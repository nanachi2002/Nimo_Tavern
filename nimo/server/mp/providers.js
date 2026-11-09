// AI providers for multiplayer sessions (the host's own multiplayer key, used by the server).
// Every request goes through the same guard as the relay: public https:// addresses only (DNS checked at
// connect time). Nothing is logged: errors carry only the provider's status code and its error message.
import https from 'node:https';
import http from 'node:http';
import { publicOnlyLookup, isPublicIp } from '../netguard.js';
import net from 'node:net';

// Test instance only: allow http://127.0.0.1 (mock provider on the same machine).
const TEST_LOOPBACK = process.env.NIMO_MP_TEST_LOOPBACK === '1';

export const PROVIDERS = {
    openrouter: { kind: 'openai', base: 'https://openrouter.ai/api/v1' },
    openai: { kind: 'openai', base: 'https://api.openai.com/v1' },
    deepseek: { kind: 'openai', base: 'https://api.deepseek.com/v1' },
    custom: { kind: 'openai', base: null },
    anthropic: { kind: 'anthropic', base: 'https://api.anthropic.com/v1' },
    gemini: { kind: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta' },
};

export class ProviderError extends Error {
    constructor(message, status) { super(message); this.status = status; }
}

/** Validates a provider config from the host; returns a normalized copy or throws ProviderError. */
export function normalizeProvider(p) {
    const type = String(p?.type || '');
    const def = PROVIDERS[type];
    if (!def) throw new ProviderError('Unknown provider');
    const base = String((type === 'custom' ? p.url : def.base) || '').trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    let u;
    try { u = new URL(base); } catch { throw new ProviderError('The API URL is not valid'); }
    const loopbackOk = TEST_LOOPBACK && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
    if (!loopbackOk) {
        if (u.protocol !== 'https:' || u.username || u.password) throw new ProviderError('The API URL must be a public https:// address');
        const host = u.hostname.replace(/^\[|\]$/g, '');
        if (net.isIP(host) && !isPublicIp(host)) throw new ProviderError('The API URL must be a public https:// address');
    }
    const model = String(p.model || '').trim().slice(0, 200);
    if (!model) throw new ProviderError('Choose a model');
    const key = String(p.key || '').trim();
    if (key.length > 1000 || /[\r\n]/.test(key)) throw new ProviderError('The API key is not valid');
    return { type, base, model, key };
}

function request(url, { method = 'POST', headers = {}, body, signal, timeout = 300_000 }, onResponse) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const isHttp = u.protocol === 'http:';
        const mod = isHttp ? http : https;
        const opts = { method, headers: { 'User-Agent': 'NimoTavern-Multiplayer', ...headers }, timeout };
        if (!isHttp) opts.lookup = publicOnlyLookup;
        else if (!TEST_LOOPBACK) return reject(new ProviderError('The API URL must be a public https:// address'));
        const req = mod.request(u, opts, (res) => {
            onResponse(res).then(resolve, reject);
        });
        req.on('timeout', () => req.destroy(new ProviderError('The AI provider took too long to answer')));
        req.on('error', (e) => reject(e.code === 'NIMO_PRIVATE' ? new ProviderError('The API URL must be a public https:// address') : e instanceof ProviderError ? e : new ProviderError('Could not reach the AI provider')));
        if (signal) {
            if (signal.aborted) req.destroy(new ProviderError('Stopped'));
            signal.addEventListener('abort', () => req.destroy(new ProviderError('Stopped')), { once: true });
        }
        if (body !== undefined) req.end(typeof body === 'string' ? body : JSON.stringify(body)); else req.end();
    });
}

async function readAll(res, max = 2_000_000) {
    const chunks = []; let n = 0;
    for await (const c of res) { n += c.length; if (n > max) break; chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
}
async function failFrom(res) {
    const text = await readAll(res, 20_000).catch(() => '');
    let msg = '';
    try { const j = JSON.parse(text); msg = j.error?.message || j.error?.metadata?.raw || j.message || (typeof j.error === 'string' ? j.error : ''); } catch { msg = text.slice(0, 200); }
    return new ProviderError(`The AI provider answered ${res.statusCode}${msg ? ': ' + String(msg).slice(0, 300) : ''}`, res.statusCode);
}

/** Server-sent events: calls onData(jsonObject) for each `data:` line. */
async function readSSE(res, onData) {
    let buf = '';
    res.setEncoding('utf8');
    for await (const chunk of res) {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            let j; try { j = JSON.parse(data); } catch { continue; }
            onData(j);
        }
    }
}

