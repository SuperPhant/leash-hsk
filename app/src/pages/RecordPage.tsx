import { EXPLORER, IS_MAINNET } from "../config";
import { FLAT, HORIZON, loadRecord, type GradedTrade, type Verdict } from "../record";
import { Badge, Card, Empty, Spinner, Stat, TxLink } from "../ui";
import { fmtPct, fmtUsd, short, useAsync } from "../util";

const roundsToZero = (x: number, digits: number) => Number(x.toFixed(digits)) === 0;
const signedUsd = (x: number) => (roundsToZero(x, 2) ? fmtUsd(0) : `${x > 0 ? "+" : "−"}${fmtUsd(Math.abs(x))}`);
const signedPct = (x: number, digits = 2) =>
  roundsToZero(x * 100, digits) ? `${(0).toFixed(digits)}%` : `${x > 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(digits)}%`;
/** Green or red, except for values that display as zero. */
const tone = (x: number | undefined, digits = 2) => (x === undefined || roundsToZero(x * 100, digits) ? "" : x > 0 ? "pos" : "neg");
const usdTone = (x: number | undefined) => (x === undefined || roundsToZero(x, 2) ? "" : x > 0 ? "pos" : "neg");
const when = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const price = (x: number) => fmtUsd(x, x < 10 ? 4 : 2);

function inHours(t: number) {
  const h = Math.max(0, (t - Date.now() / 1000) / 3600);
  return h < 1 ? `${Math.ceil(h * 60)} min` : `${h.toFixed(1)} h`;
}

function VerdictBadge({ t }: { t: GradedTrade }) {
  const tone: Record<Verdict, "ok" | "bad" | "neutral" | "blue"> = { right: "ok", wrong: "bad", flat: "neutral", pending: "blue" };
  const label = t.verdict === "pending" ? `in ${inHours(t.gradesAt)}` : t.verdict;
  return (
    <>
      <Badge tone={tone[t.verdict]}>{label}</Badge>
      {t.staleEntry && (
        <>
          {" "}
          <Badge
            tone="warn"
            title="Made on Nov 21 before 10:00 UTC, when the agent could still trade on a price relayed hours earlier. Listed, but not counted in the hit rate or value added."
          >
            stale price · not counted
          </Badge>
        </>
      )}
    </>
  );
}

function Who({ t }: { t: GradedTrade }) {
  if (t.kind === "agent") return <span className="small muted">agent</span>;
  return (
    <Badge tone="warn" title="Executed by the vault's own rule, triggered permissionlessly by the keeper">
      {t.kind}
    </Badge>
  );
}

