# dagre-order-rs

Rust and WASM scaffold for the dagre-order prototype.

## Prerequisites

- `cargo`
- `wasm-bindgen` CLI
- Rust target `wasm32-unknown-unknown`

Install missing pieces:

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
```

## Build

Build the Rust crate and generate JS/WASM output to `dist/web/wasm/dagre-order-rs`:

```bash
bash tools/build-dagre-order-rs.sh
```

Quick verify from the web build pipeline:

```bash
NETRON_BUILD_DAGRE_RS=1 node package.js build web
```

## Run

Run Rust unit tests:

```bash
cargo test --manifest-path rust/dagre-order-rs/Cargo.toml
```

Run JS-vs-Rust compare on fixtures (build wasm first):

```bash
bash tools/build-dagre-order-rs.sh
```

Then run compare:

```bash
node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json
```

Strict CI-style compare exit code on mismatch:

```bash
node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json --fail-on-diff
```

## Runtime Prototype Switch

Enable Rust prototype at runtime with `layout.orderEngine = 'rust-proto'`.

- Default path remains JS (`orderEngine = 'js'`).
- On Rust load/call failure, runtime falls back to JS and logs a warning.

## Debug

If compare reports `Unable to load dagre-order-rs wasm module`, build the wasm artifact first and re-run compare:

```bash
bash tools/build-dagre-order-rs.sh && node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json
```

Emit machine-readable compare output:

```bash
node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json --json
```
