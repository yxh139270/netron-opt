
const dagre = {};

// Dagre graph layout (fast variant)
// Simplified DFS-based layout: rank + column assigned in one pass, no ordering phase.

dagre.layout = (nodes, edges, layout, state) => {

    if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[dagre-fast] invoked nodes=${nodes.length} edges=${edges.length}`);
    }

    const debugLines = [];
    debugLines.push('[dagre-fast] version=2026-04-15-v21');
    debugLines.push(`[dagre-fast] input nodes=${nodes.length} edges=${edges.length}`);

    // ----- helpers -----

    // ----- build adjacency structures from flat arrays -----

    // nodeMap: v -> { v, width, height, inEdges: [], outEdges: [] }
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.v, {
            v: node.v,
            name: node.name || '',
            title: node.title || '',
            tensor: node.tensor || '',
            identifier: node.identifier || '',
            type: node.type || '',
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

    const resolveRankCollisions = (rank) => {
        const list = nodesByRank[rank];
        if (!list || list.length === 0) {
            return;
        }
        list.sort((a, b) => nodeMap.get(a).col - nodeMap.get(b).col);
        const original = list.map((v) => nodeMap.get(v).col);
        const placed = original.slice();
        for (let i = 1; i < placed.length; i++) {
            placed[i] = Math.max(placed[i], placed[i - 1] + 1);
        }
        const mean = (arr) => arr.reduce((sum, value) => sum + value, 0) / arr.length;
        const shift = mean(original) - mean(placed);
        for (let i = 0; i < list.length; i++) {
            nodeMap.get(list[i]).col = placed[i] + shift;
        }
    };

    const enforceAnchoredColumns = (rank, anchors) => {
        const list = nodesByRank[rank];
        if (!list || list.length === 0 || !anchors || anchors.size === 0) {
            return;
        }
        list.sort((a, b) => nodeMap.get(a).col - nodeMap.get(b).col);
        const placed = list.map((v) => nodeMap.get(v).col);
        const indexByNode = new Map(list.map((v, i) => [v, i]));

        const orderedAnchors = Array.from(anchors.entries())
            .filter(([v]) => indexByNode.has(v))
            .sort((a, b) => a[1] - b[1]);

        for (const [v, target] of orderedAnchors) {
            const index = indexByNode.get(v);
            placed[index] = target;
            for (let j = index - 1; j >= 0; j--) {
                const maxAllowed = placed[j + 1] - 1;
                if (placed[j] > maxAllowed) {
                    placed[j] = maxAllowed;
                }
            }
            for (let j = index + 1; j < placed.length; j++) {
                const minAllowed = placed[j - 1] + 1;
                if (placed[j] < minAllowed) {
                    placed[j] = minAllowed;
                }
            }
        }

        for (let i = 0; i < list.length; i++) {
            nodeMap.get(list[i]).col = placed[i];
        }
    };

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
        resolveRankCollisions(r);
    }

    // Lantern-like successor spreading pass:
    // if a node has k projected successors on the next rank, place them around
    // the parent center. Long edges contribute a virtual projected successor
    // on rank+1 (so A->C can distribute with A->B when C is two ranks away).
    const proposals = new Map();
    const proposalReasons = new Map();
    const triangleMotifs = [];
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        const directSuccessors = node.outEdges.concat();
        const successorSet = new Set(directSuccessors);
        const projected = [];
        for (const w of directSuccessors) {
            const target = nodeMap.get(w);
            if (!target) {
                continue;
            }
            const siblingsIntoTarget = directSuccessors.filter((u) => u !== w && edgeMinlen.has(edgeKey(u, w)));
            const sibling = siblingsIntoTarget[0];
            const hasSiblingIntoTarget = sibling !== undefined;
            if (hasSiblingIntoTarget) {
                triangleMotifs.push({ a: v, b: sibling, c: w });
            }

            // Diamond fan-in: A->B, A->C, A->D, B->D, C->D
            // Do not let direct A->D participate as virtual projection.
            if (siblingsIntoTarget.length >= 2) {
                debugLines.push(`[motif-ignore] skip-direct ${v}->${w} siblings=${siblingsIntoTarget.join(',')}`);
                continue;
            }

            const span = Math.max(1, target.rank - node.rank);
            const targetCol = Number.isFinite(target.col) ? target.col : node.col;
            // For A->B, A->C, B->C-like motifs, treat A->C as a virtual
            // projected successor at rank+1, and let B/C decide C placement.
            if (span === 1 && !hasSiblingIntoTarget) {
                projected.push({ kind: 'real', w, targetCol, span });
            } else {
                projected.push({ kind: 'virtual', w, targetCol, span });
            }
        }
        projected.sort((a, b) => {
            const d = a.targetCol - b.targetCol;
            if (Math.abs(d) > 1e-6) {
                return d;
            }
            if (a.kind !== b.kind) {
                return a.kind === 'virtual' ? -1 : 1;
            }
            return String(a.w).localeCompare(String(b.w));
        });
        if (projected.length === 0) {
            continue;
        }
        const center = node.col;
        const middle = (projected.length - 1) / 2;
        const realCount = projected.filter((entry) => entry.kind === 'real').length;
        for (let i = 0; i < projected.length; i++) {
            const entry = projected[i];
            // If there is only one real successor, keep it on the parent line.
            // Do not let virtual (long-edge) projections push it sideways.
            const desired = realCount <= 1 ? center : (center + (i - middle));
            if (entry.kind !== 'real') {
                continue;
            }
            const w = entry.w;
            const list = proposals.get(w) || [];
            list.push(desired);
            proposals.set(w, list);
            const reasons = proposalReasons.get(w) || [];
            reasons.push(`from=${v} center=${center} desired=${desired} realCount=${realCount} kind=${entry.kind}`);
            proposalReasons.set(w, reasons);
        }
    }

    if (triangleMotifs.length > 0) {
        debugLines.push(`[motif] triangular-successor count=${triangleMotifs.length}`);
        for (const item of triangleMotifs.slice(0, 20)) {
            const a = nodeMap.get(item.a);
            const b = nodeMap.get(item.b);
            const c = nodeMap.get(item.c);
            debugLines.push(`[motif-item] ${item.a}->${item.c} with ${item.b}->${item.c}`);
            if (a && b && c) {
                debugLines.push(`[motif-pos] a(${item.a}) r=${a.rank} c=${a.col}; b(${item.b}) r=${b.rank} c=${b.col}; c(${item.c}) r=${c.rank} c=${c.col}`);
            }
        }
    }

    for (const [w, list] of proposals) {
        const node = nodeMap.get(w);
        if (!node || list.length === 0 || node.rank === 0) {
            continue;
        }
        const proposal = list.reduce((sum, value) => sum + value, 0) / list.length;
        const oldCol = node.col;
        if (node.inEdges.length <= 1) {
            node.col = proposal;
        } else {
            // Multi-input nodes keep predecessor-centering fully dominant.
            node.col = node.col;
        }
        const reasons = proposalReasons.get(w) || [];
        if (reasons.length > 0) {
            debugLines.push(`[proposal] node=${w} oldCol=${oldCol} newCol=${node.col} indegree=${node.inEdges.length} details=${reasons.join(' | ')}`);
        }
    }

    for (let r = 1; r <= maxRank; r++) {
        resolveRankCollisions(r);
    }

    // Pure triangular motif: A->B, A->C, B->C (and C has only A/B as predecessors).
    // Ignore direct A->C for placement and force A/B/C on the same column.
    const triBAnchorsByRank = new Map();
    const triCAnchorsByRank = new Map();
    const triMotifs = [];
    for (const c of nodeMap.values()) {
        if (!Array.isArray(c.inEdges) || c.inEdges.length !== 2) {
            continue;
        }
        const preds = c.inEdges.map((v) => nodeMap.get(v)).filter((n) => !!n);
        if (preds.length !== 2) {
            continue;
        }
        let a = null;
        let b = null;
        for (const left of preds) {
            for (const right of preds) {
                if (left.v === right.v) {
                    continue;
                }
                if (edgeMinlen.has(edgeKey(left.v, right.v))) {
                    a = left;
                    b = right;
                }
            }
        }
        if (!a || !b || !Number.isFinite(a.col)) {
            continue;
        }
        const bAnchors = triBAnchorsByRank.get(b.rank) || new Map();
        const bList = bAnchors.get(b.v) || [];
        bList.push(a.col);
        bAnchors.set(b.v, bList);
        triBAnchorsByRank.set(b.rank, bAnchors);

        const cAnchors = triCAnchorsByRank.get(c.rank) || new Map();
        const cList = cAnchors.get(c.v) || [];
        cList.push(a.col);
        cAnchors.set(c.v, cList);
        triCAnchorsByRank.set(c.rank, cAnchors);

        triMotifs.push({ a: a.v, b: b.v, c: c.v, desired: a.col });
    }
    if (triMotifs.length > 0) {
        debugLines.push(`[motif] triangle-straight count=${triMotifs.length}`);
        for (const item of triMotifs.slice(0, 30)) {
            debugLines.push(`[motif-tri] a=${item.a} b=${item.b} c=${item.c} desiredCol=${item.desired}`);
        }
    }
    const applyGroupedAnchors = (byRank) => {
        for (const [rank, grouped] of byRank) {
            const anchors = new Map();
            for (const [v, list] of grouped) {
                const avg = list.reduce((sum, value) => sum + value, 0) / list.length;
                anchors.set(v, avg);
            }
            enforceAnchoredColumns(rank, anchors);
        }
    };
    applyGroupedAnchors(triBAnchorsByRank);
    applyGroupedAnchors(triCAnchorsByRank);

    // Keep Anchor(T)->Sigmoid->Mul locally aligned.
    // For A->B, A->C, B->C motif, T is the virtual projection of A->C at B rank:
    // T.col = 2 * A.col - B.col, and desired Mul.col = avg(T.col, B.col).
    // This makes SiLU-like triplets less likely to be skewed by global spreading.
    const sigmoidLike = new Set(['sigmoid', 'hardsigmoid']);
    const mulAnchorsByRank = new Map();
    const mulTriplets = [];
    for (const c of nodeMap.values()) {
        if ((c.title || '').toLowerCase() !== 'mul' || c.inEdges.length !== 2) {
            continue;
        }
        const preds = c.inEdges.map((v) => nodeMap.get(v)).filter((n) => !!n);
        if (preds.length !== 2) {
            continue;
        }
        const b = preds.find((n) => sigmoidLike.has((n.title || '').toLowerCase()));
        if (!b) {
            continue;
        }
        // Prefer A where A->B and A->C (classic triangular shortcut motif).
        const a = preds.find((n) => n.v !== b.v) || null;
        let tCol = Number.NaN;
        let tDesc = '';
        if (a && Number.isFinite(a.col) && Number.isFinite(b.col) && Array.isArray(b.inEdges) && b.inEdges.includes(a.v)) {
            tCol = (2 * a.col) - b.col;
            tDesc = `virtual(${a.v}->${c.v}@r${b.rank})`;
        } else if (a && Number.isFinite(a.col)) {
            tCol = a.col;
            tDesc = `node(${a.v})`;
        } else if (Array.isArray(b.inEdges) && b.inEdges.length > 0) {
            const candidates = b.inEdges
                .map((v) => nodeMap.get(v))
                .filter((n) => !!n && Number.isFinite(n.col));
            if (candidates.length > 0) {
                tCol = candidates[0].col;
                tDesc = `node(${candidates[0].v})`;
            }
        }
        if (!Number.isFinite(tCol) || !Number.isFinite(b.col)) {
            continue;
        }
        const desired = (tCol + b.col) / 2;
        const anchors = mulAnchorsByRank.get(c.rank) || new Map();
        anchors.set(c.v, desired);
        mulAnchorsByRank.set(c.rank, anchors);
        mulTriplets.push({ t: tDesc, tCol, b: b.v, bCol: b.col, c: c.v, desired });
    }
    if (mulTriplets.length > 0) {
        debugLines.push(`[motif] anchor-sigmoid-mul count=${mulTriplets.length}`);
        for (const item of mulTriplets.slice(0, 30)) {
            debugLines.push(`[motif-asm] t=${item.t} tCol=${item.tCol} b=${item.b} bCol=${item.bCol} c=${item.c} desiredCol=${item.desired}`);
        }
    }
    for (const [rank, anchors] of mulAnchorsByRank) {
        enforceAnchoredColumns(rank, anchors);
    }

    // Diamond fan-in motif: A->B, A->C, A->D, B->D, C->D
    // Ignore direct A->D as a virtual anchor for D placement.
    // Place D at the midpoint of branch nodes B/C.
    const fanInAnchorsByRank = new Map();
    const fanInMotifs = [];
    for (const d of nodeMap.values()) {
        if (!Array.isArray(d.inEdges) || d.inEdges.length < 3) {
            continue;
        }
        const preds = d.inEdges.map((v) => nodeMap.get(v)).filter((n) => !!n);
        if (preds.length < 3) {
            continue;
        }

        let best = null;
        for (const a of preds) {
            const branches = preds
                .filter((p) => p.v !== a.v && edgeMinlen.has(edgeKey(a.v, p.v)) && Number.isFinite(p.col))
                .sort((x, y) => x.col - y.col);
            if (branches.length < 2) {
                continue;
            }
            const left = branches[0];
            const right = branches[branches.length - 1];
            const desired = (left.col + right.col) / 2;
            const candidate = {
                a: a.v,
                b: left.v,
                c: right.v,
                d: d.v,
                bCol: left.col,
                cCol: right.col,
                desired,
                width: branches.length
            };
            if (!best || candidate.width > best.width) {
                best = candidate;
            }
        }

        if (!best) {
            continue;
        }
        const anchors = fanInAnchorsByRank.get(d.rank) || new Map();
        anchors.set(d.v, best.desired);
        fanInAnchorsByRank.set(d.rank, anchors);
        fanInMotifs.push(best);
    }
    if (fanInMotifs.length > 0) {
        debugLines.push(`[motif] fanin-midpoint count=${fanInMotifs.length}`);
        for (const item of fanInMotifs.slice(0, 30)) {
            debugLines.push(`[motif-fanin] a=${item.a} b=${item.b} bCol=${item.bCol} c=${item.c} cCol=${item.cCol} d=${item.d} desiredCol=${item.desired}`);
        }
    }
    for (const [rank, anchors] of fanInAnchorsByRank) {
        enforceAnchoredColumns(rank, anchors);
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
            // Keep target approach outside the node so intersection prefers
            // top/bottom edge over side edge for multi-input links.
            const approachLift = 12;
            const targetApproachY = direction > 0
                ? (tgtCenter.y - (tgtNode.height / 2) - approachLift)
                : (tgtCenter.y + (tgtNode.height / 2) + approachLift);
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

    const allNodes = Array.from(nodeMap.values());

    // Full node position dump for debugging node-id/name mapping issues.
    if (nodes.length <= 500) {
        for (const n of allNodes) {
            const left = n.x - (n.width / 2);
            const right = n.x + (n.width / 2);
            debugLines.push(`[node-pos] id=${n.v} name=${n.name || ''} title=${n.title || ''} tensor=${n.tensor || ''} identifier=${n.identifier || ''} type=${n.type || ''} rank=${n.rank} col=${n.col} x=${n.x} w=${n.width} left=${left} right=${right}`);
        }

        // Column outlier dump: helps locate the most skewed local motifs.
        const outliers = allNodes
            .filter((n) => Number.isFinite(n.col) && Number.isFinite(n.rank) && n.rank >= 20)
            .sort((a, b) => Math.abs(b.col) - Math.abs(a.col))
            .slice(0, 10);
        for (const n of outliers) {
            debugLines.push(`[outlier] id=${n.v} name=${n.name || ''} title=${n.title || ''} tensor=${n.tensor || ''} identifier=${n.identifier || ''} type=${n.type || ''} rank=${n.rank} col=${n.col} x=${n.x}`);
            const preds = n.inEdges.slice(0, 8).join(',');
            const succs = n.outEdges.slice(0, 8).join(',');
            debugLines.push(`[outlier-links] id=${n.v} preds=${preds} succs=${succs}`);
        }
    }
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

    // Focused debug for YOLOv5s local pattern around cv1/conv/Conv.
    const focusId = '/model.2/m/m.0/cv1/conv/Conv';
    const focusCandidates = allNodes.filter((n) => {
        const id = String(n.v);
        const name = String(n.name || '');
        const title = String(n.title || '');
        const tensor = String(n.tensor || '');
        const identifier = String(n.identifier || '');
        const type = String(n.type || '');
        return id.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            id.includes('cv1/conv/Conv') ||
            id.includes('cv1/conv') ||
            id.includes('cv1') ||
            name.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            name.includes('cv1/conv/Conv') ||
            name.includes('cv1/conv') ||
            name.includes('cv1') ||
            title.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            title.includes('cv1/conv/Conv') ||
            title.includes('cv1/conv') ||
            title.includes('cv1') ||
            tensor.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            tensor.includes('cv1/conv/Conv') ||
            tensor.includes('cv1/conv') ||
            tensor.includes('cv1') ||
            identifier.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            identifier.includes('cv1/conv/Conv') ||
            identifier.includes('cv1/conv') ||
            identifier.includes('cv1') ||
            type.includes('/model.2/m/m.0/cv1/conv/Conv') ||
            type.includes('cv1/conv/Conv') ||
            type.includes('cv1/conv') ||
            type.includes('cv1');
    });
    debugLines.push(`[focus] candidates=${focusCandidates.length}`);
    if (focusCandidates.length > 0) {
        debugLines.push(`[focus] candidate-ids=${focusCandidates.slice(0, 20).map((n) => n.v).join(',')}`);
        debugLines.push(`[focus] candidate-names=${focusCandidates.slice(0, 20).map((n) => n.name || '').join(',')}`);
    }
    const resolvedFocusId = nodeMap.has(focusId) ? focusId : (focusCandidates.length > 0 ? focusCandidates[0].v : null);
    if (resolvedFocusId && nodeMap.has(resolvedFocusId)) {
        const focus = nodeMap.get(resolvedFocusId);
        debugLines.push(`[focus] node=${resolvedFocusId} name=${focus.name || ''} rank=${focus.rank} col=${focus.col} x=${focus.x} y=${focus.y}`);
        const succ = focus.outEdges.concat();
        debugLines.push(`[focus] successors=${succ.length} -> ${succ.join(',')}`);
        for (const w of succ) {
            const n = nodeMap.get(w);
            if (n) {
                debugLines.push(`[focus-succ] ${w} rank=${n.rank} col=${n.col} x=${n.x} y=${n.y}`);
            }
            const direct = edges.find((e) => e.v === resolvedFocusId && e.w === w);
            if (direct && Array.isArray(direct.points) && direct.points.length >= 4) {
                const p1 = direct.points[1];
                const p2 = direct.points[2];
                const end = direct.points[3];
                debugLines.push(`[focus-edge] ${resolvedFocusId}->${w} p1=(${p1.x},${p1.y}) p2=(${p2.x},${p2.y}) end=(${end.x},${end.y})`);
            }
        }
        for (let i = 0; i < succ.length; i++) {
            for (let j = 0; j < succ.length; j++) {
                if (i === j) {
                    continue;
                }
                const u = succ[i];
                const v = succ[j];
                const e = edges.find((item) => item.v === u && item.w === v);
                if (e && Array.isArray(e.points) && e.points.length >= 4) {
                    const p1 = e.points[1];
                    const p2 = e.points[2];
                    const end = e.points[3];
                    debugLines.push(`[focus-link] ${u}->${v} p1=(${p1.x},${p1.y}) p2=(${p2.x},${p2.y}) end=(${end.x},${end.y})`);
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
