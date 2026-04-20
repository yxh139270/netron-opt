
import * as base from '../source/base.js';
import * as fs from 'fs/promises';
import * as mock from './mock.js';
import * as node from '../source/node.js';
import * as path from 'path';
import * as process from 'process';
import * as python from '../source/python.js';
import * as tar from '../source/tar.js';
import * as url from 'url';
import * as view from '../source/view.js';
import * as worker_threads from 'worker_threads';
import * as zip from '../source/zip.js';

const access = async (path) => {
    try {
        await fs.access(path);
        return true;
    } catch {
        return false;
    }
};

const dirname = (...args) => {
    const file = url.fileURLToPath(import.meta.url);
    const dir = path.dirname(file);
    return path.join(dir, ...args);
};

const decompress = (buffer) => {
    let archive = zip.Archive.open(buffer, 'gzip');
    if (archive && archive.entries.size === 1) {
        const stream = archive.entries.values().next().value;
        buffer = stream.peek();
    }
    const formats = [zip, tar];
    for (const module of formats) {
        archive = module.Archive.open(buffer);
        if (archive) {
            break;
        }
    }
    return archive;
};

export class Target {

    constructor(item) {
        Object.assign(this, item);
        this.events = {};
        this.tags = new Set(this.tags);
        this.folder = item.type ? path.normalize(dirname('..', 'third_party' , 'test', item.type)) : process.cwd();
        this.assert = !this.assert || Array.isArray(this.assert) ? this.assert : [this.assert];
        this.serial = false;
    }

    on(event, callback) {
        this.events[event] = this.events[event] || [];
        this.events[event].push(callback);
    }

    emit(event, data) {
        if (this.events && this.events[event]) {
            for (const callback of this.events[event]) {
                callback(this, data);
            }
        }
    }

    status(message) {
        this.emit('status', message);
    }

    _now() {
        return Number(process.hrtime.bigint()) / 1e6;
    }

    _log(message) {
        if (globalThis.console && typeof globalThis.console.log === 'function') {
            globalThis.console.log(message);
        }
    }

    _logDuration(stage, start, details) {
        const elapsed = this._now() - start;
        let suffix = '';
        if (details && typeof details === 'object') {
            const entries = Object.entries(details).filter(([, value]) => value !== undefined && value !== null && value !== '');
            if (entries.length > 0) {
                suffix = ` ${entries.map(([key, value]) => `${key}=${value}`).join(' ')}`;
            }
        }
        this._log(`${stage} ${elapsed.toFixed(2)} ms${suffix}`);
    }

    async execute() {
        if (this.measures) {
            this.measures.set('name', this.name);
        }
        await zip.Archive.import();
        const orderEngine = process.env.NETRON_ORDER_ENGINE;
        const environment = {
            zoom: 'none',
            serial: this.serial,
            options: orderEngine ? { orderEngine } : undefined
        };
        this.host = await new mock.Host(environment);
        this.view = new view.View(this.host);
        this.view.options.attributes = true;
        this.view.options.initializers = true;
        if (process.env.NETRON_ORDER_ENGINE) {
            this.view.options.orderEngine = process.env.NETRON_ORDER_ENGINE;
        }
        const time = async (method) => {
            const start = process.hrtime.bigint();
            let err = null;
            try {
                await method.call(this);
            } catch (error) {
                err = error;
            }
            const duration = Number(process.hrtime.bigint() - start) / 1e9;
            if (this.measures) {
                this.measures.set(method.name, duration);
            }
            if (err) {
                throw err;
            }
        };
        this.status({ name: 'name', target: this.name });
        const errors = [];
        try {
            await time(this.download);
            await time(this.load);
            await time(this.validate);
            if (!this.tags.has('skip-render')) {
                await time(this.render);
            }
        } catch (error) {
            errors.push(error);
        }
        errors.push(...this.host.errors);
        if (errors.length === 0 && this.error) {
            throw new Error('Expected error.');
        }
        if (errors.length > 0 && (!this.error || errors.map((error) => error.message).join('\n') !== this.error)) {
            throw errors[0];
        }
        this.view.dispose();
    }

