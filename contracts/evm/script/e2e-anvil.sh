#!/usr/bin/env bash
#
# LOCAL ANVIL end-to-end rehearsal of ProposalRegistry v1.  NOT a public testnet.
#
# Starts its own `anvil` on a free port, deploys the registry with script/Deploy.s.sol, then drives the full
# lifecycle with `cast`:  propose -> approve -> markExecuted,  plus cancel, pause, an expired-proposal revert
# (anvil time travel), a replay revert, role/ETH negatives.  Every step asserts; the first failure stops the run
# with the output that caused it, and the anvil process is always stopped on exit.
#
# What this proves: the deploy script, real transaction signing/nonces, eth_getCode == artifact deployedBytecode,
# the documented id encoding reproduced off-chain with `cast`, and the revert selectors a backend would see.
# What it does NOT prove: public-network gas prices, congestion, RPC flakiness, or anything about a multisig.
#
#     bash script/e2e-anvil.sh            # from anywhere; no arguments, no env required
#
# The keys below are anvil's well-known deterministic dev keys (public, worthless). This script never reads a
# key from any file and refuses to run against a non-local RPC because it starts its own anvil.

set -euo pipefail

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

cleanup() {
  if [ -n "$ANVIL_PID" ] && kill -0 "$ANVIL_PID" 2>/dev/null; then
    kill "$ANVIL_PID" 2>/dev/null || true
    wait "$ANVIL_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# anvil dev accounts 0..3. PUBLIC, WELL-KNOWN TEST KEYS - NEVER FUND THESE ADDRESSES ON ANY REAL NETWORK (bots sweep them).
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
OWNER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
PROPOSER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
OUTSIDER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6
DEPLOYER=$(cast wallet address --private-key $DEPLOYER_KEY)
OWNER=$(cast wallet address --private-key $OWNER_KEY)
PROPOSER=$(cast wallet address --private-key $PROPOSER_KEY)
OUTSIDER=$(cast wallet address --private-key $OUTSIDER_KEY)

TARGET=0xdAC17F958D2ee523a2206206994597C13D831ec7
OTHER_TARGET=0x1111111111111111111111111111111111111111
METHOD_SIG='transfer(address,uint256)'
SELECTOR=$(cast sig "$METHOD_SIG")
BAD_SELECTOR=$(cast sig 'approve(address,uint256)')
MAX_SPEND=1000000
MAX_SPEND_CAP=5000000
ARTIFACT_HASH=$(cast keccak "autonear-e2e-artifact")
TYPE_STRING='Proposal(uint256 chainId,address registry,address target,bytes4 selector,uint256 maxSpend,uint64 expiry,uint64 nonce,bytes32 artifactHash)'

step() { echo ""; echo "=== $* ==="; }
fail() { echo "FAILED: $*" >&2; exit 1; }
lc() { echo "$1" | tr 'A-Z' 'a-z'; }

assert_eq() {
  [ "$(lc "$2")" = "$(lc "$3")" ] || fail "$1: expected '$3', got '$2'"
  echo "  ok: $1"
}

call() { cast call --rpc-url "$RPC" "$@"; }
num() { echo "$1" | awk '{print $1}' | tr -d '()'; }
field() { echo "$1" | tr -d '()' | cut -d, -f"$2" | awk '{print $1}'; }
block_ts() { cast block latest --rpc-url "$RPC" --json | jq -r '.timestamp' | xargs printf '%d\n'; }

# Send a transaction, assert it mined with status 1, record its hash under a label, echo the full receipt JSON.
send() {
  local label="$1" key="$2"; shift 2
  local receipt status hash gas
  receipt=$(cast send --json --private-key "$key" --rpc-url "$RPC" "$@" 2>&1) \
    || fail "tx '$label' failed to send: $receipt"
  status=$(echo "$receipt" | jq -r '.status')
  hash=$(echo "$receipt" | jq -r '.transactionHash')
  [ "$status" = "0x1" ] || [ "$status" = "1" ] || fail "tx '$label' mined with status $status ($hash)"
  gas=$(echo "$receipt" | jq -r '.gasUsed' | xargs printf '%d')
  printf '%s\t%s\t%s\n' "$label" "$hash" "$gas" >> "$TXLOG"
  echo "  tx  $label  $hash  gasUsed=$gas"
  LAST_RECEIPT="$receipt"
}

# Assert a send is rejected with a specific custom error (matched by its 4-byte selector in the revert data).
expect_revert() {
  local label="$1" errsig="$2" key="$3"; shift 3
  local sel out
  sel=$(lc "$(cast sig "$errsig")")
  if out=$(cast send --json --private-key "$key" --rpc-url "$RPC" "$@" 2>&1); then
    fail "$label: expected revert $errsig but the transaction succeeded: $out"
  fi
  if ! lc "$out" | grep -q "${sel#0x}"; then
    fail "$label: reverted, but not with $errsig ($sel). Output: $out"
  fi
  echo "  ok: reverts $errsig  <- $label"
}

status_name() {
  case "$1" in
    0) echo None ;; 1) echo Pending ;; 2) echo Approved ;; 3) echo Executed ;; 4) echo Cancelled ;; 5) echo Expired ;;
    *) echo "?$1" ;;
  esac
}
assert_status() { assert_eq "$1 is $2" "$(status_name "$(num "$(call "$REG" 'statusOf(bytes32)(uint8)' "$3")")")" "$2"; }

