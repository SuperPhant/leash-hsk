// One agent cycle: research -> for every vault delegated to this agent: propose (rules + LLM), leash, plan, simulate
// and rebalance on HSKSwap, publishing a rationale document whose keccak256 is committed onchain. Prices are mirrored
// and pools realigned by the keeper (keeper.ts), which also enforces stop-losses independently of this agent.
import { BaseError, ContractFunctionRevertedError, keccak256, toBytes } from "viem";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NOTES_BASE_URL, ROOT, loadDeployment, loadKey, targetChain } from "./config.js";
import { abi, clients } from "./lib.js";
import { research, type Signal } from "./research.js";
import { baseline, bounded, leash, pct, type Weights } from "./strategy.js";
import { askModel } from "./llm.js";
import { planTrades, fmtUsd, type HoldingView, type PlannedTrade } from "./planner.js";
import { PROFILES, type Profile } from "./profiles.js";

const chain = targetChain();
const dep = loadDeployment(chain.id);
const { pub, wallet, account } = clients(chain, loadKey("AGENT_KEY", "testnet-agent"));
const notesDir = process.env.LEASH_NOTES_DIR ?? join(ROOT, "notes-out");
const dryRun = process.env.LEASH_DRY_RUN === "1";
const vaultAbi = abi("LeashVault");
const factoryAbi = abi("LeashFactory");
/** Pool fee (0.3%) plus an allowance for price impact, used to size trades against the cash floor. */
const COST_BPS = 50n;

interface VaultStatus {
  vault: string;
  name: string;
  status: string;
  detail?: string;
  epoch?: number;
  nav?: string;
  pnl?: string;
  tx?: string;
  note?: string;
  at: string;
}

const now = Math.floor(Date.now() / 1000);
const tickerOf = new Map(dep.assets.map((a) => [a.token.toLowerCase(), a.ticker]));

function inferProfile(vault: string, caps: Record<string, number>, minCash: number): Profile {
  const demo = dep.demoVaults.find((v) => v.vault.toLowerCase() === vault.toLowerCase());
  if (demo) return PROFILES.find((p) => p.id === demo.profile)!;
  if (Math.max(...Object.values(caps)) >= 0.45 && minCash < 0.1) return PROFILES.find((p) => p.id === "momentum")!;
  if (minCash >= 0.25) return PROFILES.find((p) => p.id === "steady")!;
  return PROFILES.find((p) => p.id === "balanced")!;
}

function revertInfo(e: unknown): { name: string; args: string } | null {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      return {
        name: r.data?.errorName ?? r.reason ?? "revert",
        args: JSON.stringify(r.data?.args ?? [], (_, v) => (typeof v === "bigint" ? v.toString() : v)),
      };
    }
  }
  return null;
}

const tradeArgs = (ts: PlannedTrade[]) =>
  ts.map((t) => ({ token: t.token, buy: t.buy, amountIn: t.amountIn, minAmountOut: t.minAmountOut }));