export function RecordPage() {
  const { data, error } = useAsync(loadRecord, [], 300_000);
  const t = data?.totals;
  return (
    <div className="page">
      <h1>Track record</h1>
      <p className="lead">
        Every trade the agent made, and every stop-loss its vaults executed, graded {HORIZON / 3600} hours later against
        the vault&apos;s own oracle. A buy is right if the price then rose; a sell is right if it fell. This page computes
        everything in your browser from HSK Chain {IS_MAINNET ? "mainnet" : "testnet"} events; nothing comes from our
        servers, so anyone can check it.
      </p>
      {error && <div className="err small">{error}</div>}
      {!data && !error && <Spinner />}
      {data && t && (
        <>
          <div className="stats">
            <Stat
              label="Trades graded"
              value={`${t.graded} of ${t.trades}`}
              hint={t.pending ? `${t.pending} waiting for their ${HORIZON / 3600} hours; next in ${inHours(t.nextGradeAt!)}` : "all graded"}
            />
            <Stat
              label="Hit rate"
              value={t.hitRate === null ? "–" : fmtPct(t.hitRate, 0)}
              hint={`${t.right} right · ${t.wrong} wrong · ${t.flat} flat${t.excluded ? ` · ${t.excluded} stale-price trades not counted` : ""}`}
            />
            <Stat
              label="Value added by trading"
              value={t.graded - t.excluded ? signedUsd(t.valueAdded) : "–"}
              hint={t.graded - t.excluded ? `on ${fmtUsd(t.notionalGraded, 0)} traded, over ${HORIZON / 3600} h, vs not trading` : "appears after the first grade"}
            />
            <Stat
              label="Rationales verified"
              value={`${t.rationalesVerified} of ${t.rationales}`}
              hint="note fetched, hashed, and matched to the hash its vault stored onchain"
            />
          </div>

          <Card title="Each vault: trading versus holding">
            {data.vaults.length === 0 ? (
              <Empty>No vault has traded yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Vault</th>
                      <th>Since</th>
                      <th className="num">Vault</th>
                      <th className="num" title="If the vault had kept its first allocation and never traded again">
                        Hold first allocation
                      </th>
                      <th className="num">All cash</th>
                      <th className="num">Trading added</th>
                      <th className="num">Graded trades</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.vaults.map((v) => {
                      const edge = v.vaultReturn - v.hodlReturn;
                      return (
                        <tr key={v.vault}>
                          <td>
                            <a href={`#/vault/${v.vault}`}>{v.name || short(v.vault)}</a>
                          </td>
                          <td className="small">{when(v.since)}</td>
                          <td className={`num ${tone(v.vaultReturn)}`}>{signedPct(v.vaultReturn)}</td>
                          <td className={`num ${tone(v.hodlReturn)}`}>{signedPct(v.hodlReturn)}</td>
                          <td className="num">0.00%</td>
                          <td className={`num ${tone(edge)}`}>{signedPct(edge)}</td>
                          <td className="num">
                            {v.graded ? `${v.right}/${v.right + v.wrong} right` : "–"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="small muted">
              Returns are measured from each vault&apos;s cash before its first trade, at oracle prices, after spreads
              and slippage. &quot;Hold first allocation&quot; is what the vault would be worth had it bought its first
              allocation and never traded again.
            </p>
          </Card>

          <Card title="Every trade">
            {data.trades.length === 0 ? (
              <Empty>No trades yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Vault</th>
                      <th>By</th>
                      <th>Trade</th>
                      <th className="num">Size</th>
                      <th className="num">Price then</th>
                      <th className="num">{HORIZON / 3600} h later</th>
                      <th className="num">Move</th>
                      <th>Verdict</th>
                      <th className="num">Value added</th>
                      <th>Proof</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.trades.map((x) => (
                      <tr key={`${x.tx}:${x.logIndex}`}>
                        <td className="small">{when(x.t0)}</td>
                        <td className="small">
                          <a href={`#/vault/${x.vault}`}>{x.vaultName || short(x.vault)}</a>
                        </td>
                        <td>
                          <Who t={x} />
                        </td>
                        <td>
                          <b className={x.side === "buy" ? "pos" : "neg"}>{x.side}</b> {x.ticker}
                        </td>
                        <td className="num">{fmtUsd(x.notional, 0)}</td>
                        <td className="num">{price(x.price0)}</td>
                        <td className="num" title={x.roundAt ? `oracle round dated ${new Date(x.roundAt * 1000).toUTCString()}` : undefined}>
                          {x.price24 === undefined ? "–" : price(x.price24)}
                        </td>
                        <td className={`num ${tone(x.move)}`}>
                          {x.move === undefined ? "–" : signedPct(x.move)}
                        </td>
                        <td>
                          <VerdictBadge t={x} />
                        </td>
                        <td className={`num ${usdTone(x.valueAdded)}`}>
                          {x.valueAdded === undefined ? "–" : signedUsd(x.valueAdded)}
                        </td>
                        <td className="small">
                          <TxLink hash={x.tx} label="tx" />
                          {x.rationaleURI && (
                            <>
                              {" · "}
                              <a href={x.rationaleURI} target="_blank" rel="noreferrer">
                                why
                              </a>{" "}
                              {x.rationaleVerified === true && <Badge tone="ok" title="The note's keccak256 matches the hash in the Rebalanced event">✓</Badge>}
                              {x.rationaleVerified === false && <Badge tone="bad" title="The note does not match its onchain hash">✗</Badge>}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card title="How the grading works">
            <ul className="small">
              <li>
                <b>Price then:</b> the oracle price the vault traded at, from its <code>TradeExecuted</code> event (or
                its <code>RiskExit</code> event for a stop-loss or breaker exit).
              </li>
              {IS_MAINNET ? (
                <li>
                  <b>{HORIZON / 3600} h later:</b> the vault&apos;s oracle read {HORIZON / 3600} hours after the trade.
                  On mainnet each coin&apos;s oracle is a <code>TwapFeed</code> that computes the HSKSwap pool&apos;s
                  30-minute TWAP whenever it is called, so your browser calls its <code>latestRoundData</code> at the
                  block {HORIZON / 3600} hours after the trade (HSK Chain makes a block every 2 seconds and its RPC
                  serves historical state).
                </li>
              ) : (
                <li>
                  <b>{HORIZON / 3600} h later:</b> the oracle price in force {HORIZON / 3600} hours after the trade: the
                  latest round the keeper relayed to the price hub whose HSK Chain mainnet timestamp is at or before that
                  moment, from the hub&apos;s <code>Relayed</code> events. BTC and HSK follow APRO&apos;s mainnet feeds;
                  ETH follows the mainnet HSKSwap 30-minute TWAP. A trade is graded one hour after its{" "}
                  {HORIZON / 3600} hours are up, once the keeper has relayed every round dated before then.
                </li>
              )}
              <li>
                <b>Verdict:</b> a buy is right if the price rose, a sell if it fell. Moves under{" "}
                {(FLAT * 100).toFixed(2)}% are flat and count neither way.
              </li>
              <li>
                <b>Value added:</b> what the trade earned (a buy) or saved (a sell) over those hours, compared with not
                trading: size × move, with the sign flipped for sells.
              </li>
              <li>
                <b>Why:</b> the agent&apos;s rationale note for that rebalance. Your browser fetches it, hashes it with
                keccak256 and compares the result with the hash the vault stored onchain in its{" "}
                <code>Rebalanced</code> event.
              </li>
              {!IS_MAINNET && (
                <li>
                  <b>Known error on Nov 21:</b> the hourly keeper did not run on schedule that day, so the trades at 06:23
                  and 09:10 UTC used prices relayed hours earlier: BTC about 4% and ETH about 5% below the live mainnet
                  price. A wrong entry price distorts their grades (the buys look like good calls 24 hours later, the
                  sell like a bad one), so they are listed with their grades, marked <i>stale price</i>, and left out of
                  the hit rate, the value added and each vault&apos;s graded trades. Since then the agent refreshes
                  prices right before every trade.
                </li>
              )}
            </ul>
            <p className="small muted">
              Source:{" "}
              <a href={`${EXPLORER}/address/${data.vaults[0]?.vault ?? ""}`} target="_blank" rel="noreferrer">
                vault events
              </a>{" "}
              {IS_MAINNET
                ? "and the TwapFeed oracles on HSK Chain mainnet, read live."
                : "and the price hub's events on HSK Chain testnet, read live."}{" "}
              Computed {new Date(data.asOf * 1000).toLocaleString()}.
            </p>
          </Card>
        </>
      )}
    </div>
  );
}
