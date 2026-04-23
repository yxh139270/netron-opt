import assert from 'assert';
import fs from 'fs';
import { layout as jsLayout } from '../source/dagre-fast.js';
import { layout as cppLayout } from '../source/dagre-fast-cpp.js';

const argv = process.argv.slice(2);
const fixtureArg = argv.find((arg) => arg.startsWith('--fixture='));
const fixtureIndex = argv.indexOf('--fixture');
const fixturePath = fixtureArg
    ? fixtureArg.slice('--fixture='.length)
    : (fixtureIndex >= 0 && argv[fixtureIndex + 1] ? argv[fixtureIndex + 1] : 'test/dagre-fast-cpp-fixtures.json');

assert.ok(fs.existsSync(fixturePath), 'fixtures should exist');

const EPS_NODE = 1e-6;
const EPS_POINT = 1e-4;

const close = (a, b, eps) => Math.abs(a - b) <= eps;

const runJs = (fixture) => {
    const nodes = fixture.nodes.map((node) => ({ ...node }));
    const edges = fixture.edges.map((edge) => ({ ...edge }));
    jsLayout(nodes, edges, { ...(fixture.layout || {}), fastEngine: 'js' }, {});
    return { nodes, edges };
};

const runCpp = async (fixture) => {
    const nodes = fixture.nodes.map((node) => ({ ...node }));
    const edges = fixture.edges.map((edge) => ({ ...edge }));
    await cppLayout(nodes, edges, { ...(fixture.layout || {}), fastEngine: 'cpp' }, {});
    return { nodes, edges };
};

const mapNodes = (nodes) => new Map((nodes || []).map((node) => [node.v, node]));
const mapEdges = (edges) => new Map((edges || []).map((edge) => [`${edge.v}->${edge.w}`, edge]));

const fixtures = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
let mismatchCount = 0;

for (const fixture of fixtures) {
    const js = runJs(fixture);
    const cpp = await runCpp(fixture);

    const jsNodes = mapNodes(js.nodes);
    const cppNodes = mapNodes(cpp.nodes);
    assert.strictEqual(cppNodes.size, jsNodes.size, `[${fixture.name}] node count mismatch`);
    for (const [id, node] of jsNodes) {
        const peer = cppNodes.get(id);
        assert.ok(peer, `[${fixture.name}] missing cpp node ${id}`);
        if (!close(node.x, peer.x, EPS_NODE) || !close(node.y, peer.y, EPS_NODE)) {
            mismatchCount++;
            throw new Error(`[${fixture.name}] node mismatch ${id}: js=(${node.x},${node.y}) cpp=(${peer.x},${peer.y})`);
        }
    }

    const jsEdges = mapEdges(js.edges);
    const cppEdges = mapEdges(cpp.edges);
    assert.strictEqual(cppEdges.size, jsEdges.size, `[${fixture.name}] edge count mismatch`);
    for (const [id, edge] of jsEdges) {
        const peer = cppEdges.get(id);
        assert.ok(peer, `[${fixture.name}] missing cpp edge ${id}`);
        const p1 = Array.isArray(edge.points) ? edge.points : [];
        const p2 = Array.isArray(peer.points) ? peer.points : [];
        if (p1.length !== p2.length) {
            mismatchCount++;
            throw new Error(`[${fixture.name}] edge point length mismatch ${id}: js=${p1.length} cpp=${p2.length}`);
        }
        for (let i = 0; i < p1.length; i++) {
            if (!close(p1[i].x, p2[i].x, EPS_POINT) || !close(p1[i].y, p2[i].y, EPS_POINT)) {
                mismatchCount++;
                throw new Error(`[${fixture.name}] edge point mismatch ${id}#${i}`);
            }
        }
    }
}

if (typeof console !== 'undefined' && console.log) {
    console.log(`[dagre-fast-cpp-compare] fixtures=${fixtures.length} mismatches=${mismatchCount}`);
}
