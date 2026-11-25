// Find leftover locks in the escrows and refund the expired ones.
//
//   npm run recover                  # report only (both chains)
//   npm run recover -- --execute     # refund every expired lock to its sender
//   npm run recover -- --chain sepolia --execute
//   npm run recover -- --from-block 12200000 --chunk 2000
//
// A lock can never be cancelled: claim (preimage) and refund (after expiry, by
// the sender) are the only exits. This command performs the refund side.
const { parseArgs } = require("node:util");
const { ethers } = require("ethers");

const { confirmations: configuredConfirmations, shortHex } = require("./lib/config");
const { connectChain } = require("./lib/chain");
const { recoverLocks } = require("./lib/recover");
const ui = require("./lib/ui");

function selectedChains(value) {
  const text = String(value || "both").toLowerCase();
  if (text === "both") return ["sepolia", "arbitrum"];
  return [text];
}

async function escrowBalance(chain) {
  const eth = await chain.provider.getBalance(chain.htlcAddress);
  let mst = null;
  if (chain.asset === "erc20" && chain.mst) {
    const token = new ethers.Contract(chain.mstAddress, [
      "function balanceOf(address) view returns (uint256)",
    ], chain.provider);
    mst = await token.balanceOf(chain.htlcAddress);
  }
  return { eth, mst };
}

async function main() {
  const { values } = parseArgs({
    options: {
      chain: { type: "string", default: "both" },
      execute: { type: "boolean", default: false },
      "from-block": { type: "string" },
      chunk: { type: "string" },
      confirmations: { type: "string" },
    },
  });

  const confirmations = Number(values.confirmations ?? configuredConfirmations());
  const fromBlock = values["from-block"] ? Number(values["from-block"]) : undefined;
  const chunkSize = values.chunk ? Number(values.chunk) : undefined;

  ui.heading(values.execute ? "Refund leftover locks" : "Scan for leftover locks");
  ui.info(values.execute ? "Expired locks will be refunded to their sender." : "Report only. Add --execute to refund expired locks.");

  let failures = 0;
  let refunded = 0;

  for (const name of selectedChains(values.chain)) {
    console.log("");
    console.log(`  ${name}`);
    console.log(`  ${"-".repeat(60)}`);

    let chain;
    try {
      chain = await connectChain(name);
    } catch (error) {
      ui.warn(error.message);
      failures += 1;
      continue;
    }

    const before = await escrowBalance(chain);
    let report;
    try {
      report = await recoverLocks(chain, { execute: values.execute, confirmations, fromBlock, chunkSize });
    } catch (error) {
      ui.warn(error.message);
      failures += 1;
      continue;
    }

    ui.line("scanned", `blocks ${report.startBlock}…${report.latestBlock} (chunk ${report.chunkSize})`);
    ui.line("locks", `${report.results.length} found`);

    if (report.results.length === 0) {
      ui.info("No locks found in this range.");
    } else {
      ui.table(
        ["swap id", "sender", "amount", "state", "expires", "action"],
        report.results.map((entry) => [
          shortHex(entry.swapId),
          chain.roleOf(entry.swap.sender) || shortHex(entry.swap.sender),
          chain.asset === "erc20"
            ? `${ethers.formatUnits(entry.swap.amount, 18)} MST`
            : `${ethers.formatEther(entry.swap.amount)} ETH`,
          entry.swap.state,
          new Date(entry.swap.timelock * 1000).toISOString().replace(".000Z", "Z"),
          entry.action,
        ]),
        "  "
      );
      for (const entry of report.results) {
        if (entry.refund) {
          ui.ok(`refunded ${shortHex(entry.swapId)} as ${entry.refund.role}: ${entry.refund.summary.hash}`);
          refunded += 1;
        }
      }
    }

    const after = await escrowBalance(chain);
    const describe = (balance) => (chain.asset === "erc20"
      ? `${ethers.formatEther(balance.eth)} ETH + ${ethers.formatUnits(balance.mst, 18)} MST`
      : `${ethers.formatEther(balance.eth)} ETH`);
    ui.line("escrow", `${describe(before)} -> ${describe(after)}`);
  }

  ui.heading("Result");
  if (refunded > 0) ui.ok(`${refunded} lock(s) refunded.`);
  else if (failures === 0) ui.info(values.execute ? "Nothing was refundable." : "Nothing to do. Run with --execute to refund the expired locks listed above.");
  if (failures > 0) {
    ui.warn(`${failures} chain(s) could not be processed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\n[FAIL] ${error.message}`);
  process.exitCode = 1;
});


