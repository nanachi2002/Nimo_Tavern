// Builds the NimoTavern Service Worker (SillyTavern server code running in the browser)
// and the NimoTavern web pages.
import { buildWiki } from './build-wiki.mjs';
import * as esbuild from 'esbuild';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const shim = (f) => path.join(here, 'sw/shims', f);
const BUILD_ID = process.env.NIMO_BUILD || Date.now().toString(36);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const ALIASES = {
    'fs': shim('fs.js'), 'fs/promises': shim('fs-promises.js'),
    'path': require.resolve('path-browserify'), 'path/posix': require.resolve('path-browserify'),
    'express': shim('express.js'),
    'node-fetch': shim('node-fetch.js'),
    'write-file-atomic': shim('write-file-atomic.js'),
    'form-data': shim('form-data.js'),
    'crypto': shim('crypto.js'),
    'readline': shim('readline.js'),
    'os': shim('os.js'),
    'process': shim('process.js'),
    'url': shim('url.js'),
    'buffer': require.resolve('buffer/'),
    'events': require.resolve('events/'),
    'stream': require.resolve('stream-browserify'),
    'stream/promises': shim('stream-promises.js'),
    'util': require.resolve('util/'),
    'string_decoder': require.resolve('string_decoder/'),
    'tiktoken': shim('tiktoken.js'),
};

// Node built-ins and packages that cannot work in a browser: replaced by a no-op proxy.
const STUBS = new Set([
    'http', 'https', 'http2', 'net', 'tls', 'dns', 'dns/promises', 'zlib', 'child_process', 'module', 'worker_threads',
    'v8', 'vm', 'cluster', 'dgram', 'perf_hooks', 'async_hooks', 'inspector', 'tty', 'assert', 'constants', 'querystring',
    'simple-git', 'node-persist', 'archiver', 'command-exists', 'multer', 'cookie-session', 'helmet', 'compression',
    'open', 'yargs', 'yargs/yargs', 'yargs/helpers', 'response-time', 'csrf-sync', 'cors', 'body-parser', 'ws',
    'sillytavern-transformers', '@huggingface/transformers', 'onnxruntime-node', 'sharp', 'vectra', 'wavefile',
    'webpack', 'chokidar', , 'rate-limiter-flexible', 'node-cache', 'http-proxy-agent', 'https-proxy-agent', 'socks-proxy-agent',
    'proxy-agent', 'undici', 'agent-base', 'google-translate-api-x', 'bing-translate-api', 'diff-match-patch',
]);

// SillyTavern source modules replaced by browser versions.
const SRC_REPLACE = new Set(['server-directory.js', 'private-request-filter.js', 'transformers.js', 'jimp.js']);

