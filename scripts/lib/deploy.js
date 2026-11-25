// Shared deployment logic for the two escrow contracts (Task B1).
const { ethers } = require("ethers");

const { chainConfig } = require("./config");
const { loadArtifact } = require("./artifacts");
const { openProvider } = require("./chain");
const { updateEnvFile } = require("./envFile");

/**
 * Deploys one HTLC contract on one chain, then records its address in .env.
 *
 * The chain id is checked by openProvider before anything is sent, so a
 * mis-pointed RPC endpoint cannot deploy the wrong contract to the wrong chain.
 */
async function deployHtlc(chainName, { account = "alice", confirmations = 1, saveEnv = true } = {}) {
  const cfg = chainConfig(chainName);
  const { provider, signers } = await openProvider(chainName);

  const signer = signers[account];
  if (!signer) {
    throw new Error(`No ${account} private key in .env, cannot deploy as ${account}.`);
  }
  const deployerAddress = await signer.getAddress();

  const balance = await provider.getBalance(deployerAddress);
  if (balance === 0n) {
    throw new Error(
      `${account} (${deployerAddress}) has no ${cfg.currency} on ${cfg.label}. Fund it before deploying.`
    );
  }

  const { abi, bytecode } = loadArtifact(cfg.contract);
  const factory = new ethers.ContractFactory(abi, bytecode, signer);

  const contract = await factory.deploy();
  const deploymentTx = contract.deploymentTransaction();
  const receipt = await deploymentTx.wait(confirmations);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`${cfg.label}: deployment transaction failed (${deploymentTx.hash}).`);
  }

  const address = await contract.getAddress();
  const code = await provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${cfg.label}: no bytecode at ${address} after deployment.`);
  }

  const applied = saveEnv ? updateEnvFile({ [cfg.htlcEnv]: address }) : [];
  return {
    cfg,
    address,
    txHash: deploymentTx.hash,
    blockNumber: receipt.blockNumber,
    deployerRole: account,
    deployerAddress,
    balance,
    applied,
  };
}

module.exports = { deployHtlc };
