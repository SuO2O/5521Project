// B1: deploy ERC20HTLC to Ethereum Sepolia and store its address in .env.
//
//   node scripts/deployERC20HTLC.js [--account bob] [--confirmations 2] [--no-save-env]
const { parseArgs } = require("node:util");

const { confirmations: configuredConfirmations, maskUrl, envValue } = require("./lib/config");
const { deployHtlc } = require("./lib/deploy");
const ui = require("./lib/ui");

async function main() {
  const { values } = parseArgs({
    options: {
      account: { type: "string", default: "alice" },
      confirmations: { type: "string" },
      "no-save-env": { type: "boolean", default: false },
    },
  });

  const confirmations = Number(values.confirmations ?? configuredConfirmations());
  ui.heading("Deploy ERC20HTLC (MST escrow) to Ethereum Sepolia");

  const result = await deployHtlc("sepolia", {
    account: values.account,
    confirmations,
    saveEnv: !values["no-save-env"],
  });

  ui.line("network", `${result.cfg.label} (chain ${result.cfg.chainId})`);
  ui.line("rpc", maskUrl(envValue(result.cfg.rpcEnv)));
  ui.line("deployer", `${result.deployerRole} (${result.deployerAddress})`);
  ui.line("address", result.address);
  ui.line("tx", result.txHash);
  ui.line("block", `${result.blockNumber} (${confirmations} confirmation(s))`);
  ui.line("explorer", result.cfg.explorer + "/tx/" + result.txHash);
  console.log("");
  console.log(`  ${result.cfg.htlcEnv}=${result.address}`);
  if (result.applied.length > 0) {
    ui.ok(`.env updated: ${result.applied.join(", ")}`);
  } else {
    ui.warn("Add the line above to .env yourself (run without --no-save-env to do it automatically).");
  }
  ui.info("Next: deploy the ETH escrow with scripts/deployETHHTLC.js.");
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
