// NimoTavern Service Worker.
// Runs SillyTavern's server in the user's browser, on top of an encrypted VFS.
import { vfs, NeedsLoadError } from './vfs.js';
import { Store, closeCache } from './store.js';
import { nimoState } from './state.js';
import { loadKeys, wipeLocal } from '../shared/crypto.js';
import { createReq, createRes } from './shims/express.js';
import { Unzip, UnzipInflate } from 'fflate';
import { isOptimizableMultipart, isOptimizableJson, optimizeUploadedFile, optimizeImageBody } from './imgopt.js';

const BUILD = __NIMO_BUILD__;
const STATIC_CACHE = 'nimo-static-' + BUILD;
const DEFAULTS_CACHE = 'nimo-defaults-' + BUILD;
const NIMO_SETTINGS = '/data/default-user/user/nimotavern.json';

let appModule = null; // lazily imported so the SW installs fast
let store = null;
let bootPromise = null;
let bootError = null;

self.addEventListener('install', (e) => { e.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', (e) => {
    e.waitUntil((async () => {
        for (const k of await caches.keys()) if (k.startsWith('nimo-') && k !== STATIC_CACHE && k !== DEFAULTS_CACHE) await caches.delete(k);
        await self.clients.claim();
    })());
});

// ---------------------------------------------------------------------------
// Boot: load keys, decrypt local cache into VFS, sync with server, seed new accounts.

async function loadDefaults() {
    // Shared, public default content (themes, presets, backgrounds, Seraphina...).
    const cache = await caches.open(DEFAULTS_CACHE);
    let r = await cache.match('/nimo-defaults/bundle.json');
    if (!r) {
        r = await fetch('/nimo-defaults/bundle.json', { credentials: 'same-origin' });
        if (!r.ok) throw new Error('Could not load default content');
        await cache.put('/nimo-defaults/bundle.json', r.clone());
    }
    const bundle = await r.json();
    for (const f of bundle.files) {
        const p = f.vfs || (f.path.startsWith('public/') ? '/' + f.path : '/srv/default/' + f.path);
        if (f.text !== undefined) vfs.loadFile(p, new TextEncoder().encode(f.text), 0);
        else vfs.loadRef(p, f.url || '/nimo-defaults/' + f.path, f.size, 0);
    }
    vfs.mkdirSync('/public/scripts/extensions/third-party', { recursive: true });
    vfs.refLoader = async (url) => {
        let res = await cache.match(url);
        if (!res) {
            res = await fetch(url, { credentials: 'same-origin' });
            if (!res.ok) throw new Error('Default asset missing: ' + url);
            await cache.put(url, res.clone());
        }
        return new Uint8Array(await res.arrayBuffer());
    };
}

function loadNimoSettings() {
    try {
        if (vfs.existsSync(NIMO_SETTINGS)) {
            const s = JSON.parse(vfs.readFileSync(NIMO_SETTINGS, 'utf8'));
            nimoState.relayEnabled = !!s.relayEnabled;
            nimoState.relayAlways = !!s.relayAlways;
            nimoState.optimizeImages = s.optimizeImages !== false; // on unless explicitly turned off
        }
    } catch { /* ignore */ }
}

