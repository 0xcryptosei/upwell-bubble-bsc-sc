#!/usr/bin/env bash
# Upwell contracts: check, deploy and verify, in one command. Settings come from contracts/.env.
#
#   ./deploy.sh testnet            launch on BNB testnet   (RewardVault + CallLedger)
#   ./deploy.sh mainnet            launch on BNB Chain
#   ./deploy.sh mainnet staking    Phase 2: staking for $UPW (needs UPW_TOKEN; VAULT defaults to the launch deployment)
#   ./deploy.sh local [staking]    dry run on a throwaway local chain (nothing real is sent)
#
# It does not change the backend: at the end it prints the lines to add to backend/.env.
set -euo pipefail
cd "$(dirname "$0")"
[ -d /opt/node22/bin ] && export PATH=/opt/node22/bin:$PATH

NET="${1:-}"; STEPARG="${2:-launch}"
case "$NET" in
  testnet) HH=bscTestnet; SCAN=https://testnet.bscscan.com ;;
  mainnet) HH=bsc;        SCAN=https://bscscan.com ;;
  local)   HH=localhost;  SCAN= ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
case "$STEPARG" in launch) unset STEP ;; staking) export STEP=staking ;; *) echo "Unknown step: $STEPARG (use launch or staking)"; exit 1 ;; esac
export DEPLOY_NETWORK="$NET"
REC="deployments/$NET.json"

b=$'\e[1m'; g=$'\e[32m'; r=$'\e[31m'; y=$'\e[33m'; d=$'\e[2m'; n=$'\e[0m'
step() { echo; echo "${b}== $*${n}"; }
die() { echo "${r}✗ $*${n}"; exit 1; }
json() { node -e "const j=JSON.parse(require('fs').readFileSync(0,'utf8'));const v=$1;console.log(v===undefined||v===null?'':v)"; }

