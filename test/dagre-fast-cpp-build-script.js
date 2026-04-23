import assert from 'assert';
import fs from 'fs';

assert.ok(fs.existsSync('tools/build-dagre-fast-cpp.sh'), 'build script should exist');
