#!/usr/bin/env bash
# Prints (does NOT run) the near-cli-rs commands that deploy + initialise the Mandate Vault on TESTNET and
# the owner-side setup (allow a template, grant a mandate). This script holds no keys and never signs or
# sends anything: a human reviews the printed commands and runs them with their own keychain / Ledger.
# There is no mainnet path: NEAR_NETWORK must be testnet.
#
# Required env:
#   VAULT_ACCOUNT   account that receives the vault contract, e.g. vault.you.testnet. It must be funded:
#                   everything above storage + 1 NEAR is what the agent can draw/deploy with.
#   OWNER_ID        owner account (use a multisig for anything that matters)
# Optional env (only used for the owner-setup commands that are printed):
#   AGENT_ID        agent account for set_mandate
#   TEMPLATE_WASM   wasm to allowlist as a template (default: contracts/near-registry/dist/autonear_registry.wasm)
#   TEMPLATE_INIT_ARGS  JSON object passed to the template's `new` (fixed by the owner, <= 1 KiB)
#   TEMPLATE_DEPOSIT    NEAR forwarded to each deployed sub-account (default "5 NEAR": ~2.1 NEAR per 210 KB wasm + state)
#   TEMPLATE_LABEL      default "registry-v1" (<= 64 bytes)
#   MANDATE_HOURS       mandate lifetime in hours, 1..720 (default 24)
#   PER_DRAW / PERIOD_CAP / TOTAL_CAP   in NEAR (defaults 1 / 5 / 20); PERIOD_SECS (default 3600); MAX_DEPLOYS (default 3)
#   WASM            vault wasm (default contracts/near-vault/dist/autonear_vault.wasm)
#   NETWORK_ID      string stored in the vault (default testnet)
#
# Syntax follows near-cli-rs (`near contract deploy <account> use-file <wasm> with-init-call <method>
# json-args <json> prepaid-gas <gas> attached-deposit <amount> network-config <net> sign-with-keychain send`
# and `near contract call-function as-transaction <contract> <method> json-args <json> prepaid-gas <gas>
# attached-deposit <amount> sign-as <account> network-config <net> sign-with-keychain send`), the same shape as
# scripts/near-deploy.sh. NONE of these commands has been executed by this repository's tests (the near CLI is not
# installed here); the contract itself IS exercised on a local sandbox (contracts/near-vault/integration).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="${WASM:-$ROOT/contracts/near-vault/dist/autonear_vault.wasm}"
TEMPLATE_WASM="${TEMPLATE_WASM:-$ROOT/contracts/near-registry/dist/autonear_registry.wasm}"
NETWORK="${NEAR_NETWORK:-testnet}"
NETWORK_ID="${NETWORK_ID:-testnet}"
TEMPLATE_LABEL="${TEMPLATE_LABEL:-registry-v1}"
TEMPLATE_DEPOSIT="${TEMPLATE_DEPOSIT:-5}"
MANDATE_HOURS="${MANDATE_HOURS:-24}"
PER_DRAW="${PER_DRAW:-1}"
PERIOD_CAP="${PERIOD_CAP:-5}"
TOTAL_CAP="${TOTAL_CAP:-20}"
PERIOD_SECS="${PERIOD_SECS:-3600}"
MAX_DEPLOYS="${MAX_DEPLOYS:-3}"

die() { echo "error: $*" >&2; exit 1; }

: "${VAULT_ACCOUNT:?set VAULT_ACCOUNT}"
: "${OWNER_ID:?set OWNER_ID}"

