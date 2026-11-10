// NimoTavern Multiplayer: turn-based group roleplay, built as a regular SillyTavern extension.
// The server runs the session (turns + AI with the host's multiplayer key); this extension shows it inside
// SillyTavern's own chat: player messages are user messages with each player's persona name and avatar.
// Every player keeps a local copy of the session as a normal (end-to-end encrypted) SillyTavern chat file.
import { user_avatar } from '../../../personas.js';
import { world_names } from '../../../world-info.js';

const API = '/api/nimo/mp';
const DEFAULT_MAIN = 'Write {{char}}\'s next reply in a fictional group roleplay between {{char}} and the players: {{group}}. '
    + 'Each player controls their own character; the persona descriptions below say who they are. '
    + 'Narrate the world and any side characters as needed, react to every player\'s latest action, and keep the story moving. '
    + 'Never write dialogue, thoughts or actions for the players\' characters.';
const DEFAULT_POST = 'It is now {{char}}\'s turn. Respond to the players\' latest actions. Do not speak or act for {{group}}.';
const MODES = {
    ordered: ['Ordered rounds', 'AI → player 1 → player 2 → … → AI. Everyone plays in a fixed order, then the AI answers the whole round.'],
    free: ['Free rounds', 'Everyone writes one action per round, in any order. The AI answers once all players have posted (or when the host continues).'],
    alternate: ['Strict alternation', 'Player 1 → AI → player 2 → AI → … The AI answers after every player.'],
};
const TIMERS = { 0: 'Off (wait as long as needed)', 300: '5 minutes', 3600: '1 hour', 86400: '24 hours' };
const PROVIDERS = {
    openrouter: { label: 'OpenRouter', model: 'e.g. deepseek/deepseek-chat-v3-0324' },
    openai: { label: 'OpenAI', model: 'e.g. gpt-4o' },
    deepseek: { label: 'DeepSeek', model: 'e.g. deepseek-chat' },
    anthropic: { label: 'Anthropic (Claude)', model: 'e.g. claude-sonnet-4-5' },
    gemini: { label: 'Google Gemini', model: 'e.g. gemini-2.5-pro' },
    custom: { label: 'Custom OpenAI-compatible (proxy)', model: 'model name' },
};
const PRIVACY_NOTE = `<div class="nimo-mp-notice">
<b><i class="fa-solid fa-triangle-exclamation"></i> Multiplayer is not end-to-end encrypted.</b>
<p>Your solo chats stay end-to-end encrypted: only your browser can read them. Multiplayer can't work that way: to run the AI for everyone,
even when the host is offline, the NimoTavern server has to read the session (the character, world setting, lorebook, everyone's messages and
the host's multiplayer API key) while it writes the prompt.</p>
<ul>
<li>Sessions are <b>encrypted at rest</b> with their own key, never written to logs, and <b>deleted for good</b> when the host ends them (or after 90 days without activity).</li>
<li>Players only see what's in the chat. The character definition, world setting, lorebook and API key stay with the host.</li>
<li><b>Use a separate API key for multiplayer</b>, not the one you use for solo chats (which never leaves your browser).</li>
</ul>
<p><a href="/privacy#multiplayer" target="_blank">Read the details</a></p></div>`;

const ctx = () => SillyTavern.getContext();
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
    const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', 'X-Nimo-Client': 'web' }, body: body === undefined ? undefined : JSON.stringify(body) });
    let d = null; try { d = await r.json(); } catch { /* */ }
    if (!r.ok) { const e = new Error(d?.error || `Request failed (${r.status})`); e.status = r.status; throw e; }
    return d;
}
async function blobToB64(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
}
async function fetchB64(url) {
    try { const r = await fetch(url); if (!r.ok) return null; const b = await r.blob(); return b.size && b.size < 2_000_000 ? blobToB64(b) : null; } catch { return null; }
}
const avatarUrl = (sid, mid) => `${API}/sessions/${sid}/avatar/${encodeURIComponent(mid)}`;

// =====================================================================================================
// State
let cur = null;          // the multiplayer session shown in the current chat
let ws = null, wsOpen = false, wsRetry = 0;
let dismissed = new Set(); // sessions whose persona picker was closed this page load

function currentSid() {
    const c = ctx();
    if (c.groupId) return null;
    const meta = c.chatMetadata?.nimo_mp?.sid;
    if (meta) return meta;
    const ch = c.characters?.[c.characterId];
    return ch?.data?.extensions?.nimo_mp?.sid || null;
}
const me = () => cur?.view?.me;
const isHost = () => me()?.role === 'host';
const myTurn = () => {
    const s = cur?.view?.state; const m = me();
    if (!s || !m || s.paused || s.gen) return false;
    return s.turn === m.mid || (s.turn === 'players' && s.order.includes(m.mid) && !s.posted.includes(m.mid));
};
const nameOf = (mid) => cur?.view?.members.find((m) => m.mid === mid)?.name || cur?.view?.members.find((m) => m.mid === mid)?.username || 'someone';

// =====================================================================================================
// WebSocket (server -> client pushes)
function connect() {
    if (ws) return;
    ws = new WebSocket(location.origin.replace(/^http/, 'ws') + API + '/ws');
    ws.onopen = () => { wsOpen = true; wsRetry = 0; if (cur) { ws.send(JSON.stringify({ t: 'sub', sid: cur.sid })); catchUp(); } };
    ws.onclose = () => { wsOpen = false; ws = null; setTimeout(connect, Math.min(30_000, 1000 * 2 ** wsRetry++)); };
    ws.onerror = () => { };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } onPush(m).catch((err) => console.warn('[nimo-mp]', err)); };
}
setInterval(() => { if (wsOpen) ws?.send('{"t":"ping"}'); }, 25_000);

async function onPush(m) {
    if (m.t === 'inbox') { window.dispatchEvent(new CustomEvent('nimo-inbox')); checkJoined(); return; }
    if (m.t === 'ai_error' && m.sid === cur?.sid) { toastr.error(m.error, 'Multiplayer: the AI could not answer', { timeOut: 15000 }); return; }
    if (!cur || m.sid !== cur.sid) return;
    switch (m.t) {
        case 'subscribed': cur.view = m.view; renderBar(); break;
        case 'state': cur.view.state = m.state; renderBar(); break;
        case 'members': cur.view.members = m.members; renderBar(); break;
        case 'presence': for (const x of cur.view.members) x.online = m.online.includes(x.mid); renderBar(); break;
        case 'info': cur.view.title = m.title; cur.view.maxPlayers = m.maxPlayers; renderBar(); break;
        case 'msg': await applyMsg(m.msg); break;
        case 'ai_start': aiStart(m); break;
        case 'ai_delta': aiDelta(m); break;
        case 'ai_end': if (!m.ok) aiFail(); break;
        case 'kicked': sessionGone(m.reason === 'left' ? 'You left this session.' : 'You were removed from this session by the host.'); break;
        case 'ended': sessionGone('The host ended this session.'); break;
        case 'error': if (m.error === 'gone') sessionGone('This session no longer exists.'); else if (m.error === 'forbidden') sessionGone('You are no longer in this session.'); break;
    }
}

