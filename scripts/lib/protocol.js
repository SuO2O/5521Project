// The cross-chain HTLC protocol, independent of any CLI or console formatting.
//
// The two chains are only ever touched through their own chain handles
// (scripts/lib/chain.js). Nothing here makes a contract call to the other chain:
// coordination happens by reading public state and by passing the same preimage
// between two independent escrows.
const { ethers } = require("ethers");

const core = require("../../shared/htlc-core").create(ethers);
const { ROLES, shortHex } = require("./config");
const { classify, decodeSwap, equalBytes32, isSameAddress } = require("./swapState");
const { findEvent, sendTransaction } = require("./tx");
const { formatDuration, formatTimestamp } = require("./ui");

const MIN_GAS_WEI = ethers.parseEther("0.0002");

const { hashlockFor, isValidBytes32, randomBytes32 } = core;

/**
 * Raised when the requested action is not valid for the current on-chain state
 * (wrong role, already completed, not yet expired, ...). The CLIs report these
 * as "nothing to do" instead of as failures.
 */
class ProtocolRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ProtocolRefusal";
    this.code = "INVALID_ACTION";
  }
}

function refuse(message) {
  throw new ProtocolRefusal(message);
}

function newSwapId() {
  return randomBytes32();
}

async function readSwap(chain, swapId) {
  if (!isValidBytes32(swapId)) throw new Error(`Invalid swap id "${swapId}" (expected 32 bytes of hex).`);
  const raw = await chain.htlc.getSwap(swapId);
  return decodeSwap(raw);
}

/**
 * One independent observation of one swap on one chain.
 * Everything is derived from that chain's own block timestamp.
 */
async function observe(chain, swapId, { includeBalances = false } = {}) {
  const { number, timestamp } = await chain.latestBlock();
  const swap = await readSwap(chain, swapId);
  const observation = {
    chain: chain.name,
    chainLabel: chain.label,
    chainId: chain.chainId,
    blockNumber: number,
    blockTimestamp: timestamp,
    swapId,
    swap,
    labels: classify(swap, timestamp),
    htlcAddress: chain.htlcAddress,
    mstAddress: chain.mstAddress ?? null,
  };
  if (includeBalances) observation.balances = await readBalances(chain);
  return observation;
}

/** ETH balances for both accounts, plus MST balances on the ERC20 chain. */
async function readBalances(chain) {
  const roles = [ROLES.mstSender, ROLES.mstRecipient];
  const balances = { decimals: null, accounts: {} };
  for (const role of roles) {
    const address = chain.addressOf(role);
    balances.accounts[role] = { address, eth: await chain.ethBalance(address), mst: null };
  }
  if (chain.asset === "erc20" && chain.mst) {
    try {
      balances.decimals = await chain.mstDecimals();
      for (const role of roles) {
        balances.accounts[role].mst = await chain.mst.balanceOf(balances.accounts[role].address);
      }
    } catch (error) {
      // A broken token address must not hide the swap state in `status`.
      balances.mstError = error.shortMessage || error.message;
    }
  }
  return balances;
}

function formatEth(value) {
  return `${ethers.formatEther(value)} ETH`;
}

async function formatMst(chain, value) {
  return `${ethers.formatUnits(value, await chain.mstDecimals())} MST`;
}

/**
 * Reads a lock back and compares it with what was just sent. This is the
 * "verify its parameters" step: a mismatch aborts the protocol before the
 * counterparty commits any asset.
 */
async function verifyLock(chain, swapId, expected) {
  const swap = await readSwap(chain, swapId);
  const checks = [];
  const check = (field, ok, want, got) => checks.push({ field, ok, expected: String(want), actual: String(got) });
  check("state", swap.state === "Active", "Active", swap.state);
  check("sender", isSameAddress(swap.sender, expected.sender), expected.sender, swap.sender);
  check("recipient", isSameAddress(swap.recipient, expected.recipient), expected.recipient, swap.recipient);
  check("token", isSameAddress(swap.token, expected.token), expected.token, swap.token);
  check("amount", swap.amount === expected.amount, expected.amount, swap.amount);
  check("hashlock", equalBytes32(swap.hashlock, expected.hashlock), expected.hashlock, swap.hashlock);
  check("timelock", swap.timelock === expected.timelock, expected.timelock, swap.timelock);

  const failed = checks.filter((entry) => !entry.ok);
  if (failed.length > 0) {
    const detail = failed.map((entry) => `${entry.field}: expected ${entry.expected}, got ${entry.actual}`).join("; ");
    throw new Error(`${chain.label}: the stored lock ${shortHex(swapId)} does not match what was sent (${detail}).`);
  }
  return { swap, checks };
}

