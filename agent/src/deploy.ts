// Deploys Leash for HSK Chain to the HSK testnet:
//   test USDT / HSK / WBTC / WETH, a MirrorFeedHub that copies HSK mainnet prices (APRO feeds, HSKSwap TWAP for ETH),
//   real HSKSwap (Uniswap V3) pools for each token against test USDT with deep full-range liquidity, the SwapDesk,
//   the PoolAligner keeper helper, a USDT faucet, the LeashFactory and three demo vaults delegated to the agent.
// Every step is checkpointed in deployments/133.partial.json, so a failed run resumes instead of redeploying.
import { formatEther, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ASSETS, HSKSWAP, POOL_FEE, deploymentPath, loadKey, targetChain, type DeployedAsset, type Deployment } from "./config.js";
import { abi, clients, deploy, write } from "./lib.js";
import { mainnetQuotes, relay } from "./keeper.js";
import { PROFILES } from "./profiles.js";

const chain = targetChain();
if (chain.id !== 133) throw new Error("deploy.ts deploys the testnet stack; use deployMainnet.ts for HSK mainnet");
const sw = HSKSWAP[133];
const { pub, wallet, account } = clients(chain, loadKey("DEPLOYER_KEY", "testnet-deployer"));
const agent = privateKeyToAccount(loadKey("AGENT_KEY", "testnet-agent")).address;
const keeper = privateKeyToAccount(loadKey("KEEPER_KEY", "testnet-leash-keeper")).address;

