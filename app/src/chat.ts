// The conversational interface: turns what the owner types into either an answer (positions, profit and loss, why the
// agent traded) or a proposed change to the onchain mandate, which the owner then signs. Instructions are parsed in the
// browser (no server, no API key), including plain-language moods like "I'm worried about a crash". Explanations of
// trades come from the agent's own LLM rationale, checked against the hash it committed onchain. Every action is
// clamped to what the vault contract accepts before it is shown.
import { PRESETS, TOKEN_BY_TICKER } from "./config";
import type { Mandate, VaultData } from "./data";
import { fmtPct, fmtUsd } from "./util";

export type Action =
  | { type: "preset"; preset: string }
  | { type: "cap"; ticker: string; capBps: number }
  | { type: "scaleCaps"; factor: number }
  | { type: "cooldown"; seconds: number }
  | { type: "stopLoss"; bps: number }
  | { type: "drawdown"; bps: number }
  | { type: "minCash"; bps: number }
  | { type: "turnover"; bps: number }
  | { type: "pause" }
  | { type: "resume" };

export interface Reply {
  text: string;
  /** Rows to show as a small table (positions, risk). */
  table?: Array<[string, string]>;
  actions: Action[];
  source: "rules" | "help";
}

export interface Proposal {
  mandate: Mandate;
  caps: Array<{ ticker: string; token: `0x${string}`; from: number; to: number }>;
  paused?: boolean;
  diffs: string[];
}

const COINS: Record<string, string> = { hsk: "HSK", btc: "BTC", bitcoin: "BTC", wbtc: "BTC", eth: "ETH", ether: "ETH", ethereum: "ETH", weth: "ETH" };
const COIN_RE = "(hsk|btc|bitcoin|wbtc|eth|ether|ethereum|weth)";
const num = (s: string) => Number(s.replace(/,/g, ""));
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const hours = (s: number) => (s % 3600 === 0 ? `${s / 3600}h` : `${(s / 3600).toFixed(1)}h`);

export function statusReply(v: VaultData): Reply {
  const pnlPct = v.netDeposits > 0 ? v.pnl / v.netDeposits : 0;
  const rows: Array<[string, string]> = [
    ["Net asset value", fmtUsd(v.nav)],
    ["Profit / loss", `${v.pnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(v.pnl))} (${pnlPct >= 0 ? "+" : ""}${fmtPct(pnlPct, 2)})`],
    ["Cash (USDT)", `${fmtUsd(v.cash)} · ${fmtPct(v.nav ? v.cash / v.nav : 0)}`],
    ["Drawdown from peak", `${(v.drawdownBps / 100).toFixed(2)}%${v.breakerTripped ? " · breaker TRIPPED (sells only)" : ""}`],
  ];
  for (const h of v.holdings) {
    if (h.raw === 0n) continue;
    rows.push([
      `${h.ticker} ${h.amount.toLocaleString("en-US", { maximumFractionDigits: h.ticker === "BTC" ? 5 : 3 })}`,
      `${fmtUsd(h.value)} · ${fmtPct(h.weightBps / 10_000)} of NAV · entry ${fmtUsd(h.entryPrice, h.entryPrice < 1 ? 5 : 2)} · ${h.upnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(h.upnl))}${h.stopPrice ? ` · stop ${fmtUsd(h.stopPrice, h.stopPrice < 1 ? 5 : 2)}` : ""}`,
    ]);
  }
  const open = v.holdings.filter((h) => h.raw > 0n).length;
  return {
    text: open ? `Here is your vault right now (oracle prices, updated live):` : `Your vault is all in cash right now:`,
    table: rows,
    actions: [],
    source: "rules",
  };
}

