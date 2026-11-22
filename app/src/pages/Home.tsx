import { DEP, IS_MAINNET } from "../config";
import { loadKeeper, loadMarket, loadStatus, loadVault, loadVaultList, type VaultData } from "../data";
import { Badge, Card, Spinner, WeightBar } from "../ui";
import { ago, fmtPct, fmtUsd, short, useAsync } from "../util";

const PROFILE_NAMES: Record<string, string> = { steady: "Conservative", balanced: "Balanced", momentum: "Aggressive" };

function VaultCard({ address, name, profile }: { address: `0x${string}`; name: string; profile?: string }) {
  const { data: v, error } = useAsync(() => loadVault(address), [address], 60_000);
  const top = v ? [...v.holdings].sort((a, b) => b.weightBps - a.weightBps) : [];
  return (
    <a className="vault-card" href={`#/vault/${address}`}>
      <div className="vc-head">
        <div>
          <div className="vc-name">{name}</div>
          <div className="muted small">
            {profile ? `${PROFILE_NAMES[profile] ?? profile} · ` : ""}
            <span className="mono">{short(address)}</span>
          </div>
        </div>
        {v &&
          (v.breakerTripped ? (
            <Badge tone="bad">breaker tripped</Badge>
          ) : v.paused ? (
            <Badge tone="warn">paused</Badge>
          ) : (
            <Badge tone="ok">agent active</Badge>
          ))}
      </div>
      {error && <div className="err small">{error}</div>}
      {!v && !error && <Spinner />}
      {v && <VaultSummary v={v} />}
      {v && (
        <div className="vc-holdings">
          {top.map((h) => (
            <div key={h.token} className="vc-row">
              <span className="tick">{h.ticker}</span>
              <WeightBar weightBps={h.weightBps} capBps={h.capBps} />
              <span className="num small">{(h.weightBps / 100).toFixed(1)}%</span>
            </div>
          ))}
          {!top.some((h) => h.weightBps > 0) && <div className="muted small">All in USDT right now.</div>}
        </div>
      )}
    </a>
  );
}

function VaultSummary({ v }: { v: VaultData }) {
  const pnlPct = v.netDeposits ? v.pnl / v.netDeposits : 0;
  return (
    <div className="vc-stats">
      <div>
        <div className="stat-label">NAV</div>
        <div className="stat-value">{fmtUsd(v.nav, 0)}</div>
      </div>
      <div>
        <div className="stat-label">P&amp;L</div>
        <div className={`stat-value ${v.pnl >= 0 ? "pos" : "neg"}`}>
          {pnlPct >= 0 ? "+" : ""}
          {fmtPct(pnlPct, 2)}
        </div>
      </div>
      <div>
        <div className="stat-label">Stop / breaker</div>
        <div className="stat-value">
          {v.mandate.stopLossBps / 100}% / {v.mandate.maxDrawdownBps / 100}%
        </div>
      </div>
    </div>
  );
}

