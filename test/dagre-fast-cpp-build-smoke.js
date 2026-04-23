import assert from 'assert';
import fs from 'fs';

assert.ok(fs.existsSync('dist/web/wasm/dagre-fast/dagre_fast.js'), 'dagre_fast.js should exist after cpp wasm build');
assert.ok(fs.existsSync('dist/web/wasm/dagre-fast/dagre_fast.wasm'), 'dagre_fast.wasm should exist after cpp wasm build');
