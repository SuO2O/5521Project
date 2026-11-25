// B3: observe both chains independently and report the state of both swaps.
//
//   npm run status
//   npm run status -- --json
//   npm run status -- --chain sepolia --erc20-swap-id 0x...
//
// Each side is one ordinary RPC read of that chain's own contract. The two
// contracts never call each other; nothing in this script assumes otherwise.
const { parseArgs } = require("node:util");
const { ethers } = require("ethers");

const { chainConfig, shortHex, swapParamsFromEnv } = require("./lib/config");
const { connectChain } = require("./lib/chain");
const protocol = require("./lib/protocol");
const ui = require("./lib/ui");

const DEFAULT_CHAINS = ["sepolia", "arbitrum"];

function selectedChainNames(value) {
  const text = String(value || "both").toLowerCase();
  if (text === "both") return DEFAULT_CHAINS;
  return [chainConfig(text).name];
}

function amountLabel(chainName, observation) {
  const amount = observation.swap.amount;
  if (observation.swap.token === ethers.ZeroAddress) return `${ethers.formatEther(amount)} ETH`;
  return `${ethers.formatUnits(amount, observation.balances?.decimals ?? 18)} MST`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      chain: { type: "string", default: "both" },
      "erc20-swap-id": { type: "string" },
      "eth-swap-id": { type: "string" },
      json: { type: "boolean", default: false },
      "no-balances": { type: "boolean", default: false },
    },
  });

  const params = swapParamsFromEnv();
  const swapIds = {
    sepolia: values["erc20-swap-id"] ?? params.erc20SwapId,
    arbitrum: values["eth-swap-id"] ?? params.ethSwapId,
  };

  const chains = {};
  const observations = {};
  const problems = [];

  for (const name of selectedChainNames(values.chain)) {
    const cfg = chainConfig(name);
    const swapId = swapIds[name];
    if (!swapId) {
      problems.push(
        `${cfg.label}: no swap id configured (${cfg.swapIdEnv}). Run "npm run swap" or pass --${
          name === "sepolia" ? "erc20" : "eth"
        }-swap-id.`
      );
      continue;
    }
    try {
      const chain = await connectChain(name);
      chains[name] = chain;
      observations[name] = await protocol.observe(chain, swapId, { includeBalances: !values["no-balances"] });
    } catch (error) {
      problems.push(`${cfg.label}: ${error.message}`);
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    observations,
    crossChecks: [],
    problems,
  };

  if (observations.sepolia && observations.arbitrum) {
    report.crossChecks = protocol.compareObservations(observations.sepolia, observations.arbitrum);
  }

  if (values.json) {
    console.log(JSON.stringify(report, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } else {
    ui.heading("Cross-chain state (Task B3)");
    ui.info("Each section below is one independent RPC read of that chain.");

    for (const name of Object.keys(observations)) {
      const observation = observations[name];
      const chain = chains[name];
      const cfg = chainConfig(name);
      const labels = observation.labels;

      console.log("");
      console.log(`  ${cfg.label} (chain ${observation.chainId})`);
      console.log(`  ${"-".repeat(48)}`);
      ui.line("contract", `${observation.htlcAddress} (${cfg.contract})`);
      ui.line("observed", `block ${observation.blockNumber} at ${ui.formatTimestamp(observation.blockTimestamp)}`);
      ui.line("swap id", observation.swapId);
      ui.line("state", observation.swap.state);
      ui.line("window", ui.formatWindow(labels));
      ui.line("hashlock", observation.swap.hashlock);
      ui.line("amount", amountLabel(name, observation));
      ui.line("sender", `${observation.swap.sender} ${labels.exists && chain.roleOf(observation.swap.sender) ? `(${chain.roleOf(observation.swap.sender)})` : ""}`);
      ui.line("recipient", `${observation.swap.recipient} ${labels.exists && chain.roleOf(observation.swap.recipient) ? `(${chain.roleOf(observation.swap.recipient)})` : ""}`);
      ui.line("timelock", `${ui.formatTimestamp(observation.swap.timelock)} (${observation.swap.timelock})`);

      const actions = protocol.validActions(chain, observation);
      for (const entry of actions) {
        ui.line("action", `${entry.action}: ${entry.description}`);
      }

      if (observation.balances) {
        const decimals = observation.balances.decimals;
        for (const role of ["alice", "bob"]) {
          const account = observation.balances.accounts[role];
          const mst = account.mst === null ? "" : `  MST ${ethers.formatUnits(account.mst, decimals)}`;
          console.log(`  ${" ".repeat(11)} ${role.padEnd(6)} ETH ${ethers.formatEther(account.eth)}${mst}`);
        }
        if (observation.balances.mstError) ui.warn(`MST balances unavailable: ${observation.balances.mstError}`);
      }
    }

    if (report.crossChecks.length > 0) {
      ui.heading("Cross-chain consistency (computed off-chain from the two reads)");
      for (const check of report.crossChecks) {
        if (check.ok) ui.ok(check.check);
        else ui.warn(`not consistent: ${check.check}`);
      }
      ui.info("The contracts cannot see each other; this comparison is done by the coordinator.");
    }

    for (const problem of problems) ui.warn(problem);
    if (problems.length > 0) ui.info("Fix the configuration or pass the swap ids explicitly.");
  }

  if (problems.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
