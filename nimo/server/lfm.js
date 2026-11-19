// NimoLFM gateway: /api/nimo/lfm/*
// Lets logged-in NimoTavern users talk to NimoLFM, the free roleplay model the Nimo team hosts (now Gemma 4 E4B, uncensored, with thinking).
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
    base: 'Gemma 4 E4B (uncensored, HauhauCS Aggressive, IQ4_XS)',
    context: 67_000,                 // tokens per chat the server guarantees
    maxReply: 2048,                  // tokens per reply, thinking included
    defaultReply: 1500,
};
const MAX_CHARS = 255_000;           // ~67K tokens of English; the model server would refuse more anyway
const MAX_MESSAGES = 3000;

// Same text as the extension's rules (variant "X10"); keep the two in sync.
const RULES_MARK = 'Write exactly 3 paragraphs';
const REACT_MARK = 'First react directly to';
const replyRules = (ch, who) => { const user = userNames(who)[0] || who; return `[Only ${ch} acts in this reply: ${who} is played by the user, so never write what ${user} says, does, thinks or feels. First react directly to ${user}'s last message above: answer what ${user} said and respond to what ${user} did. ${RULES_MARK}, about 150 words in total, with concrete detail and fresh wording (never reuse sentences from earlier replies). Every reply uses both marks: *actions and scenery in asterisks* and "every spoken word in double quotes", for example: *She leans closer.* "Tell me more." Paragraph 1: *${ch} reacts to what ${user} just did.* Paragraph 2: ${ch} answers ${user} in "quotes" with a short *gesture*. Paragraph 3: *what ${ch} feels or notices*. No emoji, no out-of-character notes. Remember: ${user} belongs to the user, so never write ${user}'s words, actions or feelings.]`; };