function authHeaders(p) {
    if (p.type === 'anthropic') return { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' };
    if (p.type === 'gemini') return { 'x-goog-api-key': p.key };
    const h = p.key ? { Authorization: 'Bearer ' + p.key } : {};
    if (p.type === 'openrouter') Object.assign(h, { 'HTTP-Referer': 'https://nimorp.lol', 'X-Title': 'NimoTavern' });
    return h;
}

/** Checks the key and URL without spending tokens (lists models). */
export async function testProvider(p) {
    const kind = PROVIDERS[p.type].kind;
    const url = kind === 'gemini' ? `${p.base}/models` : `${p.base}/models`;
    return request(url, { method: 'GET', headers: authHeaders(p), timeout: 20_000 }, async (res) => {
        if (res.statusCode >= 400) throw await failFrom(res);
        await readAll(res, 5_000_000).catch(() => '');
        return true;
    });
}

/**
 * Streams a reply. onDelta(textChunk) is called as text arrives; resolves with the full text.
 * @param {{system:string, messages:Array, maxTokens:number, temperature?:number, topP?:number}} prompt
 */
export async function generate(p, prompt, { onDelta, signal }) {
    const kind = PROVIDERS[p.type].kind;
    const temp = Number.isFinite(Number(prompt.temperature)) ? Math.max(0, Math.min(2, Number(prompt.temperature))) : undefined;
    const topP = Number.isFinite(Number(prompt.topP)) && Number(prompt.topP) > 0 && Number(prompt.topP) < 1 ? Number(prompt.topP) : undefined;
    let full = '';
    const add = (t) => { if (t) { full += t; onDelta?.(t); } };
    const headers = { ...authHeaders(p), 'Content-Type': 'application/json', Accept: 'text/event-stream' };

    if (kind === 'openai') {
        const body = { model: p.model, stream: true, max_tokens: prompt.maxTokens, messages: [{ role: 'system', content: prompt.system }, ...prompt.messages] };
        if (temp !== undefined) body.temperature = temp;
        if (topP !== undefined) body.top_p = topP;
        await request(`${p.base}/chat/completions`, { headers, body, signal }, async (res) => {
            if (res.statusCode >= 400) throw await failFrom(res);
            await readSSE(res, (j) => {
                if (j.error) throw new ProviderError('The AI provider returned an error: ' + String(j.error.message || '').slice(0, 300));
                add(j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.message?.content ?? '');
            });
        });
    } else if (kind === 'anthropic') {
        const body = { model: p.model, stream: true, max_tokens: prompt.maxTokens, system: prompt.system, messages: prompt.messages };
        if (temp !== undefined) body.temperature = Math.min(1, temp);
        await request(`${p.base}/messages`, { headers, body, signal }, async (res) => {
            if (res.statusCode >= 400) throw await failFrom(res);
            await readSSE(res, (j) => {
                if (j.type === 'error') throw new ProviderError('The AI provider returned an error: ' + String(j.error?.message || '').slice(0, 300));
                if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') add(j.delta.text);
            });
        });
    } else {
        const body = {
            systemInstruction: { parts: [{ text: prompt.system }] },
            contents: prompt.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
            generationConfig: { maxOutputTokens: prompt.maxTokens, ...(temp !== undefined ? { temperature: temp } : {}), ...(topP !== undefined ? { topP } : {}) },
        };
        await request(`${p.base}/models/${encodeURIComponent(p.model)}:streamGenerateContent?alt=sse`, { headers, body, signal }, async (res) => {
            if (res.statusCode >= 400) throw await failFrom(res);
            await readSSE(res, (j) => {
                for (const part of j.candidates?.[0]?.content?.parts || []) if (!part.thought) add(part.text);
            });
        });
    }
    if (!full.trim()) throw new ProviderError('The AI provider sent an empty reply');
    return full;
}
