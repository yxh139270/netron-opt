#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE_DIR="$ROOT/rust/dagre-order-rs"
OUT_DIR="$ROOT/dist/web/wasm/dagre-order-rs"

if ! command -v cargo >/dev/null 2>&1; then
    echo "Skip dagre-order-rs wasm build: cargo not found." >&2
    exit 0
fi

if ! command -v wasm-bindgen >/dev/null 2>&1; then
    echo "Skip dagre-order-rs wasm build: wasm-bindgen not found." >&2
    exit 0
fi

if ! rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
    echo "Skip dagre-order-rs wasm build: missing target wasm32-unknown-unknown." >&2
    exit 0
fi

mkdir -p "$OUT_DIR"
cargo build --release --target wasm32-unknown-unknown --manifest-path "$CRATE_DIR/Cargo.toml"
wasm-bindgen --target web --out-dir "$OUT_DIR" "$CRATE_DIR/target/wasm32-unknown-unknown/release/dagre_order_rs.wasm"
echo "Built wasm to $OUT_DIR"
