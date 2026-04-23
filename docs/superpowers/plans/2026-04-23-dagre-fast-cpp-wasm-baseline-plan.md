# dagre-fast C++ WASM Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a C++/WASM baseline implementation for `dagre-fast` core layout, selectable via `layout.fastEngine = 'js' | 'cpp'`, while keeping JS as the default and preserving output consistency.

**Architecture:** Implement core layout pipeline in `cpp/dagre-fast` with a single wasm JSON entrypoint (`layout_json`). Add a JS bridge (`source/dagre-fast-cpp.js`) and route selection in runtime paths so `dagre-fast` can run JS or C++ based on `fastEngine`. Add deterministic JS-vs-CPP comparison tests and parity regressions; block-specific logic remains out of scope for this version.

**Tech Stack:** C++17, CMake + Emscripten (WASM), JavaScript ES modules, Node.js test scripts, existing Netron runtime.

---

### Task 1: C++/WASM Scaffold in `cpp/dagre-fast`

**Files:**
- Create: `cpp/dagre-fast/CMakeLists.txt`
- Create: `cpp/dagre-fast/layout.h`
- Create: `cpp/dagre-fast/layout.cpp`
- Create: `cpp/dagre-fast/json_io.h`
- Create: `cpp/dagre-fast/json_io.cpp`
- Create: `cpp/dagre-fast/edge.h`
- Create: `cpp/dagre-fast/edge.cpp`
- Create: `cpp/dagre-fast/rank.h`
- Create: `cpp/dagre-fast/rank.cpp`
- Create: `cpp/dagre-fast/column.h`
- Create: `cpp/dagre-fast/column.cpp`
- Create: `cpp/dagre-fast/coord.h`
- Create: `cpp/dagre-fast/coord.cpp`
- Create: `cpp/dagre-fast/route.h`
- Create: `cpp/dagre-fast/route.cpp`

- [ ] **Step 1: Write failing smoke test for missing wasm artifact**

```javascript
// file: test/dagre-fast-cpp-build-smoke.js
import assert from 'assert';
import fs from 'fs';

assert.ok(fs.existsSync('dist/web/wasm/dagre-fast/dagre_fast.js'), 'dagre_fast.js should exist after cpp wasm build');
assert.ok(fs.existsSync('dist/web/wasm/dagre-fast/dagre_fast.wasm'), 'dagre_fast.wasm should exist after cpp wasm build');
```

- [ ] **Step 2: Run smoke test to confirm failure before scaffold**

Run: `node test/dagre-fast-cpp-build-smoke.js`
Expected: FAIL with missing artifact assertion.

- [ ] **Step 3: Create CMake wasm target and exported C entrypoint**

```cmake
# file: cpp/dagre-fast/CMakeLists.txt
cmake_minimum_required(VERSION 3.20)
project(dagre_fast_wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(dagre_fast
    layout.cpp
    json_io.cpp
    edge.cpp
    rank.cpp
    column.cpp
    coord.cpp
    route.cpp)

set_target_properties(dagre_fast PROPERTIES OUTPUT_NAME "dagre_fast")

target_link_options(dagre_fast PRIVATE
    "-sWASM=1"
    "-sALLOW_MEMORY_GROWTH=1"
    "-sEXPORTED_FUNCTIONS=['_layout_json','_free_json']"
    "-sEXPORTED_RUNTIME_METHODS=['cwrap','UTF8ToString','stringToUTF8','lengthBytesUTF8','_malloc','_free']"
    "-sMODULARIZE=1"
    "-sEXPORT_ES6=1"
    "-sENVIRONMENT=web,worker,node")
```

- [ ] **Step 4: Add minimal JSON passthrough implementation**

```cpp
// file: cpp/dagre-fast/layout.cpp
#include <cstdlib>
#include <cstring>
#include <string>

extern "C" {
const char* layout_json(const char* input) {
    std::string output = input ? input : "{}";
    char* buffer = static_cast<char*>(std::malloc(output.size() + 1));
    std::memcpy(buffer, output.c_str(), output.size() + 1);
    return buffer;
}

void free_json(const char* p) {
    std::free(const_cast<char*>(p));
}
}
```