export function rulesReply(text: string, v: VaultData): Reply | null {
  const t = ` ${text.toLowerCase().replace(/[’']/g, "'")} `;
  const actions: Action[] = [];

  if (/\b(help|what can you do|commands?)\b/.test(t)) return helpReply();

  if (/\b(resume|unpause|start trading again|restart|turn (the agent )?on)\b/.test(t)) actions.push({ type: "resume" });
  else if (/\b(pause|halt|freeze|stop the agent|turn (the agent )?off|stop trading)\b/.test(t) && !new RegExp(`stop trading ${COIN_RE}`).test(t)) {
    actions.push({ type: "pause" });
  }

  if (/\b(conservative|safer|less risk|lower risk|defensive|careful|risk[- ]off)\b/.test(t)) actions.push({ type: "preset", preset: "steady" });
  else if (/\b(balanced|moderate|medium risk|middle)\b/.test(t)) actions.push({ type: "preset", preset: "balanced" });
  else if (/\b(aggressive|more risk|higher risk|riskier|risk[- ]on|yolo)\b/.test(t)) actions.push({ type: "preset", preset: "momentum" });
  else if (/\b(worried|nervous|scared|afraid|anxious|crash|dump|protect|de-?risk|cautious|bearish|sleep)\b/.test(t)) {
    // A mood, not a number: tighten the stop and keep more cash, but do not sell everything unless asked.
    actions.push({ type: "stopLoss", bps: Math.max(300, Math.min(v.mandate.stopLossBps || 1000, 600)) });
    actions.push({ type: "minCash", bps: Math.max(v.mandate.minCashBps, 4000) });
    actions.push({ type: "drawdown", bps: Math.max(500, Math.min(v.mandate.maxDrawdownBps || 1500, 1000)) });
  } else if (/\b(bullish|optimistic|confident|opportunit\w*|upside|rally|pump)\b/.test(t)) {
    actions.push({ type: "minCash", bps: Math.max(500, Math.round(v.mandate.minCashBps / 2)) });
    actions.push({ type: "scaleCaps", factor: 1.2 });
  }
  if (/\b(too many trades|fees|overtrading|churn)\b/.test(t)) actions.push({ type: "cooldown", seconds: Math.max(v.mandate.cooldown * 2, 6 * 3600) });

  for (const m of t.matchAll(new RegExp(`(?:max|at most|no more than|limit|cap|up to)\\s*(?:of\\s*)?(\\d+(?:\\.\\d+)?)\\s*%\\s*(?:in|of|for|on|to)?\\s*${COIN_RE}`, "g"))) {
    actions.push({ type: "cap", ticker: COINS[m[2]], capBps: Math.round(num(m[1]) * 100) });
  }
  for (const m of t.matchAll(new RegExp(`${COIN_RE}\\s*(?:cap|limit|max|position|weight)?\\s*(?:at|to|=|of)?\\s*(?:max\\s*)?(\\d+(?:\\.\\d+)?)\\s*%`, "g"))) {
    if (!actions.some((a) => a.type === "cap" && a.ticker === COINS[m[1]])) {
      actions.push({ type: "cap", ticker: COINS[m[1]], capBps: Math.round(num(m[2]) * 100) });
    }
  }
  for (const m of t.matchAll(new RegExp(`(?:stop|don't|do not|no more|quit|exclude|avoid|drop)\\s*(?:buying|trading|holding)?\\s*${COIN_RE}`, "g"))) {
    actions.push({ type: "cap", ticker: COINS[m[1]], capBps: 0 });
  }
  for (const m of t.matchAll(new RegExp(`(?:add|include|allow|trade|buy|start trading)\\s*${COIN_RE}`, "g"))) {
    const ticker = COINS[m[1]];
    if (!actions.some((a) => a.type === "cap" && a.ticker === ticker)) actions.push({ type: "cap", ticker, capBps: 2500 });
  }

  if (/\b(smaller|reduce|lower|cut) (the )?(position|trade)s?( size)?\b/.test(t)) actions.push({ type: "scaleCaps", factor: 0.7 });
  else if (/\b(bigger|larger|increase|raise) (the )?(position|trade)s?( size)?\b/.test(t)) actions.push({ type: "scaleCaps", factor: 1.3 });

  const every = /(?:every|once every|at most every|no more than once every|once per|once a)\s*(\d+(?:\.\d+)?)?\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?)\b/.exec(t);
  if (every) {
    const n = every[1] ? num(every[1]) : 1;
    const unit = every[2].startsWith("m") ? 60 : every[2].startsWith("d") ? 86_400 : 3600;
    actions.push({ type: "cooldown", seconds: Math.round(n * unit) });
  } else if (/\b(trade less|less often|less frequently|slow down|fewer trades)\b/.test(t)) {
    actions.push({ type: "cooldown", seconds: v.mandate.cooldown * 2 });
  } else if (/\b(trade more|more often|more frequently|speed up|more trades)\b/.test(t)) {
    actions.push({ type: "cooldown", seconds: Math.max(3600, Math.round(v.mandate.cooldown / 2)) });
  }

  const sl = /stop[- ]?loss(?:es)?\s*(?:to|at|of|=)?\s*(\d+(?:\.\d+)?)\s*%/.exec(t) ?? /(\d+(?:\.\d+)?)\s*%\s*stop[- ]?loss/.exec(t);
  if (sl) actions.push({ type: "stopLoss", bps: Math.round(num(sl[1]) * 100) });
  else if (/\b(no|disable|remove|turn off) stop[- ]?loss/.test(t)) actions.push({ type: "stopLoss", bps: 0 });
  else if (/\b(tighter|tighten) stop/.test(t)) actions.push({ type: "stopLoss", bps: Math.max(300, Math.round((v.mandate.stopLossBps || 1200) * 0.7)) });
  else if (/\b(looser|loosen|wider) stop/.test(t)) actions.push({ type: "stopLoss", bps: Math.round((v.mandate.stopLossBps || 1000) * 1.4) });

  const dd = /(?:drawdown|breaker|max loss)\s*(?:limit|breaker)?\s*(?:to|at|of|=)?\s*(\d+(?:\.\d+)?)\s*%/.exec(t);
  if (dd) actions.push({ type: "drawdown", bps: Math.round(num(dd[1]) * 100) });

  const cash = /(\d+(?:\.\d+)?)\s*%\s*(?:in\s*)?(?:cash|usdt|stable)/.exec(t);
  if (cash) actions.push({ type: "minCash", bps: Math.round(num(cash[1]) * 100) });

  if (actions.length) return { text: "", actions, source: "rules" };
  if (/\b(how am i|how are we|how is (my|the) (vault|portfolio)|positions?|pnl|p&l|profit|loss|balance|holdings?|status|doing|worth|nav)\b/.test(t)) {
    return statusReply(v);
  }
  return null;
}

