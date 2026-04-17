const mycelium = {};

mycelium.Graph = class {

    constructor(compound) {
        this._compound = compound;
        this._nodes = new Map();
        this._edges = new Map();
        this._focusable = new Map();
        this._focused = null;
        this._children = new Map();
        this._children.set('\x00', new Map());
        this._parent = new Map();
        this._updateScheduled = false;
    }

    setNode(node) {
        const key = node.name;
        const value = this._nodes.get(key);
        if (value) {
            value.label = node;
        } else {
            this._nodes.set(key, { v: key, label: node });
            if (this._compound) {
                this._parent.set(key, '\x00');
                this._children.set(key, new Map());
                this._children.get('\x00').set(key, true);
            }
        }
    }

    setEdge(edge) {
        if (!this._nodes.has(edge.v)) {
            throw new Error(`Invalid edge '${JSON.stringify(edge.v)}'.`);
        }
        if (!this._nodes.has(edge.w)) {
            throw new Error(`Invalid edge '${JSON.stringify(edge.w)}'.`);
        }
        const key = `${edge.v}:${edge.w}`;
        if (!this._edges.has(key)) {
            this._edges.set(key, { v: edge.v, w: edge.w, label: edge });
        }
    }

    setParent(node, parent) {
        if (!this._compound) {
            throw new Error('Cannot set parent in a non-compound graph');
        }
        parent = String(parent);
        for (let ancestor = parent; ancestor; ancestor = this.parent(ancestor)) {
            if (ancestor === node) {
                throw new Error(`Setting ${parent} as parent of ${node} would create a cycle`);
            }
        }
        this._children.get(this._parent.get(node)).delete(node);
        this._parent.set(node, parent);
        this._children.get(parent).set(node, true);
        return this;
    }

    get nodes() {
        return this._nodes;
    }

    hasNode(key) {
        return this._nodes.has(key);
    }

    node(key) {
        return this._nodes.get(key);
    }

    edge(v, w) {
        return this._edges.get(`${v}:${w}`);
    }

    get edges() {
        return this._edges;
    }

    parent(key) {
        if (this._compound) {
            const parent = this._parent.get(key);
            if (parent !== '\x00') {
                return parent;
            }
        }
        return null;
    }

    children(key) {
        key = key === undefined ? '\x00' : key;
        if (this._compound) {
            const children = this._children.get(key);
            if (children) {
                return Array.from(children.keys());
            }
        } else if (key === '\x00') {
            return this.nodes.keys();
        } else if (this.hasNode(key)) {
            return [];
        }
        return null;
    }

    async measure() {
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this.children(key).length === 0) {
                const node = entry.label;
                await node.measure();
            }
        }
    }

    setViewport(viewport) {
        this._viewport = viewport || null;
    }

    _rectIntersects(a, b) {
        return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
    }

    _nodeBounds(node) {
        // 用布局分配的尺寸（如果有），因为那是节点在图中的实际占位
        const width = Number.isFinite(node._layoutWidth) ? node._layoutWidth : (Number.isFinite(node.width) ? node.width : 0);
        const height = Number.isFinite(node._layoutHeight) ? node._layoutHeight : (Number.isFinite(node.height) ? node.height : 0);
        const x = Number.isFinite(node.x) ? node.x : 0;
        const y = Number.isFinite(node.y) ? node.y : 0;
        return {
            left: x - width / 2,
            top: y - height / 2,
            right: x + width / 2,
            bottom: y + height / 2
        };
    }

    _edgeVisible(edge, viewport) {
        if (!Array.isArray(edge.points) || edge.points.length === 0) {
            return true;
        }
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of edge.points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }
        if (!isFinite(minX) || !isFinite(minY) || !isFinite(maxX) || !isFinite(maxY)) {
            return true;
        }
        return this._rectIntersects({ left: minX, top: minY, right: maxX, bottom: maxY }, viewport);
    }

    _mount(element) {
        if (!element || element.parentNode || !element._virtualParent) {
            return;
        }
        element._virtualParent.appendChild(element);
    }

    _unmount(element) {
        if (!element || !element.parentNode) {
            return;
        }
        element._virtualParent = element.parentNode;
        element.parentNode.removeChild(element);
    }

    _ensureEdgeBuilt(edge) {
        const label = edge.label;
        if (!label || label.element) {
            return;
        }
        label.build(this._document, this._edgePathGroup, this._edgePathHitTestGroup, this._edgeLabelGroup);
        if (label.labelElement && typeof label.labelElement.getBBox === 'function') {
            const box = label.labelElement.getBBox();
            if (Number.isFinite(box.width) && Number.isFinite(box.height)) {
                label.width = box.width;
                label.height = box.height;
            }
        }
        if (label.hitTest) {
            this._focusable.set(label.hitTest, label);
        }
    }

    _ensureClusterBuilt(node) {
        if (!node || node.element) {
            return;
        }
        const document = this._document;
        const rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        if (node.rx) {
            rectangle.setAttribute('rx', node.rx);
        }
        if (node.ry) {
            rectangle.setAttribute('ry', node.ry);
        }
        const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        element.setAttribute('class', 'cluster');
        element.appendChild(rectangle);
        node.rectangle = rectangle;
        node.element = element;
        this._clusterGroup.appendChild(element);
    }

    _ensureNodeBuilt(node) {
        if (!node || node.element) {
            return;
        }
        node.build(this._document, this._nodeGroup);
        if (this._lazyLeafNodes) {
            this._refineVisibleNode(node);
        }
    }

    _scheduleUpdate() {
        if (this._updateScheduled) {
            return;
        }
        this._updateScheduled = true;
        const run = () => {
            this._updateScheduled = false;
            this.update();
            if (typeof this.updateTunnels === 'function') {
                this.updateTunnels();
            }
        };
        const view = this._document && this._document.defaultView;
        if (view && typeof view.requestAnimationFrame === 'function') {
            view.requestAnimationFrame(run);
        } else {
            setTimeout(run, 0);
        }
    }

    _refineVisibleNode(node) {
        if (!node || node._refined || node._refining || typeof node.measure !== 'function' || typeof node.layout !== 'function') {
            return;
        }
        node._refining = true;
        Promise.resolve().then(async () => {
            try {
                const view = this._document && this._document.defaultView;
                if (view && typeof view.requestAnimationFrame === 'function') {
                    await new Promise((resolve) => view.requestAnimationFrame(resolve));
                }
                node._lazyMeasure = false;
                await node.measure();
                await node.layout();
                node._refined = Number.isFinite(node.width) && node.width > 0 && Number.isFinite(node.height) && node.height > 0;
                if (node._refined) {
                    node._layoutWidth = node.width;
                    node._layoutHeight = node.height;
                }
            } catch {
                node._refined = false;
                const view = this._document && this._document.defaultView;
                if (view && view.console && view.console.warn) {
                    view.console.warn('[lazy-refine] visible node refine failed', {
                        id: node.id,
                        name: node.name,
                        width: node.width,
                        height: node.height
                    });
                }
            } finally {
                node._refining = false;
                this._scheduleUpdate();
            }
        });
    }

    async refineViewport(limit) {
        const viewport = this._viewport;
        if (!viewport) {
            return { enabled: true, attempts: 0, refined: 0, failures: 0, reason: 'no-viewport' };
        }
        limit = Number.isFinite(limit) ? limit : 120;
        const document = this._document;
        if (document && document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }
        let count = 0;
        let refined = 0;
        let failures = 0;
        for (const nodeId of this.nodes.keys()) {
            if (count >= limit) {
                break;
            }
            if (this.children(nodeId).length !== 0) {
                continue;
            }
            const node = this.node(nodeId).label;
            if (node._refined) {
                continue;
            }
            const bounds = this._nodeBounds(node);
            if (!this._rectIntersects(bounds, viewport)) {
                continue;
            }
            this._ensureNodeBuilt(node);
            this._mount(node.element);
            try {
                node._lazyMeasure = false;
                await node.measure();
                await node.layout();
                node._refined = Number.isFinite(node.width) && node.width > 0 && Number.isFinite(node.height) && node.height > 0;
                if (node._refined) {
                    refined++;
                }
            } catch {
                node._refined = false;
                failures++;
            }
            count++;
        }
        if (failures > 0) {
            const view = this._document && this._document.defaultView;
            if (view && view.console && view.console.warn) {
                view.console.warn('[lazy-refine] viewport refine completed with failures', {
                    attempts: count,
                    failures
                });
            }
        }
        return { enabled: true, attempts: count, refined, failures };
    }

    build(document, origin, options) {
        origin = origin || document.getElementById('origin');
        options = options || {};
        this._lazyLeafNodes = !!options.lazyLeafNodes;
        const createGroup = (name) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            element.setAttribute('id', name);
            element.setAttribute('class', name);
            return element;
        };
        const clusterGroup = createGroup('clusters');
        const edgePathGroup = createGroup('edge-paths');
        const edgePathHitTestGroup = createGroup('edge-paths-hit-test');
        const edgeLabelGroup = createGroup('edge-labels');
        const nodeGroup = createGroup('nodes');
        this._clusterGroup = clusterGroup;
        this._nodeGroup = nodeGroup;
        this._edgePathGroup = edgePathGroup;
        this._edgePathHitTestGroup = edgePathHitTestGroup;
        this._edgeLabelGroup = edgeLabelGroup;
        const edgePathGroupDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        edgePathGroup.appendChild(edgePathGroupDefs);
        const marker = (id) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            element.setAttribute('id', id);
            element.setAttribute('viewBox', '0 0 10 10');
            element.setAttribute('refX', 9);
            element.setAttribute('refY', 5);
            element.setAttribute('markerUnits', 'strokeWidth');
            element.setAttribute('markerWidth', 8);
            element.setAttribute('markerHeight', 6);
            element.setAttribute('orient', 'auto');
            const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 L 4 5 z');
            markerPath.style.setProperty('stroke-width', 1);
            element.appendChild(markerPath);
            return element;
        };
        edgePathHitTestGroup.addEventListener('pointerover', (e) => {
            if (this._focused) {
                this._focused.blur();
                this._focused = null;
            }
            const edge = this._focusable.get(e.target);
            if (edge && edge.focus) {
                edge.focus();
                this._focused = edge;
                e.stopPropagation();
            }
        });
        edgePathHitTestGroup.addEventListener('pointerleave', (e) => {
            if (this._focused) {
                this._focused.blur();
                this._focused = null;
                e.stopPropagation();
            }
        });
        edgePathHitTestGroup.addEventListener('click', (e) => {
            const edge = this._focusable.get(e.target);
            if (edge && edge.activate) {
                edge.activate();
                e.stopPropagation();
            }
        });
        edgePathGroupDefs.appendChild(marker('arrowhead'));
        edgePathGroupDefs.appendChild(marker('arrowhead-select'));
        edgePathGroupDefs.appendChild(marker('arrowhead-hover'));
        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            if (this.children(nodeId).length === 0) {
                if (!this._lazyLeafNodes) {
                    node.build(document, nodeGroup);
                }
            }
        }
        this._focusable.clear();
        this._focused = null;
        for (const edge of this.edges.values()) {
            const label = edge.label;
            if (label && label.label) {
                const text = String(label.label);
                label.width = Math.min(240, Math.max(16, text.length * 7));
                label.height = 14;
            }
        }
        const tunnelGroup = createGroup('tunnel-edges');
        origin.appendChild(clusterGroup);
        origin.appendChild(edgePathGroup);
        origin.appendChild(edgePathHitTestGroup);
        origin.appendChild(edgeLabelGroup);
        origin.appendChild(nodeGroup);
        origin.appendChild(tunnelGroup);
        this._tunnelGroup = tunnelGroup;
        this._document = document;
    }

    _estimateNodeSize(label) {
        const text = label && (label.name || label.identifier || (label.type && label.type.name)) ?
            (label.name || label.identifier || label.type.name) : '';
        const textWidth = Math.min(460, Math.max(120, 40 + String(text).length * 7));

        const modelNode = label && label.value ? label.value : null;
        let constCount = 0;
        let nonConstInputCount = 0;
        let outputCount = 0;
        if (modelNode) {
            if (Array.isArray(modelNode.inputs)) {
                for (const argument of modelNode.inputs) {
                    const values = argument && Array.isArray(argument.value) ? argument.value : [];
                    for (const value of values) {
                        if (!value) {
                            continue;
                        }
                        if (value.initializer) {
                            constCount++;
                        } else {
                            nonConstInputCount++;
                        }
                    }
                }
            }
            if (Array.isArray(modelNode.outputs)) {
                for (const argument of modelNode.outputs) {
                    const values = argument && Array.isArray(argument.value) ? argument.value : [];
                    outputCount += values.length;
                }
            }
        }

        const hasBlocks = label && Array.isArray(label.blocks) && label.blocks.length > 0;
        const blockCount = hasBlocks ? label.blocks.length : 1;

        // Height model: title/header + rows. Rows include folded constants, regular
        // inputs, and outputs to avoid under-estimating lazy nodes.
        const rowCount = Math.max(1, constCount + nonConstInputCount + outputCount);
        const estimatedHeight = Math.max(44, 26 + blockCount * 14 + rowCount * 16);
        return {
            width: textWidth,
            height: estimatedHeight
        };
    }

    async layout(worker, options) {
        const estimateOnly = options && options.estimateOnly;
        const debugNodeTitle = (label) => {
            if (!label) {
                return '';
            }
            const modelNode = label.value || null;
            const modelName = modelNode && typeof modelNode.name === 'string' ? modelNode.name : '';
            const modelIdentifier = modelNode && typeof modelNode.identifier === 'string' ? modelNode.identifier : '';
            const modelType = modelNode && modelNode.type && typeof modelNode.type.name === 'string' ? modelNode.type.name : '';
            if (this.options && this.options.names && (modelName || modelIdentifier)) {
                return modelName || modelIdentifier;
            }
            if (modelType) {
                const parts = modelType.split('.');
                return parts.length > 0 ? parts[parts.length - 1] : modelType;
            }
            return label.name || label.identifier || '';
        };
        const debugTensorHint = (label) => {
            const modelNode = label && label.value ? label.value : null;
            if (!modelNode || !Array.isArray(modelNode.outputs)) {
                return '';
            }
            for (const output of modelNode.outputs) {
                if (!output || !Array.isArray(output.value)) {
                    continue;
                }
                for (const value of output.value) {
                    if (value && typeof value.name === 'string' && value.name !== '') {
                        return value.name;
                    }
                }
            }
            return '';
        };
        let nodes = [];
        for (const node of this.nodes.values()) {
            node.label._lazyMeasure = !!estimateOnly;
            if (estimateOnly) {
                node.label._refined = false;
            } else if (!this._lazyLeafNodes) {
                node.label._refined = true;
            }
            if (estimateOnly && node.label && typeof node.label.estimate === 'function') {
                node.label.estimate();
            }
            const size = estimateOnly ? this._estimateNodeSize(node.label) : null;
            if (size) {
                if (!Number.isFinite(node.label.width) || node.label.width <= 0) {
                    node.label.width = size.width;
                }
                if (!Number.isFinite(node.label.height) || node.label.height <= 0) {
                    node.label.height = size.height;
                }
            }
            nodes.push({
                v: node.v,
                name: node.label && (node.label.name || node.label.identifier || ''),
                title: debugNodeTitle(node.label),
                tensor: debugTensorHint(node.label),
                identifier: node.label && (node.label.identifier || ''),
                type: node.label && node.label.type && node.label.type.name ? node.label.type.name : '',
                width: node.label.width || 0,
                height: node.label.height || 0,
                parent: this.parent(node.v)
            });
        }
        let edges = [];
        for (const edge of this.edges.values()) {
            edges.push({
                v: edge.v,
                w: edge.w,
                minlen: edge.label.minlen || 1,
                weight: edge.label.weight || 1,
                width: edge.label.width || 0,
                height: edge.label.height || 0,
                labeloffset: edge.label.labeloffset || 10,
                labelpos: edge.label.labelpos || 'r'
            });
        }
        const layout = {};
        layout.nodesep = 20;
        layout.ranksep = 20;
        const direction = this.options.direction;
        const rotate = edges.length === 0 ? direction === 'vertical' : direction !== 'vertical';
        if (rotate) {
            layout.rankdir = 'LR';
        }
        if (edges.length === 0) {
            nodes = nodes.reverse();
        }
        if (nodes.length > 3000) {
            layout.ranker = 'longest-path';
        }
        const state = {};
        const applyWasmLayoutResult = (result) => {
            if (!result || typeof result !== 'object') {
                throw new Error('Invalid dagre-order-rs result.');
            }
            if (result.error) {
                const code = result.error.code || 'layout_error';
                const message = result.error.message || 'unknown';
                throw new Error(`dagre-order-rs ${code}: ${message}`);
            }
            const resultNodes = Array.isArray(result.nodes) ? result.nodes : [];
            const resultEdges = Array.isArray(result.edges) ? result.edges : [];
            if (resultNodes.length < nodes.length) {
                throw new Error(`dagre-order-rs returned ${resultNodes.length} nodes for ${nodes.length}.`);
            }
            if (resultEdges.length < edges.length) {
                throw new Error(`dagre-order-rs returned ${resultEdges.length} edges for ${edges.length}.`);
            }
            const nodeMap = new Map();
            for (const node of resultNodes) {
                if (node && typeof node.id === 'string') {
                    nodeMap.set(node.id, node);
                }
            }
            for (const node of nodes) {
                const mapped = nodeMap.get(node.v);
                if (!mapped) {
                    throw new Error(`dagre-order-rs missing node '${node.v}'.`);
                }
                if (Number.isFinite(mapped.x)) {
                    node.x = mapped.x;
                }
                if (Number.isFinite(mapped.y)) {
                    node.y = mapped.y;
                }
                if (Number.isFinite(mapped.width)) {
                    node.width = mapped.width;
                }
                if (Number.isFinite(mapped.height)) {
                    node.height = mapped.height;
                }
            }
            const edgeBuckets = new Map();
            for (const edge of resultEdges) {
                if (edge && typeof edge.v === 'string' && typeof edge.w === 'string') {
                    const key = JSON.stringify([edge.v, edge.w]);
                    if (!edgeBuckets.has(key)) {
                        edgeBuckets.set(key, []);
                    }
                    edgeBuckets.get(key).push(edge);
                }
            }
            for (const edge of edges) {
                const key = JSON.stringify([edge.v, edge.w]);
                const bucket = edgeBuckets.get(key);
                const mapped = bucket && bucket.length > 0 ? bucket.shift() : null;
                if (!mapped) {
                    throw new Error(`dagre-order-rs missing edge '${edge.v}' -> '${edge.w}'.`);
                }
                if (Array.isArray(mapped.points)) {
                    edge.points = mapped.points;
                }
                if (Number.isFinite(mapped.x)) {
                    edge.x = mapped.x;
                }
                if (Number.isFinite(mapped.y)) {
                    edge.y = mapped.y;
                }
                if (Number.isFinite(mapped.width)) {
                    edge.width = mapped.width;
                }
                if (Number.isFinite(mapped.height)) {
                    edge.height = mapped.height;
                }
            }
            const meta = result.meta && typeof result.meta === 'object' ? result.meta : null;
            if (meta && meta.stage_ms && typeof meta.stage_ms === 'object') {
                try {
                    state.log = JSON.stringify(meta.stage_ms);
                } catch {
                    // ignore stage logging failures
                }
            }
        };
        const orderEngine = String((this.options && this.options.orderEngine) || layout.orderEngine || 'js').toLowerCase();
        if (worker) {
            const message = await worker.request({ type: 'dagre.layout', nodes, edges, layout, state }, 2500, 'This large graph layout might take a very long time to complete.');
            if (message.type === 'cancel' || message.type === 'terminate') {
                return message.type;
            }
            nodes = message.nodes;
            edges = message.edges;
            state.log = message.state.log;
        } else if (orderEngine === 'rust-proto') {
            try {
                const dagreOrderRs = await import('./dagre-order-rs.js');
                const result = await dagreOrderRs.layout(nodes, edges, layout, state);
                applyWasmLayoutResult(result);
            } catch (error) {
                if (globalThis.console && typeof globalThis.console.warn === 'function') {
                    globalThis.console.warn(`[dagre-order-rs] fallback to js: ${error && error.message ? error.message : error}`);
                }
                const dagre = await import('./dagre-order.js');
                dagre.layout(nodes, edges, layout, state);
            }
        } else {
            const dagre = await import('./dagre-order.js');
            dagre.layout(nodes, edges, layout, state);
        }
        state.log = '';
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const node of nodes) {
            const label = this.node(node.v).label;
            label.x = node.x;
            label.y = node.y;
            // 保存布局分配的尺寸，精炼后真实尺寸可能更小
            label._layoutWidth = node.width || 0;
            label._layoutHeight = node.height || 0;
            if (this.children(node.v).length) {
                label.width = node.width;
                label.height = node.height;
            }
            const hw = (node.width || 0) / 2;
            const hh = (node.height || 0) / 2;
            minX = Math.min(minX, node.x - hw);
            minY = Math.min(minY, node.y - hh);
            maxX = Math.max(maxX, node.x + hw);
            maxY = Math.max(maxY, node.y + hh);
        }
        for (const edge of edges) {
            const label = this.edge(edge.v, edge.w).label;
            label.points = edge.points;
            if ('x' in edge) {
                label.x = edge.x;
                label.y = edge.y;
            }
            if (label.points) {
                for (const point of label.points) {
                    minX = Math.min(minX, point.x);
                    minY = Math.min(minY, point.y);
                    maxX = Math.max(maxX, point.x);
                    maxY = Math.max(maxY, point.y);
                }
            }
            if (label.x !== undefined && label.width && label.height) {
                const hw = label.width / 2;
                const hh = label.height / 2;
                minX = Math.min(minX, label.x - hw);
                minY = Math.min(minY, label.y - hh);
                maxX = Math.max(maxX, label.x + hw);
                maxY = Math.max(maxY, label.y + hh);
            }
        }
        if (isFinite(minX)) {
            this.width = maxX - minX;
            this.height = maxY - minY;
            this.originX = minX;
            this.originY = minY;
        }
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this.children(key).length === 0) {
                const node = entry.label;
                await node.layout();
            }
        }
        return '';
    }

    update() {
        const viewport = this._viewport;
        for (const nodeId of this.nodes.keys()) {
            if (this.children(nodeId).length === 0) {
                const entry = this.node(nodeId);
                const node = entry.label;
                let visible = true;
                if (viewport) {
                    const bounds = this._nodeBounds(node);
                    visible = this._rectIntersects(bounds, viewport);
                }
                if (visible) {
                    this._ensureNodeBuilt(node);
                    if (this._lazyLeafNodes) {
                        this._refineVisibleNode(node);
                    }
                    this._mount(node.element);
                    if (this._lazyLeafNodes && !node._refined) {
                        node.element.style.opacity = '0';
                    } else {
                        node.update();
                    }
                } else {
                    this._unmount(node.element);
                }
            } else {
                const entry = this.node(nodeId);
                const node = entry.label;
                let visible = true;
                if (viewport) {
                    const bounds = this._nodeBounds(node);
                    visible = this._rectIntersects(bounds, viewport);
                }
                if (visible) {
                    this._ensureClusterBuilt(node);
                    this._mount(node.element);
                    node.element.setAttribute('transform', `translate(${node.x},${node.y})`);
                    node.rectangle.setAttribute('x', -node.width / 2);
                    node.rectangle.setAttribute('y', -node.height / 2);
                    node.rectangle.setAttribute('width', node.width);
                    node.rectangle.setAttribute('height', node.height);
                } else {
                    this._unmount(node.element);
                }
            }
        }
        for (const edge of this.edges.values()) {
            const label = edge.label;
            let visible = true;
            if (viewport) {
                visible = this._edgeVisible(label, viewport);
            }
            if (visible) {
                this._ensureEdgeBuilt(edge);
                this._mount(label.element);
                this._mount(label.hitTest);
                this._mount(label.labelElement);
                label.update();
            } else {
                this._unmount(label.element);
                this._unmount(label.hitTest);
                this._unmount(label.labelElement);
            }
        }
    }
};

