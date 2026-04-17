# Dagre-Order Rust Prototype Report (Task 9)

## Scope

- Updated `rust/dagre-order-rs/README.md` with build/run/debug instructions.
- Ran full verification command from plan.
- Recorded compare limitation and workaround execution.

## Verification Commands

Primary command from plan:

```bash
cargo test --manifest-path rust/dagre-order-rs/Cargo.toml && node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json
```

Captured logs:

- `/tmp/task9-cargo-test.log`
- `/tmp/task9-compare-no-wasm.log`
- `/tmp/task9-build-wasm.log`
- `/tmp/task9-compare-with-wasm.log`

Workaround command used after missing wasm artifact was reported:

```bash
bash tools/build-dagre-order-rs.sh && node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json
```

## Correctness

### 1) Primary verification command run

- `cargo test` passed: `18 passed; 0 failed`.
- Compare command executed and completed with runtime Rust path available in this run.
- Compare summary in this run:
  - `fixtures: 2`
  - `ok: 0`
  - `mismatch: 2`
  - `chain-3`: `strict=0 tolerant=8`
  - `diamond-with-cluster`: `strict=0 tolerant=28`

Evidence excerpt (`/tmp/task9-compare-no-wasm.log`):

```text
fixtures: 2
ok: 0
mismatch: 2
[chain-3] DIFF
  diff strict=0 tolerant=8
[diamond-with-cluster] DIFF
  diff strict=0 tolerant=28
```

### 2) Workaround command (build wasm first)

- `bash tools/build-dagre-order-rs.sh` succeeded and emitted:
  - `Built wasm to /home/xuehua/project/netron-opt/.worktrees/dagre-order-rust-prototype/dist/web/wasm/dagre-order-rs`
- Compare then executed on full Rust path.
- Compare summary in workaround run:
  - `fixtures: 2`
  - `ok: 0`
  - `mismatch: 2`
  - `chain-3`: `strict=0 tolerant=8`
  - `diamond-with-cluster`: `strict=0 tolerant=28`
- Interpretation:
  - No strict structural mismatches in workaround run.
  - Coordinate/points numeric differences remain above `EPS=1e-3` and require follow-up alignment work.

Evidence excerpt (`/tmp/task9-build-wasm.log` + `/tmp/task9-compare-with-wasm.log`):

```text
Built wasm to /home/xuehua/project/netron-opt/.worktrees/dagre-order-rust-prototype/dist/web/wasm/dagre-order-rs
fixtures: 2
ok: 0
mismatch: 2
[chain-3] DIFF diff strict=0 tolerant=8
[diamond-with-cluster] DIFF diff strict=0 tolerant=28
```

## Performance

Timing extracted from compare outputs.

### 1) Primary verification run

- `chain-3`
  - JS total: `9.384 ms`
  - Rust total: `15.477 ms`
- `diamond-with-cluster`
  - JS total: `2.109 ms`
  - Rust total: `1.032 ms`

### 2) Workaround run (after building wasm)

- `chain-3`
  - JS total: `8.700 ms`
  - Rust total: `12.345 ms`
  - Rust stage breakdown: `none` (current Rust meta does not report populated `stage_ms`)
- `diamond-with-cluster`
  - JS total: `2.250 ms`
  - Rust total: `1.185 ms`
  - Rust stage breakdown: `none`

## Notes

- The plan verification command is runnable as-is. It does not guarantee deterministic timing numbers between runs.
- If wasm artifacts are missing in a clean workspace, run `bash tools/build-dagre-order-rs.sh` first to ensure Rust-path compare availability.
- Practical workflow for reliable Rust-path compare is:
  - `bash tools/build-dagre-order-rs.sh`
  - `node test/dagre-order-compare.js --fixture test/dagre-order-fixtures.json`