// ---- "Never write for the user", enforced.
// The rules alone still let a small model narrate the user's persona now and then. So the reply is checked sentence by sentence
// BEFORE it is sent: a sentence that makes the user act or speak is thrown away and the model rewrites from the last good
// sentence (the good part is sent back as the start of its reply). Nothing written for the user reaches the screen.
const NAMES_RE = /Write (.{1,60}?)'s next reply in a fictional chat between .{1,60}? and (.{1,60}?)\./;
// Names come from (1) the reply rules the extension adds ("[Only Silvia acts in this reply: Haruka is played by the user"),
// or (2) the clean preset's main prompt. A user's own preset may have neither, so both are tried.
const RULES_NAMES_RE = /\[Only (.{1,60}?) acts in this reply: (.{1,60}?) is played by the user/;
function roleplayNames(messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== 'user') continue;
        const r = messages[i].content.match(RULES_NAMES_RE);
        if (r && r[2] !== 'the user') return { ch: r[1].trim(), user: r[2].trim(), from: 'rules' };
        break;
    }
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const m = sys.match(NAMES_RE);
    return m ? { ch: m[1].trim(), user: m[2].trim(), from: 'preset' } : null;
}
const roleplayUser = (messages) => roleplayNames(messages)?.user || null;
// The model talking ABOUT the task instead of roleplaying ("<think>We need to produce… The user is playing…").
const META = /<\/?think|<\/?reasoning|\bthe user\b|\bwe need to\b|\b(?:3|three) paragraphs\b|\bin asterisks\b|\bout-of-character\b/i;
const reEsc =(s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// "Haruka (also called Nana, Nanachi)" -> ['Haruka', 'Nana', 'Nanachi']: every name the user writes under.
export const userNames = (field) => { const m = String(field).match(/^(.*?)(?: \(also called (.*)\))?$/); return [m[1], ...(m[2] ? m[2].split(', ') : [])].map((n) => n.trim()).filter(Boolean); };
export function makeUserGuard(user) {
    const all = userNames(user);
    const names = [...new Set(all.flatMap((n) => [n, n.split(/\s+/)[0]]))].filter((n) => n.length >= 2).map(reEsc);
    if (!names.length) return null;
    const N = `(?:${names.join('|')})`;
    const VERB = `[a-z]+(?:ed|s)\\b`;        // "stammered", "looks", "trembles": the user doing something
    const start = new RegExp(`^[\\s*_~(]*${N}(?:'s\\s+[a-z]+)?\\s+[a-z]`);                            // sentence starts with the user acting
    const attrib = new RegExp(`Q[\\s*,.!?…-]*${N}\\s+[a-z]`);                                          // "…," Haruka said
    const clause = new RegExp(`(?:[,;:—–]|\\b(?:and|while|as|when|before|after|until|then|so))\\s+${N}(?:'s\\s+[a-z]+)?\\s+${VERB}`);
    // speech where someone introduces themselves as the user ("I'm Haruka", "my name is Haruka") = the AI speaking as the user
    const selfIntro = new RegExp(`["“][^"”]*\\b(?:I'm|I am|my name is|my name's|call me|it's me,?)\\s+${N}\\b`, 'i');
    return (sentence) => {
        if (META.test(sentence) || selfIntro.test(sentence)) return true;
        const t = sentence.replace(/"[^"\n]*"|“[^”\n]*”/g, 'Q').replace(/["“][^"”\n]*$/, 'Q');   // only narration counts, not speech
        return start.test(t) || attrib.test(t) || clause.test(t);
    };
}
// Splits off complete sentences (outside quotes, ending in . ! ? … or a line break). Returns [sentences, rest].
export function takeSentences(text) {
    const out = []; let from = 0, q = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\n') { q = false; let j = i; while (text[j + 1] === '\n') j++; out.push(text.slice(from, j + 1)); from = j + 1; i = j; continue; }
        if (c === '"' || c === '“' || c === '”') { q = c === '“' ? true : c === '”' ? false : !q; }
        if (!q && /[.!?…"”*]/.test(c) && /[.!?…]/.test(/[.!?…]/.test(c) ? c : text[i - 1] || '')) {
            let j = i + 1;
            if (j < text.length && !/\s/.test(text[j])) continue;   // "Mr.X", "...!" etc: not the end yet
            while (j < text.length && text[j] === ' ') j++;
            if (j >= text.length) break;            // need to see what follows before calling it a sentence
            out.push(text.slice(from, j)); from = j; i = j - 1;
        }
    }
    return [out, text.slice(from)];
}
const MAX_REWRITES = 4;
const ENOUGH_WORDS = 90;                    // when the reply is already this long, a violation just ends it
// ---- the checker model: a fine-tuned Qwen3-0.6B on the same machine that answers one question per sentence:
// "is the AI writing the user's character here?" It catches what the name guard can't ("...," she stammered).
// On unseen test scenes: ~85% of such sentences caught (79% when both characters are "she"), ~1.2% of good ones wrongly flagged, ~80 ms per check.
// Nothing is stored; if it is down or slow, replies go on with the name guard alone.
const CHECK_THRESHOLD = 0.95;
let checkerDownUntil = 0;
const hasNarration = (s) => /[A-Za-z]/.test(s.replace(/"[^"\n]*"|“[^”\n]*”/g, '').replace(/["“][^"”\n]*$/, ''));
export function makeChecker(url, user, ch) {
    const u = new URL(url);
    const ask = (s, ctx) => `Roleplay check. ${user} is the USER's character. ${ch} is the AI's character.\n`
        + `Earlier in the AI's reply:\n"""${ctx || '(start of reply)'}"""\nNext sentence of the AI's reply:\n"""${s}"""\n`
        + `Question: in the next sentence, does the AI write ${user}'s own words, actions, thoughts or feelings (as if the AI were playing ${user})? `
        + `${ch} speaking, acting, or looking at or touching ${user} is NO. Answer with one word: YES or NO.`;
    return (sentence, ctx) => new Promise((resolve) => {
        const s = sentence.trim();
        if (!s || !hasNarration(s) || Date.now() < checkerDownUntil) return resolve(false);
        const payload = Buffer.from(JSON.stringify({ messages: [{ role: 'user', content: ask(s, ctx) }], max_tokens: 1, temperature: 0,
            logprobs: true, top_logprobs: 10, chat_template_kwargs: { enable_thinking: false } }));
        let settled = false;
        const done = (v, down) => { if (settled) return; settled = true; if (down) checkerDownUntil = Date.now() + 30_000; resolve(v); };
        const q = http.request({ host: u.hostname, port: u.port, path: '/v1/chat/completions', method: 'POST', timeout: 1500,
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length } }, (r) => {
            let b = ''; r.setEncoding('utf8'); r.on('data', (c) => { b += c; });
            r.on('end', () => {
                try {
                    const tops = JSON.parse(b).choices[0].logprobs.content[0].top_logprobs;
                    let y = 0, n = 0;
                    for (const t of tops) { const w = t.token.trim().toUpperCase(); if (w.startsWith('Y')) y += Math.exp(t.logprob); else if (w.startsWith('N')) n += Math.exp(t.logprob); }
                    done(y + n > 0 && y / (y + n) >= CHECK_THRESHOLD, false);
                } catch { done(false, true); }
            });
        });
        q.on('timeout', () => { q.destroy(); done(false, true); });
        q.on('error', () => done(false, true));
        q.end(payload);
    });
}

function guardedReply({ up, body, wantStream, violates, check, res, release }) {
    const id = 'chatcmpl-' + crypto.randomBytes(9).toString('base64url'), created = Math.floor(Date.now() / 1000);
    const base = body.messages;
    const lastIsAssistant = base[base.length - 1].role === 'assistant';      // "Continue": the reply goes on from that message
    let sent = '', thought = '', rewrites = 0, done = false, current = null, started = false;
    const why = [];                          // counts only, for the log line (never text)
    const words = (s) => (s.match(/\S+/g) || []).length;
    const chunk = (delta, finish = null) => 'data: ' + JSON.stringify({ id, object: 'chat.completion.chunk', created, model: MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] }) + '\n\n';
    function begin() {
        if (started || !wantStream) return; started = true;
        res.status(200); res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Accel-Buffering', 'no');
        res.write(chunk({ role: 'assistant', content: '' }));
    }
    const said = [];                         // sentences already sent (context for the checker, like in its training)
    const recent = () => said.slice(-3).join(' ').slice(-600);
    function emit(text) { if (!text) return; sent += text; if (text.trim()) said.push(text.trim()); if (wantStream) { begin(); res.write(chunk({ content: text })); } }
    function finish() {
        if (done) return; done = true; release();
        console.log(`[nimolfm] reply words=${words(sent)} cuts=${why.join(',') || 'none'}`);
        try { current?.destroy(); } catch {}
        if (wantStream) { begin(); res.write(chunk({}, 'stop')); res.end('data: [DONE]\n\n'); }
        else res.json({ id, object: 'chat.completion', created, model: MODEL_ID, choices: [{ index: 0, message: { role: 'assistant', content: sent.trimEnd(), ...(thought ? { reasoning_content: thought } : {}) }, finish_reason: 'stop' }] });
    }
    function fail(code, json) {
        if (started || sent) return finish();
        if (done) return; done = true; release();
        res.status(code).json(json);
    }
    res.on('close', () => { if (!done) { done = true; release(); try { current?.destroy(); } catch {} } });   // user stopped: stop generating

    function attempt() {
        const messages = sent
            ? (lastIsAssistant ? [...base.slice(0, -1), { role: 'assistant', content: base[base.length - 1].content + sent }] : [...base, { role: 'assistant', content: sent }])
            : base;
        const left = body.max_tokens - Math.round(words(sent) * 1.4);
        if (left < 24) return finish();
        // a rewrite continues the reply text itself, so it must not start thinking again
        const extra = sent ? { chat_template_kwargs: { enable_thinking: false } } : {};
        const payload = Buffer.from(JSON.stringify({ ...body, ...extra, messages, max_tokens: left, stream: true }));
        let pending = '', cut = false;
        const uq = current = http.request({ host: up.hostname, port: up.port, path: '/v1/chat/completions', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length }, timeout: 600_000 }, (ur) => {
            if (ur.statusCode !== 200) {              // pass the model server's error through (only possible before anything was sent)
                let e = ''; ur.setEncoding('utf8'); ur.on('data', (c) => { if (e.length < 4000) e += c; });
                ur.on('end', () => { let j; try { j = JSON.parse(e); } catch { j = { error: 'NimoLFM error' }; } fail(ur.statusCode || 502, j); });
                return;
            }
            let buf = '';
            const onViolation = () => {
                cut = true; try { uq.destroy(); } catch {}
                if (done) return;
                if (words(sent) >= ENOUGH_WORDS || rewrites >= MAX_REWRITES) return finish();
                rewrites++; attempt();
            };
            // Sentences wait in a queue: each is checked (name guard, then the checker model) before it is sent.
            let queue = [], busy = false, ended = false;
            const pump = async () => {
                if (busy) return; busy = true;
                while (queue.length && !cut && !done) {
                    const s = queue.shift();
                    let bad = violates ? violates(s) : false;
                    if (bad) why.push('name');
                    else if (check) { bad = await check(s, recent()); if (bad) why.push('check@' + said.length); }
                    if (cut || done) break;
                    if (bad) { busy = false; queue = []; return onViolation(); }
                    emit(s);
                }
                busy = false;
                if (ended && !queue.length && !cut && !done) finish();
            };
            const feed = (text) => {
                pending += text;
                const [sentences, rest] = takeSentences(pending);
                pending = rest;
                if (sentences.length) { queue.push(...sentences); pump(); }
            };
            ur.setEncoding('utf8');
            ur.on('data', (c) => {
                if (cut || done) return;
                buf += c; let k;
                while ((k = buf.indexOf('\n')) !== -1) {
                    const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
                    if (!line.startsWith('data:')) continue;
                    const d = line.slice(5).trim(); if (d === '[DONE]') continue;
                    try {
                        const delta = JSON.parse(d).choices?.[0]?.delta || {};
                        // the thinking goes straight to the thinking box: never guarded, never part of the reply text
                        if (delta.reasoning_content) { thought += delta.reasoning_content; if (wantStream) { begin(); res.write(chunk({ reasoning_content: delta.reasoning_content })); } }
                        if (delta.content) feed(delta.content);
                    } catch {}
                    if (cut || done) return;
                }
            });
            ur.on('end', () => {
                if (cut || done) return;
                ended = true;
                if (pending.trim()) queue.push(pending);
                pending = '';
                pump();
            });
            ur.on('error', () => { if (!cut) finish(); });
        });
        uq.on('timeout', () => uq.destroy(new Error('timeout')));
        uq.on('error', () => { if (cut || done) return; fail(503, { error: 'NimoLFM is offline right now. Try again in a minute.' }); });
        uq.end(payload);
    }
    attempt();
}

