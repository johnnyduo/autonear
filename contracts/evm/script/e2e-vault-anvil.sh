#!/usr/bin/env bash
#
# LOCAL ANVIL end-to-end rehearsal of the Mandate Vault v1 (AgentVault).  NOT a public testnet (chain 31337).
#
# Starts its own `anvil` on a free port, deploys the vault with script/DeployVault.s.sol, funds it, and then drives
# the real scenario with `cast`:
#   owner  : setMandate, allowTemplate(keccak256(ProposalRegistry initcode incl. constructor args), deposit 0)
#   agent  : (a SEPARATE key) draw -> deploy the REAL ProposalRegistry initcode through the vault
# and verifies eth_getCode of the deployed registry == contracts/evm/dist/ProposalRegistry.json deployedBytecode, and
# that registry.config() owner/proposer/cap are exactly the args the OWNER fixed.  Then the negative paths: wrong code,
# unlisted template, agent-chosen owner, over budget (per-draw / period / total / deploy limit), strangers, pause,
# expiry, revoke, address reuse.  Time travel uses anvil's evm_increaseTime.
#
# What this proves: the deploy script (dry run sends nothing; --broadcast deploys), real signing/nonces, the vault's
# CREATE2 landing on predictAddress, runtime-code equality, preview selectors vs real revert selectors.
# What it does NOT prove: public-network gas prices, RPC flakiness, congestion, a multisig owner, or any audit.
#
#     bash script/e2e-vault-anvil.sh      # from anywhere; no arguments, no env required
#
# Keys below are anvil's well-known deterministic dev keys (public, worthless). This script never reads a key from any
# file and starts its own anvil, so it cannot touch a real network. Prints PASS/FAIL counts; exit 1 if any FAIL.

set -uo pipefail

export PATH="$HOME/.foundry/bin:$PATH"
cd "$(dirname "${BASH_SOURCE[0]}")/.."

for bin in anvil cast forge jq python3; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 1; }
done

PORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')"
RPC="http://127.0.0.1:$PORT"
WORK="$(mktemp -d)"
TXLOG="$WORK/txs.tsv"
: > "$TXLOG"
ANVIL_PID=""
PASS=0
FAILS=0

cleanup() {
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK" broadcast/DeployVault.s.sol cache/DeployVault.s.sol
}
trap cleanup EXIT

# anvil dev accounts. PUBLIC, WELL-KNOWN TEST KEYS - NEVER FUND THESE ADDRESSES ON ANY REAL NETWORK (bots sweep them).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # account 0
OWNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d      # account 1
AGENT_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a      # account 2
OUTSIDER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # account 3
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
OWNER=$(cast wallet address --private-key $OWNER_KEY)
AGENT=$(cast wallet address --private-key $AGENT_KEY)
OUTSIDER=$(cast wallet address --private-key $OUTSIDER_KEY)
# The REGISTRY's owner/proposer (anvil accounts 4 and 5; addresses only, they never sign here). Fixed by the vault OWNER.
REG_OWNER=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65
REG_PROPOSER=0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc
REG_CAP=5000000
ZERO=0x0000000000000000000000000000000000000000

# Mandate: 0.5 ETH per draw, 1 ETH per hour, 2 ETH total, 2 deploys, valid 1 day.
PER_DRAW=500000000000000000
PERIOD_SECS=3600
PERIOD_CAP=1000000000000000000
TOTAL_CAP=2000000000000000000
MAX_DEPLOYS=2
FUNDING=5ether

step() { echo ""; echo "=== $* ==="; }
lc() { echo "$1" | tr 'A-Z' 'a-z'; }
ok() { PASS=$((PASS + 1)); echo "  PASS: $*"; }
bad() { FAILS=$((FAILS + 1)); echo "  FAIL: $*"; }
die() { echo "FATAL: $*" >&2; exit 1; }

check_eq() { # label actual expected
  if [ "$(lc "$2")" = "$(lc "$3")" ]; then ok "$1"; else bad "$1: expected '$3', got '$2'"; fi
}

call() { cast call --rpc-url "$RPC" "$@"; }
num() { echo "$1" | awk '{print $1}' | tr -d '()'; }
field() { echo "$1" | tr -d '()' | cut -d, -f"$2" | awk '{print $1}'; }
block_ts() { cast block latest --rpc-url "$RPC" --json | jq -r '.timestamp' | xargs printf '%d\n'; }
warp() { cast rpc --rpc-url "$RPC" evm_increaseTime "$1" >/dev/null && cast rpc --rpc-url "$RPC" evm_mine >/dev/null; }

