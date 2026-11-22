// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ETHHTLC} from "../ETHHTLC.sol";

/// @dev Test helper only: a swap recipient that tries to re-enter `claim`
///      from inside the ETH payout callback. Used to prove that `nonReentrant`
///      plus the claim-before-pay state write blocks double spending.
contract ReentrantReceiver {
    ETHHTLC public immutable htlc;

    bytes32 public swapId;
    bytes32 public preimage;
    bool public reentryAttempted;
    bool public reentryBlocked;

    constructor(ETHHTLC htlc_) {
        htlc = htlc_;
    }

    /// @notice Prepare the nested claim attempt that `receive` will try.
    function arm(bytes32 swapId_, bytes32 preimage_) external {
        swapId = swapId_;
        preimage = preimage_;
    }

    /// @notice Initiate a (legitimate) claim so that this contract is the recipient.
    function claimSwap(bytes32 swapId_, bytes32 preimage_) external {
        htlc.claim(swapId_, preimage_);
    }

    receive() external payable {
        if (swapId == bytes32(0)) return;
        reentryAttempted = true;
        bytes32 id = swapId;
        bytes32 secret = preimage;
        swapId = bytes32(0); // only one nested attempt
        try htlc.claim(id, secret) {
            // A successful re-entry would be a vulnerability; the test asserts
            // that this branch is never taken.
        } catch {
            reentryBlocked = true;
        }
    }
}