# Off-chain id, per the README: keccak256(abi.encode(typehash, chainId, registry, target, selector, ...)).
offchain_id() { # target selector maxSpend expiry nonce
  local typehash enc
  typehash=$(cast keccak "$TYPE_STRING")
  enc=$(cast abi-encode 'f(bytes32,uint256,address,address,bytes4,uint256,uint64,uint64,bytes32)' \
    "$typehash" "$CHAIN_ID" "$REG" "$1" "$2" "$3" "$4" "$5" "$ARTIFACT_HASH")
  cast keccak "$enc"
}

# propose via cast; sets PID (id from the Proposed event) and cross-checks computeId + the off-chain encoding.
propose_ok() { # label key target selector maxSpend expiry nonce
  local label="$1" key="$2" t="$3" s="$4" m="$5" e="$6" n="$7"
  local onchain offchain topic
  onchain=$(call "$REG" 'computeId(address,bytes4,uint256,uint64,uint64,bytes32)(bytes32)' "$t" "$s" "$m" "$e" "$n" "$ARTIFACT_HASH")
  offchain=$(offchain_id "$t" "$s" "$m" "$e" "$n")
  assert_eq "off-chain cast encoding == on-chain computeId ($label)" "$offchain" "$onchain"
  send "$label" "$key" "$REG" 'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$t" "$s" "$m" "$e" "$n" "$ARTIFACT_HASH"
  topic=$(echo "$LAST_RECEIPT" | jq -r --arg a "$(lc "$REG")" \
    '.logs[] | select((.address|ascii_downcase)==$a) | .topics[1]' | head -1)
  assert_eq "Proposed event id == computeId ($label)" "$topic" "$onchain"
  PID="$onchain"
}

# ------------------------------------------------------------------------------------------------------------
echo "################################################################################"
echo "# LOCAL ANVIL rehearsal  (NOT a public testnet; nothing here touches a real network)"
echo "################################################################################"

step "0. Start anvil on a free port ($PORT)"
anvil --port "$PORT" --silent >"$WORK/anvil.log" 2>&1 &
ANVIL_PID=$!
for _ in $(seq 1 100); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  kill -0 "$ANVIL_PID" 2>/dev/null || fail "anvil exited: $(cat "$WORK/anvil.log")"
  sleep 0.1
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || fail "anvil did not become ready"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC")
assert_eq "chain id is anvil's 31337 (local)" "$CHAIN_ID" "31337"

step "1. Build + deploy with script/Deploy.s.sol"
forge build >/dev/null
export OWNER PROPOSER MAX_SPEND_CAP
forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast --silent >"$WORK/deploy.log" 2>&1 \
  || fail "deploy script failed: $(cat "$WORK/deploy.log")"