# Send a transaction that must mine with status 1. Sets LAST_RECEIPT (empty on failure). Counts PASS/FAIL.
send_ok() {
  local label="$1" key="$2"; shift 2
  local receipt status hash gas
  LAST_RECEIPT=""
  if ! receipt=$(cast send --json --private-key "$key" --rpc-url "$RPC" "$@" 2>&1); then
    bad "tx '$label' failed to send: $(echo "$receipt" | tail -c 300)"
    return 0
  fi
  status=$(echo "$receipt" | jq -r '.status')
  hash=$(echo "$receipt" | jq -r '.transactionHash')
  if [ "$status" != "0x1" ] && [ "$status" != "1" ]; then bad "tx '$label' mined with status $status ($hash)"; return 0; fi
  gas=$(echo "$receipt" | jq -r '.gasUsed' | xargs printf '%d')
  printf '%s\t%s\t%s\n' "$label" "$hash" "$gas" >> "$TXLOG"
  ok "tx $label  gasUsed=$gas"
  LAST_RECEIPT="$receipt"
}

# A send that must be rejected with a specific custom error (matched by its 4-byte selector in the revert data).
expect_revert() {
  local label="$1" errsig="$2" key="$3"; shift 3
  local sel out
  sel=$(lc "$(cast sig "$errsig")")
  if out=$(cast send --json --private-key "$key" --rpc-url "$RPC" "$@" 2>&1); then
    bad "$label: expected revert $errsig but the transaction succeeded"
    return 0
  fi
  if lc "$out" | grep -q "${sel#0x}"; then ok "reverts $errsig  <- $label"; else bad "$label: reverted, but not with $errsig ($sel): $(echo "$out" | tail -c 300)"; fi
}

# gasUsed * effectiveGasPrice of a receipt (hex fields in cast's JSON), in wei.
gas_cost() { echo $(( $(echo "$1" | jq -r '.gasUsed' | xargs printf '%d') * $(echo "$1" | jq -r '.effectiveGasPrice' | xargs printf '%d') )); }

selector() { cast sig "$1"; }   # 'Unauthorized()' -> 0x82b42900

# ------------------------------------------------------------------------------------------------------------
echo "################################################################################"
echo "# LOCAL ANVIL rehearsal of the Mandate Vault (NOT a public testnet; chain 31337)"
echo "################################################################################"

step "0. Start anvil on a free port ($PORT)"
anvil --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || die "anvil exited: $(cat "$WORK/anvil.log")"
  sleep 0.1
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || die "anvil did not become ready"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
check_eq "chain id is anvil's 31337 (local, not a public testnet)" "$CHAIN_ID" "31337"
[ "$CHAIN_ID" = "31337" ] || die "refusing to continue on chain $CHAIN_ID"

step "1. Build, then deploy with script/DeployVault.s.sol (dry run first, then --broadcast)"
forge build >/dev/null 2>&1 || die "forge build failed"
export OWNER
NONCE_BEFORE=$(cast nonce "$DEPLOYER" --rpc-url "$RPC")
BLOCK_BEFORE=$(cast block-number --rpc-url "$RPC")
forge script script/DeployVault.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --silent >"$WORK/dry.log" 2>&1 \
  || die "dry-run failed: $(cat "$WORK/dry.log")"
check_eq "dry run (no --broadcast) sent nothing: deployer nonce unchanged" "$(cast nonce "$DEPLOYER" --rpc-url "$RPC")" "$NONCE_BEFORE"
check_eq "dry run mined no block" "$(cast block-number --rpc-url "$RPC")" "$BLOCK_BEFORE"
forge script script/DeployVault.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --silent >"$WORK/deploy.log" 2>&1 \
  || die "deploy script failed: $(cat "$WORK/deploy.log")"