mycelium.Node = class {

    constructor() {
        this.blocks = [];
    }

    header() {
        const block = new mycelium.Node.Header();
        this.blocks.push(block);
        return block;
    }

    canvas() {
        const block = new mycelium.Node.Canvas();
        this.blocks.push(block);
        return block;
    }

    list() {
        const block = new mycelium.ArgumentList();
        this.blocks.push(block);
        return block;
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        this.element.setAttribute('class', this.class ? `node ${this.class}` : 'node');
        this.element.style.opacity = 0;
        parent.appendChild(this.element);
        this.border = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.border.setAttribute('class', 'node node-border');
        for (let i = 0; i < this.blocks.length; i++) {
            const block = this.blocks[i];
            block.first = i === 0;
            block.last = i === this.blocks.length - 1;
            block.build(document, this.element);
        }
        this.element.appendChild(this.border);
    }

    async measure() {
        this.height = 0;
        for (const block of this.blocks) {
            block._lazyContent = !!this._lazyMeasure;
            await block.measure();
            this.height += block.height;
        }
        this.width = Math.max(...this.blocks.map((block) => block.width));
        for (const block of this.blocks) {
            block.width = this.width;
        }
    }

    async layout() {
        let y = 0;
        for (const block of this.blocks) {
            block.x = 0;
            block.y = y;
            block.width = this.width;
            await block.layout();
            y += block.height;
        }
    }

    estimate() {
        let width = 0;
        let height = 0;
        for (const block of this.blocks) {
            if (this._lazyMeasure) {
                block._lazyContent = true;
            }
            if (typeof block.estimate === 'function') {
                block.estimate();
            }
            if (!Number.isFinite(block.width) || block.width <= 0) {
                block.width = 120;
            }
            if (!Number.isFinite(block.height) || block.height <= 0) {
                block.height = 24;
            }
            width = Math.max(width, block.width);
            height += block.height;
        }
        this.width = Math.max(120, width);
        this.height = Math.max(44, height);
        for (const block of this.blocks) {
            block.width = this.width;
        }
    }

    update() {
        const isFiniteSize = (value) => Number.isFinite(value) && value >= 0;
        if (!isFiniteSize(this.width) || !isFiniteSize(this.height) || !Number.isFinite(this.x) || !Number.isFinite(this.y)) {
            if (!this._invalidLayoutLogged) {
                this._invalidLayoutLogged = true;
                const view = this.element && this.element.ownerDocument && this.element.ownerDocument.defaultView;
                if (view && view.console && view.console.warn) {
                    view.console.warn('[node-layout] invalid node geometry', {
                        id: this.id,
                        name: this.name,
                        x: this.x,
                        y: this.y,
                        width: this.width,
                        height: this.height
                    });
                }
            }
            return;
        }
        this.element.setAttribute('transform', `translate(${this.x - (this.width / 2)},${this.y - (this.height / 2)})`);
        this.border.setAttribute('d', mycelium.Node.roundedRect(0, 0, this.width, this.height, true, true, true, true));
        for (const block of this.blocks) {
            block.update();
        }
        this.element.style.removeProperty('opacity');
    }

    select() {
        if (this.element) {
            this.element.classList.add('select');
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element) {
            this.element.classList.remove('select');
        }
    }

    static roundedRect(x, y, width, height, r1, r2, r3, r4) {
        const radius = 5;
        r1 = r1 ? radius : 0;
        r2 = r2 ? radius : 0;
        r3 = r3 ? radius : 0;
        r4 = r4 ? radius : 0;
        return `M${x + r1},${y}h${width - r1 - r2}a${r2},${r2} 0 0 1 ${r2},${r2}v${height - r2 - r3}a${r3},${r3} 0 0 1 ${-r3},${r3}h${r3 + r4 - width}a${r4},${r4} 0 0 1 ${-r4},${-r4}v${-height + r4 + r1}a${r1},${r1} 0 0 1 ${r1},${-r1}z`;
    }
};

