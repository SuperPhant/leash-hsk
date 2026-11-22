import { useState } from "react";
import { BaseError, decodeErrorResult, encodeAbiParameters, encodeFunctionData, keccak256, toHex, zeroHash, type Abi } from "viem";
import { ABI, testnet } from "../clients";
import { IS_MAINNET } from "../config";
import type { VaultData } from "../data";
import { Card, Spinner } from "../ui";
import { fmtBps, fmtUsd, short } from "../util";

// LeashVault storage slots (forge inspect LeashVault storageLayout). Slot 11 packs lastRebalance and windowStart:
// zeroing it skips the cooldown and opens a fresh turnover window, so each scenario hits only the rule it is about.
const SLOT_CLOCKS = toHex(11, { size: 32 });
const SLOT_PEAK_NAV = toHex(8, { size: 32 });
const SLOT_BUY_BLOCKED_MAP = 7n;
const MIN_REENTRY_DELAY = 3600;

type Slot = { slot: `0x${string}`; value: `0x${string}` };
type Outcome = { allowed: boolean; name?: string; args?: readonly unknown[]; now: number };

interface Scenario {
  id: string;
  title: string;
  story: string;
  run: () => Promise<Outcome>;
}

const word = (x: bigint | number) => toHex(BigInt(x), { size: 32 });
const buyBlockedSlot = (token: `0x${string}`) =>
  keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [token, SLOT_BUY_BLOCKED_MAP]));

/** Runs the call as the vault's agent with eth_call; nothing is sent and no wallet is needed. */
async function simulate(v: VaultData, fn: "rebalance" | "withdrawAll", args: readonly unknown[], slots: Slot[] = [], shift = 0): Promise<Outcome> {
  const now = Math.floor(Date.now() / 1000) + shift;
  try {
    await testnet.call({
      to: v.address,
      data: encodeFunctionData({ abi: ABI.vault, functionName: fn, args }),
      account: v.agent,
      stateOverride: [{ address: v.address, stateDiff: [{ slot: SLOT_CLOCKS, value: zeroHash }, ...slots] }],
      ...(shift ? { blockOverrides: { time: BigInt(now) } } : {}),
    });
    return { allowed: true, now };
  } catch (e) {
    const raw =
      e instanceof BaseError ? (e.walk((x: any) => typeof x?.data === "string" && x.data.startsWith("0x")) as any)?.data : undefined;
    if (raw) {
      for (const abi of [ABI.vault, ABI.desk] as Abi[]) {
        try {
          const r = decodeErrorResult({ abi, data: raw });
          return { allowed: false, name: r.errorName, args: r.args ?? [], now };
        } catch {}
      }
    }
    return { allowed: false, name: e instanceof BaseError ? e.shortMessage : String(e), now };
  }
}

