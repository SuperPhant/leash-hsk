// Copies contract ABIs (and bytecode for deployable contracts) from the Foundry build into agent/abi and app/src/abi.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const out = join(root, "contracts", "out");
const agentAbi = join(root, "agent", "abi");
const appAbi = join(root, "app", "src", "abi");

const deployable = ["TestToken", "MirrorFeedHub", "SwapDesk", "PoolAligner", "LeashVault", "LeashFactory", "TwapFeed"];
const abiOnly: Array<[string, string]> = [
  ["TestToken.sol", "TokenFaucet"],
  ["MirrorFeedHub.sol", "MirrorFeed"],
  ["AggregatorV3Interface.sol", "AggregatorV3Interface"],
];

for (const dir of [agentAbi, appAbi]) mkdirSync(dir, { recursive: true });

function emit(file: string, name: string, withBytecode: boolean) {
  const art = JSON.parse(readFileSync(join(out, file, `${name}.json`), "utf8"));
  const agentBody = withBytecode ? { abi: art.abi, bytecode: art.bytecode.object } : { abi: art.abi };
  writeFileSync(join(agentAbi, `${name}.json`), JSON.stringify(agentBody));
  writeFileSync(join(appAbi, `${name}.json`), JSON.stringify({ abi: art.abi }));
  console.log(`exported ${name}${withBytecode ? " (+bytecode)" : ""}`);
}

for (const n of deployable) emit(`${n}.sol`, n, true);
for (const [f, n] of abiOnly) emit(f, n, n === "TokenFaucet");
