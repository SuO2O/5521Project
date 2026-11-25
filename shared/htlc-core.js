// Protocol rules shared by the Task B scripts and the Task C browser UI.
//
// Loaded as a plain <script> in the browser (it defines window.HtlcCore) and
// with require() in Node. ethers is injected, so this file has no imports of
// its own and cannot drift between the CLI and the UI.
(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else {
    root.HtlcCore = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const STATE_NAMES = ["None", "Active", "Claimed", "Refunded"];

  /** "3h 12m 5s" / "48s" — used by scripts and by the UI countdown. */
  function formatDuration(seconds) {
    const abs = Math.abs(Math.round(seconds));
    const hours = Math.floor(abs / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    const secs = abs % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (hours === 0 && (minutes === 0 || secs > 0)) parts.push(`${secs}s`);
    return parts.join(" ");
  }

  /** Unix seconds -> "2026-11-25T13:07:24Z" (UTC, no milliseconds). */
  function formatTimestamp(unixSeconds) {
    return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
  }

  function create(ethers) {
    if (!ethers) throw new Error("HtlcCore.create(ethers) requires an ethers instance");

    function randomBytes32() {
      return ethers.hexlify(ethers.randomBytes(32));
    }

    function isValidBytes32(value) {
      return /^0x[0-9a-fA-F]{64}$/.test(String(value));
    }

    /** Must match HTLCBase.claim: keccak256(abi.encodePacked(preimage)). */
    function hashlockFor(preimage) {
      if (!isValidBytes32(preimage)) {
        throw new Error(`The preimage must be 32 bytes of hex (0x + 64 characters), got "${preimage}".`);
      }
      return ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
    }

    /** ethers Result from getSwap -> plain object with a named state. */
    function decodeSwap(raw) {
      const stateCode = Number(raw.state);
      return {
        sender: raw.sender,
        recipient: raw.recipient,
        token: raw.token,
        amount: raw.amount,
        hashlock: raw.hashlock,
        timelock: Number(raw.timelock),
        state: STATE_NAMES[stateCode] || `Unknown(${stateCode})`,
        stateCode,
      };
    }

    /** Labels a swap using the observing chain's own block timestamp. */
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

    return {
      STATE_NAMES,
      classify,
      decodeSwap,
      equalBytes32,
      formatDuration,
      formatTimestamp,
      hashlockFor,
      isSameAddress,
      isValidBytes32,
      randomBytes32,
    };
  }

  return { create, formatDuration, formatTimestamp, STATE_NAMES };
});
