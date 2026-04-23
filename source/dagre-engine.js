const _readLayoutEngine = (layout) => {
    return String((layout && (layout.layoutEngine || layout.orderEngine)) || 'dagre-order').toLowerCase();
};

const _readFastEngine = (layout) => {
    return String((layout && layout.fastEngine) || 'js').toLowerCase();
};

export const resolveDagreModulePath = (layout) => {
    const engine = _readLayoutEngine(layout);
    if (engine === 'dagre-fast') {
        const fastEngine = _readFastEngine(layout);
        return fastEngine === 'cpp' ? './dagre-fast-cpp.js' : './dagre-fast.js';
    }
    return engine === 'dagre' ? './dagre.js' : './dagre-order.js';
};

export const resolveDagreEngines = (layout) => {
    return {
        layoutEngine: _readLayoutEngine(layout),
        fastEngine: _readFastEngine(layout)
    };
};