DEPLOY_LOG="broadcast/DeployVault.s.sol/$CHAIN_ID/run-latest.json"
VAULT=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="AgentVault") | .contractAddress' "$DEPLOY_LOG" | head -1)
DEPLOY_TX=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="AgentVault") | .hash' "$DEPLOY_LOG" | head -1)
[ -n "$VAULT" ] && [ "$VAULT" != "null" ] || die "no AgentVault in $DEPLOY_LOG"
printf '%s\t%s\t%s\n' "deploy_vault" "$DEPLOY_TX" "$(cast receipt "$DEPLOY_TX" gasUsed --rpc-url "$RPC" | awk '{print $1}')" >> "$TXLOG"
echo "  vault $VAULT"

ONCHAIN_CODE=$(cast code "$VAULT" --rpc-url "$RPC")
ARTIFACT_CODE=$(jq -r '.deployedBytecode.object' out/AgentVault.sol/AgentVault.json)
check_eq "vault eth_getCode == out/ artifact deployedBytecode" "$ONCHAIN_CODE" "$ARTIFACT_CODE"
if [ -f dist/AgentVault.json ]; then
  check_eq "vault eth_getCode == dist/AgentVault.json deployedBytecode (run scripts/evm-vault-build.mjs to refresh)" \
    "$ONCHAIN_CODE" "$(jq -r '.deployedBytecode' dist/AgentVault.json)"
fi
CFG=$(call "$VAULT" 'config()((address,address,bool,uint256,uint64))')
check_eq "vault owner"        "$(field "$CFG" 1)" "$OWNER"
check_eq "vault pendingOwner" "$(field "$CFG" 2)" "$ZERO"
check_eq "vault paused=false" "$(field "$CFG" 3)" "false"
check_eq "vault networkId"    "$(field "$CFG" 4)" "$CHAIN_ID"
check_eq "vault epoch=0"      "$(field "$CFG" 5)" "0"
[ "$(lc "$DEPLOYER")" != "$(lc "$OWNER")" ] && ok "deploy key is not the owner" || bad "deployer unexpectedly is the owner"

step "2. Owner funds the vault (plain transfer) and sets the mandate; agent is a separate key"
send_ok fund_vault "$OWNER_KEY" "$VAULT" --value "$FUNDING"
check_eq "vault balance after funding" "$(cast balance "$VAULT" --rpc-url "$RPC")" "5000000000000000000"
check_eq "available() == balance" "$(num "$(call "$VAULT" 'available()(uint256)')")" "5000000000000000000"
NOW=$(block_ts)
EXPIRES=$((NOW + 86400))
expect_revert "outsider setMandate" 'Unauthorized()' "$OUTSIDER_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" "$EXPIRES" $PER_DRAW $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP $MAX_DEPLOYS
expect_revert "agent setMandate (cannot widen its own budget)" 'Unauthorized()' "$AGENT_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" "$EXPIRES" $PER_DRAW $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP $MAX_DEPLOYS
expect_revert "owner setMandate with bad bounds (per_draw 0)" 'BadMandate()' "$OWNER_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" "$EXPIRES" 0 $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP $MAX_DEPLOYS
expect_revert "agent draw before any mandate" 'NoMandate()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1
send_ok set_mandate "$OWNER_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" "$EXPIRES" $PER_DRAW $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP $MAX_DEPLOYS
M=$(call "$VAULT" 'mandate()((address,uint64,uint32,uint64,uint64,bool,uint256,uint256,uint256))')
check_eq "mandate.agent"      "$(field "$M" 1)" "$AGENT"
check_eq "mandate.expiresAt"  "$(field "$M" 2)" "$EXPIRES"
check_eq "mandate.maxDeploys" "$(field "$M" 3)" "$MAX_DEPLOYS"
check_eq "mandate.revoked"    "$(field "$M" 6)" "false"
check_eq "mandate.perDrawCap" "$(field "$M" 7)" "$PER_DRAW"
check_eq "mandate.totalCap"   "$(field "$M" 9)" "$TOTAL_CAP"
check_eq "epoch is now 1" "$(field "$(call "$VAULT" 'config()((address,address,bool,uint256,uint64))')" 5)" "1"