mycelium.Node.Header = class {

    constructor() {
        this._entries = [];
    }

    add(id, classes) {
        const entry = new mycelium.Node.Header.Entry(id, classes);
        this._entries.push(entry);
        return entry;
    }

    build(document, parent) {
        this._document = document;
        for (const entry of this._entries) {
            entry.build(document, parent);
        }
        if (!this.first) {
            this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            parent.appendChild(this.line);
        }
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            if (i !== 0) {
                entry.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                parent.appendChild(entry.line);
            }
        }
    }

    measure() {
        this.width = 0;
        this.height = 0;
        for (const entry of this._entries) {
            entry.measure();
            this.height = Math.max(this.height, entry.height);
            this.width += entry.width;
        }
    }

    estimate() {
        this.width = 0;
        this.height = 0;
        for (const entry of this._entries) {
            if (typeof entry.estimate === 'function') {
                entry.estimate();
            }
            this.height = Math.max(this.height, entry.height || 0);
            this.width += entry.width || 0;
        }
        if (!Number.isFinite(this.height) || this.height <= 0) {
            this.height = 22;
        }
        if (!Number.isFinite(this.width) || this.width <= 0) {
            this.width = 120;
        }
    }

    layout() {
        let x = this.width;
        for (let i = this._entries.length - 1; i >= 0; i--) {
            const entry = this._entries[i];
            if (i > 0) {
                x -= entry.width;
                entry.x = x;
            } else {
                entry.x = 0;
                entry.width = x;
            }
        }
    }

    update() {
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            entry.element.setAttribute('transform', `translate(${entry.x},${this.y})`);
            const r1 = i === 0 && this.first;
            const r2 = i === this._entries.length - 1 && this.first;
            const r3 = i === this._entries.length - 1 && this.last;
            const r4 = i === 0 && this.last;
            entry.path.setAttribute('d', mycelium.Node.roundedRect(0, 0, entry.width, entry.height, r1, r2, r3, r4));
            entry.text.setAttribute('x', entry.tx || 6);
            entry.text.setAttribute('y', entry.ty);
        }
        if (this.line) {
            this.line.setAttribute('class', 'node');
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', this.width);
            this.line.setAttribute('y1', this.y);
            this.line.setAttribute('y2', this.y);
        }
    }
};