function explain(v: VaultData, o: Outcome): string {
  const a = (o.args ?? []) as any[];
  const tick = (t: string) => v.holdings.find((h) => h.token.toLowerCase() === String(t).toLowerCase())?.ticker ?? short(t);
  const usd = (x: unknown) => fmtUsd(Number(x) / 1e6, 0);
  switch (o.name) {
    case "WeightCapExceeded":
      return `${tick(a[0])} would be ${fmtBps(Number(a[1]))} of the vault; its cap is ${fmtBps(Number(a[2]), 0)}.`;
    case "TurnoverExceeded":
      return `that is ${usd(a[0])} of trading in one window; the rules allow ${usd(a[1])}.`;
    case "CashFloorBreached":
      return `cash would fall to ${fmtBps(Number(a[0]))} of the vault; the floor is ${fmtBps(Number(a[1]), 0)}.`;
    case "StaleOracle":
      return `the newest ${tick(a[0])} price would be ${((o.now - Number(a[1])) / 3600).toFixed(1)} hours old; the vault accepts at most ${Math.round(Number(a[2]) / 3600)} hours.`;
    case "BuyBlocked":
      return `the stop-loss just sold ${tick(a[0])}; buying it back is blocked until ${new Date(Number(a[1]) * 1000).toLocaleString()}.`;
    case "DrawdownBreached":
      return `the vault is worth ${usd(a[0])}, below the breaker floor of ${usd(a[1])}, so the agent may only sell until the owner resets it.`;
    case "NotOwner":
      return "only the owner can withdraw. The agent has no way to move funds out.";
    case "AssetNotAllowed":
      return `${tick(a[0])} is not in this vault's rules.`;
    case "BuyNotAllowed":
      return `${tick(a[0])} has a cap of 0%: the agent may only sell it.`;
    case "SlippageExceeded":
    case "InsufficientOutput":
      return "the fill would be worse than the slippage limit versus the oracle price.";
    case "PoolOffOracle":
      return `the HSKSwap pool price is more than 2% away from the ${tick(a[0])} oracle price, so the desk refuses to trade into it.`;
    case "CooldownActive":
      return `the agent traded too recently; the next trade is allowed ${new Date(Number(a[0]) * 1000).toLocaleString()}.`;
    case "AgentPaused":
      return "the owner paused the agent.";
    case "MandateExpired":
      return "the agent's authority has expired.";
    default:
      return o.name ?? "reverted";
  }
}

function scenarios(v: VaultData): Scenario[] {
  const m = v.mandate;
  const usd6 = (x: number) => BigInt(Math.max(1, Math.floor(x * 1e6)));
  const buy = (token: `0x${string}`, usd: number) => ({ token, buy: true, amountIn: usd6(usd), minAmountOut: 0n });
  const rebalance = (trades: ReturnType<typeof buy>[], slots: Slot[] = [], shift = 0) =>
    simulate(v, "rebalance", [trades, zeroHash, ""], slots, shift);
  const priced = v.holdings.filter((h) => h.capBps > 0 && h.updatedAt > 0);
  const budget = (v.nav * m.maxTurnoverBps) / 10_000;
  const spare = v.cash - ((m.minCashBps + 100) / 10_000) * v.nav;
  const list: Scenario[] = [];

  const normal = priced.filter((h) => h.weightBps < h.capBps - 200);
  const small = Math.min(50, spare, budget * 0.5);
  // The mainnet vault holds about a dollar, so its scenarios use cents.
  if (normal.length && small >= (IS_MAINNET ? 0.05 : 5)) {
    const h = normal[0];
    list.push({
      id: "normal",
      title: "A normal trade, for comparison",
      story: `The agent buys ${fmtUsd(small, 0)} of ${h.ticker}, well inside every rule.`,
      run: () => rebalance([buy(h.token, small)]),
    });
  }

  const cap = priced
    .map((h) => ({ h, need: ((h.capBps - h.weightBps) / 10_000 + 0.03) * v.nav }))
    .filter((x) => x.need > 0 && x.need < Math.min(spare, budget) * 0.95)
    .sort((a, b) => a.need - b.need)[0];
  if (cap) {
    list.push({
      id: "cap",
      title: `Push ${cap.h.ticker} past its cap`,
      story: `The agent buys ${fmtUsd(cap.need, 0)} of ${cap.h.ticker}, taking it from ${fmtBps(cap.h.weightBps)} to about ${fmtBps(cap.h.capBps + 300, 0)} of the vault. The owner capped it at ${fmtBps(cap.h.capBps, 0)}.`,
      run: () => rebalance([buy(cap.h.token, cap.need)]),
    });
  }

  if (priced.length && v.cash > (IS_MAINNET ? 0.05 : 1)) {
    const each = (v.cash * 0.99) / priced.length;
    list.push({
      id: "allin",
      title: "Spend all the cash at once",
      story: `The agent tries to put ${fmtUsd(v.cash * 0.99, 0)}, nearly all the cash, into ${priced.map((h) => h.ticker).join(", ")} in one go.`,
      run: () => rebalance(priced.map((h) => buy(h.token, each))),
    });
  }

  const target = priced[0];
  // A mainnet TwapFeed computes its price at every call, so it cannot go stale and this move does not apply there.
  if (target && !IS_MAINNET) {
    const shift = m.maxOracleAge + 2 * 3600;
    list.push({
      id: "stale",
      title: "Trade on a frozen price",
      story: `We move the clock ${Math.round(shift / 3600)} hours ahead with no new prices, as if the price feed had stopped. The agent tries to buy ${target.ticker} anyway.`,
      run: () => rebalance([buy(target.token, 100)], [], shift),
    });
  }

  if (target && m.stopLossBps > 0) {
    const until = Math.floor(Date.now() / 1000) + Math.max(m.cooldown, MIN_REENTRY_DELAY);
    list.push({
      id: "rebuy",
      title: "Buy back right after a stop-loss",
      story: `We pretend the ${fmtBps(m.stopLossBps, 0)} stop-loss sold ${target.ticker} a minute ago. The agent tries to buy it straight back.`,
      run: () => rebalance([buy(target.token, 100)], [{ slot: buyBlockedSlot(target.token), value: word(until) }]),
    });
  }

  if (target && m.maxDrawdownBps > 0 && v.nav > 0) {
    const dd = m.maxDrawdownBps + 500;
    const peak = v.nav / (1 - dd / 10_000);
    list.push({
      id: "breaker",
      title: "Keep buying through a crash",
      story: `We pretend the vault was once worth ${fmtUsd(peak, 0)}, so it is now ${fmtBps(dd, 0)} below its peak, past the ${fmtBps(m.maxDrawdownBps, 0)} breaker. The agent tries to buy ${target.ticker}.`,
      run: () => rebalance([buy(target.token, 100)], [{ slot: SLOT_PEAK_NAV, value: word(Math.round(peak * 1e6)) }]),
    });
  }

  list.push({
    id: "drain",
    title: "Send the funds to itself",
    story: "A compromised agent tries to withdraw the whole vault to its own address.",
    run: () => simulate(v, "withdrawAll", [v.agent]),
  });
  return list;
}

