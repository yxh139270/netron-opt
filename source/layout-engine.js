const layoutEngine = {};

const now = () => {
    if (typeof performance !== 'undefined' && performance.now) {
        return performance.now();
    }
    return Date.now();
};

layoutEngine.getName = (layout) => {
    if (layout && typeof layout.engine === 'string' && layout.engine.length > 0) {
        return layout.engine;
    }
    return 'dagre';
};

layoutEngine.layout = async (nodes, edges, layout, state) => {
    const engine = layoutEngine.getName(layout);
    const start = now();
    switch (engine) {
        case 'd3dag':
        case 'd3dag-fast-sugi':
        case 'd3dag-zherebko': {
            const d3dag = await import('./layout-d3dag.js');
            await d3dag.layout(nodes, edges, layout, state);
            break;
        }
        case 'dagre':
        default: {
            const dagre = await import('./dagre.js');
            dagre.layout(nodes, edges, layout, state);
            break;
        }
    }
    const duration = now() - start;
    if (state) {
        state.profile = state.profile || {};
        state.profile.layoutEngine = duration;
        state.profile.layoutEngineName = engine;
    }
};

export const { getName, layout } = layoutEngine;
