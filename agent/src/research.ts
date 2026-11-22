// Market research for HSK, BTC and ETH, built from onchain data first:
//   - the vault's own oracle (the testnet mirror of HSK Chain mainnet APRO feeds / HSKSwap TWAP): current price and age
//   - HSK Chain mainnet HSKSwap pools: 30-minute TWAP, spot, USDT depth, and the gap between the pool and APRO
//   - daily closes for returns, volatility and drawdown: CoinGecko, falling back to the keeper's hourly mainnet history
import { existsSync, readFileSync } from "node:fs";
import type { PublicClient } from "viem";
import { ASSETS, MAINNET_USDT, type Deployment } from "./config.js";
import { abi, mainnetClient, poolPrice, readApro } from "./lib.js";

const deskAbi = abi("SwapDesk");
const erc20 = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

export interface Signal {
  ticker: string;
  price: number;
  updatedAt: number;
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
  closes: number;
  historySource: string;
}

function stdev(xs: number[]): number {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

async function coingeckoCloses(id: string): Promise<number[] | null> {
  // The free API often rate-limits shared CI addresses for a few seconds; a short wait usually clears it.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 15_000 * attempt));
    try {
      const r = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=31&interval=daily`, {
        headers: { accept: "application/json" },
      });
      if (r.status === 429 || r.status >= 500) continue;
      if (!r.ok) return null;
      const j = (await r.json()) as { prices?: Array<[number, number]> };
      const closes = (j.prices ?? []).map((p) => p[1]).filter((x) => Number.isFinite(x) && x > 0);
      return closes.length >= 8 ? closes : null;
    } catch {
      // network error: try again
    }
  }
  return null;
}

/** Daily closes from the keeper's hourly mainnet history (last observation of each UTC day). */
function keeperCloses(historyPath: string, ticker: string): number[] {
  if (!existsSync(historyPath)) return [];
  const hist = (JSON.parse(readFileSync(historyPath, "utf8"))[ticker] ?? []) as Array<[number, number]>;
  const byDay = new Map<string, number>();
  for (const [t, p] of hist) byDay.set(new Date(t * 1000).toISOString().slice(0, 10), p);
  return [...byDay.values()];
}

export async function research(
  pub: PublicClient,
  dep: Deployment,
  historyPath: string,
  opts: { now?: number; staleHours?: number } = {},
): Promise<{ signals: Signal[]; asOf: string }> {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const staleHours = opts.staleHours ?? 30;
  const main = mainnetClient();
  const signals: Signal[] = [];
  for (const a of dep.assets) {
    const cfg = ASSETS.find((x) => x.ticker === a.ticker)!;
    const [p, , updated] = (await pub.readContract({ address: dep.desk, abi: deskAbi, functionName: "priceOf", args: [a.token] })) as [
      bigint,
      number,
      bigint,
    ];
    const price = Number(p) / 1e8;
    const updatedAt = Number(updated);

    let twap: number | null = null;
    let depth: number | null = null;
    let aproGap: number | null = null;
    try {
      const pool = await poolPrice(main, cfg.mainnetPool, cfg.mainnetToken, cfg.decimals);
      twap = Number(pool.twap) / 1e8;
      const usdt = (await main.readContract({ address: MAINNET_USDT, abi: erc20, functionName: "balanceOf", args: [cfg.mainnetPool] })) as bigint;
      depth = Number(usdt) / 1e6;
      if (cfg.aproFeed) {
        const apro = Number((await readApro(main, cfg.aproFeed)).answer) / 1e8;
        aproGap = Math.round(((twap - apro) / apro) * 10_000);
      }
    } catch {
      // mainnet reads are context only; the decision still has the vault's own oracle
    }

    let closes = await coingeckoCloses(cfg.coingeckoId);
    let historySource = "coingecko daily";
    if (!closes) {
      closes = keeperCloses(historyPath, a.ticker);
      historySource = "keeper hourly mainnet history (daily closes)";
    }
    const series = [...closes.slice(0, -1), price];
    const back = (n: number) => (series.length > n ? series[series.length - 1 - n] : null);
    const ret = (n: number) => {
      const b = back(n);
      return b ? price / b - 1 : null;
    };
    const window = series.slice(-31);
    const rets = window.slice(1).map((x, i) => Math.log(x / window[i]));
    let peak = -Infinity;
    let mdd = 0;
    for (const x of window) {
      peak = Math.max(peak, x);
      mdd = Math.min(mdd, x / peak - 1);
    }
    signals.push({
      ticker: a.ticker,
      price,
      updatedAt,
      ageHours: (now - updatedAt) / 3600,
      stale: now - updatedAt > staleHours * 3600,
      ret1d: ret(1),
      ret7d: ret(7),
      ret30d: ret(30),
      vol30d: rets.length >= 5 ? stdev(rets) * Math.sqrt(365) : null,
      maxDrawdown30d: window.length >= 5 ? mdd : null,
      mainnetPoolTwap: twap,
      mainnetPoolUsdtDepth: depth,
      aproVsPoolBps: aproGap,
      closes: series.length,
      historySource,
    });
  }
  return { signals, asOf: new Date(now * 1000).toISOString() };
}
