# Leash for HSK Chain

**An AI trading agent for HSKSwap that can only act inside an onchain mandate its owner sets.** Position caps,
trade frequency, a stop-loss and a drawdown breaker live in the vault contract, so they hold even when the model is
wrong, the bot is offline or its key leaks. Talk to the agent to see your positions and profit in real time and to
change the rules in plain words; every change is a transaction you sign.

- **Live app:** https://superphant.github.io/leash-hsk/ (HSK Chain testnet, chain id 133)
- **Track:** HSK Chain Horizon Hackathon (Seoul), AI Agent Trading
- **Built with:** HSKSwap (Uniswap V3) factory, pools and SwapRouter02 · APRO price feeds on HSK Chain mainnet ·
  Solidity/Foundry · TypeScript/viem · GitHub Actions · an open-weight LLM

## What it does

| The track asks for | Leash |
|---|---|
| An AI agent that trades on a DEX such as HSKSwap | Every trade is a swap in an HSKSwap (Uniswap V3) pool through SwapRouter02, sent by the agent's `rebalance` call to the vault. |
| Monitor markets, analyse on-chain data, identify signals, execute autonomously | Every 4 hours the agent reads HSK Chain mainnet prices (APRO feeds, HSKSwap TWAP), HSKSwap pool depth and the APRO-vs-pool gap, plus 30-day returns, volatility and drawdown; builds a rules baseline; has an LLM review it; and trades. |
| Spot arbitrage and spread opportunities | The desk compares each pool's spot price with its oracle before every swap; the keeper arbitrages the testnet pools back to the mainnet price every hour (it is the testnet's arbitrageur). The agent sees the mainnet APRO-vs-HSKSwap gap as a signal. |
| Strict risk controls and stop-loss rules | Enforced by the vault, not by the agent: per-coin caps, cash floor, daily turnover, max slippage vs the oracle, oracle freshness, minimum time between trades, a **stop-loss per position** (from its volume-weighted average entry) and a **drawdown breaker** on NAV. Stop-losses are executed by a keeper, and `stopOut` is permissionless, so anyone can enforce them. |
| A conversational interface to see positions and PnL in real time and adjust position size, trade frequency, risk appetite and target assets | Each vault page has a chat. "How am I doing?" answers with live positions, average entry, stop level and unrealised PnL. "Max 15% in HSK", "trade at most every 8 hours", "be more conservative", "stop trading ETH", "stop loss 6%", "I'm worried about a crash" become a concrete rule change the owner signs. "Why did you trade?" answers with the agent's own LLM rationale, verified against the hash it committed onchain. |

## How it works

```
             HSK Chain mainnet (read only)
   APRO BTC/USD, HSK/USD feeds ── HSKSwap WETH/USDT TWAP ── pool depth
                    │                          │
          keeper (hourly)                agent (every 4 h)
   mirror prices → realign pools        research → rules baseline → LLM review
   → stopOut() triggered positions      → asymmetric leash → plan → rebalance()
                    │                          │
             HSK Chain testnet ─────────────────────────────────────────────
   MirrorFeedHub ──► SwapDesk ──► HSKSwap pools (tHSK, tWBTC, tWETH / tUSDT)
                        ▲
   LeashFactory ──► LeashVault (one per owner): mandate, stop-loss, breaker
                        ▲
            app (GitHub Pages): positions, PnL, chat → owner signs rule changes
```

- **`LeashVault`** holds USDT and coins for one owner. `rebalance(trades, rationaleHash, rationaleURI)` is the only
  thing the agent can call; the whole rebalance reverts if any rule is broken afterwards. The agent can only swap
  through the desk, which pays out to the vault, so it can never move funds out. The owner can change the rules,
  pause the agent and withdraw at any time, even when an oracle is down (`withdraw` never needs a price).
  - **Stop-loss:** the vault tracks each position's volume-weighted average entry price from the actual fills. Once
    the oracle price is `stopLossBps` below it, `stopOut(token)` sells the whole position (anyone can call it) and the
    agent cannot buy that coin back for at least an hour.
  - **Drawdown breaker:** NAV high-water mark (moved with deposits and withdrawals). Below `maxDrawdownBps` the
    agent may only sell, anyone may `stopOut` any position, and buying stays off until the owner calls `resetPeak()`.
- **`SwapDesk`** lists each coin with a USD feed and its HSKSwap token/USDT pool, values positions at the oracle price
  and swaps through SwapRouter02. Before every swap it checks the feed is fresh and the pool's spot price is within
  2% of it (`PoolOffOracle`), so a manipulated or desynced pool is never traded into.