step "3. Owner allowlists the REAL ProposalRegistry initcode with the constructor args FIXED by the owner"
REG_BYTECODE=$(jq -r '.bytecode' dist/ProposalRegistry.json)
REG_DEPLOYED=$(jq -r '.deployedBytecode' dist/ProposalRegistry.json)
REG_ARGS=$(cast abi-encode 'f(address,address,uint256)' "$REG_OWNER" "$REG_PROPOSER" "$REG_CAP")
INITCODE="${REG_BYTECODE}${REG_ARGS#0x}"
TEMPLATE_ID=$(cast keccak "$INITCODE")
check_eq "vault.templateIdOf(initcode) == keccak256(initcode)" "$(call "$VAULT" 'templateIdOf(bytes)(bytes32)' "$INITCODE")" "$TEMPLATE_ID"
EVIL_INITCODE="${REG_BYTECODE}$(cast abi-encode 'f(address,address,uint256)' "$AGENT" "$AGENT" "$REG_CAP" | cut -c3-)"
EVIL_ID=$(cast keccak "$EVIL_INITCODE")
SALT1=$(cast keccak "registry-1")
SALT2=$(cast keccak "registry-2")
SALT3=$(cast keccak "registry-3")

expect_revert "agent deploy before the template is allowlisted" 'TemplateNotAllowed()' "$AGENT_KEY" "$VAULT" \
  'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "$INITCODE"
expect_revert "outsider allowTemplate" 'Unauthorized()' "$OUTSIDER_KEY" "$VAULT" 'allowTemplate(bytes32,string,uint256)' "$TEMPLATE_ID" "registry-v1" 0
expect_revert "agent allowTemplate (cannot allowlist its own code)" 'Unauthorized()' "$AGENT_KEY" "$VAULT" 'allowTemplate(bytes32,string,uint256)' "$EVIL_ID" "evil" 0
expect_revert "owner allowTemplate with deposit != 0 (EVM must be 0)" 'BadTemplate()' "$OWNER_KEY" "$VAULT" 'allowTemplate(bytes32,string,uint256)' "$TEMPLATE_ID" "registry-v1" 1
send_ok allow_template "$OWNER_KEY" "$VAULT" 'allowTemplate(bytes32,string,uint256)' "$TEMPLATE_ID" "registry-v1" 0
check_eq "templateCount == 1" "$(num "$(call "$VAULT" 'templateCount()(uint256)')")" "1"

step "4. Agent draws gas money, then deploys the registry through the vault"
OK_SEL=0x00000000
check_eq "previewDraw(per_draw) == ok"        "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' $PER_DRAW)" "$OK_SEL"
check_eq "previewDraw(per_draw+1) == PerDrawCap" "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' $((PER_DRAW + 1)))" "$(selector 'PerDrawCap()')"
check_eq "previewDraw(0) == BadAmount"        "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' 0)" "$(selector 'BadAmount()')"
expect_revert "outsider draw" 'Unauthorized()' "$OUTSIDER_KEY" "$VAULT" 'draw(uint256)' 1
expect_revert "owner draw (the owner is not the agent)" 'Unauthorized()' "$OWNER_KEY" "$VAULT" 'draw(uint256)' 1
expect_revert "agent draw over per_draw_cap" 'PerDrawCap()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' $((PER_DRAW + 1))
expect_revert "agent draw 0" 'BadAmount()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 0
AGENT_BAL_BEFORE=$(cast balance "$AGENT" --rpc-url "$RPC")
send_ok draw_1 "$AGENT_KEY" "$VAULT" 'draw(uint256)' $PER_DRAW
DRAW_GAS_COST=$(gas_cost "$LAST_RECEIPT")
AGENT_BAL_AFTER=$(cast balance "$AGENT" --rpc-url "$RPC")
check_eq "agent balance rose by exactly the draw (net of its own gas)" "$((AGENT_BAL_AFTER - AGENT_BAL_BEFORE + DRAW_GAS_COST))" "$PER_DRAW"
check_eq "vault balance fell by exactly the draw" "$(cast balance "$VAULT" --rpc-url "$RPC")" "4500000000000000000"
U=$(call "$VAULT" 'usage()((uint256,uint256,uint64,uint32))')
check_eq "usage.totalSpent"  "$(field "$U" 1)" "$PER_DRAW"
check_eq "usage.periodSpent" "$(field "$U" 2)" "$PER_DRAW"
check_eq "usage.deploys"     "$(field "$U" 4)" "0"

