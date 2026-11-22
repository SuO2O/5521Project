// Generates the off-chain values a cross-chain HTLC swap needs and prints them
// as ready-to-paste `.env` lines. No network access is involved.
//
//   npm run params
//   node scripts/generateSwapParams.js
const { ethers } = require("ethers");

function randomBytes32() {
  return ethers.hexlify(ethers.randomBytes(32));
}

function main() {
  const preimage = randomBytes32();
  // Must match the contracts: keccak256(abi.encodePacked(preimage)) over 32 raw bytes.
  const hashlock = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));

  // Unique per contract, so the two chains do not have to share an id.
  const erc20SwapId = randomBytes32();
  const ethSwapId = randomBytes32();

  const roundTrip = ethers.keccak256(ethers.solidityPacked(["bytes32"], [preimage]));
  if (roundTrip !== hashlock) throw new Error("hashlock derivation is inconsistent");

  console.log("Generated swap parameters for the COMP5521 cross-chain HTLC swap.\n");
  console.log("Copy these four lines into 5521Project/.env, replacing the empty values:\n");
  console.log(`SWAP_PREIMAGE=${preimage}`);
  console.log(`SWAP_HASHLOCK=${hashlock}`);
  console.log(`ERC20_SWAP_ID=${erc20SwapId}`);
  console.log(`ETH_SWAP_ID=${ethSwapId}`);
  console.log("\nNotes:");
  console.log("- Keep SWAP_PREIMAGE private until the first claim publishes it on-chain.");
  console.log("- Both locks use the same SWAP_HASHLOCK; only the preimage releases them.");
  console.log("- Generate a fresh set for each demo run, then update .env and redeploy/re-lock.");
  console.log("- Etherscan/Arbiscan show the preimage in the Claimed event, which is how the");
  console.log("  counterparty obtains it (Task B).");
}

main();
