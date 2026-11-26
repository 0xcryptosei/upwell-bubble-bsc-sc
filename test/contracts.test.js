// Upwell contracts: vault flow with backend-made proofs, and staking rewards that follow time staked.
//   npx hardhat test
const assert = require('node:assert/strict')
const { ethers, network } = require('hardhat')
const { StandardMerkleTree } = require('@openzeppelin/merkle-tree')
const nextEpoch = async (v) => (await v.currentEpoch()) + 1n

const E = (n) => ethers.parseEther(String(n))
const DAY = 24 * 3600
const fmt = (w) => Number(ethers.formatEther(w))
async function wait(seconds) { await network.provider.send('evm_increaseTime', [seconds]); await network.provider.send('evm_mine') }
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(fmt(a) - b) <= tol, `${fmt(a)} is not ~${b}`)

async function deploy({ connectStaking = true } = {}) {
  const [admin, operator, buyback, ops, alice, bob, whale] = await ethers.getSigners()
  const upw = await (await ethers.getContractFactory('TestToken')).deploy()
  const vault = await (await ethers.getContractFactory('RewardVault')).deploy(admin.address, operator.address, ethers.ZeroAddress, buyback.address, ops.address)
  const staking = await (await ethers.getContractFactory('UpwellStaking')).deploy(await upw.getAddress(), admin.address, await vault.getAddress())
  if (connectStaking) await vault.setWallets(await staking.getAddress(), buyback.address, ops.address)
  const fund = async (who, n) => { await upw.mint(who.address, E(n)); await upw.connect(who).approve(await staking.getAddress(), E(n)) }
  const tax = (n) => operator.sendTransaction({ to: vault.getAddress(), value: E(n) })
  return { admin, operator, buyback, ops, alice, bob, whale, upw, vault, staking, fund, tax }
}

describe('RewardVault', () => {
  it('tax in, weekly close, callers claim with proofs built like the backend builds them', async () => {
    const { operator, alice, bob, vault, buyback, ops, tax } = await deploy({ connectStaking: false })
    await tax(10)
    // also accepts BNB sent with only 2300 gas (Solidity transfer), as some tax contracts do
    const s = await (await ethers.getContractFactory('Send2300')).deploy({ value: E(1) })
    await s.go(await vault.getAddress())
    const [inflow, callers] = await vault.preview()
    assert.equal(inflow, E(11)); assert.equal(callers, E(6.6))

    const tree = StandardMerkleTree.of([[alice.address, 1n, E(4)], [bob.address, 1n, E(2.6)]], ['address', 'uint256', 'uint256'])
    const b0 = await ethers.provider.getBalance(buyback.address), o0 = await ethers.provider.getBalance(ops.address)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), tree.root, E(6.6))
    assert.equal(await vault.currentEpoch(), 1n)
    assert.equal(await ethers.provider.getBalance(buyback.address) - b0, E(1.1))
    assert.equal(await ethers.provider.getBalance(ops.address) - o0, E(0.55))
    assert.equal(await vault.pendingStakerRewards(), E(2.75), 'stakers share is held in the vault until staking is connected')

    const before = await ethers.provider.getBalance(alice.address)
    const r = await (await vault.connect(alice).claimMany([1n], [E(4)], [tree.getProof(0)])).wait()
    assert.equal(await ethers.provider.getBalance(alice.address), before + E(4) - r.gasUsed * r.gasPrice)
    await assert.rejects(vault.connect(alice).claim(1n, E(4), tree.getProof(0)), /AlreadyClaimed/)
    await assert.rejects(vault.connect(bob).claim(1n, E(4), tree.getProof(1)), /InvalidProof/)
    await vault.connect(bob).claim(1n, E(2.6), tree.getProof(1))
    assert.equal(await vault.reservedForClaims(), 0n)
  })

  it('only the operator closes, and never for more than the callers share', async () => {
    const { operator, alice, vault, tax } = await deploy()
    await tax(10)
    await assert.rejects(vault.connect(alice).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n), /AccessControl/)
    await assert.rejects(vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.id('x'), E(6.01)), /AllocationTooHigh/)
  })
})

describe('UpwellStaking (rewards streamed over 7 days)', () => {
  it('a whale who stakes just before the deposit and leaves right after gets almost nothing', async () => {
    const { operator, alice, whale, vault, staking, fund, tax } = await deploy()
    await fund(alice, 1000); await staking.connect(alice).stake(E(1000))
    await fund(whale, 9000); await staking.connect(whale).stake(E(9000))
    await tax(100)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n) // 25 BNB to staking
    await staking.connect(whale).exit()
    const whaleGot = await staking.totalNotified() - (await staking.remainingRewards()) - (await staking.earned(alice.address))
    await wait(7 * DAY)
    near(await staking.earned(alice.address), 25, 0.001)
    console.log(`      whale (staked one block) earned ~${fmt(whaleGot).toFixed(6)} BNB; alice (stayed) earned ${fmt(await staking.earned(alice.address)).toFixed(4)} of 25 BNB`)
  })

  it('rewards follow stake and time: equal stakes split, a late staker gets only their share of the time', async () => {
    const { operator, alice, bob, vault, staking, fund, tax } = await deploy()
    await fund(alice, 100); await staking.connect(alice).stake(E(100))
    await tax(100); await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n) // 25 BNB over 7 days
    await wait(3.5 * DAY)
    await fund(bob, 100); await staking.connect(bob).stake(E(100))
    await wait(3.5 * DAY)
    near(await staking.earned(alice.address), 12.5 + 6.25, 0.01)
    near(await staking.earned(bob.address), 6.25, 0.01)
    const before = await ethers.provider.getBalance(bob.address)
    const r = await (await staking.connect(bob).claim()).wait()
    near((await ethers.provider.getBalance(bob.address)) - before + r.gasUsed * r.gasPrice, 6.25, 0.01)
  })

  it('BNB that arrives while nobody is staked is not grabbed by the first staker: it waits for the next week', async () => {
    const { operator, alice, vault, staking, fund, tax } = await deploy()
    await tax(100); await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n) // 25 BNB, nobody staked
    await fund(alice, 1); await staking.connect(alice).stake(E(1))
    near(await staking.earned(alice.address), 0, 0.001)
    await wait(1 * DAY)
    near(await staking.earned(alice.address), 25 / 7, 0.01) // only the time she was staked
    await wait(7 * DAY)
    // next week's deposit (the unused callers share rolls over too); the unpaid 25 x 6/7 is queued in with it
    await tax(4); await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n)
    await wait(7 * DAY)
    near(await staking.earned(alice.address), fmt(await staking.totalNotified()), 0.01) // she ends up with every BNB sent to staking
  })

  it('a new deposit mid-week adds to what is left, and the contract never owes more than it holds', async () => {
    const { operator, alice, bob, vault, staking, fund, tax } = await deploy()
    await fund(alice, 50); await staking.connect(alice).stake(E(50))
    await fund(bob, 150); await staking.connect(bob).stake(E(150))
    await tax(40); await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n) // 10
    await wait(2 * DAY)
    await tax(40); await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.ZeroHash, 0n) // +10
    await wait(10 * DAY)
    const a = await staking.earned(alice.address), b = await staking.earned(bob.address)
    const total = fmt(await staking.totalNotified())
    near(a + b, total, 0.001)
    near(a, total / 4, 0.001); near(b, total * 3 / 4, 0.001)
    assert.ok(a + b <= await ethers.provider.getBalance(await staking.getAddress()))
    await staking.connect(alice).exit(); await staking.connect(bob).exit()
  })
})
