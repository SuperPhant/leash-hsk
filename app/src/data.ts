import { decodeEventLog, keccak256, parseAbiItem, toBytes } from "viem";
import { ABI, testnet } from "./clients";
import { CHAIN, DEP, NOTES, TICKER_BY_TOKEN } from "./config";
import { logsInSpans } from "./logs";

export interface Mandate {
  minCashBps: number;
  maxTurnoverBps: number;
  turnoverWindow: number;
  maxSlippageBps: number;
  maxOracleAge: number;
  cooldown: number;
  stopLossBps: number;
  maxDrawdownBps: number;
  expiry: number;
}

export interface Holding {
  token: `0x${string}`;
  symbol: string;
  ticker: string;
  decimals: number;
  capBps: number;
  raw: bigint;
  amount: number;
  price: number;
  updatedAt: number;
  value: number;
  weightBps: number;
  entryPrice: number;
  stopPrice: number;
  buyBlockedUntil: number;
  /** Unrealised profit or loss of the open position at the oracle price, in USD. */
  upnl: number;
}

export interface VaultData {
  address: `0x${string}`;
  owner: `0x${string}`;
  agent: `0x${string}`;
  paused: boolean;
  mandate: Mandate;
  epoch: number;
  lastRebalance: number;
  cash: number;
  nav: number;
  netDeposits: number;
  pnl: number;
  peakNav: number;
  drawdownBps: number;
  breakerTripped: boolean;
  holdings: Holding[];
  turnover: { used: number; limit: number; resetsAt: number };
}

const usd = (x: bigint) => Number(x) / 1e6;

export function toMandate(m: any): Mandate {
  return {
    minCashBps: Number(m.minCashBps),
    maxTurnoverBps: Number(m.maxTurnoverBps),
    turnoverWindow: Number(m.turnoverWindow),
    maxSlippageBps: Number(m.maxSlippageBps),
    maxOracleAge: Number(m.maxOracleAge),
    cooldown: Number(m.cooldown),
    stopLossBps: Number(m.stopLossBps),
    maxDrawdownBps: Number(m.maxDrawdownBps),
    expiry: Number(m.expiry),
  };
}

export async function loadVault(address: `0x${string}`): Promise<VaultData> {
  const c = { address, abi: ABI.vault } as const;
  const r = (functionName: string) => testnet.readContract({ ...c, functionName });
  const [owner, agent, paused, m, epoch, last, snap, head, netDeposits, peakNav, drawdown, tripped] = (await Promise.all([
    r("owner"),
    r("agent"),
    r("paused"),
    r("mandate"),
    r("epoch"),
    r("lastRebalance"),
    r("snapshot"),
    r("turnoverHeadroom"),
    r("netDeposits"),
    r("peakNav"),
    r("drawdownBps"),
    r("breakerTripped"),
  ])) as [any, any, boolean, any, bigint, bigint, [bigint, bigint, any[]], [bigint, bigint, bigint], bigint, bigint, bigint, boolean];
  const nav = usd(snap[1]);
  return {
    address,
    owner,
    agent,
    paused,
    mandate: toMandate(m),
    epoch: Number(epoch),
    lastRebalance: Number(last),
    cash: usd(snap[0]),
    nav,
    netDeposits: usd(netDeposits),
    pnl: nav - usd(netDeposits),
    peakNav: usd(peakNav),
    drawdownBps: Number(drawdown),
    breakerTripped: tripped,
    holdings: snap[2].map((h) => {
      const pd = Number(h.priceDecimals || 8);
      const amount = Number(h.raw) / 10 ** Number(h.decimals);
      const price = Number(h.price) / 10 ** pd;
      const entryPrice = Number(h.entryPrice) / 10 ** pd;
      return {
        token: h.token,
        symbol: h.symbol,
        ticker: TICKER_BY_TOKEN.get(String(h.token).toLowerCase()) ?? h.symbol,
        decimals: Number(h.decimals),
        capBps: Number(h.capBps),
        raw: h.raw,
        amount,
        price,
        updatedAt: Number(h.updatedAt),
        value: usd(h.value),
        weightBps: Number(h.weightBps),
        entryPrice,
        stopPrice: Number(h.stopPrice) / 10 ** pd,
        buyBlockedUntil: Number(h.buyBlockedUntil),
        upnl: entryPrice > 0 ? amount * (price - entryPrice) : 0,
      };
    }),
    turnover: { used: usd(head[0]), limit: usd(head[1]), resetsAt: Number(head[2]) },
  };
}

