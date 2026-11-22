# COMP5521 2026 Project — Part A: HTLC smart contracts

Implementation of **Task A (HTLC smart contracts, 25 marks)** of
`COMP5521_HTLC_Project_2026.pdf`: two self-contained, single-chain escrow
contracts that the cross-chain swap is built on in Tasks B and C.

| Contract | Chain | Asset |
| --- | --- | --- |
| `contracts/ERC20HTLC.sol` | Ethereum Sepolia | Lab 3 `MySimpleToken` (MST, ERC20) |
| `contracts/ETHHTLC.sol` | Arbitrum Sepolia | native ETH |

Neither contract reads or calls the other chain. Cross-chain coordination
(hashlock sharing, timelock ordering, claim propagation) belongs to Task B and is
deliberately **not** implemented here.

## Project layout

```text
contracts/
  HTLCBase.sol              shared lock / claim / refund state machine
  ERC20HTLC.sol             MST escrow (ERC20 path)
  ETHHTLC.sol               native ETH escrow
  mocks/TestMST.sol         local test token (Sepolia uses the Lab 3 MST)
  mocks/ReentrantReceiver.sol   test-only malicious recipient
  mocks/RejectingRecipient.sol  test-only recipient that rejects ETH
test/
  helpers.js                fixtures, hashlock/preimage constants
  ERC20HTLC.js              A1 / A3 / A4 / A5 tests
  ETHHTLC.js                A2 / A3 / A4 / A5 tests
hardhat.config.js           Solidity 0.8.20, Sepolia + Arbitrum Sepolia networks
package.json                Hardhat toolchain and OpenZeppelin 5.x
```

## Design

### One escrow, one asset

`HTLCBase` holds the protocol logic: the swap record, the state machine, the
preimage check, access control and the events. The concrete contracts only
decide how the asset enters the escrow (`_deposit`) and leaves it (`_payout`).
`ERC20HTLC` pulls the token in with `SafeERC20.safeTransferFrom` and pays out
with `safeTransfer`; `ETHHTLC` receives `msg.value` and pays out with a
low-level `call{value: ...}`.

### State machine

```text
                       claim()            claim() / refund()
   None ──lock()──► Active ──────► Claimed ─────────────────► (terminal)
                      │
                      │ refund()
                      └──────────► Refunded ─────────────────► (terminal)
```

* `None` is the default value of the mapping and means "no such swap".
* A swap leaves `Active` exactly once, so claim-then-refund and refund-then-claim
  are both impossible (`SwapNotActive`).
* `claim` is valid only while `block.timestamp < timelock`; `refund` is valid
  only when `block.timestamp >= timelock`. The two windows touch but never
  overlap: at the timelock instant, claim reverts and refund succeeds.
* A swap cannot be created already expired: `timelock > block.timestamp` is
  required.

### API

`ERC20HTLC`

```solidity
function lock(bytes32 swapId, address token, address recipient, uint256 amount,
              bytes32 hashlock, uint256 timelock) external returns (bytes32);
```

`ETHHTLC`

```solidity
function lock(bytes32 swapId, address recipient, bytes32 hashlock, uint256 timelock)
    external payable returns (bytes32);
```

Both

```solidity
function claim(bytes32 swapId, bytes32 preimage) external;  // recipient, before expiry
function refund(bytes32 swapId) external;                   // sender, at/after expiry
function getSwap(bytes32 swapId) external view returns (Swap memory);
function isClaimable(bytes32 swapId) external view returns (bool);
function isRefundable(bytes32 swapId) external view returns (bool);
```

Events (identical shape in both contracts)

```solidity
event Locked(bytes32 indexed swapId, address indexed sender, address indexed recipient,
             address token, uint256 amount, bytes32 hashlock, uint256 timelock);
event Claimed(bytes32 indexed swapId, bytes32 preimage);  // publishes the revealed preimage
event Refunded(bytes32 indexed swapId);
```

`token` is `address(0)` for ETH swaps. Events and errors are shared through
`HTLCBase`, so one ABI decodes the logs of either chain.

`swapId` is chosen by the caller and must be unique inside one contract. Task B
generates it off-chain and reuses the same value on both chains, which is what
makes the two independent escrows refer to "the same" swap.

### Validation and safety (A5)

* `swapId != 0`, `recipient != 0`, `token != 0`, `amount > 0`,
  `hashlock != 0`, `timelock > now`, and no duplicate `swapId` — each with its
  own custom error, plus `InsufficientAllowance` and the token's own
  `ERC20InsufficientBalance` surfaced before any state change.
* Checks-effects-interactions: the swap is written (or moved to
  `Claimed`/`Refunded`) **before** any token or ETH transfer.
* `nonReentrant` on `lock`, `claim` and `refund`.
* `SafeERC20` everywhere, so tokens that do not return `bool` are handled
  safely.
* ETH payouts use `call` and revert with `EthTransferFailed` instead of
  swallowing the failure; a failed payout leaves the swap `Active` (the sender
  can still refund later) — covered by a test.
* No `receive`/`fallback`, so accidental plain ETH transfers revert.
* A claim can only be made by the designated recipient, a refund only by the
  original sender.

## Running it

```bash
npm install
npx hardhat compile
npx hardhat test
```

On Windows, if `npx.ps1` is blocked, use `npx.cmd hardhat test`.

The suite is fully offline: it uses the local `TestMST` token and the in-process
Hardhat network. No testnet account or RPC endpoint is required for Part A.

## Test coverage

62 tests, all passing.

| Area | Examples |
| --- | --- |
| A1 MST lock | escrow balance and full swap record, `Locked` event, duplicate id, zero id/recipient/token/amount/hashlock, past timelock, missing allowance, empty balance |
| A2 ETH lock | `amount == msg.value`, `token == address(0)`, `Locked` event, zero-value lock, duplicate id, invalid fields, plain ETH transfers rejected |
| A3 claim | recipient paid, `Claimed` exposes the preimage, claim at `timelock - 1`, non-recipient, wrong preimage, unknown id, at/after expiry, double claim, claim after refund, re-entrant claim blocked, failed ETH payout keeps the swap active |
| A4 refund | refund at exactly the timelock, after expiry, before expiry, non-sender, double refund, refund after claim, unknown id |
| A5 views | `getSwap` record and empty record, `isClaimable` / `isRefundable` across all states |

The re-entrancy test deploys a recipient contract that calls `claim` again from
inside its ETH callback. The nested call is rejected by the reentrancy guard,
exactly one payout happens, and the swap ends `Claimed`.

## Notes and limitations

* Timelocks are absolute Unix timestamps. Task B chooses the ordering (for
  example the ETH leg expiring later than the MST leg) so a revealed preimage can
  always be used before the counterparty lock expires.
* Each swap records its own `token`, so `ERC20HTLC` is not tied to a single MST
  address at deploy time. Deployment scripts pass `MST_ADDRESS` from `.env`.
* The contracts enforce only their own on-chain rules: they do not verify the
  counterparty lock, and they have no bridge, oracle or relayer. A swap that is
  never claimed is recovered by the sender through `refund` after expiry.
