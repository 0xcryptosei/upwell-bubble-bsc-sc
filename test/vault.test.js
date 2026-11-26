// RewardVault: every function, role check and revert path.
const assert = require('node:assert/strict')
const { ethers } = require('hardhat')
const { E, DAY, wait, now, rewardTree, proofOf, deployAll, received, nextEpoch } = require('./fixtures')

const ZERO = ethers.ZeroHash

describe('RewardVault · deployment and funding', () => {
  it('sets roles, wallets and defaults', async () => {
    const { admin, operator, buyback, ops, vault } = await deployAll()
    assert.ok(await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), admin.address))
    assert.ok(await vault.hasRole(await vault.OPERATOR_ROLE(), operator.address))
    assert.ok(!(await vault.hasRole(await vault.OPERATOR_ROLE(), admin.address)))
    assert.equal(await vault.buybackWallet(), buyback.address)
    assert.equal(await vault.opsWallet(), ops.address)
    assert.equal(await vault.staking(), ethers.ZeroAddress)
    assert.equal(await vault.claimWindow(), BigInt(90 * DAY))
    const s = await vault.split()
    assert.deepEqual([s.callers, s.stakers, s.buyback, s.ops].map(Number), [6000, 2500, 1000, 500])
  })

  it('rejects zero addresses in the constructor', async () => {
    const [a, b, c, d] = await ethers.getSigners()
    const V = await ethers.getContractFactory('RewardVault')
    const Z = ethers.ZeroAddress
    for (const args of [[Z, b, Z, c, d], [a, Z, Z, c, d], [a, b, Z, Z, d], [a, b, Z, c, Z]]) {
      await assert.rejects(V.deploy(...args.map((x) => (typeof x === 'string' ? x : x.address))), /ZeroAddress/)
    }
  })

  it('accepts BNB from anyone (also with the 2300-gas stipend) and emits Funded', async () => {
    const { vault, vaultAddr, alice, tax } = await deployAll()
    const tx = await tax(1, alice)
    const r = await tx.wait()
    const ev = r.logs.map((l) => vault.interface.parseLog(l)).find((x) => x?.name === 'Funded')
    assert.equal(ev.args.from, alice.address); assert.equal(ev.args.amount, E(1))
    const s = await (await ethers.getContractFactory('Send2300')).deploy({ value: E(2) })
    await s.go(vaultAddr)
    assert.equal(await ethers.provider.getBalance(vaultAddr), E(3))
  })

  it('preview splits 60/25/10/5 with rounding dust going to callers', async () => {
    const { vault, tax } = await deployAll()
    await tax(7n) // 7 wei
    const [inflow, callers, stakers, buyback, ops] = await vault.preview()
    assert.equal(inflow, 7n); assert.equal(stakers + buyback + ops + callers, 7n)
    assert.equal(stakers, 1n); assert.equal(buyback, 0n); assert.equal(ops, 0n); assert.equal(callers, 6n)
  })
})

