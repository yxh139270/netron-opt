# dagre-order Rust 原型设计（与 JS 对比）

## 1. 背景与目标

当前 `source/dagre-order.js` 承担完整布局流程，代码体量大、热点复杂。目标是在不切换线上默认路径的前提下，先实现一套 Rust/WASM 原型，覆盖 `dagre-order` 全量逻辑，并建立与 JS 实现的一致性与性能对比体系。

本阶段目标：
- Rust 侧实现 `dagre-order` 全流程原型（直译优先，行为对齐优先）。
- JS 与 Rust 双实现可在同输入上运行并输出可比较结果。
- 产出可重复的 benchmark 与差异报告。

本阶段非目标：
- 不立即替换线上默认布局引擎。
- 不承诺首版 Rust 必然优于 JS 性能。
- 不做大规模算法重写（先对齐，再优化）。

## 2. 方案选型

采用“Rust 直译版原型（推荐方案 1）”：
- 以 `source/dagre-order.js` 为行为基线，Rust 侧尽量逐步映射同名阶段与核心流程。
- 通过 WASM 向 JS 暴露等价布局入口。
- 在 Rust 侧保留阶段耗时统计，便于对比分析。

选择理由：
- 结果可追溯，便于定位 JS/Rust 差异来源。
- 风险最低，后续切换线上路径时可控性最好。

## 3. 总体架构

### 3.1 目录与模块

- 新增 Rust 工程：`rust/dagre-order-rs/`
- JS 桥接模块：`source/dagre-order-rs.js`
- 对比工具：`test/dagre-order-compare.js`

### 3.2 运行路径

默认路径保持不变（JS）：
- `source/mycelium.js` 继续走 `dagre-order.js`

原型路径（按配置启用）：
- 通过 layout 选项（例如 `layout.orderEngine = 'rust-proto'`）切换到 Rust/WASM
- 切换仅用于本地验证与对比，不影响默认行为

### 3.3 原型调用关系

1. JS 收集 `nodes/edges/layout/state`
2. JS 桥接层序列化输入并调用 WASM
3. Rust 执行布局并返回结果与统计
4. JS 应用返回结果并可进入对比逻辑

## 4. 接口与数据模型

### 4.1 WASM 导出接口（首版）

- `layout(input_json: string) -> string`

说明：
- 首版采用 JSON 字符串作为输入输出，优先保证可调试与可比性。
- 后续如需优化，可切换到二进制协议。

### 4.2 输入结构（镜像 JS）

- `nodes[]`：`id, width, height, rank?, order?, parent?, ...`
- `edges[]`：`v, w, weight?, minlen?, width?, height?, labelpos?, ...`
- `layout`：透传现有布局参数（`ranksep/nodesep/edgesep/order/...`）
- `state`：原样透传，保证 fast 路径兼容性

### 4.3 输出结构

- `nodes[]`：`id, rank, order, x, y, width, height, ...`
- `edges[]`：`v, w, points[], x?, y?, ...`
- `meta`：`ok, elapsed_ms, stage_ms, warnings`

### 4.4 一致性判定规则

- 严格一致：`rank/order/parent`
- 浮点容差：`x/y/points` 绝对误差 `<= 1e-3`（可配置）
- 结构一致：节点数、边数、关键字段完整性
- 统计对比：crossing count 差异单列报告

## 5. 实施计划（分阶段）

### Phase 0：脚手架与桥接（1 天）

产出：
- Rust crate 基础结构
- WASM 构建脚本
- JS 加载与调用桥接

验收：
- 浏览器环境能调用 WASM 并收到结构化返回

### Phase 1：图结构与基础工具直译（2-3 天）

产出：
- Rust 版 Graph 抽象
- dummy/border 节点机制
- rank/order 依赖的基础工具函数

验收：
- 小图可执行到中间阶段且无崩溃

### Phase 2：全量流程直译（3-5 天）

产出：
- 覆盖 `dagre-order.js` 全流程原型
- 关键阶段日志/耗时输出

验收：
- 典型图可完成布局并输出完整结果

### Phase 3：JS vs Rust 对比工具（1-2 天）

产出：
- 对比脚本：同输入双跑
- 结果差异与性能报表

验收：
- 可重复执行，输出稳定报告

### Phase 4：稳定性与回归（1-2 天）

产出：
- 失败样例归档
- 误差阈值配置
- 回归检查清单

验收：
- 多次运行稳定，无随机性崩溃

### Phase 5：后续优化（可选）

- JSON 编解码优化（二进制协议）
- 热路径数据结构优化
- 算法层优化（在行为对齐后进行）

## 6. 风险与缓解

### 6.1 行为不一致风险

风险：JS 历史逻辑包含较多边界分支，直译易出现细节偏差。

缓解：
- 增加阶段级对比与中间快照
- 先对齐关键图集，再扩样本

### 6.2 性能误判风险

风险：首版 JSON 编解码开销可能掩盖算法收益。

缓解：
- 报表拆分“编解码耗时”与“算法耗时”
- 评估时分别看端到端与纯算法

### 6.3 WASM 调试难度

风险：浏览器内堆栈可读性较差。

缓解：
- Rust 返回结构化错误码与 `warnings`
- 保留阶段耗时与关键状态日志

## 7. 验收标准（DoD）

原型完成需满足：
- 已实现 Rust 版 `dagre-order` 全量原型调用链。
- 可通过开关在 JS/Rust 间切换布局实现。
- 对比脚本可输出：
  - 结果一致性差异（节点/边/浮点容差）
  - 总耗时与分阶段耗时
- 在既定样本图集上可稳定运行并生成报告。
- 默认路径仍为 JS，未引入线上行为回归。

## 8. 里程碑输出

- `rust/dagre-order-rs/`：Rust 原型实现
- `source/dagre-order-rs.js`：WASM 桥接
- `test/dagre-order-compare.js`：对比与性能报告工具
- 基准报告（文本或 JSON）：用于后续是否切换线上路径的依据
