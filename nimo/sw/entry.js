// NimoTavern Service Worker.
// Runs SillyTavern's server in the user's browser, on top of an encrypted VFS.
import { vfs, NeedsLoadError } from './vfs.js';
import { Store, closeCache } from './store.js';
import { nimoState } from './state.js';
import { loadKeys, wipeLocal } from '../shared/crypto.js';
import { createReq, createRes } from './shims/express.js';

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
        }
    } catch { /* ignore */ }
}

async function boot() {
    const keys = await loadKeys();
    if (!keys?.encKey) throw Object.assign(new Error('locked'), { locked: true });
    nimoState.username = keys.username;
    appModule = appModule || await import('./app.js');
    vfs.persistRoots = ['/data/default-user'];
    await loadDefaults();
    appModule.initServerFiles();
    store = new Store(keys);
    store.onAuthError = () => lock(false);
    const cached = await store.loadFromCache();
    try { await store.pull(); } catch (e) { if (!cached) throw e; console.warn('[nimo] offline, using local cache', e); }
    appModule.ensureUserDirectories();
    if (!vfs.existsSync('/data/default-user/settings.json')) {
        await withRefRetry(() => appModule.seedContent());
    }
    loadNimoSettings();
    // Warm up shared default files needed by the first screen (character cards, avatars).
    const warm = [];
    for (const [p, e] of vfs.files) if (!e.data && e.ref && /^\/data\/default-user\/(characters|User Avatars)\//.test(p)) warm.push(p);
    await vfs.resolveRefs(warm).catch(() => { });
    await store.flush();
    nimoState.ready = true;
    vfs.listeners.add(scheduleFlush);
    startPeriodicSync();
}

function ensureBooted() {
    if (!bootPromise) {
        bootError = null;
        bootPromise = boot().catch((e) => { bootError = e; bootPromise = null; resetMemory(); throw e; });
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
    if (ct.includes('application/json')) {
        const t = await request.text();
        try { return { body: t ? JSON.parse(t) : {} }; } catch { return { body: {}, bad: true }; }
    }
    if (ct.includes('multipart/form-data')) {
        const fd = await request.formData();
        const body = {}; let file;
        for (const [k, v] of fd.entries()) {
            if (typeof v === 'string') body[k] = v;
            else if (!file) {
                const name = crypto.randomUUID().replace(/-/g, '');
                const p = '/data/_uploads/' + name;
                vfs.writeFileSync(p, new Uint8Array(await v.arrayBuffer()));
                file = { fieldname: k, originalname: v.name, encoding: '7bit', mimetype: v.type, destination: '/data/_uploads', filename: name, path: p, size: v.size };
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
        return json(200, { unlocked: true, ready: nimoState.ready, username: nimoState.username, relayEnabled: nimoState.relayEnabled, relayAlways: nimoState.relayAlways, quota: store?.quota, pending: vfs.dirty.size });
    }
    if (url.pathname === '/api/nimo-local/settings' && request.method === 'POST') {
        await ensureBooted();
        const s = await request.json();
        nimoState.relayEnabled = !!s.relayEnabled;
        nimoState.relayAlways = !!s.relayEnabled && !!s.relayAlways;
        vfs.writeFileSync(NIMO_SETTINGS, JSON.stringify({ relayEnabled: nimoState.relayEnabled, relayAlways: nimoState.relayAlways }));
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

self.addEventListener('fetch', (event) => {
    const request = event.request;
    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return; // never touch cross-origin traffic
    const p = url.pathname;

    if (p.startsWith('/api/nimo-local/')) { event.respondWith(handleLocal(request)); return; }
    if (isAppPath(p)) {
        event.respondWith(handleApp(request).then((r) => {
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
