import assert from 'assert';
import { layout } from '../source/dagre-fast-cpp.js';

const nodes = [
    { v: 'A', width: 100, height: 40 },
    { v: 'B', width: 100, height: 40 },
    { v: 'C', width: 100, height: 40 }
];
const edges = [
    { v: 'A', w: 'B' },
    { v: 'B', w: 'C' },
    { v: 'A', w: 'C' }
];
const state = {};

await layout(nodes, edges, { rankdir: 'TB', fastEngine: 'cpp' }, state);
for (const node of nodes) {
    assert.ok(Number.isFinite(node.x) && Number.isFinite(node.y), 'cpp baseline should output coordinates');
}