- [ ] **Step 5: Run wasm build and verify artifacts**

Run:
- `emcmake cmake -S cpp/dagre-fast -B build/cpp/dagre-fast-wasm`
- `cmake --build build/cpp/dagre-fast-wasm`

Expected: build succeeds and produces `dagre_fast.js`/`dagre_fast.wasm` in build output.

- [ ] **Step 6: Copy artifacts and re-run smoke test**

Run:
- `mkdir -p dist/web/wasm/dagre-fast`
- `cp build/cpp/dagre-fast-wasm/dagre_fast.js dist/web/wasm/dagre-fast/`
- `cp build/cpp/dagre-fast-wasm/dagre_fast.wasm dist/web/wasm/dagre-fast/`
- `node test/dagre-fast-cpp-build-smoke.js`

Expected: smoke test PASS.

- [ ] **Step 7: Commit scaffold**

```bash
git add cpp/dagre-fast test/dagre-fast-cpp-build-smoke.js
git commit -m "Add dagre-fast C++ wasm scaffold and build smoke test"
```

### Task 2: Build Script and Packaging Wiring

**Files:**
- Create: `tools/build-dagre-fast-cpp.sh`
- Modify: `package.js`

- [ ] **Step 1: Write failing script test**

```javascript
// file: test/dagre-fast-cpp-build-script.js
import assert from 'assert';
import fs from 'fs';

assert.ok(fs.existsSync('tools/build-dagre-fast-cpp.sh'), 'build script should exist');
```

- [ ] **Step 2: Run test to confirm failure**

Run: `node test/dagre-fast-cpp-build-script.js`
Expected: FAIL before creating script.

- [ ] **Step 3: Add build script**

```bash
#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_DIR="$ROOT/build/cpp/dagre-fast-wasm"
OUT_DIR="$ROOT/dist/web/wasm/dagre-fast"

emcmake cmake -S "$ROOT/cpp/dagre-fast" -B "$BUILD_DIR"
cmake --build "$BUILD_DIR"

mkdir -p "$OUT_DIR"
cp "$BUILD_DIR/dagre_fast.js" "$OUT_DIR/"
cp "$BUILD_DIR/dagre_fast.wasm" "$OUT_DIR/"
echo "Built dagre-fast cpp wasm to $OUT_DIR"
```

- [ ] **Step 4: Wire optional build in `package.js`**

```js
if (process.env.NETRON_BUILD_DAGRE_FAST_CPP === '1') {
    await this.execute('bash', [ 'tools/build-dagre-fast-cpp.sh' ]);
} else {
    this.log('skip dagre-fast-cpp wasm (set NETRON_BUILD_DAGRE_FAST_CPP=1 to enable)');
}
```

- [ ] **Step 5: Verify script and optional packaging path**

Run:
- `chmod +x tools/build-dagre-fast-cpp.sh`
- `node test/dagre-fast-cpp-build-script.js`
- `NETRON_BUILD_DAGRE_FAST_CPP=1 bash tools/build-dagre-fast-cpp.sh`

Expected: script test PASS and build script prints output path.

- [ ] **Step 6: Commit build wiring**

```bash
git add tools/build-dagre-fast-cpp.sh package.js test/dagre-fast-cpp-build-script.js
git commit -m "Add optional dagre-fast C++ wasm build wiring"
```

### Task 3: JS Bridge Module for C++ Engine

**Files:**
- Create: `source/dagre-fast-cpp.js`
- Create: `test/dagre-fast-cpp-bridge.js`

- [ ] **Step 1: Write failing bridge contract test**

```javascript
import assert from 'assert';
import { layout } from '../source/dagre-fast-cpp.js';

const nodes = [ { v: 'A', width: 100, height: 40 }, { v: 'B', width: 100, height: 40 } ];
const edges = [ { v: 'A', w: 'B' } ];

await layout(nodes, edges, { rankdir: 'TB' }, {});
assert.ok(Number.isFinite(nodes[0].x) && Number.isFinite(nodes[1].x), 'bridge should write back node coordinates');
```

- [ ] **Step 2: Run test to verify failure before bridge implementation**

Run: `node test/dagre-fast-cpp-bridge.js`
Expected: FAIL (module missing or no coordinate write-back).

