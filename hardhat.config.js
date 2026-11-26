// Hardhat config for the Upwell contracts.
// Build only: `npm run build`. Nothing is deployed unless you run a deploy script yourself.
// Deploy settings (keys, wallets) come from contracts/.env (see .env.example) or the shell; the shell wins.
require('@nomicfoundation/hardhat-ethers')
require('solidity-coverage')
const fs = require('fs')
const path = require('path')

/** Minimal .env loader (no extra dependency). Values already set in the shell are kept. */
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    const [, k, raw] = m
    if (process.env[k] === undefined && raw !== '') process.env[k] = raw.replace(/^['"]|['"]$/g, '')
  }
}
loadDotEnv(path.join(__dirname, '.env'))

const { DEPLOYER_KEY, BSC_RPC_URL, BSC_TESTNET_RPC_URL } = process.env
// accept the key with or without the 0x prefix
const key = DEPLOYER_KEY ? (DEPLOYER_KEY.startsWith('0x') ? DEPLOYER_KEY : '0x' + DEPLOYER_KEY) : null
const accounts = key ? [key] : []

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
    },
  },
  networks: {
    bsc: { url: BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org', chainId: 56, accounts },
    bscTestnet: { url: BSC_TESTNET_RPC_URL || 'https://data-seed-prebsc-1-s1.bnbchain.org:8545', chainId: 97, accounts },
  },
}