function Market() {
  const { data: rows, error } = useAsync(loadMarket, [], 60_000);
  const { data: status } = useAsync(loadStatus, [], 120_000);
  const { data: keeper } = useAsync(loadKeeper, [], 120_000);
  const sig = new Map((status?.latest.research?.signals ?? []).map((s) => [s.ticker, s]));
  const main = new Map((keeper?.latest.mainnet ?? []).map((m) => [m.ticker, m]));
  return (
    <Card
      className="market"
      title="Live market: what the vaults are priced at"
      extra={
        <span className="muted small">
          {IS_MAINNET
            ? "read live on HSK Chain mainnet: the vaults' 30-minute TWAP feeds and the HSKSwap pools"
            : "HSK Chain mainnet prices, mirrored to testnet every hour by the keeper"}
        </span>
      }
    >
      {error && <div className="err">{error}</div>}
      {!rows && !error && <Spinner />}
      {rows && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Coin</th>
                <th className="num">{IS_MAINNET ? "Oracle (30-min TWAP)" : "Oracle"}</th>
                <th className="num">{IS_MAINNET ? "HSKSwap pool (spot)" : "Testnet HSKSwap pool"}</th>
                <th className="num">{IS_MAINNET ? "APRO (reference)" : "Mainnet HSKSwap TWAP"}</th>
                <th className="num">7d</th>
                <th className="num">30d</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const s = sig.get(r.ticker);
                const m = main.get(r.ticker);
                const digits = r.oracle < 1 ? 5 : 2;
                return (
                  <tr key={r.ticker}>
                    <td>
                      <b>{r.ticker}</b>
                    </td>
                    <td className="num">
                      {fmtUsd(r.oracle, digits)} <span className="muted small">{ago(r.updatedAt)}</span>
                    </td>
                    <td className="num">
                      {fmtUsd(r.pool, digits)}{" "}
                      <Badge tone={r.tradable ? "ok" : "warn"} title="The desk refuses to trade a pool more than 2% away from its oracle">
                        gap {(r.gapBps / 100).toFixed(2)}%
                      </Badge>
                    </td>
                    <td className="num">{m ? (IS_MAINNET ? (m.source === "apro" ? fmtUsd(m.price, digits) : "–") : fmtUsd(m.poolTwap, digits)) : "–"}</td>
                    <td className={`num ${(s?.ret7d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s?.ret7d)}</td>
                    <td className={`num ${(s?.ret30d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s?.ret30d)}</td>
                    <td className="small muted">
                      {IS_MAINNET ? "TwapFeed over the mainnet HSKSwap pool" : m?.source === "apro" ? "APRO feed (mainnet)" : "HSKSwap 30-min TWAP (mainnet)"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function Home() {
  const { data: list } = useAsync(loadVaultList, [], 120_000);
  const demo = new Map(DEP.demoVaults.map((d) => [d.vault.toLowerCase(), d]));
  const others = (list ?? []).filter((a) => !demo.has(a.toLowerCase()));
  return (
    <div className="page">
      <section className="hero">
        <div className="hero-text">
          <h1>
            An AI trader for HSKSwap.
            <br />
            <span className="blue">On a leash.</span>
          </h1>
          <p className="lead">
            Leash vaults trade HSK, BTC and ETH against USDT on HSKSwap. You write the rules into the vault: which coins,
            how big each position may be, how often the agent may trade, a stop-loss and a drawdown breaker. An AI agent
            researches and trades; the vault checks every trade against your rules and enforces the stop-loss itself. Talk
            to the agent to see your positions and change the rules.
          </p>
          <div className="hero-cta">
            <a className="btn" href={DEP.demoVaults.length ? `#/vault/${(DEP.demoVaults[1] ?? DEP.demoVaults[0]).vault}` : "#/create"}>
              Talk to a live vault
            </a>
            <a className="btn ghost" href="#/create">
              Create your own
            </a>
          </div>
        </div>
        <div className="hero-art" aria-hidden>
          <svg viewBox="0 0 360 240">
            <rect x="200" y="62" width="146" height="126" rx="16" fill="#E7F6F0" stroke="#0B8A62" strokeWidth="2" />
            <text x="273" y="94" textAnchor="middle" className="art-t">
              Vault
            </text>
            <text x="273" y="116" textAnchor="middle" className="art-s">
              caps · trade frequency
            </text>
            <text x="273" y="134" textAnchor="middle" className="art-s">
              stop-loss · breaker
            </text>
            <text x="273" y="160" textAnchor="middle" className="art-s">
              → HSKSwap
            </text>
            <circle cx="60" cy="125" r="34" fill="#111827" />
            <text x="60" y="131" textAnchor="middle" className="art-w">
              AI
            </text>
            <path d="M94 125 C 130 80, 160 170, 200 125" stroke="#0B8A62" strokeWidth="3" strokeDasharray="6 6" fill="none" />
            <text x="148" y="98" textAnchor="middle" className="art-s">
              mandate
            </text>
          </svg>
        </div>
      </section>

      <section className="steps">
        <div className="step">
          <span className="step-n">1</span>
          <h4>You set the rules</h4>
          <p>Pick a risk appetite, then fine-tune position caps, trade frequency, stop-loss and drawdown breaker, in plain words.</p>
        </div>
        <div className="step">
          <span className="step-n">2</span>
          <h4>The agent trades</h4>
          <p>It reads HSK Chain mainnet prices and HSKSwap pool data, proposes weights with an LLM and publishes its reasoning.</p>
        </div>
        <div className="step">
          <span className="step-n">3</span>
          <h4>The vault enforces</h4>
          <p>Out-of-rule trades revert. Stop-losses and the breaker are executed by anyone, even if the agent is offline.</p>
        </div>
      </section>

      {IS_MAINNET ? (
        <>
          <h2 className="section-title">Live on HSK Chain mainnet: real USDT, real HSKSwap pools</h2>
          <p className="small muted">
            One small vault (about a dollar) runs the same contracts and the same agent as the testnet demo. Every
            trade below is a real swap in an HSKSwap mainnet pool, checked by the vault against its rules.
          </p>
        </>
      ) : (
        <h2 className="section-title">Live vaults, traded by the Leash agent on HSK Chain testnet</h2>
      )}
      <div className="grid3">
        {DEP.demoVaults.map((d) => (
          <VaultCard key={d.vault} address={d.vault} name={d.name} profile={d.profile} />
        ))}
      </div>

      {others.length > 0 && (
        <>
          <h2 className="section-title">Community vaults</h2>
          <div className="grid3">
            {others.slice(0, 9).map((a) => (
              <VaultCard key={a} address={a} name="Vault" />
            ))}
          </div>
        </>
      )}

      <Market />
    </div>
  );
}
