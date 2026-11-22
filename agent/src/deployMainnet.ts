// Deploys Leash for HSK Chain to HSK Chain mainnet (chain 177):
//   the SwapDesk on the real HSKSwap pools, a 30-minute TWAP feed (TwapFeed) for WHSK, WBTC and WETH against USDT
//   (APRO's mainnet feeds only answer whitelisted contracts), the LeashFactory, and one small live vault: the
//   deployer swaps FUND_HSK of HSK for USDT on HSKSwap and opens a Balanced vault with it, delegated to the agent.
//   The agent also enforces stop-losses on mainnet (stopOut is permissionless), so it doubles as the keeper.
// Every step is checkpointed in deployments/177.partial.json, so a failed run resumes instead of redeploying.
//
//   LEASH_CHAIN=hskMainnet npx tsx src/deployMainnet.ts
//
// Env: DEPLOYER_KEY (else the local vault entry testnet-deployer), LEASH_MAINNET_AGENT (agent address; else derived
// from MAINNET_AGENT_KEY or the vault entry hsk-mainnet-agent), FUND_HSK (default 12), AGENT_GAS_HSK (default 3).
import { formatEther, formatUnits, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ASSETS, HSKSWAP, MAINNET_USDT, POOL_FEE, deploymentPath, loadKey, targetChain, type Deployment } from "./config.js";
import { abi, clients, deploy, mainnetClient, poolPrice, write } from "./lib.js";
import { PROFILES } from "./profiles.js";

const chain = targetChain();
if (chain.id !== 177) throw new Error("deployMainnet.ts deploys to HSK Chain mainnet; set LEASH_CHAIN=hskMainnet");
const sw = HSKSWAP[177];
const { pub, wallet, account } = clients(chain, loadKey("DEPLOYER_KEY", "testnet-deployer"));
const agent = (process.env.LEASH_MAINNET_AGENT ??
  privateKeyToAccount(loadKey("MAINNET_AGENT_KEY", "hsk-mainnet-agent")).address) as `0x${string}`;
const fundHsk = parseEther(process.env.FUND_HSK ?? "12");
const agentGas = parseEther(process.env.AGENT_GAS_HSK ?? "3");
const TWAP_WINDOW = 30 * 60;
/** Spot more than 2% away from the 30-minute TWAP blocks trading, as on the testnet. */
const MAX_DEVIATION_BPS = 200;
/** TwapFeed answers are computed at every call, so their age is always zero; this only has to be positive. */
const MAX_ORACLE_AGE = 24 * 3600;
const PROFILE = PROFILES.find((p) => p.id === "balanced")!;

const deskAbi = abi("SwapDesk");
const factoryAbi = abi("LeashFactory");
const erc20Abi = abi("TestToken");
const routerAbi = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

