import { defineChain, type Chain } from "viem";

export interface DeployedAsset {
  ticker: string;
  token: `0x${string}`;
  feed: `0x${string}`;
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
  hub?: `0x${string}`;
  aligner?: `0x${string}`;
  faucet?: `0x${string}`;
  startBlock: string;
  assets: DeployedAsset[];
  demoVaults: Array<{ name: string; vault: `0x${string}`; profile: string }>;
}

export const hskTestnet = defineChain({
  id: 133,
  name: "HSK Chain Testnet",
  nativeCurrency: { name: "HSK", symbol: "HSK", decimals: 18 },
  // VITE_RPC lets a local build talk to an anvil fork for end-to-end tests.
  rpcUrls: { default: { http: [import.meta.env.VITE_RPC ?? "https://testnet.hsk.xyz"] } },
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

const found = import.meta.glob("../../deployments/*.json", { eager: true, import: "default" }) as Record<string, Deployment>;
export const DEPLOYMENTS = Object.values(found);
export const TESTNET_DEP: Deployment = DEPLOYMENTS.find((d) => d.chainId === 133)!;
/** The mainnet deployment: the same contracts and one small live vault. */
export const MAINNET_DEP: Deployment | undefined = DEPLOYMENTS.find((d) => d.chainId === 177);

export type Net = "testnet" | "mainnet";
const NET_KEY = "leash-hsk-net";

function pickNet(): Net {
  const fromUrl = new URLSearchParams(location.search).get("net");
  let saved: string | null = null;
  try {
    if (fromUrl === "testnet" || fromUrl === "mainnet") localStorage.setItem(NET_KEY, fromUrl);
    saved = localStorage.getItem(NET_KEY);
  } catch {}
  return (fromUrl ?? saved) === "mainnet" && MAINNET_DEP ? "mainnet" : "testnet";
}

/** The network the app shows: HSK Chain testnet by default, mainnet with ?net=mainnet or the header switch. */
export const NET: Net = pickNet();
export const IS_MAINNET = NET === "mainnet";
export const DEP: Deployment = IS_MAINNET ? MAINNET_DEP! : TESTNET_DEP;

export function switchNet(net: Net, hash = "#/") {
  try {
    localStorage.setItem(NET_KEY, net);
  } catch {}
  const u = new URL(location.href);
  u.searchParams.delete("net");
  u.hash = hash;
  history.replaceState(null, "", u.toString());
  location.reload();
}

export const CHAIN: Chain = IS_MAINNET ? hskMainnet : hskTestnet;
export const MAINNET = hskMainnet;
export const TESTNET_EXPLORER = "https://testnet-explorer.hsk.xyz";
export const MAINNET_EXPLORER = "https://hsk.blockscout.com";
export const EXPLORER = IS_MAINNET ? MAINNET_EXPLORER : TESTNET_EXPLORER;
export const FAUCET_URL = "https://faucet.hsk.xyz/faucet";

export const REPO = "https://github.com/SuperPhant/leash-hsk";
export const NOTES = "https://raw.githubusercontent.com/SuperPhant/leash-hsk/notes";

export const TICKER_BY_TOKEN = new Map((DEP?.assets ?? []).map((a) => [a.token.toLowerCase(), a.ticker]));
export const TOKEN_BY_TICKER = new Map((DEP?.assets ?? []).map((a) => [a.ticker, a.token]));

export const COIN_NAMES: Record<string, string> = { HSK: "HSK", BTC: "Bitcoin", ETH: "Ether" };

/** Risk appetite presets, mirrored from agent/src/profiles.ts. */
export interface Preset {
  id: string;
  name: string;
  blurb: string;
  tickers: string[];
  caps: number[];
  mandate: {
    minCashBps: number;
    maxTurnoverBps: number;
    turnoverWindow: number;
    maxSlippageBps: number;
    maxOracleAge: number;
    cooldown: number;
    stopLossBps: number;
    maxDrawdownBps: number;
  };
}

const HOUR = 3600;
const DAY = 24 * HOUR;
export const PRESETS: Preset[] = [
  {
    id: "steady",
    name: "Conservative",
    blurb: "Mostly BTC, lots of cash, trades at most every 6 hours, 8% stop-loss, breaker at 12% drawdown.",
    tickers: ["BTC", "ETH", "HSK"],
    caps: [4500, 2500, 1000],
    mandate: { minCashBps: 3000, maxTurnoverBps: 3000, turnoverWindow: DAY, maxSlippageBps: 100, maxOracleAge: 30 * HOUR, cooldown: 6 * HOUR, stopLossBps: 800, maxDrawdownBps: 1200 },
  },
  {
    id: "balanced",
    name: "Balanced",
    blurb: "BTC, ETH and HSK sized by volatility, trades at most every 4 hours, 12% stop-loss, breaker at 20%.",
    tickers: ["BTC", "ETH", "HSK"],
    caps: [4000, 3500, 2500],
    mandate: { minCashBps: 1500, maxTurnoverBps: 5000, turnoverWindow: DAY, maxSlippageBps: 120, maxOracleAge: 30 * HOUR, cooldown: 4 * HOUR, stopLossBps: 1200, maxDrawdownBps: 2000 },
  },
  {
    id: "momentum",
    name: "Aggressive",
    blurb: "Follows the strongest trend among HSK, BTC and ETH, trades every 2 hours, 15% stop-loss, breaker at 30%.",
    tickers: ["HSK", "BTC", "ETH"],
    caps: [5000, 5000, 5000],
    mandate: { minCashBps: 500, maxTurnoverBps: 8000, turnoverWindow: DAY, maxSlippageBps: 150, maxOracleAge: 30 * HOUR, cooldown: 2 * HOUR, stopLossBps: 1500, maxDrawdownBps: 3000 },
  },
];
