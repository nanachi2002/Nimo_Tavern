// NimoFramework: runs ported SillyTavern "server plugins" in the user's own browser.
//
// A SillyTavern server plugin is Node.js code that runs on the server. On a shared server like NimoTavern's that
// would let one user's plugin read everyone's data, so it is never allowed. NimoFramework is the alternative: the
// plugin's backend runs here, in the user's Service Worker, next to SillyTavern's own (also ported) server code,
// with the same routes it would have had (/api/plugins/<id>/...). It can only reach what that user can reach.
//
// An extension opts in from its manifest.json:   "nimo": { "framework": 1, "server": "server.cjs" }
// server.cjs is ONE CommonJS file (hand-written, or bundled with esbuild) exporting { info, init(router), exit() }.
// Docs: nimo/framework/README.md and /wiki/nimoframework.
import path from 'path-browserify';
import * as bufferMod from 'buffer';
import events from 'events';
import stream from 'stream';
import util from 'util';
import * as stringDecoder from 'string_decoder';
import express from './shims/express.js';
import fsShim from './shims/fs.js';
import fsPromises from './shims/fs-promises.js';
import nodeFetch, * as nodeFetchNamed from './shims/node-fetch.js';
import cryptoShim from './shims/crypto.js';
import osShim from './shims/os.js';
import urlShim from './shims/url.js';
import streamPromises from './shims/stream-promises.js';
import readlineShim from './shims/readline.js';
import { PROVIDED, bare, explain } from '../shared/framework-modules.js';
import { vfs } from './vfs.js';
import { nimoState } from './state.js';

export const FRAMEWORK_VERSION = 1;
const WIKI = '/wiki/nimoframework';
const SETTINGS = '/data/default-user/settings.json';
const INIT_TIMEOUT = 20_000;
/** Ids that are routes of the framework itself. */
const RESERVED = new Set(['list', 'status']);

// require('node-fetch') must work both as `const fetch = require('node-fetch')` and as `.default` (bundled ESM).
const fetchModule = Object.assign((...a) => nodeFetch(...a), {
    default: nodeFetch, Headers: self.Headers, Request: self.Request, Response: self.Response,
    AbortError: nodeFetchNamed.AbortError, FetchError: nodeFetchNamed.FetchError,
});

// Node's timers carry a promisified version: `promisify(setTimeout)(ms)` is a common idiom in plugins.
for (const [fn, custom] of [
    [self.setTimeout, (ms, value) => new Promise((r) => self.setTimeout(r, ms, value))],
    [self.setImmediate || setImmediate, (value) => new Promise((r) => setImmediate(r, value))],
]) { try { Object.defineProperty(fn, util.promisify.custom, { value: custom }); } catch { /* */ } }

// The browser port of "stream" has no Readable.from(), which plugins use a lot. Same behaviour as Node's.
stream.Readable.from = function from(iterable, options) {
    if (typeof iterable === 'string' || iterable instanceof Uint8Array) {
        let sent = false;
        return new stream.Readable({ objectMode: true, ...options, read() { this.push(sent ? null : iterable); sent = true; } });
    }
    const it = iterable?.[Symbol.asyncIterator]?.() ?? iterable?.[Symbol.iterator]?.();
    if (!it) throw new TypeError('Readable.from() needs an iterable');
    let busy = false;
    return new stream.Readable({
        objectMode: true, ...options,
        async read() {
            if (busy) return;
            busy = true;
            try {
                for (;;) {
                    const { value, done } = await it.next();
                    if (done) { this.push(null); break; }
                    if (!this.push(value)) break;
                }
            } catch (e) { this.destroy(e); } finally { busy = false; }
        },
        destroy(err, cb) { Promise.resolve(it.return?.()).finally(() => cb(err)); },
    });
};

