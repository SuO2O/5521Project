// Shared fixtures and constants for the Task A contract tests.
// Not a test file itself: it only exports helpers.
const { ethers } = require("hardhat");

// One secret reused by the tests. keccak256(preimage) is the hashlock that both
// escrow contracts check, mirroring the Lab 4 convention of hashing a 32-byte
// value with abi.encodePacked.
const PREIMAGE = ethers.encodeBytes32String("comp5521-project-secret");
const HASHLOCK = ethers.keccak256(ethers.solidityPacked(["bytes32"], [PREIMAGE]));

// Must match the order of HTLCBase.SwapState.
const SwapState = {
  None: 0n,
  Active: 1n,
  Claimed: 2n,
  Refunded: 3n,
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = "0x" + "0".repeat(64);

const AMOUNT = ethers.parseUnits("100", 18); // 100 MST
const ETH_AMOUNT = ethers.parseEther("0.5");
const TIMELOCK_DELAY = 3600; // 1 hour after the latest block

function id(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}

async function futureTimelock(delay = TIMELOCK_DELAY) {
  return (await latestTimestamp()) + delay;
}

// Fixture: Alice holds all MST and has approved the escrow; Bob and Carol are
// empty accounts used to probe access control and insufficient balances.
async function deployERC20Escrow() {
  const [alice, bob, carol] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("TestMST")).deploy(
    alice.address,
    ethers.parseUnits("1000000", 18)
  );
  const htlc = await (await ethers.getContractFactory("ERC20HTLC")).deploy();
  await Promise.all([token.waitForDeployment(), htlc.waitForDeployment()]);

  const tokenAddress = await token.getAddress();
  const htlcAddress = await htlc.getAddress();
  await token.connect(alice).approve(htlcAddress, ethers.MaxUint256);

  return { alice, bob, carol, token, htlc, tokenAddress, htlcAddress };
}

// Fixture: a funded ETH escrow. Alice funds the lock, Bob claims.
async function deployETHEscrow() {
  const [alice, bob, carol] = await ethers.getSigners();
  const htlc = await (await ethers.getContractFactory("ETHHTLC")).deploy();
  await htlc.waitForDeployment();
  return { alice, bob, carol, htlc };
}

module.exports = {
  AMOUNT,
  ETH_AMOUNT,
  HASHLOCK,
  PREIMAGE,
  SwapState,
  TIMELOCK_DELAY,
  ZERO_ADDRESS,
  ZERO_HASH,
  deployERC20Escrow,
  deployETHEscrow,
  futureTimelock,
  id,
  latestTimestamp,
};
