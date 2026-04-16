# dagre-order-rs

Rust and WASM scaffold for the dagre-order prototype.

## Build

Prerequisites:
- `cargo`
- `wasm-bindgen` CLI
- Rust target `wasm32-unknown-unknown`

```bash
bash tools/build-dagre-order-rs.sh
```

Quick verify:

```bash
NETRON_BUILD_DAGRE_RS=1 node package.js build web
```