mycelium.Node.Header.Entry = class {

    constructor(id, classes) {
        this.id = id;
        this.classes = classes;
        this._events = {};
    }

    on(event, callback) {
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        parent.appendChild(this.element);
        this.path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        this.element.appendChild(this.path);
        this.element.appendChild(this.text);
        const classList = ['node-item'];
        if (this.classes) {
            classList.push(...this.classes);
        }
        this.element.setAttribute('class', classList.join(' '));
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        if (this._events.click) {
            this.element.addEventListener('click', (e) => {
                e.stopPropagation();
                this.emit('click');
            });
        }
        if (this.tooltip) {
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = this.tooltip;
            this.element.appendChild(title);
        }
        this.text.textContent = this.content || '\u00A0';
    }

    measure() {
        const yPadding = 4;
        const xPadding = this.padding || 7;
        const boundingBox = this.text.getBBox();
        if ((!Number.isFinite(boundingBox.width) || boundingBox.width <= 0) &&
            (!Number.isFinite(boundingBox.height) || boundingBox.height <= 0)) {
            this.estimate();
            return;
        }
        this.width = boundingBox.width + xPadding + xPadding;
        this.height = boundingBox.height + yPadding + yPadding;
        this.tx = xPadding;
        let offsetY = Number.isFinite(boundingBox.y) ? boundingBox.y : 0;
        if (offsetY >= 0 && Number.isFinite(boundingBox.height) && boundingBox.height > 0) {
            offsetY = -(boundingBox.height - 2);
        }
        this.ty = yPadding - offsetY;
    }

    estimate() {
        const yPadding = 4;
        const xPadding = this.padding || 7;
        const text = this.content || '\u00A0';
        const textWidth = String(text).length * 7;
        const textHeight = 14;
        this.width = textWidth + xPadding + xPadding;
        this.height = textHeight + yPadding + yPadding;
        this.tx = xPadding;
        this.ty = yPadding + textHeight - 2;
    }

    layout() {
    }
};