export async function loadVaultList(): Promise<`0x${string}`[]> {
  return (await testnet.readContract({ address: DEP.factory, abi: ABI.factory, functionName: "vaults" })) as `0x${string}`[];
}

export interface MarketRow {
  ticker: string;
  token: `0x${string}`;
  oracle: number;
  pool: number;
  updatedAt: number;
  gapBps: number;
  tradable: boolean;
}

/** What the desk's guard sees for every asset: oracle price, HSKSwap pool price and their gap. */
export async function loadMarket(): Promise<MarketRow[]> {
  return Promise.all(
    DEP.assets.map(async (a) => {
      const [oracle, pool, updatedAt, gap, tradable] = (await testnet.readContract({
        address: DEP.desk,
        abi: ABI.desk,
        functionName: "check",
        args: [a.token],
      })) as [bigint, bigint, bigint, bigint, boolean];
      return {
        ticker: a.ticker,
        token: a.token,
        oracle: Number(oracle) / 1e8,
        pool: Number(pool) / 1e8,
        updatedAt: Number(updatedAt),
        gapBps: Number(gap),
        tradable,
      };
    }),
  );
}

export interface Signal {
  ticker: string;
  price: number;
  ageHours: number;
  stale: boolean;
  ret1d: number | null;
  ret7d: number | null;
  ret30d: number | null;
  vol30d: number | null;
  maxDrawdown30d: number | null;
  mainnetPoolTwap: number | null;
  mainnetPoolUsdtDepth: number | null;
  aproVsPoolBps: number | null;
  historySource: string;
}

export interface AgentRun {
  at: string;
  agent: string;
  research?: { asOf: string; signals: Signal[] };
  vaults: Array<{ vault: string; name: string; status: string; detail?: string; epoch?: number; nav?: string; pnl?: string; tx?: string; note?: string; at: string }>;
}

export interface KeeperRun {
  at: string;
  keeper: string;
  mainnet?: Array<{ ticker: string; source: string; price: number; oracleUpdatedAt: string; poolTwap: number; poolSpot: number }>;
  relay?: { relayed?: Array<{ ticker: string; source: string; price: number; updatedAt: string }>; unchanged?: string[]; tx?: string; error?: string };
  align?: { gaps?: Array<{ ticker: string; oracle: number; pool: number; gapBps: number }>; moved?: number; tx?: string; error?: string };
  sweep?: { checked?: number; exits?: Array<{ vault: string; ticker: string; reason: string; tx?: string; error?: string }>; error?: string };
}

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(`${url}?t=${Math.floor(Date.now() / 60_000)}`);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

export const loadStatus = () => json<{ latest: AgentRun; history: AgentRun[] }>(`${NOTES}/${CHAIN.id}/status.json`);
export const loadKeeper = () => json<{ latest: KeeperRun; history: KeeperRun[] }>(`${NOTES}/${CHAIN.id}/keeper.json`);

export interface IndexFile {
  vaults: Record<string, { rebalances: Array<{ epoch: number; tx: `0x${string}`; note: string; at: string; detail?: string }>; nav: Array<[string, number]> }>;
}
export const loadIndex = () => json<IndexFile>(`${NOTES}/${CHAIN.id}/index.json`);

export interface Note {
  schema: string;
  vault: string;
  epoch: number;
  createdAt: string;
  profile: { id: string; name: string; style: string };
  mandate: Record<string, unknown>;
  risk?: Record<string, unknown>;
  market: { asOf: string; source: string; signals: Signal[] };
  decision: {
    source: string;
    summary: string;
    perAsset: Record<string, string>;
    risks: string[];
    current: Record<string, string>;
    baseline: Record<string, string>;
    proposed: Record<string, string>;
    final: Record<string, string>;
    frozen: string[];
  };
  leashCorrections: string[];
  trades: Array<{ ticker: string; side: string; notionalUsd: number }>;
}

