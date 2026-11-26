// Checks the deploy settings before anything is sent. Prints one PREFLIGHT JSON line (read by deploy.sh).
// Exit code 1 = a setting is missing or wrong. STEP=staking checks the Phase 2 settings instead.
const fs = require('fs')
const path = require('path')
const hre = require('hardhat')

async function main() {
  const { ethers } = hre
  const errors = [], warnings = []
  const staking = process.env.STEP === 'staking'
  const [deployer] = await ethers.getSigners()
  if (!deployer) errors.push('DEPLOYER_KEY is empty: set the owner wallet private key in contracts/.env')
  const { chainId } = await ethers.provider.getNetwork()
  const addr = (k, required = true, fallback) => {
    const v = (process.env[k] || fallback || '').trim()
    if (!v) { if (required) errors.push(`${k} is empty in contracts/.env`); return null }
    if (!ethers.isAddress(v)) { errors.push(`${k} is not a valid address: ${v}`); return null }
    return ethers.getAddress(v)
  }
  const hasCode = async (a) => a && (await ethers.provider.getCode(a)) !== '0x'
  const out = { step: staking ? 'staking' : 'launch', chainId: Number(chainId), deployer: deployer?.address || null }

  if (!staking) {
    out.admin = addr('ADMIN', chainId === 56n) || deployer?.address
    out.operator = addr('OPERATOR'); out.buyback = addr('BUYBACK_WALLET'); out.ops = addr('OPS_WALLET')
    out.badges = process.env.DEPLOY_BADGES !== '0'
    if (out.operator && out.admin && out.operator === out.admin) warnings.push('OPERATOR is the same wallet as ADMIN. Its key sits on the server, so a server leak would expose the admin powers too.')
    if (chainId === 56n && out.admin && deployer && out.admin === deployer.address && process.env.ALLOW_EOA_ADMIN !== '1') errors.push('ADMIN is the deployer wallet: set ALLOW_EOA_ADMIN=1 in .env (or use a multisig as ADMIN)')
    const rec = path.join(__dirname, '..', 'deployments', `${process.env.DEPLOY_NETWORK || hre.network.name}.json`)
    if (fs.existsSync(rec) && JSON.parse(fs.readFileSync(rec, 'utf8')).RewardVault) warnings.push(`contracts were already deployed on this network (deployments/${path.basename(rec)}). Deploying again creates NEW contracts.`)
  } else {
    const rec = path.join(__dirname, '..', 'deployments', `${process.env.DEPLOY_NETWORK || hre.network.name}.json`)
    const recorded = fs.existsSync(rec) ? JSON.parse(fs.readFileSync(rec, 'utf8')) : {}
    out.vault = addr('VAULT', true, recorded.RewardVault)
    out.upwToken = addr('UPW_TOKEN')
    if (out.vault && !(await hasCode(out.vault))) errors.push(`VAULT ${out.vault} is not a contract on this network`)
    if (out.upwToken && !(await hasCode(out.upwToken))) errors.push(`UPW_TOKEN ${out.upwToken} is not a contract on this network`)
    if (out.upwToken) {
      try { out.upwSymbol = await (await ethers.getContractAt(['function symbol() view returns (string)'], out.upwToken)).symbol() } catch { warnings.push('UPW_TOKEN has no symbol(): check it is the $UPW token') }
    }
    if (out.vault && deployer && (await hasCode(out.vault))) {
      const v = await ethers.getContractAt('RewardVault', out.vault)
      out.deployerIsVaultAdmin = await v.hasRole(await v.DEFAULT_ADMIN_ROLE(), deployer.address)
      if (!out.deployerIsVaultAdmin) warnings.push('the deployer is not the vault admin: staking will be deployed, and the admin must connect it (printed at the end)')
      if ((await v.staking()) !== ethers.ZeroAddress) warnings.push(`the vault is already connected to staking ${await v.staking()}: this would replace it`)
    }
    if (recorded.UpwellStaking) warnings.push(`staking was already deployed on this network (${recorded.UpwellStaking})`)
  }

  const balance = deployer ? await ethers.provider.getBalance(deployer.address) : 0n
  out.balanceBnb = ethers.formatEther(balance)
  if (deployer && balance < ethers.parseEther('0.005')) errors.push(`the deployer has only ${out.balanceBnb} BNB: send about 0.02 BNB to ${deployer.address} for gas`)
  out.errors = errors; out.warnings = warnings
  console.log('PREFLIGHT ' + JSON.stringify(out))
  if (errors.length) process.exitCode = 1
}

main().catch((e) => { console.log('PREFLIGHT ' + JSON.stringify({ errors: [e.shortMessage || e.message], warnings: [] })); process.exitCode = 1 })
