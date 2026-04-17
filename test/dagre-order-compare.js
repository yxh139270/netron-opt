import * as fs from 'fs/promises';
import * as path from 'path';
import process from 'process';
import { fileURLToPath } from 'url';

import { layout as jsLayout } from '../source/dagre-order.js';
import { layout as rustLayout } from '../source/dagre-order-rs.js';

const EPS = 1e-3;

const dirname = (...parts) => {
    const file = fileURLToPath(import.meta.url);
    const dir = path.dirname(file);
    return path.join(dir, ...parts);
};

const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

const parseArgs = () => {
    const args = process.argv.slice(2);
    let fixture = 'test/dagre-order-fixtures.json';
    let json = false;
    let failOnDiff = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--fixture' && i + 1 < args.length) {
            fixture = args[++i];
        } else if (arg.startsWith('--fixture=')) {
            fixture = arg.slice('--fixture='.length);
        } else if (arg === '--json') {
            json = true;
        } else if (arg === '--fail-on-diff') {
            failOnDiff = true;
        }
    }
    return { fixture, json, failOnDiff };
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const nodeId = (node) => (node && typeof node.id === 'string' ? node.id : node && typeof node.v === 'string' ? node.v : '');

const edgeKey = (edge) => JSON.stringify([edge.v, edge.w]);

const toNodeMap = (nodes, fixtureNodes = []) => {
    const byFixture = new Map();
    for (const node of fixtureNodes || []) {
        if (node && typeof node.v === 'string') {
            byFixture.set(node.v, node);
        }
    }
    const map = new Map();
    for (const node of nodes || []) {
        const id = nodeId(node);
        if (!id) {
            continue;
        }
        const base = byFixture.get(id) || {};
        map.set(id, {
            id,
            x: node.x,
            y: node.y,
            rank: node.rank !== undefined ? node.rank : base.rank,
            order: node.order !== undefined ? node.order : base.order,
            parent: node.parent !== undefined ? node.parent : base.parent
        });
    }
    for (const [id, base] of byFixture) {
        if (!map.has(id)) {
            map.set(id, {
                id,
                x: undefined,
                y: undefined,
                rank: base.rank,
                order: base.order,
                parent: base.parent
            });
        }
    }
    return map;
};

const toEdgeBuckets = (edges) => {
    const map = new Map();
    for (const edge of edges || []) {
        if (!edge || typeof edge.v !== 'string' || typeof edge.w !== 'string') {
            continue;
        }
        const key = edgeKey(edge);
        if (!map.has(key)) {
            map.set(key, []);
        }
        map.get(key).push(edge);
    }
    return map;
};

const edgeSortKey = (edge) => {
    const points = Array.isArray(edge && edge.points) ? edge.points : [];
    const head = points.length > 0 ? points[0] : null;
    const tail = points.length > 0 ? points[points.length - 1] : null;
    return JSON.stringify({
        v: edge && edge.v,
        w: edge && edge.w,
        points_len: points.length,
        head_x: head && Number.isFinite(head.x) ? head.x : null,
        head_y: head && Number.isFinite(head.y) ? head.y : null,
        tail_x: tail && Number.isFinite(tail.x) ? tail.x : null,
        tail_y: tail && Number.isFinite(tail.y) ? tail.y : null
    });
};

const sortedEdgeBucket = (bucket) => {
    return [...bucket].sort((left, right) => edgeSortKey(left).localeCompare(edgeSortKey(right)));
};

const formatStageSummary = (stageMs) => {
    const entries = Object.entries(stageMs || {})
        .filter(([, value]) => Number.isFinite(value))
        .sort((a, b) => b[1] - a[1]);
    if (entries.length === 0) {
        return 'none';
    }
    return entries
        .slice(0, 5)
        .map(([name, ms]) => `${name}=${Number(ms).toFixed(3)}`)
        .join(', ');
};

const numberDiff = (a, b) => {
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return Number.POSITIVE_INFINITY;
    }
    return Math.abs(a - b);
};

