import { DEP, IS_MAINNET, REPO } from "../config";
import { loadKeeper, loadStatus } from "../data";
import { AddrLink, Badge, Card, Empty, Spinner, TxLink } from "../ui";
import { fmtPct, fmtUsd, short, useAsync } from "../util";

export function AgentPage() {
  const { data: status, error } = useAsync(loadStatus, [], 120_000);
  const { data: keeper } = useAsync(loadKeeper, [], 120_000);
  const run = status?.latest;
  const k = keeper?.latest;
  return (
    <div className="page">
      <h1>Agent and keeper</h1>
      {IS_MAINNET ? (
        <p className="lead">
          On HSK Chain mainnet one GitHub Actions job runs once a day. Its <b>keeper pass</b> first sells any position
          whose stop-loss or drawdown breaker has triggered (anyone may call <code>stopOut</code>); then the <b>agent</b>{" "}
          researches and trades the live vault through the real HSKSwap pools. There are no prices to mirror or pools to
          realign on mainnet: the vault's oracle is a 30-minute TWAP read from the pool itself.
        </p>
      ) : (
        <p className="lead">
          Two bots run on GitHub Actions. The <b>agent</b> (every 4 hours) researches and trades the vaults delegated to it.
          The <b>keeper</b> (every hour) mirrors HSK Chain mainnet prices to the testnet, realigns the testnet HSKSwap pools,
          and executes any stop-loss or drawdown exit. The keeper never decides trades and the agent cannot skip the risk rules.
        </p>
      )}
      <div className="grid2">
        <Card title="Trading agent" extra={<AddrLink address={DEP.agent} />}>
          {error && <div className="err small">{error}</div>}
          {!status && !error && <Spinner />}
          {run && (
            <>
              <p className="small muted">Last run {new Date(run.at).toLocaleString()}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Vault</th>
                      <th>Result</th>
                      <th className="num">NAV</th>
                      <th className="num">P&amp;L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {run.vaults.map((x) => (
                      <tr key={x.vault}>
                        <td>
                          <a href={`#/vault/${x.vault}`}>
                            {DEP.demoVaults.find((d) => d.vault.toLowerCase() === x.vault.toLowerCase())?.name || x.name || short(x.vault)}
                          </a>
                        </td>
                        <td className="small">
                          <Badge tone={x.status === "rebalanced" ? "ok" : x.status === "error" || x.status === "blocked" ? "bad" : "neutral"}>{x.status}</Badge>{" "}
                          {x.detail} {x.tx && <TxLink hash={x.tx} />}
                        </td>
                        <td className="num">{x.nav}</td>
                        <td className="num">{x.pnl}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Card>
        <Card title="Keeper" extra={<AddrLink address={DEP.keeper} />}>
          {!k && <Spinner />}
          {k && (
            <>
              <p className="small muted">Last run {new Date(k.at).toLocaleString()}</p>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th className="num">Mainnet price</th>
                      <th className="num">Mainnet HSKSwap TWAP</th>
                      <th className="num">{IS_MAINNET ? "HSKSwap pool (spot)" : "Testnet pool gap"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(k.mainnet ?? []).map((m) => {
                      const g = k.align?.gaps?.find((x) => x.ticker === m.ticker);
                      const d = m.price < 1 ? 5 : 2;
                      return (
                        <tr key={m.ticker}>
                          <td>
                            <b>{m.ticker}</b> <span className="small muted">{m.source === "apro" ? "APRO" : "HSKSwap TWAP"}</span>
                          </td>
                          <td className="num">{fmtUsd(m.price, d)}</td>
                          <td className="num">{fmtUsd(m.poolTwap, d)}</td>
                          <td className="num">{IS_MAINNET ? fmtUsd(m.poolSpot, d) : g ? `${(g.gapBps / 100).toFixed(2)}%` : "–"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="small">
                {!IS_MAINNET && (
                  <>
                    Relayed: {k.relay?.relayed?.length ? k.relay.relayed.map((r) => r.ticker).join(", ") : "nothing new"}{" "}
                    {k.relay?.tx && <TxLink hash={k.relay.tx} />} · pools moved: {k.align?.moved ?? 0} {k.align?.tx && <TxLink hash={k.align.tx} />} ·{" "}
                  </>
                )}
                positions checked: {k.sweep?.checked ?? 0}, exits: {k.sweep?.exits?.length ?? 0}
              </p>
              {(k.relay?.error || k.align?.error || k.sweep?.error) && (
                <p className="small err">{k.relay?.error ?? k.align?.error ?? k.sweep?.error}</p>
              )}
            </>
          )}
        </Card>
      </div>
      <Card title="What the agent sees" extra={<span className="muted small">research as of {run?.research?.asOf ? new Date(run.research.asOf).toLocaleString() : "…"}</span>}>
        {!run?.research && <Empty>No research yet.</Empty>}
        {run?.research && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Price</th>
                  <th className="num">7d</th>
                  <th className="num">30d</th>
                  <th className="num">Vol (30d)</th>
                  <th className="num">Max DD (30d)</th>
                  <th className="num">Mainnet pool depth</th>
                  <th className="num">Pool vs APRO</th>
                </tr>
              </thead>
              <tbody>
                {run.research.signals.map((s) => (
                  <tr key={s.ticker}>
                    <td>
                      <b>{s.ticker}</b>
                    </td>
                    <td className="num">{fmtUsd(s.price, s.price < 1 ? 5 : 2)}</td>
                    <td className={`num ${(s.ret7d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s.ret7d)}</td>
                    <td className={`num ${(s.ret30d ?? 0) >= 0 ? "pos" : "neg"}`}>{fmtPct(s.ret30d)}</td>
                    <td className="num">{fmtPct(s.vol30d, 0)}</td>
                    <td className="num">{fmtPct(s.maxDrawdown30d)}</td>
                    <td className="num">{s.mainnetPoolUsdtDepth === null ? "–" : `${fmtUsd(s.mainnetPoolUsdtDepth, 0)} USDT`}</td>
                    <td className="num">{s.aproVsPoolBps === null ? "–" : `${(s.aproVsPoolBps / 100).toFixed(2)}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">
          Workflows: <a href={`${REPO}/actions/workflows/agent.yml`}>agent</a> · <a href={`${REPO}/actions/workflows/keeper.yml`}>keeper</a> · rationale
          notes and status live on the <a href={`${REPO}/tree/notes`}>notes branch</a>.
        </p>
      </Card>
    </div>
  );
}