const tokenAbi = abi("TestToken");
const hubAbi = abi("MirrorFeedHub");
const deskAbi = abi("SwapDesk");
const factoryAbi = abi("LeashFactory");
const npmAbi = [
  {
    type: "function",
    name: "createAndInitializePoolIfNecessary",
    stateMutability: "payable",
    inputs: [
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceX96", type: "uint160" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;
const v3FactoryAbi = [
  {
    type: "function",
    name: "getPool",
    stateMutability: "view",
    inputs: [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
    ],
    outputs: [{ type: "address" }],
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
console.log(`chain ${chain.name} (${chain.id}); deployer ${account.address} (${await bal()} HSK); agent ${agent}; keeper ${keeper}`);
const startBlock = await step("startBlock", async () => (await pub.getBlockNumber()).toString());

// 1. Test tokens.
const usd = await step("usd", () => deploy(pub, wallet, account, "TestToken", ["Leash Test USDT", "tUSDT", 6]));
const tokens: Record<string, `0x${string}`> = {};
for (const a of ASSETS) {
  tokens[a.ticker] = await step(`token.${a.ticker}`, () =>
    deploy(pub, wallet, account, "TestToken", [`Leash Test ${a.ticker === "HSK" ? "HSK" : `W${a.ticker}`}`, a.testSymbol, a.decimals]),
  );
}

// 2. Mirror hub (deployer relays the first prices, then hands the relayer role to the keeper) + one feed per asset.
const hub = await step("hub", () => deploy(pub, wallet, account, "MirrorFeedHub", [account.address]));
const feeds: Record<string, { feedId: number; feed: `0x${string}` }> = {};
for (const a of ASSETS) {
  feeds[a.ticker] = await step(`feed.${a.ticker}`, async () => {
    const source = a.aproFeed ?? a.mainnetPool;
    const label = a.aproFeed
      ? `${a.ticker} / USD (mirror of APRO ${a.aproFeed} on HSK Chain mainnet)`
      : `${a.ticker} / USD (30-min TWAP of HSKSwap W${a.ticker}/USDT ${a.mainnetPool} on HSK Chain mainnet)`;
    const { result } = await write(pub, wallet, account, { address: hub, abi: hubAbi, functionName: "addFeed", args: [source, 8, label] });
    const [feedId, feed] = result as [bigint, `0x${string}`];
    return { feedId: Number(feedId), feed };
  });
}

const partialDep = (): Deployment => ({
  chainId: chain.id,
  chainName: chain.name,
  deployedAt: new Date().toISOString(),
  deployer: account.address,
  agent,
  keeper,
  usd,
  desk: (state.desk as `0x${string}`) ?? "0x",
  factory: (state.factory as `0x${string}`) ?? "0x",
  hub,
  aligner: state.aligner as `0x${string}` | undefined,
  faucet: state.faucet as `0x${string}` | undefined,
  startBlock,
  assets: ASSETS.map((a) => ({
    ticker: a.ticker,
    token: tokens[a.ticker],
    feed: feeds[a.ticker].feed,
    feedId: feeds[a.ticker].feedId,
    pool: ((state[`pool.${a.ticker}`] as string) ?? "0x") as `0x${string}`,
    mainnetToken: a.mainnetToken,
    mainnetPool: a.mainnetPool,
    aproFeed: a.aproFeed,
  })),
  demoVaults: [],
});

const quotes = await mainnetQuotes();
await step("relay0", async () => (await relay(pub, wallet, account, partialDep(), quotes)).tx ?? "none");
await step("relayerToKeeper", async () =>
  (await write(pub, wallet, account, { address: hub, abi: hubAbi, functionName: "setRelayer", args: [keeper] })).hash,
);

// 3. Desk: rejects oracle answers older than 30 h (APRO's heartbeat on HSK mainnet is 24 h) and pools more than 2%
//    away from their oracle.
const desk = await step("desk", () => deploy(pub, wallet, account, "SwapDesk", [usd, sw.factory, sw.router, 200, 30 * 3600]));

// 4. HSKSwap pools at the mirrored mainnet price, with 50M USDT of full-range liquidity per side.
const Q192 = 1n << 192n;
function sqrtBig(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}
const MAX_TICK = 887_220;
for (const a of ASSETS) {
  const token = tokens[a.ticker];
  const price = quotes.find((q) => q.ticker === a.ticker)!.answer; // 8 decimals
  const tokenIsToken0 = token.toLowerCase() < usd.toLowerCase();
  const [t0, t1] = tokenIsToken0 ? [token, usd] : [usd, token];
  const tokenUnit = 10n ** BigInt(a.decimals + 8);
  const usdUnit = price * 10n ** 6n;
  const sqrtPriceX96 = sqrtBig(tokenIsToken0 ? (usdUnit * Q192) / tokenUnit : (tokenUnit * Q192) / usdUnit);
  await step(`poolCreate.${a.ticker}`, async () =>
    (await write(pub, wallet, account, {
      address: sw.npm,
      abi: npmAbi as never,
      functionName: "createAndInitializePoolIfNecessary",
      args: [t0, t1, POOL_FEE, sqrtPriceX96],
    })).hash,
  );
  const usdSide = parseUnits("50000000", 6);
  const tokenSide = (usdSide * tokenUnit) / usdUnit;
  await step(`poolFund.${a.ticker}`, async () => {
    await write(pub, wallet, account, { address: usd, abi: tokenAbi, functionName: "mint", args: [account.address, usdSide] });
    await write(pub, wallet, account, { address: token, abi: tokenAbi, functionName: "mint", args: [account.address, tokenSide] });
    await write(pub, wallet, account, { address: usd, abi: tokenAbi, functionName: "approve", args: [sw.npm, usdSide] });
    await write(pub, wallet, account, { address: token, abi: tokenAbi, functionName: "approve", args: [sw.npm, tokenSide] });
    const [a0, a1] = tokenIsToken0 ? [tokenSide, usdSide] : [usdSide, tokenSide];
    const { hash } = await write(pub, wallet, account, {
      address: sw.npm,
      abi: npmAbi as never,
      functionName: "mint",
      args: [
        {
          token0: t0,
          token1: t1,
          fee: POOL_FEE,
          tickLower: -MAX_TICK,
          tickUpper: MAX_TICK,
          amount0Desired: a0,
          amount1Desired: a1,
          amount0Min: 0n,
          amount1Min: 0n,
          recipient: account.address,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
        },
      ],
    });
    return hash;
  });
  const pool = await step(`pool.${a.ticker}`, async () =>
    (await pub.readContract({ address: sw.factory, abi: v3FactoryAbi, functionName: "getPool", args: [token, usd, POOL_FEE] })) as `0x${string}`,
  );
  await step(`list.${a.ticker}`, async () =>
    (await write(pub, wallet, account, { address: desk, abi: deskAbi, functionName: "list", args: [token, feeds[a.ticker].feed, POOL_FEE] })).hash,
  );
  console.log(`${a.ticker}: token ${token} pool ${pool} at $${Number(price) / 1e8}`);
}

// 5. Aligner (testnet arbitrageur run by the keeper) and the USDT faucet; both mint test tokens.
const aligner = await step("aligner", () => deploy(pub, wallet, account, "PoolAligner", [desk, keeper]));
for (const t of [usd, ...Object.values(tokens)]) {
  await step(`minter.aligner.${t}`, async () =>
    (await write(pub, wallet, account, { address: t, abi: tokenAbi, functionName: "setMinter", args: [aligner, true] })).hash,
  );
}
const faucet = await step("faucet", () => deploy(pub, wallet, account, "TokenFaucet", [usd, parseUnits("10000", 6), 24n * 3600n]));
await step("minter.faucet", async () =>
  (await write(pub, wallet, account, { address: usd, abi: tokenAbi, functionName: "setMinter", args: [faucet, true] })).hash,
);

// 6. Factory and three demo vaults owned by the deployer and delegated to the agent.
const factory = await step("factory", () => deploy(pub, wallet, account, "LeashFactory", [desk]));
const perVault = parseUnits("100000", 6);
await step("demoFunds", async () => {
  await write(pub, wallet, account, { address: usd, abi: tokenAbi, functionName: "mint", args: [account.address, perVault * BigInt(PROFILES.length)] });
  return (await write(pub, wallet, account, { address: usd, abi: tokenAbi, functionName: "approve", args: [factory, perVault * BigInt(PROFILES.length)] })).hash;
});
const demoVaults: Deployment["demoVaults"] = [];
for (const p of PROFILES) {
  const vault = await step(`vault.${p.id}`, async () => {
    const assets = p.tickers.map((t) => tokens[t]);
    const mandate = { ...p.mandate, expiry: BigInt(Math.floor(Date.now() / 1000) + 365 * 24 * 3600) };
    const { result } = await write(pub, wallet, account, {
      address: factory,
      abi: factoryAbi,
      functionName: "createVault",
      args: [agent, assets, p.caps, mandate, perVault],
    });
    return result as `0x${string}`;
  });
  demoVaults.push({ name: p.name, vault, profile: p.id });
  console.log(`demo vault ${p.name}: ${vault}`);
}

// 7. Gas for the agent and the keeper.
for (const [label, who, amount] of [
  ["agent", agent, "0.015"],
  ["keeper", keeper, "0.02"],
] as const) {
  await step(`gas.${label}`, async () => {
    const have = await pub.getBalance({ address: who });
    if (have >= parseEther(amount)) return "funded";
    const hash = await wallet.sendTransaction({ account, chain, to: who, value: parseEther(amount) - have });
    await pub.waitForTransactionReceipt({ hash });
    return hash;
  });
}

const dep: Deployment = {
  ...partialDep(),
  desk,
  factory,
  aligner,
  faucet,
  assets: partialDep().assets.map((a): DeployedAsset => ({ ...a, pool: state[`pool.${a.ticker}`] as `0x${string}` })),
  demoVaults,
};
writeFileSync(deploymentPath(chain.id), JSON.stringify(dep, null, 2));
rmSync(statePath);
console.log(`wrote ${deploymentPath(chain.id)}; deployer has ${await bal()} HSK left`);