// =====================================================================================================
// Chat sync: the server's message list is the truth; the local chat file is a copy.
function toSt(m) {
    const base = { send_date: m.ts || Date.now(), is_system: false, extra: { nimo_id: m.id } };
    if (m.kind === 'ai') return { ...base, name: m.name, is_user: false, mes: m.text };
    return { ...base, name: m.name, is_user: true, mes: m.kind === 'ooc' ? `((${m.text}))` : m.text, force_avatar: avatarUrl(cur.sid, m.mid), extra: { ...base.extra, nimo_mid: m.mid, nimo_ooc: m.kind === 'ooc' } };
}
const sortedMsgs = () => [...cur.msgs.values()].filter((m) => !m.deleted).sort((a, b) => a.id - b.id);

function cancelLocalEdit() {
    const ta = document.getElementById('curEditTextarea');
    ta?.closest('.mes')?.querySelector('.mes_edit_cancel')?.click();
}
async function rebuild() {
    cancelLocalEdit();
    const c = ctx();
    if (cur.pending) cur.pending = null;
    c.chat.length = 0;
    for (const m of sortedMsgs()) c.chat.push(toSt(m));
    await c.clearChat();
    await c.printMessages();
    decorate();
    saveLocal();
}
let saveTimer = null;
function saveLocal() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        if (!cur) return;
        const c = ctx();
        c.chatMetadata.nimo_mp = { sid: cur.sid, rev: cur.rev };
        try { await c.saveChat(); } catch { /* */ }
    }, 800);
}
function decorate() {
    const c = ctx();
    const myMid = me()?.mid, host = isHost();
    document.querySelectorAll('#chat .mes').forEach((el) => {
        const msg = c.chat[Number(el.getAttribute('mesid'))];
        if (!msg) return;
        el.classList.toggle('nimo-mp-ooc', !!msg.extra?.nimo_ooc);
        const mine = msg.extra?.nimo_mid && msg.extra.nimo_mid === myMid;
        el.classList.toggle('nimo-mp-locked', !msg.extra?.nimo_id || (!host && !mine));
    });
}

async function fullSync() {
    const sid = cur.sid;
    const [view, data] = await Promise.all([api('GET', `/sessions/${sid}`), api('GET', `/sessions/${sid}/messages?since=0`)]);
    if (!cur || cur.sid !== sid) return;
    cur.view = view; cur.rev = data.rev;
    cur.msgs = new Map(data.changes.map((m) => [m.id, m]));
    renderBar();
    await rebuild();
}
async function catchUp() {
    if (!cur?.msgs) return;
    try {
        const data = await api('GET', `/sessions/${cur.sid}/messages?since=${cur.rev}`);
        if (!data.changes.length) return;
        for (const m of data.changes) cur.msgs.set(m.id, m);
        cur.rev = data.rev;
        await rebuild();
    } catch (e) { if (e.status === 403 || e.status === 404) sessionGone('You are no longer in this session.'); }
}

async function applyMsg(m) {
    const prev = cur.msgs.get(m.id);
    cur.msgs.set(m.id, m);
    cur.rev = Math.max(cur.rev, m.rev);
    const c = ctx();
    // Streaming placeholder (or the rerolled message) becomes the final reply.
    if (cur.pending && m.kind === 'ai' && (cur.pending.reroll === m.id || (!cur.pending.reroll && !prev))) {
        const idx = cur.pending.idx;
        cur.pending = null;
        c.chat[idx] = toSt(m);
        c.updateMessageBlock(idx, c.chat[idx]);
        decorate(); saveLocal();
        if (cur.deferred) { cur.deferred = false; await rebuild(); }
        return;
    }
    const maxId = Math.max(0, ...[...cur.msgs.keys()].filter((id) => id !== m.id && !cur.msgs.get(id).deleted));
    if (!prev && !m.deleted && m.id > maxId && !cur.pending) {
        c.chat.push(toSt(m));
        c.addOneMessage(c.chat[c.chat.length - 1]);
        decorate(); saveLocal();
        return;
    }
    if (cur.pending) { cur.deferred = true; return; } // re-render once the reply is done
    await rebuild();
}

let deltaTimer = null;
function aiStart(m) {
    const c = ctx();
    if (m.reroll) {
        const idx = c.chat.findIndex((x) => x.extra?.nimo_id === m.reroll);
        if (idx < 0) return;
        cur.pending = { gid: m.gid, idx, reroll: m.reroll, text: '' };
    } else {
        c.chat.push({ name: m.name, is_user: false, is_system: false, send_date: Date.now(), mes: '…', extra: { nimo_pending: true } });
        c.addOneMessage(c.chat[c.chat.length - 1]);
        cur.pending = { gid: m.gid, idx: c.chat.length - 1, reroll: null, text: '' };
    }
    decorate();
}
function aiDelta(m) {
    const p = cur.pending;
    if (!p || p.gid !== m.gid) return;
    p.text += m.d;
    if (deltaTimer) return;
    deltaTimer = setTimeout(() => {
        deltaTimer = null;
        const pp = cur?.pending; if (!pp) return;
        const c = ctx();
        if (!c.chat[pp.idx]) return;
        c.chat[pp.idx].mes = pp.text;
        c.updateMessageBlock(pp.idx, c.chat[pp.idx]);
    }, 80);
}
async function aiFail() {
    if (!cur?.pending) return;
    cur.pending = null; cur.deferred = false;
    await rebuild();
}

