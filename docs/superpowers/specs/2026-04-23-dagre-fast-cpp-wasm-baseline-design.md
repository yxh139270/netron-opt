# dagre-fast C++/WASM 基线迁移设计

## 1. 背景与目标

当前 `source/dagre-fast.js` 承担完整的 rank/col/坐标/边路由快速布局流程。为提升性能与可维护性，将核心布局计算迁移到 C++ 并通过 WASM 在前端调用。

已确认约束：
- 集成方式：WASM（前端 JS 调用）。
- 迁移范围：只迁核心布局计算（rank/col/x-y/edge points），JS 继续负责输入整理和结果应用。
- 行为基线：先对齐主干历史 dagre-fast（不含 block 扩展），block 留下一版。
- 验收优先级：结果一致性优先，性能先不强求。
- 引擎开关：`layout.fastEngine = 'js' | 'cpp'`，默认 `js`。

## 2. 非目标

- 本版不迁移 block/lantern 约束到 C++。
- 不替换线上默认引擎（保持 `js` 默认）。
- 不引入新的布局策略或算法变更。
- 不做 native addon 或独立可执行程序。

## 3. 总体架构

### 3.1 目录结构

在已有 `cpp/dagre-fast` 目录下补充：

```
cpp/dagre-fast/
  graph.*          (已有，图结构)
  node.*           (已有，节点定义)
  edge.h / edge.cpp         (边定义与邻接)
  rank.h / rank.cpp         (rank 计算)
  column.h / column.cpp     (列分配与碰撞消解)
  coord.h / coord.cpp       (列到像素坐标映射)
  route.h / route.cpp       (边路径与控制点)
  layout.h / layout.cpp     (总调度入口)
  json_io.h / json_io.cpp   (JSON 输入输出协议)
  CMakeLists.txt             (Emscripten wasm 构建)
```

JS 侧新增：
- `source/dagre-fast-cpp.js`：WASM 桥接，提供 `async layout(nodes, edges, layout, state)`。

### 3.2 运行路径

默认路径不变：
- `fastEngine` 未设置或 `'js'` → 走 `source/dagre-fast.js`

WASM 路径（按开关启用）：
- `fastEngine === 'cpp'` → 走 `source/dagre-fast-cpp.js` → wasm

### 3.3 调用关系

1. JS 收集 `nodes/edges/layout/state`。
2. JS 桥接层序列化为 JSON 字符串并调用 wasm `layout_json`。
3. C++ 执行核心布局流水线并返回 JSON 结果。
4. JS 桥接层解析结果并写回现有对象结构。
5. 若 wasm 加载失败或返回错误，自动回退到 JS 引擎。

## 4. WASM 接口契约

### 4.1 导出函数

- `layout_json(input_json: string) -> string`

首版采用 JSON 字符串作为输入输出，优先保证可调试与可比性。

### 4.2 输入结构

```json
{
  "nodes": [{ "v": "id", "width": 100, "height": 40 }],
  "edges": [{ "v": "src", "w": "tgt", "width": 0, "height": 0 }],
  "layout": { "rankdir": "TB", "nodesep": 50, "ranksep": 85 }
}
```

### 4.3 输出结构

```json
{
  "nodes": [{ "v": "id", "x": 100.0, "y": 200.0, "width": 100, "height": 40 }],
  "edges": [{ "v": "src", "w": "tgt", "points": [{ "x": 50, "y": 100 }, ...] }],
  "meta": {
    "ok": true,
    "mode": "baseline",
    "stage_ms": { "rank": 0.1, "column": 0.05, "coord": 0.02, "route": 0.08 },
    "warnings": []
  }
}
```

### 4.4 错误协议

```json
{
  "meta": {
    "ok": false,
    "error_code": "parse_error",
    "error_message": "invalid node: missing v",
    "stage_ms": {},
    "warnings": []
  }
}
```

## 5. 算法分层与迁移边界

### 5.1 C++ 承接