mycelium.Node.Canvas = class {

    constructor() {
        this.width = 0;
        this.height = 80;
    }

    build(/* document, parent */) {
    }

    update(/* parent, top, width, first, last */) {
    }
};

mycelium.Edge = class {

    constructor(from, to) {
        this.from = from;
        this.to = to;
    }

    build(document, edgePathGroupElement, edgePathHitTestGroupElement, edgeLabelGroupElement) {
        if (this._tunnel) {
            return;
        }
        const createElement = (name) => {
            return document.createElementNS('http://www.w3.org/2000/svg', name);
        };
        this.element = createElement('path');
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        this.element.setAttribute('class', this.class ? `edge-path ${this.class}` : 'edge-path');
        edgePathGroupElement.appendChild(this.element);
        this.hitTest = createElement('path');
        edgePathHitTestGroupElement.appendChild(this.hitTest);
        if (this.label) {
            const tspan = createElement('tspan');
            tspan.setAttribute('xml:space', 'preserve');
            tspan.setAttribute('dy', '1em');
            tspan.setAttribute('x', '1');
            tspan.appendChild(document.createTextNode(this.label));
            this.labelElement = createElement('text');
            this.labelElement.appendChild(tspan);
            this.labelElement.style.opacity = 0;
            this.labelElement.setAttribute('class', 'edge-label');
            if (this.id) {
                this.labelElement.setAttribute('id', `edge-label-${this.id}`);
            }
            edgeLabelGroupElement.appendChild(this.labelElement);
        }
    }

    update() {
        if (this._tunnel) {
            return;
        }
        const intersectRect = (node, point) => {
            const x = node.x;
            const y = node.y;
            const dx = point.x - x;
            const dy = point.y - y;
            let h = node.height / 2;
            let w = node.width / 2;
            if (Math.abs(dy) * w > Math.abs(dx) * h) {
                if (dy < 0) {
                    h = -h;
                }
                return { x: x + (dy === 0 ? 0 : h * dx / dy), y: y + h };
            }
            if (dx < 0) {
                w = -w;
            }
            return { x: x + w, y: y + (dx === 0 ? 0 : w * dy / dx) };
        };
        const curvePath = (edge, tail, head) => {
            const points = edge.points.slice(1, edge.points.length - 1);
            points.unshift(intersectRect(tail, points[0]));
            points.push(intersectRect(head, points[points.length - 1]));
            return new mycelium.Edge.Curve(points).path.data;
        };
        const edgePath = curvePath(this, this.from, this.to);
        this.element.setAttribute('d', edgePath);
        this.hitTest.setAttribute('d', edgePath);
        if (this.labelElement) {
            const width = Number.isFinite(this.width) ? this.width : 0;
            const height = Number.isFinite(this.height) ? this.height : 0;
            const x = Number.isFinite(this.x) ? this.x : 0;
            const y = Number.isFinite(this.y) ? this.y : 0;
            this.labelElement.setAttribute('transform', `translate(${x - (width / 2)},${y - (height / 2)})`);
            this.labelElement.style.opacity = 1;
        }
    }

    select() {
        if (this.element) {
            if (!this.element.classList.contains('select')) {
                const path = this.element;
                path.classList.add('select');
                if (path.parentNode) {
                    this.element = path.cloneNode(true);
                    path.parentNode.replaceChild(this.element, path);
                }
            }
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element && this.element.classList.contains('select')) {
            const path = this.element;
            path.classList.remove('select');
            if (path.parentNode) {
                this.element = path.cloneNode(true);
                path.parentNode.replaceChild(this.element, path);
            }
        }
    }
};