// Small Node modules that are trivial in a browser.
function assert(value, message) { if (!value) throw message instanceof Error ? message : new Error(message || 'Assertion failed'); }
const same = (x, y) => { try { return JSON.stringify(x) === JSON.stringify(y); } catch { return x === y; } };
Object.assign(assert, {
    ok: assert,
    // eslint-disable-next-line eqeqeq
    equal: (x, y, m) => assert(x == y, m ?? `${x} == ${y}`),
    // eslint-disable-next-line eqeqeq
    notEqual: (x, y, m) => assert(x != y, m ?? `${x} != ${y}`),
    strictEqual: (x, y, m) => assert(Object.is(x, y), m ?? `${x} === ${y}`),
    notStrictEqual: (x, y, m) => assert(!Object.is(x, y), m ?? `${x} !== ${y}`),
    deepEqual: (x, y, m) => assert(same(x, y), m ?? 'deepEqual'),
    deepStrictEqual: (x, y, m) => assert(same(x, y), m ?? 'deepStrictEqual'),
    fail: (m) => assert(false, m || 'Failed'),
    throws: (fn, m) => { try { fn(); } catch { return; } assert(false, typeof m === 'string' ? m : 'Missing expected exception'); },
});
assert.strict = assert;
const qsParse = (str) => {
    const out = {};
    for (const [k, v] of new URLSearchParams(String(str ?? ''))) out[k] = k in out ? [].concat(out[k], v) : v;
    return out;
};
const qsStringify = (obj) => Object.entries(obj || {})
    .flatMap(([k, v]) => [].concat(v).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(x ?? '')}`)).join('&');
const querystring = { parse: qsParse, decode: qsParse, stringify: qsStringify, encode: qsStringify, escape: encodeURIComponent, unescape: decodeURIComponent };
const timers = {
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t),
    setInterval: (...a) => setInterval(...a), clearInterval: (t) => clearInterval(t),
    setImmediate: (...a) => setImmediate(...a), clearImmediate: (t) => clearImmediate(t),
};
Object.defineProperty(timers.setTimeout, util.promisify.custom, { value: self.setTimeout[util.promisify.custom] });
Object.defineProperty(timers.setImmediate, util.promisify.custom, { value: setImmediate[util.promisify.custom] });
const timersPromises = {
    setTimeout: (ms, value) => new Promise((r) => setTimeout(r, ms, value)),
    setImmediate: (value) => new Promise((r) => setImmediate(r, value)),
    scheduler: { wait: (ms) => new Promise((r) => setTimeout(r, ms)) },
};

/** Modules a ported plugin may require() without bundling them (the names are in shared/framework-modules.js). */
const BUILTIN = {
    express, 'node-fetch': fetchModule,
    fs: fsShim, 'fs/promises': fsPromises, path, 'path/posix': path, crypto: cryptoShim, os: osShim, url: urlShim, querystring,
    buffer: bufferMod, events, stream, 'stream/promises': streamPromises, string_decoder: stringDecoder, readline: readlineShim,
    util, assert, timers, 'timers/promises': timersPromises, perf_hooks: { performance: self.performance }, process,
    console: self.console, tty: { isatty: () => false },
};
export const AVAILABLE_MODULES = PROVIDED.filter((m) => Object.hasOwn(BUILTIN, m));
if (AVAILABLE_MODULES.length !== PROVIDED.length || Object.keys(BUILTIN).length !== PROVIDED.length) console.error('[NimoFramework] shared/framework-modules.js and BUILTIN disagree');

function makeRequire() {
    return (id) => {
        const key = bare(id);
        if (Object.hasOwn(BUILTIN, key)) return BUILTIN[key];
        throw new Error(`require("${id}") is not available in NimoFramework. ${explain(id).hint} Guide: ${WIKI}`);
    };
}

function disabledExtensions() {
    try { return JSON.parse(vfs.readFileSync(SETTINGS, 'utf8'))?.extension_settings?.disabledExtensions || []; } catch { return []; }
}

/** Ported plugins found in the user's extensions folder: [{ folder, dir, manifest, file }] */
function scan(extRoot) {
    if (!vfs.existsSync(extRoot)) return [];
    const disabled = new Set(disabledExtensions());
    const out = [];
    for (const folder of vfs.readdirSync(extRoot)) {
        const dir = path.join(extRoot, folder);
        if (folder.startsWith('.') || !vfs.statSync(dir).isDirectory() || disabled.has('third-party/' + folder)) continue;
        let manifest;
        try { manifest = JSON.parse(vfs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
        const nimo = manifest?.nimo;
        if (!nimo || typeof nimo !== 'object' || nimo.server === undefined) continue;
        const entry = { folder, dir, manifest, file: '', framework: Number(nimo.framework) || 1, problem: '' };
        if (typeof nimo.server !== 'string' || !nimo.server) entry.problem = 'manifest.json: "nimo.server" must be the name of your server file, for example "server.cjs"';
        else {
            entry.file = path.join(dir, nimo.server);
            if (!entry.file.startsWith(dir + '/')) entry.problem = 'manifest.json: "nimo.server" must point to a file inside the extension';
            else if (!vfs.existsSync(entry.file)) entry.problem = `manifest.json points to "${nimo.server}", but that file is not in the repository (did you commit the built file?)`;
        }
        out.push(entry);
    }
    return out;
}

/** The `nimo` object handed to plugins. */
function nimoApi(f) {
    const dataDir = path.join('/data/default-user/user/nimoframework', f.folder);
    const file = (k) => path.join(dataDir, String(k).replace(/[^\w.-]/g, '_') + '.json');
    return Object.freeze({
        version: FRAMEWORK_VERSION,
        user: Object.freeze({ name: nimoState.username || 'User' }),
        /** Directory for the plugin's own files (encrypted and synced like all user data). */
        dataDir,
        /** Where the extension itself is installed: read files you ship in your repository from here. */
        extensionDir: f.dir,
        /** True when the user turned on NimoTavern's opt-in relay, which lets nimo.fetch reach sites that block browsers (CORS). */
        get relay() { return !!nimoState.relayEnabled; },
        /** Small JSON key/value store, encrypted and synced. */
        storage: Object.freeze({
            get(key, fallback = null) { try { return JSON.parse(vfs.readFileSync(file(key), 'utf8')); } catch { return fallback; } },
            set(key, value) { vfs.mkdirSync(dataDir, { recursive: true }); vfs.writeFileSync(file(key), JSON.stringify(value)); },
            delete(key) { try { vfs.unlinkSync(file(key)); } catch { /* */ } },
            keys() { try { return vfs.readdirSync(dataDir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)); } catch { return []; } },
        }),
        /** fetch() that falls back to NimoTavern's opt-in relay when a site blocks browser requests (CORS). */
        fetch: (...a) => nodeFetch(...a),
    });
}

/** "GET /hello", "POST /count", "USE /sub" … for /api/plugins/status (sub-routers are listed one level deep). */
function listRoutes(router, prefix = '') {
    const out = [];
    for (const l of router?.layers || []) {
        const p = prefix + (typeof l.path === 'string' ? (l.path === '/' && prefix ? '' : l.path) : String(l.path));
        const sub = !l.end && l.handlers.find((h) => Array.isArray(h?.layers));
        if (sub && !prefix) out.push(...listRoutes(sub, p));
        else out.push(`${l.method === '*' ? 'ALL' : l.method || 'USE'} ${p}`);
    }
    return out;
}

const loaded = new Map(); // plugin id -> { router, exit, folder, name, description }
const errors = new Map(); // extension folder -> why its plugin could not start
let signature = '';
let loading = null;

async function toTabs(msg) {
    try {
        const tabs = await self.clients.matchAll({ type: 'window' });
        for (const c of tabs) c.postMessage(msg);
        return tabs.length;
    } catch { return 0; }
}

/** Tell the open tabs, so nobody needs the Service Worker console to learn that a plugin failed. */
function report(folder, error) { return toTabs({ type: 'nimo-plugin-error', folder, error }); }

/** Something that survives postMessage and stays readable in the page console. */
function printable(v, depth = 0) {
    if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
    if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…' : v;
    if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint' ? String(v) : v;
    if (v instanceof Uint8Array || v instanceof ArrayBuffer) return `<${v.constructor.name} ${v.byteLength} bytes>`;
    if (depth > 3) return '…';
    try {
        if (Array.isArray(v)) return v.slice(0, 100).map((x) => printable(x, depth + 1));
        return Object.fromEntries(Object.entries(v).slice(0, 100).map(([k, x]) => [k, printable(x, depth + 1)]));
    } catch { return String(v); }
}

/**
 * Service Worker logs are hard to find (in Firefox they are not in the page's console at all), so what a plugin
 * prints is shown in the page's console instead, as "[<tag>] ...". With no tab open it goes to the worker's console.
 */
function forwardLog(level, tag, args) {
    let safe;
    try { safe = args.map((a) => printable(a)); } catch { safe = [String(args)]; }
    toTabs({ type: 'nimo-plugin-log', level, tag, args: safe }).then((n) => { if (!n) console[level](`[${tag}]`, ...args); });
}

/** The `console` a plugin sees. */
function pluginConsole(tag) {
    const c = Object.create(console);
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) c[level] = (...args) => forwardLog(level, tag, args);
    c.trace = (...args) => forwardLog('debug', tag, [...args, new Error('trace').stack]);
    return c;
}

function withTimeout(promise, ms, what) {
    let t;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} did not finish after ${ms / 1000} seconds`)), ms); }),
    ]).finally(() => clearTimeout(t));
}

