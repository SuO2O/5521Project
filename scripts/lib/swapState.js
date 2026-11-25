// Decoding and labelling of on-chain swap records.
//
// The contracts expose the raw enum; everything a user or script wants to know
// ("can I claim?", "is it expired?") is derived here from one chain's own block
// timestamp. No cross-chain information is used.

const STATE_NAMES = ["None", "Active", "Claimed", "Refunded"];

/** Converts the ethers Result returned by getSwap() into a plain object. */
function decodeSwap(raw) {
  const stateCode = Number(raw.state);
  return {
    sender: raw.sender,
    recipient: raw.recipient,
    token: raw.token,
    amount: raw.amount,
    hashlock: raw.hashlock,
    timelock: Number(raw.timelock),
    state: STATE_NAMES[stateCode] ?? `Unknown(${stateCode})`,
    stateCode,
  };
}

/**
 * Labels a swap using the observing chain's own clock.
 *
 * @param {object} swap decoded swap
 * @param {number} now block timestamp of the chain that was read
 */
function classify(swap, now) {
  const exists = swap.state !== "None";
  const active = swap.state === "Active";
  const expired = active && now >= swap.timelock;
  return {
    exists,
    active,
    claimed: swap.state === "Claimed",
    refunded: swap.state === "Refunded",
    expired,
    claimable: active && now < swap.timelock,
    refundable: expired,
    secondsToExpiry: swap.timelock - now,
  };
}

function isSameAddress(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

function equalBytes32(left, right) {
  return String(left).toLowerCase() === String(right).toLowerCase();
}

module.exports = { STATE_NAMES, classify, decodeSwap, equalBytes32, isSameAddress };
