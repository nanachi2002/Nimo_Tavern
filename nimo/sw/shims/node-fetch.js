// node-fetch shim: requests go straight from the user's browser to the AI provider.
// If a provider blocks browser requests (CORS) and the user has explicitly opted in,
// the request is retried through NimoTavern's stateless relay (/api/nimo/relay),
// which streams bytes through without logging or storing anything.
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import { nimoState } from '../state.js';

const nativeFetch = self.fetch.bind(self);

export class AbortError extends Error { constructor(m) { super(m); this.name = 'AbortError'; this.type = 'aborted'; } }
export class FetchError extends Error { constructor(m, type) { super(m); this.name = 'FetchError'; this.type = type; } }

function normalizeBody(body) {
    if (body == null) return body;
    if (typeof body === 'string' || body instanceof Blob || body instanceof FormData || body instanceof URLSearchParams || body instanceof ReadableStream) return body;
    if (body.__nimoFormData) return body.__nimoFormData;
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) return body;
    if (typeof body.pipe === 'function') throw new Error('Node stream request bodies are not supported in NimoTavern');
    return String(body);
}

function normalizeHeaders(h) {
    const out = new Headers();
    if (!h) return out;
    if (h instanceof Headers) return h;
    const entries = Array.isArray(h) ? h : Object.entries(h);
    for (const [k, v] of entries) {
        if (v === undefined || v === null) continue;
        const lk = k.toLowerCase();
        // Browsers forbid / manage these; setting them throws or is ignored.
        if (['host', 'content-length', 'connection', 'user-agent', 'accept-encoding', 'origin', 'referer', 'cookie', 'keep-alive', 'transfer-encoding'].includes(lk)) continue;
        out.set(k, String(v));
    }
    return out;
}

function isPrivateHost(url) {
    try {
        const h = new URL(url).hostname;
        return h === 'localhost' || h.endsWith('.localhost') || /^127\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^\[?::1\]?$|^169\.254\./.test(h);
    } catch { return false; }
}

// Anthropic requires an explicit opt-in header for browser-originated requests.
function providerTweaks(url, headers) {
    try {
        const host = new URL(url).hostname;
        if (host === 'api.anthropic.com') headers.set('anthropic-dangerous-direct-browser-access', 'true');
    } catch { /* ignore */ }
}

function wrapBody(webStream) {
    if (!webStream) return null;
    const em = new EventEmitter();
    const reader = webStream.getReader();
    let started = false, destroyed = false;
    const pump = async () => {
        if (started) return; started = true;
        try {
            while (!destroyed) {
                const { done, value } = await reader.read();
                if (done) break;
                em.emit('data', Buffer.from(value));
            }
            em.emit('end');
            em.emit('close');
        } catch (e) {
            if (!destroyed) em.emit('error', e);
        }
    };
    em.on('newListener', (ev) => { if (ev === 'data' || ev === 'end') queueMicrotask(pump); });
    em.pipe = (dest) => {
        em.on('data', (c) => dest.write(c));
        em.on('end', () => dest.end());
        queueMicrotask(pump);
        return dest;
    };
    em.destroy = () => { destroyed = true; try { reader.cancel(); } catch { /* */ } };
    em.cancel = em.destroy;
    em.getReader = () => reader;
    em.readable = true;
    em[Symbol.asyncIterator] = async function* () {
        started = true;
        while (true) {
            const { done, value } = await reader.read();
            if (done) return;
            yield Buffer.from(value);
        }
    };
    return em;
}

function wrapResponse(r) {
    // Expose node-fetch-compatible API on top of the web Response.
    const out = {
        ok: r.ok, status: r.status, statusText: r.statusText, url: r.url, redirected: r.redirected, type: r.type,
        headers: r.headers,
        _r: r,
        get body() { if (!this._body) this._body = wrapBody(r.body); return this._body; },
        text: () => r.text(),
        json: () => r.json(),
        arrayBuffer: () => r.arrayBuffer(),
        blob: () => r.blob(),
        formData: () => r.formData(),
        buffer: async () => Buffer.from(await r.arrayBuffer()),
        clone: () => wrapResponse(r.clone()),
    };
    out.headers.raw = () => { const o = {}; r.headers.forEach((v, k) => { o[k] = [v]; }); return o; };
    return out;
}

async function viaRelay(url, init) {
    const headers = new Headers(init.headers);
    headers.set('X-Nimo-Target', url);
    headers.set('X-Nimo-Relay', '1');
    return nativeFetch('/api/nimo/relay', { ...init, headers, credentials: 'same-origin' });
}

export default async function fetch(input, opts = {}) {
    let url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    if (url.startsWith('/')) url = self.location.origin + url;
    const headers = normalizeHeaders(opts.headers);
    providerTweaks(url, headers);
    const init = {
        method: opts.method || 'GET',
        headers,
        body: normalizeBody(opts.body),
        signal: opts.signal,
        redirect: opts.redirect || 'follow',
        credentials: 'omit', // never send NimoTavern cookies to third parties
        mode: 'cors',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
    };
    if (init.body instanceof ReadableStream) init.duplex = 'half';

    // Never relay to private addresses (SSRF protection; the relay refuses them anyway).
    const relayAllowed = nimoState.relayEnabled && !isPrivateHost(url) && new URL(url).origin !== self.location.origin;
    let r;
    if (relayAllowed && nimoState.relayAlways) {
        r = await viaRelay(url, init);
    } else {
        try {
            r = await nativeFetch(url, init);
        } catch (e) {
            if (e?.name === 'AbortError') throw new AbortError('The operation was aborted.');
            if (relayAllowed) {
                r = await viaRelay(url, init);
            } else {
                const hint = isPrivateHost(url)
                    ? 'Make sure your local backend is running and allows CORS from this site.'
                    : 'This provider blocked a direct browser request (CORS). You can enable the optional NimoTavern relay in User Settings > NimoTavern Privacy.';
                throw new FetchError(`Request to ${new URL(url).host} failed: ${e?.message || e}. ${hint}`, 'system');
            }
        }
    }
    return wrapResponse(r);
}

export const Headers_ = self.Headers;
export { Headers_ as Headers };
export const Request = self.Request;
export const Response = self.Response;
export function isRedirect(c) { return [301, 302, 303, 307, 308].includes(c); }