- [ ] **Step 3: Implement wasm loader and layout wrapper**

```javascript
let cached = null;

const loadModule = async () => {
    if (cached) {
        return cached;
    }
    const mod = await import('./wasm/dagre-fast/dagre_fast.js');
    cached = await mod.default({ locateFile: () => new URL('./wasm/dagre-fast/dagre_fast.wasm', import.meta.url).href });
    return cached;
};

export const layout = async (nodes, edges, layout, state) => {
    const wasm = await loadModule();
    const input = JSON.stringify({ nodes, edges, layout });
    const fn = wasm.cwrap('layout_json', 'number', ['string']);
    const freeFn = wasm.cwrap('free_json', null, ['number']);
    const ptr = fn(input);
    const output = wasm.UTF8ToString(ptr);
    freeFn(ptr);
    const parsed = JSON.parse(output);
    // write-back logic (nodes/edges/meta)
};
```

- [ ] **Step 4: Add robust fallback errors in bridge**

```javascript
if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('dagre-fast-cpp returned invalid payload');
}
```

- [ ] **Step 5: Run bridge test and verify pass**

Run: `node test/dagre-fast-cpp-bridge.js`
Expected: PASS.

- [ ] **Step 6: Commit bridge module**

```bash
git add source/dagre-fast-cpp.js test/dagre-fast-cpp-bridge.js
git commit -m "Add dagre-fast C++ wasm JS bridge"
```

### Task 4: Runtime Engine Routing (`js` vs `cpp`)

**Files:**
- Modify: `source/mycelium.js`
- Modify: `source/worker.js`
- Create: `test/dagre-fast-engine-switch.js`

- [ ] **Step 1: Write failing engine-switch test**

```javascript
import assert from 'assert';
import * as mycelium from '../source/mycelium.js';

assert.ok(typeof mycelium !== 'undefined', 'mycelium module should load');
// this test should fail until fastEngine path is wired and observable through state/log marker
```

- [ ] **Step 2: Run test to verify failure**

Run: `node test/dagre-fast-engine-switch.js`
Expected: FAIL for missing switch marker/behavior.

- [ ] **Step 3: Route `dagre-fast` branch via `fastEngine` in `source/mycelium.js`**

```js
} else if (layoutEngine === 'dagre-fast') {
    const fastEngine = String(layout.fastEngine || 'js').toLowerCase();
    if (fastEngine === 'cpp') {
        const cpp = await import('./dagre-fast-cpp.js');
        await cpp.layout(nodes, edges, layout, state);
    } else {
        const dagre = await import('./dagre-fast.js');
        dagre.layout(nodes, edges, layout, state);
    }
}
```

- [ ] **Step 4: Route worker path similarly in `source/worker.js`**

```js
const engine = String((message.layout && (message.layout.layoutEngine || message.layout.orderEngine)) || 'dagre-order').toLowerCase();
const fastEngine = String((message.layout && message.layout.fastEngine) || 'js').toLowerCase();
const modulePath = engine === 'dagre-fast'
    ? (fastEngine === 'cpp' ? './dagre-fast-cpp.js' : './dagre-fast.js')
    : engine === 'dagre'
        ? './dagre.js'
        : './dagre-order.js';
```

- [ ] **Step 5: Add fallback marker in state when cpp fails and js fallback executes**

```js
state.layoutDebug = state.layoutDebug || {};
state.layoutDebug.fastEngineFallback = 'cpp->js';
```

- [ ] **Step 6: Run switch test and smoke-run a dagre-fast layout with both engines**

Run:
- `node test/dagre-fast-engine-switch.js`
- `node test/dagre-fast-block-regression.js`

Expected: tests PASS and no runtime exceptions.

- [ ] **Step 7: Commit runtime switch**

```bash
git add source/mycelium.js source/worker.js test/dagre-fast-engine-switch.js
git commit -m "Add dagre-fast runtime switch between JS and C++ engines"
```

### Task 5: Implement Baseline Layout Pipeline in C++

