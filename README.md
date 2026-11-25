# COMP5521 2026 Project — cross-chain HTLC swap

Implementation of **Task A (HTLC smart contracts, 25 marks)** and
**Task B (cross-chain protocol and scripts, 20 marks)** of
`COMP5521_HTLC_Project_2026.pdf`. Task C (browser UI) builds on the scripts and
contracts described here.

| Task | Deliverable | Status |
| --- | --- | --- |
| A | `ERC20HTLC` (MST on Ethereum Sepolia) + `ETHHTLC` (native ETH on Arbitrum Sepolia) | implemented, 62 tests |
| B | deploy + configuration check, swap coordinator, cross-chain observer, timeout recovery | implemented, 16 tests |

78 tests pass locally (`npx hardhat test`). No test or script needs a public
testnet except the deployment/swap commands themselves.

## Project layout

```text
contracts/
  HTLCBase.sol              shared lock / claim / refund state machine
  ERC20HTLC.sol             MST escrow (ERC20 path), Ethereum Sepolia
  ETHHTLC.sol               native ETH escrow, Arbitrum Sepolia
  mocks/                    local test helpers (TestMST, re-entrant/rejecting recipients)
scripts/
  lib/config.js             chains, roles, timings, address/URL masking
  lib/chain.js              one handle per chain: provider, contracts, signers
  lib/artifacts.js          reads ABIs from artifacts/
  lib/swapState.js          swap decoding and state labels
  lib/tx.js                 submit + wait for confirmations, parse events
  lib/protocol.js           lock / verify / claim / refund / observe (chain-agnostic)
  lib/deploy.js             deploy one escrow and record its address
  lib/envFile.js            in-place .env updates that keep every other line
  lib/ui.js                 ASCII console output
  deployERC20HTLC.js        B1: deploy ERC20HTLC on Sepolia
  deployETHHTLC.js          B1: deploy ETHHTLC on Arbitrum Sepolia
  checkConfig.js            B1: verify RPC, chain ids, addresses, balances, hashlock
  swap.js                   B2: the full reproducible swap
  status.js                 B3: independent state of both legs
  claim.js                  claim, only while a claim is the valid action
  refund.js                 B4: refund expired locks (optionally waiting for expiry)
  generateSwapParams.js     prints .env values for a swap without deploying
test/
  ERC20HTLC.js              A1 / A3 / A4 / A5
  ETHHTLC.js                A2 / A3 / A4 / A5
  CrossChainProtocol.js     B2 / B3 / B4 coordinator logic
  helpers.js                fixtures and constants
hardhat.config.js           Solidity 0.8.20, Sepolia + Arbitrum Sepolia
```

## Design: two self-contained escrows (Task A)

`HTLCBase` holds everything protocol-related: the swap record, the state
machine, the preimage check, access control, events and errors. The concrete
contracts only decide how the asset enters and leaves the escrow. Both deployed
contracts are independent; `HTLCBase` itself is never deployed.

```text
                     claim()            claim() / refund()
 None ──lock()──► Active ──────► Claimed ─────────────────► (terminal)
                    │
                    │ refund()
                    └──────────► Refunded ─────────────────► (terminal)
```

* A swap leaves `Active` exactly once, so a claim and a refund can never both
  succeed (`SwapNotActive`).
* `claim` is valid only while `block.timestamp < timelock`; `refund` only when
  `block.timestamp >= timelock`. At the timelock instant claim reverts and
  refund succeeds — the two windows touch but never overlap.
* `swapId` is caller-supplied and unique inside one contract
  (`SwapAlreadyExists`). Task B generates it off-chain, so both chains can name
  the same swap without either contract reading the other.

API:

```solidity
// ERC20HTLC (Sepolia)
function lock(bytes32 swapId, address token, address recipient, uint256 amount,
              bytes32 hashlock, uint256 timelock) external returns (bytes32);
// ETHHTLC (Arbitrum Sepolia)
function lock(bytes32 swapId, address recipient, bytes32 hashlock, uint256 timelock)
    external payable returns (bytes32);
// both
function claim(bytes32 swapId, bytes32 preimage) external;   // recipient, before expiry
function refund(bytes32 swapId) external;                    // sender, at/after expiry
function getSwap(bytes32 swapId) external view returns (Swap memory);
function isClaimable(bytes32 swapId) external view returns (bool);
function isRefundable(bytes32 swapId) external view returns (bool);

event Locked(bytes32 indexed swapId, address indexed sender, address indexed recipient,
             address token, uint256 amount, bytes32 hashlock, uint256 timelock);
event Claimed(bytes32 indexed swapId, bytes32 preimage);
event Refunded(bytes32 indexed swapId);
```

Safety (A5): validated id/recipient/token/amount/hashlock/timelock; duplicate
rejection; checks-effects-interactions before every transfer; `nonReentrant` on
all entry points; `SafeERC20`; ETH paid by `call` with `EthTransferFailed` (a
failed payout leaves the swap refundable); no `receive()`, so stray ETH reverts.

## Task B: how the swap is coordinated

The two chains never talk to each other. The coordinator reads each chain's
public state and carries the preimage from one chain to the other:

```text
off-chain: s = random 32 bytes        H = keccak256(abi.encodePacked(s))      swapIds = random

Ethereum Sepolia (ERC20HTLC)                     Arbitrum Sepolia (ETHHTLC)
────────────────────────────                     ────────────────────────────────
1. alice approves MST
2. alice locks 100 MST for bob, deadline T_mst
                                                  3. coordinator verifies lock #2,
                                                     bob locks ETH for alice,
                                                     deadline T_eth
                                                  4. alice claims ETH before T_eth
                                                     -> Claimed event publishes s
5. coordinator reads s from the ETH claim,
   bob claims MST before T_mst
```

Roles are fixed in `scripts/lib/config.js`: **alice** sends MST and receives
ETH; **bob** sends ETH and receives MST — the same roles as Lab 4.

### Timelock ordering

The MST leg is created first, so it must stay claimable longer than the ETH leg:

```text
T_mst = MST chain time + TIMELOCK_SECONDS + TIMELOCK_MARGIN_SECONDS
T_eth = ETH chain time + TIMELOCK_SECONDS
```

Each deadline is computed from its own chain's clock, because the two chains are
independent. The margin guarantees that after alice reveals `s` by claiming ETH,
bob still has time to use `s` on Sepolia. If bob never locks, alice refunds after
`T_mst`; if alice never claims, bob refunds after `T_eth`.

### Mapping to the marking scheme

| Item | Where | What it does |
| --- | --- | --- |
| B1 deployment and configuration | `deployERC20HTLC.js`, `deployETHHTLC.js`, `checkConfig.js`, `lib/chain.js` | deploys the right contract on the right chain, enforces the chain id, records addresses in `.env`, never prints keys, masks RPC URLs |
| B2 successful swap | `swap.js`, `lib/protocol.js` (`executeSwap`) | generates secret/hashlock, approves + locks MST, verifies the stored lock (7 fields), locks ETH, verifies it, claims ETH, reads the preimage from the claim event, claims MST, waits for confirmations, reports every hash + explorer link |
| B3 cross-chain state observation | `status.js`, `lib/protocol.js` (`observe`, `validActions`), `lib/swapState.js` | one independent read per chain: block number/timestamp, state, claimable/expired/refundable window, valid actions, balances, plus an explicitly off-chain consistency check |
| B4 timeout recovery | `refund.js`, `lib/protocol.js` (`refundSide`) | reads the swap first, requires expiry and the original sender, refuses with the reason otherwise; `--wait` polls until expiry |

Every transaction goes through `lib/tx.js`, which waits for
`CONFIRMATIONS` blocks and returns hash, block number, gas and explorer URL.
Refusals are typed (`ProtocolRefusal`, `code = "INVALID_ACTION"`) so the CLIs can
report "this action is not valid now" instead of failing.

## Running it

Prerequisites: Node.js 20+ and npm. Task B additionally needs RPC endpoints and
funded disposable testnet accounts, which `5521Project/.env` already documents.

