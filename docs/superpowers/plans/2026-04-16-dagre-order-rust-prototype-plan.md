# dagre-order Rust Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a full Rust/WASM prototype of `dagre-order` and a reproducible JS-vs-Rust comparison workflow without changing the default production layout path.

**Architecture:** Add a standalone Rust crate that mirrors `source/dagre-order.js` behavior and exposes a single WASM entrypoint. Add a JS bridge and engine switch flag so both implementations can run on identical inputs. Add a deterministic compare script that reports correctness deltas and timing breakdowns.

**Tech Stack:** Rust (`serde`, `wasm-bindgen`), WebAssembly, Node.js scripts, existing Netron JS runtime.

---

### Task 1: Rust/WASM Scaffold and Build Wiring

**Files:**
- Create: `rust/dagre-order-rs/Cargo.toml`
- Create: `rust/dagre-order-rs/src/lib.rs`
- Create: `rust/dagre-order-rs/README.md`
- Create: `tools/build-dagre-order-rs.sh`
- Modify: `package.js`

- [ ] **Step 1: Create Rust crate manifest**

```toml
[package]
name = "dagre_order_rs"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
wasm-bindgen = "0.2"

[profile.release]
lto = true
opt-level = 3
codegen-units = 1
```

- [ ] **Step 2: Add WASM entrypoint skeleton**

```rust
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn layout(input_json: &str) -> String {
    let _ = input_json;
    "{\"meta\":{\"ok\":true,\"elapsed_ms\":0.0,\"stage_ms\":{},\"warnings\":[]},\"nodes\":[],\"edges\":[]}".to_string()
}
```

- [ ] **Step 3: Add build helper script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CRATE_DIR="$ROOT/rust/dagre-order-rs"
OUT_DIR="$ROOT/dist/web/wasm/dagre-order-rs"

cargo build --release --target wasm32-unknown-unknown --manifest-path "$CRATE_DIR/Cargo.toml"
wasm-bindgen --target web --out-dir "$OUT_DIR" "$CRATE_DIR/target/wasm32-unknown-unknown/release/dagre_order_rs.wasm"
echo "Built wasm to $OUT_DIR"
```

- [ ] **Step 4: Wire build command into `package.js`**

```js
// in package.js build web pipeline
await this.execute('bash', [ 'tools/build-dagre-order-rs.sh' ]);
```

- [ ] **Step 5: Verify scaffold builds**

Run: `bash tools/build-dagre-order-rs.sh`
Expected: prints `Built wasm to .../dist/web/wasm/dagre-order-rs`

- [ ] **Step 6: Commit scaffold**

```bash
git add rust/dagre-order-rs tools/build-dagre-order-rs.sh package.js
git commit -m "Add Rust WASM scaffold for dagre-order prototype"
```

### Task 2: Define Stable JS<->Rust Data Contract

**Files:**
- Modify: `rust/dagre-order-rs/src/lib.rs`
- Create: `rust/dagre-order-rs/src/model.rs`
- Create: `rust/dagre-order-rs/src/result.rs`
- Test: `rust/dagre-order-rs/src/lib.rs` (unit tests)

- [ ] **Step 1: Add serde models for input contract**

```rust
#[derive(Debug, Clone, serde::Deserialize)]
pub struct LayoutInput {
    pub nodes: Vec<NodeInput>,
    pub edges: Vec<EdgeInput>,
    pub layout: serde_json::Value,
    pub state: serde_json::Value,
}
```

- [ ] **Step 2: Add output contract with meta fields**

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct LayoutOutput {
    pub meta: Meta,
    pub nodes: Vec<NodeOutput>,
    pub edges: Vec<EdgeOutput>,
}
```

- [ ] **Step 3: Parse input and return structured error JSON**

```rust
match serde_json::from_str::<LayoutInput>(input_json) {
    Ok(input) => run_layout(input),
    Err(err) => serialize_error("parse_error", err.to_string()),
}
```

- [ ] **Step 4: Add contract test with fixture-like payload**

```rust
#[test]
fn layout_accepts_minimal_payload() {
    let input = r#"{"nodes":[],"edges":[],"layout":{},"state":{}}"#;
    let output = layout(input);
    assert!(output.contains("\"ok\":true"));
}
```

