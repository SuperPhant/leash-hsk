import { custom } from "viem";

// Public testnet RPCs rate-limit by request count. Vibenet answers with JSON-RPC error -32016 inside an HTTP 200 and
// Base Sepolia with HTTP 429, and viem retries neither, so reads are folded into Multicall3 calls (see clients.ts) and
// rate-limited requests are retried here with backoff.
let rpcId = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMIT_CODES = new Set([-32016, -32005, 429]);

export const patientRpc = (url: string) =>
  custom({
    async request({ method, params }) {
      for (let attempt = 0; ; attempt++) {
        let j: any;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
          });
          if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
          j = await res.json();
        } catch (e) {
          if (attempt < 6) {
            await sleep(600 * (attempt + 1));
            continue;
          }
          throw e;
        }
        if (j.error) {
          const limited = RATE_LIMIT_CODES.has(j.error.code) || /rate limit|too many requests/i.test(String(j.error.message));
          if (limited && attempt < 8) {
            await sleep(700 * (attempt + 1));
            continue;
          }
          throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        }
        return j.result;
      }
    },
  });
