// Deterministic baseline allocation and the "leash" clipping that every proposal (rules or LLM) goes through
// before the agent even talks to the chain. The vault enforces the same limits onchain; clipping here just
// keeps the agent from wasting transactions on trades the vault would reject.
import type { Signal } from "./research.js";

export type Weights = Record<string, number>; // ticker -> fraction of NAV (0..1)

export interface Limits {
  caps: Record<string, number>; // ticker -> max fraction
  minCash: number; // fraction
  frozen: Record<string, number>; // ticker -> current weight that cannot change (stale oracle or blocked)
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function baseline(style: string, tickers: string[], signals: Signal[], limits: Limits): Weights {
  const live = tickers.filter((t) => !(t in limits.frozen));
  const sig = new Map(signals.map((s) => [s.ticker, s]));
  const vols = live.map((t) => sig.get(t)?.vol30d).filter((v): v is number => typeof v === "number" && v > 0);
  const medVol = vols.length ? vols.sort((a, b) => a - b)[Math.floor(vols.length / 2)] : 0.6;
  const mom = (t: string) => {
    const s = sig.get(t);
    return 0.6 * (s?.ret30d ?? 0) + 0.4 * (s?.ret7d ?? 0);
  };
  const vol = (t: string) => {
    const v = sig.get(t)?.vol30d;
    return typeof v === "number" && v > 0.1 ? v : medVol;
  };

  const raw: Weights = {};
  let investable = 1 - limits.minCash - 0.02 - Object.values(limits.frozen).reduce((a, b) => a + b, 0);
  if (style === "momentum") {
    const ranked = live.map((t) => ({ t, score: mom(t) / vol(t) })).filter((x) => x.score > 0);
    ranked.sort((a, b) => b.score - a.score);
    const top = ranked.slice(0, 2);
    if (top.length < 1) investable = 0;
    else if (top.length < 2) investable *= 0.6;
    for (const { t, score } of top) raw[t] = score;
  } else {
    const tilt = style === "steady" ? 2 : 4;
    const band = style === "steady" ? 0.3 : 0.6;
    for (const t of live) raw[t] = (1 / vol(t)) * (1 + clamp(mom(t) * tilt, -band, band));
  }
  const sum = Object.values(raw).reduce((a, b) => a + b, 0);
  const w: Weights = {};
  for (const t of Object.keys(raw)) {
    w[t] = sum > 0 ? (raw[t] / sum) * Math.max(0, investable) * trendScale(sig.get(t)) : 0;
  }
  return leash(w, limits).weights;
}

/**
 * Trend filter: a coin in a confirmed downtrend (falling over 30 days and still falling this week) keeps only part
 * of its baseline weight; the rest stays in USDT. This is what keeps the baseline from riding a crash.
 */
export function trendScale(s?: Signal): number {
  const r30 = s?.ret30d ?? 0;
  const r7 = s?.ret7d ?? 0;
  if (r30 < -0.25 && r7 < 0) return 0.25;
  if (r30 < -0.15 && r7 < 0) return 0.5;
  if (r30 < 0 && r7 < -0.05) return 0.75;
  return 1;
}

/**
 * The model may tilt the rules baseline, not overturn it, and the leash is asymmetric: it can always cut a weight
 * (down to zero), but it can only add up to `maxTilt` above the baseline, scaled down for coins in a downtrend.
 * Returns the bounded weights and a note for every weight that was pulled back.
 */
export function bounded(
  base: Weights,
  proposal: Weights,
  maxTilt: number,
  signals: Signal[],
): { weights: Weights; notes: string[] } {
  const sig = new Map(signals.map((s) => [s.ticker, s]));
  const notes: string[] = [];
  const weights: Weights = {};
  for (const t of new Set([...Object.keys(base), ...Object.keys(proposal)])) {
    const b = base[t] ?? 0;
    const p = proposal[t] ?? 0;
    const up = maxTilt * trendScale(sig.get(t));
    const w = clamp(p, 0, b + up);
    if (Math.abs(w - p) > 1e-4) {
      notes.push(`${t}: model proposed ${pct(p)}; it may add at most ${pct(up)} to the rules baseline ${pct(b)} -> ${pct(w)}`);
    }
    weights[t] = w;
  }
  return { weights, notes };
}

/**
 * Applies the mandate to a proposal: unknown tickers removed, frozen weights restored, caps enforced with the
 * excess redistributed to names below their cap, and total exposure kept under 1 - minCash.
 * Returns the human-readable list of corrections so the rationale shows where the leash pulled.
 */
export function leash(proposal: Weights, limits: Limits): { weights: Weights; corrections: string[] } {
  const corrections: string[] = [];
  const w: Weights = {};
  for (const [t, x] of Object.entries(proposal)) {
    if (!(t in limits.caps)) {
      if (x > 0) corrections.push(`${t}: not in the mandate, dropped (${pct(x)})`);
      continue;
    }
    if (t in limits.frozen) continue;
    if (!Number.isFinite(x) || x < 0) {
      corrections.push(`${t}: invalid weight ${x}, set to 0`);
      continue;
    }
    w[t] = x;
  }
  for (const [t, x] of Object.entries(limits.frozen)) {
    if (proposal[t] !== undefined && Math.abs(proposal[t] - x) > 1e-4) {
      corrections.push(`${t}: oracle stale, weight kept at ${pct(x)} instead of ${pct(proposal[t])}`);
    }
    w[t] = x;
  }

  const maxInvest = 1 - limits.minCash - 0.005;
  for (let iter = 0; iter < 10; iter++) {
    let excess = 0;
    for (const t of Object.keys(w)) {
      if (t in limits.frozen) continue;
      const cap = limits.caps[t] - 0.003;
      if (w[t] > cap) {
        if (iter === 0) corrections.push(`${t}: ${pct(w[t])} exceeds cap ${pct(limits.caps[t])}, clipped`);
        excess += w[t] - cap;
        w[t] = cap;
      }
    }
    if (excess < 1e-6) break;
    const room = Object.keys(w).filter((t) => !(t in limits.frozen) && w[t] > 0 && w[t] < limits.caps[t] - 0.003);
    const roomTotal = room.reduce((a, t) => a + w[t], 0);
    if (!room.length || roomTotal <= 0) break;
    for (const t of room) w[t] += (excess * w[t]) / roomTotal;
  }

  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total > maxInvest) {
    const frozenTotal = Object.entries(w)
      .filter(([t]) => t in limits.frozen)
      .reduce((a, [, x]) => a + x, 0);
    const scale = Math.max(0, maxInvest - frozenTotal) / Math.max(1e-9, total - frozenTotal);
    corrections.push(`total exposure ${pct(total)} above ${pct(maxInvest)} (cash floor ${pct(limits.minCash)}), scaled down`);
    for (const t of Object.keys(w)) if (!(t in limits.frozen)) w[t] *= scale;
  }
  return { weights: w, corrections };
}

export const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
