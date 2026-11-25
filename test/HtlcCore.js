// Tests for the rules module shared by the CLI scripts and the browser UI.
const { expect } = require("chai");
const { ethers } = require("hardhat");

const coreModule = require("../shared/htlc-core");
const core = coreModule.create(ethers);

describe("shared/htlc-core (used by Task B scripts and Task C UI)", function () {
  it("derives the hashlock exactly as the contracts check it", function () {
    const preimage = `0x${"11".repeat(32)}`;
    // ethers.getBytes() gives the 32 raw bytes, which is what abi.encodePacked
    // in HTLCBase.claim feeds to keccak256.
    expect(core.hashlockFor(preimage)).to.equal(ethers.keccak256(ethers.getBytes(preimage)));
  });

  it("rejects malformed preimages", function () {
    expect(() => core.hashlockFor("0x1234")).to.throw(/32 bytes of hex/);
    expect(() => core.hashlockFor("hello")).to.throw(/32 bytes of hex/);
  });

  it("generates random 32-byte values that differ", function () {
    const first = core.randomBytes32();
    const second = core.randomBytes32();
    expect(first).to.match(/^0x[0-9a-f]{64}$/);
    expect(second).to.match(/^0x[0-9a-f]{64}$/);
    expect(first).to.not.equal(second);
    expect(core.isValidBytes32(first)).to.equal(true);
  });

  it("decodes swap records", function () {
    const decoded = core.decodeSwap({
      sender: "0x0000000000000000000000000000000000000001",
      recipient: "0x0000000000000000000000000000000000000002",
      token: "0x0000000000000000000000000000000000000003",
      amount: 100n,
      hashlock: `0x${"22".repeat(32)}`,
      timelock: 1795614672n,
      state: 1n,
    });
    expect(decoded.state).to.equal("Active");
    expect(decoded.stateCode).to.equal(1);
    expect(decoded.timelock).to.equal(1795614672);
    expect(decoded.amount).to.equal(100n);
  });

  it("classifies the claim/refund windows", function () {
    const active = { state: "Active", timelock: 1000 };
    expect(core.classify(active, 999)).to.include({ claimable: true, refundable: false, expired: false });
    expect(core.classify(active, 1000)).to.include({ claimable: false, refundable: true, expired: true });
    expect(core.classify({ state: "Claimed", timelock: 1000 }, 500)).to.include({
      claimed: true,
      claimable: false,
      refundable: false,
    });
    expect(core.classify({ state: "None", timelock: 0 }, 500)).to.include({ exists: false });
  });

  it("formats durations and timestamps for the CLI and the UI", function () {
    expect(coreModule.formatDuration(0)).to.equal("0s");
    expect(coreModule.formatDuration(48)).to.equal("48s");
    expect(coreModule.formatDuration(60)).to.equal("1m");
    expect(coreModule.formatDuration(125)).to.equal("2m 5s");
    expect(coreModule.formatDuration(3725)).to.equal("1h 2m");
    expect(coreModule.formatTimestamp(1795614672)).to.equal("2026-11-25T13:51:12Z");
  });

  it("requires an ethers instance", function () {
    expect(() => coreModule.create()).to.throw(/requires an ethers instance/);
  });
});