describe('RewardVault · closeEpoch', () => {
  it('only the operator can close; closing while paused reverts', async () => {
    const { vault, admin, operator, alice, tax } = await deployAll()
    await tax(1)
    await assert.rejects(vault.connect(alice).closeEpoch(await nextEpoch(vault), ZERO, 0), /AccessControlUnauthorizedAccount/)
    await assert.rejects(vault.connect(admin).closeEpoch(await nextEpoch(vault), ZERO, 0), /AccessControlUnauthorizedAccount/)
    await vault.connect(admin).pause()
    await assert.rejects(vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0), /EnforcedPause/)
    await vault.connect(admin).unpause()
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
  })

  it('rejects an allocation without a root, and more than the callers share', async () => {
    const { vault, operator, tax } = await deployAll()
    await tax(10)
    await assert.rejects(vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 1), /EmptyRoot/)
    await assert.rejects(vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.id('r'), E(6) + 1n), /AllocationTooHigh/)
  })

  it('records the epoch, reserves the claims, pays buyback and ops, holds stakers share, emits EpochClosed', async () => {
    const { vault, operator, buyback, ops, alice, tax, bal } = await deployAll()
    await tax(10)
    const tree = rewardTree([[alice.address, 1, E(5)]])
    const b0 = await bal(buyback), o0 = await bal(ops)
    const tx = await vault.connect(operator).closeEpoch(await nextEpoch(vault), tree.root, E(5))
    const ts = await now()
    const ev = (await tx.wait()).logs.map((l) => vault.interface.parseLog(l)).find((x) => x?.name === 'EpochClosed')
    assert.deepEqual([ev.args.epoch, ev.args.inflow, ev.args.callerAllocated, ev.args.toStakers, ev.args.toBuyback, ev.args.toOps], [1n, E(10), E(5), E(2.5), E(1), E(0.5)])
    const e = await vault.epochs(1)
    assert.equal(e.root, tree.root); assert.equal(e.allocated, E(5)); assert.equal(e.claimed, 0n)
    assert.equal(e.closedAt, BigInt(ts)); assert.equal(e.claimDeadline, BigInt(ts + 90 * DAY)); assert.equal(e.recycled, false)
    assert.equal(await vault.currentEpoch(), 1n)
    assert.equal(await vault.reservedForClaims(), E(5))
    assert.equal(await vault.pendingStakerRewards(), E(2.5))
    assert.equal((await bal(buyback)) - b0, E(1)); assert.equal((await bal(ops)) - o0, E(0.5))
    // the 1 BNB of the callers share that was not allocated stays with callers for next week
    assert.equal(await vault.unallocated(), 0n)
    assert.equal(await vault.callerCarry(), E(1))
  })

  it('an empty week keeps the whole callers share for callers: nothing of it leaks to the other shares', async () => {
    const { vault, operator, buyback, tax, bal } = await deployAll()
    await tax(10)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await vault.callerCarry(), E(6))
    await tax(10)
    const [inflow, callers, stakers, bb] = await vault.preview()
    assert.equal(inflow, E(10)) // only the new BNB is split again
    assert.equal(callers, E(12)); assert.equal(stakers, E(2.5)); assert.equal(bb, E(1))
    const b0 = await bal(buyback)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ethers.id('r'), E(12)) // all of it can be given out
    assert.equal((await bal(buyback)) - b0, E(1))
    assert.equal(await vault.callerCarry(), 0n)
  })

  it('a close with no new BNB works and pays nothing', async () => {
    const { vault, operator } = await deployAll()
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await vault.currentEpoch(), 2n)
  })

  it('with staking connected, the stakers share is sent to staking at close', async () => {
    const { vault, staking, stakingAddr, operator, tax, bal } = await deployAll({ connectStaking: true })
    await tax(4)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await bal(stakingAddr), E(1)); assert.equal(await staking.totalNotified(), E(1))
    assert.equal(await vault.pendingStakerRewards(), 0n)
  })

  it('a wallet that refuses BNB does not block the close: its share is held and sent once fixed', async () => {
    const { vault, admin, operator, buyback, ops, alice, tax, bal } = await deployAll()
    const reject = await (await ethers.getContractFactory('RejectBNB')).deploy()
    await vault.connect(admin).setWallets(ethers.ZeroAddress, await reject.getAddress(), ops.address)
    await tax(10)
    const o0 = await bal(ops)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await vault.currentEpoch(), 1n)
    assert.equal(await vault.heldBuyback(), E(1)); assert.equal(await vault.heldOps(), 0n)
    assert.equal((await bal(ops)) - o0, E(0.5))
    assert.equal(await vault.unallocated(), 0n, 'held BNB is not re-split')
    await assert.rejects(vault.connect(alice).flushHeldPayouts(), /AccessControlUnauthorizedAccount/)
    await vault.connect(admin).setWallets(ethers.ZeroAddress, buyback.address, ops.address)
    const b0 = await bal(buyback)
    await vault.connect(operator).flushHeldPayouts()
    assert.equal((await bal(buyback)) - b0, E(1)); assert.equal(await vault.heldBuyback(), 0n)
  })

  it('a wallet that burns all its gas cannot make the close run out of gas', async () => {
    const { vault, admin, operator, ops, tax } = await deployAll()
    const burner = await (await ethers.getContractFactory('GasBurner')).deploy()
    await vault.connect(admin).setWallets(ethers.ZeroAddress, await burner.getAddress(), ops.address)
    await tax(10)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0, { gasLimit: 400_000 })
    assert.equal(await vault.currentEpoch(), 1n); assert.equal(await vault.heldBuyback(), E(1))
  })

  it('a staking contract that rejects the deposit does not block the close: the stakers share is held', async () => {
    const { vault, admin, operator, buyback, ops, upw, tax } = await deployAll()
    // staking deployed without the vault as notifier: notifyRewardAmount reverts
    const bad = await (await ethers.getContractFactory('UpwellStaking')).deploy(await upw.getAddress(), admin.address, ethers.ZeroAddress)
    await vault.connect(admin).setWallets(await bad.getAddress(), buyback.address, ops.address)
    await tax(4)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await vault.pendingStakerRewards(), E(1))
    await bad.connect(admin).grantRole(await bad.NOTIFIER_ROLE(), await vault.getAddress())
    await vault.connect(operator).flushStakerRewards()
    assert.equal(await vault.pendingStakerRewards(), 0n); assert.equal(await bad.totalNotified(), E(1))
  })

  it('a resent or duplicate close reverts: the epoch number must be the next one', async () => {
    const { vault, operator, tax } = await deployAll()
    await tax(10)
    await assert.rejects(vault.connect(operator).closeEpoch(2, ZERO, 0), /WrongEpoch/)
    await assert.rejects(vault.connect(operator).closeEpoch(0, ZERO, 0), /WrongEpoch/)
    await vault.connect(operator).closeEpoch(1, ZERO, 0)
    await assert.rejects(vault.connect(operator).closeEpoch(1, ZERO, 0), /WrongEpoch/)
    assert.equal(await vault.currentEpoch(), 1n)
  })
})

