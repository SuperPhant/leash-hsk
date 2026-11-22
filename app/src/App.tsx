import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { WalletClient } from "viem";
import { connectWallet, injected } from "./clients";
import { DEP, IS_MAINNET, MAINNET_DEP, NET, REPO, switchNet, type Net } from "./config";
import { short } from "./util";
import { Home } from "./pages/Home";
import { VaultPage } from "./pages/VaultPage";
import { CreatePage } from "./pages/CreatePage";
import { AgentPage } from "./pages/AgentPage";
import { AboutPage } from "./pages/AboutPage";
import { RecordPage } from "./pages/RecordPage";

interface WalletState {
  address?: `0x${string}`;
  wallet?: WalletClient;
  connect: () => Promise<{ wallet: WalletClient; address: `0x${string}` } | undefined>;
  error?: string;
}

const WalletCtx = createContext<WalletState>({ connect: async () => undefined });
export const useWallet = () => useContext(WalletCtx);

function useHashRoute() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const on = () => {
      setHash(location.hash || "#/");
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash.replace(/^#/, "");
}

function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ address?: `0x${string}`; wallet?: WalletClient; error?: string }>({});
  const connect = async () => {
    try {
      const r = await connectWallet();
      setState({ address: r.address, wallet: r.wallet });
      return r;
    } catch (e: any) {
      setState((s) => ({ ...s, error: e?.shortMessage ?? e?.message ?? String(e) }));
      return undefined;
    }
  };
  useEffect(() => {
    const eth = injected();
    eth?.on?.("accountsChanged", (accts: string[]) => setState((s) => ({ ...s, address: accts[0] as `0x${string}` | undefined })));
  }, []);
  return <WalletCtx.Provider value={{ ...state, connect }}>{children}</WalletCtx.Provider>;
}

function Header() {
  const { address, connect, error } = useWallet();
  return (
    <header className="topbar">
      <a className="brand" href="#/">
        <span className="logo" aria-hidden>
          <svg viewBox="0 0 32 32" width="28" height="28">
            <rect width="32" height="32" rx="8" fill="#111827" />
            <path d="M9 22c4-1 6-5 7-9s3-6 7-6" stroke="#34D399" strokeWidth="3" fill="none" strokeLinecap="round" />
            <circle cx="9" cy="22" r="3" fill="#34D399" />
          </svg>
        </span>
        Leash <span className="muted small">for HSK Chain</span>
      </a>
      <nav>
        <a href="#/">Vaults</a>
        <a href="#/record">Track record</a>
        <a href="#/agent">Agent &amp; keeper</a>
        <a href="#/create">Create vault</a>
        <a href="#/about">How it works</a>
        <a href={REPO} target="_blank" rel="noreferrer">
          GitHub
        </a>
      </nav>
      <div className="wallet">
        <select className="chip net" value={NET} onChange={(e) => switchNet(e.target.value as Net)} title="Network shown">
          <option value="testnet">HSK Chain Testnet</option>
          {MAINNET_DEP && <option value="mainnet">HSK Chain Mainnet</option>}
        </select>
        {address ? (
          <span className="chip addr">{short(address)}</span>
        ) : (
          <button className="btn small" onClick={connect} title={error}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}

export function App() {
  const route = useHashRoute();
  let page: ReactNode;
  if (!DEP) page = <div className="page"><p>No deployment found.</p></div>;
  else if (route.startsWith("/vault/")) page = <VaultPage address={route.split("/")[2] as `0x${string}`} />;
  else if (route.startsWith("/create")) page = <CreatePage />;
  else if (route.startsWith("/agent")) page = <AgentPage />;
  else if (route.startsWith("/record")) page = <RecordPage />;
  else if (route.startsWith("/about")) page = <AboutPage />;
  else page = <Home />;
  return (
    <WalletProvider>
      <Header />
      <main>{page}</main>
      <footer className="footer">
        {IS_MAINNET ? (
          <p>
            This is Leash on HSK Chain mainnet: one small live vault (about a dollar of USDT) traded by the Leash agent
            through the real HSKSwap pools, under the same contracts as the testnet demo. Not investment advice.
          </p>
        ) : (
          <p>
            Leash for HSK Chain is a testnet demonstration built for the HSK Chain Horizon Hackathon. Test tokens and
            testnet HSKSwap pools follow HSK Chain mainnet prices (APRO feeds and HSKSwap TWAP); they have no value. Not
            investment advice.
          </p>
        )}
        <p>
          Built by Phant Studio with AI-assisted development tools (GitHub Copilot) · <a href={REPO}>source (MIT)</a>
        </p>
      </footer>
    </WalletProvider>
  );
}