async function boot() {
    const keys = await loadKeys();
    if (!keys?.encKey) throw Object.assign(new Error('locked'), { locked: true });
    nimoState.username = keys.username;
    appModule = appModule || await import('./app.js');
    vfs.persistRoots = ['/data/default-user'];
    const T = [performance.now()]; const mark = (l) => { T.push(performance.now()); console.info(`[nimo boot] ${l}: ${Math.round(T[T.length - 1] - T[T.length - 2])}ms`); };
    await loadDefaults(); mark('defaults');
    appModule.initServerFiles();
    store = new Store(keys);
    store.onAuthError = () => lock(false);
    store.onPull = (got, total) => progress(`Downloading your encrypted tavern… ${mb(got)} / ${mb(total)}`);
    const cached = await store.loadFromCache(); mark(`cache (${cached} blobs)`);
    try { const n = await store.pull(); mark(`pull (${n} changes)`); } catch (e) { if (!cached) throw e; console.warn('[nimo] offline, using local cache', e); }
    let imported = false;
    const me = await fetch('/api/nimo/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    if (me.legacyPending) imported = await importLegacy(me.legacyPending);
    appModule.ensureUserDirectories();
    if (!imported && !vfs.existsSync('/data/default-user/settings.json')) {
        await withRefRetry(() => appModule.seedContent());
    }
    loadNimoSettings();
    // Warm up shared default files needed by the first screen (character cards, avatars).
    const warm = [];
    for (const [p, e] of vfs.files) if (!e.data && e.ref && /^\/data\/default-user\/(characters|User Avatars)\//.test(p)) warm.push(p);
    await vfs.resolveRefs(warm).catch(() => { }); mark('warm');
    await store.flush(); mark(`flush`);
    nimoState.ready = true;
    vfs.listeners.add(scheduleFlush);
    startPeriodicSync();
}

// Mobile browsers (iOS especially) sometimes drop the first IndexedDB connection or the network while a Service Worker starts: try again before giving up.
async function bootWithRetry() {
    let last;
    for (let i = 0; i < 3; i++) {
        try { return await boot(); } catch (e) {
            if (e.locked) throw e;
            last = e;
            console.warn('[nimo] boot attempt ' + (i + 1) + ' failed', e);
            resetMemory();
            closeCache();
            await new Promise(r => setTimeout(r, 600 * (i + 1)));
        }
    }
    throw last;
}

function ensureBooted() {
    if (!bootPromise) {
        bootError = null;
        bootPromise = bootWithRetry().catch((e) => { bootError = e; bootPromise = null; resetMemory(); throw e; });
    }
    return bootPromise;
}

function resetMemory() {
    nimoState.ready = false;
    vfs.files.clear(); vfs.dirs = new Set(['/']); vfs.dirty.clear(); vfs.listeners.clear();
    store = null;
}

async function lock(wipe) {
    try { if (store && vfs.dirty.size && !wipe) await store.flush(); } catch { /* ignore */ }
    resetMemory();
    bootPromise = null;
    closeCache();
    if (wipe) await wipeLocal();
    for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'nimo-locked' });
}

self.addEventListener('nimo-logout', () => { lock(true); });

// ---------------------------------------------------------------------------
// Import of an account migrated from the previous SillyTavern server.

async function progress(text) {
    for (const c of await self.clients.matchAll({ type: 'window', includeUncontrolled: true })) c.postMessage({ type: 'nimo-progress', text });
}
const mb = (n) => (n / 1048576).toFixed(n > 10485760 ? 0 : 1) + ' MB';

async function importLegacy(expectedSize) {
    const r = await fetch('/api/nimo/legacy/archive', { credentials: 'same-origin' });
    if (r.status === 404) return false;
    if (!r.ok) throw new Error('Could not download your SillyTavern data (' + r.status + ')');
    const total = Number(r.headers.get('content-length')) || expectedSize;
    const root = '/data/default-user/';
    const td = new TextDecoder();
    let manifest = null, files = 0, received = 0, lastReport = 0;
    const unzip = new Unzip((file) => {
        if (file.name.endsWith('/')) { vfs.mkdirSync(root + file.name, { recursive: true }); return; }
        const chunks = [];
        file.ondata = (err, data, final) => {
            if (err) throw err;
            chunks.push(data);
            if (!final) return;
            let len = 0; for (const c of chunks) len += c.length;
            const out = new Uint8Array(len); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
            if (file.name === 'nimo-manifest.json') { manifest = JSON.parse(td.decode(out)); return; }
            const p = root + file.name;
            vfs.mkdirSync(p.slice(0, p.lastIndexOf('/')), { recursive: true });
            vfs.writeFileSync(p, out);
            files++;
        };
        file.start();
    });
    unzip.register(UnzipInflate);
    const reader = r.body.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        unzip.push(value);
        if (Date.now() - lastReport > 400) { lastReport = Date.now(); progress(`Downloading your SillyTavern data… ${mb(received)} / ${mb(total)}`); }
    }
    unzip.push(new Uint8Array(0), true);
    // Files identical to SillyTavern's default content are shared references, not copies.
    for (const ref of manifest?.refs || []) {
        vfs.loadRef(root + ref.path, '/nimo-defaults/' + ref.default, ref.size, Date.now());
        vfs.markDirty(vfs.norm(root + ref.path));
    }
    // Encrypt and upload everything before deleting the plaintext copy on the server.
    const toUpload = vfs.dirty.size;
    store.uploadedBytes = 0;
    store.onUpload = (n) => progress(`Encrypting and uploading… ${mb(n)} / ~${mb(total)}`);
    progress(`Encrypting and uploading ${toUpload} files…`);
    for (let attempt = 0; vfs.dirty.size && attempt < 5; attempt++) {
        await store.flush();
        if (store.lastError?.quota) throw store.lastError;
    }
    store.onUpload = null;
    if (vfs.dirty.size) throw new Error('Upload incomplete, log in again to resume');
    await fetch('/api/nimo/legacy/finish', { method: 'POST', credentials: 'same-origin', headers: { 'X-Nimo-Client': 'sw' } });
    progress(`Imported ${files + (manifest?.refs?.length || 0)} files.`);
    return true;
}

