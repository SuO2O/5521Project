// Scan a chain for locks created by one escrow and, optionally, refund the ones
// whose timelock has expired.
//
// A lock is never "cancelled": the only exits are claim (needs the preimage) and
// refund (needs expiry + the original sender). This helper finds the leftovers —
// from abandoned demo runs, for example — and returns them or refunds them.
const { ethers } = require("ethers");

const { classify, decodeSwap } = require("./swapState");
const { refundSide } = require("./protocol");

const LOCKED_TOPIC = ethers.id("Locked(bytes32,address,address,address,uint256,bytes32,uint256)");

/** getLogs with splitting and retries: free-tier providers cap ranges and rate. */
async function fetchLogs(provider, filter, from, to, size, attempt = 0) {
  try {
    return await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
  } catch (error) {
    if (size > 1000) {
      const mid = Math.floor((from + to) / 2);
      const left = await fetchLogs(provider, filter, from, mid, Math.floor(size / 2));
      const right = await fetchLogs(provider, filter, mid + 1, to, to - mid);
      return [...left, ...right];
    }
    if (attempt < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
      return fetchLogs(provider, filter, from, to, size, attempt + 1);
    }
    throw error;
  }
}
/** First block at which `address` has code (binary search). */
async function findDeploymentBlock(provider, address, latest) {
  let low = 0;
  let high = latest;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const code = await provider.getCode(address, mid);
    if (code && code !== "0x") high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * Every Locked event emitted by the escrow, with the current swap state.
 * Scans in chunks to stay inside provider log limits.
 */
async function scanLocks(chain, { fromBlock, chunkSize } = {}) {
  const provider = chain.provider;
  const latest = await provider.getBlockNumber();
  const latestBlock = await provider.getBlock(latest);
  const now = latestBlock.timestamp;
  const startBlock = fromBlock ?? (await findDeploymentBlock(provider, chain.htlcAddress, latest));
  const size = chunkSize ?? (chain.name === "arbitrum" ? 50000 : 5000);
  const iface = chain.htlc.interface;
  const seen = new Map();

  for (let from = startBlock; from <= latest; from += size) {
    const to = Math.min(latest, from + size - 1);
    const logs = await fetchLogs(
      provider,
      { address: chain.htlcAddress, topics: [LOCKED_TOPIC] },
      from,
      to,
      size
    );
    for (const entry of logs) {
      let parsed;
      try {
        parsed = iface.parseLog(entry);
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== "Locked") continue;
      const swapId = parsed.args.swapId;
      if (seen.has(swapId)) continue;

      const swap = decodeSwap(await chain.htlc.getSwap(swapId));
      seen.set(swapId, {
        chain: chain.name,
        chainLabel: chain.label,
        swapId,
        swap,
        labels: classify(swap, now),
        blockNumber: entry.blockNumber,
      });
    }
  }

  return { startBlock, latestBlock: latest, chunkSize: size, locks: [...seen.values()] };
}

/**
 * Classify each lock and, when `execute` is set, refund every expired one to its
 * sender. Claimable locks are reported and left alone (a refund would revert).
 */
async function recoverLocks(chain, { execute = false, confirmations = 1, fromBlock, chunkSize } = {}) {
  const scan = await scanLocks(chain, { fromBlock, chunkSize });
  const results = [];

  for (const entry of scan.locks) {
    if (entry.swap.state === "None") continue;

    if (entry.labels.refundable) {
      if (!execute) {
        results.push({ ...entry, action: "refundable" });
        continue;
      }
      const refunded = await refundSide({ chain, swapId: entry.swapId, confirmations });
      results.push({ ...entry, action: "refunded", refund: refunded });
      continue;
    }

    if (entry.labels.claimable) {
      results.push({ ...entry, action: "claimable" });
      continue;
    }

    results.push({ ...entry, action: entry.swap.state.toLowerCase() });
  }

  return { ...scan, results };
}

module.exports = { LOCKED_TOPIC, findDeploymentBlock, recoverLocks, scanLocks };



