// Transaction submission with confirmation waiting, gas reporting and log parsing.
const { shortHex } = require("./config");

function explainError(error, prefix) {
  const reason =
    error?.shortMessage ||
    error?.reason ||
    error?.info?.error?.message ||
    error?.message ||
    String(error);
  return `${prefix}: ${reason}`;
}

/**
 * Sends a transaction, waits for `confirmations` blocks and returns both the
 * ethers transaction, the receipt, and a print-friendly summary.
 *
 * Task B requires every step to wait for confirmation and expose the hash, so
 * nothing else in the scripts calls `.wait()` directly.
 */
async function sendTransaction(txPromise, { chain, label, confirmations = 1 }) {
  let tx;
  try {
    tx = await txPromise;
  } catch (error) {
    throw new Error(explainError(error, `${chain.label}: ${label} could not be sent`));
  }

  let receipt;
  try {
    receipt = await tx.wait(confirmations);
  } catch (error) {
    throw new Error(explainError(error, `${chain.label}: ${label} failed (tx ${tx.hash})`));
  }
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${chain.label}: ${label} did not succeed (tx ${tx.hash}).`);
  }

  const block = await chain.provider.getBlock(receipt.blockNumber);
  return {
    transaction: tx,
    receipt,
    summary: {
      label,
      chain: chain.name,
      chainLabel: chain.label,
      hash: tx.hash,
      blockNumber: receipt.blockNumber,
      blockTimestamp: block?.timestamp ?? null,
      gasUsed: receipt.gasUsed?.toString() ?? null,
      confirmations,
      explorerUrl: chain.transactionUrl(tx.hash),
    },
  };
}

/** Parses the first event called `eventName` out of a receipt, or null. */
function findEvent(chain, receipt, eventName) {
  const iface = chain.htlc.interface;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === eventName) return parsed;
    } catch {
      // Log from another contract; ignore.
    }
  }
  return null;
}

function formatStep(step) {
  const gas = step.gasUsed ? `gas ${step.gasUsed}` : "gas n/a";
  return `${step.label} (${step.chain}) tx ${shortHex(step.hash, 10, 6)} block ${step.blockNumber} ${gas}`;
}

module.exports = { explainError, findEvent, formatStep, sendTransaction };