mycelium.Edge.Curve = class {

    constructor(points) {
        this._path = new mycelium.Edge.Path();
        this._x0 = NaN;
        this._x1 = NaN;
        this._y0 = NaN;
        this._y1 = NaN;
        this._state = 0;
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            this.point(point.x, point.y);
            if (i === points.length - 1) {
                switch (this._state) {
                    case 3:
                        this.curve(this._x1, this._y1);
                        this._path.lineTo(this._x1, this._y1);
                        break;
                    case 2:
                        this._path.lineTo(this._x1, this._y1);
                        break;
                    default:
                        break;
                }
                if (this._line || (this._line !== 0 && this._point === 1)) {
                    this._path.closePath();
                }
                this._line = 1 - this._line;
            }
        }
    }

    get path() {
        return this._path;
    }

    point(x, y) {
        x = Number(x);
        y = Number(y);
        switch (this._state) {
            case 0:
                this._state = 1;
                if (this._line) {
                    this._path.lineTo(x, y);
                } else {
                    this._path.moveTo(x, y);
                }
                break;
            case 1:
                this._state = 2;
                break;
            case 2:
                this._state = 3;
                this._path.lineTo((5 * this._x0 + this._x1) / 6, (5 * this._y0 + this._y1) / 6);
                this.curve(x, y);
                break;
            default:
                this.curve(x, y);
                break;
        }
        this._x0 = this._x1;
        this._x1 = x;
        this._y0 = this._y1;
        this._y1 = y;
    }

    curve(x, y) {
        this._path.bezierCurveTo(
            (2 * this._x0 + this._x1) / 3,
            (2 * this._y0 + this._y1) / 3,
            (this._x0 + 2 * this._x1) / 3,
            (this._y0 + 2 * this._y1) / 3,
            (this._x0 + 4 * this._x1 + x) / 6,
            (this._y0 + 4 * this._y1 + y) / 6
        );
    }
};

