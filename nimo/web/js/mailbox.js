// Account page mailbox: multiplayer invites (accept / decline / block) and notices.
import { api, showError } from './common.js';

const $ = (s) => document.querySelector(s);
const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MODE_LABEL = { ordered: 'Ordered rounds', free: 'Free rounds', alternate: 'Strict alternation' };
const ago = (d) => { const s = (Date.now() - new Date(d)) / 1000; return s < 60 ? 'just now' : s < 3600 ? Math.floor(s / 60) + ' min ago' : s < 86400 ? Math.floor(s / 3600) + ' h ago' : new Date(d).toLocaleDateString(); };
const NOTICE = {
    turn: (n) => ['fa-dice-d20', `It's your turn in <b>${escHtml(n.title)}</b>.`],
    joined: (n) => ['fa-user-plus', `<b>@${escHtml(n.who)}</b> joined <b>${escHtml(n.title)}</b>.`],
    declined: (n) => ['fa-user-xmark', `<b>@${escHtml(n.who)}</b> declined your invite to <b>${escHtml(n.title)}</b>.`],
    left: (n) => ['fa-door-open', `<b>@${escHtml(n.who)}</b> left <b>${escHtml(n.title)}</b>.`],
    kicked: (n) => ['fa-door-closed', `The host removed you from <b>${escHtml(n.title)}</b>. Your copy of the chat stays on this site.`],
    ended: (n) => ['fa-flag-checkered', `<b>@${escHtml(n.who)}</b> ended <b>${escHtml(n.title)}</b>. Your copy of the chat stays on this site.`],
};
const MP_PRIVACY = `<div class="nimo-mail-privacy"><b><i class="fa-solid fa-triangle-exclamation"></i> Multiplayer isn't end-to-end encrypted.</b>
    To run the AI for everyone, the NimoTavern server reads the session while it writes the prompt (your messages and your persona's name, picture and description).
    Sessions are encrypted at rest, never logged, and deleted when the host ends them. Your solo chats stay end-to-end encrypted.
    <a href="/privacy#multiplayer" target="_blank">Details</a></div>`;

async function loadMailbox() {
    let box;
    try { box = await api('/mp/inbox'); } catch { return; }
    const inv = $('#mail-invites'), nts = $('#mail-notices');
    inv.innerHTML = box.invites.map((i) => `<div class="nimo-mail-card" data-id="${escHtml(i.id)}">
        <i class="fa-solid fa-dice-d20 nimo-mail-icon"></i>
        <div class="nimo-mail-body">
            <div><b>@${escHtml(i.from)}</b> invites you to play <b>${escHtml(i.title)}</b> with <b>${escHtml(i.charName)}</b></div>
            <div class="nimo-muted">${escHtml(MODE_LABEL[i.mode] || i.mode)} · ${i.players}/${i.maxPlayers} players · ${ago(i.created)}</div>
            <div class="nimo-mail-actions" data-main>
                <button class="menu_button primary" data-act="accept"><i class="fa-solid fa-check"></i> Accept</button>
                <button class="menu_button" data-act="decline"><i class="fa-solid fa-xmark"></i> Decline</button>
                <button class="menu_button" data-act="block" title="Decline and never get invites from this user again"><i class="fa-solid fa-ban"></i> Block @${escHtml(i.from)}</button>
            </div>
            <div class="nimo-mail-confirm" hidden>${MP_PRIVACY}<div class="nimo-mail-actions"><button class="menu_button primary" data-act="join"><i class="fa-solid fa-dice-d20"></i> I understand, join</button><button class="menu_button" data-act="back">Back</button></div></div>
            <div class="nimo-error"></div>
        </div></div>`).join('');
    nts.innerHTML = box.notices.length ? `<div class="nimo-mail-notices">${box.notices.map((n) => {
        const [icon, html] = (NOTICE[n.kind] || (() => ['fa-bell', escHtml(n.kind)]))(n);
        return `<div class="nimo-mail-notice ${n.seen ? '' : 'new'}"><i class="fa-solid ${icon}"></i><span>${html}</span><small class="nimo-muted">${ago(n.created)}</small></div>`;
    }).join('')}</div><button class="menu_button" id="mail-clear" style="width:auto"><i class="fa-solid fa-broom"></i> Clear notices</button>` : '';
    $('#mail-empty').hidden = !!(box.invites.length || box.notices.length);
    const unseen = box.invites.length + box.notices.filter((n) => !n.seen).length;
    $('#mail-count').hidden = !unseen;
    $('#mail-count').textContent = unseen;
    if (box.notices.some((n) => !n.seen)) api('/mp/inbox/seen', {}).catch(() => { });
    $('#mail-clear')?.addEventListener('click', async () => { await api('/mp/inbox/clear', {}).catch(() => { }); loadMailbox(); });
}