/** Approves the escrow for the MST amount when the current allowance is short. */
async function ensureMstApproval({ chain, role, amount, confirmations }) {
  const mst = await chain.requireMst();
  const owner = chain.addressOf(role);
  const allowance = await mst.allowance(owner, chain.htlcAddress);
  if (allowance >= amount) return { summary: null, allowance };
  const { summary } = await sendTransaction(
    chain.mstFor(role).approve(chain.htlcAddress, amount),
    { chain, label: "approve MST", confirmations }
  );
  return { summary, allowanceBefore: allowance };
}

/** Checks balances and gas before the first transaction is sent. */
async function preflight({ mstChain, ethChain, mstAmount, ethAmount }) {
  const mst = await mstChain.requireMst();
  const aliceMst = mstChain.addressOf(ROLES.mstSender);
  const bobMst = mstChain.addressOf(ROLES.mstRecipient);
  const aliceEthChain = ethChain.addressOf(ROLES.ethRecipient);
  const bobEthChain = ethChain.addressOf(ROLES.ethSender);

  const [mstBalance, bobMstBalance, allowance, mstAliceGas, mstBobGas, arbBobGas, arbAliceGas] =
    await Promise.all([
      mst.balanceOf(aliceMst),
      mst.balanceOf(bobMst),
      mst.allowance(aliceMst, mstChain.htlcAddress),
      mstChain.ethBalance(aliceMst),
      mstChain.ethBalance(bobMst),
      ethChain.ethBalance(bobEthChain),
      ethChain.ethBalance(aliceEthChain),
    ]);

  const issues = [];
  const warnings = [];

  if (mstBalance < mstAmount) {
    issues.push(
      `${ROLES.mstSender} has ${await formatMst(mstChain, mstBalance)} on ${mstChain.label}, but the MST leg needs ${await formatMst(mstChain, mstAmount)}.`
    );
  }
  if (mstAliceGas < MIN_GAS_WEI) {
    issues.push(`${ROLES.mstSender} needs ${mstChain.currency} on ${mstChain.label} for the approve/lock gas.`);
  }
  if (mstBobGas < MIN_GAS_WEI) {
    issues.push(`${ROLES.mstRecipient} needs ${mstChain.currency} on ${mstChain.label} for the MST claim gas.`);
  }
  if (arbBobGas < ethAmount + MIN_GAS_WEI) {
    issues.push(
      `${ROLES.ethSender} has ${formatEth(arbBobGas)} on ${ethChain.label}, but the ETH leg needs ${formatEth(ethAmount)} plus gas.`
    );
  }
  if (arbAliceGas < MIN_GAS_WEI) {
    issues.push(`${ROLES.ethRecipient} needs ${ethChain.currency} on ${ethChain.label} for the ETH claim gas.`);
  }
  if (mstAliceGas > 0n && mstAliceGas < MIN_GAS_WEI * 2n) {
    warnings.push(`${ROLES.mstSender} is low on ${mstChain.label} gas (${formatEth(mstAliceGas)}).`);
  }

  return {
    issues,
    warnings,
    allowance,
    balances: {
      mstChain: {
        chain: mstChain.name,
        aliceEth: mstAliceGas,
        bobEth: mstBobGas,
        aliceMst: mstBalance,
        bobMst: bobMstBalance,
      },
      ethChain: {
        chain: ethChain.name,
        aliceEth: arbAliceGas,
        bobEth: arbBobGas,
      },
    },
  };
}