// =====================================================================================================
// Entering / leaving multiplayer mode when the chat changes
async function onChatChanged() {
    const sid = currentSid();
    if (cur && cur.sid !== sid) exitMode();
    if (sid && !cur) await enterMode(sid);
    updateMenu();
}
async function enterMode(sid) {
    cur = { sid, view: null, msgs: null, rev: 0, pending: null, gone: false };
    document.body.classList.add('nimo-mp');
    renderBar();
    try {
        await fullSync();
        if (!ctx().chatMetadata.nimo_mp) saveLocal();
    } catch (e) {
        if (e.status === 403 || e.status === 404) sessionGone(e.status === 404 ? 'This session no longer exists.' : 'You are no longer in this session.');
        else toastr.error(e.message, 'Multiplayer');
        return;
    }
    if (wsOpen) ws.send(JSON.stringify({ t: 'sub', sid }));
}
function exitMode() {
    if (cur && wsOpen) ws.send(JSON.stringify({ t: 'unsub', sid: cur.sid }));
    cur = null;
    document.body.classList.remove('nimo-mp', 'nimo-mp-gone');
    document.getElementById('nimo-mp-bar')?.remove();
    const ta = document.getElementById('send_textarea');
    if (ta?.dataset.nimoPlaceholder) { ta.placeholder = ta.dataset.nimoPlaceholder; delete ta.dataset.nimoPlaceholder; }
}
function sessionGone(text) {
    if (!cur || cur.gone) return;
    cur.gone = text;
    document.body.classList.add('nimo-mp-gone');
    renderBar();
    toastr.info(text + ' Your copy of the chat stays here.', 'Multiplayer');
}

// =====================================================================================================
// Players bar (above the chat) and the send box
function renderBar() {
    if (!cur) return;
    let bar = document.getElementById('nimo-mp-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'nimo-mp-bar';
        const sheld = document.getElementById('sheld');
        sheld.insertBefore(bar, document.getElementById('chat'));
        bar.addEventListener('click', onBarClick);
    }
    const v = cur.view;
    if (cur.gone) { bar.innerHTML = `<div class="nimo-mp-row"><i class="fa-solid fa-door-closed"></i> <span>${esc(cur.gone)}</span></div>`; updateSendBox(); return; }
    if (!v) { bar.innerHTML = '<div class="nimo-mp-row"><i class="fa-solid fa-spinner fa-spin"></i> <span>Joining the multiplayer session…</span></div>'; return; }
    const s = v.state;
    const c = ctx();
    const charName = v.charName;
    const seat = (cls, img, name, title, extra = '') => `<div class="nimo-mp-seat ${cls}" title="${esc(title)}"><img src="${esc(img)}" alt="" loading="lazy" onerror="this.src='/img/ai4.png'"><span>${esc(name)}</span>${extra}</div>`;
    const seats = [seat(`ai ${s.turn === 'ai' || s.gen ? 'turn' : ''}`, avatarUrl(cur.sid, 'char'), charName, `${charName} (AI)`, s.gen ? '<i class="fa-solid fa-feather nimo-mp-writing"></i>' : '')];
    const inOrder = s.order.map((mid) => v.members.find((m) => m.mid === mid)).filter(Boolean);
    const waiting = v.members.filter((m) => m.role !== 'char' && !s.order.includes(m.mid));
    for (const m of inOrder) {
        const turn = s.turn === m.mid || (s.turn === 'players' && !s.posted.includes(m.mid));
        const done = s.posted.includes(m.mid);
        seats.push(seat(`${turn && !s.gen ? 'turn' : ''} ${done ? 'done' : ''} ${m.online ? 'online' : ''} ${m.mid === me()?.mid ? 'me' : ''}`, m.hasAvatar ? avatarUrl(cur.sid, m.mid) : '/img/ai4.png',
            m.name || m.username, `${m.name || m.username} (@${m.username})${m.role === 'host' ? ' · host' : ''}${m.online ? ' · here now' : ''}`,
            `${m.role === 'host' ? '<i class="fa-solid fa-crown nimo-mp-crown"></i>' : ''}${done ? '<i class="fa-solid fa-check nimo-mp-done"></i>' : ''}`));
    }
    for (const m of waiting) seats.push(seat('pending', '/img/ai4.png', m.username, `@${m.username} is choosing a persona`, '<i class="fa-solid fa-hourglass-half nimo-mp-done"></i>'));

    let status;
    if (s.paused) status = '<i class="fa-solid fa-pause"></i> Paused by the host';
    else if (s.gen) status = `<i class="fa-solid fa-feather"></i> ${esc(charName)} is writing…`;
    else if (s.error) status = `<i class="fa-solid fa-triangle-exclamation"></i> ${esc(s.error)}`;
    else if (!me()?.hasPersona) status = 'Choose your persona to join in';
    else if (myTurn()) status = '<b class="nimo-mp-yourturn"><i class="fa-solid fa-dice-d20"></i> Your turn!</b>';
    else if (s.turn === 'players') status = `Waiting for ${esc(inOrder.filter((m) => !s.posted.includes(m.mid)).map((m) => m.name).join(', ') || 'players')}`;
    else if (s.turn === 'ai') status = `${esc(charName)}'s turn`;
    else status = `Waiting for ${esc(nameOf(s.turn))}`;

    const btn = (a, icon, label, title) => `<div class="menu_button menu_button_icon" data-a="${a}" title="${esc(title || label)}"><i class="fa-solid ${icon}"></i><span>${esc(label)}</span></div>`;
    const actions = [];
    if (!me()?.hasPersona) actions.push(btn('persona', 'fa-user-plus', 'Choose persona'));
    if (myTurn()) actions.push(btn('pass', 'fa-forward', 'Pass', 'Skip your turn this round'));
    if (isHost()) {
        if (!s.gen) actions.push(btn('force', s.error ? 'fa-rotate-right' : 'fa-play', s.error ? 'Retry' : 'AI now', 'Make the AI answer now'));
        if (s.gen) actions.push(btn('stop', 'fa-stop', 'Stop', 'Stop the AI reply'));
        if (!s.gen && c.chat.some((x) => !x.is_user && x.extra?.nimo_id)) actions.push(btn('reroll', 'fa-repeat', 'Reroll', 'Write the last AI reply again'));
        actions.push(btn('settings', 'fa-gear', 'Session', 'Players, rules, AI and world settings'));
    } else {
        actions.push(btn('info', 'fa-circle-info', 'Session', 'About this session'));
    }
    bar.innerHTML = `
        <div class="nimo-mp-row nimo-mp-head">
            <i class="fa-solid fa-dice-d20 nimo-mp-logo"></i>
            <b class="nimo-mp-title" title="${esc(v.title)}">${esc(v.title)}</b>
            <small class="nimo-mp-round">Round ${s.round} · ${esc(MODES[s.mode]?.[0] || s.mode)}${s.timer ? ' · ' + esc(TIMERS[s.timer]) + ' per turn' : ''}</small>
            <div class="nimo-mp-actions">${actions.join('')}</div>
        </div>
        <div class="nimo-mp-row nimo-mp-seats">${seats.join('')}</div>
        <div class="nimo-mp-row nimo-mp-status">${status}</div>`;
    updateSendBox();
}

