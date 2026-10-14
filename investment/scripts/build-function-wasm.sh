#!/bin/sh
# Run with a Rust toolchain that has wasm32-unknown-unknown installed.
set -eu
cd "$(dirname "$0")/.."
: "${WASM_BINDGEN:=wasm-bindgen}"
if ! "$WASM_BINDGEN" --version | grep -q 'wasm-bindgen 0.2.108$'; then
  echo 'wasm-bindgen-cli 0.2.108 is required' >&2
  exit 1
fi
cargo build --locked -p robinlab-function-wasm --release --target wasm32-unknown-unknown
mkdir -p mako/serverless/generated
"$WASM_BINDGEN" --target web --out-dir mako/serverless/generated target/wasm32-unknown-unknown/release/robinlab_function_wasm.wasm
node scripts/package-function-wasm.mjs
