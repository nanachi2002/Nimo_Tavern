// REST API for multiplayer: /api/nimo/mp/*. Every route needs a login; state-changing ones also need the
// X-Nimo-Client header (CSRF). Nothing here logs content.
import express from 'express';
import { MpError } from './engine.js';
import { ProviderError, normalizeProvider, testProvider } from './providers.js';

const MAX_IMAGE = 2 * 1024 * 1024;
function imageFrom(b64) {
    if (!b64) return null;
    if (typeof b64 !== 'string' || b64.length > MAX_IMAGE * 1.4) throw new MpError('Pictures are limited to 2 MB');
    const buf = Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > MAX_IMAGE) throw new MpError('Pictures are limited to 2 MB');
    if (!imageType(buf)) throw new MpError('Pictures must be PNG, WebP, JPEG or GIF');
    return buf;
}
function imageType(b) {
    if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (b.length > 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
    return null;
}

export function createRoutes({ engine, requireSession, requireClientHeader, limit, wrap }) {
    const r = express.Router();
    const small = express.json({ limit: '64kb' });
    const medium = express.json({ limit: '4mb' });
    const big = express.json({ limit: '12mb' });
    const uid = (req) => String(req.session.userId);
    const perUser = (name, max, ms) => limit(name, max, ms, (req) => 'u' + req.session.userId);

    r.use(requireClientHeader, requireSession, perUser('mp', 600, 60_000));

    // ---- mailbox
    r.get('/inbox/count', wrap(async (req, res) => res.json({ n: await engine.inboxCount(uid(req)) })));
    r.get('/inbox', wrap(async (req, res) => res.json(await engine.inbox(uid(req)))));
    r.post('/inbox/seen', wrap(async (req, res) => { await engine.markSeen(uid(req)); res.json({ ok: true }); }));
    r.post('/inbox/clear', wrap(async (req, res) => { await engine.clearNotices(uid(req)); res.json({ ok: true }); }));
    r.post('/invites/:id/accept', wrap(async (req, res) => res.json(await engine.answer(req.params.id, uid(req), true))));
    r.post('/invites/:id/decline', small, wrap(async (req, res) => res.json(await engine.answer(req.params.id, uid(req), false, !!req.body?.block))));
    r.get('/settings', wrap(async (req, res) => res.json(await engine.inviteSetting(uid(req)))));
    r.post('/settings', small, wrap(async (req, res) => res.json(await engine.inviteSetting(uid(req), req.body?.invites))));
    r.post('/unblock', small, wrap(async (req, res) => { await engine.unblock(uid(req), req.body?.username); res.json(await engine.inviteSetting(uid(req))); }));

    // ---- sessions
    r.post('/test-provider', perUser('mp-test', 20, 600_000), small, wrap(async (req, res) => {
        const p = normalizeProvider(req.body?.provider);
        if (!p.key && req.body?.sid) {
            const c = engine.config(await engine.hostRow(req.body.sid, uid(req)));
            if (c.provider.type === p.type) p.key = c.provider.key;
        }
        await testProvider(p);
        res.json({ ok: true });
    }));
    r.post('/sessions', perUser('mp-create', 10, 3600_000), big, wrap(async (req, res) => {
        const b = req.body || {};
        const avatars = { persona: imageFrom(b.persona?.avatar), char: imageFrom(b.config?.card?.avatar) };
        res.json({ sid: await engine.create(uid(req), b, avatars) });
    }));
    r.get('/sessions', wrap(async (req, res) => res.json(await engine.listMine(uid(req)))));
    r.get('/sessions/:sid', wrap(async (req, res) => {
        const row = await engine.loadRow(req.params.sid);
        await engine.membership(row, uid(req));
        res.json(await engine.view(row, uid(req)));
    }));
    r.get('/sessions/:sid/messages', wrap(async (req, res) => res.json(await engine.changes(req.params.sid, uid(req), req.query.since))));
    r.get('/sessions/:sid/avatar/:mid', wrap(async (req, res) => {
        const img = await engine.avatar(req.params.sid, uid(req), String(req.params.mid));
        if (!img) return res.status(404).end();
        res.setHeader('Content-Type', imageType(img) || 'application/octet-stream');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        res.send(img);
    }));
    r.post('/sessions/:sid/persona', medium, wrap(async (req, res) => res.json(await engine.setPersona(req.params.sid, uid(req), req.body?.persona, imageFrom(req.body?.persona?.avatar)))));
    r.post('/sessions/:sid/post', perUser('mp-post', 60, 60_000), small, wrap(async (req, res) => res.json(await engine.post(req.params.sid, uid(req), req.body?.text, !!req.body?.ooc))));
    r.post('/sessions/:sid/pass', wrap(async (req, res) => { await engine.pass(req.params.sid, uid(req)); res.json({ ok: true }); }));
    r.post('/sessions/:sid/edit', small, wrap(async (req, res) => res.json(await engine.edit(req.params.sid, uid(req), req.body?.id, req.body?.text))));
    r.post('/sessions/:sid/delete', small, wrap(async (req, res) => res.json(await engine.remove(req.params.sid, uid(req), req.body?.id))));
    r.post('/sessions/:sid/leave', wrap(async (req, res) => { await engine.leave(req.params.sid, uid(req)); res.json({ ok: true }); }));

    // ---- host only
    r.get('/sessions/:sid/config', wrap(async (req, res) => res.json(await engine.hostConfig(req.params.sid, uid(req)))));
    r.post('/sessions/:sid/config', big, wrap(async (req, res) => res.json(await engine.updateConfig(req.params.sid, uid(req), req.body || {}))));
    r.post('/sessions/:sid/control', perUser('mp-control', 60, 60_000), small, wrap(async (req, res) => { await engine.control(req.params.sid, uid(req), String(req.body?.action), req.body?.order); res.json({ ok: true }); }));
    r.post('/sessions/:sid/swipe', small, wrap(async (req, res) => res.json(await engine.swipe(req.params.sid, uid(req), req.body?.id, Number(req.body?.dir)))));
    r.post('/sessions/:sid/invite', perUser('mp-invite', 20, 3600_000), small, wrap(async (req, res) => res.json(await engine.invite(req.params.sid, uid(req), req.body?.username))));
    r.post('/sessions/:sid/kick', small, wrap(async (req, res) => { await engine.kick(req.params.sid, uid(req), req.body?.mid); res.json({ ok: true }); }));
    r.post('/sessions/:sid/end', wrap(async (req, res) => { await engine.end(req.params.sid, uid(req)); res.json({ ok: true }); }));

    // Expected errors -> their message; anything else -> generic (never request data).
    r.use((err, _req, res, next) => {
        if (err instanceof MpError || err instanceof ProviderError) return res.status(err instanceof MpError ? err.status : 400).json({ error: err.message });
        next(err);
    });
    return r;
}