async function loadOne(f) {
    if (f.problem) throw new Error(f.problem);
    if (f.framework > FRAMEWORK_VERSION) throw new Error(`it needs NimoFramework ${f.framework}, this NimoTavern has version ${FRAMEWORK_VERSION}`);
    const code = vfs.readFileSync(f.file, 'utf8');
    const name = path.basename(f.file);
    const module = { exports: {} };
    let run;
    try {
        // Same trust as the extension's browser code (the user accepted it when installing); not a sandbox.
        run = new Function('module', 'exports', 'require', 'nimo', '__dirname', '__filename', 'Buffer', 'process', 'global', 'setImmediate', 'clearImmediate', 'console',
            `${code}\n//# sourceURL=nimoframework/${f.folder}/${name}`);
    } catch (e) {
        if (/^\s*(import\s*[\w{*'"]|export\s+(default|const|function|class|async|\{))/m.test(code)) {
            throw new Error(`${name} is an ES module (it uses import/export). NimoFramework needs CommonJS: use require/module.exports, or build with "esbuild --bundle --format=cjs"`);
        }
        throw new Error(`${name} has a syntax error: ${e?.message || e}`);
    }
    run(module, module.exports, makeRequire(), nimoApi(f), f.dir, f.file, Buffer, process, globalThis, setImmediate, clearImmediate, pluginConsole(f.folder));
    const plugin = module.exports?.default && !module.exports.init ? module.exports.default : module.exports;
    const info = plugin?.info;
    // The same rules as SillyTavern's own plugin loader, so a plugin that loads here loads there too.
    if (!info || typeof info !== 'object') throw new Error('module.exports.info is missing');
    if (typeof info.id !== 'string' || !/^[a-z0-9_-]{1,64}$/.test(info.id)) throw new Error('info.id must be made of lowercase letters, digits, "-" or "_"');
    for (const k of ['name', 'description']) if (typeof info[k] !== 'string') throw new Error(`info.${k} is missing (SillyTavern requires it too)`);
    if (RESERVED.has(info.id)) throw new Error(`the id "${info.id}" is reserved`);
    if (typeof plugin.init !== 'function') throw new Error('module.exports.init is not a function');
    if (loaded.has(info.id)) throw new Error(`another installed extension already uses the plugin id "${info.id}"`);
    const router = express.Router();
    await withTimeout(plugin.init(router), INIT_TIMEOUT, 'init()');
    loaded.set(info.id, { router, exit: typeof plugin.exit === 'function' ? plugin.exit : null, folder: f.folder, name: info.name, description: info.description });
    forwardLog('info', 'NimoFramework', [`loaded "${info.id}" from the extension "${f.folder}": /api/plugins/${info.id}/`]);
}

async function loadAll(extRoot) {
    const found = scan(extRoot);
    const sig = found.map((f) => `${f.folder}:${f.file && !f.problem ? vfs.statSync(f.file).mtimeMs : f.problem}`).join('|') + '#' + disabledExtensions().join(',');
    if (sig === signature) return;
    // Something changed (installed, updated, enabled, disabled): restart all plugins.
    for (const p of loaded.values()) { try { await withTimeout(p.exit?.(), 5000, 'exit()'); } catch { /* */ } }
    loaded.clear();
    errors.clear();
    signature = sig;
    for (const f of found) {
        try { await loadOne(f); } catch (e) {
            // Not a plugin problem: a file has to be fetched first, then the whole request runs again.
            if (e?.message === 'VFS_NEEDS_LOAD') { signature = ''; throw e; }
            const msg = String(e?.message || e);
            errors.set(f.folder, msg);
            forwardLog('error', 'NimoFramework', [`the server part of "${f.folder}" could not start: ${msg}\nGuide: ${WIKI}#debugging`]);
            report(f.folder, msg);
        }
    }
}

function status() {
    return {
        nimotavern: true,
        framework: FRAMEWORK_VERSION,
        relay: !!nimoState.relayEnabled,
        modules: AVAILABLE_MODULES,
        plugins: [...loaded].map(([id, p]) => ({ id, name: p.name, description: p.description, extension: p.folder, url: `/api/plugins/${id}/`, routes: listRoutes(p.router) })),
        errors: [...errors].map(([extension, error]) => ({ extension, error })),
    };
}

/** Mounted at /api/plugins. */
export function frameworkRouter(getExtRoot) {
    return async (req, res, next) => {
        if (nimoState.play) return res.status(404).send('Plugins are turned off on the multiplayer site.');
        try {
            loading ??= loadAll(getExtRoot(req)).finally(() => { loading = null; });
            await loading;
        } catch (e) { if (e?.message === 'VFS_NEEDS_LOAD') throw e; console.error('[NimoFramework]', e); }
        const m = req.path.match(/^\/([^/]+)(\/.*)?$/);
        if (!m) return res.sendStatus(404);
        if (m[1] === 'list') return res.json([...loaded.keys()]);
        if (m[1] === 'status') return res.json(status());
        const p = loaded.get(m[1]);
        if (!p) {
            const why = [...errors].map(([folder, error]) => ` The plugin in "${folder}" could not start: ${error}.`).join('');
            return res.status(404).send(`No plugin "${m[1]}" is loaded.${why} Server plugins only work on NimoTavern when ported to NimoFramework (${WIKI}).`);
        }
        const basePath = req.path, baseUrl = req.baseUrl || '';
        req.path = m[2] || '/';
        req.baseUrl = baseUrl + '/' + m[1];
        const done = (err) => {
            req.path = basePath; req.baseUrl = baseUrl;
            if (err?.message === 'VFS_NEEDS_LOAD') return next(err);
            if (res.headersSent) return undefined;
            if (err) {
                forwardLog('error', 'NimoFramework', [`plugin "${m[1]}" threw in ${req.method} ${m[2] || '/'}:`, err]);
                return res.status(500).send(`[NimoFramework] plugin "${m[1]}" threw: ${String(err?.message || err)}`);
            }
            return res.status(404).send(`[NimoFramework] plugin "${m[1]}" has no route for ${req.method} ${m[2] || '/'}`);
        };
        try { return await p.router.handle(req, res, done); } catch (e) { return done(e); }
    };
}
