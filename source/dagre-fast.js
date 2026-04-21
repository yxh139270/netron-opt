
const dagre = {};

// Dagre graph layout (fast variant)
// Simplified DFS-based layout: rank + column assigned in one pass, no ordering phase.

dagre.layout = (nodes, edges, layout, state) => {

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
            const hasSiblingIntoTarget = siblingsIntoTarget.length > 0;

            // Diamond fan-in: A->B, A->C, A->D, B->D, C->D
            // Do not let direct A->D participate as virtual projection.
            if (siblingsIntoTarget.length >= 2) {
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
        }
    }


    for (const [w, list] of proposals) {
        const node = nodeMap.get(w);
        if (!node || list.length === 0 || node.rank === 0) {
            continue;
        }
        const proposal = list.reduce((sum, value) => sum + value, 0) / list.length;
        if (node.inEdges.length <= 1) {
            node.col = proposal;
        } else {
            // Multi-input nodes keep predecessor-centering fully dominant.
            node.col = node.col;
        }
    }

    for (let r = 1; r <= maxRank; r++) {
        resolveRankCollisions(r);
    }

    // Pure triangular motif: A->B, A->C, B->C (and C has only A/B as predecessors).
    // Ignore direct A->C for placement and force A/B/C on the same column.
    const triBAnchorsByRank = new Map();
    const triCAnchorsByRank = new Map();
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
        if (a && Number.isFinite(a.col) && Number.isFinite(b.col) && Array.isArray(b.inEdges) && b.inEdges.includes(a.v)) {
            tCol = (2 * a.col) - b.col;
        } else if (a && Number.isFinite(a.col)) {
            tCol = a.col;
        } else if (Array.isArray(b.inEdges) && b.inEdges.length > 0) {
            const candidates = b.inEdges
                .map((v) => nodeMap.get(v))
                .filter((n) => !!n && Number.isFinite(n.col));
            if (candidates.length > 0) {
                tCol = candidates[0].col;
            }
        }
        if (!Number.isFinite(tCol) || !Number.isFinite(b.col)) {
            continue;
        }
        const desired = (tCol + b.col) / 2;
        const anchors = mulAnchorsByRank.get(c.rank) || new Map();
        anchors.set(c.v, desired);
        mulAnchorsByRank.set(c.rank, anchors);
    }
    for (const [rank, anchors] of mulAnchorsByRank) {
        enforceAnchoredColumns(rank, anchors);
    }

    // Diamond fan-in motif: A->B, A->C, A->D, B->D, C->D
    // Ignore direct A->D as a virtual anchor for D placement.
    // Place D at the midpoint of branch nodes B/C.
    const fanInAnchorsByRank = new Map();
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

    // ----- dagre-style edge routing -----

    // 计算每个 rank 的代表 y 值（取该 rank 所有节点 y 的中位数）
    const rankYValues = new Map();
    for (const node of nodeMap.values()) {
        const r = node.rank;
        if (r === undefined) continue;
        const list = rankYValues.get(r) || [];
        list.push(node.y);
        rankYValues.set(r, list);
    }
    const rankY = new Map();
    for (const [r, ys] of rankYValues) {
        ys.sort((a, b) => a - b);
        rankY.set(r, ys[Math.floor(ys.length / 2)]);
    }

    // 构建节点包围盒用于避障
    const nodeBoxes = Array.from(nodeMap.values()).map((node) => ({
        id: node.v,
        left: node.x - (node.width / 2),
        right: node.x + (node.width / 2),
        top: node.y - (node.height / 2),
        bottom: node.y + (node.height / 2)
    }));

    // 检测点是否在某个节点包围盒内（排除指定节点）
    const pointInBox = (px, py, box, margin = 8) => {
        return px >= box.left - margin && px <= box.right + margin &&
               py >= box.top - margin && py <= box.bottom + margin;
    };

    // 精确计算线段与矩形的交点（移植自 dagre.js assignNodeIntersects）
    const intersectRect = (rect, point) => {
        const x = rect.x;
        const y = rect.y;
        const dx = point.x - x;
        const dy = point.y - y;
        if (dx === 0 && dy === 0) {
            return { x, y };
        }
        let w = rect.width / 2;
        let h = rect.height / 2;
        if (Math.abs(dy) * w > Math.abs(dx) * h) {
            h = dy < 0 ? -h : h;
            return { x: x + (h * dx / dy), y: y + h };
        }
        w = dx < 0 ? -w : w;
        return { x: x + w, y: y + (w * dy / dx) };
    };

    // 处理自环边
    const selfEdges = [];
    const normalEdges = [];
    for (const edge of edges) {
        if (edge.v === edge.w) {
            selfEdges.push(edge);
        } else {
            normalEdges.push(edge);
        }
    }

    // 自环边路径（移植自 dagre.js positionSelfEdges）
    for (const edge of selfEdges) {
        const selfNode = nodeMap.get(edge.v);
        if (!selfNode) continue;
        const x = selfNode.x + selfNode.width / 2;
        const y = selfNode.y;
        const dx = selfNode.width * 0.6;
        const dy = selfNode.height / 2;
        edge.points = [
            { x: x + 2 * dx / 3, y: y - dy },
            { x: x + 5 * dx / 6, y: y - dy },
            { x: x + dx, y },
            { x: x + 5 * dx / 6, y: y + dy },
            { x: x + 2 * dx / 3, y: y + dy }
        ];
        edge.x = x + dx;
        edge.y = y;
    }

    // 普通边路径：为长边生成中间点，然后计算精确交点
    for (const edge of normalEdges) {
        const srcNode = nodeMap.get(edge.v);
        const tgtNode = nodeMap.get(edge.w);
        if (!srcNode || !tgtNode) continue;

        const srcRank = srcNode.rank;
        const tgtRank = tgtNode.rank;
        const rankSpan = tgtRank !== undefined && srcRank !== undefined ? Math.abs(tgtRank - srcRank) : 1;

        // 确定目标 x（考虑多输入端口）
        const targetInDegree = tgtNode.inEdges.length;
        const tgtX = targetInDegree > 1
            ? (inputPortX.get(edgeKey(edge.v, edge.w)) ?? tgtNode.x)
            : tgtNode.x;

        // 中间点列表（不含起止点）
        const midPoints = [];

        if (rankSpan > 1 && srcRank !== undefined && tgtRank !== undefined) {
            // 长边：在每个中间 rank 插入虚拟折点
            const minR = Math.min(srcRank, tgtRank);
            const maxR = Math.max(srcRank, tgtRank);
            const forward = tgtRank > srcRank;
            for (let r = minR + 1; r < maxR; r++) {
                const t = (r - srcRank) / (tgtRank - srcRank);
                const midX = srcNode.x + (tgtX - srcNode.x) * t;
                const midY = rankY.get(r);
                if (midY !== undefined) {
                    midPoints.push({ x: midX, y: midY, rank: r });
                }
            }
            if (!forward) {
                midPoints.reverse();
            }

            // 避障：检测中间点是否与节点重叠，如果重叠则水平偏移
            for (const mp of midPoints) {
                for (const box of nodeBoxes) {
                    if (box.id === edge.v || box.id === edge.w) continue;
                    if (pointInBox(mp.x, mp.y, box)) {
                        // 偏移到节点右侧或左侧，选择距离更近的一侧
                        const distLeft = mp.x - (box.left - 12);
                        const distRight = (box.right + 12) - mp.x;
                        if (distLeft < distRight) {
                            mp.x = box.left - 12;
                        } else {
                            mp.x = box.right + 12;
                        }
                    }
                }
            }
        }

        // 有标签的边：在中间放置标签锚点
        const hasLabel = (Number.isFinite(edge.width) && edge.width > 0) ||
                         (Number.isFinite(edge.height) && edge.height > 0);

        // 组装完整路径点
        const allPoints = midPoints.map((p) => ({ x: p.x, y: p.y }));

        // 计算精确的节点边界交点
        const srcRect = { x: srcNode.x, y: srcNode.y, width: srcNode.width, height: srcNode.height };
        const tgtRect = { x: tgtNode.x, y: tgtNode.y, width: tgtNode.width, height: tgtNode.height };

        // 确定第一个中间点（用于计算源节点交点方向）
        const firstMid = allPoints.length > 0 ? allPoints[0] : { x: tgtX, y: tgtNode.y };
        // 确定最后一个中间点（用于计算目标节点交点方向）
        const lastMid = allPoints.length > 0 ? allPoints[allPoints.length - 1] : { x: srcNode.x, y: srcNode.y };

        const srcIntersect = intersectRect(srcRect, firstMid);
        const tgtIntersect = intersectRect(tgtRect, lastMid);

        // curvePath 期望 points 至少 3 个点（首尾交点 + 至少一个中间点）
        if (allPoints.length === 0) {
            const midX = (srcIntersect.x + tgtIntersect.x) / 2;
            const midY = (srcIntersect.y + tgtIntersect.y) / 2;
            allPoints.push({ x: midX, y: midY });
        }
        edge.points = [srcIntersect, ...allPoints, tgtIntersect];

        // 边标签锚点
        if (hasLabel && midPoints.length > 0) {
            // 标签放在中间 rank 的折点处
            const labelIdx = Math.floor(midPoints.length / 2);
            edge.x = midPoints[labelIdx].x;
            edge.y = midPoints[labelIdx].y;
        } else {
            edge.x = (srcNode.x + tgtX) / 2;
            edge.y = (srcNode.y + tgtNode.y) / 2;
        }
    }

    void inputPortDebug;

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

    state.log = '';
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