- **Prices.** On HSK Chain mainnet, APRO's BTC/USD and HSK/USD feeds only answer whitelisted contracts (our mainnet
  fork test shows `No access`), so the mainnet build prices coins with **`TwapFeed`**, a Chainlink-compatible
  30-minute TWAP read from the HSKSwap pool itself, and the desk's spot-vs-TWAP guard blocks trading into a sudden
  move. Off-chain clients can read APRO, so the keeper uses it as the reference. On the testnet,
  **`MirrorFeedHub`** carries the mainnet prices: APRO rounds copied 1:1 (same round ids and timestamps) for BTC and
  HSK, and the mainnet HSKSwap WETH/USDT TWAP for ETH (APRO has no ETH feed on HSK Chain).
- **Testnet market.** The testnet HSKSwap pools are real HSKSwap pools (created through its
  NonfungiblePositionManager) between test tokens, with 50M tUSDT of full-range liquidity per side. Every hour the
  keeper's **`PoolAligner`** swaps each pool back to the mirrored mainnet price, minting the test tokens it owes, the
  job arbitrageurs do on mainnet. So the testnet vaults gain and lose with the real market and pay real pool fees and
  price impact.
- **The agent** (`agent/src/run.ts`) builds a rules baseline (inverse-volatility sizing, a trend tilt and a downtrend
  filter that cuts a falling coin's weight to 25–75%), asks an LLM to review it with the signals, then applies an
  **asymmetric leash**: the model may always cut a weight, but may only add a few points above the baseline (less for
  a coin in a downtrend). It clips to the mandate, plans swaps that fit the turnover budget and cash floor, simulates,
  and sends `rebalance`. Each trade's rationale (signals, baseline, LLM proposal, final weights, every place the leash
  pulled) is published to the `notes` branch and its keccak256 is committed onchain; the app re-hashes it.
- **The keeper** (`agent/src/keeper.ts`) relays prices, realigns pools and calls `stopOut` wherever `exitStatus`
  says a stop-loss or the breaker has triggered. It never decides trades. Besides its hourly run, the agent's workflow
  runs one keeper pass right before every agent run, so trades always use freshly mirrored prices and realigned pools.
- **The chat** (`app/src/chat.ts`) runs in the browser with no server and no API key: it parses instructions,
  including moods ("I'm worried about a crash" → tighter stop, more cash, tighter breaker), clamps them to what the
  contract accepts, and shows the exact diff before the owner signs (`setMandate`, `setCap`, `setPaused`).
