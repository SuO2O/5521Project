// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {HTLCBase} from "./HTLCBase.sol";

/// @title ETHHTLC - native ETH escrow for the Arbitrum Sepolia side of the swap
/// @notice Locks native ETH so that only the designated recipient can claim it
///         with the hashlock preimage before the timelock, or the sender can
///         reclaim it afterwards.
/// @dev This contract never reads or calls anything on the other chain. It is a
///      self-contained single-chain escrow; cross-chain coordination lives
///      entirely in the off-chain scripts and frontend.
contract ETHHTLC is HTLCBase {
    /// @notice Lock `msg.value` wei for `recipient` under a hashlock.
    /// @dev The locked amount is exactly `msg.value`; there is no `amount`
    ///      parameter, so the transferred value and the recorded value can never
    ///      disagree. A zero-value call is rejected.
    ///      ETH arrives with this call, so `_deposit` has nothing left to do;
    ///      the swap is recorded as `Active` and `Locked` is emitted.
    /// @param swapId Caller-chosen identifier, unique within this contract.
    /// @param recipient Only address allowed to claim.
    /// @param hashlock `keccak256(abi.encodePacked(preimage))`.
    /// @param timelock Unix timestamp after which only the sender may refund.
    /// @return The swap id (echoing the input for convenient off-chain logging).
    function lock(
        bytes32 swapId,
        address recipient,
        bytes32 hashlock,
        uint256 timelock
    ) external payable nonReentrant returns (bytes32) {
        if (msg.value == 0) revert InvalidAmount();
        return _createSwap(swapId, recipient, address(0), msg.value, hashlock, timelock);
    }

    /// @dev Native ETH is already held by this contract because `lock` is payable.
    function _deposit(address, address, uint256) internal override {}

    /// @dev Sends the escrowed ETH with a low-level call so the recipient may be
    ///      a contract. The state was already moved to `Claimed`/`Refunded` and
    ///      the entry point is `nonReentrant`, so this call cannot re-enter into
    ///      a second payout.
    function _payout(Swap memory swap, address to) internal override {
        (bool sent, ) = payable(to).call{value: swap.amount}("");
        if (!sent) revert EthTransferFailed(to, swap.amount);
    }
}
