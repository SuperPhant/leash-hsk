import { defineChain, type Chain, type Hex } from "viem";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const hskTestnet = defineChain({
  id: 133,
  name: "HSK Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "HSK Testnet Explorer", url: "https://testnet-explorer.hsk.xyz" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

export const hskMainnet = defineChain({
  id: 177,
  name: "HSK Chain",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.hsk.xyz"] } },
  blockExplorers: { default: { name: "HSK Explorer", url: "https://hsk.blockscout.com" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const TARGETS: Record<string, Chain> = { hskTestnet, hskMainnet };

/** Chain the Leash contracts are operated on. The agent and keeper run on the testnet; mainnet is read for prices. */
export function targetChain(): Chain {
  const name = process.env.LEASH_CHAIN ?? "hskTestnet";
  const chain = TARGETS[name];
  if (!chain) throw new Error(`LEASH_CHAIN must be one of ${Object.keys(TARGETS).join(", ")}`);
  return chain;
}

export function targetRpc(chain: Chain): string {
  return process.env.LEASH_RPC ?? chain.rpcUrls.default.http[0];
}

export const MAINNET = hskMainnet;
export const MAINNET_RPC = process.env.HSK_MAINNET_RPC ?? "https://mainnet.hsk.xyz";

export const NOTES_BASE_URL =
  process.env.LEASH_NOTES_URL ?? "https://raw.githubusercontent.com/SuperPhant/leash-hsk/notes";

/** HSKSwap (Uniswap V3) deployments, from app.hskswap.com's own configuration. */
export const HSKSWAP = {
  133: {
    factory: "0x2dC2c21D1049F786C535bF9d45F999dB5474f3A0",
    npm: "0x73dEc6bfa6751509b08480bd97f54b874E3b20e8",
    router: "0xa6914E66690c6794244B5f66a09eAEbf66254237",
  },
  177: {
    factory: "0x972cA9D1662F5e029cD18327D29026532E84c742",
    npm: "0xDF0A9b833Db0E4CeEa103A4408f3B68e7FC0cad5",
    router: "0x2c16f75b95Cf1390c328aB70e2CEE7f4b80bD8F3",
  },
} as const;

export const MAINNET_USDT = "0xF1B50eD67A9e2CC94Ad3c477779E2d4cBfFf9029" as const;
export const POOL_FEE = 3000;

export interface AssetConfig {
  ticker: string;
  name: string;
  testSymbol: string;
  decimals: number;
  mainnetToken: `0x${string}`;
  /** HSKSwap mainnet token/USDT 0.3% pool. */
  mainnetPool: `0x${string}`;
  /** APRO push feed on HSK Chain mainnet (only answers whitelisted contracts, but EOAs and eth_call can read it). */
  aproFeed?: `0x${string}`;
  coingeckoId: string;
}

export const ASSETS: AssetConfig[] = [
  {
    ticker: "HSK",
    name: "HSK",
    testSymbol: "tHSK",
    decimals: 18,
    mainnetToken: "0xB210D2120d57b758EE163cFfb43e73728c471Cf1",
    mainnetPool: "0x4ff515761864e7838B0AdB8b5b2B8B7A068905dC",
    aproFeed: "0x86CE42c1b714149Dc3A7b17169EF67b5F78A224b",
    coingeckoId: "hashkey-ecopoints",
  },
  {
    ticker: "BTC",
    name: "Bitcoin",
    testSymbol: "tWBTC",
    decimals: 8,
    mainnetToken: "0x6119CA49a79f5825C8B345F8d7aC36B272565b14",
    mainnetPool: "0xd9EA2cE468957Ba49cCC38C4758Ed6ecD561449A",
    aproFeed: "0x204ED500ab56A2E19B051561258E3A45c850360F",
    coingeckoId: "bitcoin",
  },
  {
    ticker: "ETH",
    name: "Ether",
    testSymbol: "tWETH",
    decimals: 18,
    mainnetToken: "0xefd4bC9afD210517803f293ABABd701CaeeCdfd0",
    mainnetPool: "0xb92b79ed6b370D5cFee2E14B1D0983C258304C16",
    coingeckoId: "ethereum",
  },
];

/**
 * Reads a private key from the environment, or (on the maintainer's machine only) from the local DPAPI vault.
 * Keys are never printed.
 */
export function loadKey(envName: string, vaultEntry: string): Hex {
  const fromEnv = process.env[envName];
  if (fromEnv) return normalizeKey(fromEnv);
  const vault = process.env.PHANT_VAULT ?? join(homedir(), "AppData", "Local", "PhantWallet", "vault.py");
  const python = process.env.PHANT_PYTHON ?? join(homedir(), ".pyenv", "pyenv-win", "versions", "3.12.10", "python.exe");
  if (!existsSync(vault)) throw new Error(`${envName} is not set`);
  const r = spawnSync(python, [vault, "get", vaultEntry], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.status !== 0) throw new Error(`could not read ${vaultEntry} from the local vault (output suppressed)`);
  return normalizeKey(r.stdout.trim());
}

function normalizeKey(raw: string): Hex {
  const k = raw.trim();
  const key = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("malformed private key (value suppressed)");
  return key;
}

export interface DeployedAsset {
  ticker: string;
  token: `0x${string}`;
  feed: `0x${string}`;
  /** MirrorFeedHub feed id (testnet only). */
  feedId?: number;
  pool: `0x${string}`;
  mainnetToken: `0x${string}`;
  mainnetPool: `0x${string}`;
  aproFeed?: `0x${string}`;
}

export interface Deployment {
  chainId: number;
  chainName: string;
  deployedAt: string;
  deployer: `0x${string}`;
  agent: `0x${string}`;
  keeper: `0x${string}`;
  usd: `0x${string}`;
  desk: `0x${string}`;
  factory: `0x${string}`;
  /** Testnet only. */
  hub?: `0x${string}`;
  aligner?: `0x${string}`;
  faucet?: `0x${string}`;
  startBlock: string;
  assets: DeployedAsset[];
  demoVaults: Array<{ name: string; vault: `0x${string}`; profile: string }>;
}

export function deploymentPath(chainId: number): string {
  return join(process.env.LEASH_DEPLOYMENTS_DIR ?? join(ROOT, "deployments"), `${chainId}.json`);
}

export function loadDeployment(chainId: number): Deployment {
  return JSON.parse(readFileSync(deploymentPath(chainId), "utf8"));
}
