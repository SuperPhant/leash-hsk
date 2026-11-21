// LLM step: asks an OpenAI-compatible chat endpoint to review the baseline allocation and write the
// rationale. Default: the free, keyless Pollinations endpoint (open-weight gpt-oss model). Configure another provider
// with LEASH_LLM_ENDPOINT / LEASH_LLM_KEY / LEASH_MODEL. The model only proposes; every number it returns goes
// through `leash()` and the vault's onchain checks, and the agent falls back to its rules when the model is unavailable.
import type { Signal } from "./research.js";
import type { Weights } from "./strategy.js";

export interface LlmDecision {
  model: string;
  targets: Weights;
  summary: string;
  perAsset: Record<string, string>;
  risks: string[];
}

const ENDPOINT = process.env.LEASH_LLM_ENDPOINT ?? "https://text.pollinations.ai/openai";
const MODEL = process.env.LEASH_MODEL ?? "openai";
const KEY = process.env.LEASH_LLM_KEY;
// The keyless tier allows one reply per 45 s per IP.
const MIN_INTERVAL_MS = Number(process.env.LEASH_LLM_MIN_INTERVAL_MS ?? (KEY ? 0 : 47_000));
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/** Maps what a model may write (WBTC, tWETH, whsk, ...) to the vault's tickers HSK / BTC / ETH. */
export function normalizeTicker(raw: string): string {
  const t = raw.trim().toUpperCase().replace(/^T(?=W?(BTC|ETH|HSK)$)/, "").replace(/^W(?=(BTC|ETH|HSK)$)/, "");
  return t;
}

function fmt(x: number | null, digits = 1) {
  return x === null || x === undefined ? "n/a" : `${(x * 100).toFixed(digits)}%`;
}

export async function askModel(input: {
  profileName: string;
  style: string;
  caps: Record<string, number>;
  minCash: number;
  frozen: string[];
  signals: Signal[];
  current: Weights;
  baseline: Weights;
  maxTilt: number;
}): Promise<LlmDecision | null> {
  if (process.env.LEASH_NO_LLM === "1") return null;

  const rows = input.signals
    .filter((s) => s.ticker in input.caps)
    .map(
      (s) =>
        `${s.ticker}: price ${s.price < 1 ? s.price.toFixed(5) : s.price.toFixed(2)} (oracle age ${s.ageHours.toFixed(1)}h${s.stale ? ", STALE" : ""}), 1d ${fmt(s.ret1d)}, 7d ${fmt(s.ret7d)}, 30d ${fmt(s.ret30d)}, vol30d ${fmt(s.vol30d, 0)}, maxDD30d ${fmt(s.maxDrawdown30d)}, HSKSwap mainnet USDT depth ${s.mainnetPoolUsdtDepth === null ? "n/a" : `$${Math.round(s.mainnetPoolUsdtDepth).toLocaleString("en-US")}`}, pool vs APRO ${s.aproVsPoolBps === null ? "n/a" : `${s.aproVsPoolBps} bps`}, cap ${fmt(input.caps[s.ticker], 0)}, now ${fmt(input.current[s.ticker] ?? 0)}, baseline ${fmt(input.baseline[s.ticker] ?? 0)}`,
    )
    .join("\n");

  const system = [
    "You are the Leash trading agent on HSK Chain. You manage a portfolio of HSK, BTC and ETH against USDT for a vault owner,",
    "trading on HSKSwap. You act only inside an onchain mandate the owner set (caps, cash floor, turnover, trade frequency,",
    "stop-loss and drawdown breaker). Your proposal is checked by code and by the vault contract; anything outside the limits",
    "is cut, so propose within them. Prices are HSK Chain mainnet APRO feeds (ETH: HSKSwap 30-minute TWAP).",
    "Aim for steady risk-adjusted returns, not maximum exposure: in a downtrend holding more cash is a valid answer.",
    "Do not trade coins whose oracle is STALE or that are blocked after a stop-loss: keep their current weight.",
    "Be concise and factual. Reply with JSON only.",
  ].join(" ");

  const user = [
    `Vault profile: ${input.profileName}. Style: ${input.style}`,
    `Hard limits: per-name caps as listed, keep at least ${fmt(input.minCash, 0)} in cash.`,
    `Frozen (stale oracle or re-entry blocked after a stop-loss): ${input.frozen.length ? input.frozen.join(", ") : "none"}.`,
    "Signals (vol annualised over 365 days; depth and APRO gap are HSK Chain mainnet onchain data):",
    rows,
    "",
    "Start from the baseline (inverse-volatility sizing, a trend tilt and a downtrend filter) and adjust only where the signals justify it.",
    `You may always cut a weight, but you may add at most ${fmt(input.maxTilt, 0)} of NAV above the baseline (less for coins in a downtrend); larger additions are cut.`,
    'Return {"targets": {"TICKER": percent_of_nav_number, ...}, "summary": "<=60 words", "perAsset": {"TICKER": "<=20 words"}, "risks": ["<=3 short items"]}.',
    "Targets are percentages (0-100) of NAV; omitted tickers mean 0. Do not include cash in targets.",
  ].join("\n");

  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (KEY) headers.Authorization = `Bearer ${KEY}`;
  const payload = JSON.stringify({
    model: MODEL,
    temperature: 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await throttle();
      const res = await fetch(ENDPOINT, { method: "POST", headers, body: payload, signal: AbortSignal.timeout(120_000) });
      if (res.status === 402 || res.status === 429 || res.status >= 500) {
        const text = await res.text();
        const retry = Number(/retry after (\d+)/i.exec(text)?.[1] ?? 20);
        console.warn(`model busy (HTTP ${res.status}), retrying in ${retry + 2}s`);
        await new Promise((r) => setTimeout(r, (Math.min(retry, 90) + 2) * 1000));
        lastCallAt = 0;
        continue;
      }
      if (!res.ok) {
        console.warn(`model call failed: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
        return null;
      }
      const body = await res.json();
      const content = String(body.choices?.[0]?.message?.content ?? "{}");
      const parsed = JSON.parse(content.slice(content.indexOf("{"), content.lastIndexOf("}") + 1));
      const targets: Weights = {};
      for (const [t, v] of Object.entries(parsed.targets ?? {})) {
        const n = Number(v);
        if (Number.isFinite(n)) targets[normalizeTicker(t)] = n / 100;
      }
      if (!Object.keys(targets).length) return null;
      return {
        model: String(body.model ?? MODEL),
        targets,
        summary: String(parsed.summary ?? "").slice(0, 600),
        perAsset: Object.fromEntries(
          Object.entries(parsed.perAsset ?? {}).map(([k, v]) => [normalizeTicker(k), String(v).slice(0, 200)]),
        ),
        risks: Array.isArray(parsed.risks) ? parsed.risks.slice(0, 3).map((r: unknown) => String(r).slice(0, 200)) : [],
      };
    } catch (e) {
      console.warn(`model call failed: ${(e as Error).message}`);
      if (attempt === 2) return null;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
  return null;
}
