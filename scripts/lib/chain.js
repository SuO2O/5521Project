// One object per chain: provider, contracts, accounts and explorer links.
//
// The scripts never rely on Hardhat's single active network, because Task B has
// to talk to two independent chains in one process. Every function here takes a
// chain handle, so the same code runs on public testnets and in the local tests.
const { ethers } = require("ethers");

const {
  ACCOUNTS,
  chainConfig,
  configuredRoleFor,
  envValue,
  explorerUrl,
  maskUrl,
  requireEnv,
  shortHex,
} = require("./config");
const { loadAbi } = require("./artifacts");

// The Sepolia token is the Lab 3 MySimpleToken. Only these functions are needed.
const MINIMAL_ERC20_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
];

/**
 * Builds a chain handle from an existing provider and contract addresses.
 * This is the constructor the tests use with the in-process Hardhat network.
 */
function makeChain({
  name,
  provider,
  htlcAddress,
  mstAddress = null,
  signers = {},
  addresses = {},
  contractAbi = null,
}) {
  const cfg = chainConfig(name);
  const htlc = new ethers.Contract(htlcAddress, contractAbi ?? loadAbi(cfg.contract), provider);
  const mst = mstAddress ? new ethers.Contract(mstAddress, MINIMAL_ERC20_ABI, provider) : null;

  const chain = {
    name: cfg.name,
    label: cfg.label,
    chainId: cfg.chainId,
    asset: cfg.asset,
    currency: cfg.currency,
    provider,
    htlc,
    mst,
    htlcAddress,
    mstAddress,
    signers,
    addresses,

    transactionUrl(hash) {
      return explorerUrl(cfg, "tx", hash);
    },

    addressUrl(address) {
      return explorerUrl(cfg, "address", address);
    },

    addressOf(role) {
      const address = addresses[role];
      if (!address) throw new Error(`No ${role} account configured for ${cfg.label}.`);
      return address;
    },

    signerFor(role) {
      const signer = signers[role];
      if (!signer) {
        throw new Error(`No ${role} private key configured for ${cfg.label}. Check .env.`);
      }
      return signer;
    },

    htlcFor(role) {
      return htlc.connect(chain.signerFor(role));
    },

    mstFor(role) {
      if (!chain.mst) throw new Error(`${cfg.label}: MST_ADDRESS is not configured.`);
      return chain.mst.connect(chain.signerFor(role));
    },

    /** "alice" / "bob" for a configured account, otherwise null. */
    roleOf(address) {
      const configured = configuredRoleFor(address);
      if (configured) return configured;
      for (const [role, owned] of Object.entries(addresses)) {
        if (owned && owned.toLowerCase() === String(address).toLowerCase()) return role;
      }
      return null;
    },

    async latestBlock() {
      const block = await provider.getBlock("latest");
      return { number: block.number, timestamp: block.timestamp };
    },

    async ethBalance(address) {
      return provider.getBalance(address);
    },

    /** Reads the MST contract's decimals once and caches them. */
    async mstDecimals() {
      if (!chain.mst) throw new Error(`${cfg.label}: MST_ADDRESS is not configured.`);
      if (chain._decimals === undefined) {
        chain._decimals = Number(await chain.mst.decimals());
      }
      return chain._decimals;
    },

    /** Throws a clear error if the configured MST address has no code. */
    async requireMst() {
      if (!chain.mst) {
        throw new Error(`MST_ADDRESS is not set in .env, but the Sepolia leg escrows MST.`);
      }
      const code = await provider.getCode(chain.mstAddress);
      if (code === "0x") {
        throw new Error(`${cfg.label}: no token contract at ${chain.mstAddress}. Check MST_ADDRESS in .env.`);
      }
      return chain.mst;
    },

    /** Throws a clear error if the configured HTLC address has no code. */
    async requireHtlc() {
      const code = await provider.getCode(htlcAddress);
      if (code === "0x") {
        throw new Error(
          `${cfg.label}: no contract at ${htlcAddress}. Deploy it first or fix ${chainConfig(name).htlcEnv} in .env.`
        );
      }
      return htlc;
    },
  };

  return chain;
}

/**
 * Connects to a live chain from .env: RPC endpoint, expected chain id, HTLC
 * address, and the two wallets. Private keys never leave this function.
 */
async function openProvider(name) {
  const cfg = chainConfig(name);
  const rpcUrl = requireEnv(cfg.rpcEnv);
  const provider = new ethers.JsonRpcProvider(rpcUrl);

  let network;
  try {
    network = await provider.getNetwork();
  } catch (error) {
    throw new Error(
      `${cfg.label}: cannot reach ${maskUrl(rpcUrl)} (${error.shortMessage || error.message}). Check ${cfg.rpcEnv}.`
    );
  }
  if (Number(network.chainId) !== cfg.chainId) {
    throw new Error(
      `${cfg.label}: the RPC endpoint reports chain ${network.chainId}, but ${cfg.rpcEnv} must be chain ${cfg.chainId}.`
    );
  }

  const signers = {};
  const addresses = {};
  for (const [role, meta] of Object.entries(ACCOUNTS)) {
    const key = envValue(meta.keyEnv);
    if (!key) continue;
    const wallet = new ethers.Wallet(key, provider);
    const expected = envValue(meta.addressEnv);
    if (expected && expected.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error(
        `${meta.keyEnv} derives address ${wallet.address} but ${meta.addressEnv} is ${expected}. Fix .env before signing anything.`
      );
    }
    // A swap sends several transactions in a row from the same account. The
    // NonceManager keeps the nonce local and increments it per send, so a
    // follow-up transaction cannot reuse the previous one's nonce while the
    // previous block is still settling.
    signers[role] = new ethers.NonceManager(wallet);
    addresses[role] = wallet.address;
  }

  return { cfg, provider, signers, addresses };
}

/** Full chain handle for an already-deployed pair of contracts. */
async function connectChain(name, { needMst = false } = {}) {
  const { cfg, provider, signers, addresses } = await openProvider(name);
  const htlcAddress = requireEnv(cfg.htlcEnv);
  const chain = makeChain({ name, provider, htlcAddress, signers, addresses });

  if (cfg.asset === "erc20") {
    const mstAddress = envValue("MST_ADDRESS");
    if (mstAddress) {
      chain.mst = new ethers.Contract(mstAddress, MINIMAL_ERC20_ABI, provider);
      chain.mstAddress = mstAddress;
    }
  }

  await chain.requireHtlc();
  if (needMst) await chain.requireMst();
  return chain;
}

module.exports = { MINIMAL_ERC20_ABI, connectChain, makeChain, openProvider };
