// Deploys the Upwell contracts and wires their roles together. Settings come from contracts/.env.
// Normally run through ./deploy.sh (checks first, verifies after). Directly:
//   npm run deploy:testnet | deploy:mainnet                 launch: RewardVault + CallLedger (+ badges unless DEPLOY_BADGES=0)
//   npm run deploy:staking:testnet | deploy:staking:mainnet  Phase 2: UpwellStaking for $UPW (needs VAULT and UPW_TOKEN)
//
// Staking stays OFF at launch: the vault keeps the stakers' 25% (pendingStakerRewards) until it is connected.
// OPERATOR is the backend's wallet (OPERATOR_KEY in backend/.env): it closes reward weeks and publishes the ledger.
// Every deployment is recorded in deployments/<network>.json.
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')

const env = (k, fallback) => {
  const v = process.env[k] || fallback
  if (v === undefined || v === '') throw new Error(`Missing ${k} in contracts/.env`)
  return v
}
const recordFile = () => path.join(__dirname, '..', 'deployments', `${process.env.DEPLOY_NETWORK || hre.network.name}.json`)
const readRecord = () => (fs.existsSync(recordFile()) ? JSON.parse(fs.readFileSync(recordFile(), 'utf8')) : {})
function saveRecord(patch) {
  fs.mkdirSync(path.dirname(recordFile()), { recursive: true })
  fs.writeFileSync(recordFile(), JSON.stringify({ ...readRecord(), ...patch }, null, 2) + '\n')
  console.log(`Saved to deployments/${path.basename(recordFile())}`)
}

async function launch(deployer, chainId) {
  const g = hre.ethers.getAddress
  // on mainnet the admin must be given explicitly, never the deployer key by default
  const admin = g(chainId === 56n ? env('ADMIN') : env('ADMIN', deployer.address))
  if (chainId === 56n && admin === deployer.address && process.env.ALLOW_EOA_ADMIN !== '1') {
    throw new Error('ADMIN is the deployer wallet. Set ALLOW_EOA_ADMIN=1 in .env, or use a multisig as ADMIN.')
  }
  const operator = g(env('OPERATOR')), buyback = g(env('BUYBACK_WALLET')), ops = g(env('OPS_WALLET'))
  const badgeUri = env('BADGE_URI', 'https://up-well.space/badges/{id}.json')

  console.log('Deploying RewardVault…')
  const vault = await (await hre.ethers.getContractFactory('RewardVault')).deploy(admin, operator, hre.ethers.ZeroAddress, buyback, ops)
  await vault.waitForDeployment()
  console.log('Deploying CallLedger…')
  const ledger = await (await hre.ethers.getContractFactory('CallLedger')).deploy(admin, operator)
  await ledger.waitForDeployment()
  let badges = null
  if (process.env.DEPLOY_BADGES !== '0') {
    console.log('Deploying UpwellBadges…')
    badges = await (await hre.ethers.getContractFactory('UpwellBadges')).deploy(admin, operator, badgeUri)
    await badges.waitForDeployment()
  }
  const out = {
    RewardVault: await vault.getAddress(),
    CallLedger: await ledger.getAddress(),
    ...(badges ? { UpwellBadges: await badges.getAddress() } : {}),
  }
  console.log(JSON.stringify(out, null, 2))
  saveRecord({
    network: process.env.DEPLOY_NETWORK || hre.network.name, chainId: Number(chainId), ...out,
    deployer: deployer.address, admin, operator, buyback, ops,
    block: await hre.ethers.provider.getBlockNumber(), deployedAt: new Date().toISOString(),
  })
}

async function enableStaking(deployer) {
  const g = hre.ethers.getAddress
  const vaultAddr = g(env('VAULT', readRecord().RewardVault))
  const upw = g(env('UPW_TOKEN'))
  const vault = await hre.ethers.getContractAt('RewardVault', vaultAddr)
  const isAdmin = await vault.hasRole(await vault.DEFAULT_ADMIN_ROLE(), deployer.address)
  const stakingAdmin = g(env('ADMIN', deployer.address))

  console.log('Deploying UpwellStaking…')
  const staking = await (await hre.ethers.getContractFactory('UpwellStaking')).deploy(upw, stakingAdmin, vaultAddr)
  await staking.waitForDeployment()
  const stakingAddr = await staking.getAddress()
  console.log(JSON.stringify({ UpwellStaking: stakingAddr }, null, 2))
  saveRecord({ UpwellStaking: stakingAddr, upwToken: upw, stakingAdmin, stakingDeployedAt: new Date().toISOString() })

  if (!isAdmin) {
    // the vault admin is a multisig: deploy only, and print the calls for it to make
    console.log(`Deployed. Now:
  1. the vault admin (multisig) calls setWallets(${stakingAddr}, ${await vault.buybackWallet()}, ${await vault.opsWallet()}) on ${vaultAddr}
  2. the operator calls flushStakerRewards() to forward the held stakers' share`)
    return
  }
  console.log('Connecting the vault to staking…')
  await (await vault.setWallets(stakingAddr, await vault.buybackWallet(), await vault.opsWallet())).wait()
  // forwarding the held 25% needs OPERATOR_ROLE; otherwise the backend operator does it at the next close
  if (await vault.hasRole(await vault.OPERATOR_ROLE(), deployer.address)) await (await vault.flushStakerRewards()).wait()
  console.log("The vault now sends the stakers' 25% to staking.")
}

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  if (!deployer) throw new Error('DEPLOYER_KEY is empty in contracts/.env')
  const { chainId } = await hre.ethers.provider.getNetwork()
  console.log('Deployer', deployer.address, 'on chain', chainId)
  // npm run deploy:staking:* (or STEP=staking) runs the Phase 2 step
  if (process.env.STEP === 'staking' || /staking/.test(process.env.npm_lifecycle_event || '')) await enableStaking(deployer)
  else await launch(deployer, chainId)
}

main().catch((e) => { console.error(e.shortMessage || e.message); process.exitCode = 1 })
