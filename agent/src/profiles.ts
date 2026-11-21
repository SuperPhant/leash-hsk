// Risk profiles used for the demo vaults and offered as presets ("risk appetite") in the app and the chat.
export interface Profile {
  id: string;
  name: string;
  style: string;
  tickers: string[];
  caps: number[];
  /** How far (fraction of NAV) the LLM may move each weight away from the rules baseline. */
  maxTilt: number;
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

export const PROFILES: Profile[] = [
  {
    id: "steady",
    name: "Steady BTC",
    style:
      "Capital preservation. Mostly BTC with some ETH and a small HSK sleeve, plenty of cash, trade rarely and only when the trend or risk changes. Tight stop-loss.",
    tickers: ["BTC", "ETH", "HSK"],
    caps: [4500, 2500, 1000],
    maxTilt: 0.08,
    mandate: {
      minCashBps: 3000,
      maxTurnoverBps: 3000,
      turnoverWindow: DAY,
      maxSlippageBps: 100,
      maxOracleAge: 30 * HOUR,
      cooldown: 6 * HOUR,
      stopLossBps: 800,
      maxDrawdownBps: 1200,
    },
  },
  {
    id: "balanced",
    name: "Balanced Trio",
    style:
      "Diversified across BTC, ETH and HSK, sized by inverse volatility with a moderate tilt toward the stronger recent trend. Cut a coin whose volatility spikes.",
    tickers: ["BTC", "ETH", "HSK"],
    caps: [4000, 3500, 2500],
    maxTilt: 0.12,
    mandate: {
      minCashBps: 1500,
      maxTurnoverBps: 5000,
      turnoverWindow: DAY,
      maxSlippageBps: 120,
      maxOracleAge: 30 * HOUR,
      cooldown: 4 * HOUR,
      stopLossBps: 1200,
      maxDrawdownBps: 2000,
    },
  },
  {
    id: "momentum",
    name: "HSK Momentum",
    style:
      "Aggressive. Concentrate in whichever of HSK, BTC and ETH has the strongest risk-adjusted trend, rotate quickly out of laggards, accept larger swings within the caps.",
    tickers: ["HSK", "BTC", "ETH"],
    caps: [5000, 5000, 5000],
    maxTilt: 0.15,
    mandate: {
      minCashBps: 500,
      maxTurnoverBps: 8000,
      turnoverWindow: DAY,
      maxSlippageBps: 150,
      maxOracleAge: 30 * HOUR,
      cooldown: 2 * HOUR,
      stopLossBps: 1500,
      maxDrawdownBps: 3000,
    },
  },
];
