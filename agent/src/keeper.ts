// The keeper: one run = mirror mainnet prices -> realign the testnet HSKSwap pools -> enforce stop-losses.
//   1. relay: copies new APRO rounds (HSK/USD, BTC/USD) from HSK Chain mainnet, and the mainnet HSKSwap WETH/USDT
//      30-minute TWAP as ETH/USD, into the testnet MirrorFeedHub.
//   2. align: if a testnet pool drifted from its oracle, the PoolAligner swaps it back (the arbitrageur's job).
//   3. sweep: calls `stopOut` on every vault position whose stop-loss or drawdown breaker has triggered. Anyone may
//      call it; the keeper just makes sure someone does, so the rules hold even if the AI agent is offline.
// On mainnet only the sweep runs: the TWAP feeds read the real pools directly and nobody needs to realign them.
import { BaseError, ContractFunctionRevertedError, type Account, type PublicClient, type WalletClient } from "viem";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ASSETS, ROOT, loadDeployment, loadKey, targetChain, type Deployment } from "./config.js";
import { abi, clients, mainnetClient, poolPrice, readApro, write } from "./lib.js";

const hubAbi = abi("MirrorFeedHub");
const deskAbi = abi("SwapDesk");
const alignerAbi = abi("PoolAligner");
const vaultAbi = abi("LeashVault");
const factoryAbi = abi("LeashFactory");

const ETH_MIN_MOVE_BPS = 20n;
const ETH_MAX_AGE = 20 * 60;
const ALIGN_MIN_GAP_BPS = 10n;

export interface MainnetQuote {
  ticker: string;
  source: "apro" | "hskswap-twap";
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
  poolTwap: bigint;
  poolSpot: bigint;
}

/** Latest mainnet price for every asset, plus the mainnet pool's own TWAP and spot for comparison. */
export async function mainnetQuotes(): Promise<MainnetQuote[]> {
  const main = mainnetClient();
  const now = BigInt(Math.floor(Date.now() / 1000));
  return Promise.all(
    ASSETS.map(async (a): Promise<MainnetQuote> => {
      const pool = await poolPrice(main, a.mainnetPool, a.mainnetToken, a.decimals);
      if (a.aproFeed) {
        const r = await readApro(main, a.aproFeed);
        return { ticker: a.ticker, source: "apro", ...r, poolTwap: pool.twap, poolSpot: pool.spot };
      }
      return {
        ticker: a.ticker,
        source: "hskswap-twap",
        roundId: now,
        answer: pool.twap,
        startedAt: now - 1800n,
        updatedAt: now,
        poolTwap: pool.twap,
        poolSpot: pool.spot,
      };
    }),
  );
}

export interface RelayReport {
  relayed: Array<{ ticker: string; source: string; price: number; updatedAt: string }>;
  unchanged: string[];
  tx?: `0x${string}`;
}

export async function relay(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  dep: Deployment,
  quotes?: MainnetQuote[],
): Promise<RelayReport> {
  const q = quotes ?? (await mainnetQuotes());
  const report: RelayReport = { relayed: [], unchanged: [] };
  const ids: bigint[] = [];
  const rounds: bigint[] = [];
  const answers: bigint[] = [];
  const started: bigint[] = [];
  const updated: bigint[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const a of dep.assets) {
    const quote = q.find((x) => x.ticker === a.ticker)!;
    const feedId = BigInt(a.feedId!);
    const local = (await pub.readContract({ address: dep.hub!, abi: hubAbi, functionName: "latestRound", args: [feedId] })) as bigint;
    let fresh = quote.roundId > local;
    if (fresh && quote.source === "hskswap-twap" && local !== 0n) {
      const [, last] = (await pub.readContract({ address: dep.hub!, abi: hubAbi, functionName: "latest", args: [feedId] })) as [
        bigint,
        { answer: bigint; updatedAt: bigint },
      ];
      const move = last.answer === 0n ? 10_000n : ((quote.answer > last.answer ? quote.answer - last.answer : last.answer - quote.answer) * 10_000n) / last.answer;
      fresh = move >= ETH_MIN_MOVE_BPS || now - Number(last.updatedAt) >= ETH_MAX_AGE;
    }
    if (!fresh) {
      report.unchanged.push(a.ticker);
      continue;
    }
    ids.push(feedId);
    rounds.push(quote.roundId);
    answers.push(quote.answer);
    started.push(quote.startedAt);
    updated.push(quote.updatedAt);
    report.relayed.push({
      ticker: a.ticker,
      source: quote.source,
      price: Number(quote.answer) / 1e8,
      updatedAt: new Date(Number(quote.updatedAt) * 1000).toISOString(),
    });
  }
  if (ids.length) {
    const { hash } = await write(pub, wallet, account, {
      address: dep.hub!,
      abi: hubAbi,
      functionName: "relay",
      args: [ids, rounds, answers, started, updated],
    });
    report.tx = hash;
  }
  return report;
}

export interface AlignReport {
  gaps: Array<{ ticker: string; oracle: number; pool: number; gapBps: number }>;
  moved: number;
  tx?: `0x${string}`;
}