async function handleVault(vault: `0x${string}`, signals: Signal[], asOf: string): Promise<VaultStatus> {
  const base: VaultStatus = { vault, name: "", status: "", at: new Date().toISOString() };
  const read = (functionName: string) => pub.readContract({ address: vault, abi: vaultAbi, functionName });
  const [agent, paused, mandate, epoch, lastReb, snap, headroom, tripped, pnl, drawdown] = (await Promise.all([
    read("agent"),
    read("paused"),
    read("mandate"),
    read("epoch"),
    read("lastRebalance"),
    read("snapshot"),
    read("turnoverHeadroom"),
    read("breakerTripped"),
    read("pnl"),
    read("drawdownBps"),
  ])) as [string, boolean, any, bigint, bigint, [bigint, bigint, any[]], [bigint, bigint, bigint], boolean, bigint, bigint];

  const [cash, nav, holdingsRaw] = snap;
  const caps: Record<string, number> = {};
  const holdings: HoldingView[] = holdingsRaw.map((h) => {
    const ticker = tickerOf.get(String(h.token).toLowerCase()) ?? String(h.symbol);
    caps[ticker] = Number(h.capBps) / 10_000;
    return { token: h.token, ticker, decimals: Number(h.decimals), raw: h.raw, price: h.price, priceDecimals: Number(h.priceDecimals), value: h.value };
  });
  const profile = inferProfile(vault, caps, Number(mandate.minCashBps) / 10_000);
  base.name = profile.name;
  base.epoch = Number(epoch);
  base.nav = fmtUsd(nav);
  base.pnl = `${pnl < 0n ? "-" : "+"}${fmtUsd(pnl < 0n ? -pnl : pnl)}`;

  if (agent.toLowerCase() !== account.address.toLowerCase()) return { ...base, status: "not-mine" };
  if (paused) return { ...base, status: "paused", detail: "owner paused the agent" };
  if (now >= Number(mandate.expiry)) return { ...base, status: "expired", detail: "mandate expired" };
  const readyAt = Number(lastReb) + Number(mandate.cooldown);
  if (lastReb > 0n && now < readyAt) {
    return { ...base, status: "cooldown", detail: `next trade allowed at ${new Date(readyAt * 1000).toISOString()}` };
  }
  if (nav === 0n) return { ...base, status: "empty", detail: "vault holds nothing" };

  const maxAge = Number(mandate.maxOracleAge) - 1800;
  const current: Weights = Object.fromEntries(
    holdingsRaw.map((h) => [tickerOf.get(String(h.token).toLowerCase()) ?? h.symbol, Number(h.weightBps) / 10_000]),
  );
  const frozen: Record<string, number> = {};
  const blocked: string[] = [];
  for (const h of holdingsRaw) {
    const ticker = tickerOf.get(String(h.token).toLowerCase()) ?? String(h.symbol);
    if (h.price === 0n || now - Number(h.updatedAt) > maxAge) frozen[ticker] = Number(h.weightBps) / 10_000;
    else if (Number(h.buyBlockedUntil) > now) {
      frozen[ticker] = Number(h.weightBps) / 10_000;
      blocked.push(`${ticker} (until ${new Date(Number(h.buyBlockedUntil) * 1000).toISOString()})`);
    }
  }
  const tickers = holdings.map((h) => h.ticker);
  if (tickers.every((t) => t in frozen)) {
    return { ...base, status: "waiting", detail: "every asset is frozen (stale oracle or re-entry blocked after a stop-loss)" };
  }

  const limits = { caps, minCash: Number(mandate.minCashBps) / 10_000, frozen };
  const vaultSignals = signals.filter((s) => s.ticker in caps);
  const baselineW = baseline(profile.id, tickers, vaultSignals, limits);
  const llm =
    process.env.LEASH_NO_LLM === "1"
      ? null
      : await askModel({
          profileName: profile.name,
          style: profile.style,
          caps,
          minCash: limits.minCash,
          frozen: Object.keys(frozen),
          signals: vaultSignals,
          current,
          baseline: baselineW,
          maxTilt: profile.maxTilt,
        });
  const proposal = llm?.targets ?? baselineW;
  const tilt = bounded(baselineW, proposal, profile.maxTilt, vaultSignals);
  let { weights: finalW, corrections } = leash(tilt.weights, limits);
  corrections = [...tilt.notes, ...corrections];
  if (tripped) {
    // The drawdown breaker is onchain: buys would revert, so only reductions are planned.
    finalW = Object.fromEntries(Object.entries(finalW).map(([t, w]) => [t, Math.min(w, current[t] ?? 0)]));
    corrections = [...corrections, `drawdown breaker tripped (${Number(drawdown) / 100}% below the high-water mark): sells only`];
  }

  const budget = ((headroom[1] - headroom[0]) * 97n) / 100n;
  let plan = planTrades({
    nav,
    cash,
    holdings,
    targets: finalW,
    frozen: new Set(Object.keys(frozen)),
    turnoverBudget: budget > 0n ? budget : 0n,
    minCashBps: BigInt(mandate.minCashBps),
    spreadBps: COST_BPS,
    slippageBps: BigInt(mandate.maxSlippageBps),
    // Testnet gas is scarce (faucet: 0.1 HSK a day), so drift below 1.5% of NAV is left alone. The mainnet vault holds
    // about a dollar, so there the floor is ten cents.
    minTradeUsd: (() => {
      const floor = chain.testnet ? 100_000_000n : 100_000n;
      return (nav * 150n) / 10_000n > floor ? (nav * 150n) / 10_000n : floor;
    })(),
  });
  if (tripped) plan = { ...plan, trades: plan.trades.filter((t) => !t.buy) };
  if (!plan.trades.length) {
    return {
      ...base,
      status: "on-target",
      detail: budget > 0n ? "portfolio already within tolerance of targets" : "turnover budget used up for this window",
    };
  }

  const nextEpoch = Number(epoch) + 1;
  const buildNote = (trades: PlannedTrade[], extra: string[]) => ({
    schema: "leash-hsk.rationale/v1",
    chainId: chain.id,
    vault,
    epoch: nextEpoch,
    agent: account.address,
    createdAt: new Date().toISOString(),
    profile: { id: profile.id, name: profile.name, style: profile.style },
    mandate: {
      caps: Object.fromEntries(Object.entries(caps).map(([t, c]) => [t, pct(c)])),
      minCash: pct(limits.minCash),
      maxTurnoverPerWindow: `${Number(mandate.maxTurnoverBps) / 100}% per ${Number(mandate.turnoverWindow) / 3600}h`,
      maxSlippage: `${Number(mandate.maxSlippageBps) / 100}%`,
      maxOracleAge: `${(Number(mandate.maxOracleAge) / 3600).toFixed(1)}h`,
      tradeEvery: `${Number(mandate.cooldown) / 3600}h at most`,
      stopLoss: Number(mandate.stopLossBps) ? `${Number(mandate.stopLossBps) / 100}% below average entry` : "off",
      drawdownBreaker: Number(mandate.maxDrawdownBps) ? `${Number(mandate.maxDrawdownBps) / 100}% below high-water mark` : "off",
      expiry: new Date(Number(mandate.expiry) * 1000).toISOString(),
    },
    risk: {
      nav: fmtUsd(nav),
      pnl: base.pnl,
      drawdownFromPeak: `${Number(drawdown) / 100}%`,
      breakerTripped: tripped,
      reentryBlocked: blocked,
    },
    market: {
      asOf,
      source: chain.testnet
        ? "HSK Chain mainnet: APRO HSK/USD and BTC/USD feeds, HSKSwap WETH/USDT 30-min TWAP (mirrored to testnet by the keeper); HSKSwap pool depth; CoinGecko daily closes"
        : "HSK Chain mainnet: HSKSwap 30-min TWAPs read by the vault's own feeds, APRO HSK/USD and BTC/USD feeds for comparison; HSKSwap pool depth; CoinGecko daily closes",
      signals: vaultSignals,
    },
    decision: {
      source: llm ? `llm:${llm.model}` : "rules:inverse-vol+trend",
      summary: llm?.summary || `Rules-based rebalance toward an inverse-volatility allocation with a ${profile.id} trend tilt.`,
      perAsset: llm?.perAsset ?? {},
      risks: llm?.risks ?? [],
      current: Object.fromEntries(Object.entries(current).map(([t, w]) => [t, pct(w)])),
      baseline: Object.fromEntries(Object.entries(baselineW).map(([t, w]) => [t, pct(w)])),
      proposed: Object.fromEntries(Object.entries(proposal).map(([t, w]) => [t, pct(w)])),
      final: Object.fromEntries(Object.entries(finalW).map(([t, w]) => [t, pct(w)])),
      frozen: Object.keys(frozen),
    },
    leashCorrections: [...corrections, ...plan.note, ...extra],
    trades: trades.map((t) => ({
      ticker: t.ticker,
      side: t.buy ? "buy" : "sell",
      venue: "HSKSwap (Uniswap V3) 0.3% pool",
      amountIn: t.amountIn.toString(),
      minAmountOut: t.minAmountOut.toString(),
      notionalUsd: Number(t.usd) / 1e6,
    })),
    disclaimer: chain.testnet
      ? "Testnet demonstration on mirrored HSK Chain mainnet prices. Not investment advice."
      : "Live on HSK Chain mainnet with a small demonstration balance. Not investment advice.",
  });

  const extra: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const noteJson = JSON.stringify(buildNote(plan.trades, extra), null, 2) + "\n";
    const hash = keccak256(toBytes(noteJson));
    const rel = `${chain.id}/${vault}/${nextEpoch}.json`;
    const uri = `${NOTES_BASE_URL}/${rel}`;
    try {
      const { request } = await pub.simulateContract({
        address: vault,
        abi: vaultAbi,
        functionName: "rebalance",
        args: [tradeArgs(plan.trades), hash, uri],
        account,
      });
      const file = join(notesDir, rel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, noteJson);
      if (dryRun) return { ...base, status: "dry-run", detail: `${plan.trades.length} trades simulated OK`, note: uri };
      const tx = await wallet.writeContract(request);
      const receipt = await pub.waitForTransactionReceipt({ hash: tx });
      if (receipt.status !== "success") return { ...base, status: "failed", tx, detail: "transaction reverted" };
      return {
        ...base,
        status: "rebalanced",
        epoch: nextEpoch,
        tx,
        note: uri,
        detail: plan.trades.map((t) => `${t.buy ? "buy" : "sell"} ${t.ticker} ${fmtUsd(t.usd)}`).join(", "),
      };
    } catch (e) {
      const info = revertInfo(e);
      if (!info) throw e;
      extra.push(`attempt ${attempt + 1} rejected by the vault: ${info.name} ${info.args}; buys reduced 15%`);
      console.warn(`vault ${vault}: ${info.name} ${info.args}`);
      plan = {
        ...plan,
        trades: plan.trades.map((t) =>
          t.buy ? { ...t, amountIn: (t.amountIn * 85n) / 100n, minAmountOut: (t.minAmountOut * 85n) / 100n, usd: (t.usd * 85n) / 100n } : t,
        ),
      };
      if (["NotAgent", "AgentPaused", "MandateExpired", "CooldownActive", "StaleOracle", "StalePrice", "PoolOffOracle", "DrawdownBreached", "BuyBlocked"].includes(info.name)) {
        return { ...base, status: "blocked", detail: `${info.name} ${info.args}` };
      }
    }
  }
  return { ...base, status: "blocked", detail: extra.join(" | ") };
}