function assertChainRoles(mstChain, ethChain) {
  if (mstChain.asset !== "erc20") {
    throw new Error(`${mstChain.label} is not the ERC20 escrow; the MST leg must run on Sepolia.`);
  }
  if (ethChain.asset !== "eth") {
    throw new Error(`${ethChain.label} is not the native-ETH escrow; the ETH leg must run on Arbitrum Sepolia.`);
  }
  if (mstChain.name === ethChain.name) {
    throw new Error("The two legs must run on different chains.");
  }
}

/**
 * B2: the full reproducible swap.
 *
 *   1. generate preimage + hashlock
 *   2. approve + lock MST on Sepolia, then verify the recorded parameters
 *   3. lock ETH on Arbitrum Sepolia, then verify the recorded parameters
 *   4. recipient of the ETH leg claims, which publishes the preimage
 *   5. the same preimage, read from the ETH claim log, claims the MST leg
 *
 * Every transaction waits for `confirmations` blocks and its hash is returned.
 */
async function executeSwap({
  mstChain,
  ethChain,
  mstAmountHuman,
  ethAmountHuman,
  timelockSeconds,
  marginSeconds = 600,
  preimage = null,
  confirmations = 1,
  stopAfterLock = false,
  onStep = () => {},
}) {
  assertChainRoles(mstChain, ethChain);

  const mstSender = ROLES.mstSender;
  const mstRecipient = ROLES.mstRecipient;
  const ethSender = ROLES.ethSender;
  const ethRecipient = ROLES.ethRecipient;

  const preimageHex = preimage ? String(preimage) : randomBytes32();
  const hashlock = hashlockFor(preimageHex);

  const mstAmount = ethers.parseUnits(String(mstAmountHuman), await mstChain.mstDecimals());
  const ethAmount = ethers.parseEther(String(ethAmountHuman));

  // Deadlines are computed on the chain that must enforce them.
  const mstNow = (await mstChain.latestBlock()).timestamp;
  const ethNow = (await ethChain.latestBlock()).timestamp;
  const mstTimelock = mstNow + timelockSeconds + marginSeconds;
  // The ETH leg must expire *before* the MST leg by at least the margin, however
  // long Bob waits before locking. Take the margin off the MST deadline instead of
  // adding it to the ETH clock; otherwise a slow second lock shrinks (or reverses)
  // the safety window.
  const ethTimelock = mstTimelock - marginSeconds;
  if (mstTimelock <= mstNow + 60) {
    throw new Error("The timelock must leave at least a minute before expiry.");
  }
  if (ethTimelock <= ethNow + 60) {
    throw new Error(
      `Too late to lock the ETH leg safely: the MST expires at ${formatTimestamp(mstTimelock)}, ` +
        `which leaves less than a minute for the ETH leg after the ${marginSeconds}s margin. ` +
        `Start a new swap with a longer timelock.`
    );
  }

  const mstSwapId = newSwapId();
  const ethSwapId = newSwapId();
  const steps = [];

  const recordStep = (summary) => {
    steps.push(summary);
    onStep(summary);
  };

  const checks = await preflight({ mstChain, ethChain, mstAmount, ethAmount });
  if (checks.issues.length > 0) {
    throw new Error(`Pre-flight failed:\n- ${checks.issues.join("\n- ")}`);
  }

  const approval = await ensureMstApproval({ chain: mstChain, role: mstSender, amount: mstAmount, confirmations });
  if (approval.summary) recordStep(approval.summary);

  const lockMst = await sendTransaction(
    mstChain
      .htlcFor(mstSender)
      .lock(
        mstSwapId,
        mstChain.mstAddress,
        mstChain.addressOf(mstRecipient),
        mstAmount,
        hashlock,
        mstTimelock
      ),
    { chain: mstChain, label: "lock MST", confirmations }
  );
  recordStep(lockMst.summary);

  const mstVerification = await verifyLock(mstChain, mstSwapId, {
    sender: mstChain.addressOf(mstSender),
    recipient: mstChain.addressOf(mstRecipient),
    token: mstChain.mstAddress,
    amount: mstAmount,
    hashlock,
    timelock: mstTimelock,
  });

  const lockEth = await sendTransaction(
    ethChain
      .htlcFor(ethSender)
      .lock(ethSwapId, ethChain.addressOf(ethRecipient), hashlock, ethTimelock, { value: ethAmount }),
    { chain: ethChain, label: "lock ETH", confirmations }
  );
  recordStep(lockEth.summary);

  const ethVerification = await verifyLock(ethChain, ethSwapId, {
    sender: ethChain.addressOf(ethSender),
    recipient: ethChain.addressOf(ethRecipient),
    token: ethers.ZeroAddress,
    amount: ethAmount,
    hashlock,
    timelock: ethTimelock,
  });

  const result = {
    preimage: preimageHex,
    hashlock,
    mst: {
      chain: mstChain.name,
      chainLabel: mstChain.label,
      swapId: mstSwapId,
      amount: mstAmount,
      amountLabel: await formatMst(mstChain, mstAmount),
      sender: mstSender,
      recipient: mstRecipient,
      timelock: mstTimelock,
      timelockIso: formatTimestamp(mstTimelock),
    },
    eth: {
      chain: ethChain.name,
      chainLabel: ethChain.label,
      swapId: ethSwapId,
      amount: ethAmount,
      amountLabel: formatEth(ethAmount),
      sender: ethSender,
      recipient: ethRecipient,
      timelock: ethTimelock,
      timelockIso: formatTimestamp(ethTimelock),
    },
    balancesBefore: checks.balances,
    steps,
    verification: { mst: mstVerification, eth: ethVerification },
    revealedPreimage: null,
    revealedFromChain: false,
  };

  if (stopAfterLock) {
    result.final = {
      mst: await observe(mstChain, mstSwapId, { includeBalances: true }),
      eth: await observe(ethChain, ethSwapId, { includeBalances: true }),
    };
    return result;
  }

  // The ETH recipient claims first: this publishes the preimage on Arbitrum.
  const claimEth = await sendTransaction(
    ethChain.htlcFor(ethRecipient).claim(ethSwapId, preimageHex),
    { chain: ethChain, label: "claim ETH", confirmations }
  );
  recordStep(claimEth.summary);

  const claimedEvent = findEvent(ethChain, claimEth.receipt, "Claimed");
  const revealed = claimedEvent ? claimedEvent.args.preimage : null;
  if (revealed && !equalBytes32(revealed, preimageHex)) {
    throw new Error("The preimage published on Arbitrum does not match the swap's hashlock.");
  }
  result.revealedPreimage = revealed ?? preimageHex;
  result.revealedFromChain = Boolean(revealed);

  // The MST recipient uses the preimage observed on Arbitrum to claim on Sepolia.
  const claimMst = await sendTransaction(
    mstChain.htlcFor(mstRecipient).claim(mstSwapId, result.revealedPreimage),
    { chain: mstChain, label: "claim MST", confirmations }
  );
  recordStep(claimMst.summary);

  result.final = {
    mst: await observe(mstChain, mstSwapId, { includeBalances: true }),
    eth: await observe(ethChain, ethSwapId, { includeBalances: true }),
  };
  return result;
}

