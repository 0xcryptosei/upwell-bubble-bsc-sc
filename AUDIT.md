# Upwell contracts: internal audit (2026-11-26)

Scope: `RewardVault`, `UpwellStaking`, `CallLedger`, `UpwellBadges`, `scripts/deploy.js`, and the backend and frontend
code that talks to them (`backend/src/services/epochs.js`, `chain.js`, `leaderboard.js`; `src/lib/wallet.js`, `Rewards.jsx`).
Solidity 0.8.28, OpenZeppelin 5.6.1.

Method: two separate manual reviews (one independent, not shown the other's conclusions), then a test suite of
58 tests on a local Hardhat chain, including a randomised run of 1,000 actions checked after every step.

**This is an internal review, not a third-party audit.** Get an external audit before the vault holds real BNB.

## Test results

- 58 tests passing (`npm test`), covering every function, role check and revert path of all four contracts.
- Coverage (`npx hardhat coverage`): 100% of lines and functions in all four contracts; statements 94–100%; branches 88–95%.
- Randomised run (4 seeds × 250 steps: tax, closes with random winners, claims, stakes, withdrawals, direct BNB,
  split changes, 95-day jumps, recycling). After every step: the vault holds at least everything it owes,
  `reservedForClaims` equals what open weeks can still pay, and staking holds at least everything it owes.
- Attacks tested: re-entering `claim()` from a receiving contract (vault and staking), replaying a proof in another week,
  claiming with someone else's proof or a wrong amount, a faulty tree that sums to more than its allocation, duplicate
  closes, wallets that refuse BNB or burn all their gas, a staking contract that rejects deposits, just-in-time staking,
  forged / expired / replayed badge signatures, transferring soulbound badges.

## Findings

No Critical or High findings. All Medium and Low findings below are fixed and covered by tests unless marked.

| # | Severity | Finding | Status |
| --- | --- | --- | --- |
| S1 | High (found in the first review, before this audit) | Staking paid each weekly deposit at once: a just-in-time staker took 22.5 of 25 BNB; the first staker after a quiet week took everything. | Fixed: deposits stream over 7 days; unstaked time is queued. JIT staker now earns ~0.00004 BNB. |
| M1 | Medium | A failing staking contract, or a buyback / ops wallet that refuses BNB, made every weekly close revert. | Fixed: payouts never revert; failed amounts are held (`pendingStakerRewards`, `heldBuyback`, `heldOps`) and sent later (`flushStakerRewards`, `flushHeldPayouts`). Wallet calls get a fixed 100k gas so a gas-burning wallet cannot break the close. |
| M2 | Medium | The app sent every unclaimed week to `claimMany`; one expired, recycled or already-claimed week made the whole claim fail. An RPC error was treated as "not claimed". | Fixed (backend + app): only weeks the vault will pay now are claimable; unknown state is never offered. |
| M3 | Medium | A retried close after a lost receipt could close the vault twice, leaving a week whose proofs do not match. | Fixed: `closeEpoch(epoch, root, allocated)` requires `epoch == currentEpoch + 1`, so a duplicate always reverts. The backend also saves proofs before sending and resumes interrupted closes. |
| M4 | Medium | Key power: the operator (backend hot wallet) sets each week's callers' allocation; the admin can redirect wallets and change the split. The admin defaulted to the deployer key. | Partly addressed: mainnet deploy now requires an explicit `ADMIN` and refuses the deployer key unless `ALLOW_EOA_ADMIN=1`. **Open:** use a multisig admin, keep the operator key on the server only, and consider a timelock on `setWallets` / `setSplit`. The operator can never touch BNB already reserved for claims. |
| M5 | Medium | Flap may pay holder dividends to the staked $UPW held by the staking contract, which could not receive BNB. | Fixed: BNB sent to staking is queued into the next week's rewards. **Open:** check whether Flap's dividend contract pushes BNB (now handled) or needs a claim call (would need a small addition). |
| L1 | Low | Unallocated and recycled callers' BNB was re-split 60/25/10/5, so 40% of it left the callers' pool each week. | Fixed: kept in `callerCarry` and added to the next callers' pool only. |
| L2 | Low | `setClaimWindow` had no upper limit; a huge value would make every close revert. | Fixed: 7–365 days. |
| L3 | Low | Recycling an expired week was possible while claims were paused. | Fixed: `recycleExpired` is `whenNotPaused`. |
| L4 | Low | If the $UPW token ever charges the sender extra on transfers out of staking, the last withdrawals could fail. | Open (by design of the token): Flap tax applies to DEX trades; staking credits what actually arrives. Re-check if the token changes. |
| L5 | Low | `CallLedger.verifyCall/verifyStats` took a raw leaf hash, so an internal tree node could verify as a "call". | Fixed: they take the full record and hash it themselves. |
| L6 | Low | One unknown badge id failed a whole `mintBatch`. | Fixed: unknown and owned badges are skipped. |
| L7 | Low | The Phase 2 staking script needed the vault admin's key, which does not work with a multisig. | Fixed: with a multisig admin it only deploys and prints the calls to make. |
| L8 | Low | Claiming from a wallet other than the signed-in one failed with an unclear error. | Fixed: the app asks you to switch to the signed-in address. |
| I1 | Info | Staking rounding remainders and deposits under 1 wei/second were lost. | Fixed: carried into the next period. Per-update rounding leaves < 1 gwei. |
| I2 | Info | A pending close whose allocation no longer fits (e.g. the admin lowered the callers' split in between) cannot be resent. | Open: needs a manual decision; avoid changing the split while a close is pending. |
| I3 | Info | Badge signatures cannot be revoked before their deadline (except by revoking the signer). | Accepted: each badge mints once per wallet; keep deadlines short. |

## Checked and sound

Merkle leaf encodings match the backend exactly (tested with trees built by `@openzeppelin/merkle-tree`, as the
backend does); double-hashed leaves; proofs cannot cross weeks; accounting (`reservedForClaims`, carry, held
amounts) stays consistent under random actions; reentrancy is blocked on every path that sends BNB; casts to
uint128 / uint64 are bounded; pause never traps staked tokens or rewards; EIP-712 domain binds chain and contract;
OpenZeppelin ECDSA rejects malleable signatures; soulbound transfers and approvals revert; `claimMany` costs about
50k gas per week, fine for a year of weeks.

## Before mainnet

1. External audit of this exact code.
2. Deploy to BNB testnet; run a full week: tax in, automatic Monday close, claim from the app.
3. Multisig admin; operator key only on the server; small BNB float in the operator wallet for gas.
4. Arrange the $UPW tax forwarding from the Flap market wallet to the vault.
5. Confirm how Flap's dividend contract treats the staking contract (M5) before enabling staking.