const { signals, asOf } = await research(pub, dep, join(notesDir, "data", "prices.json"));
console.log(`research as of ${asOf}`);
for (const s of signals) {
  console.log(
    `  ${s.ticker.padEnd(4)} ${s.price.toPrecision(6).padStart(10)} age ${s.ageHours.toFixed(1)}h 7d ${pct(s.ret7d ?? 0)} 30d ${pct(s.ret30d ?? 0)} vol ${pct(s.vol30d ?? 0)} depth ${s.mainnetPoolUsdtDepth ?? "n/a"} (${s.historySource})`,
  );
}

const vaults = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "vaults" })) as `0x${string}`[];
const statuses: VaultStatus[] = [];
for (const v of vaults) {
  try {
    const st = await handleVault(v, signals, asOf);
    if (st.status !== "not-mine") statuses.push(st);
    console.log(`${v} ${st.name}: ${st.status}${st.detail ? ` - ${st.detail}` : ""}${st.tx ? ` tx ${st.tx}` : ""}`);
  } catch (e) {
    statuses.push({ vault: v, name: "", status: "error", detail: (e as Error).message.slice(0, 300), at: new Date().toISOString() });
    console.error(`${v}: ${(e as Error).message}`);
  }
}

const statusFile = join(notesDir, String(chain.id), "status.json");
mkdirSync(join(statusFile, ".."), { recursive: true });
const history = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")).history ?? [] : [];
const run = { at: new Date().toISOString(), agent: account.address, research: { asOf, signals }, vaults: statuses };
writeFileSync(statusFile, JSON.stringify({ latest: run, history: [run, ...history].slice(0, 200) }, null, 1));
console.log(`status written to ${statusFile}`);

// Per-vault index for the app: every rebalance (tx + rationale) and a NAV time series sampled each run.
const indexFile = join(notesDir, String(chain.id), "index.json");
const index: { vaults: Record<string, { rebalances: unknown[]; nav: Array<[string, number]> }> } = existsSync(indexFile)
  ? JSON.parse(readFileSync(indexFile, "utf8"))
  : { vaults: {} };
for (const v of vaults) {
  const entry = (index.vaults[v.toLowerCase()] ??= { rebalances: [], nav: [] });
  try {
    const navNow = (await pub.readContract({ address: v, abi: vaultAbi, functionName: "nav" })) as bigint;
    entry.nav.push([new Date().toISOString(), Number(navNow) / 1e6]);
    entry.nav = entry.nav.slice(-2000);
  } catch {}
  const st = statuses.find((s) => s.vault === v);
  if (st?.status === "rebalanced") {
    entry.rebalances.unshift({ epoch: st.epoch, tx: st.tx, note: st.note, at: st.at, detail: st.detail });
  }
}
writeFileSync(indexFile, JSON.stringify(index));
console.log(`index written to ${indexFile}`);
