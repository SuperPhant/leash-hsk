import { useEffect, useState } from "react";

export const fmtUsd = (x: number, digits = 2) =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
export const fmtPct = (x: number | null | undefined, digits = 1) =>
  x === null || x === undefined || !Number.isFinite(x) ? "–" : `${(x * 100).toFixed(digits)}%`;
export const fmtBps = (bps: number, digits = 1) => `${(bps / 100).toFixed(digits)}%`;
export const short = (a?: string, n = 4) => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "");

export function ago(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function duration(s: number): string {
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s >= 86400) return `${(s / 86400).toFixed(1)}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  // Results are tagged with the deps they belong to, so a different subject (e.g. another vault) is never
  // rendered with the previous subject's data, not even for one frame.
  const depsKey = JSON.stringify(deps, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>({ key: depsKey });
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && setState({ key: depsKey, data: d }))
      .catch((e) => {
        if (!alive) return;
        const msg = e?.shortMessage ?? e?.message ?? String(e);
        setState((s) => ({ key: depsKey, data: s.key === depsKey ? s.data : undefined, error: msg }));
      })
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey, tick]);
  useEffect(() => {
    if (!pollMs) return;
    const id = setInterval(() => setTick((t) => t + 1), pollMs);
    return () => clearInterval(id);
  }, [pollMs]);
  const fresh = state.key === depsKey;
  return { data: fresh ? state.data : undefined, error: fresh ? state.error : undefined, loading, reload: () => setTick((t) => t + 1) };
}