function updateSendBox() {
    const ta = document.getElementById('send_textarea');
    if (!ta) return;
    if (!ta.dataset.nimoPlaceholder) ta.dataset.nimoPlaceholder = ta.placeholder;
    if (!cur) return;
    const s = cur.view?.state;
    if (cur.gone) ta.placeholder = 'This multiplayer session is over.';
    else if (!s || !me()?.hasPersona) ta.placeholder = 'Choose your persona to join the session…';
    else if (myTurn()) ta.placeholder = 'Your turn! Write your action… ((double parentheses)) = out of character';
    else ta.placeholder = `${s.gen ? ctx().name2 + ' is writing' : s.paused ? 'Paused' : 'Waiting for ' + (s.turn === 'ai' ? cur.view.charName : s.turn === 'players' ? 'the other players' : nameOf(s.turn))}… ((double parentheses)) to chat out of character`;
}

async function onBarClick(e) {
    const b = e.target.closest('[data-a]');
    if (!b || !cur) return;
    const a = b.dataset.a;
    try {
        if (a === 'pass') await api('POST', `/sessions/${cur.sid}/pass`);
        else if (['force', 'stop', 'reroll'].includes(a)) await api('POST', `/sessions/${cur.sid}/control`, { action: a });
        else if (a === 'settings') await hostSettings();
        else if (a === 'info') await playerInfo();
        else if (a === 'persona') await pickPersona({ sid: cur.sid, title: cur.view.title, hostName: cur.view.hostName, charName: cur.view.charName }, true);
    } catch (err) { toastr.error(err.message, 'Multiplayer'); }
}