| 模块 | 文件 | 职责 |
|------|------|------|
| 图结构 | `graph.*`, `node.*`, `edge.*` | 邻接表、拓扑排序、入度出度 |
| rank | `rank.*` | 拓扑遍历、minlen 拉伸、rank 赋值 |
| column | `column.*` | 前驱均值赋值、碰撞消解、lantern spreading |
| coord | `coord.*` | 列到像素映射、rank 间距 |
| route | `route.*` | 边路径生成、长边虚拟点、控制点曲线 |
| 调度 | `layout.*` | 流水线串联 |
| IO | `json_io.*` | JSON 解析与序列化 |

### 5.2 JS 保留职责

- 输入对象整理（nodes/edges/layout/state）。
- 引擎路由：根据 `fastEngine` 选择 JS 或 C++。
- 结果写回现有前端对象结构。
- wasm 加载管理、回退逻辑。

## 6. 构建集成

### 6.1 构建产物

- CMake 配置产出 `dist/web/wasm/dagre-fast/` 下的 wasm + JS glue 文件。
- 不影响默认构建流程；通过环境变量 `NETRON_BUILD_DAGRE_FAST_CPP=1` 启用。

### 6.2 JS 桥接

- `source/dagre-fast-cpp.js` 提供 `async layout(nodes, edges, layout, state)`。
- 内部做 JSON 序列化/反序列化并调用 wasm 导出函数。

### 6.3 运行时策略

- `fastEngine === 'cpp'` 时优先走 wasm。
- wasm 加载失败或返回错误时自动回退到 JS，并在 `state.layoutDebug` 记录回退原因。

## 7. 一致性验收与测试

### 7.1 一致性目标

- 节点 `x/y`、边 `points`、关键中间属性（rank）在容差内一致。
- 默认容差：节点 `1e-6`，points `1e-4`。

### 7.2 测试分层

- **单测（C++）**：rank/col/route 各模块不变量。
- **桥接测（JS）**：`source/dagre-fast-cpp.js` 输入输出协议、异常回退。
- **对比测（端到端）**：同图双跑 `js` vs `cpp`，输出差异报告。

### 7.3 用例集合

- 小图：链式、菱形、扇入扇出。
- 长边：含虚拟点路径。
- 复杂图：多分支与高入度节点（不含 block 约束）。

### 7.4 DoD

- 对比用例集全部通过一致性阈值。
- `fastEngine='js'` 行为零回归。
- `fastEngine='cpp'` 稳定运行并可自动回退。

## 8. 实施阶段

### Phase 0：脚手架与桥接（1-2 天）

- 补齐 `cpp/dagre-fast` 的 CMake/wasm 导出入口。
- 新增 `source/dagre-fast-cpp.js` 与 `fastEngine='cpp'` 路由。
- 验收：可成功调用 wasm 并返回结构化结果。

### Phase 1：基线算法迁移（3-5 天）

- 迁移 rank/col/coord/route 到 C++。
- 跑通小图与长边场景。
- 验收：核心测试用例可完整输出坐标与边点。

### Phase 2：一致性对齐（2-3 天）

- 建立 js/cpp 对比测试脚本与报告。
- 修正差异直到通过容差门槛。
- 验收：对比集全部通过。

### Phase 3：稳态与灰度（1-2 天）

- 加入回退日志与 stage_ms。
- 文档化开关与调试方法。
- 验收：`js` 默认稳定，`cpp` 可选稳定。

### 下一版（后续）

- 基于同一框架追加 block/lantern 能力。

## 9. 风险与缓解

- **一致性差异风险**：JS 历史逻辑含较多边界分支，直译易出现浮点/逻辑偏差。
  - 缓解：对比脚本拆分阶段，先对齐小图再扩样本。
- **WASM 加载失败风险**：环境兼容性问题。
  - 缓解：自动回退到 JS，不影响默认体验。
- **构建复杂度风险**：Emscripten 工具链配置。
  - 缓解：环境变量控制，不影响默认构建。
