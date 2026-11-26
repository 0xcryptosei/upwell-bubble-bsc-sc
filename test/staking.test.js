// UpwellStaking: roles, reverts, streaming maths, fee-on-transfer tokens, reentrancy, pause.
const assert = require('node:assert/strict')
const { ethers } = require('hardhat')
const { E, DAY, fmt, wait, now, deployAll, received } = require('./fixtures')

const WEEK = 7 * DAY
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(fmt(a) - b) <= tol, `${fmt(a)} is not ~${b}`)

/** Staking whose notifier is a plain signer, so tests can deposit rewards directly. */
async function setup({ feeToken = false } = {}) {
  const f = await deployAll({ feeToken })
  const notifier = f.operator
  const staking = await (await ethers.getContractFactory('UpwellStaking')).deploy(await f.upw.getAddress(), f.admin.address, notifier.address)
  const addr = await staking.getAddress()
  const fund = async (who, n) => { await f.upw.mint(who.address, E(n)); await f.upw.connect(who).approve(addr, ethers.MaxUint256) }
  const deposit = (n) => staking.connect(notifier).notifyRewardAmount({ value: E(n) })
  return { ...f, staking, stakingAddr: addr, fund, deposit, notifier }
}

describe('UpwellStaking · roles and reverts', () => {
  it('only the notifier (the vault) can deposit rewards; a zero vault gets no role', async () => {
    const { staking, alice, admin, deposit } = await setup()
    await assert.rejects(staking.connect(alice).notifyRewardAmount({ value: 1 }), /AccessControlUnauthorizedAccount/)
    await assert.rejects(staking.connect(admin).notifyRewardAmount({ value: 1 }), /AccessControlUnauthorizedAccount/)
    await deposit(1)
    const s2 = await (await ethers.getContractFactory('UpwellStaking')).deploy(await staking.upw(), admin.address, ethers.ZeroAddress)
    assert.equal(await s2.hasRole(await s2.NOTIFIER_ROLE(), ethers.ZeroAddress), false)
  })

  it('zero stake / zero withdraw / withdrawing more than staked revert', async () => {
    const { staking, alice, fund } = await setup()
    await fund(alice, 10)
    await assert.rejects(staking.connect(alice).stake(0), /ZeroAmount/)
    await staking.connect(alice).stake(E(10))
    await assert.rejects(staking.connect(alice).withdraw(0), /ZeroAmount/)
    await assert.rejects(staking.connect(alice).withdraw(E(10) + 1n), /InsufficientStake/)
  })

  it('pause stops new stakes but never traps funds: withdraw, claim and exit still work', async () => {
    const { staking, admin, alice, bob, fund, deposit, upw } = await setup()
    await fund(alice, 10); await fund(bob, 10)
    await staking.connect(alice).stake(E(10))
    await deposit(7); await wait(DAY)
    await assert.rejects(staking.connect(alice).pause(), /AccessControlUnauthorizedAccount/)
    await staking.connect(admin).pause()
    await assert.rejects(staking.connect(bob).stake(E(1)), /EnforcedPause/)
    assert.ok((await received(alice, () => staking.connect(alice).claim())) > 0n)
    await staking.connect(alice).exit()
    assert.equal(await upw.balanceOf(alice.address), E(10))
    await staking.connect(admin).unpause()
    await staking.connect(bob).stake(E(1))
  })

  it('claim with nothing earned is a harmless no-op', async () => {
    const { staking, alice } = await setup()
    assert.equal(await received(alice, () => staking.connect(alice).claim()), 0n)
  })
})