mycelium.Edge.Path = class {

    constructor() {
        this._x0 = null;
        this._y0 = null;
        this._x1 = null;
        this._y1 = null;
        this._segments = [];
        this._data = '';
        this._dirty = false;
    }

    moveTo(x, y) {
        this._x0 = x;
        this._x1 = x;
        this._y0 = y;
        this._y1 = y;
        this._segments.push(`M${x},${y}`);
        this._dirty = true;
    }

    lineTo(x, y) {
        this._x1 = x;
        this._y1 = y;
        this._segments.push(`L${x},${y}`);
        this._dirty = true;
    }

    bezierCurveTo(x1, y1, x2, y2, x, y) {
        this._x1 = x;
        this._y1 = y;
        this._segments.push(`C${x1},${y1},${x2},${y2},${x},${y}`);
        this._dirty = true;
    }

    closePath() {
        if (this._x1 !== null) {
            this._x1 = this._x0;
            this._y1 = this._y0;
            this._segments.push('Z');
            this._dirty = true;
        }
    }

    get data() {
        if (this._dirty) {
            this._data = this._segments.join('');
            this._dirty = false;
        }
        return this._data;
    }
};

mycelium.ArgumentList = class {

    constructor() {
        this._items = [];
        this._events = {};
    }

    argument(name, value) {
        return new mycelium.Argument(name, value);
    }

    add(value) {
        this._items.push(value);
    }

    on(event, callback) {
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    build(document, parent) {
        this._document = document;
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.element.setAttribute('class', 'node-argument-list');
        if (this._events.click) {
            this.element.addEventListener('click', (e) => {
                e.stopPropagation();
                this.emit('click');
            });
        }
        this.background = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.element.appendChild(this.background);
        parent.appendChild(this.element);
        for (const item of this._items) {
            item.build(document, this.element);
        }
        if (!this.first) {
            this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            this.line.setAttribute('class', 'node');
            this.element.appendChild(this.line);
        }
    }

    async measure() {
        this.width = 75;
        this.height = 3;
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];
            item._lazyContent = !!this._lazyContent;
            await item.measure();
            this.height += item.height;
            this.width = Math.max(this.width, item.width);
            if (item.type === 'node' || item.type === 'node[]') {
                if (i === this._items.length - 1) {
                    this.height += 3;
                }
            }
        }
        for (const item of this._items) {
            item.width = this.width;
        }
        this.height += 3;
    }

    estimate() {
        this.width = 75;
        this.height = 3;
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];
            item._lazyContent = !!this._lazyContent;
            if (typeof item.estimate === 'function') {
                item.estimate();
            }
            this.height += item.height || 0;
            this.width = Math.max(this.width, item.width || 0);
            if (item.type === 'node' || item.type === 'node[]') {
                if (i === this._items.length - 1) {
                    this.height += 3;
                }
            }
        }
        for (const item of this._items) {
            item.width = this.width;
        }
        this.height += 3;
    }

    async layout() {
        let y = 3;
        for (const item of this._items) {
            item.x = this.x;
            item.y = y;
            item.width = this.width;
            await item.layout();
            y += item.height;
        }
    }

    update() {
        this.element.setAttribute('transform', `translate(${this.x},${this.y})`);
        this.background.setAttribute('d', mycelium.Node.roundedRect(0, 0, this.width, this.height, this.first, this.first, this.last, this.last));
        for (const item of this._items) {
            item.update();
        }
        if (this.line) {
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', this.width);
            this.line.setAttribute('y1', 0);
            this.line.setAttribute('y2', 0);
        }
    }
};

