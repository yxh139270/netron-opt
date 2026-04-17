let _modulePromise = null;
let _moduleError = null;

const _isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);

const _moduleCandidates = () => {
    return [
        {
            js: new URL('./wasm/dagre-order-rs/dagre_order_rs.js', import.meta.url),
            wasm: new URL('./wasm/dagre-order-rs/dagre_order_rs_bg.wasm', import.meta.url)
        },
        {
            js: new URL('../dist/web/wasm/dagre-order-rs/dagre_order_rs.js', import.meta.url),
            wasm: new URL('../dist/web/wasm/dagre-order-rs/dagre_order_rs_bg.wasm', import.meta.url)
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
                    const module = await import(candidate.js.href);
                    if (_isNode && typeof module.initSync === 'function') {
                        const fs = await import('node:fs/promises');
                        const bytes = await fs.readFile(candidate.wasm);
                        module.initSync({ module: bytes });
                    } else if (typeof module.default === 'function') {
                        await module.default(candidate.wasm);
                    }
                    return module;
                } catch (error) {
                    lastError = error;
                }
            }
            throw new Error(`Unable to load dagre-order-rs wasm module. ${lastError ? lastError.message : ''}`.trim());
        })();
        _modulePromise.catch((error) => {
            _moduleError = error;
            _modulePromise = null;
        });
    }
    return _modulePromise;
};

export const layout = async (nodes, edges, layout, state) => {
    const module = await _loadModule();
    if (!module || typeof module.layout !== 'function') {
        throw new Error('dagre-order-rs module missing layout function.');
    }
    const input = {
        nodes: (nodes || []).map((node) => ({ id: node.v, data: node })),
        edges: (edges || []).map((edge) => ({ v: edge.v, w: edge.w, data: edge })),
        layout: layout || {},
        state: state || {}
    };
    let output = null;
    try {
        output = module.layout(JSON.stringify(input));
    } catch (error) {
        throw new Error(`dagre-order-rs layout call failed: ${error && error.message ? error.message : error}`);
    }
    if (typeof output !== 'string') {
        throw new Error('dagre-order-rs returned non-string output.');
    }
    try {
        return JSON.parse(output);
    } catch (error) {
        throw new Error(`dagre-order-rs returned invalid JSON: ${error && error.message ? error.message : error}`);
    }
};