/** "Try to break the leash": the agent's most dangerous moves, simulated against this vault's live state. */
export function LeashTester({ v }: { v: VaultData }) {
  const [results, setResults] = useState<Record<string, Outcome | "running">>({});
  const list = scenarios(v);
  const runOne = async (s: Scenario) => {
    setResults((r) => ({ ...r, [s.id]: "running" }));
    const res = await s.run();
    setResults((r) => ({ ...r, [s.id]: res }));
  };
  const busy = Object.values(results).includes("running");
  return (
    <Card
      title="Try to break the leash"
      extra={
        <button className="btn small ghost" disabled={busy} onClick={async () => { for (const s of list) await runOne(s); }}>
          Try them all
        </button>
      }
    >
      <p className="muted small">
        Each move is simulated as the agent with <code>eth_call</code> against this vault&apos;s live state on HSK Chain{" "}
        {IS_MAINNET ? "mainnet" : "testnet"}: no wallet, no gas, nothing is sent. The cooldown is skipped so each rule
        shows on its own.
      </p>
      <div className="tester">
        {list.map((s) => {
          const r = results[s.id];
          return (
            <div key={s.id} className="scenario">
              <div className="scenario-text">
                <b>{s.title}</b>
                <p className="muted small">{s.story}</p>
                {r && r !== "running" && (
                  <div className={`verdict ${r.allowed ? "allowed" : "blocked"}`}>
                    {r.allowed ? (
                      <>Allowed: this trade is inside the rules.</>
                    ) : (
                      <>
                        <b>Blocked by the vault</b> <code>{r.name}</code>: {explain(v, r)}
                      </>
                    )}
                  </div>
                )}
              </div>
              <button className="btn small ghost" onClick={() => runOne(s)} disabled={r === "running"}>
                {r === "running" ? <Spinner /> : "Try it"}
              </button>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
