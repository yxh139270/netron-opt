let _modulePromise = null;
let _moduleError = null;

const _isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const _moduleCandidates = () => {
    return [
        {
            js: new URL('./wasm/dagre-fast/dagre_fast.js', import.meta.url),
            wasm: new URL('./wasm/dagre-fast/dagre_fast.wasm', import.meta.url)
        },
        {
            js: new URL('../dist/web/wasm/dagre-fast/dagre_fast.js', import.meta.url),
            wasm: new URL('../dist/web/wasm/dagre-fast/dagre_fast.wasm', import.meta.url)
        }
    ];
};

const _loadModule = async () => {
    if (_moduleError) {
        throw _moduleError;
    }
    if (!_modulePromise) {
        _modulePromise = (async () => {
            let lastError = null;
            for (const candidate of _moduleCandidates()) {
                try {
                    const mod = await import(candidate.js.href);
                    if (typeof mod.default === 'function') {
                        if (_isNode) {
                            const fs = await import('node:fs/promises');
                            const bytes = await fs.readFile(candidate.wasm);
                            return mod.default({ wasmBinary: bytes });
                        }
                        return mod.default({ locateFile: () => candidate.wasm.href });
                    }
                    if (mod && mod.cwrap) {
                        return mod;
                    }
                } catch (error) {
                    lastError = error;
                }
            }
            throw new Error(`Unable to load dagre-fast-cpp wasm module. ${lastError ? lastError.message : ''}`.trim());
        })();
        _modulePromise.catch((error) => {
            _moduleError = error;
            _modulePromise = null;
        });
    }
    return _modulePromise;
};

const _copyLayoutResult = (nodes, edges, parsed) => {
    const nodeById = new Map((parsed.nodes || []).map((node) => [node.v, node]));
    for (const node of nodes || []) {
        const out = nodeById.get(node.v);
        if (!out) {
            continue;
        }
        for (const key of Object.keys(out)) {
            node[key] = out[key];
        }
    }

    const edgeByKey = new Map((parsed.edges || []).map((edge) => [`${edge.v}->${edge.w}`, edge]));
    for (const edge of edges || []) {
        const out = edgeByKey.get(`${edge.v}->${edge.w}`);
        if (!out) {
            continue;
        }
        for (const key of Object.keys(out)) {
            edge[key] = out[key];
        }
    }
};

const _hasFiniteNodeCoords = (nodes) => {
    return Array.isArray(nodes) && nodes.length > 0 && nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
};

const _applyMeta = (state, parsed) => {
    if (!state) {
        return;
    }
    state.layoutDebug = state.layoutDebug || {};
    if (parsed && parsed.meta && typeof parsed.meta === 'object') {
        state.layoutDebug.fastEngineMeta = parsed.meta;
    }
};

export const layout = async (nodes, edges, layoutOptions, state) => {
    const fallback = async (reason) => {
        const dagre = await import('./dagre-fast.js');
        dagre.layout(nodes, edges, layoutOptions || {}, state || {});
        if (state) {
            state.layoutDebug = state.layoutDebug || {};
            state.layoutDebug.fastEngineFallback = 'cpp->js';
            if (reason) {
                state.layoutDebug.fastEngineError = reason;
            }
        }
    };

    const payload = {
        nodes: nodes || [],
        edges: edges || [],
        layout: layoutOptions || {},
        state: state || {}
    };

    try {
        const wasm = await _loadModule();
        const fn = wasm.cwrap('layout_json', 'number', ['string']);
        const freeFn = wasm.cwrap('free_json', null, ['number']);
        const ptr = fn(JSON.stringify(payload));
        const output = wasm.UTF8ToString(ptr);
        freeFn(ptr);

        let parsed = null;
        try {
            parsed = JSON.parse(output);
        } catch (error) {
            throw new Error(`dagre-fast-cpp returned invalid JSON: ${error && error.message ? error.message : error}`);
        }

        if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
            throw new Error('dagre-fast-cpp returned invalid payload');
        }

        if (parsed.meta && parsed.meta.ok === false) {
            throw new Error(parsed.meta.error || 'dagre-fast-cpp returned meta.ok=false');
        }

        _copyLayoutResult(nodes, edges, parsed);
        _applyMeta(state, parsed);
        if (!_hasFiniteNodeCoords(nodes)) {
            await fallback('missing-node-coordinates');
        }
    } catch (error) {
        await fallback(error && error.message ? error.message : String(error));
    }
};
