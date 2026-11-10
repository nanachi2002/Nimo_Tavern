// Helpers shared by NimoTavern pages.
import { loadKeys, saveKeys, wipeLocal, deriveWorkingKeys, unwrapDek, derivePasswordKeys, unb64 } from '../../shared/crypto.js';

export async function api(path, body, method = body ? 'POST' : 'GET') {
    const r = await fetch('/api/nimo' + path, {
        method,
        credentials: 'same-origin',
        headers: { 'X-Nimo-Client': 'web', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await r.json(); } catch { /* empty */ }
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status, data });
    return data;
}

// In-app browsers on iOS (Discord, Instagram, Messenger...) expose navigator.serviceWorker as undefined.
export function swSupported() { return !!navigator.serviceWorker && typeof navigator.serviceWorker.register === 'function' && !!self.indexedDB && !!self.crypto?.subtle; }

export function unsupportedMessage() {
    const ua = navigator.userAgent;
    const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const inApp = /FBAN|FBAV|Instagram|Discord|Line\/|Snapchat|Twitter|TikTok|musical_ly|GSA\//.test(ua) || (ios && !/Safari\//.test(ua));
    if (inApp || ios) return 'This browser can\'t run NimoTavern. If you opened the link from an app (Discord, Instagram, Messenger…), tap the ••• or share button and choose "Open in Safari" (or Chrome), then log in again. Private browsing can also block it.';
    return 'Your browser doesn\'t support the features NimoTavern needs (Service Workers, IndexedDB, WebCrypto). Use an up-to-date Firefox, Chrome, Edge or Safari, outside private browsing.';
}

/** Registers the NimoTavern Service Worker and resolves once it controls this page. */
export async function ensureServiceWorker() {
    if (!swSupported()) throw new Error('Your browser doesn\'t support the features NimoTavern needs (Service Workers, IndexedDB, WebCrypto). Try an up-to-date Firefox, Chrome or Safari, outside private browsing.');
    const reg = await navigator.serviceWorker.register('/nimo-sw.js', { scope: '/', updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
        await new Promise((res) => {
            navigator.serviceWorker.addEventListener('controllerchange', res, { once: true });
            setTimeout(res, 3000);
        });
    }
    return reg;
}

export function swMessage(msg, expect, timeout = 120000) {
    return new Promise((resolve, reject) => {
        const sw = navigator.serviceWorker.controller || null;
        // After logout / account deletion the server's Clear-Site-Data already removed the Service Worker:
        // a fire-and-forget message has nobody to go to (waiting for `ready` would hang forever).
        if (!sw && !expect) { resolve(); return; }
        const target = sw || (navigator.serviceWorker.ready.then(r => r.active));
        const onMsg = (e) => {
            if (!expect) return;
            if (expect.includes(e.data?.type)) { cleanup(); e.data.type === 'nimo-error' ? reject(new Error(e.data.error)) : resolve(e.data); }
        };
        const cleanup = () => { navigator.serviceWorker.removeEventListener('message', onMsg); clearTimeout(t); };
        const t = setTimeout(() => { cleanup(); reject(new Error('Timed out waiting for NimoTavern to start')); }, timeout);
        navigator.serviceWorker.addEventListener('message', onMsg);
        Promise.resolve(target).then(w => { w.postMessage(msg); if (!expect) { cleanup(); resolve(); } });
    });
}

/** Store working keys locally (wiping any other user's local data first) and start the tavern. */
/** Shared computers: drop anything a previous session (or one of its extensions) may have left in the browser. */
async function cleanBrowserLeftovers() {
    try {
        for (const r of await navigator.serviceWorker.getRegistrations()) {
            const script = (r.active || r.waiting || r.installing)?.scriptURL || '';
            if (r.scope !== location.origin + '/' || !script.startsWith(location.origin + '/nimo-sw.js')) await r.unregister();
        }
    } catch { /* */ }
    try { for (const k of await caches.keys()) await caches.delete(k); } catch { /* */ }
}

export async function unlockWithDek(dek, username) {
    const prev = await loadKeys();
    await cleanBrowserLeftovers();
    await ensureServiceWorker();
    if (prev && prev.username?.toLowerCase() !== username.toLowerCase()) {
        await swMessage({ type: 'nimo-lock', wipe: true });
        await wipeLocal();
    } else {
        await swMessage({ type: 'nimo-lock', wipe: false });
    }
    const { encKey, idKey } = await deriveWorkingKeys(dek);
    dek.fill(0);
    await saveKeys({ encKey, idKey, username, savedAt: Date.now() });
    await swMessage({ type: 'nimo-unlock' }, ['nimo-ready', 'nimo-error'], 60 * 60_000); // imports of big accounts can take a while
}

export async function passwordProof(username, password) {
    const pre = await api('/auth/prelogin', { username });
    return derivePasswordKeys(username, password, unb64(pre.salt), pre.kdf);
}

export async function unwrapWithPassword(kek, wrappedPw) { return unwrapDek(kek, wrappedPw); }

export function showError(el, msg) { el.textContent = msg; el.classList.toggle('show', !!msg); }

export function strengthMeter(input, bar) {
    input.addEventListener('input', () => {
        const v = input.value;
        let s = Math.min(v.length, 24) / 24 * 60;
        if (/[a-z]/.test(v) && /[A-Z]/.test(v)) s += 10;
        if (/\d/.test(v)) s += 10;
        if (/[^a-zA-Z0-9]/.test(v)) s += 10;
        if (/\s/.test(v) && v.length >= 16) s += 10;
        s = Math.min(100, s);
        bar.style.width = s + '%';
        bar.style.backgroundColor = s < 40 ? '#c0392b' : s < 70 ? '#e1a224' : '#58b600';
    });
}

export function showPhrase(panel, phrase, filenameUser) {
    const box = panel.querySelector('#phrase');
    box.innerHTML = '';
    for (const w of phrase.split(' ')) { const s = document.createElement('span'); s.textContent = w; box.append(s); }
    panel.querySelector('#copy-phrase')?.addEventListener('click', async (e) => {
        await navigator.clipboard.writeText(phrase);
        e.currentTarget.innerHTML = '<i class="fa-solid fa-check"></i> Copied';
    });
    panel.querySelector('#download-phrase')?.addEventListener('click', () => {
        const blob = new Blob([`NimoTavern recovery phrase\nUsername: ${filenameUser}\n\n${phrase}\n\nKeep this file private. Anyone with this phrase and your username can take over your account.\n`], { type: 'text/plain' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `nimotavern-recovery-${filenameUser}.txt`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const chk = panel.querySelector('#saved-phrase');
    const btn = panel.querySelector('#enter-tavern');
    chk?.addEventListener('change', () => { btn.disabled = !chk.checked; });
}