describe('RewardVault · claims', () => {
  async function closedWeek() {
    const f = await deployAll()
    await f.tax(10)
    const tree = rewardTree([[f.alice.address, 1, E(4)], [f.bob.address, 1, E(2)]])
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), tree.root, E(6))
    return { ...f, tree }
  }

  it('pays the exact amount once; canClaim matches', async () => {
    const { vault, alice, tree } = await closedWeek()
    const p = proofOf(tree, alice.address)
    assert.equal(await vault.canClaim(1, alice.address, E(4), p), true)
    assert.equal(await received(alice, () => vault.connect(alice).claim(1, E(4), p)), E(4))
    assert.equal(await vault.hasClaimed(1, alice.address), true)
    assert.equal(await vault.canClaim(1, alice.address, E(4), p), false)
    await assert.rejects(vault.connect(alice).claim(1, E(4), p), /AlreadyClaimed/)
    assert.equal(await vault.reservedForClaims(), E(2))
    assert.equal((await vault.epochs(1)).claimed, E(4))
  })

  it('rejects a wrong amount, someone else\'s proof, an unknown epoch and an empty-root epoch', async () => {
    const { vault, operator, alice, bob, mallory, tree } = await closedWeek()
    const pa = proofOf(tree, alice.address)
    await assert.rejects(vault.connect(alice).claim(1, E(5), pa), /InvalidProof/)
    await assert.rejects(vault.connect(mallory).claim(1, E(4), pa), /InvalidProof/)
    await assert.rejects(vault.connect(bob).claim(1, E(4), pa), /InvalidProof/)
    await assert.rejects(vault.connect(alice).claim(2, E(4), pa), /UnknownEpoch/)
    await assert.rejects(vault.connect(alice).claim(0, E(4), pa), /UnknownEpoch/)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0) // epoch 2, no winners
    await assert.rejects(vault.connect(alice).claim(2, E(4), pa), /UnknownEpoch/)
    assert.equal(await vault.canClaim(2, alice.address, E(4), pa), false)
  })

  it('a proof for epoch 1 cannot be replayed for epoch 2 (the epoch is in the leaf)', async () => {
    const { vault, operator, alice, tax, tree } = await closedWeek()
    await tax(10)
    const tree2 = rewardTree([[alice.address, 2, E(4)]])
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), tree2.root, E(4))
    await assert.rejects(vault.connect(alice).claim(2, E(4), proofOf(tree, alice.address)), /InvalidProof/)
    await vault.connect(alice).claim(2, E(4), proofOf(tree2, alice.address))
  })

  it('an intermediate tree node cannot be claimed as a leaf (double-hashed leaves)', async () => {
    const { vault, alice, tree } = await closedWeek()
    // the parent of the two leaves, presented as (address, epoch, amount), would need a second preimage;
    // the closest attempt (the sibling hash as proof, nothing as leaf) is rejected
    await assert.rejects(vault.connect(alice).claim(1, 0, []), /InvalidProof/)
    assert.equal(tree.length, 2)
  })

  it('claims close after the 90-day window; claiming while paused reverts', async () => {
    const { vault, admin, alice, bob, tree } = await closedWeek()
    await vault.connect(admin).pause()
    await assert.rejects(vault.connect(alice).claim(1, E(4), proofOf(tree, alice.address)), /EnforcedPause/)
    await vault.connect(admin).unpause()
    await wait(90 * DAY - 60)
    await vault.connect(alice).claim(1, E(4), proofOf(tree, alice.address))
    await wait(120)
    await assert.rejects(vault.connect(bob).claim(1, E(2), proofOf(tree, bob.address)), /EpochExpired/)
    assert.equal(await vault.canClaim(1, bob.address, E(2), proofOf(tree, bob.address)), false)
  })

  it('claimMany pays several weeks in one transaction and is all-or-nothing', async () => {
    const { vault, operator, alice, tax, tree } = await closedWeek()
    await tax(10)
    const tree2 = rewardTree([[alice.address, 2, E(3)]])
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), tree2.root, E(3))
    const p1 = proofOf(tree, alice.address), p2 = proofOf(tree2, alice.address)
    await assert.rejects(vault.connect(alice).claimMany([1, 2], [E(4)], [p1, p2]), /length mismatch/)
    await assert.rejects(vault.connect(alice).claimMany([1, 1], [E(4), E(4)], [p1, p1]), /AlreadyClaimed/)
    await assert.rejects(vault.connect(alice).claimMany([1, 2], [E(4), E(9)], [p1, p2]), /InvalidProof/)
    assert.equal(await vault.hasClaimed(1, alice.address), false, 'a failed batch claims nothing')
    assert.equal(await received(alice, () => vault.connect(alice).claimMany([1, 2], [E(4), E(3)], [p1, p2])), E(7))
  })

  it('a contract that re-enters claim() from receive() cannot claim twice', async () => {
    const f = await deployAll()
    const attacker = await (await ethers.getContractFactory('ReentrantClaimer')).deploy(f.vaultAddr)
    const a = await attacker.getAddress()
    await f.tax(10)
    const tree = rewardTree([[a, 1, E(6)]])
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), tree.root, E(6))
    await attacker.attack(1, E(6), proofOf(tree, a))
    assert.equal(await attacker.reentered(), true); assert.equal(await attacker.reentrySucceeded(), false)
    assert.equal(await f.bal(a), E(6))
  })

  it('allocated can never be over-claimed even if the tree sums to more than the allocation', async () => {
    const f = await deployAll()
    await f.tax(10)
    // a faulty backend tree: leaves sum to 8 but only 5 allocated
    const tree = rewardTree([[f.alice.address, 1, E(4)], [f.bob.address, 1, E(4)]])
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), tree.root, E(5))
    await f.vault.connect(f.alice).claim(1, E(4), proofOf(tree, f.alice.address))
    await assert.rejects(f.vault.connect(f.bob).claim(1, E(4), proofOf(tree, f.bob.address)), /AllocationTooHigh/)
  })
})

