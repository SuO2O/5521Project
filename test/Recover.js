// Tests for the leftover-lock scanner used by `npm run recover`.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const { makeChain } = require("../scripts/lib/chain");
const { findDeploymentBlock, recoverLocks, scanLocks } = require("../scripts/lib/recover");

const HASHLOCK = ethers.keccak256(ethers.solidityPacked(["bytes32"], [ethers.encodeBytes32String("recover-secret")]));

async function deployFixture() {
  const [alice, bob] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("TestMST")).deploy(
    alice.address,
    ethers.parseUnits("1000", 18)
  );
  const htlc = await (await ethers.getContractFactory("ERC20HTLC")).deploy();
  await Promise.all([token.waitForDeployment(), htlc.waitForDeployment()]);
  await token.connect(alice).approve(await htlc.getAddress(), ethers.parseUnits("1000", 18));

  const chain = makeChain({
    name: "sepolia",
    provider: ethers.provider,
    htlcAddress: await htlc.getAddress(),
    mstAddress: await token.getAddress(),
    signers: { alice, bob },
    addresses: { alice: alice.address, bob: bob.address },
  });
  return { alice, bob, token, htlc, chain };
}

describe("leftover-lock recovery", function () {
  it("finds the deployment block by binary search", async function () {
    const { htlc } = await loadFixture(deployFixture);
    const receipt = await htlc.deploymentTransaction().wait();
    const latest = await ethers.provider.getBlockNumber();
    const found = await findDeploymentBlock(ethers.provider, await htlc.getAddress(), latest);
    expect(found).to.equal(receipt.blockNumber);
  });

  it("scans Locked events and classifies active locks against the latest block", async function () {
    const { alice, bob, htlc, token, chain } = await loadFixture(deployFixture);
    const now = await time.latest();
    const first = ethers.keccak256(ethers.toUtf8Bytes("lock-a"));
    const second = ethers.keccak256(ethers.toUtf8Bytes("lock-b"));
    await htlc.connect(alice).lock(first, await token.getAddress(), bob.address, 100n, HASHLOCK, now + 300);
    await htlc.connect(alice).lock(second, await token.getAddress(), bob.address, 200n, HASHLOCK, now + 9000);

    const report = await scanLocks(chain);
    expect(report.locks).to.have.length(2);
    const byId = new Map(report.locks.map((entry) => [entry.swapId, entry]));
    expect(byId.get(first).labels.claimable).to.equal(true);
    expect(byId.get(first).labels.refundable).to.equal(false);
    expect(byId.get(second).swap.amount).to.equal(200n);
  });

  it("refunds expired locks and leaves claimable ones alone", async function () {
    const { alice, bob, htlc, chain, token } = await loadFixture(deployFixture);
    const now = await time.latest();
    const expired = ethers.keccak256(ethers.toUtf8Bytes("expired-lock"));
    const fresh = ethers.keccak256(ethers.toUtf8Bytes("fresh-lock"));
    await htlc.connect(alice).lock(expired, await token.getAddress(), bob.address, 100n, HASHLOCK, now + 120);
    await htlc.connect(alice).lock(fresh, await token.getAddress(), bob.address, 100n, HASHLOCK, now + 9000);

    await time.increaseTo(now + 200); // the first lock expires, the second stays claimable

    const report = await recoverLocks(chain, { execute: true });
    expect(report.results).to.have.length(2);
    const refunded = report.results.find((entry) => entry.action === "refunded");
    const claimable = report.results.find((entry) => entry.action === "claimable");
    expect(refunded.swapId).to.equal(expired);
    expect(claimable.swapId).to.equal(fresh);
    expect((await htlc.getSwap(expired)).state).to.equal(3n); // Refunded
    expect((await htlc.getSwap(fresh)).state).to.equal(1n); // Active
    expect(await token.balanceOf(await htlc.getAddress())).to.equal(100n); // only the fresh lock is held
  });

  it("reports expired locks without sending anything in dry-run mode", async function () {
    const { alice, bob, htlc, token, chain } = await loadFixture(deployFixture);
    const now = await time.latest();
    const id = ethers.keccak256(ethers.toUtf8Bytes("dry-run-lock"));
    await htlc.connect(alice).lock(id, await token.getAddress(), bob.address, 50n, HASHLOCK, now + 60);
    await time.increaseTo(now + 120);

    const report = await recoverLocks(chain, { execute: false });
    expect(report.results[0].action).to.equal("refundable");
    expect((await htlc.getSwap(id)).state).to.equal(1n); // still Active
  });
});