export function helpReply(): Reply {
  return {
    text:
      "I can show your positions and profit, explain my last trade, and change the rules I trade under. Every change is a transaction you sign; the vault enforces it, not me. Try:",
    table: [
      ["See positions", "how am I doing?"],
      ["Risk appetite", "be more conservative · go aggressive"],
      ["Position size", "max 20% in HSK · smaller positions"],
      ["Trade frequency", "trade at most every 6 hours"],
      ["Target assets", "stop trading ETH · add BTC"],
      ["Stop-loss / breaker", "stop loss 8% · drawdown breaker 15%"],
      ["Cash", "keep 40% in cash"],
      ["On / off", "pause · resume"],
    ],
    actions: [],
    source: "help",
  };
}

/** Applies actions to the current mandate and caps, clamped to what LeashVault._setMandate accepts. */
export function propose(v: VaultData, actions: Action[]): Proposal {
  const m: Mandate = { ...v.mandate };
  const caps = new Map(v.holdings.map((h) => [h.ticker, h.capBps]));
  let paused: boolean | undefined;
  const diffs: string[] = [];
  for (const a of actions) {
    if (a.type === "preset") {
      const p = PRESETS.find((x) => x.id === a.preset)!;
      Object.assign(m, p.mandate);
      p.tickers.forEach((t, i) => caps.set(t, p.caps[i]));
      diffs.push(`Risk appetite → ${p.name}: ${p.blurb}`);
    } else if (a.type === "cap") {
      caps.set(a.ticker, clamp(a.capBps, 0, 10_000));
    } else if (a.type === "scaleCaps") {
      for (const [t, c] of caps) caps.set(t, clamp(Math.round(c * a.factor), 0, 10_000));
    } else if (a.type === "cooldown") {
      m.cooldown = clamp(a.seconds, 15 * 60, 7 * 86_400);
    } else if (a.type === "stopLoss") {
      m.stopLossBps = clamp(a.bps, 0, 9_000);
    } else if (a.type === "drawdown") {
      m.maxDrawdownBps = clamp(a.bps, 0, 9_000);
    } else if (a.type === "minCash") {
      m.minCashBps = clamp(a.bps, 0, 10_000);
    } else if (a.type === "turnover") {
      m.maxTurnoverBps = clamp(a.bps, 100, 40_000);
    } else if (a.type === "pause") {
      paused = true;
    } else if (a.type === "resume") {
      paused = false;
    }
  }
  const o = v.mandate;
  if (m.cooldown !== o.cooldown) diffs.push(`Trade frequency: at most every ${hours(o.cooldown)} → every ${hours(m.cooldown)}`);
  if (m.stopLossBps !== o.stopLossBps)
    diffs.push(`Stop-loss: ${o.stopLossBps ? `${o.stopLossBps / 100}%` : "off"} → ${m.stopLossBps ? `${m.stopLossBps / 100}% below entry` : "off"}`);
  if (m.maxDrawdownBps !== o.maxDrawdownBps)
    diffs.push(`Drawdown breaker: ${o.maxDrawdownBps ? `${o.maxDrawdownBps / 100}%` : "off"} → ${m.maxDrawdownBps ? `${m.maxDrawdownBps / 100}%` : "off"}`);
  if (m.minCashBps !== o.minCashBps) diffs.push(`Cash floor: ${o.minCashBps / 100}% → ${m.minCashBps / 100}%`);
  if (m.maxTurnoverBps !== o.maxTurnoverBps) diffs.push(`Daily turnover: ${o.maxTurnoverBps / 100}% → ${m.maxTurnoverBps / 100}%`);
  if (m.maxSlippageBps !== o.maxSlippageBps) diffs.push(`Max slippage: ${o.maxSlippageBps / 100}% → ${m.maxSlippageBps / 100}%`);
  if (m.expiry <= Math.floor(Date.now() / 1000) + 3600) {
    m.expiry = Math.floor(Date.now() / 1000) + 90 * 86_400;
    diffs.push("Mandate expiry extended by 90 days");
  }
  const capChanges: Proposal["caps"] = [];
  for (const [ticker, to] of caps) {
    const from = v.holdings.find((h) => h.ticker === ticker)?.capBps ?? 0;
    const token = TOKEN_BY_TICKER.get(ticker);
    if (token && from !== to) {
      capChanges.push({ ticker, token, from, to });
      diffs.push(to === 0 ? `${ticker}: stop buying (sell-only)` : `${ticker} max position: ${from / 100}% → ${to / 100}% of NAV`);
    }
  }
  if (paused === true && !v.paused) diffs.push("Pause the agent (risk rules and your withdrawals keep working)");
  if (paused === false && v.paused) diffs.push("Resume the agent");
  return { mandate: m, caps: capChanges, paused: paused === undefined || paused === v.paused ? undefined : paused, diffs };
}

export function mandateChanged(a: Mandate, b: Mandate): boolean {
  return (Object.keys(a) as Array<keyof Mandate>).some((k) => a[k] !== b[k]);
}