check_eq "previewDeploy == ok" "$(call "$VAULT" 'previewDeploy(bytes32,bytes32)(bytes4)' "$TEMPLATE_ID" "$SALT1")" "$OK_SEL"
PREDICTED=$(call "$VAULT" 'predictAddress(bytes32,bytes32)(address)' "$TEMPLATE_ID" "$SALT1")
expect_revert "agent deploys registry with ITSELF as owner (not allowlisted)" 'TemplateNotAllowed()' "$AGENT_KEY" "$VAULT" \
  'deploy(bytes32,bytes32,bytes)' "$EVIL_ID" "$SALT1" "$EVIL_INITCODE"
expect_revert "agent claims the allowlisted id but submits other args" 'CodeMismatch()' "$AGENT_KEY" "$VAULT" \
  'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "$EVIL_INITCODE"
expect_revert "agent submits truncated code" 'CodeMismatch()' "$AGENT_KEY" "$VAULT" \
  'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "${INITCODE:0:200}"
expect_revert "outsider deploy" 'Unauthorized()' "$OUTSIDER_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "$INITCODE"
send_ok deploy_registry_1 "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "$INITCODE"
DEPLOYED_TOPIC=$(echo "$LAST_RECEIPT" | jq -r --arg a "$(lc "$VAULT")" '.logs[] | select((.address|ascii_downcase)==$a) | select(.topics|length==4) | .topics[3]' | head -1)
REG="0x${DEPLOYED_TOPIC: -40}"
check_eq "Deployed event target == predictAddress (CREATE2 precompute)" "$REG" "$PREDICTED"

step "5. Verify what was deployed"
check_eq "registry eth_getCode == dist/ProposalRegistry.json deployedBytecode" "$(cast code "$REG" --rpc-url "$RPC")" "$REG_DEPLOYED"
RCFG=$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')
check_eq "registry owner == owner-fixed arg"    "$(field "$RCFG" 1)" "$REG_OWNER"
check_eq "registry proposer == owner-fixed arg" "$(field "$RCFG" 3)" "$REG_PROPOSER"
check_eq "registry maxSpendCap == owner-fixed arg" "$(field "$RCFG" 7)" "$REG_CAP"
[ "$(lc "$(field "$RCFG" 1)")" != "$(lc "$AGENT")" ] && [ "$(lc "$(field "$RCFG" 3)")" != "$(lc "$AGENT")" ] \
  && ok "the agent holds NO role on what it deployed" || bad "agent holds a role on the registry"
[ "$(lc "$(field "$RCFG" 1)")" != "$(lc "$VAULT")" ] && ok "the vault does not own the registry either" || bad "vault owns the registry"
check_eq "registry holds no ether" "$(cast balance "$REG" --rpc-url "$RPC")" "0"
check_eq "vault balance unchanged by the deploy" "$(cast balance "$VAULT" --rpc-url "$RPC")" "4500000000000000000"
check_eq "usage.deploys == 1" "$(field "$(call "$VAULT" 'usage()((uint256,uint256,uint64,uint32))')" 4)" "1"

step "6. Negative paths: address reuse, deploy limit, budget"
check_eq "previewDeploy(same salt) == AddressTaken" "$(call "$VAULT" 'previewDeploy(bytes32,bytes32)(bytes4)' "$TEMPLATE_ID" "$SALT1")" "$(selector 'AddressTaken()')"
expect_revert "agent re-deploys at the same salt" 'AddressTaken()' "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT1" "$INITCODE"
send_ok deploy_registry_2 "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT2" "$INITCODE"
check_eq "previewDeploy(3rd) == DeployLimit" "$(call "$VAULT" 'previewDeploy(bytes32,bytes32)(bytes4)' "$TEMPLATE_ID" "$SALT3")" "$(selector 'DeployLimit()')"
expect_revert "agent 3rd deploy (max_deploys=2)" 'DeployLimit()' "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT3" "$INITCODE"

send_ok draw_2 "$AGENT_KEY" "$VAULT" 'draw(uint256)' $PER_DRAW   # period_spent == period_cap (1 ETH)
check_eq "previewDraw(1) == PeriodCap" "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' 1)" "$(selector 'PeriodCap()')"
expect_revert "agent draw beyond period_cap" 'PeriodCap()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1

