// Real-time push for multiplayer: one WebSocket per open tavern tab, authenticated with the login cookie.
// Server -> client only (actions go through the REST routes, which carry the CSRF header). A client
// subscribes to the sessions it's looking at; membership is checked on every subscribe.
import { WebSocketServer } from 'ws';

export function createHub({ getSession, engine }) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
    /** userId -> Set<ws> */
    const byUser = new Map();
    /** sid -> Set<ws> */
    const bySession = new Map();

    const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
    function unsubscribe(ws, sid) {
        ws.subs.delete(sid);
        const set = bySession.get(sid);
        if (set) { set.delete(ws); if (!set.size) bySession.delete(sid); }
    }
    async function presence(sid) {
        try { const r = await engine.loadRow(sid); hub.broadcast(sid, { t: 'presence', sid, online: (await engine.members(r)).filter((m) => hub.watching(m.userId, sid)).map((m) => m.mid) }); } catch { /* */ }
    }

    const hub = {
        broadcast(sid, obj) { for (const ws of bySession.get(sid) || []) send(ws, obj); },
        toUser(userId, obj) { for (const ws of byUser.get(String(userId)) || []) send(ws, obj); },
        watching(userId, sid) { for (const ws of byUser.get(String(userId)) || []) if (ws.subs.has(sid)) return true; return false; },
        dropUser(userId, sid) { for (const ws of [...(byUser.get(String(userId)) || [])]) if (ws.subs.has(sid)) { unsubscribe(ws, sid); send(ws, { t: 'kicked', sid }); } },
        dropSession(sid) { for (const ws of [...(bySession.get(sid) || [])]) unsubscribe(ws, sid); },

        /** Called from the HTTP server's 'upgrade' event. */
        async upgrade(req, socket, head) {
            try {
                // Only our own pages may open it (a WebSocket is not covered by CORS).
                const origin = req.headers.origin;
                let ok = false;
                try { ok = !!origin && new URL(origin).host === req.headers.host; } catch { /* */ }
                const s = ok ? await getSession(req) : null;
                if (!s) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
                wss.handleUpgrade(req, socket, head, (ws) => {
                    ws.userId = String(s.userId);
                    ws.subs = new Set();
                    ws.alive = true;
                    if (!byUser.has(ws.userId)) byUser.set(ws.userId, new Set());
                    const mine = byUser.get(ws.userId);
                    if (mine.size >= 20) { ws.close(1013, 'Too many tabs'); return; }
                    mine.add(ws);
                    let budget = 60; // messages per minute
                    const refill = setInterval(() => { budget = 60; }, 60_000);
                    ws.on('pong', () => { ws.alive = true; });
                    ws.on('message', async (raw) => {
                        if (--budget < 0) return;
                        let m; try { m = JSON.parse(String(raw)); } catch { return; }
                        if (m.t === 'sub' && typeof m.sid === 'string') {
                            try {
                                const r = await engine.loadRow(m.sid);
                                await engine.membership(r, ws.userId);
                                if (ws.subs.size >= 10) return;
                                ws.subs.add(m.sid);
                                if (!bySession.has(m.sid)) bySession.set(m.sid, new Set());
                                bySession.get(m.sid).add(ws);
                                send(ws, { t: 'subscribed', sid: m.sid, view: await engine.view(r, ws.userId) });
                                presence(m.sid);
                            } catch (e) { send(ws, { t: 'error', sid: m.sid, error: e.status === 404 ? 'gone' : 'forbidden' }); }
                        } else if (m.t === 'unsub' && typeof m.sid === 'string') { unsubscribe(ws, m.sid); presence(m.sid); }
                        else if (m.t === 'ping') send(ws, { t: 'pong' });
                    });
                    ws.on('close', () => {
                        clearInterval(refill);
                        mine.delete(ws);
                        if (!mine.size) byUser.delete(ws.userId);
                        for (const sid of [...ws.subs]) { unsubscribe(ws, sid); presence(sid); }
                    });
                    send(ws, { t: 'hello' });
                });
            } catch { socket.destroy(); }
        },
    };

    // Keep connections alive through nginx (300 s idle timeout) and drop dead ones.
    setInterval(() => {
        for (const set of byUser.values()) for (const ws of set) {
            if (!ws.alive) { ws.terminate(); continue; }
            ws.alive = false; ws.ping();
        }
    }, 30_000).unref();

    return hub;
}