const nimoPlugin = {
    name: 'nimo',
    setup(build) {
        // Image codecs (@jsquash) locate their .wasm next to import.meta.url: point them at /nimo/wasm/.
        build.onLoad({ filter: /[\\/]@jsquash[\\/].*\.js$/ }, (args) => ({
            // Only rewrite reads: emscripten glue also contains `import.meta.url = "..."` for Node/Workers.
            contents: fs.readFileSync(args.path, 'utf8')
                .replace(/import\.meta\.url\s*=(?!=)/g, 'globalThis.__nimoIgnored =')
                .replace(/import\.meta\.url/g, '(self.location.origin + "/nimo/wasm/codec.js")'),
            loader: 'js',
            resolveDir: path.dirname(args.path),
        }));
        // Tokenizer libs embed their WASM as a base64 data URI: extract it to /nimo/wasm/ (fetched lazily).
        build.onLoad({ filter: /[\\/]@agnai[\\/](web-tokenizers|sentencepiece-js)[\\/].*\.js$/ }, (args) => {
            let src = fs.readFileSync(args.path, 'utf8');
            const name = args.path.includes('web-tokenizers') ? 'web_tokenizers.wasm' : 'sentencepiece.wasm';
            const prefix = '"data:application/octet-stream;base64,';
            const m = /"data:application\/octet-stream;base64,[A-Za-z0-9+/]{1000}/.exec(src); // the payload, not emscripten's prefix constant
            const i = m ? m.index : -1;
            if (i >= 0) {
                const j = src.indexOf('"', i + prefix.length);
                const out = path.join(here, 'dist/public/nimo/wasm');
                fs.mkdirSync(out, { recursive: true });
                fs.writeFileSync(path.join(out, name), Buffer.from(src.slice(i + prefix.length, j), 'base64'));
                // Relative: emscripten's locateFile() prefixes the worker's directory (the site root).
                src = src.slice(0, i) + `"nimo/wasm/${name}"` + src.slice(j + 1);
            }
            // Their script directory must be the site root (not the file:// path we define for SillyTavern code).
            src = src.replace(/import\.meta\.url(?!\s*=[^=])/g, 'self.location.href')
                .replace(/new \(require\('u' \+ 'rl'\)\.URL\)\('file:' \+ __filename\)\.href/g, 'self.location.href');
            // Service Workers have no XMLHttpRequest: load the binary with fetch instead of the sync loader.
            src = src.replace('function getBinaryPromise(binaryFile){return Promise.resolve().then(()=>getBinarySync(binaryFile))}',
                'function getBinaryPromise(binaryFile){return fetch(binaryFile,{credentials:"same-origin"}).then(r=>{if(!r.ok)throw new Error("failed to load "+binaryFile);return r.arrayBuffer()})}');
            return { contents: src, loader: 'js', resolveDir: path.dirname(args.path) };
        });
        // Upstream bug: SentencePieceTokenizer caches its instance before load() succeeds, so a failed
        // first load (e.g. model file not downloaded yet) leaves a broken tokenizer forever.
        build.onLoad({ filter: /[\\/]src[\\/]endpoints[\\/]tokenizers\.js$/ }, (args) => {
            const src = fs.readFileSync(args.path, 'utf8');
            const from = /this\.#instance = new SentencePieceProcessor\(\);\s*await this\.#instance\.load\(pathToModel\);/;
            if (!from.test(src)) throw new Error('tokenizers.js patch target not found (SillyTavern changed?)');
            return {
                contents: src.replace(from, 'const instance = new SentencePieceProcessor(); await instance.load(pathToModel); this.#instance = instance;'),
                loader: 'js', resolveDir: path.dirname(args.path),
            };
        });
        build.onResolve({ filter: /.*/ }, (args) => {
            let id = args.path;
            if (args.kind === 'entry-point') return null;
            if (id.startsWith('node:')) id = id.slice(5);
            if (ALIASES[id]) return { path: ALIASES[id] };
            if (STUBS.has(id)) return { path: shim('stub.js') };
            // SillyTavern's server-directory.js uses import.meta.dirname
            const base = path.basename(id);
            if (SRC_REPLACE.has(base) && args.importer.startsWith(path.join(root, 'src'))) return { path: shim(base) };
            return null;
        });
    },
};

const define = {
    'process.env.NODE_ENV': '"production"',
    'global': 'globalThis',
    '__ST_VERSION__': JSON.stringify(pkg.version),
    '__NIMO_BUILD__': JSON.stringify(BUILD_ID),
    'import.meta.dirname': '"/srv/src"',
    '__filename': '"/srv/src/index.js"',
    '__dirname': '"/srv/src"',
    'import.meta.url': '"file:///srv/src/index.js"',
};

