// B4: coordinate the timeout-recovery path.
//
//   npm run refund
//   npm run refund -- --chain sepolia
//   npm run refund -- --wait --wait-timeout 600
//
// For each chain the script reads the swap, checks that the timelock has
// expired and that the configured signer is the original sender, and only then
// sends the refund. Anything else is reported with the reason instead of being
// attempted — no claim or refund is offered that the current state forbids.
const { parseArgs } = require("node:util");

const { chainConfig, confirmations: configuredConfirmations, swapParamsFromEnv } = require("./lib/config");
const { connectChain } = require("./lib/chain");
const protocol = require("./lib/protocol");
const ui = require("./lib/ui");

const POLL_INTERVAL_SECONDS = 10;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedChainNames(value) {
  const text = String(value || "both").toLowerCase();
  if (text === "both") return ["sepolia", "arbitrum"];
  return [chainConfig(text).name];
}

/** Polls until the swap is refundable, a terminal state is reached, or time runs out. */
async function waitForRefundable(chain, swapId, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let observation = await protocol.observe(chain, swapId);

  while (!observation.labels.refundable) {
    if (!observation.labels.active) return observation;
    if (Date.now() >= deadline) {
      throw new Error(
        `${chain.label}: gave up after ${timeoutSeconds}s; the timelock unlocks at ${ui.formatTimestamp(observation.swap.timelock)}.`
      );
    }
    const remaining = Math.max(1, observation.labels.secondsToExpiry);
    ui.info(`${chain.label}: ${ui.formatDuration(remaining)} left before the timelock; polling every ${POLL_INTERVAL_SECONDS}s.`);
    await sleep(Math.min(POLL_INTERVAL_SECONDS, remaining + 1) * 1000);
    observation = await protocol.observe(chain, swapId);
  }
  return observation;
}

async function main() {
  const { values } = parseArgs({
    options: {
      chain: { type: "string", default: "both" },
      "erc20-swap-id": { type: "string" },
      "eth-swap-id": { type: "string" },
      confirmations: { type: "string" },
      wait: { type: "boolean", default: false },
      "wait-timeout": { type: "string", default: "900" },
    },
  });

  const params = swapParamsFromEnv();
  const swapIds = {
    sepolia: values["erc20-swap-id"] ?? params.erc20SwapId,
    arbitrum: values["eth-swap-id"] ?? params.ethSwapId,
  };
  const confirmations = Number(values.confirmations ?? configuredConfirmations());
  const waitTimeout = Number(values["wait-timeout"]);

  ui.heading("Refund expired locks (Task B4)");

  let failures = 0;
  let refunded = 0;

  for (const name of selectedChainNames(values.chain)) {
    const cfg = chainConfig(name);
    const swapId = swapIds[name];
    console.log("");
    console.log(`  ${cfg.label}`);
    console.log(`  ${"-".repeat(48)}`);

    if (!swapId) {
      ui.warn(`No swap id for ${cfg.label} (${cfg.swapIdEnv}). Nothing to recover.`);
      failures += 1;
      continue;
    }

    try {
      const chain = await connectChain(name);
      if (values.wait) await waitForRefundable(chain, swapId, waitTimeout);

      const result = await protocol.refundSide({ chain, swapId, confirmations });
      ui.ok(`refunded as ${result.role}: tx ${result.summary.hash}`);
      ui.line("block", `${result.summary.blockNumber} (${confirmations} confirmation(s))`);
      ui.line("explorer", result.summary.explorerUrl);
      refunded += 1;
    } catch (error) {
      if (error.code === "INVALID_ACTION") {
        ui.warn(error.message);
      } else {
        ui.warn(`refund failed: ${error.message}`);
        failures += 1;
      }
    }
  }

  ui.heading("Result");
  if (refunded > 0) ui.ok(`${refunded} leg(s) refunded; use "npm run status" to confirm both sides.`);
  else ui.info("No leg was refundable. Nothing was sent.");
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
