import { createPublicClient, createWalletClient, custom, http, type Abi, type WalletClient } from "viem";
import { CHAIN, MAINNET } from "./config";
import { patientRpc } from "./rpc";
import LeashVault from "./abi/LeashVault.json";
import LeashFactory from "./abi/LeashFactory.json";
import SwapDesk from "./abi/SwapDesk.json";
import TokenFaucet from "./abi/TokenFaucet.json";
import TestToken from "./abi/TestToken.json";
import Aggregator from "./abi/AggregatorV3Interface.json";

export const ABI = {
  vault: LeashVault.abi as Abi,
  factory: LeashFactory.abi as Abi,
  desk: SwapDesk.abi as Abi,
  faucet: TokenFaucet.abi as Abi,
  erc20: TestToken.abi as Abi,
  feed: Aggregator.abi as Abi,
};

export const testnet = createPublicClient({
  chain: CHAIN,
  batch: { multicall: { wait: 20 } },
  transport: patientRpc(CHAIN.rpcUrls.default.http[0]),
});
export const mainnet = createPublicClient({ chain: MAINNET, transport: http(MAINNET.rpcUrls.default.http[0], { batch: true, retryCount: 3 }) });

type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown>; on?: (e: string, f: (...a: any[]) => void) => void };

export function injected(): Eip1193 | null {
  return ((window as any).ethereum as Eip1193) ?? null;
}

/** Connects the browser wallet and switches (or adds) HSK Chain testnet. */
export async function connectWallet(): Promise<{ wallet: WalletClient; address: `0x${string}` }> {
  const eth = injected();
  if (!eth) throw new Error("No browser wallet found. Install MetaMask (or any EVM wallet) to continue.");
  const wallet = createWalletClient({ chain: CHAIN, transport: custom(eth) });
  const [address] = await wallet.requestAddresses();
  const current = await wallet.getChainId();
  if (current !== CHAIN.id) {
    try {
      await wallet.switchChain({ id: CHAIN.id });
    } catch {
      await wallet.addChain({ chain: CHAIN });
      await wallet.switchChain({ id: CHAIN.id });
    }
  }
  return { wallet, address };
}

/** Sends a contract write from the connected wallet after a simulation, and waits for the receipt. */
export async function send(
  wallet: WalletClient,
  account: `0x${string}`,
  req: { address: `0x${string}`; abi: Abi; functionName: string; args?: readonly unknown[] },
): Promise<`0x${string}`> {
  const { request } = await testnet.simulateContract({ ...req, account } as never);
  const hash = await wallet.writeContract({ ...(request as object), account, chain: CHAIN } as never);
  const receipt = await testnet.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
}