DEPLOY_LOG="broadcast/Deploy.s.sol/$CHAIN_ID/run-latest.json"
REG=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="ProposalRegistry") | .contractAddress' "$DEPLOY_LOG" | head -1)
DEPLOY_TX=$(jq -r '.transactions[] | select(.transactionType=="CREATE" and .contractName=="ProposalRegistry") | .hash' "$DEPLOY_LOG" | head -1)
[ -n "$REG" ] && [ "$REG" != "null" ] || fail "no ProposalRegistry in $DEPLOY_LOG"
DEPLOY_GAS=$(cast receipt "$DEPLOY_TX" gasUsed --rpc-url "$RPC" | awk '{print $1}')
printf '%s\t%s\t%s\n' "deploy" "$DEPLOY_TX" "$DEPLOY_GAS" >> "$TXLOG"
echo "  registry $REG"
echo "  deploy tx $DEPLOY_TX"

ONCHAIN_CODE=$(cast code "$REG" --rpc-url "$RPC")
ARTIFACT_CODE=$(jq -r '.deployedBytecode.object' out/ProposalRegistry.sol/ProposalRegistry.json)
assert_eq "eth_getCode == artifact deployedBytecode (no immutables)" "$ONCHAIN_CODE" "$ARTIFACT_CODE"
CODEHASH=$(cast keccak "$ONCHAIN_CODE")
CFG=$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')
assert_eq "owner"           "$(field "$CFG" 1)" "$OWNER"
assert_eq "pendingOwner"    "$(field "$CFG" 2)" "0x0000000000000000000000000000000000000000"
assert_eq "proposer"        "$(field "$CFG" 3)" "$PROPOSER"
assert_eq "paused=false"    "$(field "$CFG" 4)" "false"
assert_eq "networkId"       "$(field "$CFG" 5)" "$CHAIN_ID"
assert_eq "nextNonce=0"     "$(field "$CFG" 6)" "0"
assert_eq "maxSpendCap"     "$(field "$CFG" 7)" "$MAX_SPEND_CAP"
[ "$(lc "$DEPLOYER")" != "$(lc "$(field "$CFG" 1)")" ] && [ "$(lc "$DEPLOYER")" != "$(lc "$(field "$CFG" 3)")" ] \
  || fail "deployer unexpectedly holds a role"
echo "  ok: deploy key holds no role (owner/proposer are separate keys)"

step "2. Owner allowlists (target, transfer(address,uint256))"
expect_revert "outsider addAllowed" 'NotOwner(address)' "$OUTSIDER_KEY" "$REG" 'addAllowed(address,bytes4)' "$TARGET" "$SELECTOR"
expect_revert "proposer addAllowed" 'NotOwner(address)' "$PROPOSER_KEY" "$REG" 'addAllowed(address,bytes4)' "$TARGET" "$SELECTOR"
send allowlist_add "$OWNER_KEY" "$REG" 'addAllowed(address,bytes4)' "$TARGET" "$SELECTOR"
assert_eq "isAllowed(target, selector)" "$(call "$REG" 'isAllowed(address,bytes4)(bool)' "$TARGET" "$SELECTOR")" "true"
assert_eq "isAllowed(other target)"      "$(call "$REG" 'isAllowed(address,bytes4)(bool)' "$OTHER_TARGET" "$SELECTOR")" "false"

step "3. ETH is rejected (no payable function, no receive/fallback)"
if cast send --private-key "$OUTSIDER_KEY" --rpc-url "$RPC" "$REG" --value 1wei >/dev/null 2>&1; then
  fail "registry accepted a plain ETH transfer"
fi
echo "  ok: plain ETH transfer reverts"
assert_eq "registry ETH balance is 0" "$(cast balance "$REG" --rpc-url "$RPC")" "0"

step "4. FULL LIFECYCLE: propose -> approve -> markExecuted"
NOW=$(block_ts)
EXPIRY=$((NOW + 86400))
expect_revert "outsider propose" 'NotProposerOrOwner(address)' "$OUTSIDER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 0 "$ARTIFACT_HASH"
expect_revert "wrong target"    'NotAllowlisted(address,bytes4)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$OTHER_TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 0 "$ARTIFACT_HASH"
expect_revert "wrong method"    'NotAllowlisted(address,bytes4)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$BAD_SELECTOR" "$MAX_SPEND" "$EXPIRY" 0 "$ARTIFACT_HASH"
expect_revert "over cap"        'MaxSpendExceedsCap(uint256,uint256)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" $((MAX_SPEND_CAP + 1)) "$EXPIRY" 0 "$ARTIFACT_HASH"
expect_revert "bad nonce (1, expected 0)" 'BadNonce(uint64,uint64)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 1 "$ARTIFACT_HASH"