```bash
cd 5521Project
npm install
npx hardhat compile
npx hardhat test
```

On Windows, if PowerShell blocks `npx.ps1`, use `npx.cmd` instead of `npx`.
The suite is offline: it deploys local tokens/escrows on the in-process Hardhat
network. A clean run ends with `78 passing`.

## Deploying and operating on the testnets

### 1. Deploy (B1)

```bash
npm run deploy:sepolia     # ERC20HTLC on Ethereum Sepolia
npm run deploy:arbitrum    # ETHHTLC on Arbitrum Sepolia
# or both: npm run deploy
```

Each script prints the address, tx hash, block and explorer link, and writes
`SEPOLIA_ERC20_HTLC_ADDRESS` / `ARBITRUM_ETH_HTLC_ADDRESS` into `.env`
(`--no-save-env` disables that). The deployer defaults to alice; use
`--account bob` if only bob is funded on a chain. The RPC's chain id is checked
against the expected one (11155111 / 421614) before anything is sent.

### 2. Check the configuration (B1)

```bash
npm run check              # human output, exit code 1 on any problem
npm run check -- --json
```

Verifies both RPCs, chain ids, deployed code at every address, the Lab 3
`MST_ADDRESS`, the two accounts (key/address agreement, ETH and MST balances),
the timelock settings and that `SWAP_PREIMAGE` hashes to `SWAP_HASHLOCK`. Run it
right before a demo.

### 3. Run the swap (B2)

```bash
npm run swap
npm run swap -- --mst-amount 100 --eth-amount 0.001 --timelock 600
```

The command generates a fresh preimage, performs the five transactions
(approve, lock MST, lock ETH, claim ETH, claim MST), verifies both locks by
reading them back, waits for confirmations and prints a report with every hash,
block and explorer link for both networks. It writes the preimage, hashlock and
both swap ids to `.env` (`--no-save-env` disables that). Use `--preimage` to reuse
a known secret instead of generating one.

Because the deadlock-free ordering matters, the MST deadline gets
`TIMELOCK_MARGIN_SECONDS` extra time over the ETH deadline.

### 4. Observe both chains (B3)

```bash
npm run status
npm run status -- --json
npm run status -- --chain sepolia --erc20-swap-id 0x...
```

Each section is a separate RPC read of that chain's own contract: block number
and timestamp, raw state, claimable/expired/refundable window, amount, sender,
recipient, timelock, and the actions that are valid right now. The final section
compares the two readings (same hashlock, mirrored roles) and says explicitly
that the comparison happens off-chain.

### 5. Claims and timeout recovery (B4)

```bash
npm run claim                  # only while claimable; refuses otherwise with the reason
npm run claim -- --chain arbitrum
npm run refund                 # only after expiry; refuses before it
npm run refund -- --wait       # poll until the timelock expires, then refund
```

To demonstrate the failure path, create locks without claiming:

```bash
npm run swap -- --timelock 120 --margin 60 --stop-after-lock
npm run status                 # Active, claimable, "expires in ..."
npm run refund                 # refuses: still claimable, refund unlocks at ...
npm run claim                  # after expiry this refuses too: "only refund is valid now"
npm run refund                 # refunds both legs, each signed by its original sender
```

`refund.js` chooses the signer from the swap's `sender` field, so the MST leg is
refunded by alice and the ETH leg by bob — the only addresses the contracts
accept.

## Filling in `.env`

`.env` is shared by Tasks A–C and is git-ignored. The Task A tests do not read
it; only the network entries in `hardhat.config.js` and the Task B scripts do.