- [ ] **Step 5: Run Rust tests**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml`
Expected: all tests pass

- [ ] **Step 6: Commit contract layer**

```bash
git add rust/dagre-order-rs/src
git commit -m "Define dagre-order Rust WASM input output contract"
```

### Task 3: Port Core Graph Primitives

**Files:**
- Create: `rust/dagre-order-rs/src/graph.rs`
- Create: `rust/dagre-order-rs/src/util.rs`
- Modify: `rust/dagre-order-rs/src/lib.rs`
- Test: `rust/dagre-order-rs/src/graph.rs` (unit tests)

- [ ] **Step 1: Implement Graph struct matching JS semantics**

```rust
pub struct Graph {
    pub is_compound: bool,
    pub is_multigraph: bool,
    // nodes, edges, parent/children maps
}
```

- [ ] **Step 2: Implement required operations**

```rust
impl Graph {
    pub fn set_node(&mut self, id: &str, label: NodeLabel) { /* ... */ }
    pub fn set_edge(&mut self, v: &str, w: &str, label: EdgeLabel) { /* ... */ }
    pub fn successors(&self, id: &str) -> Vec<String> { /* ... */ }
    pub fn predecessors(&self, id: &str) -> Vec<String> { /* ... */ }
}
```

- [ ] **Step 3: Port utility helpers used by dagre-order**

```rust
pub fn unique_id(prefix: &str, counter: &mut usize) -> String { /* ... */ }
pub fn map_values<K, V, U>(input: &HashMap<K, V>, f: impl Fn(&V) -> U) -> HashMap<K, U> { /* ... */ }
```

- [ ] **Step 4: Add deterministic graph operation tests**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml graph::`
Expected: all graph tests pass

- [ ] **Step 5: Commit graph primitives**

```bash
git add rust/dagre-order-rs/src/graph.rs rust/dagre-order-rs/src/util.rs rust/dagre-order-rs/src/lib.rs
git commit -m "Port dagre-order core graph primitives to Rust"
```

### Task 4: Port Rank and Normalization Pipeline

**Files:**
- Create: `rust/dagre-order-rs/src/pipeline/rank.rs`
- Create: `rust/dagre-order-rs/src/pipeline/normalize.rs`
- Modify: `rust/dagre-order-rs/src/lib.rs`
- Test: `rust/dagre-order-rs/src/pipeline/rank.rs`

- [ ] **Step 1: Port rank assignment stages from `source/dagre-order.js`**

```rust
pub fn run_rank_pipeline(g: &mut Graph, layout: &LayoutConfig, stage_ms: &mut StageMetrics) {
    // acyclic -> rank -> inject edge labels -> remove empty ranks alignment
}
```

- [ ] **Step 2: Port dummy/border node normalization**

```rust
pub fn normalize_graph(g: &mut Graph, state: &serde_json::Value, stage_ms: &mut StageMetrics) {
    // add border segments, handle minRank/maxRank, normalize edges
}
```

- [ ] **Step 3: Add unit tests for rank invariants**

```rust
#[test]
fn rank_pipeline_preserves_minlen_constraints() {
    // assert rank(w) - rank(v) >= minlen for every edge
}
```

- [ ] **Step 4: Run tests for rank pipeline**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml rank_pipeline`
Expected: all tests pass

- [ ] **Step 5: Commit rank pipeline**

```bash
git add rust/dagre-order-rs/src/pipeline/rank.rs rust/dagre-order-rs/src/pipeline/normalize.rs rust/dagre-order-rs/src/lib.rs
git commit -m "Port dagre-order rank and normalization pipeline to Rust"
```

### Task 5: Port Ordering Pipeline (Crossing Minimization)

**Files:**
- Create: `rust/dagre-order-rs/src/pipeline/order.rs`
- Modify: `rust/dagre-order-rs/src/lib.rs`
- Test: `rust/dagre-order-rs/src/pipeline/order.rs`

- [ ] **Step 1: Port layer graph build and initial ordering**

```rust
pub fn build_layer_graph(g: &Graph, rank: i32, relationship: Relationship) -> Graph { /* ... */ }
pub fn init_order(g: &mut Graph) { /* dfs-based initial order */ }
```

- [ ] **Step 2: Port barycenter, conflict resolution, and sweep loop**

```rust
pub fn order(g: &mut Graph, state: &serde_json::Value, stage_ms: &mut StageMetrics) {
    // downward/upward sweeps + best crossing selection
}
```

- [ ] **Step 3: Add crossing-count regression test**

```rust
#[test]
fn ordering_reduces_crossings_vs_initial_order() {
    // compute crossing before/after and assert non-increase
}
```

- [ ] **Step 4: Run order tests**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml ordering`
Expected: all tests pass

- [ ] **Step 5: Commit ordering pipeline**

```bash
git add rust/dagre-order-rs/src/pipeline/order.rs rust/dagre-order-rs/src/lib.rs
git commit -m "Port dagre-order ordering and crossing minimization to Rust"
```

### Task 6: Port Position and Edge Coordinate Assignment

**Files:**
- Create: `rust/dagre-order-rs/src/pipeline/position.rs`
- Create: `rust/dagre-order-rs/src/pipeline/edge.rs`
- Modify: `rust/dagre-order-rs/src/lib.rs`
- Test: `rust/dagre-order-rs/src/pipeline/position.rs`

- [ ] **Step 1: Port horizontal and vertical coordinate assignment**

```rust
pub fn assign_coordinates(g: &mut Graph, layout: &LayoutConfig, stage_ms: &mut StageMetrics) {
    // x and y assignment aligned with JS dagre-order implementation
}
```

- [ ] **Step 2: Port edge points and label coordinates generation**

```rust
pub fn assign_edge_points(g: &mut Graph, stage_ms: &mut StageMetrics) {
    // produce points[] per edge and optional x/y for labels
}
```

