// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {HTLCBase} from "./HTLCBase.sol";

/// @title ERC20HTLC - MST escrow for the Ethereum Sepolia side of the swap
/// @notice Locks an ERC20 asset (the Lab 3 `MySimpleToken`, MST) so that only
///         the designated recipient can claim it with the hashlock preimage
///         before the timelock, or the sender can reclaim it afterwards.
/// @dev This contract never reads or calls anything on the other chain. It is a
///      self-contained single-chain escrow; cross-chain coordination lives
///      entirely in the off-chain scripts and frontend.
contract ERC20HTLC is HTLCBase {
    using SafeERC20 for IERC20;

    /// @notice Lock `amount` of `token` for `recipient` under a hashlock.
    /// @dev The caller must have approved this contract for at least `amount`
    ///      beforehand (Lab 4 style `approve` + `lock`). The token is pulled in
    ///      with `SafeERC20.safeTransferFrom`, so both standard tokens and
    ///      tokens that do not return a bool are handled safely.
    ///      The swap record is written as `Active` before the token transfer
    ///      (checks-effects-interactions) and the whole transaction reverts if
    ///      the transfer fails, so a partially created swap can never exist.
    /// @param swapId Caller-chosen identifier, unique within this contract.
    /// @param token ERC20 token to escrow (MST on Sepolia).
    /// @param recipient Only address allowed to claim.
    /// @param amount Token amount, in the token's own decimals.
    /// @param hashlock `keccak256(abi.encodePacked(preimage))`.
    /// @param timelock Unix timestamp after which only the sender may refund.
    /// @return The swap id (echoing the input for convenient off-chain logging).
    function lock(
        bytes32 swapId,
        address token,
        address recipient,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) external nonReentrant returns (bytes32) {
        if (token == address(0)) revert InvalidToken();

        // Fail fast with a precise error before any state changes; the actual
        // allowance check is still enforced by safeTransferFrom below.
        uint256 allowed = IERC20(token).allowance(msg.sender, address(this));
        if (allowed < amount) revert InsufficientAllowance(allowed, amount);

        return _createSwap(swapId, recipient, token, amount, hashlock, timelock);
    }

    /// @dev Pulls the ERC20 asset into this contract. Runs after the swap is
    ///      recorded as `Active`.
    function _deposit(address sender, address token, uint256 amount) internal override {
        IERC20(token).safeTransferFrom(sender, address(this), amount);
    }

    /// @dev Pays the escrowed ERC20 asset out of this contract. Runs after the
    ///      swap state has already been moved to `Claimed` or `Refunded`.
    function _payout(Swap memory swap, address to) internal override {
        IERC20(swap.token).safeTransfer(to, swap.amount);
    }
}