propose_ok propose_1 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 0
ID1="$PID"
assert_status "proposal 1" Pending "$ID1"
assert_eq "nextNonce=1" "$(field "$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')" 6)" "1"

echo "  -- replay of the identical proposal"
expect_revert "replay identical proposal" 'ProposalAlreadyExists(bytes32)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 0 "$ARTIFACT_HASH"

echo "  -- roles"
expect_revert "proposer cannot approve" 'NotOwner(address)' "$PROPOSER_KEY" "$REG" 'approve(bytes32)' "$ID1"
expect_revert "outsider cannot approve" 'NotOwner(address)' "$OUTSIDER_KEY" "$REG" 'approve(bytes32)' "$ID1"
expect_revert "execute before approve"  'InvalidStatus(bytes32,uint8)' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" 1 0x01

send approve_1 "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID1"
assert_status "proposal 1" Approved "$ID1"
expect_revert "proposer cannot cancel Approved" 'NotAuthorizedToCancel(address,bytes32)' "$PROPOSER_KEY" "$REG" 'cancel(bytes32)' "$ID1"
expect_revert "proposer cannot execute" 'NotOwner(address)' "$PROPOSER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" 1 0x01
expect_revert "spent > maxSpend" 'SpentExceedsMaxSpend(uint256,uint256)' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" $((MAX_SPEND + 1)) 0x01
expect_revert "empty receipt ref" 'EmptyReceiptRef()' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" 1 0x

RECEIPT_REF=$(cast --from-utf8 "eip155:31337/tx:local-rehearsal-1")
send mark_executed_1 "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" 750000 "$RECEIPT_REF"
assert_status "proposal 1" Executed "$ID1"
expect_revert "double execute" 'InvalidStatus(bytes32,uint8)' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID1" 1 0x02
expect_revert "cancel after execute" 'InvalidStatus(bytes32,uint8)' "$OWNER_KEY" "$REG" 'cancel(bytes32)' "$ID1"
P1=$(call "$REG" 'getProposal(bytes32)((bytes32,address,address,bytes4,uint256,uint64,uint64,bytes32,uint8,uint64,uint64,uint64,uint256,bytes))' "$ID1")
assert_eq "recorded spent" "$(field "$P1" 13)" "750000"
assert_eq "recorded receiptRef" "$(field "$P1" 14)" "$RECEIPT_REF"

step "5. Cancel path"
propose_ok propose_2 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 1
ID2="$PID"
expect_revert "outsider cannot cancel" 'NotAuthorizedToCancel(address,bytes32)' "$OUTSIDER_KEY" "$REG" 'cancel(bytes32)' "$ID2"
send cancel_2 "$PROPOSER_KEY" "$REG" 'cancel(bytes32)' "$ID2"
assert_status "proposal 2" Cancelled "$ID2"
expect_revert "approve after cancel" 'InvalidStatus(bytes32,uint8)' "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID2"

step "6. Pause: blocks propose/approve/execute, not cancel"
propose_ok propose_3 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 2
ID3="$PID"
propose_ok propose_4 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 3
ID4="$PID"
send approve_4 "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID4"
expect_revert "outsider pause" 'NotOwner(address)' "$OUTSIDER_KEY" "$REG" 'pause()'
send pause "$OWNER_KEY" "$REG" 'pause()'
assert_eq "paused=true" "$(field "$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')" 4)" "true"
expect_revert "propose while paused" 'RegistryPaused()' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" "$EXPIRY" 4 "$ARTIFACT_HASH"
expect_revert "approve while paused" 'RegistryPaused()' "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID3"
expect_revert "execute while paused" 'RegistryPaused()' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID4" 1 0x01
send cancel_3_while_paused "$PROPOSER_KEY" "$REG" 'cancel(bytes32)' "$ID3"
send cancel_4_while_paused "$OWNER_KEY" "$REG" 'cancel(bytes32)' "$ID4"
assert_status "proposal 3 (cancelled while paused)" Cancelled "$ID3"
assert_status "proposal 4 (cancelled while paused)" Cancelled "$ID4"
send unpause "$OWNER_KEY" "$REG" 'unpause()'
assert_eq "paused=false" "$(field "$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')" 4)" "false"

