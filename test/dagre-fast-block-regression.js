import assert from 'assert';
import { layout as layoutJs } from '../source/dagre-fast.js';
import { layout as layoutCpp } from '../source/dagre-fast-cpp.js';

const EPS = 1e-6;

const makeGraph = () => ({
    nodes: [
        { v: 's', width: 100, height: 40 },
        { v: 'a', width: 100, height: 40 },
        { v: 'b', width: 100, height: 40 },
        { v: 'c', width: 100, height: 40 },
        { v: 'd', width: 100, height: 40 },
        { v: 't', width: 100, height: 40 },
        { v: 'u', width: 100, height: 40 }
    ],
    edges: [
        { v: 's', w: 'a' },
        { v: 's', w: 'b' },
        { v: 'a', w: 'c' },
        { v: 'b', w: 'd' },
        { v: 'c', w: 't' },
        { v: 'd', w: 't' },
        { v: 's', w: 't' },
        { v: 't', w: 'u' }
    ]
});

const run = async (mode, fastEngine) => {
    const { nodes, edges } = makeGraph();
    const options = { rankdir: 'TB' };
    if (mode) {
        options.blockMode = mode;
    }
    if (fastEngine === 'cpp') {
        await layoutCpp(nodes, edges, { ...options, fastEngine: 'cpp' }, {});
    } else {
        layoutJs(nodes, edges, { ...options, fastEngine: 'js' }, {});
    }
    return { nodes, edges };
};

for (const fastEngine of [ 'js', 'cpp' ]) {
    const baseline = await run(undefined, fastEngine);
    const off = await run('off', fastEngine);

    assert.strictEqual(off.nodes.length, baseline.nodes.length, 'off and default should have same node count');
    assert.strictEqual(off.edges.length, baseline.edges.length, 'off and default should have same edge count');

    for (const node of baseline.nodes) {
        const peer = off.nodes.find((item) => item.v === node.v);
        assert.ok(peer, `node ${node.v} should exist in off mode`);
        assert.ok(Math.abs(node.x - peer.x) <= EPS, `node ${node.v} x should match default within tolerance`);
        assert.ok(Math.abs(node.y - peer.y) <= EPS, `node ${node.v} y should match default within tolerance`);
    }

    for (const edge of baseline.edges) {
        const peer = off.edges.find((item) => item.v === edge.v && item.w === edge.w);
        assert.ok(peer, `edge ${edge.v}->${edge.w} should exist in off mode`);
        const points = Array.isArray(edge.points) ? edge.points : [];
        const peerPoints = Array.isArray(peer.points) ? peer.points : [];
        assert.strictEqual(peerPoints.length, points.length, `edge ${edge.v}->${edge.w} point count should match`);
        for (let i = 0; i < points.length; i++) {
            assert.ok(Math.abs(points[i].x - peerPoints[i].x) <= EPS, `edge ${edge.v}->${edge.w} point ${i} x should match`);
            assert.ok(Math.abs(points[i].y - peerPoints[i].y) <= EPS, `edge ${edge.v}->${edge.w} point ${i} y should match`);
        }
    }
}