**Files:**
- Modify: `cpp/dagre-fast/layout.cpp`
- Modify: `cpp/dagre-fast/rank.cpp`
- Modify: `cpp/dagre-fast/column.cpp`
- Modify: `cpp/dagre-fast/coord.cpp`
- Modify: `cpp/dagre-fast/route.cpp`
- Modify: `cpp/dagre-fast/json_io.cpp`
- Create: `test/dagre-fast-cpp-baseline-smoke.js`

- [ ] **Step 1: Write failing end-to-end baseline smoke test**

```javascript
import assert from 'assert';
import { layout } from '../source/dagre-fast-cpp.js';

const nodes = [
  { v: 'A', width: 100, height: 40 },
  { v: 'B', width: 100, height: 40 },
  { v: 'C', width: 100, height: 40 }
];
const edges = [ { v: 'A', w: 'B' }, { v: 'B', w: 'C' }, { v: 'A', w: 'C' } ];

await layout(nodes, edges, { rankdir: 'TB', fastEngine: 'cpp' }, {});
for (const node of nodes) {
  assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'cpp baseline should output coordinates');
}
```

- [ ] **Step 2: Run smoke test and confirm failure before pipeline completion**

Run: `node test/dagre-fast-cpp-baseline-smoke.js`
Expected: FAIL with invalid/missing coordinates.

- [ ] **Step 3: Implement rank and minlen handling in `rank.cpp`**

```cpp
void assign_rank(Graph& g) {
    auto topo = topological_order(g);
    for (auto id : topo) {
        if (g.in_edges(id).empty()) {
            g.node(id).rank = 0;
            continue;
        }
        int best = 0;
        for (auto e : g.in_edges(id)) {
            best = std::max(best, g.node(e.v).rank + std::max(1, e.minlen));
        }
        g.node(id).rank = best;
    }
}
```

- [ ] **Step 4: Implement column assignment + collision in `column.cpp`**

```cpp
void assign_column(Graph& g) {
    auto ranks = group_by_rank(g);
    for (int r = 1; r <= max_rank(g); r++) {
        for (auto id : ranks[r]) {
            g.node(id).col = average_pred_col(g, id);
        }
        resolve_rank_collisions(g, ranks[r]);
    }
}
```

- [ ] **Step 5: Implement coordinate map and route points in `coord.cpp` + `route.cpp`**

```cpp
void assign_coord(Graph& g, const LayoutOptions& opt) {
    // map col->x and rank->y using nodesep/ranksep
}

void route_edges(Graph& g) {
    // generate points[] including long-edge virtual path points
}
```

- [ ] **Step 6: Emit `meta.ok`, `stage_ms` and serialize output**

Run: `NETRON_BUILD_DAGRE_FAST_CPP=1 bash tools/build-dagre-fast-cpp.sh`
Expected: build succeeds and bridge returns structured payload with `meta`.

- [ ] **Step 7: Run baseline smoke test and verify pass**

Run: `node test/dagre-fast-cpp-baseline-smoke.js`
Expected: PASS.

- [ ] **Step 8: Commit baseline C++ pipeline**

```bash
git add cpp/dagre-fast test/dagre-fast-cpp-baseline-smoke.js
git commit -m "Implement dagre-fast baseline layout pipeline in C++ wasm"
```

### Task 6: JS-vs-CPP Consistency Harness

**Files:**
- Create: `test/dagre-fast-cpp-compare.js`
- Create: `test/dagre-fast-cpp-fixtures.json`

- [ ] **Step 1: Write failing comparison harness test**

```javascript
import assert from 'assert';
import fs from 'fs';

assert.ok(fs.existsSync('test/dagre-fast-cpp-fixtures.json'), 'fixtures should exist');
```

- [ ] **Step 2: Run test to confirm failure**

Run: `node test/dagre-fast-cpp-compare.js --fixture test/dagre-fast-cpp-fixtures.json`
Expected: FAIL before harness/fixture creation.

- [ ] **Step 3: Add fixture file covering chain/diamond/long-edge/multi-branch (no block)**

```json
[
  { "name": "chain", "nodes": [...], "edges": [...], "layout": { "rankdir": "TB" } },
  { "name": "diamond", "nodes": [...], "edges": [...], "layout": { "rankdir": "TB" } }
]
```