let flushTimer = null;
function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => store?.flush().then(broadcastPending), 150);
    broadcastPending();
}

// Tell open tabs whether encrypted writes are still uploading (they warn before closing).
let lastPending = -1, pendingTimer = null;
function broadcastPending() {
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(async () => {
        const n = vfs.dirty.size + (store?.uploading ? 1 : 0);
        if ((n > 0) === (lastPending > 0)) return;
        lastPending = n;
        for (const c of await self.clients.matchAll({ type: 'window' })) c.postMessage({ type: 'nimo-pending', n });
    }, 50);
}

let syncTimer = null;
function startPeriodicSync() {
    clearInterval(syncTimer);
    // Picks up changes made on the user's other devices while this one is open.
    syncTimer = setInterval(() => { if (store && nimoState.ready) store.pull().catch(() => { }); }, 60_000);
}

async function withRefRetry(fn, max = 25) {
    for (let i = 0; ; i++) {
        try { return await fn(); } catch (e) {
            if (e instanceof NeedsLoadError && i < max) { await vfs.resolveRefs(e.paths); continue; }
            throw e;
        }
    }
}

// ---------------------------------------------------------------------------
// Request handling

const APP_PREFIXES = ['/api/', '/thumbnail', '/backgrounds/', '/characters/', '/User%20Avatars/', '/User Avatars/', '/assets/', '/user/images/', '/user/files/', '/scripts/extensions/third-party/'];
const APP_EXACT = ['/csrf-token', '/version'];

function isAppPath(p) {
    if (p.startsWith('/api/nimo/')) return false; // real NimoTavern server API
    return APP_EXACT.includes(p) || APP_PREFIXES.some(x => p.startsWith(x));
}

async function parseBody(request) {
    if (request.method === 'GET' || request.method === 'HEAD') return { body: {} };
    const ct = request.headers.get('content-type') || '';
    const pathname = new URL(request.url).pathname;
    if (ct.includes('application/json')) {
        const t = await request.text();
        let body;
        try { body = t ? JSON.parse(t) : {}; } catch { return { body: {}, bad: true }; }
        // Chat / generated pictures arrive as base64: store PNG/JPEG as WebP (smaller encrypted blobs).
        if (nimoState.optimizeImages && isOptimizableJson(pathname)) await optimizeImageBody(body);
        return { body };
    }
    if (ct.includes('multipart/form-data')) {
        const fd = await request.formData();
        const body = {}; let file;
        for (const [k, v] of fd.entries()) {
            if (typeof v === 'string') body[k] = v;
            else if (!file) {
                const name = crypto.randomUUID().replace(/-/g, '');
                const p = '/data/_uploads/' + name;
                let bytes = new Uint8Array(await v.arrayBuffer());
                let originalname = v.name, mimetype = v.type;
                // Backgrounds and sprites: PNG/JPEG -> WebP (the extension is rewritten with it).
                if (nimoState.optimizeImages && isOptimizableMultipart(pathname)) {
                    const o = await optimizeUploadedFile(bytes, v.name);
                    if (o) ({ bytes, name: originalname, type: mimetype } = o);
                }
                vfs.writeFileSync(p, bytes);
                file = { fieldname: k, originalname, encoding: '7bit', mimetype, destination: '/data/_uploads', filename: name, path: p, size: bytes.length };
            }
        }
        return { body, file };
    }
    if (ct.includes('application/x-www-form-urlencoded')) return { body: Object.fromEntries(new URLSearchParams(await request.text())) };
    const buf = await request.arrayBuffer();
    return { body: buf.byteLength ? new TextDecoder().decode(buf) : {} };
}

