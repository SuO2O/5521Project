const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const {
  AMOUNT,
  HASHLOCK,
  PREIMAGE,
  SwapState,
  ZERO_ADDRESS,
  ZERO_HASH,
  deployERC20Escrow,
  futureTimelock,
  id,
  latestTimestamp,
} = require("./helpers");

// Creates an MST swap and returns everything a test needs to reason about it.
async function createSwap(fixture, overrides = {}) {
  const { alice, bob, htlc, tokenAddress } = fixture;
  const swapId = overrides.swapId ?? id("mst-swap");
  const token = overrides.token ?? tokenAddress;
  const recipient = overrides.recipient ?? bob.address;
  const amount = overrides.amount ?? AMOUNT;
  const hashlock = overrides.hashlock ?? HASHLOCK;
  const timelock = overrides.timelock ?? (await futureTimelock());
  const sender = overrides.sender ?? alice;

  const tx = await htlc.connect(sender).lock(swapId, token, recipient, amount, hashlock, timelock);
  await tx.wait();

  return { swapId, token, recipient, amount, hashlock, timelock, sender, tx };
}

describe("ERC20HTLC - MST escrow (Task A1/A3/A4/A5)", function () {
  describe("A1: MST locking", function () {
    it("escrows the MST and records the full swap", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, token, tokenAddress, alice, bob } = fixture;

      const swap = await createSwap(fixture);

      const record = await htlc.getSwap(swap.swapId);
      expect(record.sender).to.equal(alice.address);
      expect(record.recipient).to.equal(bob.address);
      expect(record.token).to.equal(tokenAddress);
      expect(record.amount).to.equal(AMOUNT);
      expect(record.hashlock).to.equal(HASHLOCK);
      expect(record.timelock).to.equal(swap.timelock);
      expect(record.state).to.equal(SwapState.Active);

      expect(await token.balanceOf(await htlc.getAddress())).to.equal(AMOUNT);
      expect(await token.balanceOf(alice.address)).to.equal(
        ethers.parseUnits("1000000", 18) - AMOUNT
      );
    });

    it("emits Locked with the swap parameters", async function () {
      const { htlc, alice, bob, tokenAddress } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();
      const swapId = id("event-swap");

      await expect(htlc.connect(alice).lock(swapId, tokenAddress, bob.address, AMOUNT, HASHLOCK, timelock))
        .to.emit(htlc, "Locked")
        .withArgs(swapId, alice.address, bob.address, tokenAddress, AMOUNT, HASHLOCK, timelock);
    });

    it("keeps two swaps with different ids independent", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, alice, bob, carol } = fixture;

      const first = await createSwap(fixture, { swapId: id("first"), recipient: bob.address });
      const second = await createSwap(fixture, {
        swapId: id("second"),
        recipient: carol.address,
        amount: ethers.parseUnits("25", 18),
      });

      await htlc.connect(bob).claim(first.swapId, PREIMAGE);

      expect((await htlc.getSwap(first.swapId)).state).to.equal(SwapState.Claimed);
      const pending = await htlc.getSwap(second.swapId);
      expect(pending.state).to.equal(SwapState.Active);
      expect(pending.amount).to.equal(ethers.parseUnits("25", 18));
    });

    it("reverts when the swap id is re-used", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const swap = await createSwap(fixture);
      const { htlc, tokenAddress, alice, bob } = fixture;
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(swap.swapId, tokenAddress, bob.address, AMOUNT, HASHLOCK, timelock)
      )
        .to.be.revertedWithCustomError(htlc, "SwapAlreadyExists")
        .withArgs(swap.swapId);
    });

    it("reverts for a zero swap id", async function () {
      const { htlc, tokenAddress, alice, bob } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(ZERO_HASH, tokenAddress, bob.address, AMOUNT, HASHLOCK, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidSwapId");
    });

    it("reverts for a zero recipient", async function () {
      const { htlc, tokenAddress, alice } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("bad-recipient"), tokenAddress, ZERO_ADDRESS, AMOUNT, HASHLOCK, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidRecipient");
    });

    it("reverts for a zero token address", async function () {
      const { htlc, alice, bob } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("bad-token"), ZERO_ADDRESS, bob.address, AMOUNT, HASHLOCK, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidToken");
    });

    it("reverts for a zero amount", async function () {
      const { htlc, tokenAddress, alice, bob } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("zero-amount"), tokenAddress, bob.address, 0n, HASHLOCK, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidAmount");
    });

    it("reverts for a zero hashlock", async function () {
      const { htlc, tokenAddress, alice, bob } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(alice).lock(id("zero-hashlock"), tokenAddress, bob.address, AMOUNT, ZERO_HASH, timelock)
      ).to.be.revertedWithCustomError(htlc, "InvalidHashlock");
    });

    it("reverts when the timelock is not in the future", async function () {
      const { htlc, tokenAddress, alice, bob } = await loadFixture(deployERC20Escrow);
      const now = await latestTimestamp();

      await expect(
        htlc.connect(alice).lock(id("past-timelock"), tokenAddress, bob.address, AMOUNT, HASHLOCK, now)
      ).to.be.revertedWithCustomError(htlc, "InvalidTimelock");

      await expect(
        htlc.connect(alice).lock(id("older-timelock"), tokenAddress, bob.address, AMOUNT, HASHLOCK, now - 1)
      ).to.be.revertedWithCustomError(htlc, "InvalidTimelock");
    });

    it("reverts when the allowance is below the amount", async function () {
      const { htlc, tokenAddress, bob } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();

      await expect(
        htlc.connect(bob).lock(id("no-allowance"), tokenAddress, bob.address, AMOUNT, HASHLOCK, timelock)
      )
        .to.be.revertedWithCustomError(htlc, "InsufficientAllowance")
        .withArgs(0n, AMOUNT);
    });

    it("reverts when the sender does not own the tokens", async function () {
      const { htlc, token, tokenAddress, carol } = await loadFixture(deployERC20Escrow);
      const timelock = await futureTimelock();
      await token.connect(carol).approve(await htlc.getAddress(), ethers.MaxUint256);

      await expect(
        htlc.connect(carol).lock(id("broke-sender"), tokenAddress, carol.address, AMOUNT, HASHLOCK, timelock)
      ).to.be.revertedWithCustomError(token, "ERC20InsufficientBalance");
    });
  });

  describe("A3: hashlock claim", function () {
    it("pays the recipient and marks the swap claimed", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, token, bob } = fixture;
      const swap = await createSwap(fixture);

      const claimTx = htlc.connect(bob).claim(swap.swapId, PREIMAGE);

      await expect(claimTx).to.changeTokenBalances(
        token,
        [bob, await htlc.getAddress()],
        [AMOUNT, -AMOUNT]
      );

      expect((await htlc.getSwap(swap.swapId)).state).to.equal(SwapState.Claimed);
    });

    it("publishes the revealed preimage in the Claimed event", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.emit(htlc, "Claimed")
        .withArgs(swap.swapId, PREIMAGE);
    });

    it("accepts a claim one second before the timelock", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, token, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock - 1);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE)).to.changeTokenBalances(
        token,
        [bob],
        [AMOUNT]
      );
    });

    it("reverts when the caller is not the recipient", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
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
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      const wrong = ethers.encodeBytes32String("not-the-secret");
      await expect(htlc.connect(bob).claim(swap.swapId, wrong)).to.be.revertedWithCustomError(
        htlc,
        "InvalidPreimage"
      );
    });

    it("reverts for an unknown swap id", async function () {
      const { htlc, bob } = await loadFixture(deployERC20Escrow);

      await expect(htlc.connect(bob).claim(id("missing"), PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound")
        .withArgs(id("missing"));
    });

    it("reverts at exactly the timelock", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapExpired")
        .withArgs(swap.swapId);
    });

    it("reverts after the timelock", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock + 600);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE)).to.be.revertedWithCustomError(
        htlc,
        "SwapExpired"
      );
    });

    it("reverts for a second claim", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      await htlc.connect(bob).claim(swap.swapId, PREIMAGE);
      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Claimed);
    });

    it("reverts for a claim after a refund", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, alice, bob } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock);
      await htlc.connect(alice).refund(swap.swapId);

      await expect(htlc.connect(bob).claim(swap.swapId, PREIMAGE))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Refunded);
    });
  });

  describe("A4: timelock refund", function () {
    it("returns the asset to the sender at exactly the timelock", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, token, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.setNextBlockTimestamp(swap.timelock);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.emit(htlc, "Refunded")
        .withArgs(swap.swapId);
      expect((await htlc.getSwap(swap.swapId)).state).to.equal(SwapState.Refunded);
      expect(await token.balanceOf(alice.address)).to.equal(ethers.parseUnits("1000000", 18));
    });

    it("returns the asset after expiry", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, token, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock + 3600);
      await expect(htlc.connect(alice).refund(swap.swapId)).to.changeTokenBalances(
        token,
        [alice, await htlc.getAddress()],
        [AMOUNT, -AMOUNT]
      );
    });

    it("reverts before expiry", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
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
      const fixture = await loadFixture(deployERC20Escrow);
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
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, alice } = fixture;
      const swap = await createSwap(fixture);

      await time.increaseTo(swap.timelock);
      await htlc.connect(alice).refund(swap.swapId);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Refunded);
    });

    it("reverts for a refund after a claim", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, alice, bob } = fixture;
      const swap = await createSwap(fixture);

      await htlc.connect(bob).claim(swap.swapId, PREIMAGE);
      await time.increaseTo(swap.timelock + 1);

      await expect(htlc.connect(alice).refund(swap.swapId))
        .to.be.revertedWithCustomError(htlc, "SwapNotActive")
        .withArgs(swap.swapId, SwapState.Claimed);
    });

    it("reverts for an unknown swap id", async function () {
      const { htlc, alice } = await loadFixture(deployERC20Escrow);

      await expect(htlc.connect(alice).refund(id("missing")))
        .to.be.revertedWithCustomError(htlc, "SwapNotFound")
        .withArgs(id("missing"));
    });
  });

  describe("A5: state views and safety", function () {
    it("tracks claimable and refundable windows across the state machine", async function () {
      const fixture = await loadFixture(deployERC20Escrow);
      const { htlc, bob } = fixture;
      const swap = await createSwap(fixture);

      expect(await htlc.isClaimable(swap.swapId)).to.equal(true);
      expect(await htlc.isRefundable(swap.swapId)).to.equal(false);

      await time.increaseTo(swap.timelock);
      expect(await htlc.isClaimable(swap.swapId)).to.equal(false);
      expect(await htlc.isRefundable(swap.swapId)).to.equal(true);

      const second = await createSwap(fixture, { swapId: id("claimed-swap") });
      await htlc.connect(bob).claim(second.swapId, PREIMAGE);
      expect(await htlc.isClaimable(second.swapId)).to.equal(false);
      expect(await htlc.isRefundable(second.swapId)).to.equal(false);
    });

    it("reports an empty record for an unknown swap id", async function () {
      const { htlc } = await loadFixture(deployERC20Escrow);
      const unknown = id("unknown-swap");

      const record = await htlc.getSwap(unknown);
      expect(record.sender).to.equal(ZERO_ADDRESS);
      expect(record.recipient).to.equal(ZERO_ADDRESS);
      expect(record.amount).to.equal(0n);
      expect(record.state).to.equal(SwapState.None);
      expect(await htlc.isClaimable(unknown)).to.equal(false);
      expect(await htlc.isRefundable(unknown)).to.equal(false);
    });

    it("rejects plain ETH transfers", async function () {
      const { htlc, alice } = await loadFixture(deployERC20Escrow);

      await expect(
        alice.sendTransaction({ to: await htlc.getAddress(), value: ethers.parseEther("1") })
      ).to.be.reverted;
    });
  });
});
