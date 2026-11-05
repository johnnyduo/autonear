#!/usr/bin/env bash
# Deterministic build of the NEAR vault (contracts/near-vault) + machine-readable manifest.
#
# Runs:  cargo build --locked --release --target wasm32-unknown-unknown
# Copies the wasm to contracts/near-vault/dist/autonear_vault.wasm
# Prints ONE JSON object on stdout (all logs go to stderr):
#   { sha256, bytes, rustc, nearSdk, cargoLockSha256, sourceSha256 }
#
#  - sha256 / bytes: of the dist wasm file.
#  - rustc: `rustc --version` as resolved by rust-toolchain.toml (pinned).
#  - nearSdk: the near-sdk version recorded in Cargo.lock.
#  - cargoLockSha256: sha256 of Cargo.lock.
#  - sourceSha256: sha256 over, in C-locale sorted relative-path order, "<path>\0<content>\0" for
#    Cargo.toml, Cargo.lock, rust-toolchain.toml and every file under src/ (paths relative to
#    contracts/near-vault, "/" separated; same scheme as scripts/evm-build.mjs).
#
# Reproducibility: --locked, pinned toolchain, absolute paths remapped via --remap-path-prefix.
# If `wasm-tools` is on PATH (or WASM_TOOLS=/path/to/wasm-tools) the wasm is also validated against
# the feature set the NEAR runtime accepts (MVP + sign-extension; no reference-types/bulk-memory/multivalue/simd).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CRATE="$ROOT/contracts/near-vault"
DIST="$CRATE/dist"
cd "$CRATE"

sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }

log() { echo "[near-vault-build] $*" >&2; }

export LC_ALL=C
SYSROOT="$(rustc --print sysroot)"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--remap-path-prefix=$CRATE=/src --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$SYSROOT=/rustc"
# Never inherit flags that could change codegen (e.g. target-cpu=native, extra target features).
unset CARGO_ENCODED_RUSTFLAGS CARGO_BUILD_RUSTFLAGS || true

log "rustc: $(rustc --version)"
cargo build --locked --release --target wasm32-unknown-unknown >&2

WASM_SRC="target/wasm32-unknown-unknown/release/autonear_vault.wasm"
mkdir -p "$DIST"
cp "$WASM_SRC" "$DIST/autonear_vault.wasm"
WASM="$DIST/autonear_vault.wasm"

WT="${WASM_TOOLS:-$(command -v wasm-tools || true)}"
if [ -n "$WT" ]; then
  # nearcore (near-vm-runner features.rs, prepare V2) enables only: floats, mutable-global, sign-extension.
  # reference-types, multi-value, bulk-memory, simd, saturating-float-to-int, ... are all off.
  "$WT" validate --features mvp,sign-extension "$WASM" >&2
  log "wasm-tools validate --features mvp,sign-extension: OK"
else
  log "wasm-tools not found: SKIPPED wasm feature validation (install: cargo install wasm-tools --locked)"
fi

BYTES="$(wc -c < "$WASM" | tr -d ' ')"
SHA="$(sha256_file "$WASM")"
RUSTC="$(rustc --version)"
NEAR_SDK="$(awk '/^name = "near-sdk"$/{getline; gsub(/version = |"/,""); print; exit}' Cargo.lock)"
LOCK_SHA="$(sha256_file Cargo.lock)"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
{ printf '%s\n' Cargo.toml Cargo.lock rust-toolchain.toml; find src -type f; } | LC_ALL=C sort | while IFS= read -r f; do
  printf '%s\0' "$f"
  cat "$f"
  printf '\0'
done > "$TMP"
SRC_SHA="$(sha256_file "$TMP")"

printf '{"sha256":"%s","bytes":%s,"rustc":"%s","nearSdk":"%s","cargoLockSha256":"%s","sourceSha256":"%s"}\n' \
  "$SHA" "$BYTES" "$RUSTC" "$NEAR_SDK" "$LOCK_SHA" "$SRC_SHA"
