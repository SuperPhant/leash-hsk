import { DEP, MAINNET_DEP, REPO } from "../config";
import { AddrLink, Card } from "../ui";

export function AboutPage() {
  return (
    <div className="page narrow">
      <h1>How Leash works</h1>
      <p className="lead">
        An AI that trades for you is only useful if you can bound what it does. Leash puts the bounds in the vault
        contract, so they hold even when the model is wrong, the agent's server is down or its key leaks.
      </p>

      <Card title="Who does what">
        <ul className="bullets">
          <li>
            <b>The vault</b> (one per user) holds USDT and coins and enforces the mandate on every trade: allowed coins and
            per-coin caps, a cash floor, daily turnover, slippage against the oracle, oracle freshness, a minimum time between
            trades, a <b>stop-loss</b> per position (from its average entry price) and a <b>drawdown breaker</b> on NAV. Only
            the owner can change these rules or withdraw.
          </li>
          <li>
            <b>The desk</b> routes trades to <b>HSKSwap</b> (Uniswap V3) pools and refuses to trade when the pool price is
            more than 2% away from the oracle, so a manipulated or stale pool cannot be traded into.
          </li>
          <li>
            <b>The agent</b> builds a rules baseline (inverse-volatility sizing, trend tilt, downtrend filter), asks an LLM
            to review it, bounds the LLM (it may always cut risk but only add a little, less in a downtrend), plans the
            swaps and calls <code>rebalance</code>. It publishes a rationale for every trade and commits its keccak256
            onchain; the app re-checks the hash.
          </li>
          <li>
            <b>The keeper</b> mirrors HSK Chain mainnet prices to the testnet, realigns the testnet pools and calls{" "}
            <code>stopOut</code> for any position whose stop-loss or breaker triggered. <code>stopOut</code> is
            permissionless: anyone can enforce the rules.
          </li>
          <li>
            <b>The chat</b> on each vault page answers questions about positions and profit, and turns instructions ("max
            15% in HSK", "trade at most every 8 hours", "stop loss 6%", "be more conservative") into a concrete rule
            change the owner signs. Clear commands are parsed in the browser; free-form text goes to an LLM that may only
            return the same small set of actions, which code validates.
          </li>
        </ul>
      </Card>

      <Card title="Prices: real HSK Chain data">
        <p>
          On HSK Chain mainnet, BTC/USD and HSK/USD come from APRO's push feeds and ETH/USD from the HSKSwap WETH/USDT
          pool's 30-minute TWAP. APRO's feeds only answer whitelisted contracts, so the mainnet build values positions with
          a TWAP adapter on the HSKSwap pools (<code>TwapFeed</code>) and the keeper reads APRO off-chain. On the testnet
          the keeper copies those mainnet prices into a mirror hub every hour and moves the testnet HSKSwap pools back to
          them, playing the arbitrageur, so the testnet vaults gain and lose with the real market.
        </p>
      </Card>

      <Card title="Contracts">
        <div className="table-wrap">
          <table className="rules">
            <tbody>
              <tr>
                <td>LeashFactory (testnet)</td>
                <td>
                  <AddrLink address={DEP.factory} label={DEP.factory} />
                </td>
              </tr>
              <tr>
                <td>SwapDesk (testnet)</td>
                <td>
                  <AddrLink address={DEP.desk} label={DEP.desk} />
                </td>
              </tr>
              {DEP.hub && (
                <tr>
                  <td>MirrorFeedHub (testnet)</td>
                  <td>
                    <AddrLink address={DEP.hub} label={DEP.hub} />
                  </td>
                </tr>
              )}
              {DEP.aligner && (
                <tr>
                  <td>PoolAligner (testnet)</td>
                  <td>
                    <AddrLink address={DEP.aligner} label={DEP.aligner} />
                  </td>
                </tr>
              )}
              {DEP.assets.map((a) => (
                <tr key={a.ticker}>
                  <td>HSKSwap t{a.ticker === "HSK" ? "HSK" : `W${a.ticker}`}/tUSDT pool (testnet)</td>
                  <td>
                    <AddrLink address={a.pool} label={a.pool} />
                  </td>
                </tr>
              ))}
              {MAINNET_DEP && (
                <>
                  <tr>
                    <td>LeashFactory (mainnet)</td>
                    <td>
                      <AddrLink address={MAINNET_DEP.factory} label={MAINNET_DEP.factory} mainnet />
                    </td>
                  </tr>
                  <tr>
                    <td>SwapDesk (mainnet)</td>
                    <td>
                      <AddrLink address={MAINNET_DEP.desk} label={MAINNET_DEP.desk} mainnet />
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
        <p className="small muted">
          Source, tests (forked against the live HSKSwap contracts) and deployment scripts: <a href={REPO}>{REPO}</a>.
        </p>
      </Card>

      <Card title="Honest notes">
        <ul className="bullets small">
          <li>Everything runs on HSK Chain testnet with test tokens; no real money is involved.</li>
          <li>The LLM is a free, keyless open-weight model (via Pollinations). It proposes; code and the vault decide.</li>
          <li>Built by Phant Studio with AI coding assistants (GitHub Copilot). Leash started as an entry for the Base Stocks Maxxing quest (tokenized stocks on Base); this HSK Chain version was rebuilt for the HSK Chain Horizon Hackathon: new HSKSwap desk, stop-loss and drawdown breaker, TWAP/APRO price layer, keeper and chat.</li>
        </ul>
      </Card>
    </div>
  );
}
