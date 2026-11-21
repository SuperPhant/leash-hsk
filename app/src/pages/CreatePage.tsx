import { useState } from "react";
import { decodeEventLog, formatEther, parseUnits } from "viem";
import { useWallet } from "../App";
import { ABI, send, testnet } from "../clients";
import { DEP, FAUCET_URL, PRESETS, TOKEN_BY_TICKER } from "../config";
import { Badge, Card, Spinner } from "../ui";
import { duration, fmtUsd, useAsync } from "../util";
import { explainRevert } from "./VaultPage";

export function CreatePage() {
  const { address, wallet, connect } = useWallet();
  const [preset, setPreset] = useState(PRESETS[1].id);
  const [amount, setAmount] = useState("10000");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [created, setCreated] = useState<`0x${string}` | null>(null);
  const { data: bal, reload } = useAsync(
    async () => {
      if (!address) return null;
      const [hsk, usdt] = await Promise.all([
        testnet.getBalance({ address }),
        testnet.readContract({ address: DEP.usd, abi: ABI.erc20, functionName: "balanceOf", args: [address] }) as Promise<bigint>,
      ]);
      return { hsk: Number(formatEther(hsk)), usdt: Number(usdt) / 1e6 };
    },
    [address],
    20_000,
  );
  const p = PRESETS.find((x) => x.id === preset)!;

  const run = async (label: string, fn: (w: NonNullable<typeof wallet>, me: `0x${string}`) => Promise<void>) => {
    setBusy(label);
    setMsg("");
    try {
      const c = wallet && address ? { wallet, address } : await connect();
      if (!c) throw new Error("Connect a wallet first.");
      await fn(c.wallet, c.address);
      reload();
    } catch (e) {
      setMsg(`${label} failed: ${explainRevert(e)}`);
    } finally {
      setBusy("");
    }
  };

  const create = () =>
    run("Create vault", async (w, me) => {
      const amt = parseUnits(amount || "0", 6);
      if (amt > 0n) await send(w, me, { address: DEP.usd, abi: ABI.erc20, functionName: "approve", args: [DEP.factory, amt] });
      const tokens = p.tickers.map((t) => TOKEN_BY_TICKER.get(t)!);
      const mandate = { ...p.mandate, expiry: BigInt(Math.floor(Date.now() / 1000) + 180 * 86_400) };
      const hash = await send(w, me, {
        address: DEP.factory,
        abi: ABI.factory,
        functionName: "createVault",
        args: [DEP.agent, tokens, p.caps, mandate, amt],
      });
      const receipt = await testnet.getTransactionReceipt({ hash });
      for (const log of receipt.logs) {
        try {
          const d = decodeEventLog({ abi: ABI.factory, data: log.data, topics: log.topics }) as any;
          if (d.eventName === "VaultCreated") setCreated(d.args.vault);
        } catch {}
      }
    });

  return (
    <div className="page narrow">
      <h1>Create a Leash vault</h1>
      <p className="lead">
        Your vault, your rules. The Leash agent trades it on HSKSwap within the rules you pick here, and you can change them
        any time by talking to it. It can never move money out; only you can withdraw.
      </p>

      <Card title="1 · Wallet and test funds">
        {!address ? (
          <button className="btn" onClick={connect}>
            Connect wallet (HSK Chain testnet)
          </button>
        ) : (
          <>
            <p className="small">
              Testnet HSK for gas: <b>{bal ? bal.hsk.toFixed(4) : "…"}</b>{" "}
              {bal && bal.hsk < 0.003 && (
                <>
                  <Badge tone="warn">low</Badge> get some from the{" "}
                  <a href={FAUCET_URL} target="_blank" rel="noreferrer">
                    official HSK testnet faucet
                  </a>
                  .
                </>
              )}
              <br />
              Test USDT: <b>{bal ? fmtUsd(bal.usdt, 0) : "…"}</b>
            </p>
            <button
              className="btn small ghost"
              disabled={!!busy}
              onClick={() => run("Faucet", async (w, me) => void (await send(w, me, { address: DEP.faucet!, abi: ABI.faucet, functionName: "claim" })))}
            >
              Get 10,000 test USDT
            </button>
          </>
        )}
      </Card>

      <Card title="2 · Risk appetite">
        <div className="presets">
          {PRESETS.map((x) => (
            <button key={x.id} className={`preset ${x.id === preset ? "on" : ""}`} onClick={() => setPreset(x.id)}>
              <b>{x.name}</b>
              <span className="small">{x.blurb}</span>
            </button>
          ))}
        </div>
        <div className="table-wrap">
          <table className="rules">
            <tbody>
              <tr>
                <td>Coins and caps</td>
                <td>{p.tickers.map((t, i) => `${t} ≤ ${p.caps[i] / 100}%`).join(" · ")}</td>
              </tr>
              <tr>
                <td>Cash floor</td>
                <td>{p.mandate.minCashBps / 100}% USDT</td>
              </tr>
              <tr>
                <td>Trade frequency</td>
                <td>at most every {duration(p.mandate.cooldown)}</td>
              </tr>
              <tr>
                <td>Stop-loss / drawdown breaker</td>
                <td>
                  {p.mandate.stopLossBps / 100}% / {p.mandate.maxDrawdownBps / 100}%
                </td>
              </tr>
              <tr>
                <td>Daily turnover · max slippage</td>
                <td>
                  {p.mandate.maxTurnoverBps / 100}% · {p.mandate.maxSlippageBps / 100}%
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="3 · Deposit and create">
        <div className="row gap">
          <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
          <span className="small muted">test USDT</span>
          <button className="btn" disabled={!!busy} onClick={create}>
            Create vault
          </button>
        </div>
        <p className="small muted">Two signatures: approve the deposit, then create the vault delegated to the Leash agent ({DEP.agent.slice(0, 8)}…).</p>
        {busy && (
          <p className="small">
            <Spinner /> {busy}…
          </p>
        )}
        {msg && <p className="small err">{msg}</p>}
        {created && (
          <p>
            Vault created. <a href={`#/vault/${created}`}>Open it and talk to your agent →</a>
          </p>
        )}
      </Card>
    </div>
  );
}
