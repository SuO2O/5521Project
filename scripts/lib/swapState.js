// Decoding and labelling of on-chain swap records.
//
// The implementation lives in shared/htlc-core.js so the Task B scripts and the
// Task C browser UI apply exactly the same rules.
const { ethers } = require("ethers");

const core = require("../../shared/htlc-core").create(ethers);

module.exports = {
  STATE_NAMES: core.STATE_NAMES,
  classify: core.classify,
  decodeSwap: core.decodeSwap,
  equalBytes32: core.equalBytes32,
  isSameAddress: core.isSameAddress,
};
