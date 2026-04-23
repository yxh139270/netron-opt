
const require = async () => {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const worker_threads = await import('worker_threads');
        return worker_threads.parentPort;
    }
    import('./dagre-order.js');
    import('./dagre-fast.js');
    import('./dagre-fast-cpp.js');
    import('./dagre.js');
    return self;
};

require().then((self) => {
    self.addEventListener('message', async (e) => {
        const message = e.data;
        switch (message.type) {
            case 'dagre.layout': {
                try {
                    const selector = await import('./dagre-engine.js');
                    const engines = selector.resolveDagreEngines(message.layout || {});
                    const modulePath = selector.resolveDagreModulePath(message.layout || {});
                    const dagre = await import(modulePath);
                    await dagre.layout(message.nodes, message.edges, message.layout, message.state);
                    if (typeof console !== 'undefined' && console.warn) {
                        const hasLog = !!(message.state && message.state.log);
                        console.warn(`[worker] dagre.layout engine=${engines.layoutEngine}/${engines.fastEngine} done hasLog=${hasLog} nodes=${message.nodes ? message.nodes.length : 0} edges=${message.edges ? message.edges.length : 0}`);
                    }
                    self.postMessage(message);
                } catch (error) {
                    self.postMessage({ type: 'error', message: error.message });
                }
                break;
            }
            default: {
                throw Error(`Unsupported message type '${message.type}'.`);
            }
        }
    });
});
