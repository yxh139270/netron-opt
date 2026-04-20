// dagre-compare.js
// 对比 JS 引擎和 Rust WASM 引擎对同一输入的布局结果
//
// 用法:
//   1. 先用 NETRON_DAGRE_DUMP=/tmp/dagre-input.json 跑一次模型加载，dump 布局输入
//   2. 运行 node test/dagre-compare.js /tmp/dagre-input.json
//
// 或直接提供 dump 文件路径作为参数

import * as fs from 'fs/promises';
import * as path from 'path';
import * as url from 'url';

const self = url.fileURLToPath(import.meta.url);
const dir = path.dirname(self);
const root = path.resolve(dir, '..');

const inputPath = process.argv[2];
if (!inputPath) {
    console.error('用法: node test/dagre-compare.js <dagre-input.json>');
    process.exit(1);
}

const raw = await fs.readFile(inputPath, 'utf-8');
const input = JSON.parse(raw);
const { nodes, edges, layout } = input;

console.log(`输入: ${nodes.length} nodes, ${edges.length} edges`);
console.log(`layout: ${JSON.stringify(layout)}`);

// --- JS 引擎 ---
const jsNodes = JSON.parse(JSON.stringify(nodes));
const jsEdges = JSON.parse(JSON.stringify(edges));
const jsLayout = JSON.parse(JSON.stringify(layout));
const jsState = {};

const dagre = await import(path.resolve(root, 'source/dagre-order.js'));
const jsStart = performance.now();
dagre.layout(jsNodes, jsEdges, jsLayout, jsState);
const jsTime = performance.now() - jsStart;
console.log(`\n[JS] 完成: ${jsTime.toFixed(2)} ms`);

// --- Rust WASM 引擎 ---
const rsNodes = JSON.parse(JSON.stringify(nodes));
const rsEdges = JSON.parse(JSON.stringify(edges));
const rsLayout = JSON.parse(JSON.stringify(layout));
const rsState = {};

let rsResult = null;
let rsTime = 0;
try {
    const dagreRs = await import(path.resolve(root, 'source/dagre-order-rs.js'));
    const rsStart = performance.now();
    rsResult = await dagreRs.layout(rsNodes, rsEdges, rsLayout, rsState);
    rsTime = performance.now() - rsStart;
    console.log(`[Rust] 完成: ${rsTime.toFixed(2)} ms`);
} catch (error) {
    console.error(`[Rust] 加载/运行失败: ${error.message}`);
    process.exit(1);
}

if (rsResult && rsResult.error) {
    console.error(`[Rust] 返回错误: ${rsResult.error.code}: ${rsResult.error.message}`);
    process.exit(1);
}

// --- 对比节点 ---
const rsNodeMap = new Map();
if (rsResult && Array.isArray(rsResult.nodes)) {
    for (const node of rsResult.nodes) {
        if (node && typeof node.id === 'string') {
            rsNodeMap.set(node.id, node);
        }
    }
}

const rsEdgeBuckets = new Map();
if (rsResult && Array.isArray(rsResult.edges)) {
    for (const edge of rsResult.edges) {
        if (edge && typeof edge.v === 'string' && typeof edge.w === 'string') {
            const key = `${edge.v}->${edge.w}`;
            if (!rsEdgeBuckets.has(key)) {
                rsEdgeBuckets.set(key, []);
            }
            rsEdgeBuckets.get(key).push(edge);
        }
    }
}

let nodeDiffs = 0;
let nodeMaxDx = 0;
let nodeMaxDy = 0;
const EPS = 0.5;

console.log(`\n--- 节点对比 (共 ${jsNodes.length} 个原始节点) ---`);

for (const jsNode of jsNodes) {
    const rsNode = rsNodeMap.get(jsNode.v);
    if (!rsNode) {
        console.log(`  [MISS] 节点 '${jsNode.v}' Rust 侧缺失`);
        nodeDiffs++;
        continue;
    }
    const dx = Math.abs((jsNode.x || 0) - (rsNode.x || 0));
    const dy = Math.abs((jsNode.y || 0) - (rsNode.y || 0));
    nodeMaxDx = Math.max(nodeMaxDx, dx);
    nodeMaxDy = Math.max(nodeMaxDy, dy);
    if (dx > EPS || dy > EPS) {
        nodeDiffs++;
        if (nodeDiffs <= 20) {
            console.log(`  [DIFF] ${jsNode.v}: JS(${jsNode.x?.toFixed(1)}, ${jsNode.y?.toFixed(1)}) vs RS(${rsNode.x?.toFixed(1)}, ${rsNode.y?.toFixed(1)}) dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`);
        }
    }
}

console.log(`节点差异: ${nodeDiffs}/${jsNodes.length} (maxDx=${nodeMaxDx.toFixed(1)}, maxDy=${nodeMaxDy.toFixed(1)})`);

// --- 对比边 ---
let edgeDiffs = 0;
let edgeMissing = 0;
let edgePointCountDiff = 0;
let edgeMaxPointDist = 0;

console.log(`\n--- 边对比 (共 ${jsEdges.length} 条原始边) ---`);

for (const jsEdge of jsEdges) {
    const key = `${jsEdge.v}->${jsEdge.w}`;
    const bucket = rsEdgeBuckets.get(key);
    const rsEdge = bucket && bucket.length > 0 ? bucket.shift() : null;
    if (!rsEdge) {
        edgeMissing++;
        if (edgeMissing <= 10) {
            console.log(`  [MISS] 边 '${key}' Rust 侧缺失`);
        }
        continue;
    }
    const jsPoints = jsEdge.points || [];
    const rsPoints = rsEdge.points || [];
    if (jsPoints.length !== rsPoints.length) {
        edgePointCountDiff++;
        if (edgePointCountDiff <= 10) {
            console.log(`  [POINTS] 边 '${key}': JS ${jsPoints.length} points vs RS ${rsPoints.length} points`);
        }
        edgeDiffs++;
        continue;
    }
    let maxDist = 0;
    for (let i = 0; i < jsPoints.length; i++) {
        const dist = Math.sqrt(Math.pow((jsPoints[i].x || 0) - (rsPoints[i].x || 0), 2) + Math.pow((jsPoints[i].y || 0) - (rsPoints[i].y || 0), 2));
        maxDist = Math.max(maxDist, dist);
    }
    edgeMaxPointDist = Math.max(edgeMaxPointDist, maxDist);
    if (maxDist > EPS) {
        edgeDiffs++;
        if (edgeDiffs <= 10) {
            console.log(`  [DIFF] 边 '${key}': maxPointDist=${maxDist.toFixed(1)}`);
        }
    }
}

console.log(`边差异: ${edgeDiffs}/${jsEdges.length} (missing=${edgeMissing}, pointCountDiff=${edgePointCountDiff}, maxPointDist=${edgeMaxPointDist.toFixed(1)})`);

// --- 汇总 ---
console.log(`\n--- 汇总 ---`);
console.log(`JS: ${jsTime.toFixed(2)} ms, Rust: ${rsTime.toFixed(2)} ms (${(jsTime / rsTime).toFixed(1)}x)`);
console.log(`节点差异: ${nodeDiffs}/${jsNodes.length}`);
console.log(`边差异: ${edgeDiffs}/${jsEdges.length}`);

if (nodeDiffs === 0 && edgeDiffs === 0) {
    console.log('\n✅ JS 和 Rust 引擎输出完全一致！');
} else {
    console.log('\n❌ JS 和 Rust 引擎输出存在差异');
    process.exit(2);
}
