import { parseAbiItem } from "viem";
import { testnet } from "./clients";
import { DEP, TICKER_BY_TOKEN } from "./config";
import { loadMarket, loadNote, loadVault, loadVaultList } from "./data";
import { logsInSpans } from "./logs";

/** Every trade is graded on the oracle price this long after it was made. */
export const HORIZON = 24 * 3600;
/** Extra wait before grading, so the hourly keeper has relayed every round dated before the horizon. */
export const SETTLE = 3600;
/** Price moves smaller than this count as flat: neither right nor wrong. */
export const FLAT = 0.0005;

const tradeExecuted = parseAbiItem(
  "event TradeExecuted(uint256 indexed epoch, address indexed token, bool buy, uint256 amountIn, uint256 amountOut, uint256 oraclePrice, uint256 notional)",
);
const rebalanced = parseAbiItem(
  "event Rebalanced(uint256 indexed epoch, address indexed agent, uint256 navBefore, uint256 navAfter, uint256 windowTurnover, bytes32 rationaleHash, string rationaleURI)",
);
const riskExit = parseAbiItem(
  "event RiskExit(address indexed token, uint8 reason, uint256 price, uint256 entryPrice, uint256 amountSold, uint256 usdOut, address indexed caller)",
);
const relayed = parseAbiItem("event Relayed(uint256 indexed feedId, uint80 indexed roundId, int256 answer, uint256 updatedAt)");

export type Verdict = "right" | "wrong" | "flat" | "pending";

export interface GradedTrade {
  vault: `0x${string}`;
  vaultName: string;
  /** Who made the trade: the agent, or the keeper executing a rule (stop-loss or drawdown breaker). */
  kind: "agent" | "stop-loss" | "breaker";
  epoch?: number;
  ticker: string;
  side: "buy" | "sell";
  notional: number;
  price0: number;
  t0: number;
  tx: `0x${string}`;
  block: bigint;
  logIndex: number;
  gradesAt: number;
  price24?: number;
  /** Mainnet timestamp of the oracle round used as the price 24 hours later. */
  roundAt?: number;
  move?: number;
  verdict: Verdict;
  /** What the decision earned (buy) or saved (sell) over the horizon, compared with not trading, in USD. */
  valueAdded?: number;
  rationaleURI?: string;
  rationaleHash?: `0x${string}`;
  rationaleVerified?: boolean | null;
}

export interface VaultRecord {
  vault: `0x${string}`;
  name: string;
  since: number;
  navStart: number;
  navNow: number;
  /** The vault's value now if it had kept its first allocation and never traded again. */
  hodlNow: number;
  vaultReturn: number;
  hodlReturn: number;
  trades: number;
  graded: number;
  right: number;
  wrong: number;
  valueAdded: number;
}

export interface Totals {
  trades: number;
  graded: number;
  right: number;
  wrong: number;
  flat: number;
  pending: number;
  hitRate: number | null;
  valueAdded: number;
  notionalGraded: number;
  rationales: number;
  rationalesVerified: number;
  nextGradeAt: number | null;
}