export async function align(pub: PublicClient, wallet: WalletClient, account: Account, dep: Deployment): Promise<AlignReport> {
  const report: AlignReport = { gaps: [], moved: 0 };
  let needed = false;
  for (const a of dep.assets) {
    const [oracle, spot, , gap] = (await pub.readContract({ address: dep.desk, abi: deskAbi, functionName: "check", args: [a.token] })) as [
      bigint,
      bigint,
      bigint,
      bigint,
      boolean,
    ];
    report.gaps.push({ ticker: a.ticker, oracle: Number(oracle) / 1e8, pool: Number(spot) / 1e8, gapBps: Number(gap) });
    if (gap >= ALIGN_MIN_GAP_BPS) needed = true;
  }
  if (!needed) return report;
  const { hash, result } = await write(pub, wallet, account, {
    address: dep.aligner!,
    abi: alignerAbi,
    functionName: "align",
    args: [dep.assets.map((a) => a.token), ALIGN_MIN_GAP_BPS],
  });
  report.moved = Number(result as bigint);
  report.tx = hash;
  return report;
}

export interface SweepReport {
  checked: number;
  exits: Array<{ vault: string; ticker: string; reason: string; tx?: string; error?: string }>;
}

const REASONS = ["none", "stop-loss", "drawdown-breaker"];

export async function sweep(pub: PublicClient, wallet: WalletClient, account: Account, dep: Deployment): Promise<SweepReport> {
  const report: SweepReport = { checked: 0, exits: [] };
  const vaults = (await pub.readContract({ address: dep.factory, abi: factoryAbi, functionName: "vaults" })) as `0x${string}`[];
  const tickerOf = new Map(dep.assets.map((a) => [a.token.toLowerCase(), a.ticker]));
  for (const vault of vaults) {
    const assets = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: "assets" })) as `0x${string}`[];
    for (const token of assets) {
      report.checked++;
      const [reason] = (await pub.readContract({ address: vault, abi: vaultAbi, functionName: "exitStatus", args: [token] })) as [
        number,
        bigint,
        bigint,
      ];
      if (Number(reason) === 0) continue;
      const ticker = tickerOf.get(token.toLowerCase()) ?? token;
      try {
        const { hash } = await write(pub, wallet, account, { address: vault, abi: vaultAbi, functionName: "stopOut", args: [token] });
        report.exits.push({ vault, ticker, reason: REASONS[Number(reason)], tx: hash });
      } catch (e) {
        let error = (e as Error).message.slice(0, 200);
        if (e instanceof BaseError) {
          const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
          if (r instanceof ContractFunctionRevertedError) error = r.data?.errorName ?? r.reason ?? error;
        }
        report.exits.push({ vault, ticker, reason: REASONS[Number(reason)], error });
      }
    }
  }
  return report;
}

/** Appends one mainnet observation per asset to the price history the agent's research uses as a fallback. */
function recordHistory(notesDir: string, quotes: MainnetQuote[]) {
  const file = join(notesDir, "data", "prices.json");
  mkdirSync(join(file, ".."), { recursive: true });
  const hist: Record<string, Array<[number, number]>> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const t = Math.floor(Date.now() / 1000);
  for (const q of quotes) {
    const arr = (hist[q.ticker] ??= []);
    arr.push([t, Number(q.poolTwap) / 1e8]);
    hist[q.ticker] = arr.slice(-24 * 45);
  }
  writeFileSync(file, JSON.stringify(hist));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chain = targetChain();
  const dep = loadDeployment(chain.id);
  const { pub, wallet, account } = clients(chain, loadKey("KEEPER_KEY", "testnet-leash-keeper"));
  const notesDir = process.env.LEASH_NOTES_DIR ?? join(ROOT, "notes-out");
  const out: Record<string, unknown> = { at: new Date().toISOString(), keeper: account.address };
  let failed = false;
  const quotes = await mainnetQuotes();
  out.mainnet = quotes.map((q) => ({
    ticker: q.ticker,
    source: q.source,
    price: Number(q.answer) / 1e8,
    oracleUpdatedAt: new Date(Number(q.updatedAt) * 1000).toISOString(),
    poolTwap: Number(q.poolTwap) / 1e8,
    poolSpot: Number(q.poolSpot) / 1e8,
  }));
  recordHistory(notesDir, quotes);
  for (const [name, step] of [
    ["relay", () => relay(pub, wallet, account, dep, quotes)],
    ["align", () => align(pub, wallet, account, dep)],
    ["sweep", () => sweep(pub, wallet, account, dep)],
  ] as const) {
    if (name !== "sweep" && !dep.hub) {
      out[name] = "not needed on mainnet";
      continue;
    }
    try {
      out[name] = await step();
    } catch (e) {
      failed = true;
      out[name] = { error: (e as Error).message.slice(0, 400) };
    }
  }
  const json = JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  console.log(json);
  const statusFile = join(notesDir, String(chain.id), "keeper.json");
  mkdirSync(join(statusFile, ".."), { recursive: true });
  const history = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, "utf8")).history ?? [] : [];
  writeFileSync(statusFile, JSON.stringify({ latest: JSON.parse(json), history: [JSON.parse(json), ...history].slice(0, 300) }));
  if (failed) process.exitCode = 1;
}
