// Local tests for the Task B coordinator.
//
// The coordinator is chain-agnostic: it receives two "chain handles". Here both
// handles point at the in-process Hardhat network but at different escrow
// contracts, which is enough to exercise the whole protocol logic — locking,
// verification, claiming, independent observation and timeout recovery — without
// a public testnet.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const fs = require("node:fs");
const path = require("node:path");

const { makeChain } = require("../scripts/lib/chain");
const protocol = require("../scripts/lib/protocol");
const { classify } = require("../scripts/lib/swapState");
const { updateEnvFile } = require("../scripts/lib/envFile");

const SWAP_OPTIONS = {
  mstAmountHuman: "100",
  ethAmountHuman: "0.5",
  timelockSeconds: 600,
  marginSeconds: 120,
  confirmations: 1,
};

async function deployFixture() {
  const [alice, bob, carol] = await ethers.getSigners();

  const token = await (await ethers.getContractFactory("TestMST")).deploy(
    alice.address,
    ethers.parseUnits("1000000", 18)
  );
  const mstHtlc = await (await ethers.getContractFactory("ERC20HTLC")).deploy();
  const ethHtlc = await (await ethers.getContractFactory("ETHHTLC")).deploy();
  await Promise.all([token.waitForDeployment(), mstHtlc.waitForDeployment(), ethHtlc.waitForDeployment()]);

  const provider = ethers.provider;
  const mstChain = makeChain({
    name: "sepolia",
    provider,
    htlcAddress: await mstHtlc.getAddress(),
    mstAddress: await token.getAddress(),
    signers: { alice, bob },
    addresses: { alice: alice.address, bob: bob.address },
  });
  const ethChain = makeChain({
    name: "arbitrum",
    provider,
    htlcAddress: await ethHtlc.getAddress(),
    signers: { alice, bob },
    addresses: { alice: alice.address, bob: bob.address },
  });

  return { alice, bob, carol, token, mstHtlc, ethHtlc, mstChain, ethChain };
}

/** Runs a promise that must reject; returns the error for further assertions. */
async function rejection(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to be refused, but it succeeded.");
}

