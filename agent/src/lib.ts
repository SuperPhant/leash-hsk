import {
  createPublicClient,
  createWalletClient,
  http,
  type Abi,
  type Account,
  type Chain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MAINNET, MAINNET_RPC, ROOT, targetRpc } from "./config.js";

export function abi(name: string): Abi {
  return JSON.parse(readFileSync(join(ROOT, "agent", "abi", `${name}.json`), "utf8")).abi as Abi;
}

export function bytecode(name: string): Hex {
  return JSON.parse(readFileSync(join(ROOT, "agent", "abi", `${name}.json`), "utf8")).bytecode as Hex;
}

export function mainnetClient(): PublicClient {
  return createPublicClient({ chain: MAINNET, transport: http(MAINNET_RPC, { retryCount: 4, batch: true }) }) as PublicClient;
}

export function clients(chain: Chain, key: Hex) {
  const account = privateKeyToAccount(key);
  const transport = http(targetRpc(chain), { retryCount: 4 });
  const pub = createPublicClient({ chain, transport }) as PublicClient;
  const wallet = createWalletClient({ chain, transport, account });
  return { account, pub, wallet };
}

/** Simulates, sends and waits for a contract write; throws with the decoded revert reason on failure. */
export async function write(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  req: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
) {
  const { request, result } = await pub.simulateContract({ ...req, account } as never);
  const hash = await wallet.writeContract(request as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${req.functionName} reverted in ${hash}`);
  return { hash, receipt, result: result as unknown };
}

export async function deploy(
  pub: PublicClient,
  wallet: WalletClient,
  account: Account,
  name: string,
  args: readonly unknown[],
): Promise<`0x${string}`> {
  const hash = await wallet.deployContract({ abi: abi(name), bytecode: bytecode(name), args, account, chain: wallet.chain } as never);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy ${name} failed in ${hash}`);
  console.log(`deployed ${name} at ${receipt.contractAddress} (gas ${receipt.gasUsed})`);
  return receipt.contractAddress;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const aggAbi = [
  {
    type: "function",
    name: "latestRoundData",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "roundId", type: "uint80" },
      { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" },
      { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" },
    ],
  },
] as const;

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "observe",
    stateMutability: "view",
    inputs: [{ name: "secondsAgos", type: "uint32[]" }],
    outputs: [
      { name: "tickCumulatives", type: "int56[]" },
      { name: "secondsPerLiquidityCumulativeX128s", type: "uint160[]" },
    ],
  },
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export interface FeedRound {
  roundId: bigint;
  answer: bigint;
  startedAt: bigint;
  updatedAt: bigint;
}

/** Reads an APRO feed the way an off-chain client does (eth_call with no sender), which its access control allows. */
export async function readApro(client: PublicClient, feed: `0x${string}`): Promise<FeedRound> {
  const [roundId, answer, startedAt, updatedAt] = await client.readContract({ address: feed, abi: aggAbi, functionName: "latestRoundData" });
  return { roundId, answer, startedAt, updatedAt };
}

/** USD price of one whole token, 8 decimals, from a token/USDT HSKSwap pool: `window`-second TWAP and spot. */
export async function poolPrice(
  client: PublicClient,
  pool: `0x${string}`,
  token: `0x${string}`,
  tokenDecimals: number,
  usdDecimals = 6,
  window = 1800,
): Promise<{ twap: bigint; spot: bigint }> {
  const [token0, observed, slot0] = await Promise.all([
    client.readContract({ address: pool, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[window, 0]] }),
    client.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
  ]);
  const isToken0 = token0.toLowerCase() === token.toLowerCase();
  const [c0, c1] = observed[0];
  const delta = c1 - c0;
  let tick = Number(delta / BigInt(window));
  if (delta < 0n && delta % BigInt(window) !== 0n) tick -= 1;
  const toUsd = (t: number) => {
    const ratio = Math.pow(1.0001, isToken0 ? t : -t); // USD raw per token raw
    return BigInt(Math.round(ratio * 10 ** (tokenDecimals - usdDecimals) * 1e8));
  };
  return { twap: toUsd(tick), spot: toUsd(slot0[1]) };
}