describe('RewardVault · recycling, staking flush and admin', () => {
  it('recycles only expired, closed, not-yet-recycled weeks, returning unclaimed BNB to the pool', async () => {
    const f = await deployAll()
    await f.tax(10)
    const tree = rewardTree([[f.alice.address, 1, E(4)], [f.bob.address, 1, E(2)]])
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), tree.root, E(6))
    await f.vault.connect(f.alice).claim(1, E(4), proofOf(tree, f.alice.address))
    await assert.rejects(f.vault.connect(f.operator).recycleExpired(9), /UnknownEpoch/)
    await assert.rejects(f.vault.connect(f.operator).recycleExpired(1), /NotExpired/)
    await assert.rejects(f.vault.connect(f.alice).recycleExpired(1), /AccessControlUnauthorizedAccount/)
    await wait(90 * DAY + 1)
    const before = await f.vault.callerCarry()
    await f.vault.connect(f.admin).pause()
    await assert.rejects(f.vault.connect(f.operator).recycleExpired(1), /EnforcedPause/)
    await f.vault.connect(f.admin).unpause()
    await f.vault.connect(f.operator).recycleExpired(1)
    assert.equal((await f.vault.callerCarry()) - before, E(2), 'recycled BNB goes back to the callers pool')
    assert.equal(await f.vault.reservedForClaims(), 0n)
    await assert.rejects(f.vault.connect(f.operator).recycleExpired(1), /AlreadyRecycled/)
    await assert.rejects(f.vault.connect(f.bob).claim(1, E(2), proofOf(tree, f.bob.address)), /EpochExpired/)
  })

  it('held stakers share is forwarded once staking is connected (operator only)', async () => {
    const { vault, staking, stakingAddr, admin, operator, buyback, ops, alice, tax, bal } = await deployAll()
    await tax(8)
    await vault.connect(operator).closeEpoch(await nextEpoch(vault), ZERO, 0)
    assert.equal(await vault.pendingStakerRewards(), E(2))
    await assert.rejects(vault.connect(alice).flushStakerRewards(), /AccessControlUnauthorizedAccount/)
    await vault.connect(operator).flushStakerRewards() // no staking yet: stays held
    assert.equal(await vault.pendingStakerRewards(), E(2))
    await vault.connect(admin).setWallets(stakingAddr, buyback.address, ops.address)
    await vault.connect(operator).flushStakerRewards()
    assert.equal(await vault.pendingStakerRewards(), 0n)
    assert.equal(await bal(stakingAddr), E(2)); assert.equal(await staking.totalNotified(), E(2))
  })

  it('admin-only settings with validation', async () => {
    const { vault, admin, operator, alice, buyback, ops } = await deployAll()
    for (const who of [operator, alice]) {
      await assert.rejects(vault.connect(who).setSplit(5000, 3000, 1500, 500), /AccessControlUnauthorizedAccount/)
      await assert.rejects(vault.connect(who).setWallets(ethers.ZeroAddress, buyback.address, ops.address), /AccessControlUnauthorizedAccount/)
      await assert.rejects(vault.connect(who).setClaimWindow(30 * DAY), /AccessControlUnauthorizedAccount/)
      await assert.rejects(vault.connect(who).pause(), /AccessControlUnauthorizedAccount/)
    }
    await assert.rejects(vault.connect(admin).setSplit(5000, 3000, 1500, 499), /InvalidSplit/)
    await vault.connect(admin).setSplit(5000, 3000, 1500, 500)
    assert.equal((await vault.split()).callers, 5000n)
    await assert.rejects(vault.connect(admin).setWallets(ethers.ZeroAddress, ethers.ZeroAddress, ops.address), /ZeroAddress/)
    await assert.rejects(vault.connect(admin).setWallets(ethers.ZeroAddress, buyback.address, ethers.ZeroAddress), /ZeroAddress/)
    await assert.rejects(vault.connect(admin).setClaimWindow(7 * DAY - 1), /window too short/)
    await assert.rejects(vault.connect(admin).setClaimWindow(365 * DAY + 1), /window too long/)
    await vault.connect(admin).setClaimWindow(7 * DAY)
    assert.equal(await vault.claimWindow(), BigInt(7 * DAY))
  })

  it('a changed claim window applies to weeks closed after the change only', async () => {
    const f = await deployAll()
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), ZERO, 0)
    const d1 = (await f.vault.epochs(1)).claimDeadline
    await f.vault.connect(f.admin).setClaimWindow(10 * DAY)
    await f.vault.connect(f.operator).closeEpoch(await nextEpoch(f.vault), ZERO, 0)
    const e2 = await f.vault.epochs(2)
    assert.equal(e2.claimDeadline - e2.closedAt, BigInt(10 * DAY))
    assert.equal(await f.vault.epochs(1).then((e) => e.claimDeadline), d1)
  })
})
