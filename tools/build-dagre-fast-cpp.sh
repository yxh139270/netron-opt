#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build/cpp/dagre-fast-wasm"
OUT_DIR="$ROOT/dist/web/wasm/dagre-fast"

if ! command -v emcmake >/dev/null 2>&1; then
    echo "Skip dagre-fast cpp wasm build: emcmake not found." >&2
    exit 0
fi

emcmake cmake -S "$ROOT/cpp/dagre-fast" -B "$BUILD_DIR"
cmake --build "$BUILD_DIR"

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/dagre_fast.js" "$OUT_DIR/"
cp "$BUILD_DIR/dagre_fast.wasm" "$OUT_DIR/"
echo "Built dagre-fast cpp wasm to $OUT_DIR"
