const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  ETH_AMOUNT,
  HASHLOCK,
  PREIMAGE,
  SwapState,
  ZERO_ADDRESS,
  ZERO_HASH,
  deployETHEscrow,
  futureTimelock,
  id,
  latestTimestamp,
} = require("./helpers");

// Locks ETH for `recipient` and returns the swap description.
async function createSwap(fixture, overrides = {}) {
  const { alice, bob, htlc } = fixture;
  const swapId = overrides.swapId ?? id("eth-swap");
  const recipient = overrides.recipient ?? bob.address;
  const hashlock = overrides.hashlock ?? HASHLOCK;
  const timelock = overrides.timelock ?? (await futureTimelock());
  const value = overrides.value ?? ETH_AMOUNT;

  const tx = await htlc.connect(alice).lock(swapId, recipient, hashlock, timelock, { value });
  await tx.wait();

  return { swapId, recipient, hashlock, timelock, value, tx };
}

describe("ETHHTLC - native ETH escrow (Task A2/A3/A4/A5)", function () {
  describe("A2: ETH locking", function () {
    it("escrows msg.value and records the full swap", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice, bob } = fixture;

      const swap = await createSwap(fixture);

      const record = await htlc.getSwap(swap.swapId);
      expect(record.sender).to.equal(alice.address);
      expect(record.recipient).to.equal(bob.address);
      expect(record.token).to.equal(ZERO_ADDRESS);
      expect(record.amount).to.equal(ETH_AMOUNT);
      expect(record.hashlock).to.equal(HASHLOCK);
      expect(record.timelock).to.equal(swap.timelock);
      expect(record.state).to.equal(SwapState.Active);

      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(ETH_AMOUNT);
    });

    it("emits Locked with the swap parameters", async function () {
      const { htlc, alice, bob } = await loadFixture(deployETHEscrow);
      const timelock = await futureTimelock();
      const swapId = id("eth-event-swap");

      await expect(
        htlc.connect(alice).lock(swapId, bob.address, HASHLOCK, timelock, { value: ETH_AMOUNT })
      )
        .to.emit(htlc, "Locked")
        .withArgs(
          swapId,
          alice.address,
          bob.address,
          ZERO_ADDRESS,
          ETH_AMOUNT,
          HASHLOCK,
          timelock
        );
    });

    it("reverts for a zero-value lock", async function () {
      const { htlc, alice, bob } = await loadFixture(deployETHEscrow);
      const timelock = await futureTimelock();

      await expect(htlc.connect(alice).lock(id("no-value"), bob.address, HASHLOCK, timelock))
        .to.be.revertedWithCustomError(htlc, "InvalidAmount");
    });

    it("reverts when the swap id is re-used", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice, bob } = fixture;
      const swap = await createSwap(fixture);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(swap.swapId, bob.address, HASHLOCK, timelock, { value: ETH_AMOUNT })
      )
        .to.be.revertedWithCustomError(htlc, "SwapAlreadyExists")
        .withArgs(swap.swapId);
    });

    it("reverts for a zero swap id", async function () {
      const { htlc, alice, bob } = await loadFixture(deployETHEscrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(ZERO_HASH, bob.address, HASHLOCK, timelock, { value: ETH_AMOUNT })
      ).to.be.revertedWithCustomError(htlc, "InvalidSwapId");
    });

    it("reverts for a zero recipient", async function () {
      const { htlc, alice } = await loadFixture(deployETHEscrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("eth-bad-recipient"), ZERO_ADDRESS, HASHLOCK, timelock, {
          value: ETH_AMOUNT,
        })
      ).to.be.revertedWithCustomError(htlc, "InvalidRecipient");
    });

    it("reverts for a zero hashlock", async function () {
      const { htlc, alice, bob } = await loadFixture(deployETHEscrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("eth-zero-hashlock"), bob.address, ZERO_HASH, timelock, {
          value: ETH_AMOUNT,
        })
      ).to.be.revertedWithCustomError(htlc, "InvalidHashlock");
    });

    it("reverts when the timelock is not in the future", async function () {
      const { htlc, alice, bob } = await loadFixture(deployETHEscrow);
      const now = await latestTimestamp();

      await expect(
        htlc.connect(alice).lock(id("eth-past-timelock"), bob.address, HASHLOCK, now, {
          value: ETH_AMOUNT,
        })
      ).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
    });

    it("rejects plain ETH transfers", async function () {
      const { htlc, alice } = await loadFixture(deployETHEscrow);

      await expect(
        alice.sendTransaction({ to: await htlc.getAddress(), value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });

  describe("A3: hashlock claim", function () {
    it("pays the recipient and marks the swap claimed", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE)).to.changeEtherBalances(
        [bob, await htlc.getAddress()],
        [ETH_AMOUNT, -ETH_AMOUNT]
      );

      expect((await htlc.getSwap(swap.swapId)).state).to.equal(SwapState.Claimed);
    });

    it("publishes the revealed preimage in the Claimed event", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.emit(htlc, "Claimed")
        .withArgs(swap.swapId, PREIMAGE);
    });

    it("accepts a claim one second before the timelock", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock - 1);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE)).to.changeEtherBalances(
        [bob],
        [ETH_AMOUNT]
      );
    });

    it("reverts when the caller is not the recipient", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice, carol } = fixture;
      const swap = await createSwap(fixture);

      await expect(htlc.connect(alice).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "NotRecipient")
        .withArgs(alice.address);
      await expect(htlc.connect(carol).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "NotRecipient")
        .withArgs(carol.address);
    });

    it("reverts for a wrong preimage", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      const wrong = ethers.encodeBytes32String("wrong-secret");
      await expect(htlc.connect(bob).claim(swap.swapId, wrong)).to.be.revertedWithCustomError(
        htlc,
        "InvalidPreimage"
      );
    });

    it("reverts for an unknown swap id", async function () {
      const { htlc, bob } = await loadFixture(deployETHEscrow);

      await expect(htlc.connect(bob).claim(id("missing"), PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound")
        .withArgs(id("missing"));
    });

    it("reverts at exactly the timelock", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapExpired")
        .withArgs(swap.swapId);
    });

    it("reverts after the timelock", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock + 600);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE)).to.be.revertedWithCustomError(
        htlc,
        "SwapExpired"
      );
    });

    it("reverts for a second claim", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await htlc.connect(bob).claim(swap.swapId, PREIMAGE);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Claimed);
    });

    it("reverts for a claim after a refund", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock);
      await htlc.connect(alice).refund(swap.swapId);

      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Refunded);
    });

    it("blocks a re-entrant claim from the ETH payout callback", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;

      const attacker = await (
        await ethers.getContractFactory("ReentrantReceiver")
      ).deploy(await htlc.getAddress());
      await attacker.waitForDeployment();
      const attackerAddress = await attacker.getAddress();

      const timelock = await futureTimelock();
      const swapId = id("reentrant-swap");
      await htlc
        .connect(alice)
        .lock(swapId, attackerAddress, HASHLOCK, timelock, { value: ETH_AMOUNT });

      await attacker.arm(swapId, PREIMAGE);
      await attacker.connect(alice).claimSwap(swapId, PREIMAGE);

      // The nested claim was attempted and rejected by the reentrancy guard.
      expect(await attacker.reentryAttempted()).to.equal(true);
      expect(await attacker.reentryBlocked()).to.equal(true);
      // Exactly one payout happened.
      expect(await ethers.provider.getBalance(attackerAddress)).to.equal(ETH_AMOUNT);
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(0n);
      expect((await htlc.getSwap(swapId)).state).to.equal(SwapState.Claimed);
    });

    it("keeps the swap active when the ETH payout fails", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;

      const recipient = await (
        await ethers.getContractFactory("RejectingRecipient")
      ).deploy(await htlc.getAddress());
      await recipient.waitForDeployment();

      const timelock = await futureTimelock();
      const swapId = id("rejecting-swap");
      await htlc
        .connect(alice)
        .lock(swapId, await recipient.getAddress(), HASHLOCK, timelock, { value: ETH_AMOUNT });

      await expect(recipient.claimSwap(swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "EthTransferFailed")
        .withArgs(await recipient.getAddress(), ETH_AMOUNT);

      expect((await htlc.getSwap(swapId)).state).to.equal(SwapState.Active);

      // The failed claim cannot strand the asset: the sender refunds after expiry.
      await time.increaseTo(timelock);
      await expect(htlc.connect(alice).refund(swapId)).to.changeEtherBalances(
        [alice, await htlc.getAddress()],
        [ETH_AMOUNT, -ETH_AMOUNT]
      );
    });
  });

  describe("A4: timelock refund", function () {
    it("returns the ETH to the sender at exactly the timelock", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.emit(htlc, "Refunded")
        .withArgs(swap.swapId);
      expect((await htlc.getSwap(swap.swapId)).state).to.equal(SwapState.Refunded);
      expect(await ethers.provider.getBalance(await htlc.getAddress())).to.equal(0n);
    });

    it("returns the ETH after expiry", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock + 3600);
      await expect(htlc.connect(alice).refund(swap.swapId)).to.changeEtherBalances(
        [alice, await htlc.getAddress()],
        [ETH_AMOUNT, -ETH_AMOUNT]
      );
    });

    it("reverts before expiry", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;
      const swap = await createSwap(fixture);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "SwapNotExpired")
        .withArgs(swap.swapId);

      await time.setNextBlockTimestamp(swap.timelock - 1);
      await expect(htlc.connect(alice).refund(swap.swapId)).to.be.revertedWithCustomError(
        htlc,
        "SwapNotExpired"
      );
    });

    it("reverts when the caller is not the sender", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob, carol } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock + 1);

      await expect(htlc.connect(bob).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "NotSender")
        .withArgs(bob.address);
      await expect(htlc.connect(carol).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "NotSender")
        .withArgs(carol.address);
    });

    it("reverts for a second refund", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock);
      await htlc.connect(alice).refund(swap.swapId);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Refunded);
    });

    it("reverts for a refund after a claim", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, alice, bob } = fixture;
      const swap = await createSwap(fixture);

      await htlc.connect(bob).claim(swap.swapId, PREIMAGE);
      await time.increaseTo(swap.timelock + 1);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Claimed);
    });

    it("reverts for an unknown swap id", async function () {
      const { htlc, alice } = await loadFixture(deployETHEscrow);

      await expect(htlc.connect(alice).refund(id("missing")))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound")
        .withArgs(id("missing"));
    });
  });

  describe("A5: state views", function () {
    it("tracks claimable and refundable windows across the state machine", async function () {
      const fixture = await loadFixture(deployETHEscrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      expect(await htlc.isClaimable(swap.swapId)).to.equal(true);
      expect(await htlc.isRefundable(swap.swapId)).to.equal(false);

      await time.increaseTo(swap.timelock);
      expect(await htlc.isClaimable(swap.swapId)).to.equal(false);
      expect(await htlc.isRefundable(swap.swapId)).to.equal(true);

      const second = await createSwap(fixture, { swapId: id("claimed-eth") });
      await htlc.connect(bob).claim(second.swapId, PREIMAGE);
      expect(await htlc.isClaimable(second.swapId)).to.equal(false);
      expect(await htlc.isRefundable(second.swapId)).to.equal(false);
    });

    it("reports an empty record for an unknown swap id", async function () {
      const { htlc } = await loadFixture(deployETHEscrow);
      const unknown = id("unknown-swap");

      const record = await htlc.getSwap(unknown);
      expect(record.sender).to.equal(ZERO_ADDRESS);
      expect(record.amount).to.equal(0n);
      expect(record.state).to.equal(SwapState.None);
      expect(await htlc.isClaimable(unknown)).to.equal(false);
      expect(await htlc.isRefundable(unknown)).to.equal(false);
    });
  });
});
