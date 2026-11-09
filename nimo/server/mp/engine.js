// Multiplayer sessions: storage (sealed at rest), turn engine and AI generation.
// One process serves everything, so a per-session promise chain is enough to serialize changes.
import crypto from 'node:crypto';
import { buildPrompt } from './prompt.js';
import { generate, normalizeProvider, ProviderError } from './providers.js';

export const MAX_PLAYERS = 6;
export const MODES = ['ordered', 'free', 'alternate'];
export const TIMERS = [0, 300, 3600, 86400];
const MAX_TEXT = 8000;

export class MpError extends Error {
    constructor(message, status = 400) { super(message); this.status = status; }
}

export function createEngine({ pool, sealer }) {
    let hub = { broadcast() { }, toUser() { }, watching: () => false };
    const locks = new Map();
    const running = new Map(); // sid -> AbortController of the AI generation in progress

    function withLock(sid, fn) {
        const prev = locks.get(sid) || Promise.resolve();
        const p = prev.then(fn);
        // The stored tail never rejects (errors go to the caller through p), so a failed action can't
        // become an unhandled rejection or block the next one.
        const tail = p.then(() => { }, () => { });
        locks.set(sid, tail);
        tail.then(() => { if (locks.get(sid) === tail) locks.delete(sid); });
        return p;
    }

    // ------------------------------------------------------------------ loading
    async function loadRow(sid) {
        if (!/^[0-9a-f-]{36}$/.test(String(sid))) throw new MpError('Session not found', 404);
        const { rows } = await pool.query('SELECT s.*, u.username AS host_name FROM mp_sessions s JOIN users u ON u.id = s.host_id WHERE s.id = $1', [sid]);
        if (!rows[0]) throw new MpError('Session not found', 404);
        const r = rows[0];
        r.key = sealer.key(sid, r.wrapped_key);
        return r;
    }
    const info = (r) => sealer.open(r.key, r.id, 'info', r.info);
    const config = (r) => sealer.open(r.key, r.id, 'config', r.config);

    async function members(r) {
        const { rows } = await pool.query('SELECT m.user_id, m.mid, m.role, m.persona, m.avatar IS NOT NULL AS has_avatar, u.username FROM mp_members m JOIN users u ON u.id = m.user_id WHERE m.session_id = $1 ORDER BY m.joined_at', [r.id]);
        return rows.map((m) => ({ userId: String(m.user_id), mid: m.mid, role: m.role, username: m.username, hasAvatar: m.has_avatar, persona: m.persona ? sealer.open(r.key, r.id, 'persona:' + m.mid, m.persona) : null }));
    }
    async function membership(r, userId) {
        const { rows } = await pool.query('SELECT mid, role FROM mp_members WHERE session_id = $1 AND user_id = $2', [r.id, userId]);
        if (!rows[0]) throw new MpError('You are not in this session', 403);
        return rows[0];
    }
    async function messages(r, sinceRev = -1) {
        const { rows } = await pool.query('SELECT id, rev, data FROM mp_messages WHERE session_id = $1 AND id > 0 AND rev > $2 ORDER BY id', [r.id, sinceRev]);
        return rows.map((m) => (m.data ? { id: Number(m.id), rev: Number(m.rev), ...sealer.open(r.key, r.id, 'msg', m.data) } : { id: Number(m.id), rev: Number(m.rev), deleted: true }));
    }

    async function bumpRev(sid) {
        const { rows } = await pool.query('UPDATE mp_sessions SET rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING rev', [sid]);
        return Number(rows[0].rev);
    }
    async function putMessage(r, id, msg) {
        const rev = await bumpRev(r.id);
        if (id == null) {
            const { rows } = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM mp_messages WHERE session_id = $1', [r.id]);
            id = Number(rows[0].id);
        }
        const data = msg ? sealer.seal(r.key, r.id, 'msg', msg) : null;
        await pool.query('INSERT INTO mp_messages (session_id, id, rev, data) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id, id) DO UPDATE SET rev = $3, data = $4', [r.id, id, rev, data]);
        const out = msg ? { id, rev, ...msg } : { id, rev, deleted: true };
        hub.broadcast(r.id, { t: 'msg', sid: r.id, msg: out });
        return out;
    }
    async function saveState(r, state) {
        r.state = state;
        await pool.query('UPDATE mp_sessions SET state = $2, updated_at = now() WHERE id = $1', [r.id, state]);
    }

    // ------------------------------------------------------------------ public view
    async function view(r, forUserId) {
        const i = info(r);
        const ms = await members(r);
        const me = ms.find((m) => m.userId === String(forUserId));
        return {
            sid: r.id, title: i.title, charName: i.charName, hostName: r.host_name, maxPlayers: r.max_players, rev: Number(r.rev),
            me: me ? { mid: me.mid, role: me.role, hasPersona: !!me.persona } : null,
            members: ms.map((m) => ({ mid: m.mid, role: m.role, username: m.username, name: m.persona?.name || null, hasAvatar: m.hasAvatar, online: hub.watching(m.userId, r.id) })),
            state: publicState(r.state),
        };
    }
    const publicState = (s) => ({ mode: s.mode, order: s.order, turn: s.turn, round: s.round, posted: s.posted, paused: s.paused, timer: s.timer, since: s.since, gen: s.gen, error: s.error || null });
    async function pushState(r) {
        hub.broadcast(r.id, { t: 'state', sid: r.id, state: publicState(r.state) });
    }
    async function pushMembers(r) {
        const ms = await members(r);
        hub.broadcast(r.id, { t: 'members', sid: r.id, members: ms.map((m) => ({ mid: m.mid, role: m.role, username: m.username, name: m.persona?.name || null, hasAvatar: m.hasAvatar, online: hub.watching(m.userId, r.id) })) });
    }

    // ------------------------------------------------------------------ notices
    async function notice(userId, sid, kind, who, title) {
        if (kind === 'turn') await pool.query('DELETE FROM mp_notices WHERE user_id = $1 AND session_id = $2 AND kind = \'turn\'', [userId, sid]);
        await pool.query('INSERT INTO mp_notices (user_id, session_id, kind, who, title) VALUES ($1,$2,$3,$4,$5)', [userId, sid, kind, who || null, title ? sealer.sealNotice(title) : null]);
        hub.toUser(userId, { t: 'inbox' });
    }
    async function notifyTurn(r) {
        const s = r.state;
        if (s.paused || s.turn === 'ai') return;
        const ms = await members(r);
        const due = s.turn === 'players' ? ms.filter((m) => s.order.includes(m.mid) && !s.posted.includes(m.mid)) : ms.filter((m) => m.mid === s.turn);
        const title = info(r).title;
        for (const m of due) if (!hub.watching(m.userId, r.id)) await notice(m.userId, r.id, 'turn', null, title);
    }

    // ------------------------------------------------------------------ turn engine
    function startState(mode, order, timer, hasGreeting) {
        const s = { mode, order, turn: 'ai', round: 1, posted: [], next: 0, paused: false, timer, since: Date.now(), gen: false, error: null };
        if (hasGreeting || !order.length) afterAi(s, true);
        return s;
    }
    function afterAi(s, initial = false) {
        if (!initial) s.round += 1;
        s.posted = [];
        s.error = null;
        s.since = Date.now();
        if (!s.order.length || s.mode === 'free') { s.turn = 'players'; return; }
        if (s.mode === 'ordered') { s.turn = s.order[0]; return; }
        s.turn = s.order[s.next % s.order.length];
    }
    function afterPlayer(s, mid) {
        s.since = Date.now();
        if (s.mode === 'free') {
            if (!s.posted.includes(mid)) s.posted.push(mid);
            if (s.order.every((m) => s.posted.includes(m))) s.turn = 'ai';
            return;
        }
        const i = s.order.indexOf(mid);
        if (s.mode === 'alternate') { s.next = i + 1; s.turn = 'ai'; return; }
        s.posted.push(mid);
        s.turn = i >= 0 && i + 1 < s.order.length ? s.order[i + 1] : 'ai';
    }
    const canPost = (s, mid) => !s.paused && !s.gen && (s.turn === mid || (s.turn === 'players' && s.order.includes(mid) && !s.posted.includes(mid)));

    /** Persists the state, tells everyone, starts the AI if it's its turn, and sends turn notices. */
    async function advance(r) {
        await saveState(r, r.state);
        await pushState(r);
        if (r.state.turn === 'ai' && !r.state.paused && !r.state.gen) runAi(r.id).catch(() => { });
        else await notifyTurn(r);
    }

    // ------------------------------------------------------------------ AI
    async function runAi(sid, { reroll = false } = {}) {
        let r, prompt, provider, gid, target = null;
        await withLock(sid, async () => {
            r = await loadRow(sid);
            const s = r.state;
            if (s.gen || s.paused || (!reroll && s.turn !== 'ai')) { r = null; return; }
            const cfg = config(r);
            const ms = await members(r);
            const players = s.order.map((mid) => ms.find((m) => m.mid === mid)?.persona).filter(Boolean);
            const history = (await messages(r)).filter((m) => !m.deleted);
            if (reroll) {
                const lastAi = [...history].reverse().find((m) => m.kind === 'ai');
                if (!lastAi || history[history.length - 1].id !== lastAi.id) { r = null; return; }
                target = lastAi;
                history.pop();
            }
            prompt = buildPrompt(cfg, players, history.map((m) => ({ kind: m.kind, name: m.name, text: m.text })));
            provider = cfg.provider;
            s.gen = true; s.error = null;
            await saveState(r, s);
            await pushState(r);
        });
        if (!r) return;
        gid = crypto.randomBytes(6).toString('hex');
        const ac = new AbortController();
        running.set(sid, ac);
        hub.broadcast(sid, { t: 'ai_start', sid, gid, reroll: target?.id ?? null, name: prompt.charName });
        let text = null, err = null;
        try {
            text = await generate(provider, prompt, { signal: ac.signal, onDelta: (d) => hub.broadcast(sid, { t: 'ai_delta', sid, gid, d }) });
        } catch (e) { err = e; }
        finally { running.delete(sid); }
        await withLock(sid, async () => {
            let r2;
            try { r2 = await loadRow(sid); } catch { return; } // session ended meanwhile
            const s = r2.state;
            s.gen = false;
            if (err) {
                s.error = 'The AI could not answer. The host can retry.';
                await saveState(r2, s);
                hub.broadcast(sid, { t: 'ai_end', sid, gid, ok: false });
                const msg = err instanceof ProviderError ? err.message : 'Could not reach the AI provider';
                hub.toUser(String(r2.host_id), { t: 'ai_error', sid, error: msg });
                await pushState(r2);
                return;
            }
            const charName = info(r2).charName;
            if (target) {
                const swipes = [...(target.swipes || [target.text]), text];
                await putMessage(r2, target.id, { kind: 'ai', name: charName, text, ts: Date.now(), swipes, swipe: swipes.length - 1 });
            } else {
                await putMessage(r2, null, { kind: 'ai', name: charName, text, ts: Date.now() });
                if (s.turn === 'ai') afterAi(s);
            }
            hub.broadcast(sid, { t: 'ai_end', sid, gid, ok: true });
            await advance(r2);
        });
    }

    // ------------------------------------------------------------------ operations
    function cleanText(t) {
        t = String(t ?? '').replace(/\r\n/g, '\n').trim();
        if (!t) throw new MpError('Write something first');
        if (t.length > MAX_TEXT) throw new MpError(`Messages are limited to ${MAX_TEXT} characters`);
        return t;
    }
    function cleanPersona(p) {
        const name = String(p?.name || '').trim().slice(0, 64);
        if (!name) throw new MpError('Your persona needs a name');
        return { name, description: String(p?.description || '').trim().slice(0, 4000) };
    }
    const newMid = () => crypto.randomBytes(6).toString('base64url');

    const api = {
        setHub(h) { hub = h; },
        loadRow, view, members, membership, messages, info, config,

        async create(hostId, body, avatars) {
            const cfg = body.config || {};
            const provider = normalizeProvider(cfg.provider);
            if (!provider.key && provider.type !== 'custom') throw new MpError('Enter the API key for multiplayer');
            const card = cfg.card || {};
            const charName = String(card.name || '').trim().slice(0, 128);
            if (!charName) throw new MpError('The character has no name');
            const mode = MODES.includes(body.mode) ? body.mode : 'ordered';
            const timer = TIMERS.includes(Number(body.timer)) ? Number(body.timer) : 0;
            const maxPlayers = Math.max(2, Math.min(MAX_PLAYERS, Number(body.maxPlayers) || MAX_PLAYERS));
            const title = String(body.title || charName).trim().slice(0, 100) || charName;
            const persona = cleanPersona(body.persona);
            const lorebook = Array.isArray(cfg.lorebook) ? cfg.lorebook.slice(0, 5000) : [];
            const sealedCfg = {
                card: Object.fromEntries(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'system_prompt', 'post_history_instructions'].map((k) => [k, String(card[k] || '').slice(0, 200_000)])),
                world: String(cfg.world || '').slice(0, 100_000),
                lorebook, loreDepth: Math.max(1, Math.min(50, Number(cfg.loreDepth) || 4)),
                prompts: { main: String(cfg.prompts?.main || '').slice(0, 20_000), post: String(cfg.prompts?.post || '').slice(0, 20_000) },
                provider,
                sampling: { context: Number(cfg.sampling?.context) || 16384, maxTokens: Number(cfg.sampling?.maxTokens) || 600, temperature: cfg.sampling?.temperature ?? 1, topP: cfg.sampling?.topP ?? 1 },
            };
            const sid = crypto.randomUUID();
            const wrapped = sealer.newKey(sid);
            const key = sealer.key(sid, wrapped);
            const hostMid = newMid();
            const history = (Array.isArray(body.history) ? body.history : []).slice(-2000);
            const state = startState(mode, [hostMid], timer, history.length > 0 && history[history.length - 1].kind === 'ai');
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('INSERT INTO mp_sessions (id, host_id, max_players, wrapped_key, config, info, state) VALUES ($1,$2,$3,$4,$5,$6,$7)',
                    [sid, hostId, maxPlayers, wrapped, sealer.seal(key, sid, 'config', sealedCfg), sealer.seal(key, sid, 'info', { title, charName }), state]);
                await client.query('INSERT INTO mp_members (session_id, user_id, mid, role, persona, avatar) VALUES ($1,$2,$3,\'host\',$4,$5)',
                    [sid, hostId, hostMid, sealer.seal(key, sid, 'persona:' + hostMid, persona), avatars.persona ? sealer.seal(key, sid, 'avatar:' + hostMid, avatars.persona) : null]);
                let id = 0;
                for (const m of history) {
                    const text = String(m.text || '').slice(0, MAX_TEXT * 4);
                    if (!text) continue;
                    const msg = m.kind === 'ai' ? { kind: 'ai', name: charName, text, ts: Date.now() } : { kind: m.ooc ? 'ooc' : 'player', mid: hostMid, name: String(m.name || persona.name).slice(0, 64), text, ts: Date.now() };
                    await client.query('INSERT INTO mp_messages (session_id, id, rev, data) VALUES ($1,$2,$3,$4)', [sid, ++id, id, sealer.seal(key, sid, 'msg', msg)]);
                }
                // The character's picture is kept as row 0 (sync and prompts only read rows > 0).
                if (avatars.char) await client.query('INSERT INTO mp_messages (session_id, id, rev, data) VALUES ($1, 0, 0, $2)', [sid, sealer.seal(key, sid, 'charavatar', avatars.char)]);
                await client.query('UPDATE mp_sessions SET rev = $2 WHERE id = $1', [sid, id]);
                await client.query('COMMIT');
            } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
            if (state.turn === 'ai') runAi(sid).catch(() => { });
            return sid;
        },

        /** Character avatar is stored as message row 0 (never sent as a message: id 0 is skipped by sync). */
        async avatar(sid, userId, mid) {
            const r = await loadRow(sid);
            await membership(r, userId);
            if (mid === 'char') {
                const { rows } = await pool.query('SELECT data FROM mp_messages WHERE session_id = $1 AND id = 0', [sid]);
                return rows[0]?.data ? sealer.open(r.key, sid, 'charavatar', rows[0].data, true) : null;
            }
            const { rows } = await pool.query('SELECT avatar FROM mp_members WHERE session_id = $1 AND mid = $2', [sid, mid]);
            return rows[0]?.avatar ? sealer.open(r.key, sid, 'avatar:' + mid, rows[0].avatar, true) : null;
        },

        async listMine(userId) {
            const { rows } = await pool.query('SELECT s.id FROM mp_members m JOIN mp_sessions s ON s.id = m.session_id WHERE m.user_id = $1 ORDER BY s.updated_at DESC', [userId]);
            const out = [];
            for (const { id } of rows) { try { const r = await loadRow(id); out.push(await view(r, userId)); } catch { /* */ } }
            return out;
        },

        async changes(sid, userId, since) {
            const r = await loadRow(sid);
            await membership(r, userId);
            const list = await messages(r, Number(since) || 0);
            return { rev: Number(r.rev), changes: list };
        },

        async setPersona(sid, userId, persona, avatar) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                const p = cleanPersona(persona);
                await pool.query('UPDATE mp_members SET persona = $3, avatar = COALESCE($4, avatar) WHERE session_id = $1 AND mid = $2',
                    [sid, me.mid, sealer.seal(r.key, sid, 'persona:' + me.mid, p), avatar ? sealer.seal(r.key, sid, 'avatar:' + me.mid, avatar) : null]);
                if (!r.state.order.includes(me.mid)) {
                    // New players join at the end of the turn order (in free rounds they can post right away).
                    r.state.order.push(me.mid);
                    await advance(r);
                }
                await pushMembers(r);
                return view(r, userId);
            });
        },

        async post(sid, userId, text, ooc) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                const ms = await members(r);
                const persona = ms.find((m) => m.mid === me.mid)?.persona;
                if (!persona) throw new MpError('Pick your persona first');
                text = cleanText(text);
                if (ooc) return putMessage(r, null, { kind: 'ooc', mid: me.mid, name: persona.name, text, ts: Date.now() });
                if (!canPost(r.state, me.mid)) throw new MpError(r.state.paused ? 'The session is paused' : 'It\'s not your turn yet', 409);
                const out = await putMessage(r, null, { kind: 'player', mid: me.mid, name: persona.name, text, ts: Date.now() });
                await pool.query('DELETE FROM mp_notices WHERE user_id = $1 AND session_id = $2 AND kind = \'turn\'', [userId, sid]);
                afterPlayer(r.state, me.mid);
                await advance(r);
                return out;
            });
        },

        async pass(sid, userId) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                if (!canPost(r.state, me.mid)) throw new MpError('It\'s not your turn', 409);
                afterPlayer(r.state, me.mid);
                await advance(r);
            });
        },

        async edit(sid, userId, id, text) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                const all = (await messages(r)).filter((m) => !m.deleted);
                const m = all.find((x) => x.id === Number(id));
                if (!m) throw new MpError('Message not found', 404);
                const isHost = me.role === 'host';
                if (!isHost) {
                    if (m.mid !== me.mid) throw new MpError('You can only edit your own messages', 403);
                    if (m.kind === 'player' && all.some((x) => x.id > m.id && x.kind === 'ai')) throw new MpError('The AI already answered this message', 409);
                }
                const t = cleanText(text);
                const upd = { ...m, text: t };
                if (upd.swipes) { upd.swipes = [...upd.swipes]; upd.swipes[upd.swipe ?? upd.swipes.length - 1] = t; }
                delete upd.id; delete upd.rev;
                return putMessage(r, m.id, upd);
            });
        },

        async remove(sid, userId, id) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                const all = (await messages(r)).filter((m) => !m.deleted);
                const m = all.find((x) => x.id === Number(id));
                if (!m) throw new MpError('Message not found', 404);
                if (me.role !== 'host') {
                    if (m.mid !== me.mid) throw new MpError('You can only delete your own messages', 403);
                    if (m.kind === 'player' && all.some((x) => x.id > m.id && x.kind === 'ai')) throw new MpError('The AI already answered this message', 409);
                }
                return putMessage(r, m.id, null);
            });
        },

        async swipe(sid, userId, id, dir) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                if (me.role !== 'host') throw new MpError('Only the host can change replies', 403);
                const m = (await messages(r)).find((x) => x.id === Number(id) && !x.deleted);
                if (!m?.swipes?.length) throw new MpError('Nothing to swipe');
                const i = Math.max(0, Math.min(m.swipes.length - 1, (m.swipe ?? m.swipes.length - 1) + (dir < 0 ? -1 : 1)));
                const upd = { ...m, swipe: i, text: m.swipes[i] };
                delete upd.id; delete upd.rev;
                return putMessage(r, m.id, upd);
            });
        },

        async leave(sid, userId) {
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const me = await membership(r, userId);
                if (me.role === 'host') throw new MpError('The host can end the session instead');
                await dropMember(r, me.mid, userId);
                const host = String(r.host_id);
                const { rows } = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
                await notice(host, sid, 'left', rows[0]?.username, info(r).title);
            });
        },

        // -------------------------------------------------------------- host
        async hostRow(sid, userId) {
            const r = await loadRow(sid);
            if (String(r.host_id) !== String(userId)) throw new MpError('Only the host can do that', 403);
            return r;
        },

        async hostConfig(sid, userId) {
            const r = await api.hostRow(sid, userId);
            const c = config(r);
            const i = info(r);
            return {
                title: i.title, maxPlayers: r.max_players, mode: r.state.mode, timer: r.state.timer,
                world: c.world, lorebookEntries: c.lorebook.length, loreDepth: c.loreDepth, prompts: c.prompts, sampling: c.sampling,
                provider: { type: c.provider.type, url: c.provider.type === 'custom' ? c.provider.base : '', model: c.provider.model, hasKey: !!c.provider.key },
            };
        },

        async updateConfig(sid, userId, body) {
            return withLock(sid, async () => {
                const r = await api.hostRow(sid, userId);
                const c = config(r);
                const i = info(r);
                if (body.provider) {
                    const p = normalizeProvider({ ...body.provider, key: body.provider.key || c.provider.key });
                    c.provider = p;
                }
                if (typeof body.world === 'string') c.world = body.world.slice(0, 100_000);
                if (Array.isArray(body.lorebook)) c.lorebook = body.lorebook.slice(0, 5000);
                if (body.prompts) c.prompts = { main: String(body.prompts.main || '').slice(0, 20_000), post: String(body.prompts.post || '').slice(0, 20_000) };
                if (body.sampling) c.sampling = { context: Number(body.sampling.context) || 16384, maxTokens: Number(body.sampling.maxTokens) || 600, temperature: body.sampling.temperature ?? 1, topP: body.sampling.topP ?? 1 };
                if (body.loreDepth) c.loreDepth = Math.max(1, Math.min(50, Number(body.loreDepth) || 4));
                if (typeof body.title === 'string' && body.title.trim()) i.title = body.title.trim().slice(0, 100);
                if (body.maxPlayers) {
                    const n = Math.max(2, Math.min(MAX_PLAYERS, Number(body.maxPlayers)));
                    const { rows } = await pool.query('SELECT count(*)::int AS n FROM mp_members WHERE session_id = $1 AND role <> \'char\'', [sid]);
                    if (n < rows[0].n) throw new MpError('There are already more players than that');
                    r.max_players = n;
                }
                await pool.query('UPDATE mp_sessions SET config = $2, info = $3, max_players = $4, updated_at = now() WHERE id = $1',
                    [sid, sealer.seal(r.key, sid, 'config', c), sealer.seal(r.key, sid, 'info', i), r.max_players]);
                let stateChanged = false;
                if (body.mode && MODES.includes(body.mode) && body.mode !== r.state.mode) {
                    r.state.mode = body.mode; r.state.posted = []; stateChanged = true;
                    if (r.state.turn !== 'ai') afterAi(r.state, true);
                }
                if (body.timer !== undefined && TIMERS.includes(Number(body.timer))) { r.state.timer = Number(body.timer); stateChanged = true; }
                if (stateChanged) await advance(r);
                hub.broadcast(sid, { t: 'info', sid, title: i.title, maxPlayers: r.max_players });
                return api.hostConfig(sid, userId);
            });
        },

        async control(sid, userId, action, arg) {
            if (action === 'reroll') { await api.hostRow(sid, userId); return runAi(sid, { reroll: true }); }
            if (action === 'stop') { await api.hostRow(sid, userId); running.get(sid)?.abort(); return; }
            return withLock(sid, async () => {
                const r = await api.hostRow(sid, userId);
                const s = r.state;
                if (action === 'pause') s.paused = true;
                else if (action === 'resume') s.paused = false;
                else if (action === 'force') { if (s.gen) throw new MpError('The AI is already writing'); s.turn = 'ai'; s.paused = false; s.error = null; }
                else if (action === 'skip') {
                    if (s.turn === 'ai' || s.gen) throw new MpError('It\'s the AI\'s turn');
                    if (s.turn === 'players') s.turn = 'ai';
                    else afterPlayer(s, s.turn);
                } else if (action === 'order') {
                    const order = Array.isArray(arg) ? arg.map(String) : [];
                    if (order.length !== s.order.length || !order.every((m) => s.order.includes(m))) throw new MpError('Bad order');
                    s.order = order;
                } else throw new MpError('Unknown action');
                await advance(r);
            });
        },

        async kick(sid, userId, mid) {
            return withLock(sid, async () => {
                const r = await api.hostRow(sid, userId);
                const { rows } = await pool.query('SELECT user_id, role FROM mp_members WHERE session_id = $1 AND mid = $2', [sid, String(mid)]);
                if (!rows[0] || rows[0].role !== 'player') throw new MpError('Player not found', 404);
                await dropMember(r, String(mid), rows[0].user_id);
                await notice(String(rows[0].user_id), sid, 'kicked', r.host_name, info(r).title);
                hub.toUser(String(rows[0].user_id), { t: 'kicked', sid });
            });
        },

        async end(sid, userId) {
            const r = await api.hostRow(sid, userId);
            running.get(sid)?.abort();
            const title = info(r).title;
            const ms = await members(r);
            await pool.query('DELETE FROM mp_sessions WHERE id = $1', [sid]); // cascades: members, messages, invites
            sealer.forget(sid);
            for (const m of ms) if (m.role === 'player') await notice(m.userId, null, 'ended', r.host_name, title);
            hub.broadcast(sid, { t: 'ended', sid });
            hub.dropSession(sid);
        },

        // -------------------------------------------------------------- invites
        async invite(sid, userId, username) {
            const r = await api.hostRow(sid, userId);
            const uname = String(username || '').trim().toLowerCase();
            const generic = { ok: true, message: `If ${String(username).slice(0, 32)} accepts invites, they'll find yours in their mailbox.` };
            if (!/^[a-z0-9_.-]{3,32}$/.test(uname)) throw new MpError('That is not a valid username');
            const { rows } = await pool.query('SELECT id, mp_invites FROM users WHERE username_lc = $1', [uname]);
            const target = rows[0];
            if (target && String(target.id) === String(userId)) throw new MpError('You are already in this session');
            if (!target || target.mp_invites !== 'anyone') return generic;
            const { rows: blocked } = await pool.query('SELECT 1 FROM mp_blocks WHERE user_id = $1 AND blocked_id = $2', [target.id, userId]);
            if (blocked.length) return generic;
            const { rows: already } = await pool.query('SELECT 1 FROM mp_members WHERE session_id = $1 AND user_id = $2', [sid, target.id]);
            if (already.length) throw new MpError('They are already in this session');
            await pool.query('INSERT INTO mp_invites (session_id, from_id, to_id) VALUES ($1,$2,$3) ON CONFLICT (session_id, to_id) DO UPDATE SET created_at = now()', [sid, userId, target.id]);
            hub.toUser(String(target.id), { t: 'inbox' });
            return generic;
        },

        async inbox(userId) {
            const { rows: inv } = await pool.query(`SELECT i.id, i.session_id, i.created_at, u.username AS from_name,
                (SELECT count(*)::int FROM mp_members m WHERE m.session_id = i.session_id AND m.role <> 'char') AS players
                FROM mp_invites i JOIN users u ON u.id = i.from_id WHERE i.to_id = $1 ORDER BY i.created_at DESC LIMIT 50`, [userId]);
            const invites = [];
            for (const i of inv) {
                try {
                    const r = await loadRow(i.session_id);
                    const inf = info(r);
                    invites.push({ id: String(i.id), sid: i.session_id, from: i.from_name, title: inf.title, charName: inf.charName, players: i.players, maxPlayers: r.max_players, mode: r.state.mode, created: i.created_at });
                } catch { /* session gone */ }
            }
            const { rows: nts } = await pool.query('SELECT id, session_id, kind, who, title, created_at, seen FROM mp_notices WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
            const notices = nts.map((n) => ({ id: String(n.id), sid: n.session_id, kind: n.kind, who: n.who, title: n.title ? sealer.openNotice(n.title) : '', created: n.created_at, seen: n.seen }));
            return { invites, notices };
        },

        async inboxCount(userId) {
            const { rows } = await pool.query('SELECT (SELECT count(*) FROM mp_invites WHERE to_id = $1)::int + (SELECT count(*) FROM mp_notices WHERE user_id = $1 AND NOT seen)::int AS n', [userId]);
            return rows[0].n;
        },

        async markSeen(userId) {
            await pool.query('UPDATE mp_notices SET seen = true WHERE user_id = $1 AND NOT seen', [userId]);
            hub.toUser(String(userId), { t: 'inbox' });
        },
        async clearNotices(userId) {
            await pool.query('DELETE FROM mp_notices WHERE user_id = $1', [userId]);
            hub.toUser(String(userId), { t: 'inbox' });
        },

        async answer(inviteId, userId, accept, block = false) {
            if (!/^\d{1,18}$/.test(String(inviteId))) throw new MpError('Invite not found', 404);
            const { rows } = await pool.query('SELECT i.*, u.username AS to_name FROM mp_invites i JOIN users u ON u.id = i.to_id WHERE i.id = $1 AND i.to_id = $2', [inviteId, userId]);
            const inv = rows[0];
            if (!inv) throw new MpError('Invite not found', 404);
            const sid = inv.session_id;
            if (!accept) {
                await pool.query('DELETE FROM mp_invites WHERE id = $1', [inviteId]);
                if (block) await pool.query('INSERT INTO mp_blocks (user_id, blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, inv.from_id]);
                const r = await loadRow(sid).catch(() => null);
                if (r) await notice(String(inv.from_id), sid, 'declined', inv.to_name, info(r).title);
                hub.toUser(String(userId), { t: 'inbox' });
                return { ok: true };
            }
            return withLock(sid, async () => {
                const r = await loadRow(sid);
                const { rows: cnt } = await pool.query('SELECT count(*)::int AS n FROM mp_members WHERE session_id = $1 AND role <> \'char\'', [sid]);
                if (cnt[0].n >= r.max_players) throw new MpError('This session is full', 409);
                await pool.query('INSERT INTO mp_members (session_id, user_id, mid, role) VALUES ($1,$2,$3,\'player\') ON CONFLICT DO NOTHING', [sid, userId, newMid()]);
                await pool.query('DELETE FROM mp_invites WHERE id = $1', [inviteId]);
                await notice(String(inv.from_id), sid, 'joined', inv.to_name, info(r).title);
                hub.toUser(String(userId), { t: 'inbox' });
                await pushMembers(r);
                return { ok: true, sid };
            });
        },

        async inviteSetting(userId, value) {
            if (value !== undefined) {
                if (!['anyone', 'nobody'].includes(value)) throw new MpError('Bad setting');
                await pool.query('UPDATE users SET mp_invites = $2 WHERE id = $1', [userId, value]);
            }
            const { rows } = await pool.query('SELECT mp_invites FROM users WHERE id = $1', [userId]);
            const { rows: bl } = await pool.query('SELECT u.username FROM mp_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = $1 ORDER BY u.username', [userId]);
            return { invites: rows[0]?.mp_invites || 'anyone', blocked: bl.map((b) => b.username) };
        },
        async unblock(userId, username) {
            await pool.query('DELETE FROM mp_blocks WHERE user_id = $1 AND blocked_id = (SELECT id FROM users WHERE username_lc = $2)', [userId, String(username || '').toLowerCase()]);
        },

        /** Auto-skip for turn timers; old inactive sessions are deleted after 90 days. */
        async housekeeping() {
            const { rows } = await pool.query('SELECT id, state FROM mp_sessions WHERE (state->>\'timer\')::int > 0');
            for (const row of rows) {
                const s = row.state;
                if (s.paused || s.gen || s.turn === 'ai' || Date.now() - s.since < s.timer * 1000) continue;
                await withLock(row.id, async () => {
                    const r = await loadRow(row.id);
                    const st = r.state;
                    if (st.paused || st.gen || st.turn === 'ai' || Date.now() - st.since < st.timer * 1000) return;
                    if (st.turn === 'players') st.turn = 'ai'; else afterPlayer(st, st.turn);
                    await advance(r);
                }).catch(() => { });
            }
            // Players whose account was deleted vanish from mp_members (cascade): take them out of the turn order.
            const { rows: stale } = await pool.query(`SELECT s.id FROM mp_sessions s WHERE EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(s.state->'order') o(mid)
                WHERE NOT EXISTS (SELECT 1 FROM mp_members m WHERE m.session_id = s.id AND m.mid = o.mid))`);
            for (const { id } of stale) {
                await withLock(id, async () => {
                    const r = await loadRow(id);
                    const { rows: ms } = await pool.query('SELECT mid FROM mp_members WHERE session_id = $1', [id]);
                    const alive = new Set(ms.map((m) => m.mid));
                    const st = r.state;
                    for (const mid of st.order.filter((m) => !alive.has(m))) {
                        if (st.turn === mid) afterPlayer(st, mid);
                        st.order = st.order.filter((m) => m !== mid);
                        st.posted = st.posted.filter((m) => m !== mid);
                    }
                    if (st.turn === 'players' && st.order.length && st.order.every((m) => st.posted.includes(m))) st.turn = 'ai';
                    await advance(r);
                    await pushMembers(r);
                }).catch(() => { });
            }
            await pool.query('DELETE FROM mp_sessions WHERE updated_at < now() - interval \'90 days\'');
            await pool.query('DELETE FROM mp_notices WHERE created_at < now() - interval \'60 days\'');
        },
        runAi,
    };

    async function dropMember(r, mid, userId) {
        await pool.query('DELETE FROM mp_members WHERE session_id = $1 AND user_id = $2', [r.id, userId]);
        const s = r.state;
        const wasTurn = s.turn === mid;
        if (wasTurn) afterPlayer(s, mid);
        s.order = s.order.filter((m) => m !== mid);
        s.posted = s.posted.filter((m) => m !== mid);
        if (s.turn === 'players' && s.order.length && s.order.every((m) => s.posted.includes(m))) s.turn = 'ai';
        hub.dropUser(String(userId), r.id);
        await advance(r);
        await pushMembers(r);
    }

    return api;
}
