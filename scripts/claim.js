// Claim one leg (or both) with the preimage, but only while a claim is the
// valid action for the current on-chain state.
//
//   npm run claim
//   npm run claim -- --chain sepolia
//   npm run claim -- --preimage 0x...
//
// The script reads the swap first and refuses (with the reason) when the swap is
// missing, already completed or expired. That refusal is the B4 requirement:
// never offer a claim that can no longer succeed.
const { parseArgs } = require("node:util");

const { chainConfig, confirmations: configuredConfirmations, shortHex, swapParamsFromEnv } = require("./lib/config");
const { connectChain } = require("./lib/chain");
const protocol = require("./lib/protocol");
const ui = require("./lib/ui");

function selectedChainNames(value) {
  const text = String(value || "both").toLowerCase();
  if (text === "both") return ["sepolia", "arbitrum"];
  return [chainConfig(text).name];
}

async function main() {
  const { values } = parseArgs({
    options: {
      chain: { type: "string", default: "both" },
      preimage: { type: "string" },
      "erc20-swap-id": { type: "string" },
      "eth-swap-id": { type: "string" },
      confirmations: { type: "string" },
    },
  });

  const params = swapParamsFromEnv();
  const preimage = values.preimage ?? params.preimage;
  const swapIds = {
    sepolia: values["erc20-swap-id"] ?? params.erc20SwapId,
    arbitrum: values["eth-swap-id"] ?? params.ethSwapId,
  };
  const confirmations = Number(values.confirmations ?? configuredConfirmations());

  ui.heading("Claim a locked asset");
  if (!preimage) {
    ui.warn("No preimage available. Set SWAP_PREIMAGE in .env or pass --preimage.");
    process.exitCode = 1;
    return;
  }

  let failures = 0;
  let claimed = 0;
  let refused = 0;

  for (const name of selectedChainNames(values.chain)) {
    const cfg = chainConfig(name);
    const swapId = swapIds[name];
    console.log("");
    console.log(`  ${cfg.label}`);
    console.log(`  ${"-".repeat(48)}`);

    if (!swapId) {
      ui.warn(`No swap id for ${cfg.label} (${cfg.swapIdEnv}). Run "npm run swap" first.`);
      failures += 1;
      continue;
    }

    try {
      const chain = await connectChain(name);
      const result = await protocol.claimSide({ chain, swapId, preimage, confirmations });
      ui.ok(`claimed as ${result.role}: tx ${result.summary.hash}`);
      ui.line("block", `${result.summary.blockNumber} (${confirmations} confirmation(s))`);
      ui.line("explorer", result.summary.explorerUrl);
      ui.line("preimage", result.preimageFromEvent ? "published in the Claimed event" : "used from .env");
      claimed += 1;
    } catch (error) {
      if (error.code === "INVALID_ACTION") {
        ui.warn(error.message);
        refused += 1;
      } else {
        ui.warn(`claim failed: ${error.message}`);
        failures += 1;
      }
    }
  }

  ui.heading("Result");
  if (failures > 0) ui.warn(`${failures} chain(s) could not be processed.`);
  else if (claimed > 0) ui.ok(`${claimed} leg(s) claimed.`);
  else if (refused > 0) ui.info("No claim was sent: a claim is not the valid action for these swaps right now.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
