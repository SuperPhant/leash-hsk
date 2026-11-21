import { testnet } from "./clients";
import { DEP } from "./config";

/** HSK Chain's public RPC rejects eth_getLogs when toBlock - fromBlock exceeds 5,000 (about 2.8 hours of blocks). */
export const LOG_SPAN = 5_000n;
/** Spans that end this many blocks below the head are final and cached for the rest of the visit. */
const FINAL = 64n;
const cache = new Map<string, unknown[]>();

/**
 * Runs a log query from `fromBlock` to the head in spans the RPC accepts, a few at a time. The spans are aligned to
 * `fromBlock`, so repeated calls (the pages poll) only fetch the spans that were not final last time.
 */
export async function logsInSpans<T>(
  key: string,
  fetch: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint = BigInt(DEP.startBlock),
  parallel = 6,
): Promise<T[]> {
  const latest = await testnet.getBlockNumber();
  const spans: Array<[bigint, bigint]> = [];
  for (let s = fromBlock; s <= latest; s += LOG_SPAN) spans.push([s, s + LOG_SPAN - 1n > latest ? latest : s + LOG_SPAN - 1n]);
  const out: T[][] = new Array(spans.length);
  let next = 0;
  const worker = async () => {
    while (next < spans.length) {
      const i = next++;
      const [a, b] = spans[i];
      const k = `${key}:${a}`;
      const hit = cache.get(k);
      if (hit) {
        out[i] = hit as T[];
        continue;
      }
      const logs = await fetch(a, b);
      if (b - a + 1n === LOG_SPAN && b + FINAL < latest) cache.set(k, logs);
      out[i] = logs;
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, spans.length) }, worker));
  return out.flat();
}
