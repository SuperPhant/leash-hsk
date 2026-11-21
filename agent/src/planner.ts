// Turns target weights into vault trades that fit the remaining turnover budget and the cash floor.
import type { Weights } from "./strategy.js";

export interface HoldingView {
  token: `0x${string}`;
  ticker: string;
  decimals: number;
  raw: bigint;
  price: bigint; // feed units
  priceDecimals: number;
  value: bigint; // USD units (6 decimals)
}

export interface PlannedTrade {
  token: `0x${string}`;
  ticker: string;
  buy: boolean;
  amountIn: bigint;
  minAmountOut: bigint;
  usd: bigint; // notional in USD units
}

const USD = 10n ** 6n;
const BPS = 10_000n;

const toUnits = (h: HoldingView, usd: bigint) =>
  (usd * 10n ** BigInt(h.decimals + h.priceDecimals)) / (h.price * USD);

export function planTrades(args: {
  nav: bigint;
  cash: bigint;
  holdings: HoldingView[];
  targets: Weights;
  frozen: Set<string>;
  turnoverBudget: bigint;
  minCashBps: bigint;
  spreadBps: bigint;
  slippageBps: bigint;
  minTradeUsd?: bigint;
}): { trades: PlannedTrade[]; scaledBy: number; note: string[] } {
  const note: string[] = [];
  const minTrade = args.minTradeUsd ?? (args.nav / 200n > 50n * USD ? args.nav / 200n : 50n * USD);
  const deltas = args.holdings
    .filter((h) => !args.frozen.has(h.ticker) && h.price > 0n)
    .map((h) => {
      const target = BigInt(Math.round((args.targets[h.ticker] ?? 0) * 1e6)) * args.nav / 1_000_000n;
      return { h, delta: target - h.value };
    })
    .filter(({ delta }) => (delta < 0n ? -delta : delta) >= minTrade);

  let gross = deltas.reduce((a, { delta }) => a + (delta < 0n ? -delta : delta), 0n);
  let scale = 1;
  if (gross > args.turnoverBudget) {
    scale = Number((args.turnoverBudget * 1_000_000n) / (gross === 0n ? 1n : gross)) / 1_000_000;
    note.push(`turnover budget ${fmtUsd(args.turnoverBudget)} < desired ${fmtUsd(gross)}: trades scaled to ${(scale * 100).toFixed(1)}%`);
  }
  const s = BigInt(Math.floor(scale * 1_000_000));
  const scaled = deltas.map(({ h, delta }) => ({ h, delta: (delta * s) / 1_000_000n }));

  const sells = scaled.filter(({ delta }) => delta < 0n);
  let buys = scaled.filter(({ delta }) => delta > 0n);

  const sellUsd = sells.reduce((a, { delta }) => a - delta, 0n);
  const sellProceeds = (sellUsd * (BPS - args.spreadBps)) / BPS;
  let buyUsd = buys.reduce((a, { delta }) => a + delta, 0n);
  const navAfter = args.nav - ((sellUsd + buyUsd) * args.spreadBps) / BPS;
  const cashFloor = (navAfter * (args.minCashBps + 50n)) / BPS;
  const spendable = args.cash + sellProceeds - cashFloor;
  if (buyUsd > 0n && buyUsd > spendable) {
    const k = spendable > 0n ? (spendable * 1_000_000n) / buyUsd : 0n;
    buys = buys.map(({ h, delta }) => ({ h, delta: (delta * k) / 1_000_000n }));
    note.push(`cash floor: buys scaled to ${(Number(k) / 1e4).toFixed(1)}%`);
    buyUsd = buys.reduce((a, { delta }) => a + delta, 0n);
  }

  const trades: PlannedTrade[] = [];
  for (const { h, delta } of sells) {
    let units = toUnits(h, -delta);
    if (units > h.raw) units = h.raw;
    if (units === 0n) continue;
    const fair = (units * h.price * USD) / 10n ** BigInt(h.decimals + h.priceDecimals);
    trades.push({
      token: h.token,
      ticker: h.ticker,
      buy: false,
      amountIn: units,
      minAmountOut: (fair * (BPS - args.slippageBps)) / BPS,
      usd: fair,
    });
  }
  for (const { h, delta } of buys) {
    if (delta < minTrade / 2n) continue;
    const units = toUnits(h, delta);
    trades.push({
      token: h.token,
      ticker: h.ticker,
      buy: true,
      amountIn: delta,
      minAmountOut: (units * (BPS - args.slippageBps)) / BPS,
      usd: delta,
    });
  }
  return { trades, scaledBy: scale, note };
}

export function fmtUsd(x: bigint) {
  return `$${(Number(x) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}