/**
 * Claims one leg after checking that a claim is still the valid action.
 * Refuses when the swap is missing, already completed, or expired.
 */
async function claimSide({ chain, swapId, preimage, confirmations = 1 }) {
  const swap = await readSwap(chain, swapId);
  const { timestamp } = await chain.latestBlock();
  const labels = classify(swap, timestamp);

  if (!labels.exists) refuse(`${chain.label}: no swap ${shortHex(swapId)} on this chain, so there is nothing to claim.`);
  if (labels.claimed) refuse(`${chain.label}: swap ${shortHex(swapId)} was already claimed; a second claim is invalid.`);
  if (labels.refunded) refuse(`${chain.label}: swap ${shortHex(swapId)} was already refunded; a claim is no longer valid.`);
  if (!labels.claimable) {
    refuse(
      `${chain.label}: swap ${shortHex(swapId)} expired ${formatDuration(-labels.secondsToExpiry)} ago; only refund is valid now.`
    );
  }
  if (!preimage) {
    throw new Error("No preimage given. Pass --preimage or set SWAP_PREIMAGE in .env.");
  }
  if (!equalBytes32(hashlockFor(preimage), swap.hashlock)) {
    refuse(`The preimage does not match the hashlock stored in swap ${shortHex(swapId)}.`);
  }

  const role = chain.roleOf(swap.recipient);
  if (!role) {
    refuse(`${chain.label}: the recipient ${shortHex(swap.recipient)} is not one of the configured accounts.`);
  }

  const { summary, receipt } = await sendTransaction(chain.htlcFor(role).claim(swapId, preimage), {
    chain,
    label: `claim as ${role}`,
    confirmations,
  });
  const event = findEvent(chain, receipt, "Claimed");
  return {
    summary,
    role,
    swapBefore: swap,
    labelsBefore: labels,
    preimageFromEvent: event ? event.args.preimage : null,
  };
}