step "7. Expired proposal (anvil time travel)"
NOW=$(block_ts)
SHORT_EXPIRY=$((NOW + 3600))
propose_ok propose_5 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$SHORT_EXPIRY" 4
ID5="$PID"
propose_ok propose_6 "$PROPOSER_KEY" "$TARGET" "$SELECTOR" "$MAX_SPEND" "$SHORT_EXPIRY" 5
ID6="$PID"
send approve_6 "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID6"
expect_revert "expiry too far (>30d)" 'ExpiryTooFar(uint64,uint256)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" $((NOW + 31*86400)) 6 "$ARTIFACT_HASH"
cast rpc evm_increaseTime 7200 --rpc-url "$RPC" >/dev/null
cast rpc evm_mine --rpc-url "$RPC" >/dev/null
assert_status "proposal 5 (derived)" Expired "$ID5"
assert_status "proposal 6 (derived)" Expired "$ID6"
expect_revert "approve expired"      'ProposalExpired(bytes32,uint64)' "$OWNER_KEY" "$REG" 'approve(bytes32)' "$ID5"
expect_revert "markExecuted expired" 'ProposalExpired(bytes32,uint64)' "$OWNER_KEY" "$REG" 'markExecuted(bytes32,uint256,bytes)' "$ID6" 1 0x01
expect_revert "expiry in the past"   'ExpiryNotInFuture(uint64,uint256)' "$PROPOSER_KEY" "$REG" \
  'propose(address,bytes4,uint256,uint64,uint64,bytes32)' "$TARGET" "$SELECTOR" "$MAX_SPEND" "$NOW" 6 "$ARTIFACT_HASH"

step "8. Two-step ownership"
NEW_OWNER_KEY=$OUTSIDER_KEY
NEW_OWNER=$OUTSIDER
expect_revert "transfer to zero" 'ZeroAddress()' "$OWNER_KEY" "$REG" 'transferOwnership(address)' 0x0000000000000000000000000000000000000000
expect_revert "transfer to self" 'SelfTransfer()' "$OWNER_KEY" "$REG" 'transferOwnership(address)' "$OWNER"
send transfer_ownership "$OWNER_KEY" "$REG" 'transferOwnership(address)' "$NEW_OWNER"
expect_revert "wrong acceptor" 'NotPendingOwner(address)' "$PROPOSER_KEY" "$REG" 'acceptOwnership()'
send accept_ownership "$NEW_OWNER_KEY" "$REG" 'acceptOwnership()'
assert_eq "owner rotated" "$(field "$(call "$REG" 'config()((address,address,address,bool,uint256,uint64,uint256))')" 1)" "$NEW_OWNER"
expect_revert "old owner lost power" 'NotOwner(address)' "$OWNER_KEY" "$REG" 'pause()'

step "9. Final state"
assert_eq "proposalCount" "$(num "$(call "$REG" 'proposalCount()(uint256)')")" "6"
assert_eq "registry ETH balance still 0" "$(cast balance "$REG" --rpc-url "$RPC")" "0"
assert_eq "runtime code unchanged" "$(cast keccak "$(cast code "$REG" --rpc-url "$RPC")")" "$CODEHASH"

echo ""
echo "================ SUMMARY (LOCAL ANVIL, chainId $CHAIN_ID, NOT a public testnet) ================"
jq -n --arg net "LOCAL ANVIL (not a public testnet)" --arg chain "$CHAIN_ID" --arg reg "$REG" \
  --arg codehash "$CODEHASH" --arg owner "$OWNER" --arg proposer "$PROPOSER" \
  --arg i1 "$ID1" --arg i2 "$ID2" --arg i3 "$ID3" --arg i4 "$ID4" --arg i5 "$ID5" --arg i6 "$ID6" \
  --rawfile txs "$TXLOG" '
  { network: $net, chainId: ($chain|tonumber), registry: $reg, runtimeCodeKeccak: $codehash,
    originalOwner: $owner, proposer: $proposer,
    proposals: { executed: $i1, cancelled: $i2, cancelledWhilePaused: [$i3,$i4], expired: [$i5,$i6] },
    txHashes: ($txs | split("\n") | map(select(length>0) | split("\t") | {(.[0]): .[1]}) | add),
    gasUsed: ($txs | split("\n") | map(select(length>0) | split("\t") | {(.[0]): (.[2]|tonumber)}) | add),
    result: "PASS" }'
