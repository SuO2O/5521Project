// B1: verifies the two-chain configuration without sending any transaction.
//
//   node scripts/checkConfig.js [--json]
//
// Checks the RPC endpoints, chain ids, deployed addresses, participants,
// balances, the shared hashlock and the timelock settings. Exits non-zero if
// anything is missing, so it can be run right before a demo.
const { parseArgs } = require("node:util");
const { ethers } = require("ethers");

const {
  ACCOUNTS,
  allChains,
  amountConfig,
  confirmations,
  envValue,
  maskUrl,
  shortHex,
  swapParamsFromEnv,
  timelockMarginSeconds,
  timelockSeconds,
} = require("./lib/config");
const { openProvider } = require("./lib/chain");
const { hashlockFor } = require("./lib/protocol");
const ui = require("./lib/ui");

async function checkChain(cfg, report) {
  const entry = { chain: cfg.name, label: cfg.label, expectedChainId: cfg.chainId, ok: true };

  let context;
  try {
    context = await openProvider(cfg.name);
  } catch (error) {
    entry.ok = false;
    entry.error = error.message;
    report.problems.push(error.message);
    report.chains.push(entry);
    return;
  }

  const { provider, addresses } = context;
  const network = await provider.getNetwork();
  entry.chainId = Number(network.chainId);
  entry.rpc = maskUrl(envValue(cfg.rpcEnv));
  entry.chainIdOk = entry.chainId === cfg.chainId;
  if (!entry.chainIdOk) {
    entry.ok = false;
    report.problems.push(`${cfg.label}: chain id ${entry.chainId} does not match ${cfg.chainId}.`);
  }

  const htlcAddress = envValue(cfg.htlcEnv);
  entry.htlcAddress = htlcAddress ?? null;
  if (!htlcAddress) {
    entry.ok = false;
    report.problems.push(`${cfg.label}: ${cfg.htlcEnv} is empty. Deploy with "npm run deploy:${cfg.name}".`);
  } else {
    const code = await provider.getCode(htlcAddress);
    entry.htlcDeployed = code !== "0x";
    if (!entry.htlcDeployed) {
      entry.ok = false;
      report.problems.push(`${cfg.label}: no contract at ${htlcAddress} (${cfg.htlcEnv}).`);
    }
  }

  entry.accounts = {};
  for (const [role, meta] of Object.entries(ACCOUNTS)) {
    const address = addresses[role];
    if (!address) {
      entry.ok = false;
      report.problems.push(`${cfg.label}: ${meta.keyEnv} is missing from .env.`);
      continue;
    }
    entry.accounts[role] = { address, eth: await provider.getBalance(address) };
  }

  if (cfg.asset === "erc20") {
    const mstAddress = envValue("MST_ADDRESS");
    entry.mstAddress = mstAddress ?? null;
    if (!mstAddress) {
      entry.ok = false;
      report.problems.push(`${cfg.label}: MST_ADDRESS is empty; the MST leg has no token.`);
    } else {
      const code = await provider.getCode(mstAddress);
      entry.mstDeployed = code !== "0x";
      if (!entry.mstDeployed) {
        entry.ok = false;
        report.problems.push(`${cfg.label}: no token contract at ${mstAddress} (MST_ADDRESS).`);
      } else {
        const token = new ethers.Contract(mstAddress, [
          "function decimals() view returns (uint8)",
          "function balanceOf(address) view returns (uint256)",
        ], provider);
        entry.mstDecimals = Number(await token.decimals());
        for (const role of ["alice", "bob"]) {
          if (!entry.accounts[role]) continue;
          entry.accounts[role].mst = await token.balanceOf(entry.accounts[role].address);
        }
      }
    }
  }

  report.chains.push(entry);
}
async function main() {
  const { values } = parseArgs({ options: { json: { type: "boolean", default: false } } });

  const report = { chains: [], problems: [], warnings: [], settings: {} };

  for (const cfg of allChains()) {
    await checkChain(cfg, report);
  }

  const params = swapParamsFromEnv();
  report.settings = {
    timelockSeconds: timelockSeconds(),
    timelockMarginSeconds: timelockMarginSeconds(),
    confirmations: confirmations(),
    amounts: amountConfig(),
  };

  if (params.preimage && params.hashlock) {
    const derived = hashlockFor(params.preimage);
    report.settings.hashlockMatches = derived.toLowerCase() === params.hashlock.toLowerCase();
    if (!report.settings.hashlockMatches) {
      report.problems.push("SWAP_PREIMAGE does not hash to SWAP_HASHLOCK. Run \"npm run params\" and update both.");
    }
  } else if (!params.preimage && !params.hashlock) {
    report.warnings.push("SWAP_PREIMAGE / SWAP_HASHLOCK are empty; scripts/swap.js will generate them.");
  }

  if (values.json) {
    console.log(JSON.stringify(report, (key, value) => (typeof value === "bigint" ? value.toString() : value), 2));
  } else {
    ui.heading("Configuration check (Task B1)");
    for (const entry of report.chains) {
      ui.line("network", `${entry.label} (chain ${entry.expectedChainId})`);
      if (entry.error) {
        ui.line("rpc", entry.error);
        continue;
      }
      ui.line("rpc", entry.rpc);
      ui.line("chain id", `${entry.chainId} ${entry.chainIdOk ? "matches" : "MISMATCH"}`);
      ui.line("htlc", entry.htlcAddress ? `${entry.htlcAddress} ${entry.htlcDeployed ? "(code found)" : "(NO CODE)"}` : "(unset)");
      if (entry.mstAddress !== undefined) {
        ui.line("mst", entry.mstAddress ? `${entry.mstAddress} ${entry.mstDeployed ? "(code found)" : "(NO CODE)"}` : "(unset)");
      }
      for (const [role, account] of Object.entries(entry.accounts)) {
        const mst = account.mst !== undefined ? `  MST ${ethers.formatUnits(account.mst, entry.mstDecimals)}` : "";
        ui.line(role, `${account.address}  ETH ${ethers.formatEther(account.eth)}${mst}`);
      }
      console.log("");
    }

    ui.heading("Settings");
    ui.line("amounts", `${report.settings.amounts.mst} MST  /  ${report.settings.amounts.eth} ETH`);
    ui.line("mst lock", `now + ${report.settings.timelockSeconds}s + ${report.settings.timelockMarginSeconds}s margin`);
    ui.line("eth lock", `now + ${report.settings.timelockSeconds}s`);
    ui.line("confirmations", report.settings.confirmations);
    if (report.settings.hashlockMatches !== undefined) {
      ui.line("swap params", report.settings.hashlockMatches ? "preimage matches hashlock" : "MISMATCH");
    }

    for (const problem of report.problems) ui.warn(problem);
    for (const warning of report.warnings) ui.info(warning);

    if (report.problems.length === 0) {
      ui.heading("Result");
      ui.ok("Configuration looks complete. Next: npm run swap");
    }
  }

  if (report.problems.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
