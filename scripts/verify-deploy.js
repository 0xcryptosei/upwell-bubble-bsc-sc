// Reads the deployed contracts back from the chain and checks their roles and settings.
// Run by deploy.sh: DEPLOYMENT=deployments/<network>.json [STEP=staking] npx hardhat run scripts/verify-deploy.js --network <net>
const fs = require('fs')
const hre = require('hardhat')

async function main() {
  const { ethers } = hre
  const d = JSON.parse(fs.readFileSync(process.env.DEPLOYMENT, 'utf8'))
  const checks = []
  const code = async (a) => (await ethers.provider.getCode(a)) !== '0x'

  if (process.env.STEP !== 'staking') {
    const vault = await ethers.getContractAt('RewardVault', d.RewardVault)
    const ledger = await ethers.getContractAt('CallLedger', d.CallLedger)
    const ADMIN = await vault.DEFAULT_ADMIN_ROLE(), OPERATOR = await vault.OPERATOR_ROLE(), PUBLISHER = await ledger.PUBLISHER_ROLE()
    const s = await vault.split()
    checks.push(
      ['RewardVault has code', await code(d.RewardVault)],
      ['CallLedger has code', await code(d.CallLedger)],
      ['vault: ADMIN has the admin role', await vault.hasRole(ADMIN, d.admin)],
      ['vault: OPERATOR has the operator role', await vault.hasRole(OPERATOR, d.operator)],
      ['vault: buyback wallet = BUYBACK_WALLET', (await vault.buybackWallet()) === d.buyback],
      ['vault: ops wallet = OPS_WALLET', (await vault.opsWallet()) === d.ops],
      ['vault: no staking yet (the 25% is held)', (await vault.staking()) === ethers.ZeroAddress],
      ['vault: split 60 / 25 / 10 / 5', [s.callers, s.stakers, s.buyback, s.ops].map(Number).join('/') === '6000/2500/1000/500'],
      ['vault: week counter at 0, not paused', (await vault.currentEpoch()) === 0n && !(await vault.paused())],
      ['ledger: ADMIN has the admin role', await ledger.hasRole(ADMIN, d.admin)],
      ['ledger: OPERATOR can publish', await ledger.hasRole(PUBLISHER, d.operator)],
    )
    if (d.deployer !== d.admin) checks.push(['vault: the deployer has no admin role', !(await vault.hasRole(ADMIN, d.deployer))])
  } else {
    const staking = await ethers.getContractAt('UpwellStaking', d.UpwellStaking)
    const vault = await ethers.getContractAt('RewardVault', d.RewardVault)
    checks.push(
      ['UpwellStaking has code', await code(d.UpwellStaking)],
      ['staking: token = UPW_TOKEN', (await staking.upw()) === d.upwToken],
      ['staking: the vault can send rewards', await staking.hasRole(await staking.NOTIFIER_ROLE(), d.RewardVault)],
      ['staking: admin role set', await staking.hasRole(await staking.DEFAULT_ADMIN_ROLE(), d.stakingAdmin)],
    )
    const connected = (await vault.staking()) === d.UpwellStaking
    if (await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), d.deployer)) checks.push(['vault: connected to staking', connected])
    else console.log(`  NOTE vault connected to staking: ${connected ? 'yes' : 'not yet (the vault admin must call setWallets)'}`)
  }

  let ok = true
  for (const [name, pass] of checks) { console.log(`  ${pass ? 'OK  ' : 'FAIL'}  ${name}`); if (!pass) ok = false }
  if (!ok) process.exitCode = 1
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