describe('UpwellStaking · reward maths', () => {
  it('a deposit is spread evenly over exactly 7 days', async () => {
    const { staking, alice, fund, deposit } = await setup()
    await fund(alice, 100); await staking.connect(alice).stake(E(100))
    await deposit(7)
    const t0 = await now()
    assert.equal(await staking.rewardRate(), E(7) / BigInt(WEEK))
    assert.equal(await staking.periodFinish(), BigInt(t0 + WEEK))
    await wait(DAY); near(await staking.earned(alice.address), 1, 1e-4)
    near(await staking.remainingRewards(), 6, 1e-4)
    await wait(6 * DAY); near(await staking.earned(alice.address), 7, 1e-9)
    await wait(30 * DAY); near(await staking.earned(alice.address), 7, 1e-9) // nothing more after the period
    assert.equal(await staking.remainingRewards(), 0n)
  })

  it('splits pro rata to stake, and follows stake changes during the week', async () => {
    const { staking, alice, bob, fund, deposit } = await setup()
    await fund(alice, 300); await fund(bob, 100)
    await staking.connect(alice).stake(E(300)); await staking.connect(bob).stake(E(100))
    await deposit(14) // 2 BNB a day
    await wait(2 * DAY) // 4 BNB: alice 3, bob 1
    await staking.connect(alice).withdraw(E(200)) // now 100 / 100
    await wait(5 * DAY) // 10 BNB: 5 / 5
    near(await staking.earned(alice.address), 8, 1e-3); near(await staking.earned(bob.address), 6, 1e-3)
  })

  it('a deposit during a running week is added to what is left and restarts the 7 days', async () => {
    const { staking, alice, fund, deposit } = await setup()
    await fund(alice, 1); await staking.connect(alice).stake(E(1))
    await deposit(7); await wait(3 * DAY) // 3 paid, 4 left
    await deposit(3) // 4 + 3 = 7 over the next 7 days
    near(await staking.rewardRate() * BigInt(WEEK), 7, 1e-4) // the 4 left + the new 3, over a fresh 7 days
    assert.equal(await staking.periodFinish(), BigInt((await now()) + WEEK))
    await wait(WEEK)
    near(await staking.earned(alice.address), 10, 1e-6)
  })

  it('time with nobody staked is queued and paid with the next deposit, never lost or grabbed', async () => {
    const { staking, alice, fund, deposit } = await setup()
    await deposit(7)
    await wait(2 * DAY) // 2 BNB of time with nobody staked
    await fund(alice, 1); await staking.connect(alice).stake(E(1))
    near(await staking.earned(alice.address), 0, 1e-9)
    await wait(5 * DAY + 10)
    near(await staking.earned(alice.address), 5, 1e-3)
    assert.ok((await staking.queued()) >= 0n)
    await deposit(0.000001) // next week: the queued ~2 BNB is added in
    await wait(WEEK)
    near(await staking.earned(alice.address), 7.000001, 1e-3)
  })

  it('a just-in-time staker earns only for the seconds staked', async () => {
    const { staking, alice, mallory, fund, deposit } = await setup()
    await fund(alice, 10); await staking.connect(alice).stake(E(10))
    await fund(mallory, 1_000_000); await staking.connect(mallory).stake(E(1_000_000))
    await deposit(100)
    const got = await received(mallory, () => staking.connect(mallory).exit())
    assert.ok(fmt(got) < 0.001, `JIT staker got ${fmt(got)} BNB`)
    await wait(WEEK)
    near(await staking.earned(alice.address), 100, 1e-3)
  })

  it('never pays out more than it received (dust stays in the contract)', async () => {
    const { staking, stakingAddr, alice, bob, carol, fund, deposit, bal } = await setup()
    for (const [w, n] of [[alice, 3], [bob, 7], [carol, 11]]) { await fund(w, n); await staking.connect(w).stake(E(n)) }
    await deposit(1); await wait(2 * DAY); await deposit(0.333333333333333333); await wait(10 * DAY)
    let paid = 0n
    for (const w of [alice, bob, carol]) paid += await received(w, () => staking.connect(w).claim())
    assert.ok(paid <= E(1) + E(0.333333333333333333))
    assert.ok((await bal(stakingAddr)) >= 0n)
    near(paid, 1.333333333333333333, 1e-6)
  })

  it('a tiny deposit (less than 1 wei per second) is carried to the next period, not lost', async () => {
    const { staking, alice, fund } = await setup()
    await fund(alice, 1); await staking.connect(alice).stake(E(1))
    await staking.connect((await ethers.getSigners())[1]).notifyRewardAmount({ value: 1000n }) // rate rounds to 0
    assert.equal(await staking.rewardRate(), 0n)
    await wait(WEEK)
    assert.equal(await staking.earned(alice.address), 0n)
    // the 1000 wei is carried (queued) into the next period instead of being lost
    assert.equal(await staking.queued(), 1000n)
    assert.equal(await ethers.provider.getBalance(await staking.getAddress()), 1000n)
  })
})

describe('UpwellStaking · tokens and reentrancy', () => {
  it('credits what actually arrived for a fee-on-transfer token', async () => {
    const { staking, alice, fund, upw, stakingAddr } = await setup({ feeToken: true })
    await fund(alice, 100)
    await staking.connect(alice).stake(E(100))
    assert.equal(await staking.balanceOf(alice.address), E(99))
    assert.equal(await staking.totalStaked(), E(99))
    assert.equal(await upw.balanceOf(stakingAddr), E(99))
    await staking.connect(alice).withdraw(E(99)) // the token takes its fee on the way out too
    assert.equal(await upw.balanceOf(alice.address), E(99) - E(0.99))
    assert.equal(await staking.totalStaked(), 0n)
  })

  it('a contract that re-enters claim() from receive() cannot claim twice', async () => {
    const { staking, stakingAddr, upw, deposit, bal } = await setup()
    const att = await (await ethers.getContractFactory('ReentrantStaker')).deploy(stakingAddr)
    const a = await att.getAddress()
    await upw.mint(a, E(10))
    await att.approveAndStake(await upw.getAddress(), E(10))
    await deposit(7); await wait(WEEK)
    await att.claimRewards()
    assert.equal(await att.reentrySucceeded(), false)
    near(await bal(a), 7, 1e-9)
    assert.equal(await staking.rewards(a), 0n)
  })
})

describe('UpwellStaking · BNB sent directly', () => {
  it('BNB sent straight to staking (e.g. holder dividends) is queued and shared with the next deposit', async () => {
    const { staking, stakingAddr, alice, carol, fund, deposit } = await setup()
    await fund(alice, 10); await staking.connect(alice).stake(E(10))
    await carol.sendTransaction({ to: stakingAddr, value: E(2) })
    assert.equal(await staking.queued(), E(2))
    near(await staking.earned(alice.address), 0, 1e-12)
    await deposit(5); await wait(WEEK)
    near(await staking.earned(alice.address), 7, 1e-9)
  })
})