step "7. Time: the next period re-opens the budget; total_cap still binds; expiry closes it"
warp 3600
send_ok draw_3 "$AGENT_KEY" "$VAULT" 'draw(uint256)' $PER_DRAW
send_ok draw_4 "$AGENT_KEY" "$VAULT" 'draw(uint256)' $PER_DRAW   # total_spent == total_cap (2 ETH)
check_eq "usage.totalSpent == total_cap" "$(field "$(call "$VAULT" 'usage()((uint256,uint256,uint64,uint32))')" 1)" "$TOTAL_CAP"
warp 3600
check_eq "previewDraw(1) == TotalCap" "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' 1)" "$(selector 'TotalCap()')"
expect_revert "agent draw beyond total_cap (new period, total exhausted)" 'TotalCap()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1

step "8. Pause, new mandate, revoke, expiry - and the owner can always withdraw"
NOW=$(block_ts)
send_ok pause "$OWNER_KEY" "$VAULT" 'pause()'
expect_revert "agent draw while paused (even with a fresh mandate)" 'Paused()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1
send_ok set_mandate_2_while_paused "$OWNER_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" $((NOW + 3600)) $PER_DRAW $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP 1
check_eq "epoch is now 2 and usage reset" "$(field "$(call "$VAULT" 'usage()((uint256,uint256,uint64,uint32))')" 1)" "0"
expect_revert "agent deploy while paused" 'Paused()' "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT3" "$INITCODE"
send_ok unpause "$OWNER_KEY" "$VAULT" 'unpause()'
send_ok draw_epoch2 "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1000
send_ok revoke "$OWNER_KEY" "$VAULT" 'revoke()'
check_eq "previewDraw after revoke == MandateInactive" "$(call "$VAULT" 'previewDraw(uint256)(bytes4)' 1)" "$(selector 'MandateInactive()')"
expect_revert "agent draw after revoke" 'MandateInactive()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1
expect_revert "agent deploy after revoke" 'MandateInactive()' "$AGENT_KEY" "$VAULT" 'deploy(bytes32,bytes32,bytes)' "$TEMPLATE_ID" "$SALT3" "$INITCODE"
send_ok set_mandate_3 "$OWNER_KEY" "$VAULT" \
  'setMandate(address,uint256,uint256,uint256,uint256,uint256,uint256)' "$AGENT" $(( $(block_ts) + 120 )) $PER_DRAW $PERIOD_SECS $PERIOD_CAP $TOTAL_CAP 1
send_ok draw_epoch3 "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1000
warp 200
expect_revert "agent draw after expiry" 'MandateInactive()' "$AGENT_KEY" "$VAULT" 'draw(uint256)' 1

expect_revert "agent withdraw" 'Unauthorized()' "$AGENT_KEY" "$VAULT" 'withdraw(uint256)' 1
expect_revert "outsider withdraw" 'Unauthorized()' "$OUTSIDER_KEY" "$VAULT" 'withdraw(uint256)' 1
expect_revert "owner withdraw 0" 'BadAmount()' "$OWNER_KEY" "$VAULT" 'withdraw(uint256)' 0
LEFT=$(cast balance "$VAULT" --rpc-url "$RPC")
expect_revert "owner withdraw more than available" 'InsufficientBalance()' "$OWNER_KEY" "$VAULT" 'withdraw(uint256)' $((LEFT + 1))
OWNER_BAL_BEFORE=$(cast balance "$OWNER" --rpc-url "$RPC")
send_ok withdraw_all "$OWNER_KEY" "$VAULT" 'withdraw(uint256)' "$LEFT"
W_GAS_COST=$(gas_cost "$LAST_RECEIPT")
check_eq "owner received exactly the withdrawal (net of gas), after revoke+expiry" "$(( $(cast balance "$OWNER" --rpc-url "$RPC") - OWNER_BAL_BEFORE + W_GAS_COST ))" "$LEFT"
check_eq "vault is empty; nothing trapped" "$(cast balance "$VAULT" --rpc-url "$RPC")" "0"
check_eq "vault code unchanged at the end (no upgrade path)" "$(cast code "$VAULT" --rpc-url "$RPC")" "$ARTIFACT_CODE"

step "Gas used"
awk -F'\t' '{printf "  %-28s gas=%s\n", $1, $3}' "$TXLOG"

echo ""
echo "################################################################################"
echo "# RESULT: PASS=$PASS FAIL=$FAILS   (local anvil chain 31337; NOT a public testnet)"
echo "################################################################################"
[ "$FAILS" -eq 0 ]
