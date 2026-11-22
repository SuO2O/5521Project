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
scripts/
  generateSwapParams.js     prints the .env values for a new swap (no network)
hardhat.config.js           Solidity 0.8.20, Sepolia + Arbitrum Sepolia networks
package.json                Hardhat toolchain and OpenZeppelin 5.x
README.md                   this file
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

### 1. Prerequisites

* Node.js 20 or newer with npm (developed with Node 24 / npm 11).
* Nothing else. Part A needs no RPC endpoint, no testnet account and no funds:
  the tests deploy the local `TestMST` token and run on the in-process Hardhat
  network.

### 2. Install, compile and test

```bash
cd 5521Project
npm install
npx hardhat compile
npx hardhat test
```

On Windows, if PowerShell blocks `npx.ps1`, use `npx.cmd hardhat test`.

A clean run ends with:

```text
  ERC20HTLC - MST escrow (Task A1/A3/A4/A5)
    A1: MST locking
      ...
  ETHHTLC - native ETH escrow (Task A2/A3/A4/A5)
    A2: ETH locking
      ...

  62 passing
```

Build output goes to `artifacts/` and `cache/`; both are git-ignored.

### 3. Run part of the suite

```bash
npx hardhat test test/ERC20HTLC.js     # MST side only
npx hardhat test test/ETHHTLC.js       # ETH side only
npx hardhat test --grep "A3"           # only the claim tests
```

### 4. Deploying is Task B

This snapshot deliberately ships no deploy script. Task B1 deploys `ERC20HTLC`
on Ethereum Sepolia and `ETHHTLC` on Arbitrum Sepolia; the addresses those
scripts print are the only addresses Part A's contracts ever need, and they go
into `.env` (see below).

## Filling in `.env`

`.env` is one file shared by Tasks A–C. No Part A test reads a value from it: the
tests run on the in-process Hardhat network with its default accounts, and only
the `sepolia` / `arbitrumSepolia` network entries in `hardhat.config.js` consume
`.env`. So **nothing in `.env` has to change for Part A to pass**. The table
records where every value comes from, so the same file stays correct as Tasks B
and C are added.

| Variable | Used by | Where the value comes from |
| --- | --- | --- |
| `SEPOLIA_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL` | network config | your Infura/Alchemy endpoint (already set) |
| `ALICE_PRIVATE_KEY`, `BOB_PRIVATE_KEY` | signing transactions | disposable testnet keys (already set; never commit) |
| `ALICE_ADDRESS`, `BOB_ADDRESS` | scripts, UI | addresses of those two keys (already set) |
| `MST_ADDRESS` | `ERC20HTLC.lock` | Lab 3 `MySimpleToken` deployment on Sepolia (already set) |
| `SEPOLIA_ERC20_HTLC_ADDRESS` | claim/refund scripts | printed by the B1 deploy of `ERC20HTLC` |
| `ARBITRUM_ETH_HTLC_ADDRESS` | claim/refund scripts | printed by the B1 deploy of `ETHHTLC` |
| `SWAP_PREIMAGE`, `SWAP_HASHLOCK` | both locks, both claims | generated by `npm run params` |
| `ERC20_SWAP_ID`, `ETH_SWAP_ID` | each lock | generated by `npm run params` |
| `ERC20_AMOUNT`, `ETH_AMOUNT`, `TIMELOCK_SECONDS` | demo scripts | chosen by the group (currently 100 MST / 0.001 ETH / 3600 s) |
| `ETHERSCAN_API_KEY` | optional source verification | your Etherscan key; may stay empty |

### Step 1 — generate the swap parameters

```bash
npm run params        # same as: node scripts/generateSwapParams.js
```

The script needs no network and prints four ready-to-paste lines; the values are
fresh on every run:

```text
SWAP_PREIMAGE=0x0987…       # 32-byte secret, keep private until the first claim
SWAP_HASHLOCK=0x0241…       # keccak256(preimage), used by BOTH locks
ERC20_SWAP_ID=0x7ea5…       # swap id for the MST lock
ETH_SWAP_ID=0xeec3…         # swap id for the ETH lock
```

### Step 2 — paste them into `.env`

Replace the four empty values:

```env
SWAP_PREIMAGE=0x0987…
SWAP_HASHLOCK=0x0241…
ERC20_SWAP_ID=0x7ea5…
ETH_SWAP_ID=0xeec3…
```

`SWAP_HASHLOCK` is computed as `keccak256(abi.encodePacked(preimage))`, exactly
as `HTLCBase.claim` checks it, which is why one hashlock line serves both chains.
The two swap ids are different because uniqueness is only required inside each
contract.

### Step 3 — paste the deployed addresses (Task B)

After B1 deploys the escrows, fill in:

```env
SEPOLIA_ERC20_HTLC_ADDRESS=0x…      # ERC20HTLC on Ethereum Sepolia
ARBITRUM_ETH_HTLC_ADDRESS=0x…       # ETHHTLC on Arbitrum Sepolia
```

Part A itself produces no address: it ends at compile + test.

### `.env` notes

* `.env` is git-ignored; private keys and the preimage must never be committed.
* Hardhat loads `.env` when the process starts, so restart any running script
  after editing it.
* Generate a fresh `npm run params` set for each demo run; an already-revealed
  preimage is public on-chain and must not be reused.

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
