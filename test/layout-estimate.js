import assert from 'assert';
import { Graph } from '../source/mycelium.js';

class StubNode {

    constructor(name) {
        this.name = name;
        this.width = undefined;
        this.height = undefined;
        this.x = 0;
        this.y = 0;
    }

    async measure() {
        throw new Error('measure() should not be called when layout uses estimated size.');
    }

    async layout() {
    }

    update() {
    }
}

const graph = new Graph(false);
graph.options = { direction: 'horizontal' };
const n1 = new StubNode('node-a');
const n2 = new StubNode('node-b');
graph.setNode(n1);
graph.setNode(n2);
graph.setEdge({ v: 'node-a', w: 'node-b', label: '' });

await graph.layout(null, { estimateOnly: true });

assert.ok(Number.isFinite(n1.x) && Number.isFinite(n1.y), 'node-a should be laid out without DOM measure.');
assert.ok(Number.isFinite(n2.x) && Number.isFinite(n2.y), 'node-b should be laid out without DOM measure.');
assert.ok(n1.width > 0 && n1.height > 0, 'node-a should get estimated size.');
assert.ok(n2.width > 0 && n2.height > 0, 'node-b should get estimated size.');
assert.ok(graph.width > 0 && graph.height > 0, 'graph bounds should be computed.');
