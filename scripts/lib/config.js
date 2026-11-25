// Central configuration for the Part B cross-chain scripts.
//
// Everything is read from 5521Project/.env. Private keys are only ever turned
// into signer objects in chain.js; no module prints a key, an RPC URL or the
// preimage unless a script explicitly says so.
const path = require("node:path");

const ENV_PATH = path.resolve(__dirname, "..", "..", ".env");
require("dotenv").config({ path: ENV_PATH });

/// The two independent chains of the swap. They never call each other.
const CHAINS = {
  sepolia: {
    name: "sepolia",
    label: "Ethereum Sepolia",
    chainId: 11155111,
    rpcEnv: "SEPOLIA_RPC_URL",
    htlcEnv: "SEPOLIA_ERC20_HTLC_ADDRESS",
    swapIdEnv: "ERC20_SWAP_ID",
    contract: "ERC20HTLC",
    asset: "erc20",
    explorer: "https://sepolia.etherscan.io",
    currency: "ETH",
  },
  arbitrum: {
    name: "arbitrum",
    label: "Arbitrum Sepolia",
    chainId: 421614,
    rpcEnv: "ARBITRUM_SEPOLIA_RPC_URL",
    htlcEnv: "ARBITRUM_ETH_HTLC_ADDRESS",
    swapIdEnv: "ETH_SWAP_ID",
    contract: "ETHHTLC",
    asset: "eth",
    explorer: "https://sepolia.arbiscan.io",
    currency: "ETH",
  },
};

const CHAIN_ALIASES = {
  sepolia: "sepolia",
  ethereum: "sepolia",
  eth: "sepolia",
  arbitrum: "arbitrum",
  arb: "arbitrum",
  "arbitrum-sepolia": "arbitrum",
};

/// Configured testnet accounts. Alice is signer 0 in Lab 4, Bob is signer 1.
const ACCOUNTS = {
  alice: { keyEnv: "ALICE_PRIVATE_KEY", addressEnv: "ALICE_ADDRESS" },
  bob: { keyEnv: "BOB_PRIVATE_KEY", addressEnv: "BOB_ADDRESS" },
};

/// Who sends which asset. Alice sends MST and receives ETH; Bob sends ETH and
/// receives MST — the same roles as the Lab 4 demo.
const ROLES = {
  mstSender: "alice",
  mstRecipient: "bob",
  ethSender: "bob",
  ethRecipient: "alice",
};

const SWAP_ENV_KEYS = ["SWAP_PREIMAGE", "SWAP_HASHLOCK", "ERC20_SWAP_ID", "ETH_SWAP_ID"];

function envValue(name) {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : undefined;
}

function requireEnv(name) {
  const value = envValue(name);
  if (!value) throw new Error(`Missing ${name} in ${ENV_PATH}. See README "Filling in .env".`);
  return value;
}

/** Accepts "sepolia" / "arbitrum" and the usual aliases. */
function chainConfig(name) {
  const key = CHAIN_ALIASES[String(name).toLowerCase()];
  if (!key) {
    throw new Error(`Unknown chain "${name}". Use one of: sepolia, arbitrum.`);
  }
  return CHAINS[key];
}

/** Both chains, in protocol order (first lock, then counterparty lock). */
function allChains() {
  return [CHAINS.sepolia, CHAINS.arbitrum];
}

function amountConfig() {
  return {
    mst: envValue("ERC20_AMOUNT") || "100",
    eth: envValue("ETH_AMOUNT") || "0.001",
  };
}

function timelockSeconds() {
  const value = Number(envValue("TIMELOCK_SECONDS") || 3600);
  if (!Number.isInteger(value) || value < 60) {
    throw new Error(`TIMELOCK_SECONDS must be an integer >= 60 (got ${process.env.TIMELOCK_SECONDS}).`);
  }
  return value;
}

/**
 * The MST lock is created first, so it must stay claimable longer than the ETH
 * lock: otherwise the party that reveals the preimage on Arbitrum could run out
 * of time to claim on Sepolia. This margin is added to the MST deadline.
 */
function timelockMarginSeconds() {
  const value = Number(envValue("TIMELOCK_MARGIN_SECONDS") || 600);
  if (!Number.isInteger(value) || value < 60) {
    throw new Error(`TIMELOCK_MARGIN_SECONDS must be an integer >= 60 (got ${process.env.TIMELOCK_MARGIN_SECONDS}).`);
  }
  return value;
}

function confirmations() {
  const value = Number(envValue("CONFIRMATIONS") || 1);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`CONFIRMATIONS must be an integer >= 1 (got ${process.env.CONFIRMATIONS}).`);
  }
  return value;
}

function swapParamsFromEnv() {
  return {
    preimage: envValue("SWAP_PREIMAGE"),
    hashlock: envValue("SWAP_HASHLOCK"),
    erc20SwapId: envValue("ERC20_SWAP_ID"),
    ethSwapId: envValue("ETH_SWAP_ID"),
  };
}

/** Short 0x1234…abcd form for logs. Never used for the preimage. */
function shortHex(value, head = 6, tail = 4) {
  if (!value) return "(unset)";
  const text = String(value);
  if (text.length <= head + tail + 2) return text;
  return `${text.slice(0, head)}…${text.slice(-tail)}`;
}

/** Keep RPC endpoints (which embed API keys) out of logs. */
function maskUrl(url) {
  if (!url) return "(unset)";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "(invalid URL)";
  }
}

/** Address with the configured account name when known, e.g. "alice (0xeD8a…36FC)". */
function labelAddress(address) {
  if (!address) return "(none)";
  for (const [role, meta] of Object.entries(ACCOUNTS)) {
    const configured = envValue(meta.addressEnv);
    if (configured && configured.toLowerCase() === String(address).toLowerCase()) {
      return `${role} (${shortHex(address)})`;
    }
  }
  return shortHex(address);
}

/** Does a configured account own this address? Returns "alice" / "bob" / null. */
function configuredRoleFor(address) {
  if (!address) return null;
  for (const [role, meta] of Object.entries(ACCOUNTS)) {
    const configured = envValue(meta.addressEnv);
    if (configured && configured.toLowerCase() === String(address).toLowerCase()) return role;
  }
  return null;
}

function explorerUrl(chain, kind, value) {
  return `${chain.explorer}/${kind}/${value}`;
}

module.exports = {
  ACCOUNTS,
  CHAINS,
  CHAIN_ALIASES,
  ENV_PATH,
  ROLES,
  SWAP_ENV_KEYS,
  allChains,
  amountConfig,
  chainConfig,
  confirmations,
  configuredRoleFor,
  envValue,
  explorerUrl,
  labelAddress,
  maskUrl,
  requireEnv,
  shortHex,
  swapParamsFromEnv,
  timelockMarginSeconds,
  timelockSeconds,
};