function json(status, obj) { return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } }); }

async function handleApp(request) {
    try { await ensureBooted(); } catch (e) {
        if (e.locked) return json(401, { error: 'locked', nimo: 'login-required' });
        return json(503, { error: 'NimoTavern failed to start: ' + e.message });
    }
    const url = new URL(request.url);
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const { body, file, bad } = await parseBody(request);
    if (bad) return new Response('Bad JSON', { status: 400 });

    for (let attempt = 0; attempt < 25; attempt++) {
        const req = createReq({ method: request.method, url: url.href, headers, body, file, user: null, signal: request.signal });
        const res = createRes(req);
        let thrown = null;
        vfs.misses.clear();
        const writes0 = vfs.writeCount;
        const done = appModule.app.handle(req, res, (err) => {
            if (err) thrown = err;
            else if (!res.isStarted()) res.sendStatus(404);
        }).catch((e) => { thrown = e; });

        // Wait for the handler (or for a streaming response to begin).
        await Promise.race([done, res.responsePromise.then(() => { if (!res.isStreaming) return done; })]);
        if (!res.isStarted() && !thrown) await res.responsePromise;

        // A default (shared) file was needed but not downloaded yet. If the handler hasn't written
        // anything, it's safe to fetch the file(s) and run the request again.
        const misses = thrown instanceof NeedsLoadError ? thrown.paths : [...vfs.misses];
        if (misses.length && !res.isStreaming && vfs.writeCount === writes0) {
            await vfs.resolveRefs(misses);
            continue;
        }
        if (misses.length) { console.warn('[nimo] unresolved refs (no retry)', url.pathname, misses.join(', ')); vfs.resolveRefs(misses).catch(() => { }); }
        if (thrown && !res.isStarted()) {
            console.error('[nimo] handler error', url.pathname, thrown);
            return new Response(String(thrown?.message || thrown), { status: 500 });
        }
        if (file && vfs.existsSync(file.path)) { try { vfs.unlinkSync(file.path); } catch { /* */ } }
        return res.responsePromise;
    }
    return new Response('Too many lazy loads', { status: 500 });
}

// Local-only endpoints used by the injected NimoTavern UI.
async function handleLocal(request) {
    const url = new URL(request.url);
    if (url.pathname === '/api/nimo-local/status') {
        const keys = await loadKeys();
        if (!keys?.encKey) return json(200, { unlocked: false });
        try { await ensureBooted(); } catch (e) { return json(200, { unlocked: false, error: e.message }); }
        return json(200, { unlocked: true, ready: nimoState.ready, username: nimoState.username, relayEnabled: nimoState.relayEnabled, relayAlways: nimoState.relayAlways, optimizeImages: nimoState.optimizeImages, quota: store?.quota, pending: vfs.dirty.size });
    }
    if (url.pathname === '/api/nimo-local/settings' && request.method === 'POST') {
        await ensureBooted();
        const s = await request.json();
        // Each setting is only changed when present, so one toggle can't reset the others.
        if ('relayEnabled' in s) {
            nimoState.relayEnabled = !!s.relayEnabled;
            nimoState.relayAlways = !!s.relayEnabled && !!s.relayAlways;
        }
        if ('optimizeImages' in s) nimoState.optimizeImages = !!s.optimizeImages;
        vfs.writeFileSync(NIMO_SETTINGS, JSON.stringify({ relayEnabled: nimoState.relayEnabled, relayAlways: nimoState.relayAlways, optimizeImages: nimoState.optimizeImages }));
        await store.flush();
        return json(200, { ok: true });
    }
    if (url.pathname === '/api/nimo-local/sync' && request.method === 'POST') {
        await ensureBooted();
        await store.flush();
        const n = await store.pull();
        return json(200, { ok: true, changes: n });
    }
    if (url.pathname === '/api/nimo-local/lock' && request.method === 'POST') {
        await lock(true);
        return json(200, { ok: true });
    }
    return json(404, { error: 'unknown' });
}