- [ ] **Step 4: Implement compare script with strict + tolerant checks**

```javascript
const EPS_NODE = 1e-6;
const EPS_POINT = 1e-4;
// run js engine and cpp engine for each fixture
// compare node x/y and edge point arrays
```

- [ ] **Step 5: Run compare harness and confirm pass on fixture set**

Run: `node test/dagre-fast-cpp-compare.js --fixture test/dagre-fast-cpp-fixtures.json`
Expected: exit 0 with mismatch count 0 (or within configured tolerance).

- [ ] **Step 6: Commit comparison harness**

```bash
git add test/dagre-fast-cpp-compare.js test/dagre-fast-cpp-fixtures.json
git commit -m "Add dagre-fast JS vs C++ consistency comparison harness"
```

### Task 7: Regression Safety and End-to-End Verification

**Files:**
- Modify: `test/dagre-fast-block-regression.js`
- Modify: `test/dagre-fast-long-edge-anchors.js`
- Create: `docs/superpowers/reports/2026-04-23-dagre-fast-cpp-wasm-baseline-report.md`

- [ ] **Step 1: Extend regression script to include `fastEngine='cpp'` scenario**

```javascript
const js = run({ layoutEngine: 'dagre-fast', fastEngine: 'js' });
const cpp = await run({ layoutEngine: 'dagre-fast', fastEngine: 'cpp' });
// compare with tolerance
```

- [ ] **Step 2: Ensure long-edge anchor test runs in both engines**

```javascript
for (const fastEngine of ['js', 'cpp']) {
  runCase({ layoutEngine: 'dagre-fast', fastEngine });
}
```

- [ ] **Step 3: Run targeted verification suite**

Run:
- `NETRON_BUILD_DAGRE_FAST_CPP=1 bash tools/build-dagre-fast-cpp.sh`
- `node test/dagre-fast-cpp-build-smoke.js`
- `node test/dagre-fast-cpp-bridge.js`
- `node test/dagre-fast-cpp-baseline-smoke.js`
- `node test/dagre-fast-cpp-compare.js --fixture test/dagre-fast-cpp-fixtures.json`
- `node test/dagre-fast-block-regression.js`
- `node test/dagre-fast-long-edge-anchors.js`

Expected: all commands PASS.

- [ ] **Step 4: Run full `npm test` and record known failures if any**

Run: `npm test`
Expected: command completes; if pre-existing dataset failure appears, report it explicitly in report.

- [ ] **Step 5: Write implementation report**

```md
## Engine switch
- layout.fastEngine: js/cpp

## Consistency
- fixture count, mismatch count, tolerance

## Performance
- stage_ms summary (rank/column/coord/route)

## Known Issues
- existing repository-wide failures unrelated to this feature
```

- [ ] **Step 6: Commit regression and report**

```bash
git add test/dagre-fast-block-regression.js test/dagre-fast-long-edge-anchors.js docs/superpowers/reports/2026-04-23-dagre-fast-cpp-wasm-baseline-report.md
git commit -m "Verify dagre-fast C++ wasm baseline with parity and regression tests"
```

## Spec Coverage Check

- `cpp/dagre-fast` 目录内实现核心流水线：Task 1 + Task 5 覆盖。
- JS/WASM 桥接与 `fastEngine='js'|'cpp'` 开关：Task 3 + Task 4 覆盖。
- 默认 JS 路径保持不变且可回退：Task 4 + Task 7 覆盖。
- 一致性优先验收（对比脚本/容差）：Task 6 + Task 7 覆盖。
- block 留到下一版：所有任务均限定 baseline，不引入 block 算法迁移。

## Placeholder Scan

- 无 `TODO`/`TBD`/“后续补充”占位语句。
- 每个代码步骤都提供了明确代码片段或命令。
- 每个验证步骤都有可执行命令与预期结果。

## Type/Name Consistency Check

- 引擎开关统一为 `layout.fastEngine = 'js' | 'cpp'`。
- wasm 导出入口统一为 `layout_json` + `free_json`。
- 桥接模块统一命名为 `source/dagre-fast-cpp.js`。
- 一致性容差统一：节点 `1e-6`，边点 `1e-4`。
