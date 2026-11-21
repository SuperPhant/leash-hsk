import { useEffect, useRef, useState } from "react";
import { BaseError, ContractFunctionRevertedError, parseUnits } from "viem";
import { useWallet } from "../App";
import { ABI, send, testnet } from "../clients";
import { DEP } from "../config";
import {
  loadIndex,
  loadNote,
  loadRebalance,
  loadRiskExits,
  loadVault,
  type VaultData,
} from "../data";
import { helpReply, mandateChanged, propose, rulesReply, statusReply, type Proposal, type Reply } from "../chat";
import { AddrLink, Badge, Card, Empty, LineChart, Spinner, Stat, TxLink, WeightBar } from "../ui";
import { ago, duration, fmtPct, fmtUsd, short, useAsync } from "../util";

const PROFILE_NAMES: Record<string, string> = { steady: "Conservative", balanced: "Balanced", momentum: "Aggressive" };

/** Answers "why did you trade?" from the agent's latest rationale note, checked against the onchain hash. */
async function whyReply(vault: `0x${string}`): Promise<Reply> {
  const index = await loadIndex();
  const latest = index?.vaults[vault.toLowerCase()]?.rebalances[0];
  if (!latest) return { text: "I have not traded this vault yet.", actions: [], source: "rules" };
  const ev = await loadRebalance(latest.tx, vault);
  const { note, verified } = ev ? await loadNote(ev.rationaleURI || latest.note, ev.rationaleHash) : { note: null, verified: null };
  if (!ev || !note) return { text: `My last trade was ${latest.detail ?? ""} (${new Date(latest.at).toLocaleString()}).`, actions: [], source: "rules" };
  const rows: Array<[string, string]> = Object.keys({ ...note.decision.current, ...note.decision.final }).map((t) => [
    t,
    `${note.decision.current[t] ?? "0%"} → ${note.decision.final[t] ?? "0%"}${note.decision.perAsset[t] ? ` · ${note.decision.perAsset[t]}` : ""}`,
  ]);
  if (note.leashCorrections.length) rows.push(["Leash pulled", note.leashCorrections.slice(0, 3).join(" · ")]);
  rows.push(["Rationale", verified ? "hash matches the one committed onchain ✓" : verified === false ? "HASH MISMATCH" : "not verified"]);
  return {
    text: `Trade #${ev.epoch} (${new Date(ev.timestamp * 1000).toLocaleString()}), decided by ${note.decision.source}: “${note.decision.summary}”`,
    table: rows,
    actions: [],
    source: "rules",
  };
}

export function explainRevert(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) {
      const name = r.data?.errorName ?? r.reason ?? "revert";
      const known: Record<string, string> = {
        NotOwner: "only the vault owner can do this",
        BadMandate: "the vault rejected these rules (out of range)",
        BadCap: "a position cap must be between 0% and 100%",
        NotListedOnDesk: "that coin is not listed on the desk",
        TooManyAssets: "the vault already holds the maximum number of coins",
      };
      return known[name] ?? name;
    }
    return e.shortMessage;
  }
  return (e as Error)?.message ?? String(e);
}

