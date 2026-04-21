import assert from 'assert';
import { layout } from '../source/dagre-fast.js';

const nodes = [
    { v: 'A', width: 100, height: 40 },
    { v: 'B', width: 100, height: 40 },
    { v: 'C', width: 100, height: 40 }
];

const edges = [
    { v: 'A', w: 'B' },
    { v: 'A', w: 'C' },
    { v: 'B', w: 'C' }
];

layout(nodes, edges, { rankdir: 'TB' }, {});

const edgeAB = edges.find((edge) => edge.v === 'A' && edge.w === 'B');
const edgeBC = edges.find((edge) => edge.v === 'B' && edge.w === 'C');
const edgeAC = edges.find((edge) => edge.v === 'A' && edge.w === 'C');

assert.ok(edgeAB && Array.isArray(edgeAB.points), 'edge A->B should have routed points');
assert.ok(edgeBC && Array.isArray(edgeBC.points), 'edge B->C should have routed points');
assert.ok(edgeAC && Array.isArray(edgeAC.points), 'edge A->C should have routed points');

assert.strictEqual(edgeAB.points.length, 6, 'adjacent-rank edge A->B should not insert long-edge anchors');
assert.strictEqual(edgeBC.points.length, 6, 'adjacent-rank edge B->C should not insert long-edge anchors');
assert.strictEqual(edgeAC.points.length, 8, 'long edge A->C should include route points plus two inline anchors for curved lantern shape');

const sourceAC = edgeAC.points[0];
const targetAC = edgeAC.points[edgeAC.points.length - 1];
const t1 = 0.22;
const t2 = 0.78;
const expectedAnchor1 = {
    x: sourceAC.x + (targetAC.x - sourceAC.x) * t1,
    y: sourceAC.y + (targetAC.y - sourceAC.y) * t1
};
const expectedAnchor2 = {
    x: sourceAC.x + (targetAC.x - sourceAC.x) * t2,
    y: sourceAC.y + (targetAC.y - sourceAC.y) * t2
};
const hasExpectedAnchor = (expected) => edgeAC.points.some((point) =>
    Math.abs(point.x - expected.x) < 1e-6 && Math.abs(point.y - expected.y) < 1e-6
);
assert.ok(hasExpectedAnchor(expectedAnchor1), 'long edge A->C should contain anchor near source on straight line');
assert.ok(hasExpectedAnchor(expectedAnchor2), 'long edge A->C should contain anchor near target on straight line');

const nodeB = nodes.find((node) => node.v === 'B');
const nodeC = nodes.find((node) => node.v === 'C');
const anchorMidX = (expectedAnchor1.x + expectedAnchor2.x) / 2;
assert.ok(Number.isFinite(anchorMidX) && Number.isFinite(nodeB.x) && Number.isFinite(nodeC.x),
    'virtual-anchor spacing metrics should be finite');
assert.ok(Math.abs(nodeB.x - nodeC.x) > 1e-6,
    'virtual anchors should influence rank-1 and rank-2 horizontal allocation to avoid full vertical collapse');

for (let i = 1; i < edgeAC.points.length; i++) {
    assert.ok(edgeAC.points[i].y >= edgeAC.points[i - 1].y, 'long edge A->C should not fold upward in TB layout');
}