const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export function createLfmRoutes({ requireSession, limit, wrap, secret, count = () => {}, upstream = 'http://127.0.0.1:8080' }) {
    if (!secret || String(secret).length < 32) throw new Error('NimoLFM: secret required');
    const up = new URL(upstream);
    // the checker model runs next to the main model (port 8081); LFM_CHECK_URL=off disables it
    const CHECK_URL = process.env.LFM_CHECK_URL === 'off' ? null : (process.env.LFM_CHECK_URL || `${up.protocol}//${up.hostname}:8081`);
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
        const hadRules = lastUser.role === 'user' && lastUser.content.includes(RULES_MARK);
        // Older clients send rules that only describe the reply's shape, so the model fills it from the card and ignores what the
        // user just did. Swap them for the current rules ("react to the user's last message first": 15/24 -> 20/24 in tests).
        if (hadRules && !lastUser.content.includes(REACT_MARK)) {
            const r = lastUser.content.match(RULES_NAMES_RE);
            if (r) lastUser.content = lastUser.content.replace(/\[Only [^\]]{1,60}? acts in this reply:[\s\S]*\]\s*$/, replyRules(r[1].trim(), r[2].trim()));
        }
        if (lastUser.role === 'user' && !lastUser.content.includes(RULES_MARK)
            && !/\[Pause your roleplay|from the point of view of|impersonat/i.test(lastUser.content.slice(-2000))) {   // summaries, impersonate
            const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
            const m = sys.match(/Write (.{1,60}?)'s next reply in a fictional chat between .{1,60}? and (.{1,60}?)\./);
            lastUser.content += '\n\n' + replyRules(m ? m[1] : 'the character', m ? m[2] : 'the user');
        }
        // Gemma 4 decides by itself whether to think, and with our detailed reply rules it almost never did (0/5 in tests).
        // This line in the system prompt makes it think every time (5/5).
        const THINK = 'Always think before you reply: plan the character\'s reaction, feelings and next move in your thoughts first, then write the reply.';
        if (messages[0].role === 'system') messages[0].content += '\n\n' + THINK; else messages.unshift({ role: 'system', content: THINK });
        if (chars > MAX_CHARS) return res.status(413).json({ error: `This chat is longer than NimoLFM's ${LFM.context.toLocaleString('en-US')}-token limit. Shorten the context size or trim the chat.` });
        if ((inflight.get(uid) || 0) >= 1) return res.status(429).json({ error: 'NimoLFM is already writing a reply for you. Wait for it to finish.' });

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
            chat_template_kwargs: { enable_thinking: true },      // Gemma 4 thinks first; the thinking comes back separately (reasoning_content)
        };
        if (Array.isArray(b.stop)) body.stop = b.stop.filter((s) => typeof s === 'string' && s.length && s.length <= 40).slice(0, 4);

        count('lfm_calls');
        inflight.set(uid, (inflight.get(uid) || 0) + 1);
        let released = false;
        const release = () => { if (!released) { released = true; const n = (inflight.get(uid) || 1) - 1; if (n <= 0) inflight.delete(uid); else inflight.set(uid, n); } };

        const names = roleplayNames(messages);
        const userName = names?.user || null;
                const check = userName && CHECK_URL ? makeChecker(CHECK_URL, userNames(userName)[0], names.ch) : null;
        guardedReply({ up, body, wantStream: b.stream === true, violates: userName ? makeUserGuard(userName) : null, check, res, release });
    });

    return r;
}