/** Fetches a rationale note and checks it against the hash the agent committed onchain. */
export async function loadNote(uri: string, onchainHash?: string): Promise<{ note: Note | null; verified: boolean | null }> {
  try {
    const r = await fetch(uri);
    if (!r.ok) return { note: null, verified: null };
    const text = await r.text();
    const verified = onchainHash ? keccak256(toBytes(text)).toLowerCase() === onchainHash.toLowerCase() : null;
    return { note: JSON.parse(text) as Note, verified };
  } catch {
    return { note: null, verified: null };
  }
}

export interface RebalanceEvent {
  epoch: number;
  navBefore: number;
  navAfter: number;
  turnover: number;
  rationaleHash: `0x${string}`;
  rationaleURI: string;
  trades: Array<{ ticker: string; buy: boolean; notional: number; price: number; amountIn: bigint; amountOut: bigint }>;
  tx: `0x${string}`;
  timestamp: number;
}

/** Reads a rebalance straight from its transaction receipt. */
export async function loadRebalance(tx: `0x${string}`, vault: string): Promise<RebalanceEvent | null> {
  try {
    const receipt = await testnet.getTransactionReceipt({ hash: tx });
    const block = await testnet.getBlock({ blockNumber: receipt.blockNumber });
    let ev: RebalanceEvent | null = null;
    const trades: RebalanceEvent["trades"] = [];
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== vault.toLowerCase()) continue;
      try {
        const d = decodeEventLog({ abi: ABI.vault, data: log.data, topics: log.topics }) as any;
        if (d.eventName === "TradeExecuted") {
          trades.push({
            ticker: TICKER_BY_TOKEN.get(String(d.args.token).toLowerCase()) ?? "?",
            buy: d.args.buy,
            notional: Number(d.args.notional) / 1e6,
            price: Number(d.args.oraclePrice) / 1e8,
            amountIn: d.args.amountIn,
            amountOut: d.args.amountOut,
          });
        }
        if (d.eventName === "Rebalanced") {
          ev = {
            epoch: Number(d.args.epoch),
            navBefore: Number(d.args.navBefore) / 1e6,
            navAfter: Number(d.args.navAfter) / 1e6,
            turnover: Number(d.args.windowTurnover) / 1e6,
            rationaleHash: d.args.rationaleHash,
            rationaleURI: d.args.rationaleURI,
            trades,
            tx,
            timestamp: Number(block.timestamp),
          };
        }
      } catch {}
    }
    return ev;
  } catch {
    return null;
  }
}

export interface RiskExitEvent {
  ticker: string;
  reason: "stop-loss" | "drawdown breaker";
  price: number;
  entryPrice: number;
  usdOut: number;
  caller: `0x${string}`;
  tx: `0x${string}`;
  block: bigint;
}

const riskExit = parseAbiItem(
  "event RiskExit(address indexed token, uint8 reason, uint256 price, uint256 entryPrice, uint256 amountSold, uint256 usdOut, address indexed caller)",
);

/** Every stop-loss or breaker exit of a vault, read from its event logs in block spans the public RPC accepts. */
export async function loadRiskExits(vault: `0x${string}`): Promise<RiskExitEvent[]> {
  const logs = await logsInSpans(`risk:${vault}`, (fromBlock, toBlock) =>
    testnet.getLogs({ address: vault, event: riskExit, fromBlock, toBlock }),
  );
  const out: RiskExitEvent[] = logs.map((l) => {
    const a = l.args as any;
    return {
      ticker: TICKER_BY_TOKEN.get(String(a.token).toLowerCase()) ?? "?",
      reason: Number(a.reason) === 1 ? "stop-loss" : "drawdown breaker",
      price: Number(a.price) / 1e8,
      entryPrice: Number(a.entryPrice) / 1e8,
      usdOut: Number(a.usdOut) / 1e6,
      caller: a.caller,
      tx: l.transactionHash!,
      block: l.blockNumber!,
    };
  });
  return out.reverse();
}