- [ ] **Step 3: Add geometry consistency tests**

```rust
#[test]
fn output_contains_points_for_routed_edges() {
    // assert each routed edge has non-empty points
}
```

- [ ] **Step 4: Run position tests**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml position`
Expected: all tests pass

- [ ] **Step 5: Commit position and edge pipeline**

```bash
git add rust/dagre-order-rs/src/pipeline/position.rs rust/dagre-order-rs/src/pipeline/edge.rs rust/dagre-order-rs/src/lib.rs
git commit -m "Port dagre-order coordinate and edge routing stages to Rust"
```

### Task 7: JS Bridge and Runtime Engine Switch

**Files:**
- Create: `source/dagre-order-rs.js`
- Modify: `source/mycelium.js`
- Modify: `source/dagre-order.js` (only to expose helper, if required)
- Test: `test/dagre-order-compare.js`

- [ ] **Step 1: Implement WASM loader and `layout()` wrapper in JS**

```js
export const layout = async (nodes, edges, layout, state) => {
    const wasm = await loadWasm();
    const input = JSON.stringify({ nodes, edges, layout, state });
    const output = wasm.layout(input);
    return JSON.parse(output);
};
```

- [ ] **Step 2: Add engine switch in `source/mycelium.js`**

```js
const orderEngine = String(layout.orderEngine || 'js').toLowerCase();
if (orderEngine === 'rust-proto') {
    const rust = await import('./dagre-order-rs.js');
    const result = await rust.layout(nodes, edges, layout, state);
    applyResult(result, nodes, edges);
} else {
    const dagre = await import('./dagre-order.js');
    dagre.layout(nodes, edges, layout, state);
}
```

- [ ] **Step 3: Build and smoke-test browser runtime**

Run: `python3 package.py build start`
Expected: default JS path unchanged; `orderEngine=rust-proto` path runs without crash

- [ ] **Step 4: Commit JS bridge and switch**

```bash
git add source/dagre-order-rs.js source/mycelium.js source/dagre-order.js
git commit -m "Add Rust dagre-order prototype bridge and runtime switch"
```

### Task 8: JS-vs-Rust Comparison Harness

**Files:**
- Create: `test/dagre-order-compare.js`
- Create: `test/dagre-order-fixtures.json`
- Modify: `test/models.js` (optional entrypoint wiring)

- [ ] **Step 1: Implement compare CLI script**

```js
// node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json
// output: correctness summary + timing summary per fixture
```

- [ ] **Step 2: Add correctness diff rules**

```js
const EPS = 1e-3;
// strict compare: rank/order/parent
// tolerant compare: x/y/points abs diff <= EPS
```

- [ ] **Step 3: Add stage timing report extraction**

```js
// print: total_ms, encode_ms, wasm_ms, decode_ms, stage_ms
```

- [ ] **Step 4: Run compare on fixtures**

Run: `node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json`
Expected: emits JSON/text summary, exits code 0

- [ ] **Step 5: Commit comparison tooling**

```bash
git add test/dagre-order-compare.js test/dagre-order-fixtures.json test/models.js
git commit -m "Add JS vs Rust dagre-order comparison harness"
```

### Task 9: Verification, Documentation, and Prototype Report

**Files:**
- Modify: `rust/dagre-order-rs/README.md`
- Create: `docs/superpowers/reports/2026-04-16-dagre-order-rust-prototype-report.md`

- [ ] **Step 1: Document build/run/debug commands**

```md
- Build wasm: bash tools/build-dagre-order-rs.sh
- Compare: node test/dagre-order-compare.js --fixture ...
- Enable runtime prototype: layout.orderEngine='rust-proto'
```

- [ ] **Step 2: Record baseline comparison report**

```md
## Correctness
- strict field mismatch count
- tolerant coordinate mismatch count

## Performance
- js total ms
- rust total ms
- rust stage breakdown
```

- [ ] **Step 3: Full verification run**

Run: `cargo test --manifest-path rust/dagre-order-rs/Cargo.toml && node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json`
Expected: tests pass and compare report generated

- [ ] **Step 4: Commit report artifacts**

```bash
git add rust/dagre-order-rs/README.md docs/superpowers/reports/2026-04-16-dagre-order-rust-prototype-report.md
git commit -m "Document dagre-order Rust prototype verification results"
```

## Spec Coverage Check

- Rust 全量原型：Task 3-6 覆盖 graph/rank/order/position/edge 全流程。
- JS/Rust 双路径可切换：Task 7 覆盖。
- 对比工具与性能报告：Task 8-9 覆盖。
- 默认路径保持 JS：Task 7 明确保持默认 `orderEngine='js'`。

## Placeholder Scan

- 未使用 TBD/TODO/“后续补充”等占位描述。
- 每个代码变更步骤都给出明确代码骨架或命令。

## Type/Name Consistency Check

- 统一使用 `layout(input_json)` 作为 Rust 导出入口。
- 统一使用 `orderEngine='rust-proto'` 作为运行时开关。
- 对比容差统一 `EPS = 1e-3`。
