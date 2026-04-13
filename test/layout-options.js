import assert from 'assert';
import { View } from '../source/view.js';

const callLayoutOptions = (threshold, nodeCount) => {
    const fakeView = {
        options: { layoutEstimateThreshold: threshold, layoutEstimateMode: 'auto' }
    };
    return View.prototype._layoutOptions.call(fakeView, {
        nodes: new Array(nodeCount).fill(0)
    });
};

const callLayoutOptionsWithMode = (mode, threshold, nodeCount) => {
    const fakeView = {
        options: { layoutEstimateMode: mode, layoutEstimateThreshold: threshold }
    };
    return View.prototype._layoutOptions.call(fakeView, {
        nodes: new Array(nodeCount).fill(0)
    });
};

assert.deepStrictEqual(callLayoutOptions(5, 4), { estimateOnly: false });
assert.deepStrictEqual(callLayoutOptions(5, 5), { estimateOnly: true });
assert.deepStrictEqual(callLayoutOptions(undefined, 1600), { estimateOnly: true });
assert.deepStrictEqual(callLayoutOptionsWithMode('on', 99999, 1), { estimateOnly: true });
assert.deepStrictEqual(callLayoutOptionsWithMode('off', 1, 99999), { estimateOnly: false });
