// What a ported plugin can require() in NimoFramework.
// One list, used by the framework itself (sw/framework.js) and by the "port check" tool on the wiki
// (web/js/wiki.js), so the documentation can never disagree with what really runs.

/** Modules NimoFramework provides: require() them without bundling. */
export const PROVIDED = [
    'express', 'node-fetch',
    'fs', 'fs/promises', 'path', 'path/posix', 'crypto', 'os', 'url', 'querystring',
    'buffer', 'events', 'stream', 'stream/promises', 'string_decoder', 'readline',
    'util', 'assert', 'timers', 'timers/promises', 'perf_hooks', 'process', 'console', 'tty',
];

/** Modules that can never work in a browser, and what to do instead. */
export const IMPOSSIBLE = {
    child_process: 'A browser cannot start programs. Call a web API with nimo.fetch instead.',
    worker_threads: 'Not available. Keep the work inside your route handler.',
    cluster: 'Not available in a browser.',
    net: 'Raw sockets do not exist in a browser. Use nimo.fetch (HTTP) instead.',
    tls: 'Raw sockets do not exist in a browser. Use nimo.fetch (HTTPS) instead.',
    dgram: 'UDP does not exist in a browser.',
    dns: 'DNS lookups are not available in a browser.',
    http: 'Use nimo.fetch (or require("node-fetch")) instead of http.request. You cannot listen on a port: your routes are your server.',
    https: 'Use nimo.fetch (or require("node-fetch")) instead of https.request.',
    http2: 'Use nimo.fetch instead.',
    zlib: 'Bundle a pure-JavaScript library such as "fflate" or "pako" into server.cjs.',
    vm: 'Not available in a browser.',
    module: 'Not available. Bundle your dependencies into server.cjs.',
    ws: 'A browser cannot open a WebSocket server. The global WebSocket client is available.',
    sqlite3: 'Native addons cannot run in a browser. Use nimo.storage, or bundle a WebAssembly build such as "sql.js".',
    'better-sqlite3': 'Native addons cannot run in a browser. Use nimo.storage, or bundle a WebAssembly build such as "sql.js".',
    sharp: 'Native addons cannot run in a browser. Use OffscreenCanvas and createImageBitmap, which are available here.',
    canvas: 'Native addons cannot run in a browser. Use OffscreenCanvas, which is available here.',
    puppeteer: 'A browser cannot drive another browser.',
    playwright: 'A browser cannot drive another browser.',
    'simple-git': 'A browser cannot run git. Read GitHub through its web API with nimo.fetch.',
    multer: 'Not needed: uploaded files are already parsed. Read req.file and req.body.',
    'body-parser': 'Not needed: request bodies are already parsed. Read req.body.',
};

/** Other Node.js built-ins that have no browser version. */
export const NODE_ONLY = [
    'async_hooks', 'constants', 'diagnostics_channel', 'dns/promises', 'domain', 'inspector', 'punycode', 'repl',
    'sys', 'trace_events', 'v8', 'wasi',
];

/** "node:fs" -> "fs" */
export const bare = (id) => String(id).replace(/^node:/, '');

/** "lodash/get" -> "lodash", "@scope/pkg/file" -> "@scope/pkg" */
export function packageName(id) {
    const parts = bare(id).split('/');
    return parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * What NimoFramework does with require(id).
 * @returns {{ kind: 'provided' | 'impossible' | 'node' | 'local' | 'package', hint: string }}
 */
export function explain(id) {
    const key = bare(id);
    if (PROVIDED.includes(key)) return { kind: 'provided', hint: 'Provided by NimoFramework.' };
    if (/^\.{0,2}\//.test(key)) return { kind: 'local', hint: 'One of your own files: bundle it into server.cjs with esbuild.' };
    const impossible = IMPOSSIBLE[key] ?? IMPOSSIBLE[packageName(key)];
    if (impossible) return { kind: 'impossible', hint: impossible };
    if (NODE_ONLY.includes(key)) return { kind: 'node', hint: 'This Node.js module has no browser version.' };
    return { kind: 'package', hint: 'If it is a pure-JavaScript package, bundle it into server.cjs with esbuild.' };
}
