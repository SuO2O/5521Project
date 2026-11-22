// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ETHHTLC} from "../ETHHTLC.sol";

/// @dev Test helper only: a swap recipient that cannot accept ETH (no
///      `receive`/`fallback`). Used to prove that a failed payout reverts the
///      claim and leaves the swap state unchanged.
contract RejectingRecipient {
    ETHHTLC public immutable htlc;

    constructor(ETHHTLC htlc_) {
        htlc = htlc_;
    }

    function claimSwap(bytes32 swapId_, bytes32 preimage_) external {
        htlc.claim(swapId_, preimage_);
    }
}