    async request(url, init) {
        const response = await global.fetch(url, init);
        if (!response.ok) {
            throw new Error(response.status.toString());
        }
        if (response.body) {
            const reader = response.body.getReader();
            const length = response.headers.has('Content-Length') ? parseInt(response.headers.get('Content-Length'), 10) : -1;
            let position = 0;
            /* eslint-disable consistent-this */
            const target = this;
            /* eslint-enable consistent-this */
            const stream = new global.ReadableStream({
                async start(controller) {
                    const read = async () => {
                        try {
                            const result = await reader.read();
                            if (result.done) {
                                target.status({ name: 'download' });
                                controller.close();
                            } else {
                                position += result.value.length;
                                if (length >= 0) {
                                    const percent = position / length;
                                    target.status({ name: 'download', target: url, percent });
                                } else {
                                    target.status({ name: 'download', target: url, position });
                                }
                                controller.enqueue(result.value);
                                return await read();
                            }
                        } catch (error) {
                            controller.error(error);
                            throw error;
                        }

                        return null;
                    };
                    return read();
                }
            });
            return new global.Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers
            });
        }
        return response;
    }
    async download(targets, sources) {
        targets = targets || Array.from(this.targets);
        sources = sources || this.source;
        const files = targets.map((file) => path.resolve(this.folder, file));
        const exists = await Promise.all(files.map((file) => access(file)));
        if (exists.every((value) => value)) {
            return;
        }
        if (!sources) {
            throw new Error('Download source not specified.');
        }
        let source = '';
        let sourceFiles = [];
        const match = sources.match(/^(.*?)\[(.*?)\](.*)$/);
        if (match) {
            [, source, sourceFiles, sources] = match;
            sourceFiles = sourceFiles.split(',').map((file) => file.trim());
            sources = sources && sources.startsWith(',') ? sources.substring(1).trim() : '';
        } else {
            const comma = sources.indexOf(',');
            if (comma === -1) {
                source = sources;
                sources = '';
            } else {
                source = sources.substring(0, comma);
                sources = sources.substring(comma + 1);
            }
        }
        await Promise.all(targets.map((target) => {
            const dir = path.dirname(`${this.folder}/${target}`);
            return fs.mkdir(dir, { recursive: true });
        }));
        const response = await this.request(source);
        const buffer = await response.arrayBuffer();
        const data = new Uint8Array(buffer);
        if (sourceFiles.length > 0) {
            this.status({ name: 'decompress' });
            const archive = decompress(data);
            for (const name of sourceFiles) {
                this.status({ name: 'write', target: name });
                if (name === '.') {
                    const target = targets.shift();
                    const dir = path.join(this.folder, target);
                    // eslint-disable-next-line no-await-in-loop
                    await fs.mkdir(dir, { recursive: true });
                } else {
                    const stream = archive.entries.get(name);
                    if (!stream) {
                        throw new Error(`Entry not found '${name}. Archive contains entries: ${JSON.stringify(Array.from(archive.entries.keys()))} .`);
                    }
                    const target = targets.shift();
                    const buffer = stream.peek();
                    const file = path.join(this.folder, target);
                    // eslint-disable-next-line no-await-in-loop
                    await fs.writeFile(file, buffer, null);
                }
            }
        } else {
            const target = targets.shift();
            this.status({ name: 'write', target });
            await fs.writeFile(`${this.folder}/${target}`, data, null);
        }
        if (targets.length > 0 && sources.length > 0) {
            await this.download(targets, sources);
        }
    }

    async load() {
        const start = this._now();
        const target = path.resolve(this.folder, this.targets[0]);
        const identifier = path.basename(target);
        this._log(`[load] start target=${identifier}`);
        const statStart = this._now();
        const stat = await fs.stat(target);
        this._logDuration('[load] stat', statStart, { type: stat.isFile() ? 'file' : 'directory' });
        let context = null;
        if (stat.isFile()) {
            const contextStart = this._now();
            const stream = new node.FileStream(target, 0, stat.size, stat.mtimeMs);
            const dirname = path.dirname(target);
            context = new mock.Context(this.host, dirname, identifier, stream, new Map());
            this._logDuration('[load] context', contextStart, { bytes: stat.size });
        } else if (stat.isDirectory()) {
            const contextStart = this._now();
            const entries = new Map();
            const file = async (pathname) => {
                const stat = await fs.stat(pathname);
                const stream = new node.FileStream(pathname, 0, stat.size, stat.mtimeMs);
                const name = pathname.split(path.sep).join(path.posix.sep);
                entries.set(name, stream);
            };
            const walk = async (dir) => {
                const stats = await fs.readdir(dir, { withFileTypes: true });
                const promises = [];
                for (const stat of stats) {
                    const pathname = path.join(dir, stat.name);
                    if (stat.isDirectory()) {
                        promises.push(walk(pathname));
                    } else if (stat.isFile()) {
                        promises.push(file(pathname));
                    }
                }
                await Promise.all(promises);
            };
            await walk(target);
            context = new mock.Context(this.host, target, identifier, null, entries);
            this._logDuration('[load] context', contextStart, { entries: entries.size });
        }
        const openStart = this._now();
        const modelFactoryService = new view.ModelFactoryService(this.host);
        this.model = await modelFactoryService.open(context);
        this._logDuration('[load] model-factory.open', openStart, {
            modules: Array.isArray(this.model.modules) ? this.model.modules.length : 0,
            functions: Array.isArray(this.model.functions) ? this.model.functions.length : 0,
            format: this.model.format || ''
        });
        this.view.model = this.model;
        this._logDuration('[load] total', start);
    }

    async validate() {
        const start = this._now();
        const model = this.model;
        this._log(`[validate] start format=${model && model.format ? model.format : ''}`);
        const countGraphNodes = (graph) => {
            if (!graph || !Array.isArray(graph.nodes)) {
                return 0;
            }
            let count = graph.nodes.length;
            for (const node of graph.nodes) {
                if (node && node.type && Array.isArray(node.type.nodes)) {
                    count += countGraphNodes(node.type);
                }
                const attributes = node && Array.isArray(node.attributes) ? node.attributes : [];
                for (const attribute of attributes) {
                    const value = attribute ? attribute.value : null;
                    if ((attribute.type === 'graph' || attribute.type === 'function') && value && Array.isArray(value.nodes)) {
                        count += countGraphNodes(value);
                    }
                }
            }
            return count;
        };
        const validationNodeThreshold = 1000;
        const topLevelNodes = (Array.isArray(model.modules) ? model.modules : []).reduce((sum, graph) => sum + countGraphNodes(graph), 0) +
            (Array.isArray(model.functions) ? model.functions : []).reduce((sum, graph) => sum + countGraphNodes(graph), 0);
        const requestedValidateMode = this.validateMode || 'full';
        const lightMode = requestedValidateMode === 'light' || (requestedValidateMode === 'auto' && topLevelNodes >= validationNodeThreshold);
        const effectiveValidateMode = lightMode ? 'light' : 'full';
        this._log(`[validate] mode=${effectiveValidateMode} requested=${requestedValidateMode} top_level_nodes=${topLevelNodes} threshold=${validationNodeThreshold}`);
        const stats = {
            graphs: 0,
            nodes: 0,
            values: 0,
            tensors: 0,
            signatures: 0,
            moduleMs: 0,
            functionMs: 0,
            breakdown: {
                signaturesMs: 0,
                nodeLoopMs: 0,
                validateValueMs: 0,
                validateTensorMs: 0,
                tensorStringMs: 0,
                tensorPythonMs: 0,
                documentationMs: 0,
                attributeMs: 0,
                formatterMs: 0,
                nodeSidebarMs: 0,
                modelSidebarMs: 0
            }
        };
        if (!model.format || (this.format && this.format !== model.format)) {
            throw new Error(`Invalid model format '${model.format}'.`);
        }
        if (this.producer && model.producer !== this.producer) {
            throw new Error(`Invalid producer '${model.producer}'.`);
        }
        if (this.runtime && model.runtime !== this.runtime) {
            throw new Error(`Invalid runtime '${model.runtime}'.`);
        }
        if (model.metadata && (!Array.isArray(model.metadata) || !model.metadata.every((argument) => argument.name && (argument.value || argument.value === null || argument.value === '' || argument.value === false || argument.value === 0)))) {
            throw new Error("Invalid model metadata.");
        }
        if (this.assert) {
            for (const assert of this.assert) {
                const parts = assert.split('==').map((item) => item.trim());
                const properties = parts[0].split('.');
                const value = JSON.parse(parts[1].replace(/\s*'|'\s*/g, '"'));
                let context = { model };
                while (properties.length) {
                    const property = properties.shift();
                    if (context[property] !== undefined) {
                        context = context[property];
                        continue;
                    }
                    const match = /(.*)\[(.*)\]/.exec(property);
                    if (match && match.length === 3 && context[match[1]] !== undefined) {
                        const array = context[match[1]];
                        const index = parseInt(match[2], 10);
                        if (array[index] !== undefined) {
                            context = array[index];
                            continue;
                        }
                    }
                    throw new Error(`Invalid property path '${parts[0]}'.`);
                }
                if (context !== value && context.toString() !== value) {
                    throw new Error(`Invalid '${context}' != '${assert}'.`);
                }
            }
        }
        if (model.version || model.description || model.author || model.license) {
            // continue
        }
        const validateGraph = async (graph) => {
            const graphStart = this._now();
            stats.graphs += 1;
            const graphStats = {
                signaturesMs: 0,
                nodeLoopMs: 0,
                validateValueMs: 0,
                validateTensorMs: 0,
                tensorStringMs: 0,
                tensorPythonMs: 0,
                documentationMs: 0,
                attributeMs: 0,
                formatterMs: 0,
                nodeSidebarMs: 0,
                modelSidebarMs: 0
            };
            /* eslint-disable no-unused-expressions */
            const values = new Map();
            const validateTensor = async (value) => {
                const validateTensorStart = this._now();
                stats.tensors += 1;
                value.type.toString();
                if (value && value.peek && !value.peek()) {
                    await value.read();
                }
                const tensor = new base.Tensor(value);
                if (!this.tags.has('skip-tensor-value')) {
                    if (tensor.encoding !== '<' && tensor.encoding !== '>' && tensor.encoding !== '|') {
                        throw new Error(`Tensor encoding '${tensor.encoding}' is not implemented.`);
                    }
                    if (tensor.layout && (tensor.layout !== 'sparse' && tensor.layout !== 'sparse.coo')) {
                        throw new Error(`Tensor layout '${tensor.layout}' is not implemented.`);
                    }
                    if (!tensor.empty) {
                        if (tensor.type && tensor.type.dataType === '?') {
                            throw new Error('Tensor data type is not defined.');
                        } else if (tensor.type && !tensor.type.shape) {
                            throw new Error('Tensor shape is not defined.');
                        } else if (!lightMode) {
                            const tensorStringStart = this._now();
                            tensor.toString();
                            graphStats.tensorStringMs += this._now() - tensorStringStart;
                            if (this.tags.has('validation')) {
                                const size = tensor.type.shape.dimensions.reduce((a, b) => BigInt(a) * BigInt(b), 1n).toNumber();
                                if (size < 8192 && tensor.type &&
                                    tensor.type.dataType !== '?' &&
                                    tensor.type.dataType !== 'string' &&
                                    tensor.type.dataType !== 'int128' &&
                                    tensor.type.dataType !== 'complex<int32>') {
                                    const tensorPythonStart = this._now();
                                    let data_type = '?';
                                    switch (tensor.type.dataType) {
                                        case 'boolean': data_type = 'bool'; break;
                                        case 'bfloat16': data_type = 'float32'; break;
                                        case 'float4e2m1fn': data_type = 'float16'; break;
                                        case 'float6e2m3fn': data_type = 'float16'; break;
                                        case 'float6e3m2fn': data_type = 'float16'; break;
                                        case 'float8e5m2': data_type = 'float16'; break;
                                        case 'float8e5m2fnuz': data_type = 'float16'; break;
                                        case 'float8e3m4': data_type = 'float16'; break;
                                        case 'float8e4m3': data_type = 'float16'; break;
                                        case 'float8e4m3fn': data_type = 'float16'; break;
                                        case 'float8e4m3fnuz': data_type = 'float16'; break;
                                        case 'float8e4m3b11fnuz': data_type = 'float16'; break;
                                        case 'float8e8m0fnu': data_type = 'float16'; break;
                                        case 'float8e8m0': data_type = 'float16'; break;
                                        case 'float80': data_type = 'float64'; break;
                                        case 'float128': data_type = 'float64'; break;
                                        case 'complex<float32>': data_type = 'complex64'; break;
                                        case 'complex<float64>': data_type = 'complex128'; break;
                                        case 'int48': data_type = 'int64'; break;
                                        case 'quint4x2': data_type = 'uint8'; break;
                                        case 'quint2x4': data_type = 'uint8'; break;
                                        default: {
                                            const intMatch = tensor.type.dataType.match(/^(u?)int(\d+)$/);
                                            if (intMatch) {
                                                const bits = parseInt(intMatch[2], 10);
                                                const prefix = intMatch[1] ? 'uint' : 'int';
                                                if (bits <= 8) {
                                                    data_type = `${prefix}8`;
                                                } else if (bits <= 16) {
                                                    data_type = `${prefix}16`;
                                                } else if (bits <= 32) {
                                                    data_type = `${prefix}32`;
                                                } else if (bits <= 64) {
                                                    data_type = `${prefix}64`;
                                                } else {
                                                    data_type = tensor.type.dataType;
                                                }
                                            } else {
                                                data_type = tensor.type.dataType;
                                            }
                                            break;
                                        }
                                    }
                                    Target.execution = Target.execution || new python.Execution();
                                    const execution = Target.execution;
                                    const io = execution.__import__('io');
                                    const numpy = execution.__import__('numpy');
                                    const bytes = new io.BytesIO();
                                    const dtype = new numpy.dtype(data_type);
                                    const array = numpy.asarray(tensor.value, dtype);
                                    numpy.save(bytes, array);
                                    graphStats.tensorPythonMs += this._now() - tensorPythonStart;
                                }
                            }
                        }
                    }
                }
                graphStats.validateTensorMs += this._now() - validateTensorStart;
            };
            const validateValue = async (value) => {
                const validateValueStart = this._now();
                stats.values += 1;
                if (value === null) {
                    graphStats.validateValueMs += this._now() - validateValueStart;
                    return;
                }
                value.name.toString();
                value.name.length;
                value.description;
                if (value.quantization) {
                    if (!this.tags.has('quantization')) {
                        throw new Error("Invalid 'quantization' tag.");
                    }
                    const quantization = new view.Quantization(value.quantization);
                    quantization.toString();
                }
                if (value.type) {
                    value.type.toString();
                }
                if (value.initializer) {
                    await validateTensor(value.initializer);
                } else if (value.name.length === 0) {
                    throw new Error('Empty value name.');
                }
                if (value.name.length > 0 && value.initializer === null) {
                    if (!values.has(value.name)) {
                        values.set(value.name, value);
                    } else if (value !== values.get(value.name)) {
                        throw new Error(`Duplicate value '${value.name}'.`);
                    }
                }
                graphStats.validateValueMs += this._now() - validateValueStart;
            };
            const signatures = Array.isArray(graph.signatures) ? graph.signatures : [graph];
            stats.signatures += signatures.length;
            const signaturesStart = this._now();
            for (const signature of signatures) {
                for (const input of signature.inputs) {
                    input.name.toString();
                    input.name.length;
                    for (const value of input.value) {
                        // eslint-disable-next-line no-await-in-loop
                        await validateValue(value);
                    }
                }
                for (const output of signature.outputs) {
                    output.name.toString();
                    output.name.length;
                    if (Array.isArray(output.value)) {
                        for (const value of output.value) {
                            // eslint-disable-next-line no-await-in-loop
                            await validateValue(value);
                        }
                    }
                }
            }
            graphStats.signaturesMs += this._now() - signaturesStart;
            if (graph.metadata && (!Array.isArray(graph.metadata) || !graph.metadata.every((argument) => argument.name && argument.value !== undefined))) {
                throw new Error("Invalid graph metadata.");
            }
            stats.nodes += Array.isArray(graph.nodes) ? graph.nodes.length : 0;
            const nodeLoopStart = this._now();
            for (const node of graph.nodes) {
                const type = node.type;
                if (!type || typeof type.name !== 'string') {
                    throw new Error(`Invalid node type '${JSON.stringify(node.type)}'.`);
                }
                if (Array.isArray(type.nodes)) {
                    // eslint-disable-next-line no-await-in-loop
                    await validateGraph(type);
                }
                if (!lightMode) {
                    const documentationStart = this._now();
                    view.Documentation.open(type);
                    graphStats.documentationMs += this._now() - documentationStart;
                }
                node.name.toString();
                node.description;
                if (node.metadata && (!Array.isArray(node.metadata) || !node.metadata.every((argument) => argument.name && argument.value !== undefined))) {
                    throw new Error("Invalid node metadata.");
                }
                const attributes = node.attributes;
                if (attributes) {
                    const attributeStart = this._now();
                    for (const attribute of attributes) {
                        attribute.name.toString();
                        attribute.name.length;
                        const type = attribute.type;
                        const value = attribute.value;
                        if ((type === 'graph' || type === 'function') && value && Array.isArray(value.nodes)) {
                            // eslint-disable-next-line no-await-in-loop
                            await validateGraph(value);
                        } else if (type === 'tensor') {
                            // eslint-disable-next-line no-await-in-loop
                            await validateTensor(value);
                        } else if (!lightMode) {
                            const formatterStart = this._now();
                            let text = new view.Formatter(attribute.value, attribute.type).toString();
                            if (text && text.length > 1000) {
                                text = `${text.substring(0, 1000)}...`;
                            }
                            /* value = */ text.split('<');
                            graphStats.formatterMs += this._now() - formatterStart;
                        }
                    }
                    graphStats.attributeMs += this._now() - attributeStart;
                }
                const inputs = node.inputs;
                if (Array.isArray(inputs)) {
                    for (const input of inputs) {
                        input.name.toString();
                        input.name.length;
                        if (!input.type || input.type.endsWith('*')) {
                            for (const value of input.value) {
                                // eslint-disable-next-line no-await-in-loop
                                await validateValue(value);
                            }
                            if (!lightMode && this.tags.has('validation')) {
                                if (input.value.length === 1 && input.value[0].initializer) {
                                    const tensorSidebarStart = this._now();
                                    const sidebar = new view.TensorSidebar(this.view, input);
                                    sidebar.render();
                                    graphStats.nodeSidebarMs += this._now() - tensorSidebarStart;
                                }
                            }
                        }
                    }
                }
                const outputs = node.outputs;
                if (Array.isArray(outputs)) {
                    for (const output of node.outputs) {
                        output.name.toString();
                        output.name.length;
                        if (!output.type || output.type.endsWith('*')) {
                            for (const value of output.value) {
                                // eslint-disable-next-line no-await-in-loop
                                await validateValue(value);
                            }
                        }
                    }
                }
                if (node.chain) {
                    for (const chain of node.chain) {
                        chain.name.toString();
                        chain.name.length;
                    }
                }
                if (!lightMode) {
                    const nodeSidebarStart = this._now();
                    const sidebar = new view.NodeSidebar(this.view, node);
                    sidebar.render();
                    graphStats.nodeSidebarMs += this._now() - nodeSidebarStart;
                }
            }
            graphStats.nodeLoopMs += this._now() - nodeLoopStart;
            if (!lightMode) {
                const modelSidebarStart = this._now();
                const sidebar = new view.ModelSidebar(this.view, this.model, graph);
                sidebar.render();
                graphStats.modelSidebarMs += this._now() - modelSidebarStart;
            }
            /* eslint-enable no-unused-expressions */
            for (const [key, value] of Object.entries(graphStats)) {
                stats.breakdown[key] += value;
            }
            this._logDuration('[validate] graph', graphStart, {
                name: graph && (graph.name || graph.identifier) ? (graph.name || graph.identifier) : '',
                nodes: Array.isArray(graph.nodes) ? graph.nodes.length : 0,
                signatures_ms: graphStats.signaturesMs.toFixed(2),
                node_loop_ms: graphStats.nodeLoopMs.toFixed(2),
                value_ms: graphStats.validateValueMs.toFixed(2),
                tensor_ms: graphStats.validateTensorMs.toFixed(2),
                tensor_python_ms: graphStats.tensorPythonMs.toFixed(2),
                attr_ms: graphStats.attributeMs.toFixed(2),
                sidebar_ms: (graphStats.nodeSidebarMs + graphStats.modelSidebarMs).toFixed(2)
            });
        };
        const validateTarget = async (target) => {
            switch (target.type) {
                default: {
                    await validateGraph(target);
                }
            }
        };
        for (const module of model.modules) {
            const moduleStart = this._now();
            // eslint-disable-next-line no-await-in-loop
            await validateTarget(module);
            stats.moduleMs += this._now() - moduleStart;
        }
        const functions = model.functions || [];
        for (const func of functions) {
            const functionStart = this._now();
            // eslint-disable-next-line no-await-in-loop
            await validateTarget(func);
            stats.functionMs += this._now() - functionStart;
        }
        this._logDuration('[validate] modules', start, {
            ms: stats.moduleMs.toFixed(2),
            functions_ms: stats.functionMs.toFixed(2)
        });
        this._logDuration('[validate] total', start, {
            graphs: stats.graphs,
            nodes: stats.nodes,
            signatures: stats.signatures,
            values: stats.values,
            tensors: stats.tensors
        });
        this._log(`[validate] breakdown signatures_ms=${stats.breakdown.signaturesMs.toFixed(2)} node_loop_ms=${stats.breakdown.nodeLoopMs.toFixed(2)} value_ms=${stats.breakdown.validateValueMs.toFixed(2)} tensor_ms=${stats.breakdown.validateTensorMs.toFixed(2)} tensor_string_ms=${stats.breakdown.tensorStringMs.toFixed(2)} tensor_python_ms=${stats.breakdown.tensorPythonMs.toFixed(2)} documentation_ms=${stats.breakdown.documentationMs.toFixed(2)} attribute_ms=${stats.breakdown.attributeMs.toFixed(2)} formatter_ms=${stats.breakdown.formatterMs.toFixed(2)} node_sidebar_ms=${stats.breakdown.nodeSidebarMs.toFixed(2)} model_sidebar_ms=${stats.breakdown.modelSidebarMs.toFixed(2)}`);
    }

    async render() {
        for (const graph of this.model.modules) {
            const signatures = Array.isArray(graph.signatures) && graph.signatures.length > 0 ? graph.signatures : [graph];
            for (const signature of signatures) {
                // eslint-disable-next-line no-await-in-loop
                await this.view.render(graph, signature);
            }
        }
    }
}

if (!worker_threads.isMainThread) {
    worker_threads.parentPort.addEventListener('message', async (e) => {
        const message = e.data;
        const response = {};
        try {
            const target = new Target(message);
            response.type = 'complete';
            response.target = target.name;
            target.on('status', (sender, message) => {
                message = { type: 'status', ...message };
                worker_threads.parentPort.postMessage(message);
            });
            if (message.measures) {
                target.measures = new Map();
            }
            await target.execute();
            response.measures = target.measures;
        } catch (error) {
            response.type = 'error';
            response.error = {
                name: error.name,
                message: error.message,
                stack: error.stack
            };
            const cause = error.cause;
            if (cause) {
                response.error.cause = {
                    name: cause.name,
                    message: cause.message
                };
            }
        }
        worker_threads.parentPort.postMessage(response);
    });
}