[ "$NETWORK" = "testnet" ] || die "NEAR_NETWORK must be testnet (there is no mainnet path for the vault; got '$NETWORK')"
valid_account() { [[ "$1" =~ ^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$ ]] && [[ "$1" != *..* ]]; }
for v in VAULT_ACCOUNT OWNER_ID; do valid_account "${!v}" || die "$v is not a valid NEAR account id: '${!v}'"; done
[ -z "${AGENT_ID:-}" ] || valid_account "$AGENT_ID" || die "AGENT_ID is not a valid NEAR account id"
[[ "$NETWORK_ID" =~ ^[a-z0-9_-]{1,32}$ ]] || die "NETWORK_ID must match [a-z0-9_-]{1,32}"
[[ "$TEMPLATE_LABEL" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "TEMPLATE_LABEL must match [A-Za-z0-9._-]{1,64}"
for n in TEMPLATE_DEPOSIT PER_DRAW PERIOD_CAP TOTAL_CAP; do [[ "${!n}" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "$n must be a number of NEAR"; done
for n in MANDATE_HOURS PERIOD_SECS MAX_DEPLOYS; do [[ "${!n}" =~ ^[0-9]+$ ]] || die "$n must be an integer"; done
[ "$MANDATE_HOURS" -ge 1 ] && [ "$MANDATE_HOURS" -le 720 ] || die "MANDATE_HOURS must be 1..720 (30 days max)"
[ "$PERIOD_SECS" -ge 60 ] && [ "$PERIOD_SECS" -le 2592000 ] || die "PERIOD_SECS must be 60..2592000"
[ "$MAX_DEPLOYS" -le 1000 ] || die "MAX_DEPLOYS must be <= 1000"
case "$WASM$TEMPLATE_WASM" in *"'"*) die "single quotes are not allowed in paths" ;; esac

[ -f "$WASM" ] || echo "note: $WASM not found yet; run scripts/near-vault-build.sh first" >&2
[ ! -f "$WASM" ] || echo "# vault wasm sha256: $(shasum -a 256 "$WASM" | awk '{print $1}') ($(wc -c < "$WASM" | tr -d ' ') bytes)" >&2

echo "# network: $NETWORK | vault account: $VAULT_ACCOUNT | owner: $OWNER_ID" >&2
echo "# Review, then run each command yourself. Nothing below has been executed." >&2
echo >&2
echo "# 1. deploy + init the vault in ONE atomic batch (cannot be front-run):"
echo "near contract deploy '$VAULT_ACCOUNT' use-file '$WASM' with-init-call new json-args '{\"owner\":\"$OWNER_ID\",\"network_id\":\"$NETWORK_ID\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' network-config $NETWORK sign-with-keychain send"
echo
echo "# 2. fund the vault (this is the agent's whole budget; testnet NEAR only). Plain transfer, no event:"
echo "#    near tokens '$OWNER_ID' send-near '$VAULT_ACCOUNT' '<N> NEAR' network-config $NETWORK sign-with-keychain send"

if [ -f "$TEMPLATE_WASM" ]; then
  TID="$(shasum -a 256 "$TEMPLATE_WASM" | awk '{print $1}')"
  ARGS="${TEMPLATE_INIT_ARGS:-}"
  if [ -z "$ARGS" ] && [ -n "${AGENT_ID:-}" ]; then
    ARGS="{\"owner_id\":\"$OWNER_ID\",\"proposer_id\":\"$AGENT_ID\",\"network_id\":\"$NETWORK_ID\"}"
  fi
  if [ -n "$ARGS" ]; then
    case "$ARGS" in *"'"*) die "single quotes are not allowed in TEMPLATE_INIT_ARGS" ;; esac
    [ "${#ARGS}" -le 1024 ] || die "TEMPLATE_INIT_ARGS is longer than 1 KiB"
    DEP_YOCTO="$(DEP="$TEMPLATE_DEPOSIT" python3 -c 'import os; from decimal import Decimal; print(int(Decimal(os.environ["DEP"])*10**24))')"
    echo
    echo "# 3. owner allowlists the template (id = sha256 of $TEMPLATE_WASM). init args are fixed HERE, the agent cannot pick them:"
    echo "near contract call-function as-transaction '$VAULT_ACCOUNT' allow_template json-args '{\"template_id\":\"$TID\",\"label\":\"$TEMPLATE_LABEL\",\"deposit\":\"$DEP_YOCTO\",\"init_args\":$ARGS,\"init_gas\":\"30000000000000\"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as '$OWNER_ID' network-config $NETWORK sign-with-keychain send"
  else
    echo
    echo "# 3. (skipped) set TEMPLATE_INIT_ARGS or AGENT_ID to print the allow_template command for template $TID"
  fi
else
  echo "# 3. (skipped) $TEMPLATE_WASM not found" >&2
fi

if [ -n "${AGENT_ID:-}" ]; then
  EXPIRES="$(( $(date +%s) + MANDATE_HOURS * 3600 ))"
  y() { DEP="$1" python3 -c 'import os; from decimal import Decimal; print(int(Decimal(os.environ["DEP"])*10**24))'; }
  echo
  echo "# 4. owner grants the mandate (expires_at = $EXPIRES unix seconds, computed NOW; re-run this script right before running the command):"
  echo "near contract call-function as-transaction '$VAULT_ACCOUNT' set_mandate json-args '{\"agent\":\"$AGENT_ID\",\"expires_at\":\"$EXPIRES\",\"per_draw_cap\":\"$(y "$PER_DRAW")\",\"period_secs\":\"$PERIOD_SECS\",\"period_cap\":\"$(y "$PERIOD_CAP")\",\"total_cap\":\"$(y "$TOTAL_CAP")\",\"max_deploys\":$MAX_DEPLOYS}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as '$OWNER_ID' network-config $NETWORK sign-with-keychain send"
else
  echo
  echo "# 4. (skipped) set AGENT_ID to print the set_mandate command"
fi

cat <<NOTE

# 5. CHECK, then decide about the vault account's own keys (human decision, NOT printed as a command):
#    The vault contract has no upgrade method, but whoever holds a FULL-ACCESS KEY on $VAULT_ACCOUNT can redeploy it or
#    transfer its balance, bypassing every rule. Either keep that key under the owner multisig, or, once everything is
#    verified and you accept that the vault can then never be changed, delete the key with 'near account delete-keys'.
#    Owner funds stay recoverable via withdraw() either way.
# Verify: near contract call-function as-read-only '$VAULT_ACCOUNT' config json-args '{}' network-config $NETWORK now
NOTE