describe("Cross-chain coordinator (Task B)", function () {
  describe("B2: successful swap", function () {
    it("locks, verifies and claims both legs with confirmed transaction hashes", async function () {
      const ctx = await loadFixture(deployFixture);

      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
      });

      const labels = result.steps.map((step) => step.label);
      expect(labels).to.deep.equal(["approve MST", "lock MST", "lock ETH", "claim ETH", "claim MST"]);

      for (const step of result.steps) {
        expect(step.hash).to.match(/^0x[0-9a-f]{64}$/);
        expect(step.blockNumber).to.be.greaterThan(0);
        expect(step.explorerUrl).to.match(/^https:\/\//);
      }

      expect(result.final.mst.swap.state).to.equal("Claimed");
      expect(result.final.eth.swap.state).to.equal("Claimed");
      expect(result.revealedFromChain).to.equal(true);
      expect(result.revealedPreimage).to.equal(result.preimage);
      expect(result.hashlock).to.equal(protocol.hashlockFor(result.preimage));
    });

    it("moves the assets to the opposite parties", async function () {
      const ctx = await loadFixture(deployFixture);

      await protocol.executeSwap({ mstChain: ctx.mstChain, ethChain: ctx.ethChain, ...SWAP_OPTIONS });

      expect(await ctx.token.balanceOf(ctx.bob.address)).to.equal(ethers.parseUnits("100", 18));
      expect(await ctx.token.balanceOf(await ctx.mstHtlc.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await ctx.ethHtlc.getAddress())).to.equal(0n);
    });

    it("verifies the first lock before the counterparty commits ETH", async function () {
      const ctx = await loadFixture(deployFixture);

      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
      });

      const lockMstIndex = result.steps.findIndex((step) => step.label === "lock MST");
      const lockEthIndex = result.steps.findIndex((step) => step.label === "lock ETH");
      expect(lockMstIndex).to.be.lessThan(lockEthIndex);
      expect(result.verification.mst.checks).to.have.length(7);
      expect(result.verification.mst.checks.every((check) => check.ok)).to.equal(true);
      expect(result.verification.eth.checks.every((check) => check.ok)).to.equal(true);
    });

    it("rejects a lock whose stored parameters differ from what was sent", async function () {
      const ctx = await loadFixture(deployFixture);

      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      const error = await rejection(
        protocol.verifyLock(ctx.mstChain, result.mst.swapId, {
          sender: ctx.alice.address,
          recipient: ctx.bob.address,
          token: await ctx.token.getAddress(),
          amount: 1n,
          hashlock: result.hashlock,
          timelock: result.mst.timelock,
        })
      );
      expect(error.message).to.match(/does not match/);
      expect(error.message).to.match(/amount/);
    });

    it("refuses a preimage that does not match the hashlock", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      const error = await rejection(
        protocol.claimSide({
          chain: ctx.mstChain,
          swapId: result.mst.swapId,
          preimage: protocol.hashlockFor(result.preimage),
        })
      );
      expect(error.code).to.equal("INVALID_ACTION");
      expect(error.message).to.match(/does not match the hashlock/);
    });
  });

  describe("B2/B4: timeout path", function () {
    it("creates active locks when --stop-after-lock is used", async function () {
      const ctx = await loadFixture(deployFixture);

      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      expect(result.steps.map((step) => step.label)).to.deep.equal(["approve MST", "lock MST", "lock ETH"]);
      expect(result.final.mst.swap.state).to.equal("Active");
      expect(result.final.eth.swap.state).to.equal("Active");
      expect(result.final.mst.labels.claimable).to.equal(true);
      expect(result.final.mst.labels.refundable).to.equal(false);
      expect(result.revealedPreimage).to.equal(null);
    });

    it("claims after expiry is refused and refund is then allowed", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      await time.increaseTo(result.eth.timelock + 1);

      const claimError = await rejection(
        protocol.claimSide({ chain: ctx.ethChain, swapId: result.eth.swapId, preimage: result.preimage })
      );
      expect(claimError.code).to.equal("INVALID_ACTION");
      expect(claimError.message).to.match(/expired/);

      const refund = await protocol.refundSide({ chain: ctx.ethChain, swapId: result.eth.swapId });
      expect(refund.role).to.equal("bob");
      expect((await protocol.readSwap(ctx.ethChain, result.eth.swapId)).state).to.equal("Refunded");
    });

    it("refunds both legs to their senders and restores the balances", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      await time.increaseTo(result.mst.timelock + 1);

      const mstRefund = await protocol.refundSide({ chain: ctx.mstChain, swapId: result.mst.swapId });
      const ethRefund = await protocol.refundSide({ chain: ctx.ethChain, swapId: result.eth.swapId });
      expect(mstRefund.role).to.equal("alice");
      expect(ethRefund.role).to.equal("bob");

      expect((await protocol.readSwap(ctx.mstChain, result.mst.swapId)).state).to.equal("Refunded");
      expect((await protocol.readSwap(ctx.ethChain, result.eth.swapId)).state).to.equal("Refunded");
      expect(await ctx.token.balanceOf(ctx.alice.address)).to.equal(ethers.parseUnits("1000000", 18));
      expect(await ethers.provider.getBalance(await ctx.ethHtlc.getAddress())).to.equal(0n);
    });

    it("refuses a refund before the timelock expires", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      const error = await rejection(
        protocol.refundSide({ chain: ctx.mstChain, swapId: result.mst.swapId })
      );
      expect(error.code).to.equal("INVALID_ACTION");
      expect(error.message).to.match(/still claimable/);
    });

    it("refuses a refund after the swap was claimed", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({ mstChain: ctx.mstChain, ethChain: ctx.ethChain, ...SWAP_OPTIONS });

      const error = await rejection(
        protocol.refundSide({ chain: ctx.mstChain, swapId: result.mst.swapId })
      );
      expect(error.code).to.equal("INVALID_ACTION");
      expect(error.message).to.match(/claimed/);
    });

    it("refuses a duplicate claim", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({ mstChain: ctx.mstChain, ethChain: ctx.ethChain, ...SWAP_OPTIONS });

      const error = await rejection(
        protocol.claimSide({ chain: ctx.mstChain, swapId: result.mst.swapId, preimage: result.preimage })
      );
      expect(error.code).to.equal("INVALID_ACTION");
      expect(error.message).to.match(/already claimed/);
    });
  });

  describe("B3: independent observation", function () {
    it("labels each leg from its own chain clock", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      const observed = await protocol.observe(ctx.mstChain, result.mst.swapId, { includeBalances: true });
      expect(observed.chain).to.equal("sepolia");
      expect(observed.swap.state).to.equal("Active");
      expect(observed.labels.claimable).to.equal(true);
      expect(observed.labels.refundable).to.equal(false);
      expect(observed.labels.expired).to.equal(false);

      const actions = protocol.validActions(ctx.mstChain, observed);
      expect(actions).to.have.length(1);
      expect(actions[0].action).to.equal("claim");
      expect(actions[0].role).to.equal("bob");

      await time.increaseTo(result.mst.timelock + 1);
      const expired = await protocol.observe(ctx.mstChain, result.mst.swapId);
      expect(expired.labels.expired).to.equal(true);
      expect(expired.labels.claimable).to.equal(false);
      expect(expired.labels.refundable).to.equal(true);
      expect(protocol.validActions(ctx.mstChain, expired)[0].action).to.equal("refund");
    });

    it("compares the two legs without any contract-to-contract call", async function () {
      const ctx = await loadFixture(deployFixture);
      const result = await protocol.executeSwap({
        mstChain: ctx.mstChain,
        ethChain: ctx.ethChain,
        ...SWAP_OPTIONS,
        stopAfterLock: true,
      });

      const mstObserved = await protocol.observe(ctx.mstChain, result.mst.swapId);
      const ethObserved = await protocol.observe(ctx.ethChain, result.eth.swapId);
      const checks = protocol.compareObservations(mstObserved, ethObserved);
      expect(checks.every((check) => check.ok)).to.equal(true);
    });

    it("reports an unknown swap as not created", async function () {
      const ctx = await loadFixture(deployFixture);
      const unknown = protocol.newSwapId();

      const observed = await protocol.observe(ctx.mstChain, unknown);
      expect(observed.swap.state).to.equal("None");
      expect(observed.labels.exists).to.equal(false);
      expect(protocol.validActions(ctx.mstChain, observed)[0].action).to.equal("none");
    });
  });

  describe("classification", function () {
    it("derives every state label from one timestamp", function () {
      const swap = { state: "Active", timelock: 1000 };
      expect(classify(swap, 999)).to.include({ claimable: true, refundable: false, expired: false });
      expect(classify(swap, 1000)).to.include({ claimable: false, refundable: true, expired: true });
      expect(classify({ state: "Claimed", timelock: 1000 }, 1000)).to.include({
        claimed: true,
        claimable: false,
        refundable: false,
      });
      expect(classify({ state: "None", timelock: 0 }, 1000)).to.include({ exists: false });
    });
  });

  describe("environment writer", function () {
    it("replaces only the given keys and preserves the rest of .env", function () {
      const dir = fs.mkdtempSync(path.join(process.cwd(), "cache", "env-test-"));
      const file = path.join(dir, ".env");
      fs.writeFileSync(file, "# keep this comment\nA=1\nB=2\n\nC=3\n", "utf8");

      const applied = updateEnvFile({ B: "20", D: "4" }, file);
      const text = fs.readFileSync(file, "utf8");

      expect(applied).to.deep.equal(["B", "D"]);
      expect(text).to.include("# keep this comment");
      expect(text).to.include("A=1");
      expect(text).to.include("B=20");
      expect(text).to.include("C=3");
      expect(text).to.include("D=4");
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });
});
