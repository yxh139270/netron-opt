const layoutD3dag = {};

let d3dagModule = null;

const loadD3dag = async () => {
    if (!d3dagModule) {
        d3dagModule = await import('d3-dag');
    }
    return d3dagModule;
};

const now = () => {
    if (typeof performance !== 'undefined' && performance.now) {
        return performance.now();
    }
    return Date.now();
};

layoutD3dag.layout = async (nodes, edges, layout, state) => {
    const fallback = async (reason) => {
        if (state) {
            state.engine = 'dagre-fallback';
            state.layoutError = reason;
        }
        const dagre = await import('./dagre.js');
        dagre.layout(nodes, edges, layout, state);
    };

    try {
        const isNodeRuntime = typeof process !== 'undefined' && process.versions && process.versions.node;
        if (!isNodeRuntime) {
            await fallback('d3-dag is not available in browser worker runtime');
            return;
        }

        let d3dag = null;
        try {
            d3dag = await loadD3dag();
        } catch (error) {
            await fallback(error && error.message ? error.message : 'Unable to load d3-dag module');
            return;
        }

        const metrics = {};
        const t0 = now();
        const hasCompound = nodes.some((node) => node.parent !== null && node.parent !== undefined);
        if (hasCompound) {
            await fallback('d3-dag does not support compound graph in this adapter');
            return;
        }
        metrics.compoundCheck = now() - t0;

        const t1 = now();
        const connected = new Set();
        for (const edge of edges) {
            connected.add(edge.v);
            connected.add(edge.w);
        }
        const isolated = nodes.filter((node) => !connected.has(node.v));
        const unique = [];
        const seen = new Set();
        for (const edge of edges) {
            const key = `${edge.v}->${edge.w}`;
            if (!seen.has(key)) {
                seen.add(key);
                unique.push([edge.v, edge.w]);
            }
        }
        const edgePairs = unique;
        const connect = d3dag.graphConnect();
        const graph = connect(edgePairs);
        metrics.buildGraph = now() - t1;

        const t2 = now();
        const nodeMap = new Map(nodes.map((node) => [node.v, node]));
        const nodeSize = (node) => {
            const key = node.data;
            const entry = nodeMap.get(key);
            const width = entry && Number.isFinite(entry.width) ? entry.width : 0;
            const height = entry && Number.isFinite(entry.height) ? entry.height : 0;
            return [Math.max(1, width), Math.max(1, height)];
        };
        const mode = layout.engine || 'd3dag';
        const layering = (mode === 'd3dag-fast-sugi' || layout.ranker === 'longest-path') ? d3dag.layeringLongestPath() : d3dag.layeringSimplex();
        const ranksep = Number.isFinite(layout.ranksep) ? layout.ranksep : 20;
        const nodesep = Number.isFinite(layout.nodesep) ? layout.nodesep : 20;
        const gap = [nodesep, ranksep];

        let layoutOperator = null;
        if (mode === 'd3dag-zherebko') {
            layoutOperator = d3dag.zherebko();
        } else {
            const decross = mode === 'd3dag-fast-sugi' ? d3dag.decrossDfs() : d3dag.decrossTwoLayer();
            const coord = mode === 'd3dag-fast-sugi' ? d3dag.coordTopological() : d3dag.coordGreedy();
            layoutOperator = d3dag.sugiyama()
                .nodeSize(nodeSize)
                .layering(layering)
                .gap(gap)
                .decross(decross)
                .coord(coord);
        }

        metrics.prepare = now() - t2;

        const t3 = now();
        const result = layoutOperator(graph);
        metrics.sugiyama = now() - t3;

        const t4 = now();
        for (const node of graph.nodes()) {
            const entry = nodeMap.get(node.data);
            if (entry) {
                entry.x = node.ux;
                entry.y = node.uy;
            }
        }
        metrics.mapNodes = now() - t4;

        const t5 = now();
        const links = Array.from(graph.links());
        const linkMap = new Map();
        for (const link of links) {
            const key = `${link.source.data}->${link.target.data}`;
            if (!linkMap.has(key)) {
                linkMap.set(key, link);
            }
        }
        for (const edge of edges) {
            const match = linkMap.get(`${edge.v}->${edge.w}`);
            if (match && Array.isArray(match.points) && match.points.length > 0) {
                edge.points = match.points.map((point) => ({ x: point[0], y: point[1] }));
                const index = Math.floor(edge.points.length / 2);
                edge.x = edge.points[index].x;
                edge.y = edge.points[index].y;
            } else {
                const source = nodeMap.get(edge.v);
                const target = nodeMap.get(edge.w);
                if (source && target) {
                    edge.points = [
                        { x: source.x, y: source.y },
                        { x: target.x, y: target.y }
                    ];
                    edge.x = (source.x + target.x) / 2;
                    edge.y = (source.y + target.y) / 2;
                }
            }
        }
        metrics.mapEdges = now() - t5;

        const t6 = now();
        if (isolated.length > 0) {
            let cursor = (Number.isFinite(result.width) ? result.width : 0) + nodesep;
            for (const node of isolated) {
                node.x = cursor + (node.width || 0) / 2;
                node.y = (node.height || 0) / 2;
                cursor += (node.width || 0) + nodesep;
            }
        }
        metrics.isolated = now() - t6;

        const t7 = now();
        const rankdir = (layout.rankdir || 'TB').toUpperCase();
        if (rankdir === 'LR' || rankdir === 'RL') {
            for (const node of nodes) {
                const x = node.x;
                node.x = node.y;
                node.y = x;
            }
            for (const edge of edges) {
                if (Array.isArray(edge.points)) {
                    for (const point of edge.points) {
                        const x = point.x;
                        point.x = point.y;
                        point.y = x;
                    }
                }
                const x = edge.x;
                edge.x = edge.y;
                edge.y = x;
            }
        }
        metrics.rotate = now() - t7;

        if (state) {
            state.engine = mode;
            state.profile = state.profile || {};
            state.profile.d3dag = metrics;
        }
    } catch (error) {
        await fallback(error && error.message ? error.message : 'd3-dag layout failed');
    }
};

export const { layout } = layoutD3dag;