export interface RecordData {
  asOf: number;
  trades: GradedTrade[];
  vaults: VaultRecord[];
  totals: Totals;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The oracle price in force at time t: the latest relayed round whose mainnet timestamp is at or before t. */
export function priceAt(rounds: Array<{ at: number; price: number }>, t: number) {
  let found: { at: number; price: number } | undefined;
  for (const r of rounds) {
    if (r.at > t) break;
    found = r;
  }
  return found;
}

/** A buy is right if the price then rose, a sell (stop-loss exits included) if it fell. */
export function grade(side: "buy" | "sell", notional: number, price0: number, price24: number) {
  const move = price24 / price0 - 1;
  const signed = side === "buy" ? move : -move;
  const verdict: Verdict = Math.abs(move) < FLAT ? "flat" : signed > 0 ? "right" : "wrong";
  return { move, verdict, valueAdded: notional * signed };
}

/** Grades every trade of every vault from HSK Chain testnet events alone. */
export async function loadRecord(): Promise<RecordData> {
  const now = Math.floor(Date.now() / 1000);
  const vaults = await loadVaultList();
  const names = new Map(DEP.demoVaults.map((v) => [v.vault.toLowerCase(), v.name]));
  const feedTicker = new Map(DEP.assets.map((a) => [a.feedId ?? -1, a.ticker]));

  // One query per span for both sources: the vaults' trades and the price hub's relayed rounds.
  const addresses = DEP.hub ? [...vaults, DEP.hub] : vaults;
  const [logs, market] = await Promise.all([
    logsInSpans(`record:${addresses.join(",")}`, (fromBlock, toBlock) =>
      testnet.getLogs({ address: addresses, events: [tradeExecuted, rebalanced, riskExit, relayed], fromBlock, toBlock }),
    ),
    loadMarket(),
  ]);
  const hub = DEP.hub?.toLowerCase();
  const hubLogs = (logs as any[]).filter((l) => l.eventName === "Relayed" && String(l.address).toLowerCase() === hub);
  const vaultLogs = (logs as any[]).filter((l) => l.eventName !== "Relayed");

  const rounds = new Map<string, Array<{ at: number; price: number }>>();
  for (const l of hubLogs as any[]) {
    const ticker = feedTicker.get(Number(l.args.feedId));
    if (!ticker) continue;
    const list = rounds.get(ticker) ?? [];
    list.push({ at: Number(l.args.updatedAt), price: Number(l.args.answer) / 1e8 });
    rounds.set(ticker, list);
  }
  for (const list of rounds.values()) list.sort((a, b) => a.at - b.at);
  const priceNow = new Map(market.map((m) => [m.ticker, m.oracle]));

  const blocks = [...new Set((vaultLogs as any[]).map((l) => l.blockNumber as bigint))];
  const times = new Map<bigint, number>();
  await mapLimit(blocks, 4, async (b) => {
    const blk = await testnet.getBlock({ blockNumber: b });
    times.set(b, Number(blk.timestamp));
  });

  const rebalances = new Map<string, { navBefore: number; navAfter: number; hash: `0x${string}`; uri: string }>();
  const trades: GradedTrade[] = [];
  for (const l of vaultLogs as any[]) {
    const vault = l.address as `0x${string}`;
    const a = l.args;
    const base = {
      vault,
      vaultName: names.get(vault.toLowerCase()) ?? "",
      tx: l.transactionHash as `0x${string}`,
      block: l.blockNumber as bigint,
      logIndex: Number(l.logIndex),
      t0: times.get(l.blockNumber) ?? now,
    };
    if (l.eventName === "Rebalanced") {
      rebalances.set(`${vault.toLowerCase()}:${a.epoch}`, {
        navBefore: Number(a.navBefore) / 1e6,
        navAfter: Number(a.navAfter) / 1e6,
        hash: a.rationaleHash,
        uri: a.rationaleURI,
      });
    } else if (l.eventName === "TradeExecuted") {
      trades.push({
        ...base,
        kind: "agent",
        epoch: Number(a.epoch),
        ticker: TICKER_BY_TOKEN.get(String(a.token).toLowerCase()) ?? "?",
        side: a.buy ? "buy" : "sell",
        notional: Number(a.notional) / 1e6,
        price0: Number(a.oraclePrice) / 1e8,
        gradesAt: base.t0 + HORIZON + SETTLE,
        verdict: "pending",
      });
    } else if (l.eventName === "RiskExit") {
      trades.push({
        ...base,
        kind: Number(a.reason) === 1 ? "stop-loss" : "breaker",
        ticker: TICKER_BY_TOKEN.get(String(a.token).toLowerCase()) ?? "?",
        side: "sell",
        notional: Number(a.usdOut) / 1e6,
        price0: Number(a.price) / 1e8,
        gradesAt: base.t0 + HORIZON + SETTLE,
        verdict: "pending",
      });
    }
  }

  for (const t of trades) {
    if (t.epoch !== undefined) {
      const r = rebalances.get(`${t.vault.toLowerCase()}:${t.epoch}`);
      if (r) {
        t.rationaleURI = r.uri;
        t.rationaleHash = r.hash;
      }
    }
    if (now < t.gradesAt) continue;
    const r24 = priceAt(rounds.get(t.ticker) ?? [], t.t0 + HORIZON);
    const p24 = r24?.price ?? t.price0;
    const g = grade(t.side, t.notional, t.price0, p24);
    Object.assign(t, { price24: p24, roundAt: r24?.at, move: g.move, verdict: g.verdict, valueAdded: g.valueAdded });
  }

  // Each rationale is fetched once and checked against the hash its vault committed onchain.
  const notes = [...new Map(trades.filter((t) => t.rationaleURI).map((t) => [t.rationaleURI!, t.rationaleHash])).entries()];
  const verified = new Map<string, boolean | null>();
  await mapLimit(notes, 4, async ([uri, hash]) => {
    verified.set(uri, (await loadNote(uri, hash)).verified);
  });
  for (const t of trades) if (t.rationaleURI) t.rationaleVerified = verified.get(t.rationaleURI) ?? null;

  trades.sort((x, y) => (x.block === y.block ? y.logIndex - x.logIndex : x.block < y.block ? 1 : -1));

  const vaultRecords: VaultRecord[] = [];
  for (const v of vaults) {
    const mine = trades.filter((t) => t.vault.toLowerCase() === v.toLowerCase());
    const agentTrades = mine.filter((t) => t.kind === "agent");
    if (!agentTrades.length) continue;
    const firstEpoch = Math.min(...agentTrades.map((t) => t.epoch!));
    const first = rebalances.get(`${v.toLowerCase()}:${firstEpoch}`);
    if (!first) continue;
    const firstTrades = agentTrades.filter((t) => t.epoch === firstEpoch);
    const hodlNow =
      first.navAfter +
      firstTrades.reduce((s, t) => {
        const p = priceNow.get(t.ticker) ?? t.price0;
        return s + (t.side === "buy" ? 1 : -1) * t.notional * (p / t.price0 - 1);
      }, 0);
    const data = await loadVault(v);
    // Deposits made after the first trade are left out of both returns.
    const later = Math.max(0, data.netDeposits - first.navBefore);
    const graded = mine.filter((t) => t.verdict !== "pending");
    vaultRecords.push({
      vault: v,
      name: names.get(v.toLowerCase()) ?? "",
      since: Math.min(...firstTrades.map((t) => t.t0)),
      navStart: first.navBefore,
      navNow: data.nav,
      hodlNow,
      vaultReturn: (data.nav - later) / first.navBefore - 1,
      hodlReturn: hodlNow / first.navBefore - 1,
      trades: mine.length,
      graded: graded.length,
      right: graded.filter((t) => t.verdict === "right").length,
      wrong: graded.filter((t) => t.verdict === "wrong").length,
      valueAdded: graded.reduce((s, t) => s + (t.valueAdded ?? 0), 0),
    });
  }

  const graded = trades.filter((t) => t.verdict !== "pending");
  const right = graded.filter((t) => t.verdict === "right").length;
  const wrong = graded.filter((t) => t.verdict === "wrong").length;
  const pending = trades.filter((t) => t.verdict === "pending");
  const withNotes = trades.filter((t) => t.rationaleURI);
  const uniqueNotes = new Set(withNotes.map((t) => t.rationaleURI));
  const okNotes = new Set(withNotes.filter((t) => t.rationaleVerified).map((t) => t.rationaleURI));
  return {
    asOf: now,
    trades,
    vaults: vaultRecords,
    totals: {
      trades: trades.length,
      graded: graded.length,
      right,
      wrong,
      flat: graded.length - right - wrong,
      pending: pending.length,
      hitRate: right + wrong ? right / (right + wrong) : null,
      valueAdded: graded.reduce((s, t) => s + (t.valueAdded ?? 0), 0),
      notionalGraded: graded.reduce((s, t) => s + t.notional, 0),
      rationales: uniqueNotes.size,
      rationalesVerified: okNotes.size,
      nextGradeAt: pending.length ? Math.min(...pending.map((t) => t.gradesAt)) : null,
    },
  };
}
