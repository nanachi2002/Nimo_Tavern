// NimoLFM gateway: /api/nimo/lfm/*
// Lets logged-in NimoTavern users talk to NimoLFM, the free roleplay model the Nimo team fine-tuned and hosts.
// The model server (llama.cpp) lives on the private network and is never exposed to the internet: this is the only way in.
//
// Privacy rules (same as the rest of this server):
//   * request and response bodies are streamed through and never logged, stored or inspected beyond the parameter clamps below
//   * nothing is written anywhere; the only state is RAM counters for rate limiting
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';

// NimoTavern's browser backend (service worker) sends requests to custom AI endpoints WITHOUT cookies, so the login
// cookie can't authenticate them. Instead a logged-in page asks /token for a short-lived signed token and uses it as the
// connection's API key; the worker then sends it as "Authorization: Bearer nlfm1.<payload>.<mac>". Stateless: nothing is stored.
const TOKEN_PREFIX = 'nlfm1.';
const TOKEN_TTL_MS = 6 * 3600_000;

const MODEL_ID = 'lfm3-rp';          // internal alias on the model server
export const LFM = {
    name: 'NimoLFM',
    base: 'LiquidAI LFM3-1.7B-Base',
    context: 86_000,                 // tokens per chat the server guarantees
    maxReply: 1024,                  // tokens per reply
    defaultReply: 400,
};
const MAX_CHARS = 330_000;           // ~86K tokens of English; the model server would refuse more anyway
const MAX_MESSAGES = 3000;

// Same text as the extension's rules (variant "X10"); keep the two in sync.
const RULES_MARK = 'Write exactly 3 paragraphs';
const replyRules = (ch, user) => `[Only ${ch} acts in this reply: ${user} is played by the user, so never write what ${user} says, does, thinks or feels. ${RULES_MARK}, about 150 words in total, with concrete detail and fresh wording (never reuse sentences from earlier replies). Every reply uses both marks: *actions and scenery in asterisks* and "every spoken word in double quotes", for example: *She leans closer.* "Tell me more." Paragraph 1: *${ch} acts, and the scene around them.* Paragraph 2: ${ch} speaks in "quotes" with a short *gesture*. Paragraph 3: *what ${ch} feels or notices*. No emoji, no out-of-character notes. Remember: ${user} belongs to the user, so never write ${user}'s words, actions or feelings.]`;