function Holdings({ v }: { v: VaultData }) {
  const now = Date.now() / 1000;
  return (
    <Card title="Positions" extra={<span className="muted small">live, at oracle prices · traded on HSKSwap</span>}>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Coin</th>
              <th className="num">Amount</th>
              <th className="num">Value</th>
              <th>Weight vs cap</th>
              <th className="num">Avg entry</th>
              <th className="num">Stop-loss at</th>
              <th className="num">Unrealised</th>
            </tr>
          </thead>
          <tbody>
            {v.holdings.map((h) => {
              const d = h.price < 1 ? 5 : 2;
              return (
                <tr key={h.token}>
                  <td>
                    <b>{h.ticker}</b> <span className="muted small">{fmtUsd(h.price, d)}</span>
                    {h.buyBlockedUntil > now && (
                      <div>
                        <Badge tone="warn" title="Stopped out: the vault blocks buying it again until then">
                          re-entry blocked {new Date(h.buyBlockedUntil * 1000).toLocaleTimeString()}
                        </Badge>
                      </div>
                    )}
                    {h.capBps === 0 && <div><Badge tone="neutral">sell-only</Badge></div>}
                  </td>
                  <td className="num">{h.amount.toLocaleString("en-US", { maximumFractionDigits: h.ticker === "BTC" ? 5 : 2 })}</td>
                  <td className="num">{fmtUsd(h.value, 0)}</td>
                  <td className="wcell">
                    <WeightBar weightBps={h.weightBps} capBps={h.capBps} />
                    <span className="small muted">
                      {(h.weightBps / 100).toFixed(1)}% / {(h.capBps / 100).toFixed(0)}%
                    </span>
                  </td>
                  <td className="num">{h.entryPrice ? fmtUsd(h.entryPrice, d) : "–"}</td>
                  <td className="num">{h.stopPrice ? fmtUsd(h.stopPrice, d) : "–"}</td>
                  <td className={`num ${h.upnl >= 0 ? "pos" : "neg"}`}>{h.entryPrice ? `${h.upnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(h.upnl), 0)}` : "–"}</td>
                </tr>
              );
            })}
            <tr>
              <td>
                <b>USDT</b> <span className="muted small">cash</span>
              </td>
              <td className="num">{v.cash.toLocaleString("en-US", { maximumFractionDigits: 0 })}</td>
              <td className="num">{fmtUsd(v.cash, 0)}</td>
              <td className="wcell">
                <WeightBar weightBps={v.nav ? (v.cash / v.nav) * 10_000 : 0} capBps={0} cash />
                <span className="small muted">floor {(v.mandate.minCashBps / 100).toFixed(0)}%</span>
              </td>
              <td colSpan={3}></td>
            </tr>
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function RulesCard({ v }: { v: VaultData }) {
  const m = v.mandate;
  const rows: Array<[string, string, string]> = [
    ["Trade frequency", `at most every ${duration(m.cooldown)}`, "rebalances inside the cooldown revert"],
    ["Stop-loss", m.stopLossBps ? `${m.stopLossBps / 100}% below average entry` : "off", "anyone can sell the position; buying it back is blocked for a while"],
    ["Drawdown breaker", m.maxDrawdownBps ? `${m.maxDrawdownBps / 100}% below the high-water mark` : "off", "the agent may only sell until you reset it"],
    ["Cash floor", `${m.minCashBps / 100}% in USDT after any buy`, "buys that dip below revert"],
    ["Daily turnover", `${m.maxTurnoverBps / 100}% of NAV per ${duration(m.turnoverWindow)}`, "bigger rebalances revert"],
    ["Max slippage", `${m.maxSlippageBps / 100}% vs the oracle`, "fills worse than this revert"],
    ["Oracle freshness", `≤ ${duration(m.maxOracleAge)} old`, "stale prices freeze trading in that coin"],
    ["Mandate expires", new Date(m.expiry * 1000).toLocaleDateString(), "the agent loses authority after this"],
  ];
  return (
    <Card title="Rules the vault enforces" extra={<span className="muted small">change them by talking to the agent →</span>}>
      <div className="table-wrap">
        <table className="rules">
          <tbody>
            {rows.map(([k, val, why]) => (
              <tr key={k}>
                <td>{k}</td>
                <td>
                  <b>{val}</b>
                </td>
                <td className="small muted">{why}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

interface Msg {
  role: "user" | "agent";
  text: string;
  reply?: Reply;
  proposal?: Proposal;
  status?: string;
}

function ProposalCard({ v, proposal, onApplied }: { v: VaultData; proposal: Proposal; onApplied: () => void }) {
  const { address, wallet, connect } = useWallet();
  const [state, setState] = useState<{ busy?: string; done?: string; error?: string; txs: string[] }>({ txs: [] });
  const isOwner = address?.toLowerCase() === v.owner.toLowerCase();
  const apply = async () => {
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect the owner's wallet first.");
      if (c.address.toLowerCase() !== v.owner.toLowerCase()) throw new Error("Only the vault owner can change its rules.");
      const txs: string[] = [];
      if (mandateChanged(proposal.mandate, v.mandate)) {
        setState({ busy: "Signing the new mandate…", txs });
        const m = proposal.mandate;
        txs.push(
          await send(c.wallet, c.address, {
            address: v.address,
            abi: ABI.vault,
            functionName: "setMandate",
            args: [{ ...m, expiry: BigInt(m.expiry) }],
          }),
        );
      }
      for (const cap of proposal.caps) {
        setState({ busy: `Setting the ${cap.ticker} cap…`, txs });
        txs.push(await send(c.wallet, c.address, { address: v.address, abi: ABI.vault, functionName: "setCap", args: [cap.token, cap.to] }));
      }
      if (proposal.paused !== undefined) {
        setState({ busy: proposal.paused ? "Pausing the agent…" : "Resuming the agent…", txs });
        txs.push(await send(c.wallet, c.address, { address: v.address, abi: ABI.vault, functionName: "setPaused", args: [proposal.paused] }));
      }
      setState({ done: "Applied onchain. The agent reads the new rules on its next run.", txs });
      onApplied();
    } catch (e) {
      setState((s) => ({ ...s, busy: undefined, error: explainRevert(e) }));
    }
  };
  if (!proposal.diffs.length) return <div className="small muted">That is already how the vault is set up.</div>;
  return (
    <div className="proposal">
      <div className="small">
        <b>Proposed change</b>
      </div>
      <ul>
        {proposal.diffs.map((d, i) => (
          <li key={i}>{d}</li>
        ))}
      </ul>
      {!state.done && (
        <button className="btn small" disabled={!!state.busy} onClick={apply} title={isOwner ? "" : "Only the vault owner can sign"}>
          {state.busy ? state.busy : isOwner ? "Sign and apply" : "Sign and apply (owner only)"}
        </button>
      )}
      {state.done && <div className="small pos">{state.done}</div>}
      {state.error && <div className="small err">{state.error}</div>}
      {state.txs.length > 0 && (
        <div className="small">
          {state.txs.map((t) => (
            <span key={t}>
              <TxLink hash={t} />{" "}
            </span>
          ))}
        </div>
      )}
      {!isOwner && (
        <div className="small muted">
          This demo vault belongs to the Leash deployer. <a href="#/create">Create your own vault</a> to change rules by chat.
        </div>
      )}
    </div>
  );
}

function ChatPanel({ v, reload }: { v: VaultData; reload: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>(() => [
    { role: "agent", text: "", reply: statusReply(v) },
    { role: "agent", text: "Ask me anything about this vault, or tell me how to trade. Type “help” for examples." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [msgs.length]);

  const ask = async (text: string) => {
    const q = text.trim();
    if (!q || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: q }]);
    setBusy(true);
    let reply: Reply | null = null;
    if (/\b(why|explain|reason|rationale|last (trade|decision|rebalance))\b/i.test(q)) {
      reply = await whyReply(v.address);
    } else {
      reply = rulesReply(q, v);
      if (!reply) reply = { ...helpReply(), text: "I couldn't map that to a rule change. " + helpReply().text };
    }
    const proposal = reply.actions.length ? propose(v, reply.actions) : undefined;
    if (proposal && !reply.text) reply.text = proposal.diffs.length ? "Here is what I would change in the vault's rules:" : "Nothing to change.";
    setMsgs((m) => [...m, { role: "agent", text: reply!.text, reply, proposal }]);
    setBusy(false);
  };

  const suggestions = ["How am I doing?", "Why did you trade?", "I'm worried about a crash", "Max 15% in HSK", "Trade at most every 8 hours", "Stop trading ETH"];
  return (
    <Card className="chat" title="Talk to your agent" extra={<span className="muted small">changes are signed by the owner, enforced by the vault</span>}>
      <div className="chat-log">
        {msgs.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text && <div>{m.text}</div>}
            {m.reply?.table && (
              <table className="msg-table">
                <tbody>
                  {m.reply.table.map(([k, val], j) => (
                    <tr key={j}>
                      <td>{k}</td>
                      <td>{val}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {m.proposal && <ProposalCard v={v} proposal={m.proposal} onApplied={reload} />}
          </div>
        ))}
        {busy && (
          <div className="msg agent">
            <Spinner /> thinking…
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="chips">
        {suggestions.map((s) => (
          <button key={s} className="chip-btn" onClick={() => ask(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input className="input" value={input} onChange={(e) => setInput(e.target.value)} placeholder="e.g. keep 40% in cash and stop trading ETH" />
        <button className="btn small" disabled={busy || !input.trim()}>
          Send
        </button>
      </form>
    </Card>
  );
}

function RebalanceItem({ tx, vault, noteUri }: { tx: `0x${string}`; vault: string; noteUri?: string }) {
  const { data: ev } = useAsync(() => loadRebalance(tx, vault), [tx]);
  const { data: note } = useAsync(
    async () => (ev ? loadNote(ev.rationaleURI || noteUri || "", ev.rationaleHash) : { note: null, verified: null }),
    [ev?.rationaleURI],
  );
  const [open, setOpen] = useState(false);
  if (!ev) return <div className="tl-item"><Spinner /></div>;
  const n = note?.note;
  return (
    <div className="tl-item">
      <div className="tl-head">
        <div>
          <b>Trade #{ev.epoch}</b> <span className="muted small">{new Date(ev.timestamp * 1000).toLocaleString()}</span>
        </div>
        <div className="tl-badges">
          {note?.verified === true && <Badge tone="ok" title="keccak256 of the published rationale equals the hash committed onchain">rationale verified</Badge>}
          {note?.verified === false && <Badge tone="bad">rationale hash mismatch</Badge>}
          <TxLink hash={ev.tx} />
        </div>
      </div>
      <div className="trades">
        {ev.trades.map((t, i) => (
          <span key={i} className={`trade ${t.buy ? "buy" : "sell"}`}>
            {t.buy ? "Buy" : "Sell"} {t.ticker} {fmtUsd(t.notional, 0)} @ {fmtUsd(t.price, t.price < 1 ? 5 : 2)}
          </span>
        ))}
      </div>
      {n && (
        <>
          <p className="summary">“{n.decision.summary}”</p>
          <div className="muted small">
            Decided by <code>{n.decision.source}</code> · NAV {fmtUsd(ev.navBefore, 0)} → {fmtUsd(ev.navAfter, 0)} · swapped on HSKSwap
          </div>
          {n.leashCorrections.length > 0 && (
            <div className="corrections">
              <div className="small">
                <b>Where the leash pulled</b>
              </div>
              <ul>
                {n.leashCorrections.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </div>
          )}
          <button className="link" onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"} the agent's reasoning
          </button>
          {open && (
            <div className="reasoning">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Coin</th>
                      <th className="num">Before</th>
                      <th className="num">Rules baseline</th>
                      <th className="num">LLM proposed</th>
                      <th className="num">After leash</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys({ ...n.decision.current, ...n.decision.final }).map((t) => (
                      <tr key={t}>
                        <td>{t}</td>
                        <td className="num">{n.decision.current[t] ?? "–"}</td>
                        <td className="num">{n.decision.baseline[t] ?? "–"}</td>
                        <td className="num">{n.decision.proposed[t] ?? "–"}</td>
                        <td className="num">{n.decision.final[t] ?? "–"}</td>
                        <td className="small">{n.decision.perAsset[t] ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {n.decision.risks.length > 0 && <p className="small">Risks flagged: {n.decision.risks.join(" · ")}</p>}
              <a className="small" href={ev.rationaleURI} target="_blank" rel="noreferrer">
                Full rationale document (JSON)
              </a>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function RiskExits({ v }: { v: VaultData }) {
  const { data: exits, error } = useAsync(() => loadRiskExits(v.address), [v.address, v.epoch], 300_000);
  return (
    <Card title="Stop-loss and breaker exits" extra={<span className="muted small">executed by the keeper (or anyone), not by the AI</span>}>
      {error && <div className="err small">{error}</div>}
      {!exits && !error && <Spinner />}
      {exits && !exits.length && <Empty>No stop-loss has fired in this vault yet.</Empty>}
      {exits?.map((x) => (
        <div key={x.tx} className="tl-item">
          <div className="tl-head">
            <div>
              <b>
                {x.reason === "stop-loss" ? "Stop-loss" : "Drawdown breaker"}: sold {x.ticker}
              </b>{" "}
              <span className="muted small">
                at {fmtUsd(x.price, x.price < 1 ? 5 : 2)}
                {x.entryPrice ? ` (entry ${fmtUsd(x.entryPrice, x.entryPrice < 1 ? 5 : 2)})` : ""} for {fmtUsd(x.usdOut, 0)} · called by{" "}
                {x.caller.toLowerCase() === DEP.keeper.toLowerCase() ? "the keeper" : short(x.caller)}
              </span>
            </div>
            <TxLink hash={x.tx} />
          </div>
        </div>
      ))}
    </Card>
  );
}

function Activity({ v }: { v: VaultData }) {
  const { data: index } = useAsync(loadIndex, [v.address], 120_000);
  const entry = index?.vaults[v.address.toLowerCase()];
  return (
    <Card title="Agent trades" extra={<span className="muted small">{v.epoch} rebalance{v.epoch === 1 ? "" : "s"} onchain</span>}>
      {!index && <Spinner />}
      {index && !entry?.rebalances.length && <Empty>No trades yet. The agent runs every four hours.</Empty>}
      <div className="timeline">
        {entry?.rebalances.slice(0, 12).map((r) => (
          <RebalanceItem key={r.tx} tx={r.tx} vault={v.address} noteUri={r.note} />
        ))}
      </div>
    </Card>
  );
}

function NavCard({ v }: { v: VaultData }) {
  const { data: index } = useAsync(loadIndex, [v.address], 300_000);
  const pts = (index?.vaults[v.address.toLowerCase()]?.nav ?? []).map(([t, x]) => [Date.parse(t), x] as [number, number]);
  pts.push([Date.now(), v.nav]);
  return (
    <Card title="Net asset value" extra={<span className="muted small">sampled every agent run</span>}>
      <LineChart points={pts} />
    </Card>
  );
}

function OwnerPanel({ v, reload }: { v: VaultData; reload: () => void }) {
  const { address, wallet, connect } = useWallet();
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [amount, setAmount] = useState("1000");
  const isOwner = address?.toLowerCase() === v.owner.toLowerCase();
  const run = async (label: string, fn: (w: NonNullable<typeof wallet>, me: `0x${string}`) => Promise<unknown>) => {
    setBusy(label);
    setMsg("");
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect a wallet first.");
      await fn(c.wallet, c.address);
      setMsg(`${label}: confirmed.`);
      reload();
    } catch (e) {
      setMsg(`${label} failed: ${explainRevert(e)}`);
    } finally {
      setBusy("");
    }
  };
  return (
    <Card title={isOwner ? "Owner controls" : "Deposit"}>
      <div className="row gap">
        <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        <button
          className="btn small"
          disabled={!!busy}
          onClick={() =>
            run("Deposit", async (w, me) => {
              const amt = parseUnits(amount || "0", 6);
              await send(w, me, { address: DEP.usd, abi: ABI.erc20, functionName: "approve", args: [v.address, amt] });
              await send(w, me, { address: v.address, abi: ABI.vault, functionName: "deposit", args: [amt] });
            })
          }
        >
          Deposit tUSDT
        </button>
      </div>
      {isOwner && (
        <div className="row gap wrap" style={{ marginTop: 12 }}>
          {v.breakerTripped && (
            <button className="btn small ghost" disabled={!!busy} onClick={() => run("Reset breaker", (w, me) => send(w, me, { address: v.address, abi: ABI.vault, functionName: "resetPeak" }))}>
              Reset drawdown breaker
            </button>
          )}
          <button className="btn small danger" disabled={!!busy} onClick={() => run("Withdraw everything", (w, me) => send(w, me, { address: v.address, abi: ABI.vault, functionName: "withdrawAll", args: [me] }))}>
            Withdraw everything
          </button>
        </div>
      )}
      {!isOwner && <p className="muted small">Anyone can deposit; the funds belong to the owner. Owner controls appear when the owner's wallet is connected.</p>}
      {busy && (
        <p className="small">
          <Spinner /> {busy}…
        </p>
      )}
      {msg && <p className="small">{msg}</p>}
    </Card>
  );
}

export function VaultPage({ address }: { address: `0x${string}` }) {
  const { data: v, error, reload } = useAsync(() => loadVault(address), [address], 15_000);
  const demo = DEP.demoVaults.find((d) => d.vault.toLowerCase() === address.toLowerCase());
  if (error && !v) return <div className="page"><div className="err">Could not load vault: {error}</div></div>;
  if (!v) return <div className="page"><Spinner /></div>;
  const leashAgent = v.agent.toLowerCase() === DEP.agent.toLowerCase();
  const pnlPct = v.netDeposits ? v.pnl / v.netDeposits : 0;
  const nextTrade = v.lastRebalance + v.mandate.cooldown;
  return (
    <div className="page">
      <div className="vault-head">
        <div>
          <a className="muted small" href="#/">
            ← All vaults
          </a>
          <h1>
            {demo?.name ?? "Leash vault"} {demo && <span className="muted small">· {PROFILE_NAMES[demo.profile]}</span>}
          </h1>
          <div className="muted small">
            Vault <AddrLink address={v.address} /> · owner <AddrLink address={v.owner} /> · agent{" "}
            <AddrLink address={v.agent} label={leashAgent ? "Leash trading agent" : short(v.agent)} />
          </div>
        </div>
        <div>
          {v.breakerTripped ? (
            <Badge tone="bad">drawdown breaker tripped: sells only</Badge>
          ) : v.paused ? (
            <Badge tone="warn">agent paused by owner</Badge>
          ) : Date.now() / 1000 > v.mandate.expiry ? (
            <Badge tone="bad">mandate expired</Badge>
          ) : (
            <Badge tone="ok">agent active</Badge>
          )}
        </div>
      </div>
      <div className="stats">
        <Stat label="Net asset value" value={fmtUsd(v.nav)} />
        <Stat
          label="Profit / loss"
          value={<span className={v.pnl >= 0 ? "pos" : "neg"}>{`${v.pnl >= 0 ? "+" : "-"}${fmtUsd(Math.abs(v.pnl), 0)}`}</span>}
          hint={`${pnlPct >= 0 ? "+" : ""}${fmtPct(pnlPct, 2)} on ${fmtUsd(v.netDeposits, 0)} deposited`}
        />
        <Stat label="Drawdown from peak" value={`${(v.drawdownBps / 100).toFixed(2)}%`} hint={`breaker at ${v.mandate.maxDrawdownBps / 100}%`} />
        <Stat
          label="Trades"
          value={v.epoch}
          hint={v.lastRebalance ? (nextTrade > Date.now() / 1000 ? `next allowed in ${duration(Math.round(nextTrade - Date.now() / 1000))}` : `last ${ago(v.lastRebalance)}`) : "none yet"}
        />
      </div>
      <div className="vault-layout">
        <div className="col">
          <Holdings v={v} />
          <NavCard v={v} />
          <RulesCard v={v} />
          <Activity v={v} />
          <RiskExits v={v} />
        </div>
        <div className="col side">
          <ChatPanel v={v} reload={reload} />
          <OwnerPanel v={v} reload={reload} />
        </div>
      </div>
    </div>
  );
}
