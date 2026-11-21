import type { ReactNode } from "react";
import { EXPLORER, MAINNET_EXPLORER } from "./config";
import { short } from "./util";

export function Card({ title, extra, children, className = "" }: { title?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || extra) && (
        <div className="card-head">
          {title && <h3>{title}</h3>}
          {extra && <div className="card-extra">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Badge({ tone = "neutral", children, title }: { tone?: "ok" | "warn" | "bad" | "neutral" | "blue"; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${tone}`} title={title}>
      {children}
    </span>
  );
}

/** Weight versus cap: the filled part is the position, the marker is the cap the agent cannot cross. */
export function WeightBar({ weightBps, capBps, cash = false }: { weightBps: number; capBps: number; cash?: boolean }) {
  const w = Math.min(100, weightBps / 100);
  const c = Math.min(100, capBps / 100);
  const over = capBps > 0 && weightBps > capBps;
  return (
    <div className="wbar" title={`${(weightBps / 100).toFixed(1)}% of NAV${capBps ? `, cap ${(capBps / 100).toFixed(0)}%` : ""}`}>
      <div className={`wbar-fill ${over ? "over" : ""} ${cash ? "cash" : ""}`} style={{ width: `${w}%` }} />
      {capBps > 0 && <div className="wbar-cap" style={{ left: `${c}%` }} />}
    </div>
  );
}

export function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="mono" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      {label ?? short(hash, 6)}
    </a>
  );
}

export function AddrLink({ address, label, mainnet = false }: { address: string; label?: string; mainnet?: boolean }) {
  return (
    <a className="mono" href={`${mainnet ? MAINNET_EXPLORER : EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {label ?? short(address)}
    </a>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="loading" />;
}

export function LineChart({ points, height = 150 }: { points: Array<[number, number]>; height?: number }) {
  if (points.length < 2) return <div className="muted small">NAV history appears after a few agent runs.</div>;
  const w = 640;
  const h = height;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const mid = (Math.min(...ys) + Math.max(...ys)) / 2;
  // Never zoom in closer than ±1% of NAV, so spread costs do not look like a crash.
  const half = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.65, Math.abs(mid) * 0.01, 1);
  const lo = mid - half;
  const hi = mid + half;
  const sx = (x: number) => ((x - x0) / Math.max(1, x1 - x0)) * (w - 8) + 4;
  const sy = (y: number) => h - 6 - ((y - lo) / (hi - lo)) * (h - 12);
  const d = points.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join(" ");
  const first = ys[0];
  const last = ys[ys.length - 1];
  const up = last >= first;
  const chg = first ? (last / first - 1) * 100 : 0;
  const money = (v: number) => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return (
    <div className="chart-wrap">
      <div className="chart-meta small">
        <span className={up ? "pos" : "neg"}>
          {chg >= 0 ? "+" : ""}
          {chg.toFixed(2)}% since {new Date(x0).toLocaleDateString()}
        </span>
        <span className="muted">
          range {money(lo)} – {money(hi)}
        </span>
      </div>
      <svg className="chart" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="NAV history">
        <line x1="0" x2={w} y1={sy(first)} y2={sy(first)} className="baseline" />
        <path d={`${d} L${sx(x1)},${h} L${sx(x0)},${h} Z`} className={up ? "area up" : "area down"} />
        <path d={d} className={up ? "line up" : "line down"} />
      </svg>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
