// Loads compiled ABIs from Hardhat's artifacts/ directory.
//
// The scripts talk to two public testnets over plain JSON-RPC, so they do not
// use the Hardhat runtime; they only need the ABIs Hardhat produced.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const ARTIFACTS_CONTRACTS = path.join(ROOT, "artifacts", "contracts");
const cache = new Map();

function findArtifactFile(contractName) {
  const stack = [ARTIFACTS_CONTRACTS];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (entry.name === `${contractName}.sol`) {
        const candidate = path.join(full, `${contractName}.json`);
        if (fs.existsSync(candidate)) return candidate;
      } else {
        stack.push(full);
      }
    }
  }
  return null;
}

/** Returns { abi, bytecode } for a compiled contract. */
function loadArtifact(contractName) {
  if (cache.has(contractName)) return cache.get(contractName);
  const file = findArtifactFile(contractName);
  if (!file) {
    throw new Error(
      `No compiled artifact for ${contractName}. Run "npx hardhat compile" in 5521Project first.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(file, "utf8"));
  const value = { abi: artifact.abi, bytecode: artifact.bytecode };
  cache.set(contractName, value);
  return value;
}

function loadAbi(contractName) {
  return loadArtifact(contractName).abi;
}

module.exports = { loadAbi, loadArtifact };