// =====================================================================================================
// Sending: in a multiplayer chat, the send button posts to the session instead of generating locally.
async function sendFromBox() {
    const ta = document.getElementById('send_textarea');
    let text = String(ta.value || '').trim();
    if (!text || !cur || cur.gone) return;
    let ooc = false;
    if (/^\(\(/.test(text)) { ooc = true; text = text.replace(/^\(\(\s*/, '').replace(/\s*\)\)\s*$/, ''); }
    else if (/^\/\//.test(text)) { ooc = true; text = text.replace(/^\/\/\s*/, ''); }
    if (!text) return;
    if (!me()?.hasPersona) { await pickPersona({ sid: cur.sid, title: cur.view.title, hostName: cur.view.hostName, charName: cur.view.charName }, true); return; }
    if (!ooc && !myTurn()) {
        toastr.warning('It\'s not your turn yet. Write ((like this)) to talk out of character meanwhile.', 'Multiplayer');
        return;
    }
    ta.value = ''; ta.dispatchEvent(new Event('input', { bubbles: true }));
    try { await api('POST', `/sessions/${cur.sid}/post`, { text, ooc }); }
    catch (err) { ta.value = (ooc ? '((' + text + '))' : text); ta.dispatchEvent(new Event('input', { bubbles: true })); toastr.error(err.message, 'Multiplayer'); }
}
function isSlashCommand(text) { return /^\/(?!\/)/.test(text.trim()); }

window.addEventListener('keydown', (e) => {
    if (!cur || e.target?.id !== 'send_textarea' || e.key !== 'Enter' || e.isComposing) return;
    if (!ctx().shouldSendOnEnter() || e.shiftKey || e.ctrlKey || e.altKey) return;
    if (isSlashCommand(e.target.value)) return; // slash commands still run locally
    e.preventDefault(); e.stopImmediatePropagation();
    sendFromBox();
}, true);
window.addEventListener('click', (e) => {
    if (!cur) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('#send_but')) {
        if (isSlashCommand(document.getElementById('send_textarea').value)) return;
        e.preventDefault(); e.stopImmediatePropagation();
        sendFromBox();
        return;
    }
    // Deleting a message: ask the session (the host can delete anything, players their own last message).
    const del = t?.closest('.mes_edit_delete');
    if (del) {
        const idx = Number(del.closest('.mes')?.getAttribute('mesid'));
        const msg = ctx().chat[idx];
        if (!msg?.extra?.nimo_id) return;
        e.preventDefault(); e.stopImmediatePropagation();
        (async () => {
            const ok = await ctx().Popup.show.confirm('Delete this message for everyone?', 'It will be removed from the multiplayer session.');
            if (!ok) return;
            cancelLocalEdit();
            try { await api('POST', `/sessions/${cur.sid}/delete`, { id: msg.extra.nimo_id }); } catch (err) { toastr.error(err.message, 'Multiplayer'); }
        })();
    }
}, true);

// Safety net: nothing may generate locally in a multiplayer chat (regenerate, continue, impersonate, /gen...).
globalThis.nimoMultiplayerInterceptor = async function (chat, _contextSize, abort, type) {
    if (!currentSid()) return;
    abort(true);
    if (type !== 'quiet') toastr.info('In multiplayer, the AI answers on its own turn.', 'Multiplayer', { preventDuplicates: true });
    // A message that slipped through (e.g. /send): remove the local copy and post it to the session instead.
    const c = ctx();
    const last = c.chat[c.chat.length - 1];
    if (cur && last?.is_user && !last.extra?.nimo_id) {
        const text = last.mes;
        await c.deleteLastMessage();
        if (myTurn()) api('POST', `/sessions/${cur.sid}/post`, { text, ooc: false }).catch((err) => toastr.error(err.message, 'Multiplayer'));
    }
};

// Edits made with SillyTavern's pencil go to the session.
async function onMessageEdited(idx) {
    if (!cur) return;
    const msg = ctx().chat[idx];
    if (!msg?.extra?.nimo_id) return;
    let text = String(msg.mes || '');
    if (msg.extra.nimo_ooc) text = text.replace(/^\(\(\s*/, '').replace(/\s*\)\)\s*$/, '');
    try { await api('POST', `/sessions/${cur.sid}/edit`, { id: msg.extra.nimo_id, text }); }
    catch (err) { toastr.error(err.message, 'Multiplayer'); await fullSync(); }
}

// =====================================================================================================
// Popups
async function popup(html, opts = {}) {
    const c = ctx();
    const p = new c.Popup(html, opts.type ?? c.POPUP_TYPE.CONFIRM, '', { okButton: opts.ok || 'OK', cancelButton: opts.cancel ?? 'Cancel', wide: opts.wide, large: opts.large, allowVerticalScrolling: true, onOpen: opts.onOpen, onClosing: opts.onClosing });
    const res = await p.show();
    return { res, el: p.dlg, ok: res === c.POPUP_RESULT.AFFIRMATIVE };
}
function providerFields(p = {}) {
    return `<div class="nimo-mp-grid">
        <label>Provider<select class="text_pole" name="ptype">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === (p.type || 'openrouter') ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}</select></label>
        <label class="nimo-mp-url">API URL (OpenAI-compatible, https)<input class="text_pole" name="purl" placeholder="https://my-proxy.example/v1" value="${esc(p.url || '')}"></label>
        <label>Model<input class="text_pole" name="pmodel" value="${esc(p.model || '')}" placeholder="${esc(PROVIDERS[p.type || 'openrouter'].model)}"></label>
        <label>API key for multiplayer<input class="text_pole" name="pkey" type="password" autocomplete="off" placeholder="${p.hasKey ? 'Saved (leave empty to keep it)' : 'Paste a key you only use for multiplayer'}"></label>
    </div>
    <div class="flex-container alignItemsCenter"><div class="menu_button menu_button_icon" data-test><i class="fa-solid fa-plug"></i><span>Test connection</span></div><small class="nimo-mp-test"></small></div>`;
}
function wireProvider(el, sid) {
    const type = el.querySelector('[name=ptype]');
    const sync = () => {
        el.querySelector('.nimo-mp-url').style.display = type.value === 'custom' ? '' : 'none';
        el.querySelector('[name=pmodel]').placeholder = PROVIDERS[type.value].model;
    };
    type.addEventListener('change', sync); sync();
    el.querySelector('[data-test]').addEventListener('click', async () => {
        const out = el.querySelector('.nimo-mp-test');
        out.textContent = 'Testing…';
        try { await api('POST', '/test-provider', { provider: readProvider(el), sid }); out.innerHTML = '<span class="nimo-mp-ok"><i class="fa-solid fa-check"></i> Connected</span>'; }
        catch (err) { out.textContent = err.message; }
    });
}
const readProvider = (el) => ({ type: el.querySelector('[name=ptype]').value, url: el.querySelector('[name=purl]').value.trim(), model: el.querySelector('[name=pmodel]').value.trim(), key: el.querySelector('[name=pkey]').value.trim() });
function samplingFields(s = {}) {
    return `<div class="nimo-mp-grid">
        <label>Context size (tokens)<input class="text_pole" type="number" name="context" min="1024" max="2000000" value="${esc(s.context ?? 16384)}"></label>
        <label>Max reply length (tokens)<input class="text_pole" type="number" name="maxTokens" min="16" max="32000" value="${esc(s.maxTokens ?? 600)}"></label>
        <label>Temperature<input class="text_pole" type="number" name="temperature" step="0.05" min="0" max="2" value="${esc(s.temperature ?? 1)}"></label>
        <label>Top P<input class="text_pole" type="number" name="topP" step="0.01" min="0" max="1" value="${esc(s.topP ?? 1)}"></label>
    </div>`;
}
const readSampling = (el) => Object.fromEntries(['context', 'maxTokens', 'temperature', 'topP'].map((k) => [k, Number(el.querySelector(`[name=${k}]`).value)]));
function rulesFields(r = {}) {
    return `<div class="nimo-mp-grid">
        <label>Turn mode<select class="text_pole" name="mode">${Object.entries(MODES).map(([k, v]) => `<option value="${k}" ${k === (r.mode || 'ordered') ? 'selected' : ''}>${esc(v[0])}</option>`).join('')}</select></label>
        <label>Players (you included)<select class="text_pole" name="maxPlayers">${[2, 3, 4, 5, 6].map((n) => `<option ${n === (r.maxPlayers || 6) ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
        <label>Skip a player after<select class="text_pole" name="timer">${Object.entries(TIMERS).map(([k, v]) => `<option value="${k}" ${Number(k) === (r.timer || 0) ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    </div><small class="nimo-mp-modehelp"></small>`;
}
function wireRules(el) {
    const sel = el.querySelector('[name=mode]'), help = el.querySelector('.nimo-mp-modehelp');
    const sync = () => { help.textContent = MODES[sel.value][1]; };
    sel.addEventListener('change', sync); sync();
}
async function loreChoices(selected = []) {
    let names = Array.isArray(world_names) ? [...world_names] : [];
    if (!names.length) { try { const r = await fetch('/api/worldinfo/list', { method: 'POST', headers: ctx().getRequestHeaders(), body: '{}' }); names = (await r.json()).map((x) => x.name); } catch { /* */ } }
    if (!names.length) return '<small>No lorebooks yet. You can create them in World Info, then add them here later.</small>';
    return `<div class="nimo-mp-lore">${names.map((n) => `<label class="checkbox_label"><input type="checkbox" name="lore" value="${esc(n)}" ${selected.includes(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div>`;
}
async function readLore(el) {
    const out = [];
    for (const cb of el.querySelectorAll('[name=lore]:checked')) {
        const data = await ctx().loadWorldInfo(cb.value);
        for (const e of Object.values(data?.entries || {})) {
            if (e.disable) continue;
            out.push({ key: e.key || [], keysecondary: e.keysecondary || [], selective: !!e.selective, selectiveLogic: e.selectiveLogic ?? 0, constant: !!e.constant, content: String(e.content || ''), order: e.order ?? 100, scanDepth: Number.isInteger(e.scanDepth) ? e.scanDepth : null, caseSensitive: !!e.caseSensitive, matchWholeWords: e.matchWholeWords ?? true });
        }
    }
    return out;
}

/** Host: turn the open chat into a multiplayer session. */
async function makeMultiplayer() {
    const c = ctx();
    if (c.groupId || c.characterId === undefined) { toastr.info('Open a chat with a character first.', 'Multiplayer'); return; }
    if (currentSid()) return hostSettings();
    await c.unshallowCharacter?.(c.characterId);
    const ch = c.characters[c.characterId];
    const charWorld = ch?.data?.extensions?.world;
    const html = `<div class="nimo-mp-form">
        <h3><i class="fa-solid fa-dice-d20"></i> Make this chat multiplayer</h3>
        <p>Play with up to 5 friends, turn by turn, with <b>${esc(ch.name)}</b> as the AI. Invite them by their NimoTavern username; they'll get the invite in their mailbox.</p>
        ${PRIVACY_NOTE}
        <label class="checkbox_label nimo-mp-agree"><input type="checkbox" name="agree"><span>I understand that the server reads this session to run the AI, and I'll use a separate API key for multiplayer.</span></label>
        <h4>Session</h4>
        <div class="nimo-mp-grid"><label>Title<input class="text_pole" name="title" maxlength="100" value="${esc(ch.name)}"></label></div>
        ${rulesFields()}
        <h4>AI for this session <small>(separate from your solo connection)</small></h4>
        ${providerFields()}
        ${samplingFields({ context: Math.min(c.maxContext || 16384, 32768) })}
        <h4>World</h4>
        <label>World setting <small>(only the AI sees it)</small><textarea class="text_pole" name="world" rows="4" placeholder="The kingdom of… Magic works like… The players start in…"></textarea></label>
        <label>Lorebooks <small>(only the AI sees them)</small></label>
        ${await loreChoices(charWorld ? [charWorld] : [])}
        <details><summary>Prompt</summary>
            <label>Main prompt<textarea class="text_pole" name="main" rows="4">${esc(DEFAULT_MAIN)}</textarea></label>
            <label>Instruction after the chat<textarea class="text_pole" name="post" rows="2">${esc(DEFAULT_POST)}</textarea></label>
            <small>{{char}} is the character, {{group}} the players' names. The character card's own system prompt, if it has one, replaces the main prompt.</small>
        </details>
        <label class="checkbox_label"><input type="checkbox" name="history" checked><span>Bring the messages of this chat into the session</span></label>
        <h4>Invite friends <small>(optional, you can invite later)</small></h4>
        <input class="text_pole" name="invite" placeholder="usernames, separated by commas">
    </div>`;
    const { ok, el } = await popup(html, {
        ok: 'Start multiplayer', wide: true, large: true,
        onOpen: (p) => { wireProvider(p.dlg); wireRules(p.dlg); },
        onClosing: (p) => {
            if (p.result !== ctx().POPUP_RESULT.AFFIRMATIVE) return true;
            const d = p.dlg;
            if (!d.querySelector('[name=agree]').checked) { toastr.warning('Please read and accept the privacy note first.'); return false; }
            const prov = readProvider(d);
            if (!prov.model) { toastr.warning('Choose a model for the multiplayer AI.'); return false; }
            if (!prov.key && prov.type !== 'custom') { toastr.warning('Enter the API key for multiplayer.'); return false; }
            return true;
        },
    });
    if (!ok) return;
    const busy = toastr.info('Creating the session…', 'Multiplayer', { timeOut: 0 });
    try {
        const d = el;
        const persona = await myPersona();
        if (!persona.name) throw new Error('Pick a persona first (Persona Management).');
        const charAvatar = await fetchB64(`/thumbnail?type=avatar&file=${encodeURIComponent(ch.avatar)}`);
        const body = {
            title: d.querySelector('[name=title]').value.trim() || ch.name,
            mode: d.querySelector('[name=mode]').value, maxPlayers: Number(d.querySelector('[name=maxPlayers]').value), timer: Number(d.querySelector('[name=timer]').value),
            persona,
            config: {
                card: { name: ch.name, description: ch.data?.description ?? ch.description, personality: ch.data?.personality ?? ch.personality, scenario: ch.data?.scenario ?? ch.scenario, first_mes: ch.data?.first_mes ?? ch.first_mes, mes_example: ch.data?.mes_example ?? ch.mes_example, system_prompt: ch.data?.system_prompt, post_history_instructions: ch.data?.post_history_instructions, avatar: charAvatar },
                world: d.querySelector('[name=world]').value, lorebook: await readLore(d),
                prompts: { main: d.querySelector('[name=main]').value === DEFAULT_MAIN ? '' : d.querySelector('[name=main]').value, post: d.querySelector('[name=post]').value === DEFAULT_POST ? '' : d.querySelector('[name=post]').value },
                provider: readProvider(d), sampling: readSampling(d),
            },
            history: d.querySelector('[name=history]').checked ? c.chat.filter((m) => !m.is_system && m.mes).map((m) => ({ kind: m.is_user ? 'player' : 'ai', name: m.name, text: m.mes })) : [],
        };
        const { sid } = await api('POST', '/sessions', body);
        ctx().chatMetadata.nimo_mp = { sid, rev: 0 };
        await ctx().saveMetadata();
        const invites = d.querySelector('[name=invite]').value.split(/[,\s]+/).map((x) => x.trim().replace(/^@/, '')).filter(Boolean);
        for (const u of invites) { try { await api('POST', `/sessions/${sid}/invite`, { username: u }); } catch (err) { toastr.warning(`${u}: ${err.message}`, 'Invite'); } }
        toastr.clear(busy);
        toastr.success(invites.length ? `Invites sent to ${invites.join(', ')}.` : 'Invite friends from the Session button.', 'Multiplayer session started');
        await onChatChanged();
    } catch (err) { toastr.clear(busy); toastr.error(err.message, 'Multiplayer'); }
}

async function myPersona() {
    const c = ctx();
    const pu = c.powerUserSettings;
    const file = user_avatar;
    const description = pu.persona_descriptions?.[file]?.description ?? pu.persona_description ?? '';
    return { name: c.name1, description, avatar: file ? await fetchB64(`/thumbnail?type=persona&file=${encodeURIComponent(file)}`) : null };
}

/** Invited player: pick which persona to play, then the session gets its own character in the list. */
async function pickPersona(s, force = false) {
    if (!force && dismissed.has(s.sid)) return;
    const c = ctx();
    const personas = Object.entries(c.powerUserSettings.personas || {});
    const cards = personas.map(([file, name]) => `<label class="nimo-mp-persona"><input type="radio" name="persona" value="${esc(file)}" ${file === user_avatar ? 'checked' : ''}>
        <img src="/thumbnail?type=persona&file=${encodeURIComponent(file)}" alt=""><span><b>${esc(name)}</b><small>${esc((c.powerUserSettings.persona_descriptions?.[file]?.description || '').slice(0, 140))}</small></span></label>`).join('');
    const { ok, el } = await popup(`<div class="nimo-mp-form">
        <h3><i class="fa-solid fa-dice-d20"></i> ${esc(s.title)}</h3>
        <p><b>@${esc(s.hostName)}</b> invited you to play with <b>${esc(s.charName)}</b>. Who will you play as?</p>
        <div class="nimo-mp-personas">${cards || '<small>You have no personas yet. Your current name will be used.</small>'}</div>
        <small>The other players and the AI see this persona's name, picture and description.</small>
        ${PRIVACY_NOTE}</div>`, { ok: 'Join the session', cancel: 'Later', wide: true });
    if (!ok) { dismissed.add(s.sid); return; }
    const file = el.querySelector('[name=persona]:checked')?.value || user_avatar;
    const persona = {
        name: c.powerUserSettings.personas?.[file] || c.name1,
        description: c.powerUserSettings.persona_descriptions?.[file]?.description || '',
        avatar: file ? await fetchB64(`/thumbnail?type=persona&file=${encodeURIComponent(file)}`) : null,
    };
    try {
        await api('POST', `/sessions/${s.sid}/persona`, { persona });
        await openSessionChat(s);
        if (cur?.sid === s.sid) await fullSync();
    } catch (err) { toastr.error(err.message, 'Multiplayer'); }
}

/** Finds (or creates) the local character that holds this session's chat for an invited player. */
async function openSessionChat(s) {
    let c = ctx();
    let idx = c.characters.findIndex((x) => x?.data?.extensions?.nimo_mp?.sid === s.sid);
    if (idx < 0) {
        const fd = new FormData();
        const fields = { ch_name: s.charName, description: `Multiplayer session "${s.title}", hosted by @${s.hostName}. The character's definition stays with the host; this card only holds your copy of the chat.`, first_mes: '', personality: '', scenario: '', mes_example: '', creator_notes: `NimoTavern multiplayer session hosted by @${s.hostName}`, talkativeness: '0.5', fav: 'false', tags: '', world: '', depth_prompt_prompt: '', depth_prompt_depth: '4', depth_prompt_role: 'system', extensions: JSON.stringify({ nimo_mp: { sid: s.sid } }) };
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        try { const r = await fetch(avatarUrl(s.sid, 'char')); if (r.ok) fd.append('avatar', await r.blob(), 'avatar.png'); } catch { /* */ }
        const h = { ...c.getRequestHeaders() }; delete h['Content-Type'];
        const r = await fetch('/api/characters/create', { method: 'POST', headers: h, body: fd });
        if (!r.ok) throw new Error('Could not add the session to your characters');
        const avatar = await r.text();
        await c.getCharacters();
        c = ctx();
        idx = c.characters.findIndex((x) => x.avatar === avatar);
    }
    if (idx >= 0) await c.selectCharacterById(idx);
}

/** On load and when the mailbox changes: sessions you accepted but haven't set up yet. */
let checking = false;
async function checkJoined() {
    if (checking) return; checking = true;
    try {
        const list = await api('GET', '/sessions');
        for (const s of list) {
            if (s.me?.role !== 'player' || s.me.hasPersona) continue;
            await pickPersona({ sid: s.sid, title: s.title, hostName: s.hostName, charName: s.charName });
        }
    } catch { /* offline */ } finally { checking = false; }
}

async function playerInfo() {
    const v = cur.view;
    const { res, el } = await popup(`<div class="nimo-mp-form">
        <h3><i class="fa-solid fa-dice-d20"></i> ${esc(v.title)}</h3>
        <p>Hosted by <b>@${esc(v.hostName)}</b> · ${esc(MODES[v.state.mode][0])}: ${esc(MODES[v.state.mode][1])}</p>
        <p>Players: ${v.members.map((m) => `<b>${esc(m.name || m.username)}</b> (@${esc(m.username)})`).join(', ')}</p>
        <p><small>Write <code>((like this))</code> to talk out of character: the AI never sees it. You can edit or delete your last message until the AI answers.</small></p>
        ${PRIVACY_NOTE}
        <div class="menu_button menu_button_icon redWarningBG" data-leave><i class="fa-solid fa-door-open"></i><span>Leave this session</span></div>
    </div>`, { type: ctx().POPUP_TYPE.TEXT, ok: 'Close', cancel: false, wide: true, onOpen: (p) => p.dlg.querySelector('[data-leave]').addEventListener('click', async () => {
        if (!await ctx().Popup.show.confirm('Leave this session?', 'You can only come back if the host invites you again. Your copy of the chat stays.')) return;
        try { await api('POST', `/sessions/${cur.sid}/leave`); p.completeCancelled(); sessionGone('You left this session.'); } catch (err) { toastr.error(err.message); }
    }) });
    void res; void el;
}

async function hostSettings() {
    const sid = cur.sid;
    const cfg = await api('GET', `/sessions/${sid}/config`);
    const v = cur.view;
    const playersHtml = () => cur.view.state.order.map((mid, i) => {
        const m = cur.view.members.find((x) => x.mid === mid);
        return `<div class="nimo-mp-player" data-mid="${esc(mid)}"><span>${i + 1}. <b>${esc(m?.name || m?.username)}</b> <small>@${esc(m?.username)}${m?.role === 'host' ? ' · host' : ''}</small></span>
            <span><i class="fa-solid fa-arrow-up menu_button" data-up title="Move up"></i><i class="fa-solid fa-arrow-down menu_button" data-down title="Move down"></i>${m?.role === 'host' ? '' : '<i class="fa-solid fa-user-xmark menu_button redWarningBG" data-kick title="Remove from the session"></i>'}</span></div>`;
    }).join('') + cur.view.members.filter((m) => !cur.view.state.order.includes(m.mid)).map((m) => `<div class="nimo-mp-player"><span><b>@${esc(m.username)}</b> <small>choosing a persona…</small></span><span><i class="fa-solid fa-user-xmark menu_button redWarningBG" data-kick data-mid2="${esc(m.mid)}" title="Remove"></i></span></div>`).join('');
    const html = `<div class="nimo-mp-form">
        <h3><i class="fa-solid fa-dice-d20"></i> Session settings</h3>
        <div class="nimo-mp-grid"><label>Title<input class="text_pole" name="title" maxlength="100" value="${esc(cfg.title)}"></label></div>
        <h4>Players <small>(${v.members.length}/${cfg.maxPlayers})</small></h4>
        <div class="nimo-mp-players">${playersHtml()}</div>
        <div class="flex-container alignItemsCenter"><input class="text_pole flex1" name="invite" placeholder="Invite by username"><div class="menu_button menu_button_icon" data-invite><i class="fa-solid fa-envelope"></i><span>Invite</span></div></div>
        <div class="flex-container"><div class="menu_button menu_button_icon" data-ctl="skip"><i class="fa-solid fa-forward"></i><span>Skip current turn</span></div>
        <div class="menu_button menu_button_icon" data-ctl="pausetoggle"><i class="fa-solid ${v.state.paused ? 'fa-play' : 'fa-pause'}"></i><span>${v.state.paused ? 'Resume' : 'Pause'}</span></div></div>
        <h4>Rules</h4>${rulesFields(cfg)}
        <h4>AI <small>(this session's own provider)</small></h4>${providerFields(cfg.provider)}${samplingFields(cfg.sampling)}
        <h4>World</h4>
        <label>World setting<textarea class="text_pole" name="world" rows="4">${esc(cfg.world)}</textarea></label>
        <label>Lorebooks <small>(${cfg.lorebookEntries} entries in the session now; tick books to replace them)</small></label>
        ${await loreChoices()}
        <details><summary>Prompt</summary>
            <label>Main prompt<textarea class="text_pole" name="main" rows="4">${esc(cfg.prompts.main || DEFAULT_MAIN)}</textarea></label>
            <label>Instruction after the chat<textarea class="text_pole" name="post" rows="2">${esc(cfg.prompts.post || DEFAULT_POST)}</textarea></label>
        </details>
        ${PRIVACY_NOTE}
        <h4>End the session</h4>
        <div class="menu_button menu_button_icon redWarningBG" data-end><i class="fa-solid fa-trash"></i><span>End and delete the session for everyone</span></div>
    </div>`;
    const { ok, el } = await popup(html, {
        ok: 'Save', wide: true, large: true,
        onOpen: (p) => {
            const d = p.dlg;
            wireProvider(d, sid); wireRules(d);
            d.querySelector('[data-invite]').addEventListener('click', async () => {
                const inp = d.querySelector('[name=invite]');
                const u = inp.value.trim().replace(/^@/, '');
                if (!u) return;
                try { const r = await api('POST', `/sessions/${sid}/invite`, { username: u }); toastr.success(r.message, 'Invite'); inp.value = ''; } catch (err) { toastr.error(err.message, 'Invite'); }
            });
            d.querySelectorAll('[data-ctl]').forEach((b) => b.addEventListener('click', async () => {
                const action = b.dataset.ctl === 'pausetoggle' ? (cur.view.state.paused ? 'resume' : 'pause') : b.dataset.ctl;
                try { await api('POST', `/sessions/${sid}/control`, { action }); p.completeCancelled(); } catch (err) { toastr.error(err.message); }
            }));
            d.querySelector('.nimo-mp-players').addEventListener('click', async (e) => {
                const row = e.target.closest('.nimo-mp-player');
                const mid = e.target.dataset.mid2 || row?.dataset.mid;
                if (!mid) return;
                try {
                    if (e.target.matches('[data-kick]')) {
                        if (!await ctx().Popup.show.confirm('Remove this player?', 'They lose access to the session (their own copy of the chat stays with them).')) return;
                        await api('POST', `/sessions/${sid}/kick`, { mid });
                        row.remove();
                    } else if (e.target.matches('[data-up],[data-down]')) {
                        const order = [...cur.view.state.order];
                        const i = order.indexOf(mid), j = i + (e.target.matches('[data-up]') ? -1 : 1);
                        if (j < 0 || j >= order.length) return;
                        [order[i], order[j]] = [order[j], order[i]];
                        await api('POST', `/sessions/${sid}/control`, { action: 'order', order });
                        cur.view.state.order = order;
                        d.querySelector('.nimo-mp-players').innerHTML = playersHtml();
                    }
                } catch (err) { toastr.error(err.message); }
            });
            d.querySelector('[data-end]').addEventListener('click', async () => {
                if (!await ctx().Popup.show.confirm('End this session for everyone?', 'Everything stored on the server for it is deleted for good. Everyone keeps their own copy of the chat.')) return;
                try { await api('POST', `/sessions/${sid}/end`); p.completeCancelled(); sessionGone('You ended this session.'); } catch (err) { toastr.error(err.message); }
            });
        },
    });
    if (!ok) return;
    try {
        const prov = readProvider(el);
        const body = {
            title: el.querySelector('[name=title]').value, mode: el.querySelector('[name=mode]').value, timer: Number(el.querySelector('[name=timer]').value), maxPlayers: Number(el.querySelector('[name=maxPlayers]').value),
            world: el.querySelector('[name=world]').value, sampling: readSampling(el),
            prompts: { main: el.querySelector('[name=main]').value === DEFAULT_MAIN ? '' : el.querySelector('[name=main]').value, post: el.querySelector('[name=post]').value === DEFAULT_POST ? '' : el.querySelector('[name=post]').value },
        };
        if (prov.model) body.provider = prov;
        if (el.querySelectorAll('[name=lore]:checked').length) body.lorebook = await readLore(el);
        await api('POST', `/sessions/${sid}/config`, body);
        toastr.success('Session settings saved.', 'Multiplayer');
    } catch (err) { toastr.error(err.message, 'Multiplayer'); }
}

// =====================================================================================================
// Chat options menu entry
function updateMenu() {
    let item = document.getElementById('option_nimo_multiplayer');
    if (!item) {
        item = document.createElement('a');
        item.id = 'option_nimo_multiplayer';
        item.innerHTML = '<i class="fa-lg fa-solid fa-dice-d20"></i><span>Make multiplayer…</span>';
        document.getElementById('option_convert_to_group')?.after(item);
        item.addEventListener('click', () => { document.getElementById('options')?.style.setProperty('display', 'none'); (currentSid() ? (isHost() ? hostSettings() : playerInfo()) : makeMultiplayer()).catch((e) => toastr.error(e.message)); });
    }
    const c = ctx();
    const sid = currentSid();
    item.style.display = c.groupId || c.characterId === undefined ? 'none' : '';
    item.querySelector('span').textContent = sid ? 'Multiplayer session…' : 'Make multiplayer…';
}

// =====================================================================================================
const { eventSource, eventTypes } = ctx();
eventSource.on(eventTypes.CHAT_CHANGED, () => { onChatChanged().catch((e) => console.warn('[nimo-mp]', e)); });
eventSource.on(eventTypes.MESSAGE_EDITED, (idx) => { onMessageEdited(Number(idx)).catch(() => { }); });
eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, () => { if (cur) decorate(); });
eventSource.on(eventTypes.USER_MESSAGE_RENDERED, () => { if (cur) decorate(); });
connect();
onChatChanged().catch(() => { });
setTimeout(checkJoined, 2500);
window.nimoMultiplayer = { openSessionChat, makeMultiplayer };