export async function buildSW({ watch = false, minify = true } = {}) {
    const opts = {
        entryPoints: [path.join(here, 'sw/entry.js')],
        bundle: true,
        format: 'iife', // classic worker: widest browser support, no import() in SW
        platform: 'browser',
        target: ['chrome110', 'firefox115', 'safari16'],
        outfile: path.join(here, 'dist/public/nimo-sw.js'),
        plugins: [nimoPlugin],
        define,
        inject: [shim('globals.js')],
        minify,
        sourcemap: false,
        legalComments: 'external',
        logLevel: 'info',
        metafile: true,
        mainFields: ['browser', 'module', 'main'],
        conditions: ['browser', 'import', 'module', 'default'],
        loader: { '.wasm': 'binary' },
    };
    copyWasm();
    await writeTiktokenRanks();
    if (watch) { const ctx = await esbuild.context(opts); await ctx.watch(); return ctx; }
    const r = await esbuild.build(opts);
    fs.writeFileSync(path.join(here, 'dist/sw-meta.json'), JSON.stringify(r.metafile));
    return r;
}

async function writeTiktokenRanks() {
    const out = path.join(here, 'dist/public/nimo/tiktoken');
    fs.mkdirSync(out, { recursive: true });
    for (const name of ['cl100k_base', 'o200k_base', 'p50k_base', 'r50k_base', 'gpt2']) {
        try {
            const mod = await import(`js-tiktoken/ranks/${name}`);
            fs.writeFileSync(path.join(out, name + '.json'), JSON.stringify(mod.default));
        } catch { /* encoding not shipped by js-tiktoken */ }
    }
}

function copyWasm() {
    const out = path.join(here, 'dist/public/nimo/wasm');
    fs.mkdirSync(out, { recursive: true });
    const base = path.join(root, 'node_modules/@jsquash');
    for (const rel of fs.readdirSync(base, { recursive: true })) {
        if (!rel.endsWith('.wasm') || rel.includes('pkg-parallel') || rel.includes('_mt')) continue;
        fs.copyFileSync(path.join(base, rel), path.join(out, path.basename(rel)));
    }
}

export async function buildWeb({ minify = true } = {}) {
    await esbuild.build({
        entryPoints: { 'nimo-auth': path.join(here, 'web/js/auth.js'), 'nimo-boot': path.join(here, 'web/js/boot.js'), 'nimo-account': path.join(here, 'web/js/account.js'), 'nimo-wiki': path.join(here, 'web/js/wiki.js') },
        bundle: true, format: 'iife', platform: 'browser', target: ['chrome110', 'firefox115', 'safari16'],
        outdir: path.join(here, 'dist/public/nimo/js'), minify, logLevel: 'info', loader: { '.wasm': 'binary' },
    });
    buildPages();
    buildWiki();
}

/** Wrap each page body in the shared layout. Pages declare <!--TITLE -->, <!--NAV -->, <!--HEAD --> comments. */
export function buildPages() {
    const layout = fs.readFileSync(path.join(here, 'web/layout.html'), 'utf8');
    const out = path.join(here, 'dist/pages');
    fs.mkdirSync(out, { recursive: true });
    for (const f of fs.readdirSync(path.join(here, 'web/pages'))) {
        let src = fs.readFileSync(path.join(here, 'web/pages', f), 'utf8');
        const take = (k) => { const m = src.match(new RegExp(`<!--${k} ([\\s\\S]*?) -->\\r?\\n?`)); if (m) src = src.replace(m[0], ''); return m ? m[1] : ''; };
        const title = take('TITLE'), nav = take('NAV'), head = take('HEAD');
        const html = layout.replace(/\.(css|js)"/g, '.$1?v={{V}}"').replace('{{TITLE}}', title).replace('{{NAV}}', nav).replace('{{HEAD}}', head.replace('type="module" ', 'defer ').replace(/\.js"/g, '.js?v={{V}}"')).replace('{{BODY}}', src);
        fs.writeFileSync(path.join(out, f), html);
    }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const what = process.argv[2] || 'all';
    fs.mkdirSync(path.join(here, 'dist/public/nimo/js'), { recursive: true });
    fs.writeFileSync(path.join(here, 'dist/build.json'), JSON.stringify({ build: BUILD_ID }));
    if (what === 'sw' || what === 'all') await buildSW({ minify: !process.argv.includes('--dev') });
    if (what === 'web' || what === 'all') await buildWeb({ minify: !process.argv.includes('--dev') });
}
