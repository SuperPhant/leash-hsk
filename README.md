# Leash for HSK Chain

An AI trading agent for HSKSwap that can only act inside an onchain mandate its owner sets, with stop-loss and
drawdown rules enforced by the vault contract itself.

Built for the HSK Chain Horizon Hackathon (Seoul), AI Agent Trading track. Work in progress; the full write-up,
demo and live app links follow.

- Contracts: `contracts/` (Foundry). Fork tests run against HSK Chain testnet (live HSKSwap) and mainnet.
- Agent and keeper: `agent/` (TypeScript, viem), run on GitHub Actions.
- Testnet deployment: [`deployments/133.json`](deployments/133.json).

Built by Phant Studio with AI coding assistants (GitHub Copilot). MIT licence.