/**
 * Refunds one leg after checking that the timelock has expired and that the
 * configured signer is the original sender. Refuses otherwise.
 */
async function refundSide({ chain, swapId, confirmations = 1 }) {
  const swap = await readSwap(chain, swapId);
  const { timestamp } = await chain.latestBlock();
  const labels = classify(swap, timestamp);

  if (!labels.exists) refuse(`${chain.label}: no swap ${shortHex(swapId)} on this chain, so there is nothing to refund.`);
  if (labels.claimed) refuse(`${chain.label}: swap ${shortHex(swapId)} was claimed; a refund is no longer valid.`);
  if (labels.refunded) refuse(`${chain.label}: swap ${shortHex(swapId)} was already refunded.`);
  if (!labels.refundable) {
    refuse(
      `${chain.label}: swap ${shortHex(swapId)} is still claimable for ${formatDuration(labels.secondsToExpiry)}; refund unlocks at ${formatTimestamp(swap.timelock)}.`
    );
  }

  const role = chain.roleOf(swap.sender);
  if (!role) {
    refuse(`${chain.label}: the sender ${shortHex(swap.sender)} is not one of the configured accounts.`);
  }

  const { summary } = await sendTransaction(chain.htlcFor(role).refund(swapId), {
    chain,
    label: `refund as ${role}`,
    confirmations,
  });
  return { summary, role, swapBefore: swap, labelsBefore: labels };
}

/** Actions that are valid right now on one chain, for a given observation. */
function validActions(chain, observation) {
  const { swap, labels } = observation;
  if (!labels.exists) {
    return [{ action: "none", role: null, description: "No swap with this id on this chain." }];
  }
  if (labels.claimed) {
    return [{ action: "none", role: null, description: "Completed: the recipient already claimed." }];
  }
  if (labels.refunded) {
    return [{ action: "none", role: null, description: "Completed: the sender already refunded." }];
  }
  const actions = [];
  if (labels.claimable) {
    const role = chain.roleOf(swap.recipient);
    actions.push({
      action: "claim",
      role,
      description: `${role ?? shortHex(swap.recipient)} can claim until ${formatTimestamp(swap.timelock)} (${formatDuration(labels.secondsToExpiry)} left).`,
    });
  }
  if (labels.refundable) {
    const role = chain.roleOf(swap.sender);
    actions.push({
      action: "refund",
      role,
      description: `${role ?? shortHex(swap.sender)} can refund now (expired ${formatDuration(-labels.secondsToExpiry)} ago).`,
    });
  }
  return actions;
}

/**
 * Off-chain comparison of two independent observations. This is the only place
 * the two legs are related, and it is plain data comparison — the contracts
 * still never talk to each other.
 */
function compareObservations(mstObservation, ethObservation) {
  const mst = mstObservation.swap;
  const eth = ethObservation.swap;
  return [
    { check: "hashlock identical on both chains", ok: equalBytes32(mst.hashlock, eth.hashlock) },
    {
      check: "recipients mirrored (MST recipient = ETH sender, ETH recipient = MST sender)",
      ok: isSameAddress(mst.recipient, eth.sender) && isSameAddress(eth.recipient, mst.sender),
    },
    {
      check: "both legs were created",
      ok: mstObservation.labels.exists && ethObservation.labels.exists,
    },
  ];
}

module.exports = {
  ProtocolRefusal,
  claimSide,
  compareObservations,
  executeSwap,
  formatEth,
  formatMst,
  hashlockFor,
  isValidBytes32,
  newSwapId,
  observe,
  preflight,
  readBalances,
  readSwap,
  refundSide,
  validActions,
  verifyLock,
};