| Variable | Used by | Where the value comes from |
| --- | --- | --- |
| `SEPOLIA_RPC_URL`, `ARBITRUM_SEPOLIA_RPC_URL` | all Task B scripts | your Infura/Alchemy endpoint (already set) |
| `ALICE_PRIVATE_KEY`, `BOB_PRIVATE_KEY` | signing | disposable testnet keys (already set; never commit) |
| `ALICE_ADDRESS`, `BOB_ADDRESS` | roles, explorer labels | must equal the addresses derived from those keys (checked) |
| `MST_ADDRESS` | MST lock | Lab 3 `MySimpleToken` on Sepolia (already set) |
| `SEPOLIA_ERC20_HTLC_ADDRESS` | MST leg | written by `npm run deploy:sepolia` |
| `ARBITRUM_ETH_HTLC_ADDRESS` | ETH leg | written by `npm run deploy:arbitrum` |
| `SWAP_PREIMAGE`, `SWAP_HASHLOCK` | both legs | written by `npm run swap` (or `npm run params`) |
| `ERC20_SWAP_ID`, `ETH_SWAP_ID` | both legs | written by `npm run swap` |
| `ERC20_AMOUNT`, `ETH_AMOUNT` | demo amounts | chosen by the group (100 MST / 0.001 ETH) |
| `TIMELOCK_SECONDS` | both deadlines | chosen by the group (default 3600) |
| `TIMELOCK_MARGIN_SECONDS` | extra time on the MST leg | default 600; keeps the first leg alive longer |
| `CONFIRMATIONS` | every transaction | default 1; raise it for a slower but safer demo |
| `ETHERSCAN_API_KEY` | optional verification | may stay empty |

Swap parameters can also be produced without deploying:

```bash
npm run params             # prints SWAP_PREIMAGE / SWAP_HASHLOCK / both swap ids
```

## Test coverage

`npx hardhat test` → **78 passing**.

| Area | Tests |
| --- | --- |
| A1 MST lock | escrow + record, event, duplicate id, zero id/recipient/token/amount/hashlock, past timelock, allowance, empty balance |
| A2 ETH lock | `msg.value` recorded, `token == 0`, event, zero-value lock, duplicate/invalid, plain ETH rejected |
| A3 claim | payment, preimage event, `timelock - 1` boundary, wrong role/secret/id, at/after expiry, double claim, claim after refund, re-entrancy blocked, failed payout leaves the swap refundable |
| A4 refund | exact timelock boundary, after expiry, early refund, non-sender, double refund, refund after claim |
| A5 views | `getSwap`, `isClaimable`/`isRefundable` across states |
| B2 | full swap orchestration, transaction hashes/confirmations, parameter verification, asset movement, tampered-lock rejection |
| B3 | per-chain state labels, valid actions, unknown swap, off-chain comparison |
| B4 | stop-after-lock, claim refused after expiry, refund refused before expiry, refund refused after claim, both legs refunded and balances restored, duplicate claim refused |
| Utility | `.env` writer preserves comments and unrelated keys |

The Task B tests run two escrows on the local Hardhat network and drive the same
`lib/protocol.js` functions the CLIs use. The CLIs themselves were exercised
end-to-end against two local nodes reporting chain ids 11155111 and 421614, so
the deploy → swap → status → refund paths run unchanged offline.

## Notes and limitations

* The contracts have no bridge, oracle, relayer or cross-chain messaging. Both
  legs are independent escrows; coordination is off-chain.
* Deadlines are absolute Unix timestamps computed per chain; the MST leg gets the
  margin so the party that reveals the preimage can still claim on Sepolia.
* `ERC20HTLC` records the token per swap rather than at deploy time, so the Lab 3
  MST address is configuration, not a constructor argument.
* Gas is not sponsored: alice needs Sepolia ETH (approve/lock/claim) and Arbitrum
  ETH (claim), bob needs Sepolia ETH (claim) and Arbitrum ETH (lock).
* A swap that is never claimed is recovered by its sender through `refund`; the
  contracts cannot push funds back on their own.

## Next: Task C

The UI can call the same functions the scripts use (`lock`, `getSwap`,
`isClaimable`, `isRefundable`, `claim`, `refund`) through a wallet, and read
`.env`-style configuration from a build-time config file. The coordinator logic
in `scripts/lib/protocol.js` — parameter verification, preimage extraction from
the `Claimed` event and the valid-action checks — maps one-to-one onto the
guided UI flow.
