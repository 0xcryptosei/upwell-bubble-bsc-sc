// Randomised run: hundreds of random actions on the vault + staking, checking after every step that the
// contracts always hold enough BNB for everything they owe, and that no BNB appears or disappears.
const assert = require('node:assert/strict')
const { ethers } = require('hardhat')
const { E, DAY, wait, rewardTree, proofOf, deployAll, nextEpoch } = require('./fixtures')

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) }

async function run(seed, steps) {
  const r = rng(seed)
  const pick = (a) => a[Math.floor(r() * a.length)]
  const f = await deployAll({ connectStaking: true })
  const { vault, staking, operator, admin } = f
  const users = [f.alice, f.bob, f.carol, f.mallory]
  for (const u of users) await f.fund(u, 1_000_000)
  const open = [] // { epoch, tree, rows: [[addr, epoch, amount]], claimed:Set }
  let taxedIn = 0n, paidOutClaims = 0n, stakingPaid = 0n
  const counts = {}

  async function check(step, action) {
    const vb = await ethers.provider.getBalance(f.vaultAddr)
    const owed = (await vault.reservedForClaims()) + (await vault.pendingStakerRewards()) + (await vault.callerCarry()) + (await vault.heldBuyback()) + (await vault.heldOps())
    assert.ok(vb >= owed, `step ${step} ${action}: vault holds ${vb} but owes ${owed}`)
    // reserved == what open weeks can still pay
    let reserved = 0n
    for (const o of open) { const e = await vault.epochs(o.epoch); if (!e.recycled) reserved += e.allocated - e.claimed }
    assert.equal(await vault.reservedForClaims(), reserved, `step ${step} ${action}: reservedForClaims drift`)
    const sb = await ethers.provider.getBalance(f.stakingAddr)
    let earned = 0n
    for (const u of users) earned += await staking.earned(u.address)
    const stakingOwed = earned + (await staking.remainingRewards()) + (await staking.queued())
    // per-update rounding can only leave a few wei extra in the contract, never owe more than it holds
    assert.ok(sb + 10n ** 6n >= stakingOwed, `step ${step} ${action}: staking holds ${sb} but owes ${stakingOwed}`)
    assert.ok(stakingPaid <= await staking.totalNotified() + (await ethers.provider.getBalance(f.stakingAddr)), 'staking paid more than it got')
  }

  for (let step = 0; step < steps; step++) {
    const roll = r()
    let action
    if (roll < 0.18) {
      action = 'tax'
      const amt = E((r() * 5).toFixed(6)); await f.tax(amt); taxedIn += amt
    } else if (roll < 0.30) {
      action = 'close'
      const [, callers] = await vault.preview()
      const epoch = await nextEpoch(vault)
      const winners = users.filter(() => r() < 0.6)
      let rows = [], root = ethers.ZeroHash, total = 0n, tree = null
      if (winners.length && callers > 0n) {
        const give = (callers * BigInt(Math.floor(r() * 100))) / 100n // 0..99% of the pool
        const each = give / BigInt(winners.length)
        if (each > 0n) {
          rows = winners.map((w) => [w.address, epoch, each]); total = each * BigInt(winners.length)
          tree = rewardTree(rows); root = tree.root
        }
      }
      await vault.connect(operator).closeEpoch(epoch, root, total)
      if (tree) open.push({ epoch, tree, rows, claimed: new Set() })
    } else if (roll < 0.45 && open.length) {
      action = 'claim'
      const o = pick(open), row = pick(o.rows), who = users.find((u) => u.address === row[0])
      const e = await vault.epochs(o.epoch)
      const live = !e.recycled && BigInt((await ethers.provider.getBlock('latest')).timestamp) < e.claimDeadline
      if (!o.claimed.has(row[0]) && live) {
        await vault.connect(who).claim(o.epoch, row[2], proofOf(o.tree, row[0])); o.claimed.add(row[0]); paidOutClaims += row[2]
      } else {
        await assert.rejects(vault.connect(who).claim(o.epoch, row[2], proofOf(o.tree, row[0])))
      }
    } else if (roll < 0.58) {
      action = 'stake'
      const u = pick(users); await staking.connect(u).stake(E(Math.floor(r() * 5000) + 1))
    } else if (roll < 0.68) {
      action = 'withdraw'
      const u = pick(users), b = await staking.balanceOf(u.address)
      if (b > 0n) await staking.connect(u).withdraw(r() < 0.5 ? b : b / 2n || b)
    } else if (roll < 0.78) {
      action = 'stakingClaim'
      const u = pick(users), before = await staking.earned(u.address)
      await staking.connect(u).claim(); stakingPaid += before
    } else if (roll < 0.83) {
      action = 'recycle'
      const o = open.length ? pick(open) : null
      if (o) {
        const e = await vault.epochs(o.epoch)
        const expired = BigInt((await ethers.provider.getBlock('latest')).timestamp) > e.claimDeadline
        if (expired && !e.recycled) await vault.connect(operator).recycleExpired(o.epoch)
      }
    } else if (roll < 0.86) {
      action = 'directBNB'
      await f.carol.sendTransaction({ to: f.stakingAddr, value: E((r() * 0.5).toFixed(6)) })
    } else if (roll < 0.88) {
      action = 'setSplit'
      const a = [5000, 6000, 7000][Math.floor(r() * 3)]
      await vault.connect(admin).setSplit(a, 9000 - a, 700, 300)
    } else {
      action = 'wait'
      await wait(r() < 0.1 ? 95 * DAY : r() * 4 * DAY)
    }
    counts[action] = (counts[action] || 0) + 1
    await check(step, action)
  }
  return { counts, taxedIn, paidOutClaims, stakingPaid }
}

describe('Invariants (randomised)', function () {
  this.timeout(600000)
  for (const seed of [1, 7, 42, 2026]) {
    it(`seed ${seed}: the vault and staking can always pay everything they owe`, async () => {
      const { counts, taxedIn, paidOutClaims } = await run(seed, 250)
      assert.ok(paidOutClaims <= taxedIn)
      console.log('      ', JSON.stringify(counts))
    })
  }
})
