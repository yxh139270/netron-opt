import assert from 'assert';
import { layout as layoutJs } from '../source/dagre-fast.js';
import { layout as layoutCpp } from '../source/dagre-fast-cpp.js';

const makeGraph = () => ({
    nodes: [
        { v: 'A', width: 100, height: 40 },
        { v: 'B', width: 100, height: 40 },
        { v: 'C', width: 100, height: 40 }
    ],
    edges: [
        { v: 'A', w: 'B' },
        { v: 'A', w: 'C' },
        { v: 'B', w: 'C' }
    ]
});

const runCase = async (blockMode, fastEngine) => {
    const { nodes, edges } = makeGraph();
    const options = { rankdir: 'TB' };
    if (blockMode) {
        options.blockMode = blockMode;
    }
    if (fastEngine === 'cpp') {
        await layoutCpp(nodes, edges, { ...options, fastEngine: 'cpp' }, {});
    } else {
        layoutJs(nodes, edges, { ...options, fastEngine: 'js' }, {});
    }

    const edgeAB = edges.find((edge) => edge.v === 'A' && edge.w === 'B');
    const edgeBC = edges.find((edge) => edge.v === 'B' && edge.w === 'C');
    const edgeAC = edges.find((edge) => edge.v === 'A' && edge.w === 'C');

    assert.ok(edgeAB && Array.isArray(edgeAB.points), 'edge A->B should have routed points');
    assert.ok(edgeBC && Array.isArray(edgeBC.points), 'edge B->C should have routed points');
    assert.ok(edgeAC && Array.isArray(edgeAC.points), 'edge A->C should have routed points');

    assert.strictEqual(edgeAB.points.length, 4, 'adjacent-rank edge A->B should not insert long-edge anchors');
    assert.strictEqual(edgeBC.points.length, 4, 'adjacent-rank edge B->C should not insert long-edge anchors');
    assert.strictEqual(edgeAC.points.length, 8, 'long edge A->C should include route points plus two inline anchors for curved lantern shape');

    const sourceAC = edgeAC.points[0];
    const sourceExitAC = edgeAC.points[1];
    const virtualAnchor = edgeAC.points[4];
    const targetAC = edgeAC.points[edgeAC.points.length - 1];
    const almostEqual = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
    const easePoint = (fromX, fromY, toX, toY, t) => {
        const eased = t * t;
        return {
            x: fromX + (toX - fromX) * eased,
            y: fromY + (toY - fromY) * t
        };
    };
    const easePointInv = (fromX, fromY, toX, toY, t) => {
        const eased = 1 - (1 - t) * (1 - t);
        return {
            x: fromX + (toX - fromX) * eased,
            y: fromY + (toY - fromY) * t
        };
    };
    const expectedSourceControl1 = easePointInv(sourceAC.x, sourceExitAC.y, virtualAnchor.x, virtualAnchor.y, 0.35);
    const expectedSourceControl2 = easePointInv(sourceAC.x, sourceExitAC.y, virtualAnchor.x, virtualAnchor.y, 0.75);
    const expectedTargetControl1 = easePoint(virtualAnchor.x, virtualAnchor.y, targetAC.x, targetAC.y, 0.35);
    const expectedTargetControl2 = easePoint(virtualAnchor.x, virtualAnchor.y, targetAC.x, targetAC.y, 0.75);
    assert.ok(
        almostEqual(edgeAC.points[2].x, expectedSourceControl1.x) && almostEqual(edgeAC.points[2].y, expectedSourceControl1.y),
        'long edge A->C should include source-side eased control point (t=0.35)',
    );
    assert.ok(
        almostEqual(edgeAC.points[3].x, expectedSourceControl2.x) && almostEqual(edgeAC.points[3].y, expectedSourceControl2.y),
        'long edge A->C should include source-side eased control point (t=0.75)',
    );
    assert.ok(
        almostEqual(edgeAC.points[5].x, expectedTargetControl1.x) && almostEqual(edgeAC.points[5].y, expectedTargetControl1.y),
        'long edge A->C should include target-side eased control point (t=0.35)',
    );
    assert.ok(
        almostEqual(edgeAC.points[6].x, expectedTargetControl2.x) && almostEqual(edgeAC.points[6].y, expectedTargetControl2.y),
        'long edge A->C should include target-side eased control point (t=0.75)',
    );

    const nodeB = nodes.find((node) => node.v === 'B');
    const nodeC = nodes.find((node) => node.v === 'C');
    const anchorMidX = (edgeAC.points[2].x + edgeAC.points[6].x) / 2;
    assert.ok(Number.isFinite(anchorMidX) && Number.isFinite(nodeB.x) && Number.isFinite(nodeC.x),
        'virtual-anchor spacing metrics should be finite');
    assert.ok(Math.abs(nodeB.x - nodeC.x) > 1e-6,
        'virtual anchors should influence rank-1 and rank-2 horizontal allocation to avoid full vertical collapse');

    for (let i = 1; i < edgeAC.points.length; i++) {
        assert.ok(edgeAC.points[i].y >= edgeAC.points[i - 1].y, 'long edge A->C should not fold upward in TB layout');
    }
};

for (const fastEngine of [ 'js', 'cpp' ]) {
    await runCase(undefined, fastEngine);
    await runCase('auto-inline', fastEngine);
}
