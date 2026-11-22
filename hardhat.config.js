require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Both participants are plain testnet accounts; Alice is signer 0, Bob signer 1.
// Private keys never leave .env, which is git-ignored.
const accounts = [process.env.ALICE_PRIVATE_KEY, process.env.BOB_PRIVATE_KEY]
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index);

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    // Task B deploys ERC20HTLC here (MST lives on Ethereum Sepolia).
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "",
      accounts,
    },
    // Task B deploys ETHHTLC here; the two chains are independent networks.
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "",
      chainId: 421614,
      accounts,
    },
  },
  etherscan: {
    // Optional: only used to verify deployed sources.
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};