async function loadMailSettings() {
    let s;
    try { s = await api('/mp/settings'); } catch { return; }
    $('#mail-allow').checked = s.invites === 'anyone';
    $('#mail-blocked').innerHTML = s.blocked.length ? 'Blocked: ' + s.blocked.map((u) => `<span class="nimo-mail-blocked">@${escHtml(u)} <a href="#" data-unblock="${escHtml(u)}">unblock</a></span>`).join(' ') : '';
}

const PLAY = location.hostname.toLowerCase().startsWith('play.');

/** Main site: multiplayer (and its mailbox) lives on play.<host>, out of reach of extensions. Only the count shows here. */
async function mainSiteMailbox() {
    const url = `${location.protocol}//play.${location.host}/account#mailbox`;
    let n = 0;
    try { n = (await fetch('/api/nimo/mp/inbox/count', { credentials: 'same-origin' }).then((r) => r.json())).n || 0; } catch { /* */ }
    $('#mail-invites').innerHTML = `<p>${n ? `You have <b>${n}</b> new invite${n > 1 ? 's or notices' : ' or notice'}.` : 'Multiplayer invites and news are waiting for you on the multiplayer site.'}</p>
        <p class="nimo-muted">Multiplayer has its own site, <b>play.${escHtml(location.host)}</b>, where extensions can never run, so they can't see your group sessions or the other players. Log in there with the same username and password.</p>
        <a class="menu_button primary" style="width:auto;text-decoration:none;display:inline-flex" href="${escHtml(url)}"><i class="fa-solid fa-dice-d20"></i> Open the multiplayer site</a>`;
    $('#mail-count').hidden = !n;
    $('#mail-count').textContent = n;
    $('#mail-empty').hidden = true;
    document.querySelector('.nimo-mail-settings')?.setAttribute('hidden', '');
}

export function initMailbox() {
    if (!PLAY) { mainSiteMailbox(); return; }
    $('#mail-invites').addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const card = btn.closest('.nimo-mail-card');
        const id = card.dataset.id, act = btn.dataset.act;
        const err = card.querySelector('.nimo-error');
        const main = card.querySelector('[data-main]'), confirmBox = card.querySelector('.nimo-mail-confirm');
        if (act === 'accept') { confirmBox.hidden = false; main.hidden = true; return; }
        if (act === 'back') { confirmBox.hidden = true; main.hidden = false; return; }
        btn.disabled = true;
        try {
            if (act === 'join') {
                await api(`/mp/invites/${id}/accept`, {});
                card.innerHTML = `<div class="nimo-mail-body"><div class="nimo-ok"><i class="fa-solid fa-check"></i> You joined! Open the tavern on this site: it will ask which persona you want to play.</div>
                    <div class="nimo-mail-actions"><a class="menu_button primary" href="/" style="text-decoration:none"><i class="fa-solid fa-door-open"></i> Open my tavern</a></div></div>`;
            } else {
                await api(`/mp/invites/${id}/decline`, { block: act === 'block' });
                card.remove();
                loadMailSettings();
            }
        } catch (ex) { showError(err, ex.message); btn.disabled = false; }
    });
    $('#mail-allow').addEventListener('change', async () => { await api('/mp/settings', { invites: $('#mail-allow').checked ? 'anyone' : 'nobody' }).catch(() => { }); loadMailSettings(); });
    $('#mail-blocked').addEventListener('click', async (e) => {
        const u = e.target.dataset.unblock;
        if (!u) return;
        e.preventDefault();
        await api('/mp/unblock', { username: u }).catch(() => { });
        loadMailSettings();
    });
    loadMailbox();
    loadMailSettings();
    setInterval(loadMailbox, 60_000);
    if (location.hash === '#mailbox') setTimeout(() => $('#mailbox')?.scrollIntoView({ behavior: 'smooth' }), 300);
}