const comparePoints = (pointsA, pointsB, pathPrefix) => {
    const diffs = [];
    const a = Array.isArray(pointsA) ? pointsA : [];
    const b = Array.isArray(pointsB) ? pointsB : [];
    if (a.length !== b.length) {
        diffs.push({ type: 'tolerant', field: `${pathPrefix}.length`, left: a.length, right: b.length, diff: Math.abs(a.length - b.length) });
        return diffs;
    }
    for (let i = 0; i < a.length; i++) {
        const dx = numberDiff(a[i] && a[i].x, b[i] && b[i].x);
        const dy = numberDiff(a[i] && a[i].y, b[i] && b[i].y);
        if (dx > EPS) {
            diffs.push({ type: 'tolerant', field: `${pathPrefix}[${i}].x`, left: a[i] && a[i].x, right: b[i] && b[i].x, diff: dx });
        }
        if (dy > EPS) {
            diffs.push({ type: 'tolerant', field: `${pathPrefix}[${i}].y`, left: a[i] && a[i].y, right: b[i] && b[i].y, diff: dy });
        }
    }
    return diffs;
};

const compareOutputs = (fixture, jsResult, rustResult) => {
    const strictDiffs = [];
    const tolerantDiffs = [];

    const jsNodes = toNodeMap(jsResult.nodes, fixture.nodes);
    const rustNodes = toNodeMap(rustResult.nodes, fixture.nodes);
    const nodeKeys = new Set([...jsNodes.keys(), ...rustNodes.keys()]);
    for (const key of nodeKeys) {
        const left = jsNodes.get(key);
        const right = rustNodes.get(key);
        if (!left || !right) {
            strictDiffs.push({ type: 'strict', field: `node:${key}.exists`, left: !!left, right: !!right });
            continue;
        }
        for (const field of ['rank', 'order', 'parent']) {
            if (!Object.is(left[field], right[field])) {
                strictDiffs.push({ type: 'strict', field: `node:${key}.${field}`, left: left[field], right: right[field] });
            }
        }
        for (const field of ['x', 'y']) {
            const delta = numberDiff(left[field], right[field]);
            if (delta > EPS) {
                tolerantDiffs.push({ type: 'tolerant', field: `node:${key}.${field}`, left: left[field], right: right[field], diff: delta });
            }
        }
    }

    const jsEdgeBuckets = toEdgeBuckets(jsResult.edges);
    const rustEdgeBuckets = toEdgeBuckets(rustResult.edges);
    const edgeKeys = new Set([...jsEdgeBuckets.keys(), ...rustEdgeBuckets.keys()]);
    for (const key of edgeKeys) {
        const leftBucket = sortedEdgeBucket(jsEdgeBuckets.get(key) || []);
        const rightBucket = sortedEdgeBucket(rustEdgeBuckets.get(key) || []);
        if (leftBucket.length !== rightBucket.length) {
            strictDiffs.push({ type: 'strict', field: `edge:${key}.count`, left: leftBucket.length, right: rightBucket.length });
        }
        const length = Math.min(leftBucket.length, rightBucket.length);
        for (let i = 0; i < length; i++) {
            const left = leftBucket[i];
            const right = rightBucket[i];
            tolerantDiffs.push(...comparePoints(left.points, right.points, `edge:${key}[${i}].points`));
            for (const field of ['x', 'y']) {
                if (left[field] === undefined && right[field] === undefined) {
                    continue;
                }
                const delta = numberDiff(left[field], right[field]);
                if (delta > EPS) {
                    tolerantDiffs.push({ type: 'tolerant', field: `edge:${key}[${i}].${field}`, left: left[field], right: right[field], diff: delta });
                }
            }
        }
    }

    return {
        ok: strictDiffs.length === 0 && tolerantDiffs.length === 0,
        strictDiffs,
        tolerantDiffs
    };
};

const runJs = (fixture) => {
    const nodes = clone(fixture.nodes || []);
    const edges = clone(fixture.edges || []);
    const layout = { ...(fixture.layout || {}), profileStages: true };
    const state = { ...(fixture.state || {}) };
    const start = nowMs();
    jsLayout(nodes, edges, layout, state);
    const total = nowMs() - start;
    const stage = {};
    if (Array.isArray(state.stageTimings)) {
        for (const item of state.stageTimings) {
            const name = item && typeof item.name === 'string' ? item.name : 'anonymous';
            const ms = item && Number.isFinite(item.ms) ? item.ms : 0;
            stage[name] = (stage[name] || 0) + ms;
        }
    }
    return {
        nodes,
        edges,
        timing: {
            total_ms: total,
            stage_ms: stage,
            stage_total_ms: Number.isFinite(state.stageTotalMs) ? state.stageTotalMs : null
        }
    };
};

