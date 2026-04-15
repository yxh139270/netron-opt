
const dagre = {};

// Dagre graph layout (fast variant)
// Simplified DFS-based layout: rank + column assigned in one pass, no ordering phase.

dagre.layout = (nodes, edges, layout, state) => {

    if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[dagre-fast] invoked nodes=${nodes.length} edges=${edges.length}`);
    }

    const debugLines = [];
    debugLines.push('[dagre-fast] version=2026-04-15-v13');
    debugLines.push(`[dagre-fast] input nodes=${nodes.length} edges=${edges.length}`);

    // ----- helpers -----

    // ----- build adjacency structures from flat arrays -----

    // nodeMap: v -> { v, width, height, inEdges: [], outEdges: [] }
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.v, {
            v: node.v,
            width: node.width || 0,
            height: node.height || 0,
            inEdges: [],
            outEdges: [],
            rank: undefined,
            col: undefined,
            x: undefined,
            y: undefined
        });
    }

    const edgeKey = (v, w) => `${v}->${w}`;

    // Build adjacency lists
    for (const edge of edges) {
        const src = nodeMap.get(edge.v);
        const tgt = nodeMap.get(edge.w);
        if (src && tgt) {
            src.outEdges.push(edge.w);
            tgt.inEdges.push(edge.v);
        }
    }

    // ----- DFS: assign rank and col -----

    // Find all nodes with in-degree 0 (sources)
    const sources = [];
    for (const [v, node] of nodeMap) {
        if (node.inEdges.length === 0) {
            sources.push(v);
        }
    }

    // Compute rank/col by topological pass.
    // For multi-input nodes: col tries to stay at predecessors' average.

    // Kahn's algorithm for topological sort
    const inDegree = new Map();
    for (const [v, node] of nodeMap) {
        inDegree.set(v, node.inEdges.length);
    }
    const queue = [...sources];
    const topoOrder = [];
    while (queue.length > 0) {
        const v = queue.shift();
        topoOrder.push(v);
        const node = nodeMap.get(v);
        for (const w of node.outEdges) {
            const d = inDegree.get(w) - 1;
            inDegree.set(w, d);
            if (d === 0) {
                queue.push(w);
            }
        }
    }

    // Handle any remaining nodes (cycles) — just add them at the end
    for (const [v] of nodeMap) {
        if (!topoOrder.includes(v)) {
            topoOrder.push(v);
        }
    }

    // Similar to dagre's makeSpaceForEdgeLabels, but conservative:
    // unlabeled edges keep unit length, labeled edges get a slightly longer span.
    const edgeMinlen = new Map();
    for (const edge of edges) {
        const hasLabel = (Number.isFinite(edge.width) && edge.width > 0) || (Number.isFinite(edge.height) && edge.height > 0);
        edgeMinlen.set(edgeKey(edge.v, edge.w), hasLabel ? 2 : 1);
    }
    debugLines.push('[dagre-fast] minlen policy: unlabeled=1 labeled=2');

    // Assign rank: for each node in topo order,
    // rank = max(predecessor ranks + effective minlen)
    // Sources get rank 0.
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        if (node.inEdges.length === 0) {
            node.rank = 0;
        } else {
            let maxPredRank = -1;
            for (const pred of node.inEdges) {
                const predNode = nodeMap.get(pred);
                const minlen = edgeMinlen.get(edgeKey(pred, v)) || 1;
                const candidate = predNode.rank !== undefined ? predNode.rank + minlen : -1;
                if (candidate > maxPredRank) {
                    maxPredRank = candidate;
                }
            }
            node.rank = Math.max(0, maxPredRank);
        }
    }

    // Assign col: process nodes rank by rank
    // For rank 0 (sources): assign col 0, 1, 2, ... in source order
    // For rank > 0: col = average of predecessor cols, then resolve collisions

    // Group nodes by rank
    const maxRank = Math.max(...Array.from(nodeMap.values()).map(n => n.rank || 0));
    const nodesByRank = new Array(maxRank + 1);
    for (let r = 0; r <= maxRank; r++) {
        nodesByRank[r] = [];
    }
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        nodesByRank[node.rank].push(v);
    }

    // For rank 0: assign sequential columns
    for (let i = 0; i < nodesByRank[0].length; i++) {
        nodeMap.get(nodesByRank[0][i]).col = i;
    }

    // For rank > 0: col = average of predecessor cols
    for (let r = 1; r <= maxRank; r++) {
        for (const v of nodesByRank[r]) {
            const node = nodeMap.get(v);
            if (node.inEdges.length === 0) {
                // Shouldn't happen for r > 0, but just in case
                node.col = 0;
            } else {
                let sum = 0;
                let count = 0;
                for (const pred of node.inEdges) {
                    const predNode = nodeMap.get(pred);
                    if (predNode.col !== undefined) {
                        sum += predNode.col;
                        count++;
                    }
                }
                node.col = count > 0 ? sum / count : 0;
            }
        }

        // Resolve collisions while preserving average-based center as much as possible.
        // Keep floating col, only enforce minimum spacing of 1 column unit.
        nodesByRank[r].sort((a, b) => nodeMap.get(a).col - nodeMap.get(b).col);

        if (nodesByRank[r].length > 0) {
            const first = nodeMap.get(nodesByRank[r][0]);
            let prev = first.col;
            first.col = prev;
            for (let i = 1; i < nodesByRank[r].length; i++) {
                const current = nodeMap.get(nodesByRank[r][i]);
                const desired = current.col;
                const placed = Math.max(desired, prev + 1);
                current.col = placed;
                prev = placed;
            }
        }
    }

    // ----- convert (rank, col) to pixel coordinates -----

    layout = { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: 'tb', ...layout };
    const nodesep = layout.nodesep;

    // Reserve extra vertical space between ranks for edge labels.
    // Similar to dagre's edge-label spacing behavior, but simplified.
    // Compute max node width per column
    // First pass: assign initial coordinates based on rank and col
    for (const [v, node] of nodeMap) {
        node.x = node.col * nodesep;
        node.y = 0;
    }

    // Refine: center columns by accounting for actual node widths
    // Compute column positions respecting node widths
    const allCols = Array.from(nodeMap.values()).map((n) => n.col || 0);
    const minCol = Math.floor(Math.min(...allCols));
    const maxCol = Math.ceil(Math.max(...allCols));
    const colCount = maxCol - minCol + 1;
    const maxNodeWidthPerCol = new Array(colCount).fill(0);
    for (const node of nodeMap.values()) {
        const idx = Math.round(node.col - minCol);
        if (node.width > maxNodeWidthPerCol[idx]) {
            maxNodeWidthPerCol[idx] = node.width;
        }
    }

    // Build cumulative column x positions
    const colX = new Array(colCount);
    let cx = 0;
    for (let c = 0; c < colCount; c++) {
        colX[c] = cx + maxNodeWidthPerCol[c] / 2;
        cx += maxNodeWidthPerCol[c] + nodesep;
    }

    // Compute node Y with fixed edge clear-gap constraints.
    // unlabeled edge gap = 45, labeled edge gap = 60.
    const edgeLabeled = new Map();
    for (const edge of edges) {
        const labeled =
            (Number.isFinite(edge.width) && edge.width > 0) ||
            (Number.isFinite(edge.height) && edge.height > 0);
        edgeLabeled.set(edgeKey(edge.v, edge.w), labeled);
    }
    const edgeClearGap = (pred, succ) => {
        return edgeLabeled.get(edgeKey(pred, succ)) ? 60 : 45;
    };
    const yByNode = new Map();
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        if (node.inEdges.length === 0) {
            yByNode.set(v, node.height / 2);
            continue;
        }
        let y = node.height / 2;
        for (const pred of node.inEdges) {
            const predNode = nodeMap.get(pred);
            const predY = yByNode.get(pred);
            if (!predNode || !Number.isFinite(predY)) {
                continue;
            }
            const gap = edgeClearGap(pred, v);
            const candidate = predY + (predNode.height / 2) + gap + (node.height / 2);
            if (candidate > y) {
                y = candidate;
            }
        }
        yByNode.set(v, y);
    }

    const colToX = (col) => {
        const value = col - minCol;
        const left = Math.floor(value);
        const right = Math.ceil(value);
        if (left === right) {
            return colX[left];
        }
        const t = value - left;
        return colX[left] + (colX[right] - colX[left]) * t;
    };

    // Assign final pixel coordinates
    for (const node of nodeMap.values()) {
        node.x = colToX(node.col);
        node.y = yByNode.get(node.v) || (node.height / 2);
    }

    // ----- handle coordinate direction -----

    const rankDir = (layout.rankdir || 'tb').toLowerCase();
    debugLines.push(`[dagre-fast] rankdir=${rankDir} nodesep=${nodesep} gap(unlabeled)=45 gap(labeled)=60`);
    if (rankDir === 'lr' || rankDir === 'rl') {
        // Swap x and y for horizontal layout
        for (const [v, node] of nodeMap) {
            const tmp = node.x;
            node.x = node.y;
            node.y = tmp;
        }
    }
    if (rankDir === 'bt' || rankDir === 'rl') {
        // Reverse y direction
        let maxY = -Infinity;
        for (const [v, node] of nodeMap) {
            if (node.y > maxY) maxY = node.y;
        }
        for (const [v, node] of nodeMap) {
            node.y = maxY - node.y;
        }
    }

    // ----- build edge paths -----

    // Pre-compute input port positions for multi-input nodes.
    // If a node has k inputs, place ports at fractions 1/(k+1), 2/(k+1), ... k/(k+1)
    // across the node width, then map incoming edges left-to-right by source x.
    const inputPortX = new Map();
    const inputPortDebug = [];
    for (const target of nodeMap.values()) {
        if (target.inEdges.length <= 1) {
            continue;
        }
        const sortedPreds = target.inEdges.concat().sort((a, b) => {
            const ax = (nodeMap.get(a) && Number.isFinite(nodeMap.get(a).x)) ? nodeMap.get(a).x : 0;
            const bx = (nodeMap.get(b) && Number.isFinite(nodeMap.get(b).x)) ? nodeMap.get(b).x : 0;
            return ax - bx;
        });
        const k = sortedPreds.length;
        const left = target.x - (target.width / 2);
        const ports = [];
        for (let i = 0; i < k; i++) {
            const fraction = (i + 1) / (k + 1);
            const portX = left + target.width * fraction;
            inputPortX.set(edgeKey(sortedPreds[i], target.v), portX);
            ports.push(portX);
        }
        inputPortDebug.push({ target: target.v, width: target.width, left, ports });
    }

    // For each edge, create a smooth 4-point polyline that the renderer converts
    // to bezier segments. This improves visual quality over pure straight lines.
    for (const edge of edges) {
        const srcNode = nodeMap.get(edge.v);
        const tgtNode = nodeMap.get(edge.w);
        if (!srcNode || !tgtNode) continue;

        const srcCenter = { x: srcNode.x, y: srcNode.y };
        const tgtCenter = { x: tgtNode.x, y: tgtNode.y };
        const dy = tgtCenter.y - srcCenter.y;

        let p1;
        let p2;
        // For vertical flows, force incoming edges to approach target from top/bottom,
        // so multi-input edges connect on the node top edge instead of side edges.
        if (rankDir === 'tb' || rankDir === 'bt') {
            const direction = dy >= 0 ? 1 : -1;
            const verticalBend = Math.max(Math.abs(dy) * 0.45, 12) * direction;
            p1 = { x: srcCenter.x, y: srcCenter.y + verticalBend };

            // Keep the approach to target mostly vertical so incoming edges
            // intersect target on top/bottom edge instead of the side edge.
            const targetInDegree = tgtNode.inEdges.length;
            const targetApproachX = targetInDegree > 1 ?
                (inputPortX.get(edgeKey(edge.v, edge.w)) ?? tgtCenter.x) :
                (tgtCenter.x + (srcCenter.x - tgtCenter.x) * 0.2);
            const targetApproachY = direction > 0
                ? (tgtCenter.y - (tgtNode.height / 2))
                : (tgtCenter.y + (tgtNode.height / 2));
            p2 = { x: targetApproachX, y: targetApproachY };
        } else {
            const dx = tgtCenter.x - srcCenter.x;
            const bend = dx * 0.5;
            p1 = { x: srcCenter.x + bend, y: srcCenter.y };
            p2 = { x: tgtCenter.x - bend, y: tgtCenter.y };
        }

        edge.points = [
            { x: srcCenter.x, y: srcCenter.y },
            p1,
            p2,
            { x: tgtCenter.x, y: tgtCenter.y }
        ];

        // Edge label anchor (always finite to avoid NaN in renderer)
        edge.x = (srcCenter.x + tgtCenter.x) / 2;
        edge.y = (srcCenter.y + tgtCenter.y) / 2;
    }

    // Debug focused on multi-input nodes and Times212 family.
    const multiInputNodes = Array.from(nodeMap.values()).filter((node) => node.inEdges.length > 1);
    debugLines.push(`[dagre-fast] multi-input nodes=${multiInputNodes.length}`);
    for (const item of inputPortDebug.slice(0, 20)) {
        if (String(item.target).includes('Times212') || inputPortDebug.length <= 10) {
            debugLines.push(`[ports] target=${item.target} width=${item.width} left=${item.left} ports=${item.ports.join(',')}`);
        }
    }
    for (const node of multiInputNodes.slice(0, 50)) {
        const focus = String(node.v).includes('Times212') || String(node.v).includes('times212');
        if (focus || multiInputNodes.length <= 20) {
            debugLines.push(`[node] id=${node.v} indegree=${node.inEdges.length} rank=${node.rank} col=${node.col} x=${node.x} y=${node.y}`);
            for (const pred of node.inEdges) {
                const e = edges.find((item) => item.v === pred && item.w === node.v);
                if (e && Array.isArray(e.points) && e.points.length >= 4) {
                    const p1 = e.points[1];
                    const p2 = e.points[2];
                    debugLines.push(`[edge] ${pred}->${node.v} p1=(${p1.x},${p1.y}) p2=(${p2.x},${p2.y}) end=(${e.points[3].x},${e.points[3].y}) label=(${e.x},${e.y})`);
                } else {
                    debugLines.push(`[edge] ${pred}->${node.v} points=missing`);
                }
            }
        }
    }

    // Debug vertical clear gap between connected nodes.
    // clearGap = center distance on primary axis - half source size - half target size.
    const edgeGaps = [];
    for (const edge of edges) {
        const src = nodeMap.get(edge.v);
        const tgt = nodeMap.get(edge.w);
        if (!src || !tgt) {
            continue;
        }
        let clearGap = 0;
        if (rankDir === 'tb' || rankDir === 'bt') {
            clearGap = Math.abs(tgt.y - src.y) - (src.height / 2) - (tgt.height / 2);
        } else {
            clearGap = Math.abs(tgt.x - src.x) - (src.width / 2) - (tgt.width / 2);
        }
        edgeGaps.push({ edge: `${edge.v}->${edge.w}`, gap: clearGap });
    }
    if (edgeGaps.length > 0) {
        edgeGaps.sort((a, b) => a.gap - b.gap);
        const minGap = edgeGaps[0].gap;
        const maxGap = edgeGaps[edgeGaps.length - 1].gap;
        const avgGap = edgeGaps.reduce((sum, item) => sum + item.gap, 0) / edgeGaps.length;
        debugLines.push(`[gap] edges=${edgeGaps.length} min=${minGap.toFixed(2)} avg=${avgGap.toFixed(2)} max=${maxGap.toFixed(2)}`);
        for (const item of edgeGaps.slice(0, 20)) {
            debugLines.push(`[gap-edge] ${item.edge} gap=${item.gap.toFixed(2)}`);
        }
    }

    // ----- write results back to nodes/edges arrays -----

    for (const node of nodes) {
        const n = nodeMap.get(node.v);
        if (n) {
            node.x = n.x;
            node.y = n.y;
        } else {
            // Node not in any edge — assign default position
            node.x = node.x || 0;
            node.y = node.y || 0;
        }
    }

    // Ensure every edge has points
    for (const edge of edges) {
        if (!edge.points || !Array.isArray(edge.points) || edge.points.length < 2) {
            const srcNode = nodeMap.get(edge.v);
            const tgtNode = nodeMap.get(edge.w);
            const sx = srcNode ? srcNode.x : 0;
            const sy = srcNode ? srcNode.y : 0;
            const tx = tgtNode ? tgtNode.x : 0;
            const ty = tgtNode ? tgtNode.y : 0;
            edge.points = [
                { x: sx, y: sy },
                { x: sx, y: sy },
                { x: tx, y: ty },
                { x: tx, y: ty }
            ];
        }
        if (!Number.isFinite(edge.x) || !Number.isFinite(edge.y)) {
            const first = edge.points[0] || { x: 0, y: 0 };
            const last = edge.points[edge.points.length - 1] || first;
            edge.x = (first.x + last.x) / 2;
            edge.y = (first.y + last.y) / 2;
        }
    }

    // Compute bounding box
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
        const hw = (node.width || 0) / 2;
        const hh = (node.height || 0) / 2;
        minX = Math.min(minX, node.x - hw);
        minY = Math.min(minY, node.y - hh);
        maxX = Math.max(maxX, node.x + hw);
        maxY = Math.max(maxY, node.y + hh);
    }

    // Translate to origin
    if (isFinite(minX)) {
        for (const node of nodes) {
            node.x -= minX;
            node.y -= minY;
        }
        for (const edge of edges) {
            if (edge.points) {
                for (const p of edge.points) {
                    p.x -= minX;
                    p.y -= minY;
                }
            }
            if (Number.isFinite(edge.x)) {
                edge.x -= minX;
            }
            if (Number.isFinite(edge.y)) {
                edge.y -= minY;
            }
        }
        state.width = maxX - minX;
        state.height = maxY - minY;
    }

    state.log = debugLines.join('\n');
};

dagre.Graph = class {

    constructor(directed, compound) {
        this.directed = directed;
        this.compound = compound;
        this._defaultNodeLabelFn = () => {
            return undefined;
        };
        this.nodes = new Map();
        this.edges = new Map();
        if (this.compound) {
            this._parent = new Map();
            this._children = new Map();
            this._children.set('\x00', new Map());
        }
    }

    setDefaultNodeLabel(newDefault) {
        this._defaultNodeLabelFn = newDefault;
    }

    setNode(v, label) {
        const node = this.nodes.get(v);
        if (node) {
            if (label) {
                node.label = label;
            }
        } else {
            const node = { label: label ? label : this._defaultNodeLabelFn(v), in: [], out: [], predecessors: new Map(), successors: new Map(), v };
            this.nodes.set(v, node);
            if (this.compound) {
                this._parent.set(v, '\x00');
                this._children.set(v, new Map());
                this._children.get('\x00').set(v, true);
            }
        }
    }

    node(v) {
        return this.nodes.get(v);
    }

    hasNode(v) {
        return this.nodes.has(v);
    }

    removeNode(v) {
        const node = this.nodes.get(v);
        if (node) {
            if (this.compound) {
                this._children.get(this._parent.get(v)).delete(v);
                this._parent.delete(v);
                for (const child of this.children(v)) {
                    this.setParent(child);
                }
                this._children.delete(v);
            }
            for (const edge of node.in.concat()) {
                this.removeEdge(edge);
            }
            for (const edge of node.out.concat()) {
                this.removeEdge(edge);
            }
            this.nodes.delete(v);
        }
    }

    setParent(v, parent) {
        if (!this.compound) {
            throw new Error('Cannot set parent in a non-compound graph');
        }
        if (parent) {
            for (let ancestor = parent; ancestor !== undefined; ancestor = this.parent(ancestor)) {
                if (ancestor === v) {
                    throw new Error(`Setting ${parent} as parent of ${v} would create a cycle.`);
                }
            }
            this.setNode(parent);
        } else {
            parent = '\x00';
        }
        this._children.get(this._parent.get(v)).delete(v);
        this._parent.set(v, parent);
        this._children.get(parent).set(v, true);
    }

    parent(v) {
        if (this.compound) {
            const parent = this._parent.get(v);
            if (parent !== '\x00') {
                return parent;
            }
        }
        return null;
    }

    children(v) {
        if (this.compound) {
            return this._children.get(v === undefined ? '\x00' : v).keys();
        } else if (v === undefined) {
            return this.nodes.keys();
        } else if (this.hasNode(v)) {
            return [];
        }
        return null;
    }

    hasChildren(v) {
        if (this.compound) {
            return this._children.get(v === undefined ? '\x00' : v).size > 0;
        } else if (v === undefined) {
            return this.nodes.size > 0;
        }
        return false;
    }

    predecessors(v) {
        return this.nodes.get(v).predecessors;
    }

    successors(v) {
        return this.nodes.get(v).successors;
    }

    neighbors(v) {
        const n = this.nodes.get(v);
        const p = n.predecessors.keys();
        const s = n.successors.keys();
        const set = new Set();
        for (const k of p) {
            set.add(k);
        }
        for (const k of s) {
            set.add(k);
        }
        return set;
    }

    edge(v, w) {
        return this.edges.get(this._edgeKey(this.directed, v, w));
    }

    setEdge(v, w, label, name) {
        const key = this._edgeKey(this.directed, v, w, name);
        const edge = this.edges.get(key);
        if (edge) {
            edge.label = label;
        } else {
            if (!this.directed && v > w) {
                [v, w] = [w, v];
            }
            const edge = { label, v, w, name, key, vNode: null, wNode: null };
            this.edges.set(key, edge);
            this.setNode(v);
            this.setNode(w);
            const wNode = this.nodes.get(w);
            const vNode = this.nodes.get(v);
            edge.wNode = wNode;
            edge.vNode = vNode;
            const incrementOrInitEntry = (map, k) => {
                map.set(k, (map.get(k) ?? 0) + 1);
            };
            incrementOrInitEntry(wNode.predecessors, v);
            incrementOrInitEntry(vNode.successors, w);
            wNode.in.push(edge);
            vNode.out.push(edge);
        }
    }

    removeEdge(edge) {
        const key = edge.key;
        const v = edge.v;
        const w = edge.w;
        const wNode = edge.wNode;
        const vNode = edge.vNode;
        if (wNode.predecessors.has(v)) {
            const value = wNode.predecessors.get(v);
            if (value === 1) {
                wNode.predecessors.delete(v);
            } else {
                wNode.predecessors.set(v, value - 1);
            }
        }
        if (vNode.successors.has(w)) {
            const value = vNode.successors.get(w);
            if (value === 1) {
                vNode.successors.delete(w);
            } else {
                vNode.successors.set(w, value - 1);
            }
        }
        const idxIn = wNode.in.findIndex((e) => e.key === key);
        if (idxIn !== -1) {
            wNode.in.splice(idxIn, 1);
        }
        const idxOut = vNode.out.findIndex((e) => e.key === key);
        if (idxOut !== -1) {
            vNode.out.splice(idxOut, 1);
        }
        this.edges.delete(key);
    }

    _edgeKey(isDirected, v, w, name) {
        if (!isDirected && v > w) {
            return name ? `${w}:${v}:${name}` : `${w}:${v}:`;
        }
        return name ? `${v}:${w}:${name}` : `${v}:${w}:`;
    }

    toString() {
        return [
            '[nodes]', Array.from(this.nodes.values()).map((n) => JSON.stringify(n.label)).join('\n'),
            '[edges]', Array.from(this.edges.values()).map((e) => JSON.stringify(e.label)).join('\n'),
            '[parents]', JSON.stringify(this._parent, null, 2),
            '[children]', JSON.stringify(this._children, null, 2)
        ].join('\n');
    }
};

export const { layout, Graph } = dagre;
// dagre-fast: optimized layout algorithm
