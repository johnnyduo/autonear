#!/usr/bin/env bash
# Prints (does NOT run) the near-cli-rs command that deploys + initialises the registry.
# This script holds no keys and never signs or sends anything: a human runs the printed command
# and signs with their own keychain / Ledger.
#
# Required env:
#   NEAR_DEPLOY_ACCOUNT  account that receives the contract (and signs the deploy), e.g. registry.you.testnet
#   OWNER_ID             owner account (use a multisig on any real network)
#   PROPOSER_ID          the AutoNEAR agent account (may only propose / cancel own Pending)
# Optional env:
#   NEAR_NETWORK         testnet (default) | mainnet. mainnet additionally needs I_UNDERSTAND_MAINNET=yes
#   MAX_SPEND_CAP        max_spend cap in yoctoNEAR (default: contract default, 100 NEAR)
#   WASM                 path to wasm (default contracts/near-registry/dist/autonear_registry.wasm)
#   INIT_GAS             default "30 Tgas"
#
# Syntax follows near-cli-rs (`near contract deploy <account> use-file <wasm> with-init-call <method>
# json-args <json> prepaid-gas <gas> attached-deposit <amount> network-config <net> sign-with-keychain send`),
# verified against the near-cli-rs source (js_command_match/contract/deploy.rs, v0.26.x) and docs.near.org examples.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WASM="${WASM:-$ROOT/contracts/near-registry/dist/autonear_registry.wasm}"
NETWORK="${NEAR_NETWORK:-testnet}"
INIT_GAS="${INIT_GAS:-30 Tgas}"

die() { echo "error: $*" >&2; exit 1; }

: "${NEAR_DEPLOY_ACCOUNT:?set NEAR_DEPLOY_ACCOUNT}"
: "${OWNER_ID:?set OWNER_ID}"
: "${PROPOSER_ID:?set PROPOSER_ID}"

case "$NETWORK" in
  testnet) ;;
  mainnet)
    [ "${I_UNDERSTAND_MAINNET:-}" = "yes" ] || die "refusing network=mainnet without I_UNDERSTAND_MAINNET=yes"
    ;;
  *) die "NEAR_NETWORK must be testnet or mainnet (got '$NETWORK')" ;;
esac

# Conservative NEAR account-id check (also keeps the JSON/shell quoting below trivially safe).
valid_account() { [[ "$1" =~ ^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$ ]] && [[ "$1" != *..* ]]; }
for v in NEAR_DEPLOY_ACCOUNT OWNER_ID PROPOSER_ID; do
  valid_account "${!v}" || die "$v is not a valid NEAR account id: '${!v}'"
done
[ "$OWNER_ID" != "$PROPOSER_ID" ] || echo "warning: OWNER_ID == PROPOSER_ID defeats role separation" >&2

# network_id inside the proposal id hash (must match what the backend uses).
ARGS="{\"owner_id\":\"$OWNER_ID\",\"proposer_id\":\"$PROPOSER_ID\",\"network_id\":\"$NETWORK\""
if [ -n "${MAX_SPEND_CAP:-}" ]; then
  [[ "$MAX_SPEND_CAP" =~ ^[1-9][0-9]*$ ]] || die "MAX_SPEND_CAP must be a positive integer (yoctoNEAR)"
  ARGS="$ARGS,\"max_spend_cap\":\"$MAX_SPEND_CAP\""
fi
ARGS="$ARGS}"

[ -f "$WASM" ] || echo "note: $WASM not found yet; run scripts/near-build.sh first" >&2
if [ -f "$WASM" ]; then
  echo "# wasm sha256: $(shasum -a 256 "$WASM" | awk '{print $1}') ($(wc -c < "$WASM" | tr -d ' ') bytes)" >&2
fi
echo "# network: $NETWORK | deploy account: $NEAR_DEPLOY_ACCOUNT | review, then run it yourself:" >&2

# Every interpolated value was validated above (account ids / digits only) except paths, so plain
# single-quoting is sufficient; a single quote inside a path is refused.
case "$WASM$INIT_GAS" in *"'"*) die "single quotes are not allowed in WASM / INIT_GAS" ;; esac
echo "near contract deploy '$NEAR_DEPLOY_ACCOUNT' use-file '$WASM' with-init-call new json-args '$ARGS' prepaid-gas '$INIT_GAS' attached-deposit '0 NEAR' network-config $NETWORK sign-with-keychain send"