- **The track record** ([app page](https://superphant.github.io/leash-hsk/#/record), `app/src/record.ts`) grades
  every trade 24 hours after it was made, in the visitor's browser, from HSK Chain testnet events alone: the price the
  vault traded at (`TradeExecuted`, or `RiskExit` for a stop-loss) against the oracle price in force 24 hours later
  (the price hub's `Relayed` rounds, timestamped on mainnet). A buy is right if the price rose, a sell if it fell;
  "value added" is what each decision earned or saved over those 24 hours versus not trading. Each vault is also
  compared with holding its first allocation and with staying in cash, and every rationale note is re-hashed and
  matched to the hash in its `Rebalanced` event. No number on the page comes from our servers.

## Try it (about 3 minutes)

1. Get testnet HSK for gas from the [official HSK testnet faucet](https://faucet.hsk.xyz/faucet).
2. Open the [app](https://superphant.github.io/leash-hsk/), **Create vault**: connect a wallet (it adds HSK Chain
   testnet), click **Get 10,000 test USDT**, pick a risk appetite and create the vault. It is delegated to the Leash
   agent, which trades it on its next run.
3. On your vault page, talk to the agent: "how am I doing?", "max 15% in HSK", "trade at most every 8 hours",
   "stop loss 6%", then **Sign and apply**.
4. Or just watch the three live demo vaults (Conservative, Balanced, Aggressive) and their verified rationales, and
   check the agent's graded **Track record**.

## Deployments

**HSK Chain testnet (133)** — [`deployments/133.json`](deployments/133.json)

| Contract | Address |
|---|---|
| LeashFactory | [`0x353ad999ddc02f7fc0876c00c643a0386e6c0b4b`](https://testnet-explorer.hsk.xyz/address/0x353ad999ddc02f7fc0876c00c643a0386e6c0b4b) |
| SwapDesk | [`0xf43dae5250ec6462a42e5f7a1fb2b0401685a5fb`](https://testnet-explorer.hsk.xyz/address/0xf43dae5250ec6462a42e5f7a1fb2b0401685a5fb) |
| MirrorFeedHub | [`0xc8f0aebd9963f8bb2217e8c3f57659de0f2d3a9b`](https://testnet-explorer.hsk.xyz/address/0xc8f0aebd9963f8bb2217e8c3f57659de0f2d3a9b) |
| PoolAligner | [`0x06659271aa926a279799a513aef6c3e652b7c4cf`](https://testnet-explorer.hsk.xyz/address/0x06659271aa926a279799a513aef6c3e652b7c4cf) |
| tUSDT faucet | [`0x4e60901ec6ac8dd9f6b8e6ff152d66966da44240`](https://testnet-explorer.hsk.xyz/address/0x4e60901ec6ac8dd9f6b8e6ff152d66966da44240) |
| HSKSwap tHSK/tUSDT pool | [`0x435cb3e69b3c079efffDB94B0Ab97d12a3D39dfa`](https://testnet-explorer.hsk.xyz/address/0x435cb3e69b3c079efffDB94B0Ab97d12a3D39dfa) |
| HSKSwap tWBTC/tUSDT pool | [`0xa6c3aaF23053b788cb9e8C4E29B8De1bBE27C93F`](https://testnet-explorer.hsk.xyz/address/0xa6c3aaF23053b788cb9e8C4E29B8De1bBE27C93F) |
| HSKSwap tWETH/tUSDT pool | [`0xB0875232303b21B1F5f3E6D4958CBa3c3d595107`](https://testnet-explorer.hsk.xyz/address/0xB0875232303b21B1F5f3E6D4958CBa3c3d595107) |
| Demo vault: Steady BTC (Conservative) | [`0xc6c761dB028dC29e18E5d487982A39800e2e14A2`](https://superphant.github.io/leash-hsk/#/vault/0xc6c761dB028dC29e18E5d487982A39800e2e14A2) |
| Demo vault: Balanced Trio (Balanced) | [`0x9b2D36C0f4c492397AaB3F85addD1Fe68680f6b5`](https://superphant.github.io/leash-hsk/#/vault/0x9b2D36C0f4c492397AaB3F85addD1Fe68680f6b5) |
| Demo vault: HSK Momentum (Aggressive) | [`0xd50Ce76BBB531EFE171f4d69F93Ab7C95A0fac26`](https://superphant.github.io/leash-hsk/#/vault/0xd50Ce76BBB531EFE171f4d69F93Ab7C95A0fac26) |

HSKSwap testnet contracts used: factory `0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0`, SwapRouter02
`0xa6914E66690c6794244B5f66a09eAEbf66254237`, NonfungiblePositionManager `0x73dEc6bfa6751509b08480bd97f54b874E3b20e8`.

**HSK Chain mainnet (177)** — the same `LeashFactory` and `SwapDesk`, with `TwapFeed`s over the real WHSK/USDT and
WBTC/USDT HSKSwap pools. Deployment pending; the mainnet fork test (`contracts/test/Mainnet.t.sol`) already creates a
vault and buys WHSK through the real HSKSwap pool.

## Run it yourself

```sh
# contracts: fork tests against HSK testnet (live HSKSwap) and mainnet (real pools, APRO)
cd contracts && forge test -vv
# agent and keeper
cd agent && npm ci
AGENT_KEY=0x... npx tsx src/run.ts        # one agent cycle
KEEPER_KEY=0x... npx tsx src/keeper.ts    # one keeper cycle
# app
cd app && npm ci && npm run dev
```

The GitHub Actions workflows `agent.yml` (every 4 h) and `keeper.yml` (hourly) run the same scripts and publish
rationale notes and status to the `notes` branch. `tick.yml` starts them on that schedule, because GitHub's own cron
trigger ran hours late for this repository.

## Honest notes

- Everything that trades runs on HSK Chain **testnet** with test tokens; no real money is involved. The prices are
  real HSK Chain mainnet prices.
- The LLM is a free, keyless open-weight model (via Pollinations), called by the agent on GitHub Actions. It
  proposes; code and the vault decide. The keyless endpoint does not accept browser requests, so the in-app chat
  parses instructions in the browser and quotes the agent's LLM rationale rather than calling a model itself.
- Leash started as an entry for Base's Stocks Maxxing builder quest (tokenized stocks on Base, built on Nov 20–21).
  This HSK Chain version was rebuilt during the hackathon: new HSKSwap desk, stop-loss and drawdown breaker, TWAP and
  mirrored APRO price layer, pool aligner, keeper, crypto strategy and the chat.
- The testnet pools are realigned to the mainnet price once an hour, so a trade made between two alignments can pay a
  wider spread than it would on mainnet. The track record counts that cost; it shows up in "Trading added".
- On Nov 21 the hourly keeper did not run on schedule, so the trades at 06:23 and 09:10 UTC used prices relayed hours
  earlier (BTC about 4% and ETH about 5% below the live mainnet price). Their 24-hour grades carry that error. The
  agent now runs a keeper pass right before trading, and `tick.yml` keeps the keeper on time.
- Built by Phant Studio with AI coding assistants (GitHub Copilot). Not investment advice.

MIT licence.