const statePath = deploymentPath(chain.id).replace(".json", ".partial.json");
const state: Record<string, unknown> = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : {};
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  if (name in state) return state[name] as T;
  const value = await fn();
  state[name] = value;
  writeFileSync(statePath, JSON.stringify(state, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return value;
}

const bal = async () => formatEther(await pub.getBalance({ address: account.address }));
console.log(`chain ${chain.name} (${chain.id}); deployer ${account.address} (${await bal()} HSK); agent ${agent}`);
const startBlock = await step("startBlock", async () => (await pub.getBlockNumber()).toString());

// 1. Desk, TWAP feeds, listings, factory.
const desk = await step("desk", () =>
  deploy(pub, wallet, account, "SwapDesk", [MAINNET_USDT, sw.factory, sw.router, MAX_DEVIATION_BPS, MAX_ORACLE_AGE]),
);
const feeds: Record<string, `0x${string}`> = {};
for (const a of ASSETS) {
  feeds[a.ticker] = await step(`feed.${a.ticker}`, () =>
    deploy(pub, wallet, account, "TwapFeed", [a.mainnetPool, a.mainnetToken, TWAP_WINDOW, `${a.ticker} / USD (HSKSwap 30m TWAP)`]),
  );
  await step(`list.${a.ticker}`, async () =>
    (await write(pub, wallet, account, { address: desk, abi: deskAbi, functionName: "list", args: [a.mainnetToken, feeds[a.ticker], POOL_FEE] }))
      .hash,
  );
}
const factory = await step("factory", () => deploy(pub, wallet, account, "LeashFactory", [desk]));

// 2. Fund: swap FUND_HSK of native HSK for USDT through SwapRouter02 (it wraps HSK into WHSK itself).
const hsk = ASSETS.find((a) => a.ticker === "HSK")!;
const usdtIn = await step("fundSwap", async () => {
  const { twap } = await poolPrice(mainnetClient(), hsk.mainnetPool, hsk.mainnetToken, hsk.decimals);
  const expected = (fundHsk * twap) / 10n ** 20n; // HSK (1e18) x USD (1e8) -> USDT (1e6)
  const before = (await pub.readContract({ address: MAINNET_USDT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  const { request } = await pub.simulateContract({
    address: sw.router,
    abi: routerAbi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: hsk.mainnetToken,
        tokenOut: MAINNET_USDT,
        fee: POOL_FEE,
        recipient: account.address,
        amountIn: fundHsk,
        amountOutMinimum: (expected * 97n) / 100n,
        sqrtPriceLimitX96: 0n,
      },
    ],
    value: fundHsk,
    account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`HSK -> USDT swap reverted in ${hash}`);
  const after = (await pub.readContract({ address: MAINNET_USDT, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })) as bigint;
  console.log(`swapped ${formatEther(fundHsk)} HSK for ${formatUnits(after - before, 6)} USDT (tx ${hash})`);
  return (after - before).toString();
});
const deposit = BigInt(usdtIn);

// 3. The live vault: Balanced profile, owned by the deployer, delegated to the agent.
await step("approve", async () =>
  (await write(pub, wallet, account, { address: MAINNET_USDT, abi: erc20Abi, functionName: "approve", args: [factory, deposit] })).hash,
);
const vault = await step("vault", async () => {
  const assets = PROFILE.tickers.map((t) => ASSETS.find((a) => a.ticker === t)!.mainnetToken);
  const mandate = { ...PROFILE.mandate, expiry: BigInt(Math.floor(Date.now() / 1000) + 180 * 24 * 3600) };
  const { result } = await write(pub, wallet, account, {
    address: factory,
    abi: factoryAbi,
    functionName: "createVault",
    args: [agent, assets, PROFILE.caps, mandate, deposit],
  });
  return result as `0x${string}`;
});
console.log(`live vault ${vault}: ${formatUnits(deposit, 6)} USDT, ${PROFILE.name} rules, agent ${agent}`);

// 4. Gas for the agent (it also runs the stop-loss sweep on mainnet).
await step("gas.agent", async () => {
  const have = await pub.getBalance({ address: agent });
  if (have >= agentGas) return "funded";
  const hash = await wallet.sendTransaction({ account, chain, to: agent, value: agentGas - have });
  await pub.waitForTransactionReceipt({ hash });
  return hash;
});

const dep: Deployment = {
  chainId: chain.id,
  chainName: chain.name,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  agent,
  keeper: agent,
  usd: MAINNET_USDT,
  desk,
  factory,
  startBlock,
  assets: ASSETS.map((a) => ({
    ticker: a.ticker,
    token: a.mainnetToken,
    feed: feeds[a.ticker],
    pool: a.mainnetPool,
    mainnetToken: a.mainnetToken,
    mainnetPool: a.mainnetPool,
    aproFeed: a.aproFeed,
  })),
  demoVaults: [{ name: "Leash Mainnet", vault, profile: PROFILE.id }],
};
writeFileSync(deploymentPath(chain.id), JSON.stringify(dep, null, 2));
rmSync(statePath);
console.log(`wrote ${deploymentPath(chain.id)}; deployer has ${await bal()} HSK left`);