const clamp =(v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function createLfmRoutes({ requireSession, limit, wrap, secret, count = () => {}, upstream = 'http://127.0.0.1:8080' }) {
    if (!secret || String(secret).length < 32) throw new Error('NimoLFM: secret required');
    const up = new URL(upstream);
    const r = express.Router();
    const json = express.json({ limit: '2mb' });
    const perUser = (name, max, ms) => limit(name, max, ms, (req) => 'u' + req.session.userId);
    const inflight = new Map();      // userId -> concurrent generations (RAM only)

    const key = crypto.createHmac('sha256', String(secret)).update('nimolfm-token-v1').digest();
    const mac = (p) => crypto.createHmac('sha256', key).update(p).digest('base64url');
    const sign = (uid) => { const p = Buffer.from(JSON.stringify({ u: uid, e: Date.now() + TOKEN_TTL_MS })).toString('base64url'); return TOKEN_PREFIX + p + '.' + mac(p); };
    function verify(tok) {
        if (typeof tok !== 'string' || !tok.startsWith(TOKEN_PREFIX) || tok.length > 400) return null;
        const [p, m] = tok.slice(TOKEN_PREFIX.length).split('.');
        if (!p || !m) return null;
        const a = Buffer.from(m), b = Buffer.from(mac(p));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
        try { const d = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); return d && d.e > Date.now() && d.u != null ? d.u : null; } catch { return null; }
    }
    // Accept either the login cookie (page requests) or the bearer token (service-worker requests).
    const auth = (req, res, next) => {
        const h = req.headers.authorization || '';
        if (h.startsWith('Bearer ' + TOKEN_PREFIX)) {
            const uid = verify(h.slice(7).trim());
            if (uid == null) return res.status(401).json({ error: 'Your NimoLFM session expired. Reload NimoTavern and try again.' });
            req.session = { userId: uid };
            return next();
        }
        return requireSession(req, res, next);
    };

    // Same-site only: the cookie is SameSite=Lax already; this also refuses cross-site fetches that carry an Origin.
    const sameOrigin = (req, res, next) => {
        const o = req.headers.origin;
        if (o) { try { if (new URL(o).host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request refused' }); } catch { return res.status(403).end(); } }
        next();
    };

    function probe(path, timeout = 2500) {
        return new Promise((resolve) => {
            const q = http.get({ host: up.hostname, port: up.port, path, timeout }, (res) => {
                let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { if (b.length < 20_000) b += c; });
                res.on('end', () => { try { resolve({ ok: res.statusCode === 200, body: JSON.parse(b) }); } catch { resolve({ ok: res.statusCode === 200, body: null }); } });
            });
            q.on('timeout', () => q.destroy()); q.on('error', () => resolve({ ok: false, body: null }));
        });
    }
    let cache = { t: 0, v: null };
    async function status() {
        if (Date.now() - cache.t < 4000 && cache.v) return cache.v;
        const h = await probe('/health');
        let busy = null, slots = null;
        if (h.ok) {                  // counts only: the /slots endpoint can include prompt text, so only the booleans are read
            const s = await probe('/slots');
            if (Array.isArray(s.body)) { slots = s.body.length; busy = s.body.filter((x) => x && x.is_processing).length; }
        }
        cache = { t: Date.now(), v: { online: h.ok, busy, slots } };
        return cache.v;
    }

    r.get('/status', requireSession, perUser('lfm-status', 60, 60_000), wrap(async (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ ...LFM, ...(await status()) });
    }));

    // A logged-in page (cookie) asks for a token; the extension stores it as the connection's API key.
    r.get('/token', sameOrigin, requireSession, perUser('lfm-token', 30, 60_000), (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ token: sign(req.session.userId), ttlMs: TOKEN_TTL_MS });
    });

    // Lets the SillyTavern "Connect" button succeed.
    r.get('/v1/models', auth, perUser('lfm-status', 60, 60_000), (_req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json({ object: 'list', data: [{ id: MODEL_ID, object: 'model', owned_by: 'nimo' }] });
    });

    r.post('/v1/chat/completions', sameOrigin, auth, perUser('lfm-chat', 40, 60_000), json, (req, res) => {
        const b = req.body || {};
        const uid = req.session.userId;
        if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_MESSAGES) return res.status(400).json({ error: 'Bad messages' });
        let chars = 0;
        const messages = [];
        for (const m of b.messages) {
            const role = m && m.role;
            let content = m && m.content;
            if (Array.isArray(content)) content = content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n'); // text only
            if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') return res.status(400).json({ error: 'Bad message' });
            chars += content.length;
            messages.push({ role, content });
        }
        // The model's chat template refuses a prompt that ends with two or more assistant messages (it happens on "Continue" or a
        // send with an empty box). Merge them into one so the reply still works.
        while (messages.length >= 2 && messages[messages.length - 1].role === 'assistant' && messages[messages.length - 2].role === 'assistant') {
            const tail = messages.pop(); messages[messages.length - 1].content += '\n\n' + tail.content;
        }
        // A final assistant message right after a user message is a prefill ("Start Reply With"). Presets for big models put
        // "<think>" + thinking rules there; the model then continues the rules and the reply ends up in the thinking box.
        // NimoLFM doesn't think, so such a prefill is dropped (a normal "Continue" of a real reply is kept).
        const last = messages[messages.length - 1];
        if (messages.length >= 2 && last.role === 'assistant' && messages[messages.length - 2].role === 'user' && /<\/?think|<\/?reasoning|do not leak/i.test(last.content)) messages.pop();
        // The NimoLFM extension appends the reply rules to the last user message. If a client didn't (old cached code, another
        // extension rewrote the message), add them here, so every user gets the format the model was tuned for.
        const lastUser = messages[messages.length - 1];
        if (lastUser.role === 'user' && !lastUser.content.includes(RULES_MARK)
            && !/\[Pause your roleplay|from the point of view of|impersonat/i.test(lastUser.content.slice(-2000))) {   // summaries, impersonate
            const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
            const m = sys.match(/Write (.{1,60}?)'s next reply in a fictional chat between .{1,60}? and (.{1,60}?)\./);
            lastUser.content += '\n\n' + replyRules(m ? m[1] : 'the character', m ? m[2] : 'the user');
        }
        if (chars > MAX_CHARS) return res.status(413).json({ error: `This chat is longer than NimoLFM's ${LFM.context.toLocaleString('en-US')}-token limit. Shorten the context size or trim the chat.` });
        if ((inflight.get(uid) || 0) >= 2) return res.status(429).json({ error: 'You already have two replies being written. Wait for one to finish.' });

        // Only these parameters ever reach the model, each clamped to a sane range.
        const body = {
            model: MODEL_ID,
            messages,
            stream: b.stream === true,
            max_tokens: Math.round(clamp(b.max_tokens ?? b.max_completion_tokens, 1, LFM.maxReply, LFM.defaultReply)),
            temperature: clamp(b.temperature, 0.2, 1.4, 0.8),
            top_p: clamp(b.top_p, 0.1, 1, 1),
            min_p: clamp(b.min_p, 0, 0.5, 0.06),
            top_k: Math.round(clamp(b.top_k, 0, 100, 0)),
            repeat_penalty: clamp(b.repeat_penalty ?? b.repetition_penalty, 1, 1.3, 1.06),
            // DRY sampler, fixed on our side: stops the model echoing earlier replies in long chats. In multi-turn tests it cut
            // repeated 4-word phrases from 55% to 10% and identical reply openings from 33% to 0%.
            dry_multiplier: 0.8, dry_base: 1.75, dry_allowed_length: 3, dry_penalty_last_n: 4096,
        };
        if (Array.isArray(b.stop)) body.stop = b.stop.filter((s) => typeof s === 'string' && s.length && s.length <= 40).slice(0, 4);
        const payload = Buffer.from(JSON.stringify(body));

        count('lfm_calls');
        inflight.set(uid, (inflight.get(uid) || 0) + 1);
        let released = false;
        const release = () => { if (!released) { released = true; const n = (inflight.get(uid) || 1) - 1; if (n <= 0) inflight.delete(uid); else inflight.set(uid, n); } };

        const uq = http.request({ host: up.hostname, port: up.port, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }, timeout: 600_000 }, (ur) => {
            res.status(ur.statusCode || 502);
            const ct = ur.headers['content-type']; if (ct) res.setHeader('Content-Type', ct);
            res.setHeader('Cache-Control', 'no-store');
            res.setHeader('X-Accel-Buffering', 'no');
            ur.on('error', () => res.end());
            ur.on('end', release);
            ur.pipe(res);
        });
        uq.on('timeout', () => uq.destroy(new Error('timeout')));
        uq.on('error', () => { release(); if (res.headersSent) return res.end(); res.status(503).json({ error: 'NimoLFM is offline right now. Try again in a minute.' }); });
        res.on('close', () => { release(); if (!res.writableFinished) uq.destroy(); });   // user stopped or left: stop generating
        uq.end(payload);
    });

    return r;
}
