// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title HTLCBase - shared state machine for the two COMP5521 HTLC escrows
/// @notice Implements the lock / claim / refund state machine that both
///         `ERC20HTLC` (MST on Ethereum Sepolia) and `ETHHTLC` (native ETH on
///         Arbitrum Sepolia) share. Each concrete contract only decides how the
///         locked asset is taken in and paid out.
/// @dev Design notes
///      - A swap is identified by a caller-supplied `bytes32 swapId`. The id is
///        unique inside one contract: re-using it reverts with
///        `SwapAlreadyExists`, which is what makes two independent chains able
///        to talk about "the same" swap without either contract reading the other.
///      - State machine: `None -> Active -> Claimed | Refunded`. A swap can
///        leave `Active` exactly once, so a claim and a refund can never both
///        succeed.
///      - Claim is valid only while `block.timestamp < timelock`; refund is
///        valid only when `block.timestamp >= timelock`. The windows therefore
///        touch but never overlap, and there is no instant at which both are
///        allowed.
///      - External value movement always happens after the state write
///        (checks-effects-interactions) and every entry point is
///        `nonReentrant`.
abstract contract HTLCBase is ReentrancyGuard {
    /// @notice Lifecycle of one escrowed swap.
    enum SwapState {
        None, // not created (default mapping value)
        Active, // asset locked, waiting for claim or refund
        Claimed, // preimage revealed, asset paid to the recipient
        Refunded // timelock passed, asset returned to the sender
    }

    /// @notice Full record of one swap. `token` is the ERC20 address for
    ///         `ERC20HTLC` and `address(0)` for `ETHHTLC`.
    struct Swap {
        address sender;
        address recipient;
        address token;
        uint256 amount;
        bytes32 hashlock;
        uint256 timelock;
        SwapState state;
    }

    /// @dev swapId => swap record.
    mapping(bytes32 => Swap) internal _swaps;

    /// @notice Emitted when an asset is locked and a swap becomes active.
    /// @dev `token` is `address(0)` for native-ETH swaps; both contracts emit
    ///      the same shape so off-chain tooling can decode either chain with one ABI.
    event Locked(
        bytes32 indexed swapId,
        address indexed sender,
        address indexed recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    );

    /// @notice Emitted on a successful claim, publishing the revealed preimage.
    event Claimed(bytes32 indexed swapId, bytes32 preimage);

    /// @notice Emitted when the sender recovers the asset after expiry.
    event Refunded(bytes32 indexed swapId);

    error InvalidSwapId();
    error InvalidRecipient();
    error InvalidToken();
    error InvalidAmount();
    error InvalidHashlock();
    error InvalidTimelock(uint256 timelock, uint256 blockTime);
    error InsufficientAllowance(uint256 allowed, uint256 required);
    error SwapAlreadyExists(bytes32 swapId);
    error SwapNotFound(bytes32 swapId);
    error SwapNotActive(bytes32 swapId, SwapState state);
    error NotRecipient(address caller);
    error NotSender(address caller);
    error SwapExpired(bytes32 swapId);
    error SwapNotExpired(bytes32 swapId);
    error InvalidPreimage();
    error EthTransferFailed(address to, uint256 amount);

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice Returns the full record of `swapId`. The struct is all-zero
    ///         (state `None`) when the swap does not exist.
    function getSwap(bytes32 swapId) external view returns (Swap memory) {
        return _swaps[swapId];
    }

    /// @notice True when the recipient can claim right now: active and before expiry.
    function isClaimable(bytes32 swapId) external view returns (bool) {
        Swap storage swap = _swaps[swapId];
        return swap.state == SwapState.Active && block.timestamp < swap.timelock;
    }

    /// @notice True when the sender can refund right now: active and at/after expiry.
    function isRefundable(bytes32 swapId) external view returns (bool) {
        Swap storage swap = _swaps[swapId];
        return swap.state == SwapState.Active && block.timestamp >= swap.timelock;
    }

    // ---------------------------------------------------------------------
    // State transitions
    // ---------------------------------------------------------------------

    /// @notice Claim a locked asset by revealing the preimage behind the hashlock.
    /// @dev Only the designated recipient may call, only while the swap is
    ///      `Active` and before `timelock`, and only with the exact preimage:
    ///      `keccak256(abi.encodePacked(preimage)) == hashlock`.
    ///      The state is moved to `Claimed` before the payout, so a second
    ///      claim (including a re-entrant one) can never pay twice.
    /// @param swapId Identifier of the swap to claim.
    /// @param preimage Secret whose 32-byte hash was stored as the hashlock.
    function claim(bytes32 swapId, bytes32 preimage) external nonReentrant {
        Swap storage swap = _swaps[swapId];
        if (swap.state == SwapState.None) revert SwapNotFound(swapId);
        if (swap.state != SwapState.Active) revert SwapNotActive(swapId, swap.state);
        if (msg.sender != swap.recipient) revert NotRecipient(msg.sender);
        if (block.timestamp >= swap.timelock) revert SwapExpired(swapId);
        if (keccak256(abi.encodePacked(preimage)) != swap.hashlock) revert InvalidPreimage();

        swap.state = SwapState.Claimed;
        _payout(swap, swap.recipient);
        emit Claimed(swapId, preimage);
    }

    /// @notice Recover a locked asset after the timelock has expired.
    /// @dev Only the original sender may call, only once the swap is at or past
    ///      `timelock`, and only while it is still `Active`. A swap that was
    ///      already claimed can never be refunded.
    /// @param swapId Identifier of the swap to refund.
    function refund(bytes32 swapId) external nonReentrant {
        Swap storage swap = _swaps[swapId];
        if (swap.state == SwapState.None) revert SwapNotFound(swapId);
        if (swap.state != SwapState.Active) revert SwapNotActive(swapId, swap.state);
        if (msg.sender != swap.sender) revert NotSender(msg.sender);
        if (block.timestamp < swap.timelock) revert SwapNotExpired(swapId);

        swap.state = SwapState.Refunded;
        _payout(swap, swap.sender);
        emit Refunded(swapId);
    }

    // ---------------------------------------------------------------------
    // Internal helpers / asset hooks
    // ---------------------------------------------------------------------

    /// @dev Validates the common protocol fields, stores the swap as `Active`,
    ///      takes custody of the asset and emits `Locked`.
    ///      Concrete contracts validate their own asset fields first.
    function _createSwap(
        bytes32 swapId,
        address recipient,
        address token,
        uint256 amount,
        bytes32 hashlock,
        uint256 timelock
    ) internal returns (bytes32) {
        if (swapId == bytes32(0)) revert InvalidSwapId();
        if (recipient == address(0)) revert InvalidRecipient();
        if (amount == 0) revert InvalidAmount();
        if (hashlock == bytes32(0)) revert InvalidHashlock();
        if (timelock <= block.timestamp) revert InvalidTimelock(timelock, block.timestamp);
        if (_swaps[swapId].state != SwapState.None) revert SwapAlreadyExists(swapId);

        _swaps[swapId] = Swap({
            sender: msg.sender,
            recipient: recipient,
            token: token,
            amount: amount,
            hashlock: hashlock,
            timelock: timelock,
            state: SwapState.Active
        });

        // State is already Active, so a re-entrant create cannot duplicate this id.
        _deposit(msg.sender, token, amount);
        emit Locked(swapId, msg.sender, recipient, token, amount, hashlock, timelock);
        return swapId;
    }

    /// @dev Moves the locked asset into this contract at lock time.
    function _deposit(address sender, address token, uint256 amount) internal virtual;

    /// @dev Moves `swap.amount` of the locked asset from this contract to `to`.
    function _payout(Swap memory swap, address to) internal virtual;
}
