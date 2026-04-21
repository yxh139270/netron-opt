import assert from 'assert';
import { View } from '../source/view.js';

const callLayoutOptions = (threshold, nodeCount) => {
    const fakeView = {
        options: { layoutEstimateThreshold: threshold, layoutEstimateMode: 'auto', layoutEngine: 'dagre-order' }
    };
    return View.prototype._layoutOptions.call(fakeView, {
        nodes: new Array(nodeCount).fill(0)
    });
};

const callLayoutOptionsWithMode = (mode, threshold, nodeCount) => {
    const fakeView = {
        options: { layoutEstimateMode: mode, layoutEstimateThreshold: threshold, layoutEngine: 'dagre-fast' }
    };
    return View.prototype._layoutOptions.call(fakeView, {
        nodes: new Array(nodeCount).fill(0)
    });
};

const callToggleLayoutEngine = (layoutEngine) => {
    const fakeView = {
        _options: {
            layoutEngine,
            layoutEstimateMode: 'auto',
            layoutEstimateThreshold: 1500
        },
        _defaultOptions: {
            layoutEngine: 'dagre-order',
            layoutEstimateMode: 'on',
            layoutEstimateThreshold: 1500
        },
        _reload: () => {},
        _host: {
            set: () => {},
            delete: () => {}
        }
    };
    View.prototype.toggle.call(fakeView, 'layoutEngine');
    return fakeView._options.layoutEngine;
};

assert.deepStrictEqual(callLayoutOptions(5, 4), { estimateOnly: false, layoutEngine: 'dagre-order' });
assert.deepStrictEqual(callLayoutOptions(5, 5), { estimateOnly: true, layoutEngine: 'dagre-order' });
assert.deepStrictEqual(callLayoutOptions(undefined, 1600), { estimateOnly: true, layoutEngine: 'dagre-order' });
assert.deepStrictEqual(callLayoutOptionsWithMode('on', 99999, 1), { estimateOnly: true, layoutEngine: 'dagre-fast' });
assert.deepStrictEqual(callLayoutOptionsWithMode('off', 1, 99999), { estimateOnly: false, layoutEngine: 'dagre-fast' });
assert.strictEqual(callToggleLayoutEngine('dagre-order'), 'dagre-fast');
assert.strictEqual(callToggleLayoutEngine('dagre-fast'), 'dagre');
assert.strictEqual(callToggleLayoutEngine('dagre'), 'dagre-order');
