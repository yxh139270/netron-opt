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
            name: node.name || "",
            title: node.title || "",
            tensor: node.tensor || "",
            identifier: node.identifier || "",
            type: node.type || "",
            width: node.width || 0,
            height: node.height || 0,
            inEdges: [],
            outEdges: [],
            rank: undefined,
            col: undefined,
            x: undefined,
            y: undefined,
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
        const hasLabel =
            (Number.isFinite(edge.width) && edge.width > 0) ||
            (Number.isFinite(edge.height) && edge.height > 0);
        edgeMinlen.set(edgeKey(edge.v, edge.w), hasLabel ? 2 : 1);
    }

    // Assign rank: for each node in topo order,
    // rank = max(predecessor ranks + effective minlen)
    // Sources get rank 0.
    console.log('[dagre-fast] === Step 1: Rank Assignment ===');
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        if (node.inEdges.length === 0) {
            node.rank = 0;
        } else {
            let maxPredRank = -1;
            for (const pred of node.inEdges) {
                const predNode = nodeMap.get(pred);
                const minlen = edgeMinlen.get(edgeKey(pred, v)) || 1;
                const candidate =
                    predNode.rank !== undefined ? predNode.rank + minlen : -1;
                if (candidate > maxPredRank) {
                    maxPredRank = candidate;
                }
            }
            node.rank = Math.max(0, maxPredRank);
        }
        console.log(`  rank[${node.title || node.v}] (v=${JSON.stringify(v)}) = ${node.rank}, inEdges=[${node.inEdges}], outEdges=[${node.outEdges}]`);
    }

    // ----- insert virtual (dummy) nodes for long edges (span >= 2) -----
    // For an edge A->C where C.rank - A.rank >= 2, insert virtual nodes at
    // each intermediate rank so the edge becomes A->V1->V2->...->C.
    // Virtual nodes participate in column assignment.
    // Their top-mid / bottom-mid points are later used as edge waypoints.

    console.log('[dagre-fast] === Step 2: Virtual Node Insertion ===');
    let virtualIdCounter = 0;
    const virtualNodeId = () => `\x00virt_${virtualIdCounter++}`;
    // Map: original edge key -> array of virtual node ids (in rank order)
    const edgeVirtualChain = new Map();

    // We need to process edges that span >= 2 ranks.
    // Use a snapshot of the current edges list (it may grow as we split).
    const originalEdges = edges.slice();
    for (const edge of originalEdges) {
        const srcNode = nodeMap.get(edge.v);
        const tgtNode = nodeMap.get(edge.w);
        if (!srcNode || !tgtNode) continue;
        const span = tgtNode.rank - srcNode.rank;
        if (span < 2) continue;

        // 对于纯链路单边（src 只有这一条出边，tgt 只有这一条入边），
        // 不插入虚拟节点。此类长跨度通常来自 edge label 的 minlen 拉伸，
        // 仅用于留标签空间，不需要作为真实中间占位节点参与布局。
        const isSingleChainEdge = srcNode.outEdges.length === 1 && tgtNode.inEdges.length === 1;
        if (isSingleChainEdge) {
            console.log(`  Skip long edge ${JSON.stringify(edge.v)}->${JSON.stringify(edge.w)} span=${span}: single-chain label edge`);
            continue;
        }

        // Determine which intermediate ranks need virtual nodes.
        // If any intermediate rank already has a real node sitting between
        // src and tgt in the topo order, skip virtual insertion for that rank
        // (the edge already routes through that rank naturally).
        const chain = []; // virtual node ids in ascending rank order
        const ek = edgeKey(edge.v, edge.w);
        const minlen = edgeMinlen.get(ek) || 1;

        for (let r = srcNode.rank + 1; r < tgtNode.rank; r++) {
            // Insert a virtual node at this intermediate rank
            const vid = virtualNodeId();
            const vNode = {
                v: vid,
                name: '',
                title: '',
                tensor: '',
                identifier: '',
                type: 'virtual',
                width: 0,
                height: 0,
                inEdges: [],
                outEdges: [],
                rank: r,
                col: undefined,
                x: undefined,
                y: undefined
            };
            nodeMap.set(vid, vNode);
            chain.push(vid);

            // Add to topoOrder at the correct position (after any node with rank < r)
            // We simply append; topoOrder is only used for iteration order, and
            // since rank is already assigned, the exact position doesn't matter.
            topoOrder.push(vid);
        }

        if (chain.length === 0) continue;

        edgeVirtualChain.set(ek, chain);

        // Update adjacency: build the chain A -> V1 -> V2 -> ... -> C
        // Remove original edge from adjacency lists
        const srcOutIdx = srcNode.outEdges.indexOf(edge.w);
        if (srcOutIdx !== -1) srcNode.outEdges.splice(srcOutIdx, 1);
        const tgtInIdx = tgtNode.inEdges.indexOf(edge.v);
        if (tgtInIdx !== -1) tgtNode.inEdges.splice(tgtInIdx, 1);

        // A -> V1
        srcNode.outEdges.push(chain[0]);
        nodeMap.get(chain[0]).inEdges.push(edge.v);

        // Vi -> Vi+1
        for (let i = 0; i < chain.length - 1; i++) {
            nodeMap.get(chain[i]).outEdges.push(chain[i + 1]);
            nodeMap.get(chain[i + 1]).inEdges.push(chain[i]);
        }

        // Vlast -> C
        nodeMap.get(chain[chain.length - 1]).outEdges.push(edge.w);
        tgtNode.inEdges.push(chain[chain.length - 1]);

        // Update edgeMinlen for the chain segments (all 1, except possibly the first
        // which inherits the original minlen - 1 for each virtual hop).
        // Simplified: all chain segments have minlen 1.
        edgeMinlen.set(edgeKey(edge.v, chain[0]), 1);
        for (let i = 0; i < chain.length - 1; i++) {
            edgeMinlen.set(edgeKey(chain[i], chain[i + 1]), 1);
        }
        edgeMinlen.set(edgeKey(chain[chain.length - 1], edge.w), 1);
        console.log(`  Long edge ${JSON.stringify(edge.v)}->${JSON.stringify(edge.w)} span=${span}: inserted ${chain.length} virtual nodes at ranks [${chain.map((vid, i) => srcNode.rank + 1 + i).join(',')}]`);
    }
    if (edgeVirtualChain.size === 0) {
        console.log('  No long edges found (all spans < 2)');
    }

    // Assign col: process nodes rank by rank
    // For rank 0 (sources): assign col 0, 1, 2, ... in source order
    // For rank > 0: col = average of predecessor cols, then resolve collisions

    // Group nodes by rank
    const maxRank = Math.max(
        ...Array.from(nodeMap.values()).map((n) => n.rank || 0),
    );
    const nodesByRank = new Array(maxRank + 1);
    for (let r = 0; r <= maxRank; r++) {
        nodesByRank[r] = [];
    }
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        nodesByRank[node.rank].push(v);
    }

    // For rank 0: assign sequential columns
    console.log('[dagre-fast] === Step 3: Column Assignment ===');
    console.log(`  maxRank=${maxRank}`);
    for (let r = 0; r <= maxRank; r++) {
        console.log(`  rank ${r}: [${nodesByRank[r].map(v => {
            const n = nodeMap.get(v);
            return `${n.title||n.type}[${JSON.stringify(v)}]`;
        }).join(', ')}]`);
    }
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
        const mean = (arr) =>
            arr.reduce((sum, value) => sum + value, 0) / arr.length;
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
        console.log(`  rank ${r} after assign+resolve: ${nodesByRank[r].map(v => {
            const n = nodeMap.get(v);
            return `${n.title||n.type}[${JSON.stringify(v)}].col=${n.col?.toFixed(2)}`;
        }).join(', ')}`);
    }

    // Lantern-like successor spreading pass:
    // if a node has k projected successors on the next rank, place them around
    // the parent center. Long edges contribute a virtual projected successor
    // on rank+1 (so A->C can distribute with A->B when C is two ranks away).
    const proposals = new Map();
    const virtualParticipantsByRank = new Map();
    for (const v of topoOrder) {
        const node = nodeMap.get(v);
        const directSuccessors = node.outEdges.concat();
        const projected = [];
        for (const w of directSuccessors) {
            const target = nodeMap.get(w);
            if (!target) {
                continue;
            }
            const siblingsIntoTarget = directSuccessors.filter(
                (u) => u !== w && edgeMinlen.has(edgeKey(u, w)),
            );
            const hasSiblingIntoTarget = siblingsIntoTarget.length > 0;

            // Diamond fan-in: A->B, A->C, A->D, B->D, C->D
            // Do not let direct A->D participate as virtual projection.
            if (siblingsIntoTarget.length >= 2) {
                continue;
            }

            const span = Math.max(1, target.rank - node.rank);
            const targetCol = Number.isFinite(target.col)
                ? target.col
                : node.col;
            // For A->B, A->C, B->C-like motifs, treat A->C as a virtual
            // projected successor at rank+1, and let B/C decide C placement.
            if (span === 1 && !hasSiblingIntoTarget) {
                projected.push({ kind: "real", w, targetCol, span });
            } else {
                projected.push({ kind: "virtual", w, targetCol, span });
            }
        }
        projected.sort((a, b) => {
            const d = a.targetCol - b.targetCol;
            if (Math.abs(d) > 1e-6) {
                return d;
            }
            if (a.kind !== b.kind) {
                return a.kind === "virtual" ? -1 : 1;
            }
            return String(a.w).localeCompare(String(b.w));
        });
        if (projected.length === 0) {
            continue;
        }
        const center = node.col;
        const middle = (projected.length - 1) / 2;
        const realCount = projected.filter(
            (entry) => entry.kind === "real",
        ).length;
        const hasVirtual = projected.some((entry) => entry.kind === "virtual");
        let longEdgeVirtualOrder = 0;
        for (let i = 0; i < projected.length; i++) {
            const entry = projected[i];
            // If there is only one real successor, keep it on the parent line.
            // Do not let virtual (long-edge) projections push it sideways.
            const desired =
                realCount <= 1 && !hasVirtual ? center : center + (i - middle);
            if (entry.kind !== "real") {
                if (entry.span >= 2) {
                    const rank = node.rank + 1;
                    const list = virtualParticipantsByRank.get(rank) || [];
                    longEdgeVirtualOrder += 1;
                    const direction = longEdgeVirtualOrder % 2 === 1 ? -1 : 1;
                    const distance = Math.ceil(longEdgeVirtualOrder / 2);
                    list.push(center + direction * distance);
                    virtualParticipantsByRank.set(rank, list);
                }
                continue;
            }
            const w = entry.w;
            const list = proposals.get(w) || [];
            list.push(desired);
            proposals.set(w, list);
        }
    }

    const resolveRankCollisionsWithVirtual = (rank, virtualCols) => {
        const list = nodesByRank[rank];
        if (!list || list.length === 0) {
            return;
        }
        const items = [];
        for (const v of list) {
            items.push({ type: "real", v, col: nodeMap.get(v).col });
        }
        for (const col of virtualCols || []) {
            items.push({ type: "virtual", col });
        }
        if (items.length <= 1) {
            return;
        }
        items.sort((a, b) => a.col - b.col);
        const original = items.map((item) => item.col);
        const placed = original.slice();
        for (let i = 1; i < placed.length; i++) {
            const prev = items[i - 1];
            const curr = items[i];
            const minGap = 1;
            placed[i] = Math.max(placed[i], placed[i - 1] + minGap);
        }
        const mean = (arr) =>
            arr.reduce((sum, value) => sum + value, 0) / arr.length;
        const shift = mean(original) - mean(placed);
        for (let i = 0; i < items.length; i++) {
            const value = placed[i] + shift;
            if (items[i].type === "real") {
                nodeMap.get(items[i].v).col = value;
            }
        }
    };

    for (const [w, list] of proposals) {
        const node = nodeMap.get(w);
        if (!node || list.length === 0 || node.rank === 0) {
            continue;
        }
        const proposal =
            list.reduce((sum, value) => sum + value, 0) / list.length;
        if (node.inEdges.length <= 1) {
            node.col = proposal;
        } else {
            // Multi-input nodes keep predecessor-centering fully dominant.
            node.col = node.col;
        }
    }

    for (let r = 1; r <= maxRank; r++) {
        resolveRankCollisionsWithVirtual(
            r,
            virtualParticipantsByRank.get(r) || [],
        );
    }

    console.log('[dagre-fast] === Step 4: Col After Lantern Spreading ===');
    for (let r = 0; r <= maxRank; r++) {
        console.log(`  rank ${r}: ${nodesByRank[r].map(v => {
            const n = nodeMap.get(v);
            return `${n.title||n.type}[${JSON.stringify(v)}].col=${n.col?.toFixed(2)}`;
        }).join(', ')}`);
    }

    const applyGroupedAnchors = (byRank) => {
        for (const [rank, grouped] of byRank) {
            const anchors = new Map();
            for (const [v, list] of grouped) {
                const avg =
                    list.reduce((sum, value) => sum + value, 0) / list.length;
                anchors.set(v, avg);
            }
            enforceAnchoredColumns(rank, anchors);
        }
    };

    // ----- convert (rank, col) to pixel coordinates -----

    layout = {
        ranksep: 50,
        edgesep: 20,
        nodesep: 50,
        rankdir: "tb",
        ...layout,
    };
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
    // 先计算每个节点的候选 y，再按 rank 统一层 y。
    // 这样虚拟节点会和同层真实节点保持同一 y，不会出现层内“细密台阶”。
    const rankCandidateY = new Array(maxRank + 1).fill(0);
    const rankMaxHeight = new Array(maxRank + 1).fill(0);

    for (let r = 0; r <= maxRank; r++) {
        const list = nodesByRank[r] || [];
        let candidateMax = 0;
        let maxHeight = 0;
        for (const v of list) {
            const node = nodeMap.get(v);
            if (!node) {
                continue;
            }
            maxHeight = Math.max(maxHeight, node.height || 0);
            if (node.inEdges.length === 0) {
                candidateMax = Math.max(candidateMax, (node.height || 0) / 2);
                continue;
            }
            let y = (node.height || 0) / 2;
            for (const pred of node.inEdges) {
                const predNode = nodeMap.get(pred);
                const predY = yByNode.get(pred);
                if (!predNode || !Number.isFinite(predY)) {
                    continue;
                }
                const gap = edgeClearGap(pred, v);
                const candidate =
                    predY + (predNode.height || 0) / 2 + gap + (node.height || 0) / 2;
                if (candidate > y) {
                    y = candidate;
                }
            }
            candidateMax = Math.max(candidateMax, y);
        }
        rankCandidateY[r] = candidateMax;
        rankMaxHeight[r] = maxHeight;

        let rankY = candidateMax;
        if (r > 0) {
            const prev = rankCandidateY[r - 1];
            const prevH = rankMaxHeight[r - 1] || 0;
            const currH = maxHeight || 0;
            const minGapY = prev + (prevH / 2) + 45 + (currH / 2);
            rankY = Math.max(rankY, minGapY);
        }
        rankCandidateY[r] = rankY;
        console.log(`  rankY[${r}] = ${rankY.toFixed(1)} (maxHeight=${maxHeight.toFixed(1)}, nodes=${list.length})`);

        for (const v of list) {
            yByNode.set(v, rankY);
        }
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
        node.y = yByNode.get(node.v) || node.height / 2;
    }

    console.log('[dagre-fast] === Step 5: Final Pixel Coordinates ===');
    for (const [v, node] of nodeMap) {
        console.log(`  ${node.title||node.type}[${JSON.stringify(v)}]: x=${node.x.toFixed(1)}, y=${node.y.toFixed(1)}, w=${node.width}, h=${node.height}`);
    }
    console.log(`  minCol=${minCol}, maxCol=${maxCol}, colX=[${colX.map(c=>c.toFixed(1)).join(',')}]`);

    // ----- handle coordinate direction -----

    const rankDir = (layout.rankdir || "tb").toLowerCase();
    if (rankDir === "lr" || rankDir === "rl") {
        // Swap x and y for horizontal layout
        for (const [v, node] of nodeMap) {
            const tmp = node.x;
            node.x = node.y;
            node.y = tmp;
        }
    }
    if (rankDir === "bt" || rankDir === "rl") {
        // Reverse y direction
        let maxY = -Infinity;
        for (const [v, node] of nodeMap) {
            if (node.y > maxY) maxY = node.y;
        }
        for (const [v, node] of nodeMap) {
            node.y = maxY - node.y;
        }
    }

    const rankBandTop = new Map();
    const rankBandBottom = new Map();
    for (let r = 0; r <= maxRank; r++) {
        const list = nodesByRank[r] || [];
        let top = Infinity;
        let bottom = -Infinity;
        for (const v of list) {
            const node = nodeMap.get(v);
            if (!node || node.type === 'virtual') {
                continue;
            }
            top = Math.min(top, node.y - (node.height || 0) / 2);
            bottom = Math.max(bottom, node.y + (node.height || 0) / 2);
        }
        if (!Number.isFinite(top) || !Number.isFinite(bottom)) {
            for (const v of list) {
                const node = nodeMap.get(v);
                if (!node) {
                    continue;
                }
                top = Math.min(top, node.y);
                bottom = Math.max(bottom, node.y);
            }
        }
        rankBandTop.set(r, top);
        rankBandBottom.set(r, bottom);
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
            const ax =
                nodeMap.get(a) && Number.isFinite(nodeMap.get(a).x)
                    ? nodeMap.get(a).x
                    : 0;
            const bx =
                nodeMap.get(b) && Number.isFinite(nodeMap.get(b).x)
                    ? nodeMap.get(b).x
                    : 0;
            return ax - bx;
        });
        const k = sortedPreds.length;
        const left = target.x - target.width / 2;
        const ports = [];
        for (let i = 0; i < k; i++) {
            const fraction = (i + 1) / (k + 1);
            const portX = left + target.width * fraction;
            inputPortX.set(edgeKey(sortedPreds[i], target.v), portX);
            ports.push(portX);
        }
        inputPortDebug.push({
            target: target.v,
            width: target.width,
            left,
            ports,
        });
    }

    // For each edge, create a smooth 4-point polyline that the renderer converts
    // to bezier segments. This improves visual quality over pure straight lines.
    const nodeBoxes = Array.from(nodeMap.values()).map((node) => ({
        id: node.v,
        left: node.x - node.width / 2,
        right: node.x + node.width / 2,
        top: node.y - node.height / 2,
        bottom: node.y + node.height / 2,
    }));
    const segmentIntersectsBox = (a, b, box, margin = 6) => {
        const left = box.left - margin;
        const right = box.right + margin;
        const top = box.top - margin;
        const bottom = box.bottom + margin;
        if (Math.abs(a.x - b.x) < 1e-6) {
            const x = a.x;
            if (x < left || x > right) {
                return false;
            }
            const minY = Math.min(a.y, b.y);
            const maxY = Math.max(a.y, b.y);
            return !(maxY < top || minY > bottom);
        }
        if (Math.abs(a.y - b.y) < 1e-6) {
            const y = a.y;
            if (y < top || y > bottom) {
                return false;
            }
            const minX = Math.min(a.x, b.x);
            const maxX = Math.max(a.x, b.x);
            return !(maxX < left || minX > right);
        }
        const minX = Math.min(a.x, b.x);
        const maxX = Math.max(a.x, b.x);
        const minY = Math.min(a.y, b.y);
        const maxY = Math.max(a.y, b.y);
        return !(maxX < left || minX > right || maxY < top || minY > bottom);
    };
    const pathObstacleScore = (points, sourceId, targetId) => {
        let score = 0;
        for (let i = 0; i < points.length - 1; i++) {
            const a = points[i];
            const b = points[i + 1];
            for (const box of nodeBoxes) {
                if (box.id === sourceId || box.id === targetId) {
                    continue;
                }
                if (segmentIntersectsBox(a, b, box)) {
                    score++;
                }
            }
        }
        return score;
    };
    const withLongEdgeAnchors = (points, srcNode, tgtNode, rankDir) => {
        if (
            !Array.isArray(points) ||
            points.length < 2 ||
            !srcNode ||
            !tgtNode
        ) {
            return points;
        }
        const span = Math.abs((tgtNode.rank || 0) - (srcNode.rank || 0));
        if (span < 2) {
            return points;
        }
        const t1 = 0.22;
        const t2 = 0.78;
        const first = points[0];
        const last = points[points.length - 1];
        const anchor1 = {
            x: first.x + (last.x - first.x) * t1,
            y: first.y + (last.y - first.y) * t1,
        };
        const anchor2 = {
            x: first.x + (last.x - first.x) * t2,
            y: first.y + (last.y - first.y) * t2,
        };
        const vertical = rankDir === "tb" || rankDir === "bt";
        const sign = vertical
            ? last.y >= first.y
                ? 1
                : -1
            : last.x >= first.x
              ? 1
              : -1;
        const body = points.slice(1, -1).concat([anchor1, anchor2]);
        body.sort((a, b) => {
            if (vertical) {
                return sign * (a.y - b.y);
            }
            return sign * (a.x - b.x);
        });
        return [first, ...body, last];
    };

    for (const edge of edges) {
        const srcNode = nodeMap.get(edge.v);
        const tgtNode = nodeMap.get(edge.w);
        if (!srcNode || !tgtNode) continue;

        const srcCenter = { x: srcNode.x, y: srcNode.y };
        const tgtCenter = { x: tgtNode.x, y: tgtNode.y };
        const dy = tgtCenter.y - srcCenter.y;

        // ----- use virtual nodes as edge waypoints -----
        // If this edge has a virtual chain (inserted during long-edge splitting),
        // build the path as src -> (bottom-mid of each virtual) -> tgt using
        // the virtual node coordinates.  The renderer will connect these points
        // with bezier curves, producing clean straight-ish routes for long edges.
        const ek = edgeKey(edge.v, edge.w);
        const vChain = edgeVirtualChain.get(ek);
        if (vChain && vChain.length > 0) {
            // Long edge with virtual chain: use compact arc-like path,
            // but keep two controls (front/back virtual) to avoid crossing nodes.
            const direction = dy >= 0 ? 1 : -1;
            const sourceExitY =
                direction > 0
                    ? srcCenter.y + srcNode.height / 2 + 8
                    : srcCenter.y - srcNode.height / 2 - 8;
            const approachLift = 12;
            const targetApproachY =
                direction > 0
                    ? tgtCenter.y - tgtNode.height / 2 - approachLift
                    : tgtCenter.y + tgtNode.height / 2 + approachLift;
            const virtualPoints = vChain
                .map((vid) => nodeMap.get(vid))
                .filter((n) => !!n && Number.isFinite(n.x) && Number.isFinite(n.y));
            const first = virtualPoints.length > 0 ? virtualPoints[0] : null;
            const last = virtualPoints.length > 0 ? virtualPoints[virtualPoints.length - 1] : null;
            const firstY = first && Number.isFinite(rankBandTop.get(first.rank)) ? rankBandTop.get(first.rank) : (first ? first.y : NaN);
            const lastY = last && Number.isFinite(rankBandBottom.get(last.rank)) ? rankBandBottom.get(last.rank) : (last ? last.y : NaN);
            const midX = (srcCenter.x + tgtCenter.x) / 2;
            const midY = (sourceExitY + targetApproachY) / 2;
            edge.points = first && last && first !== last
                ? [
                    { x: srcCenter.x, y: srcCenter.y },
                    { x: srcCenter.x, y: sourceExitY },
                    { x: first.x, y: firstY },
                    { x: first.x, y: firstY },
                    { x: last.x, y: lastY },
                    { x: last.x, y: lastY },
                    { x: tgtCenter.x, y: targetApproachY },
                    { x: tgtCenter.x, y: tgtCenter.y }
                ]
                : first
                ? [
                    { x: srcCenter.x, y: srcCenter.y },
                    { x: srcCenter.x, y: sourceExitY },
                    { x: first.x, y: firstY },
                    { x: tgtCenter.x, y: targetApproachY },
                    { x: tgtCenter.x, y: tgtCenter.y }
                ]
                : [
                    { x: srcCenter.x, y: srcCenter.y },
                    { x: srcCenter.x, y: sourceExitY },
                    { x: midX, y: midY },
                    { x: tgtCenter.x, y: targetApproachY },
                    { x: tgtCenter.x, y: tgtCenter.y }
                ];
            edge.x = (srcCenter.x + tgtCenter.x) / 2;
            edge.y = (srcCenter.y + tgtCenter.y) / 2;
            continue; // skip the normal Manhattan routing for this edge
        }

        let p1;
        let p2;
        // For vertical flows, force incoming edges to approach target from top/bottom,
        // so multi-input edges connect on the node top edge instead of side edges.
        if (rankDir === "tb" || rankDir === "bt") {
            const direction = dy >= 0 ? 1 : -1;
            const sourceExitY =
                direction > 0
                    ? srcCenter.y + srcNode.height / 2 + 8
                    : srcCenter.y - srcNode.height / 2 - 8;

            // Keep the approach to target mostly vertical so incoming edges
            // intersect target on top/bottom edge instead of the side edge.
            const targetInDegree = tgtNode.inEdges.length;
            const targetApproachX =
                targetInDegree > 1
                    ? (inputPortX.get(edgeKey(edge.v, edge.w)) ?? tgtCenter.x)
                    : tgtCenter.x + (srcCenter.x - tgtCenter.x) * 0.2;
            // Keep target approach outside the node so intersection prefers
            // top/bottom edge over side edge for multi-input links.
            const approachLift = 12;
            const targetApproachY =
                direction > 0
                    ? tgtCenter.y - tgtNode.height / 2 - approachLift
                    : tgtCenter.y + tgtNode.height / 2 + approachLift;

            // Keep vertical routing compact: one broad arc (few control points)
            // instead of multi-lane Manhattan turns.
            const midX = (srcCenter.x + targetApproachX) / 2;
            const midY = (sourceExitY + targetApproachY) / 2;
            edge.points = [
                { x: srcCenter.x, y: srcCenter.y },
                { x: srcCenter.x, y: sourceExitY },
                { x: midX, y: midY },
                { x: targetApproachX, y: targetApproachY },
                { x: tgtCenter.x, y: tgtCenter.y }
            ];
        } else {
            const dx = tgtCenter.x - srcCenter.x;
            const bend = dx * 0.5;
            p1 = { x: srcCenter.x + bend, y: srcCenter.y };
            p2 = { x: tgtCenter.x - bend, y: tgtCenter.y };
            edge.points = withLongEdgeAnchors(
                [
                    { x: srcCenter.x, y: srcCenter.y },
                    p1,
                    p2,
                    { x: tgtCenter.x, y: tgtCenter.y },
                ],
                srcNode,
                tgtNode,
                rankDir,
            );
        }

        // Edge label anchor (always finite to avoid NaN in renderer)
        edge.x = (srcCenter.x + tgtCenter.x) / 2;
        edge.y = (srcCenter.y + tgtCenter.y) / 2;
    }

    void inputPortDebug;

    console.log('[dagre-fast] === Step 6: Edge Paths ===');
    for (const edge of edges) {
        const srcNode = nodeMap.get(edge.v);
        const tgtNode = nodeMap.get(edge.w);
        if (!srcNode || !tgtNode) continue;
        const ek = edgeKey(edge.v, edge.w);
        const vChain = edgeVirtualChain.get(ek);
        console.log(`  Edge ${srcNode.title||srcNode.v}[${JSON.stringify(edge.v)}] -> ${tgtNode.title||tgtNode.v}[${JSON.stringify(edge.w)}]: ${edge.points?.length || 0} pts${vChain ? ` (virtual chain: ${vChain.length})` : ''}`);
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
        if (
            !edge.points ||
            !Array.isArray(edge.points) ||
            edge.points.length < 2
        ) {
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
                { x: tx, y: ty },
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

    console.log('[dagre-fast] === Step 7: Final Output (nodes array) ===');
    for (const node of nodes) {
        console.log(`  ${node.title||node.v}[${JSON.stringify(node.v)}]: x=${node.x?.toFixed(1)}, y=${node.y?.toFixed(1)}`);
    }
    console.log(`  Canvas: ${state.width?.toFixed(0)} x ${state.height?.toFixed(0)}`);
    console.log('[dagre-fast] === Done ===\n');

    state.log = "";
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
            this._children.set("\x00", new Map());
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
            const node = {
                label: label ? label : this._defaultNodeLabelFn(v),
                in: [],
                out: [],
                predecessors: new Map(),
                successors: new Map(),
                v,
            };
            this.nodes.set(v, node);
            if (this.compound) {
                this._parent.set(v, "\x00");
                this._children.set(v, new Map());
                this._children.get("\x00").set(v, true);
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
            throw new Error("Cannot set parent in a non-compound graph");
        }
        if (parent) {
            for (
                let ancestor = parent;
                ancestor !== undefined;
                ancestor = this.parent(ancestor)
            ) {
                if (ancestor === v) {
                    throw new Error(
                        `Setting ${parent} as parent of ${v} would create a cycle.`,
                    );
                }
            }
            this.setNode(parent);
        } else {
            parent = "\x00";
        }
        this._children.get(this._parent.get(v)).delete(v);
        this._parent.set(v, parent);
        this._children.get(parent).set(v, true);
    }

    parent(v) {
        if (this.compound) {
            const parent = this._parent.get(v);
            if (parent !== "\x00") {
                return parent;
            }
        }
        return null;
    }

    children(v) {
        if (this.compound) {
            return this._children.get(v === undefined ? "\x00" : v).keys();
        } else if (v === undefined) {
            return this.nodes.keys();
        } else if (this.hasNode(v)) {
            return [];
        }
        return null;
    }

    hasChildren(v) {
        if (this.compound) {
            return this._children.get(v === undefined ? "\x00" : v).size > 0;
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
            "[nodes]",
            Array.from(this.nodes.values())
                .map((n) => JSON.stringify(n.label))
                .join("\n"),
            "[edges]",
            Array.from(this.edges.values())
                .map((e) => JSON.stringify(e.label))
                .join("\n"),
            "[parents]",
            JSON.stringify(this._parent, null, 2),
            "[children]",
            JSON.stringify(this._children, null, 2),
        ].join("\n");
    }
};

export const { layout, Graph } = dagre;
// dagre-fast: optimized layout algorithm
