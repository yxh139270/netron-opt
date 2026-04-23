import assert from 'assert';
import { layout } from '../source/dagre-fast-cpp.js';

const nodes = [
    { v: 'A', width: 100, height: 40 },
    { v: 'B', width: 100, height: 40 }
];
const edges = [ { v: 'A', w: 'B' } ];
const state = {};

await layout(nodes, edges, { rankdir: 'TB' }, state);
assert.ok(Number.isFinite(nodes[0].x) && Number.isFinite(nodes[1].x), 'bridge should write back node coordinates');
assert.strictEqual(state.layoutDebug && state.layoutDebug.fastEngineFallback, 'cpp->js', 'bridge should mark cpp fallback during passthrough phase');
