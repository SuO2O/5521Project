// B2: the full cross-chain swap in one reproducible command.
//
//   npm run swap
//   npm run swap -- --timelock 180 --mst-amount 100 --eth-amount 0.001
//
// Steps: generate preimage/hashlock -> approve + lock MST on Sepolia -> verify
// the recorded lock -> lock ETH on Arbitrum Sepolia -> verify -> claim ETH
// (which publishes the preimage) -> claim MST with the preimage read back from
// the ETH claim. Every transaction waits for a confirmation and is reported with
// its hash and explorer link.
const { parseArgs } = require("node:util");
const { ethers } = require("ethers");

const {
  amountConfig,
  confirmations: configuredConfirmations,
  shortHex,
  timelockMarginSeconds,
  timelockSeconds,
} = require("./lib/config");
const { connectChain } = require("./lib/chain");
const protocol = require("./lib/protocol");
const { updateEnvFile } = require("./lib/envFile");
const ui = require("./lib/ui");

async function main() {
  const { values } = parseArgs({
    options: {
      "mst-amount": { type: "string" },
      "eth-amount": { type: "string" },
      timelock: { type: "string" },
      margin: { type: "string" },
      preimage: { type: "string" },
      confirmations: { type: "string" },
      "stop-after-lock": { type: "boolean", default: false },
      "no-save-env": { type: "boolean", default: false },
    },
  });

  const amounts = amountConfig();
  const mstAmountHuman = values["mst-amount"] ?? amounts.mst;
  const ethAmountHuman = values["eth-amount"] ?? amounts.eth;
  const timelock = Number(values.timelock ?? timelockSeconds());
  const margin = Number(values.margin ?? timelockMarginSeconds());
  const confirmations = Number(values.confirmations ?? configuredConfirmations());

  ui.heading("Cross-chain HTLC swap (Task B2)");
  ui.info("Connecting to both chains; each is read independently...");

  const mstChain = await connectChain("sepolia", { needMst: true });
  const ethChain = await connectChain("arbitrum");
  ui.line("mst leg", `${mstChain.label} (chain ${mstChain.chainId}) htlc ${shortHex(mstChain.htlcAddress)}`);
  ui.line("eth leg", `${ethChain.label} (chain ${ethChain.chainId}) htlc ${shortHex(ethChain.htlcAddress)}`);
  ui.line("roles", "alice locks MST and receives ETH; bob locks ETH and receives MST");
  ui.line("amounts", `${mstAmountHuman} MST  <->  ${ethAmountHuman} ETH`);

  let result;
  try {
    result = await protocol.executeSwap({
      mstChain,
      ethChain,
      mstAmountHuman,
      ethAmountHuman,
      timelockSeconds: timelock,
      marginSeconds: margin,
      preimage: values.preimage ?? null,
      confirmations,
      stopAfterLock: values["stop-after-lock"],
      onStep: (step) => {
        ui.ok(`${step.label} [${step.chain}] tx ${step.hash}`);
        console.log(`       block ${step.blockNumber}  gas ${step.gasUsed ?? "n/a"}  ${step.explorerUrl}`);
      },
    });
  } catch (error) {
    console.error(`\n[FAIL] ${error.message}`);
    ui.info('Inspect both chains with: npm run status');
    ui.info('Recover expired locks with: npm run refund');
    process.exitCode = 1;
    return;
  }

  printReport(result);

  if (!values["no-save-env"]) {
    const applied = updateEnvFile({
      SWAP_PREIMAGE: result.preimage,
      SWAP_HASHLOCK: result.hashlock,
      ERC20_SWAP_ID: result.mst.swapId,
      ETH_SWAP_ID: result.eth.swapId,
    });
    ui.ok(`.env updated: ${applied.join(", ")}`);
  }
}