# ---- local dry run: a throwaway chain with test wallets ------------------------------------------
NODE_PID=
cleanup() { [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true; }
trap cleanup EXIT
if [ "$NET" = local ]; then
  step "Starting a throwaway local chain"
  npx hardhat node --port 8545 >/tmp/upwell-hardhat-node.log 2>&1 & NODE_PID=$!
  for _ in $(seq 1 40); do curl -s -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' http://127.0.0.1:8545 && break; sleep 0.5; done
  # Hardhat's public test accounts #1-#3 (never use them on a real network)
  export OPERATOR=0x70997970c51812dc3a010c7f50e0d4f9c3e7f8e1 BUYBACK_WALLET=0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc OPS_WALLET=0x90f79bf6eb2c4f937b0b9b4a5ba7e93cb6c7e2d7 ADMIN=0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266
  rm -f "$REC"
  if [ "${STEP:-}" = staking ]; then
    echo "${d}Local staking dry run: launching the vault first, with a test token as \$UPW${n}"
    (unset STEP; npx hardhat run scripts/deploy.js --network localhost >/dev/null)
    export UPW_TOKEN=$(printf '%s\n' "const hre=require('hardhat');(async()=>{const t=await (await hre.ethers.getContractFactory('TestToken')).deploy();await t.waitForDeployment();console.log(await t.getAddress())})()" > scripts/_localtoken.js && npx hardhat run scripts/_localtoken.js --network localhost | tail -1; rm -f scripts/_localtoken.js)
  fi
fi

# ---- 1. tests ---------------------------------------------------------------------------------
step "1/4  Contract tests"
if npx hardhat test >/tmp/upwell-test.log 2>&1; then
  echo "${g}✓ $(grep -E 'passing' /tmp/upwell-test.log | tr -s ' ')${n}"
else
  tail -30 /tmp/upwell-test.log; die "Tests failed: nothing was deployed"
fi

# ---- 2. preflight -----------------------------------------------------------------------------
step "2/4  Checking settings (contracts/.env) on $NET"
PF=$(npx hardhat run scripts/preflight.js --network "$HH" 2>&1 | grep '^PREFLIGHT ' | sed 's/^PREFLIGHT //' || true)
[ -n "$PF" ] || die "Could not reach the $NET network (check BSC_RPC_URL / internet)"
echo "  Network      $NET (chain $(echo "$PF" | json 'j.chainId'))"
echo "  Deployer     $(echo "$PF" | json 'j.deployer')   balance $(echo "$PF" | json 'j.balanceBnb') BNB"
if [ "${STEP:-}" = staking ]; then
  echo "  Vault        $(echo "$PF" | json 'j.vault')"
  echo "  \$UPW token   $(echo "$PF" | json 'j.upwToken')  $(echo "$PF" | json 'j.upwSymbol')"
else
  echo "  Admin        $(echo "$PF" | json 'j.admin')"
  echo "  Operator     $(echo "$PF" | json 'j.operator')"
  echo "  Buyback      $(echo "$PF" | json 'j.buyback')"
  echo "  Ops          $(echo "$PF" | json 'j.ops')"
  echo "  Contracts    RewardVault, CallLedger$( [ "$(echo "$PF" | json 'j.badges')" = true ] && echo ', UpwellBadges')"
fi
echo "$PF" | json "j.warnings.map(w=>'  ${y}! '+w+'${n}').join('\n')"
ERR=$(echo "$PF" | json "j.errors.map(e=>'  ${r}✗ '+e+'${n}').join('\n')")
[ -z "$ERR" ] || { echo "$ERR"; die "Fix the settings above in contracts/.env, then run again. Nothing was deployed."; }
echo "${g}✓ Settings OK${n}"

if [ "$NET" = mainnet ]; then
  echo; echo "${y}This deploys to BNB Chain MAINNET and spends real BNB for gas.${n}"
  read -r -p "Type DEPLOY to continue: " ANSWER
  [ "$ANSWER" = DEPLOY ] || die "Cancelled. Nothing was deployed."
fi

# ---- 3. deploy --------------------------------------------------------------------------------
step "3/4  Deploying"
npx hardhat run scripts/deploy.js --network "$HH" || die "Deployment failed (see above). Contracts that were already created are listed above."
[ -f "$REC" ] || die "Deployment record $REC missing"

# ---- 4. verify --------------------------------------------------------------------------------
step "4/4  Verifying on-chain"
DEPLOYMENT="$REC" npx hardhat run scripts/verify-deploy.js --network "$HH" || die "Verification found a problem (see FAIL above)"
echo "${g}✓ All checks passed${n}"

# ---- summary ----------------------------------------------------------------------------------
step "Done"
link() { [ -n "$SCAN" ] && echo "$SCAN/address/$1" || echo "$1"; }
if [ "${STEP:-}" = staking ]; then
  S=$(json 'j.UpwellStaking' < "$REC")
  echo "  UpwellStaking  $S"
  echo "                 $(link "$S")"
else
  V=$(json 'j.RewardVault' < "$REC"); L=$(json 'j.CallLedger' < "$REC")
  echo "  RewardVault  $V"
  echo "               $(link "$V")"
  echo "  CallLedger   $L"
  echo "               $(link "$L")"
  CHAIN=$(json 'j.chainId' < "$REC")
  MONDAY=$(node -e "const d=new Date();d.setUTCHours(0,0,0,0);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));console.log(d.toISOString().replace('.000',''))")
  echo
  echo "  Saved in $REC"
  echo
  echo "${b}When you want the vault in the app${n} (claims + automatic Monday closes), add to backend/.env:"
  echo "    VAULT_ADDRESS=$V"
  echo "    LEDGER_ADDRESS=$L"
  echo "    CHAIN_ID=$CHAIN"
  echo "    BSC_RPC_URL=$( [ "$CHAIN" = 97 ] && echo https://data-seed-prebsc-1-s1.bnbchain.org:8545 || echo https://bsc-dataseed.bnbchain.org )"
  echo "    SEASON_START=$MONDAY"
  echo "    OPERATOR_KEY=<private key of $(json 'j.operator' < "$REC")>"
  echo "  then: pm2 restart upwell-backend --update-env"
  echo "  Fund the operator wallet with ~0.02 BNB for the weekly close gas."
fi

if [ "$NET" != local ] && grep -qE '^DEPLOYER_KEY=.+' .env 2>/dev/null; then
  echo
  read -r -p "Remove DEPLOYER_KEY from contracts/.env now? (add it back for the staking deploy later) [y/N] " CLR
  if [ "$CLR" = y ] || [ "$CLR" = Y ]; then sed -i 's/^DEPLOYER_KEY=.*/DEPLOYER_KEY=/' .env && echo "${g}✓ DEPLOYER_KEY cleared${n}"; fi
fi
