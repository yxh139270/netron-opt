import assert from 'assert';
import { resolveDagreModulePath } from '../source/dagre-engine.js';

assert.strictEqual(
    resolveDagreModulePath({ layoutEngine: 'dagre-fast', fastEngine: 'cpp' }),
    './dagre-fast-cpp.js',
    'dagre-fast + cpp should route to cpp module'
);

assert.strictEqual(
    resolveDagreModulePath({ layoutEngine: 'dagre-fast' }),
    './dagre-fast.js',
    'dagre-fast default should route to js module'
);

assert.strictEqual(
    resolveDagreModulePath({ layoutEngine: 'dagre' }),
    './dagre.js',
    'dagre should route to dagre.js'
);
