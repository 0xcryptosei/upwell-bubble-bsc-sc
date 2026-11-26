// Shared setup for the contract tests.
const { ethers, network } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')

const E = (n) => ethers.parseEther(String(n))
const DAY = 24 * 3600
const fmt = (w) => Number(ethers.formatEther(w))
const REWARD_LEAF = ['address', 'uint256', 'uint256'] // same as backend/src/services/epochs.js

async function wait(seconds) {
  await network.provider.send('evm_increaseTime', [Math.round(seconds)])
  await network.provider.send('evm_mine')
}
async function now() { return (await ethers.provider.getBlock('latest')).timestamp }

/** Merkle tree of [address, epoch, amountWei] rows, exactly as the backend builds it. */
function rewardTree(rows) { return StandardMerkleTree.of(rows.map(([a, e, w]) => [a, BigInt(e), w]), REWARD_LEAF) }
const proofOf = (tree, address) => { for (const [i, v] of tree.entries()) if (v[0] === address) return tree.getProof(i); throw new Error('not in tree') }

async function deployAll({ connectStaking = false, feeToken = false } = {}) {
  const signers = await ethers.getSigners()
  const [admin, operator, buyback, ops, alice, bob, carol, mallory] = signers
  const upw = await (await ethers.getContractFactory(feeToken ? 'FeeToken' : 'TestToken')).deploy()
  const vault = await (await ethers.getContractFactory('RewardVault')).deploy(admin.address, operator.address, ethers.ZeroAddress, buyback.address, ops.address)
  const staking = await (await ethers.getContractFactory('UpwellStaking')).deploy(await upw.getAddress(), admin.address, await vault.getAddress())
  if (connectStaking) await vault.setWallets(await staking.getAddress(), buyback.address, ops.address)
  const vaultAddr = await vault.getAddress(), stakingAddr = await staking.getAddress()
  const tax = (n, from = operator) => from.sendTransaction({ to: vaultAddr, value: typeof n === 'bigint' ? n : E(n) })
  const fund = async (who, n) => { await upw.mint(who.address, E(n)); await upw.connect(who).approve(stakingAddr, ethers.MaxUint256) }
  const bal = (a) => ethers.provider.getBalance(typeof a === 'string' ? a : a.address)
  return { signers, admin, operator, buyback, ops, alice, bob, carol, mallory, upw, vault, staking, vaultAddr, stakingAddr, tax, fund, bal }
}

/** Balance change of `who` from running fn(), with gas paid by `who` added back. */
async function received(who, fn) {
  const before = await ethers.provider.getBalance(who.address)
  const tx = await fn()
  const r = await tx.wait()
  const gas = r.from.toLowerCase() === who.address.toLowerCase() ? r.gasUsed * r.gasPrice : 0n
  return (await ethers.provider.getBalance(who.address)) - before + gas
}

/** The epoch number closeEpoch expects next. */
const nextEpoch = async (vault) => (await vault.currentEpoch()) + 1n

module.exports = { nextEpoch, E, DAY, fmt, wait, now, rewardTree, proofOf, deployAll, received, REWARD_LEAF }