mycelium.Argument = class {

    constructor(name, content) {
        const isNodeLike = (value) => {
            return value &&
                typeof value === 'object' &&
                Array.isArray(value.blocks) &&
                typeof value.build === 'function' &&
                typeof value.measure === 'function' &&
                typeof value.layout === 'function' &&
                typeof value.update === 'function';
        };
        this.name = name;
        this.content = content;
        this.tooltip = '';
        this.separator = '';
        if (isNodeLike(content)) {
            this.type = 'node';
        } else if (Array.isArray(content) && content.every((value) => isNodeLike(value))) {
            this.type = 'node[]';
        }
        this._contentBuilt = false;
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.element.setAttribute('class', 'node-argument');
        this.border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        this.border.setAttribute('rx', 3);
        this.border.setAttribute('ry', 3);
        this.element.appendChild(this.border);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('xml:space', 'preserve');
        if (this.tooltip) {
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = this.tooltip;
            text.appendChild(title);
        }
        const colon = this.type === 'node' || this.type === 'node[]';
        const name = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        name.textContent = colon ? `${this.name}:` : this.name;
        if (this.separator.trim() !== '=' && !colon) {
            name.style.fontWeight = 'bold';
        }
        if (this.focus) {
            this.element.addEventListener('pointerover', (e) => {
                this.focus();
                e.stopPropagation();
            });
        }
        if (this.blur) {
            this.element.addEventListener('pointerleave', (e) => {
                this.blur();
                e.stopPropagation();
            });
        }
        if (this.activate) {
            this.element.addEventListener('click', (e) => {
                this.activate();
                e.stopPropagation();
            });
        }
        text.appendChild(name);
        this.element.appendChild(text);
        parent.appendChild(this.element);
        this.text = text;
        switch (this.type) {
            case 'node': {
                const node = this.content;
                if (!this._lazyContent) {
                    node.build(document, this.element);
                    this._contentBuilt = true;
                }
                break;
            }
            case 'node[]': {
                if (!this._lazyContent) {
                    for (const node of this.content) {
                        node.build(document, this.element);
                    }
                    this._contentBuilt = true;
                }
                break;
            }
            default: {
                const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                tspan.textContent = (this.separator || '') + this.content;
                this.text.appendChild(tspan);
                break;
            }
        }
    }

    async measure() {
        const yPadding = 1;
        const xPadding = 6;
        if ((this.type === 'node' || this.type === 'node[]') && this._lazyContent && !this._contentBuilt) {
            this.estimate();
            return;
        }
        const size = this.text.getBBox();
        if ((!Number.isFinite(size.width) || size.width <= 0) &&
            (!Number.isFinite(size.height) || size.height <= 0)) {
            this.estimate();
            return;
        }
        this.width = xPadding + size.width + xPadding;
        this.bottom = yPadding + size.height + yPadding;
        this.offset = Number.isFinite(size.y) ? size.y : 0;
        if (this.offset >= 0 && Number.isFinite(size.height) && size.height > 0) {
            this.offset = -(size.height - 2);
        }
        this.height = this.bottom;
        if (this.type === 'node') {
            const node = this.content;
            if (!this._contentBuilt && !this._lazyContent) {
                node.build(this.element.ownerDocument, this.element);
                this._contentBuilt = true;
            }
            await node.measure();
            this.width = Math.max(150, this.width, node.width + (2 * xPadding));
            this.height += node.height + yPadding + yPadding + yPadding + yPadding;
        } else if (this.type === 'node[]') {
            if (!this._contentBuilt && !this._lazyContent) {
                for (const node of this.content) {
                    node.build(this.element.ownerDocument, this.element);
                }
                this._contentBuilt = true;
            }
            for (const node of this.content) {
                await node.measure();
                this.width = Math.max(150, this.width, node.width + (2 * xPadding));
                this.height += node.height + yPadding + yPadding + yPadding + yPadding;
            }
        }
    }

    estimate() {
        const yPadding = 1;
        const xPadding = 6;
        const left = this.name || '';
        const right = (this.type === 'node' || this.type === 'node[]') ? '' : `${this.separator || ''}${this.content || ''}`;
        const text = `${left}${right}`;
        const textWidth = String(text).length * 7;
        const textHeight = 14;
        this.width = xPadding + textWidth + xPadding;
        this.bottom = yPadding + textHeight + yPadding;
        this.offset = -(textHeight - 2);
        this.height = this.bottom;
        if (this.type === 'node') {
            const node = this.content;
            if (node && typeof node.estimate === 'function') {
                node.estimate();
            }
            this.width = Math.max(150, this.width, (node && node.width ? node.width : 0) + (2 * xPadding));
            this.height += (node && node.height ? node.height : 44) + yPadding + yPadding + yPadding + yPadding;
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                if (node && typeof node.estimate === 'function') {
                    node.estimate();
                }
                this.width = Math.max(150, this.width, (node && node.width ? node.width : 0) + (2 * xPadding));
                this.height += (node && node.height ? node.height : 44) + yPadding + yPadding + yPadding + yPadding;
            }
        }
    }

    async layout() {
        const yPadding = 1;
        const xPadding = 6;
        let y = this.y + this.bottom;
        if (this.type === 'node') {
            const node = this.content;
            if (!this._contentBuilt && !this._lazyContent) {
                node.build(this.element.ownerDocument, this.element);
                this._contentBuilt = true;
            }
            node.width = this.width - xPadding - xPadding;
            if (this._contentBuilt) {
                await node.layout();
                node.x = this.x + xPadding + (node.width / 2);
                node.y = y + (node.height / 2) + yPadding + yPadding;
            }
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                if (!this._contentBuilt && !this._lazyContent) {
                    node.build(this.element.ownerDocument, this.element);
                }
                node.width = this.width - xPadding - xPadding;
                if (this._contentBuilt || !this._lazyContent) {
                    await node.layout();
                    node.x = this.x + xPadding + (node.width / 2);
                    node.y = y + (node.height / 2) + yPadding + yPadding;
                }
                y += node.height + yPadding + yPadding + yPadding + yPadding;
            }
            if (!this._contentBuilt && !this._lazyContent) {
                this._contentBuilt = true;
            }
        }
    }

    update() {
        if (!Number.isFinite(this.x) || !Number.isFinite(this.y) || !Number.isFinite(this.width) || !Number.isFinite(this.height)) {
            const view = this.element && this.element.ownerDocument && this.element.ownerDocument.defaultView;
            if (view && view.console && view.console.warn) {
                view.console.warn('[argument-layout] invalid argument geometry', {
                    name: this.name,
                    x: this.x,
                    y: this.y,
                    width: this.width,
                    height: this.height,
                    type: this.type
                });
            }
            return;
        }
        const yPadding = 1;
        const xPadding = 6;
        this.text.setAttribute('x', this.x + xPadding);
        this.text.setAttribute('y', this.y + yPadding - this.offset);
        this.border.setAttribute('x', this.x + 3);
        this.border.setAttribute('y', this.y);
        this.border.setAttribute('width', this.width - 6);
        this.border.setAttribute('height', this.height);
        if ((this.type === 'node' || this.type === 'node[]') && this._lazyContent && !this._contentBuilt) {
            this.border.style.display = 'none';
            return;
        }
        this.border.style.display = '';
        if (this.type === 'node') {
            const node = this.content;
            node.update();
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                node.update();
            }
        }
    }

    select() {
        if (this.element) {
            this.element.classList.add('select');
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element) {
            this.element.classList.remove('select');
        }
    }
};

export const { Graph, Node, Edge, Argument, ArgumentList } = mycelium;
export const NodeHeader = mycelium.Node.Header;
export const NodeHeaderEntry = mycelium.Node.Header.Entry;
export const NodeCanvas = mycelium.Node.Canvas;
export const EdgeCurve = mycelium.Edge.Curve;
export const EdgePath = mycelium.Edge.Path;