const runRust = async (fixture) => {
    const nodes = clone(fixture.nodes || []);
    const edges = clone(fixture.edges || []);
    const layout = clone(fixture.layout || {});
    const state = clone(fixture.state || {});
    const start = nowMs();
    const result = await rustLayout(nodes, edges, layout, state);
    const total = nowMs() - start;
    return {
        nodes: Array.isArray(result && result.nodes) ? result.nodes : [],
        edges: Array.isArray(result && result.edges) ? result.edges : [],
        meta: result && result.meta ? result.meta : null,
        timing: {
            total_ms: total,
            stage_ms: result && result.meta && result.meta.stage_ms && typeof result.meta.stage_ms === 'object' ? result.meta.stage_ms : {},
            stage_total_ms: result && result.meta && Number.isFinite(result.meta.elapsed_ms) ? result.meta.elapsed_ms : null
        }
    };
};

const summarizeFixture = async (fixture) => {
    const jsResult = runJs(fixture);
    let rustResult = null;
    let rustError = null;
    try {
        rustResult = await runRust(fixture);
    } catch (error) {
        rustError = error && error.message ? error.message : String(error);
    }
    const diff = rustResult ? compareOutputs(fixture, jsResult, rustResult) : {
        ok: false,
        strictDiffs: [{ type: 'strict', field: 'rust.runtime', left: 'ok', right: rustError || 'unknown_error' }],
        tolerantDiffs: []
    };
    return {
        name: fixture.name || 'unnamed',
        ok: diff.ok,
        diff,
        rustError,
        timing: {
            js: jsResult.timing,
            rust: rustResult ? rustResult.timing : { total_ms: 0, stage_ms: {}, stage_total_ms: null }
        }
    };
};

const printText = (report) => {
    const lines = [];
    lines.push(`fixtures: ${report.fixtures.length}`);
    lines.push(`ok: ${report.okCount}`);
    lines.push(`mismatch: ${report.mismatchCount}`);
    for (const item of report.fixtures) {
        lines.push('');
        lines.push(`[${item.name}] ${item.ok ? 'OK' : 'DIFF'}`);
        lines.push(`  diff strict=${item.diff.strictDiffs.length} tolerant=${item.diff.tolerantDiffs.length}`);
        lines.push(`  js total_ms=${item.timing.js.total_ms.toFixed(3)} stage=${formatStageSummary(item.timing.js.stage_ms)}`);
        lines.push(`  rust total_ms=${item.timing.rust.total_ms.toFixed(3)} stage=${formatStageSummary(item.timing.rust.stage_ms)}`);
        if (item.rustError) {
            lines.push(`  rust error=${item.rustError}`);
        }
        if (item.diff.strictDiffs.length > 0) {
            const sample = item.diff.strictDiffs.slice(0, 3);
            for (const diff of sample) {
                lines.push(`  strict ${diff.field} left=${JSON.stringify(diff.left)} right=${JSON.stringify(diff.right)}`);
            }
        }
        if (item.diff.tolerantDiffs.length > 0) {
            const sample = item.diff.tolerantDiffs.slice(0, 3);
            for (const diff of sample) {
                const value = Number.isFinite(diff.diff) ? diff.diff.toExponential(2) : String(diff.diff);
                lines.push(`  tolerant ${diff.field} left=${JSON.stringify(diff.left)} right=${JSON.stringify(diff.right)} diff=${value}`);
            }
        }
    }
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
};

const main = async () => {
    const args = parseArgs();
    const fixturePath = path.isAbsolute(args.fixture) ? args.fixture : path.resolve(process.cwd(), args.fixture);
    const content = await fs.readFile(fixturePath, 'utf-8');
    const parsed = JSON.parse(content);
    const fixtures = Array.isArray(parsed) ? parsed : Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
    if (fixtures.length === 0) {
        throw new Error(`No fixtures found in '${args.fixture}'.`);
    }
    const results = [];
    for (const fixture of fixtures) {
        // eslint-disable-next-line no-await-in-loop
        const result = await summarizeFixture(fixture);
        results.push(result);
    }
    const report = {
        fixture: path.relative(process.cwd(), fixturePath),
        eps: EPS,
        okCount: results.filter((item) => item.ok).length,
        mismatchCount: results.filter((item) => !item.ok).length,
        fixtures: results
    };
    if (args.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify(report, null, 2));
    } else {
        printText(report);
    }
    if (args.failOnDiff && report.mismatchCount > 0) {
        process.exitCode = 2;
    }
};

main().catch((error) => {
    // eslint-disable-next-line no-console
    console.error(`${error.name}: ${error.message}`);
    process.exitCode = 1;
});