function printReport(result) {
  const bothClaimed = result.final.mst.swap.state === "Claimed" && result.final.eth.swap.state === "Claimed";

  ui.heading("Swap parameters");
  ui.line("hashlock", result.hashlock);
  ui.line("preimage", bothClaimed ? `${result.preimage} (now public on-chain)` : "not printed; stored in .env");
  ui.table(
    ["leg", "swap id", "amount", "sender -> recipient", "expires"],
    [
      ["MST", shortHex(result.mst.swapId), result.mst.amountLabel, `${result.mst.sender} -> ${result.mst.recipient}`, result.mst.timelockIso],
      ["ETH", shortHex(result.eth.swapId), result.eth.amountLabel, `${result.eth.sender} -> ${result.eth.recipient}`, result.eth.timelockIso],
    ],
    "  "
  );

  ui.heading("Transactions (all confirmed)");
  ui.table(
    ["#", "chain", "action", "block", "tx hash"],
    result.steps.map((step, index) => [index + 1, step.chain, step.label, step.blockNumber, shortHex(step.hash, 14, 8)]),
    "  "
  );
  for (const step of result.steps) {
    console.log(`  ${step.label.padEnd(12)} ${step.chain.padEnd(9)} ${step.explorerUrl}`);
  }

  ui.heading("Lock verification (read back from each chain)");
  const summarize = (verification) => {
    const passed = verification.checks.filter((check) => check.ok).length;
    return `${passed}/${verification.checks.length} fields match (${verification.checks.map((check) => check.field).join(", ")})`;
  };
  ui.ok(`MST lock ${shortHex(result.mst.swapId)}: ${summarize(result.verification.mst)}`);
  ui.ok(`ETH lock ${shortHex(result.eth.swapId)}: ${summarize(result.verification.eth)}`);

  ui.heading("Final status (one independent read per chain)");
  for (const side of ["mst", "eth"]) {
    const observation = result.final[side];
    ui.line(
      observation.chainLabel,
      `${observation.swap.state}; ${ui.formatWindow(observation.labels)} (block ${observation.blockNumber})`
    );
  }

  printBalances(result);

  ui.heading("Result");
  if (bothClaimed) {
    ui.ok("Swap completed: both legs are Claimed.");
    ui.ok("The ETH claim published the preimage on Arbitrum; the MST claim used that value on Sepolia.");
  } else if (result.final.mst.swap.state === "Active") {
    ui.warn("Locks are active and nothing was claimed yet (--stop-after-lock).");
    ui.info("Next: npm run status  ->  npm run claim (before expiry) or npm run refund (after expiry).");
  }
}

function printBalances(result) {
  const sepoliaFinal = result.final.mst.balances;
  const arbitrumFinal = result.final.eth.balances;
  const before = result.balancesBefore;
  const decimals = sepoliaFinal?.decimals ?? 18;

  const delta = (beforeValue, afterValue, format) => {
    const diff = afterValue - beforeValue;
    const sign = diff > 0n ? "+" : diff < 0n ? "-" : "";
    const absolute = diff < 0n ? -diff : diff;
    return `${format(beforeValue)} -> ${format(afterValue)} (${sign}${format(absolute)})`;
  };

  ui.heading("Balances");
  if (sepoliaFinal) {
    for (const role of ["alice", "bob"]) {
      const account = sepoliaFinal.accounts[role];
      const beforeMst = role === "alice" ? before.mstChain.aliceMst : before.mstChain.bobMst;
      const beforeEth = role === "alice" ? before.mstChain.aliceEth : before.mstChain.bobEth;
      console.log(`  ${role} on ${result.final.mst.chainLabel}`);
      console.log(`    MST  ${delta(beforeMst, account.mst, (value) => ethers.formatUnits(value, decimals))}`);
      console.log(`    ETH  ${delta(beforeEth, account.eth, ethers.formatEther)}`);
    }
  }
  if (arbitrumFinal) {
    for (const role of ["alice", "bob"]) {
      const account = arbitrumFinal.accounts[role];
      const beforeEth = role === "alice" ? before.ethChain.aliceEth : before.ethChain.bobEth;
      console.log(`  ${role} on ${result.final.eth.chainLabel}`);
      console.log(`    ETH  ${delta(beforeEth, account.eth, ethers.formatEther)}`);
    }
  }
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});
