# Upwell contracts (BNB Chain)

Solidity 0.8.28 · OpenZeppelin 5.6 · Hardhat 2. **Not deployed yet.** 58 tests on a local Hardhat chain (`npm test`), 100% line coverage (`npx hardhat coverage`). Internal audit: [AUDIT.md](AUDIT.md).
These contracts will hold real money: get them audited before mainnet.

```bash
npm install
npm run build        # compiles to artifacts/
npm test             # all tests on a local chain
npx hardhat coverage # coverage report
```

## Contracts

| Contract | What it does |
| --- | --- |
| `RewardVault` | Receives BNB (the $UPW tax). Once a week the operator calls `closeEpoch(epoch, root, allocated)` (epoch must be the next one, so a duplicate reverts): the BNB that arrived since the last close is split 60% callers / 25% stakers / 10% buyback & burn / 5% operations. Callers claim their share with a Merkle proof (`claim`, `claimMany`). Unallocated caller BNB stays with callers (`callerCarry`) and is added to next week's pool. Payouts to staking and the wallets never block a close: failed amounts are held and sent later. Unclaimed BNB can be recycled after `claimWindow` (90 days). Until staking exists, the stakers' 25% is held in the vault (`pendingStakerRewards`). |
| `UpwellStaking` | Phase 2. Stake $UPW, earn BNB from the vault. No lock. Each weekly deposit is paid out evenly over the next 7 days to whoever is staked, pro rata, so rewards follow time staked: staking just before a deposit and leaving right after earns almost nothing, and BNB that arrives while nobody is staked cannot be grabbed by the next staker (it is queued into the next week). Handles fee-on-transfer tokens. |
| `CallLedger` | One Merkle root per week of every judged call, plus a root of every caller's stats. Roots are immutable, so any call or record can be proven on-chain without paying gas per call. |
| `UpwellBadges` | Soulbound ERC-1155 badges (ids 1–9). Minted by the backend, or claimed by the caller with an EIP-712 signature from the backend. Transfers and approvals revert. Not used by the app yet. |

$UPW itself is a Flap.sh tax token, so there is no token contract here.

## Getting the tax into the vault

Flap's own contracts handle the $UPW tax: part goes to the token's "market" wallet, part to Flap's holder dividend
contract. Flap owns those contracts, so the vault cannot be set as the recipient. The market wallet must forward
its BNB to the vault (before each Monday close) for the vault to have anything to pay.

## Roles

- **Admin** (`DEFAULT_ADMIN_ROLE`): changes split, wallets, claim window, pause. Use a multisig on mainnet.
- **Operator** (`OPERATOR_ROLE` on the vault, `PUBLISHER_ROLE` on the ledger, `MINTER_ROLE` on badges): the backend's hot wallet (`OPERATOR_KEY`). It decides one week's callers' share at a time; it cannot touch BNB already reserved for claims.
- **Vault** (`NOTIFIER_ROLE` on staking): only the vault can push rewards into staking.

## Merkle leaves (must match `backend/src/services/epochs.js`)

All trees are OpenZeppelin `StandardMerkleTree` (double-hashed leaves).

- Rewards: `(address account, uint256 epoch, uint256 amount)`
- Calls: `(uint256 callId, address caller, address token, uint8 window, uint256 entryMcapCents, uint256 exitMcapCents, uint64 startAt, uint64 endAt, bool won)` with window 0 = 1h, 1 = 24h, 2 = 7d
- Stats: `(address caller, uint256 epoch, uint256 calls, uint256 wins, uint256 bestMultipleBps, uint256 score, uint256 xp)`

## Deploying (testnet first)

Launch: RewardVault + CallLedger (+ UpwellBadges unless `DEPLOY_BADGES=0`). Staking stays off.

```bash
DEPLOYER_KEY=0x... OPERATOR=0x<backend wallet> BUYBACK_WALLET=0x... OPS_WALLET=0x... ADMIN=0x<multisig> npm run deploy:testnet
```

Then in `backend/.env`: `VAULT_ADDRESS`, `LEDGER_ADDRESS`, `BSC_RPC_URL`, `OPERATOR_KEY`, and `SEASON_START` = the Monday
the vault goes live (the first weekly close covers every finished week since `SEASON_START`). Fund the operator
wallet with a little BNB for gas. Do not close weeks off-chain before the vault is configured: the backend's
week numbers must match the vault's.

Phase 2, staking on (run by the vault admin):

```bash
VAULT=0x<RewardVault> UPW_TOKEN=0x<$UPW> DEPLOYER_KEY=0x<admin key> npm run deploy:staking:testnet
```

It deploys `UpwellStaking`, points the vault at it and forwards the held stakers' share (streamed over 7 days).

## Not done yet

- A security audit.
- Buyback & burn is a wallet, not an automated swap contract.
- Forwarding the tax from the Flap market wallet to the vault (manual, or a small script).