async function handleStatic(request) {
    // Cache-first for SillyTavern's static assets: versioned per build, so updates are atomic.
    const cache = await caches.open(STATIC_CACHE);
    const hit = await cache.match(request, { ignoreSearch: false });
    if (hit) return hit;
    // Per-build query string: a fresh cache key at the CDN and in the browser HTTP cache for each release.
    const u = new URL(request.url);
    u.searchParams.set('nimo_v', BUILD);
    const r = await fetch(u, { credentials: 'same-origin' });
    if (r.ok && r.type === 'basic') cache.put(request, r.clone()).catch(() => { });
    return r;
}

// ---------------------------------------------------------------------------
// Security: the SW acts on the user's decrypted data without cookies or CSRF tokens, so it must only
// obey requests made by our own pages.
//  * A navigation (link, form submit, window.open, iframe) can be started by ANY website, e.g. a hidden
//    <form method=post action="https://nimorp.lol/api/settings/save">. Such requests never reach the
//    tavern's API: only plain GET navigations to user files are allowed.
//  * Anything the SW serves as a document (a user file opened in a tab) is sandboxed with a strict CSP,
//    so an .html/.svg smuggled in by a character card can't run script on our origin.
const DOC_CSP = "sandbox; default-src 'none'; img-src 'self' data: blob:; media-src 'self' data: blob:; style-src 'unsafe-inline'; font-src 'self' data:";
const NAV_ALLOWED = ['/backgrounds/', '/characters/', '/User%20Avatars/', '/User Avatars/', '/assets/', '/user/images/', '/user/files/'];
const isDocumentRequest = (r) => r.mode === 'navigate' || ['document', 'iframe', 'frame', 'object', 'embed'].includes(r.destination);

function harden(response, asDocument) {
    if (!response || response.type === 'opaque' || response.type === 'error') return response;
    const h = new Headers(response.headers);
    h.set('X-Content-Type-Options', 'nosniff');
    if (asDocument) {
        h.set('Content-Security-Policy', DOC_CSP);
        h.set('Cross-Origin-Resource-Policy', 'same-origin');
        // Anything that isn't plainly a picture/sound/video is downloaded instead of rendered.
        if (!/^(image\/(?!svg)|audio\/|video\/|text\/plain)/i.test(h.get('Content-Type') || '')) h.set('Content-Disposition', 'attachment');
    }
    const nullBody = [101, 204, 205, 304].includes(response.status);
    return new Response(nullBody ? null : response.body, { status: response.status, statusText: response.statusText, headers: h });
}

function refuseNavigation() {
    return new Response('Blocked: this address can only be used by the NimoTavern app itself.', { status: 403, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' } });
}

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // never touch cross-origin traffic
    const p = url.pathname;
    const isDoc = isDocumentRequest(request);
    const handled = p.startsWith('/api/nimo-local/') || isAppPath(p);

    if (handled && isDoc && (request.method !== 'GET' || !NAV_ALLOWED.some((x) => p.startsWith(x)))) {
        event.respondWith(refuseNavigation());
        return;
    }
    if (p.startsWith('/api/nimo-local/')) { event.respondWith(handleLocal(request).then((r) => harden(r, false))); return; }
    if (isAppPath(p)) {
        event.respondWith(handleApp(request).then((r) => harden(r, isDoc)).then((r) => {
            // Make sure writes are encrypted+uploaded even if the SW would otherwise be stopped.
            if (store && vfs.dirty.size) event.waitUntil(store.flush().then(broadcastPending)); // upload right away; flushes are serialized so bursts batch up
            return r;
        }));
        return;
    }
    if (request.method !== 'GET' || request.mode === 'navigate' || p.startsWith('/api/nimo/') || p === '/nimo-sw.js' || p.startsWith('/nimo/') || p.startsWith('/nimo-defaults/')) return;
    if (/\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|woff2?|ttf|ico|json|html|mp3|wav|ogg)$/i.test(p)) event.respondWith(handleStatic(request));
});

self.addEventListener('message', (event) => {
    const d = event.data || {};
    if (d.type === 'nimo-unlock') {
        event.waitUntil(ensureBooted().then(
            () => event.source?.postMessage({ type: 'nimo-ready' }),
            (e) => event.source?.postMessage({ type: 'nimo-error', error: e.message + (e.locked ? '' : ' @ ' + String(e.stack).split('\n').slice(1, 6).join(' | ')), locked: !!e.locked }),
        ));
    }
    if (d.type === 'nimo-lock') event.waitUntil(lock(!!d.wipe));
    if (d.type === 'nimo-flush') event.waitUntil(store?.flush());
});
