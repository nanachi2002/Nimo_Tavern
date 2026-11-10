// Injected at the very top of SillyTavern's index.html.
// Makes sure the NimoTavern Service Worker controls the page and the tavern is unlocked,
// and wires SillyTavern's Account / Logout buttons to NimoTavern.
(function () {
    const goLogin = () => location.replace('/login?next=' + encodeURIComponent(location.pathname));

    function overlay(text) {
        let o = document.getElementById('nimo-overlay');
        if (!o) {
            o = document.createElement('div');
            o.id = 'nimo-overlay';
            o.innerHTML = '<img src="/img/logo.png" alt=""><div id="nimo-overlay-text"></div>';
            (document.body || document.documentElement).append(o);
        }
        o.querySelector('#nimo-overlay-text').textContent = text;
        return o;
    }

    if (!navigator.serviceWorker) { // undefined in iOS in-app browsers
        document.addEventListener('DOMContentLoaded', () => overlay('Your browser doesn\'t support Service Workers, which NimoTavern needs. (Private browsing often disables them.)'));
        return;
    }

    if (!navigator.serviceWorker.controller) {
        // Hard refresh or first visit on this device: the SW must take control before SillyTavern runs.
        document.documentElement.style.visibility = 'hidden';
        navigator.serviceWorker.register('/nimo-sw.js', { scope: '/', updateViaCache: 'none' })
            .then(() => navigator.serviceWorker.ready)
            .then(() => { if (!sessionStorage.getItem('nimo-reloaded')) { sessionStorage.setItem('nimo-reloaded', '1'); location.reload(); } else goLogin(); })
            .catch(goLogin);
        window.stop?.();
        return;
    }
    sessionStorage.removeItem('nimo-reloaded');

    // play.<site> is the multiplayer site: a separate origin where extensions never run.
    const PLAY = location.hostname.toLowerCase().startsWith('play.');
    const playUrl = () => location.protocol + '//play.' + location.host;

    // Only NimoTavern's own Service Worker may live on this site. An extension could register another one to
    // keep running after logout (on a shared computer): remove anything that isn't ours.
    navigator.serviceWorker.getRegistrations?.().then((regs) => {
        for (const r of regs) {
            const script = (r.active || r.waiting || r.installing)?.scriptURL || '';
            if (r.scope !== location.origin + '/' || !script.startsWith(location.origin + '/nimo-sw.js')) r.unregister();
        }
    }).catch(() => { });

    // The first extension install shows what an extension can and can't do, and asks for consent.
    if (!PLAY) {
        const nativeFetch = window.fetch.bind(window);
        window.fetch = async function (input, init) {
            let path = '';
            try { path = new URL(typeof input === 'string' ? input : input?.url || '', location.href).pathname; } catch { /* */ }
            if (path === '/api/extensions/install') {
                // Re-check unless already known: consent may have been given in another tab since this one loaded.
                const status = window.nimoStatus?.extensionsConsent ? window.nimoStatus : await nativeFetch('/api/nimo-local/status').then((r) => r.json()).catch(() => ({}));
                if (!status.extensionsConsent) {
                    if (!await extensionConsent()) return new Response('Installation cancelled.', { status: 400 });
                    await nativeFetch('/api/nimo-local/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extensionsConsent: true }) });
                    window.nimoStatus = { ...status, extensionsConsent: true };
                }
            }
            return nativeFetch(input, init);
        };
    }
    function extensionConsent() {
        return new Promise((resolve) => {
            const d = document.createElement('div');
            d.id = 'nimo-ext-consent';
            d.innerHTML = `<div class="nimo-ext-box" role="dialog" aria-modal="true" aria-labelledby="nimo-ext-title">
                <h3 id="nimo-ext-title"><i class="fa-solid fa-puzzle-piece"></i> Before you install an extension</h3>
                <p>Extensions are code written by other people. On NimoTavern they run <b>only in your browser</b>, never on our server.</p>
                <ul>
                    <li><b>It can read and change everything in your tavern</b> (characters, chats, settings, API keys) and act as you. Only install extensions from authors you trust.</li>
                    <li><b>It can't reach other users</b>, their data, or our server.</li>
                    <li><b>Extensions are always off in multiplayer.</b> Multiplayer runs on its own site, <code>play.${location.host}</code>, where no extension can load, so they never see your group sessions or the other players.</li>
                    <li>Your browser downloads the files straight from GitHub (GitHub sees your visit like any other). We don't see what you install.</li>
                    <li>SillyTavern <b>server plugins</b> (Node.js) don't run here, because they'd run on a server shared by everyone. Their authors can port them to <a href="/wiki/nimoframework" target="_blank">NimoFramework</a>.</li>
                </ul>
                <div class="nimo-ext-actions"><button class="menu_button" data-a="no">Cancel</button><button class="menu_button nimo-ext-ok" data-a="yes">I understand, install</button></div>
            </div>`;
            document.body.append(d);
            d.querySelector('.nimo-ext-ok').focus();
            d.addEventListener('click', (e) => {
                const a = e.target instanceof Element ? e.target.closest('[data-a]')?.getAttribute('data-a') : null;
                if (!a && e.target !== d) return;
                d.remove();
                resolve(a === 'yes');
            });
        });
    }

    fetch('/api/nimo-local/status').then(r => r.json()).then((s) => {
        if (!s.unlocked) goLogin();
        window.nimoStatus = s;
    }).catch(goLogin);

    // SillyTavern's own "couldn't get CSRF token" toast is a dead end, so check the same request ourselves:
    // retry once automatically, otherwise explain what went wrong and offer a way out.
    fetch('/csrf-token', { cache: 'no-store' }).then(async (r) => {
        if (r.ok) { sessionStorage.removeItem('nimo-csrf-retry'); return; }
        if (r.status === 401) return; // locked: the status check above sends us to the login page
        let why = ''; try { why = (await r.text()).slice(0, 300); } catch { /* */ }
        if (!sessionStorage.getItem('nimo-csrf-retry')) { sessionStorage.setItem('nimo-csrf-retry', '1'); location.reload(); return; }
        const o = overlay('NimoTavern could not start' + (why ? ': ' + why.replace(/^\{"error":"|"\}$/g, '') : '.'));
        if (!o.querySelector('button')) {
            const b = document.createElement('div');
            b.style.cssText = 'display:flex;gap:10px';
            b.innerHTML = '<button style="padding:8px 16px;cursor:pointer" id="nimo-retry">Try again</button><button style="padding:8px 16px;cursor:pointer" id="nimo-relogin">Log in again</button>';
            o.append(b);
            b.querySelector('#nimo-retry').onclick = () => { sessionStorage.removeItem('nimo-csrf-retry'); location.reload(); };
            b.querySelector('#nimo-relogin').onclick = goLogin;
        }
    }).catch(() => { });

    // Lets an extension know it runs on NimoTavern (and which NimoFramework version) without a request.
    try { Object.defineProperty(window, 'NimoTavern', { value: Object.freeze({ framework: 1, play: PLAY }), enumerable: true }); } catch { /* */ }

    // A NimoFramework plugin that could not start: say so on screen (once per problem), not only in the console.
    const pluginErrorsShown = new Set();
    function pluginError(folder, error, tries = 0) {
        const key = folder + '\n' + error;
        if (pluginErrorsShown.has(key)) return;
        if (!window.toastr) { if (tries < 40) setTimeout(() => pluginError(folder, error, tries + 1), 500); return; }
        pluginErrorsShown.add(key);
        const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
        window.toastr.error(`${esc(error)}<br><small>The rest of the extension still loads. Details for its author: <a href="/wiki/nimoframework#debugging" target="_blank">NimoFramework guide</a></small>`,
            `Extension "${esc(folder)}": its server part could not start`, { timeOut: 20000, extendedTimeOut: 10000, escapeHtml: false });
    }

    let pendingWrites = 0;
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'nimo-locked') goLogin();
        if (e.data?.type === 'nimo-pending') pendingWrites = e.data.n;
        if (e.data?.type === 'nimo-plugin-error') pluginError(String(e.data.folder || ''), String(e.data.error || ''));
        // What NimoFramework plugins print (they run in the Service Worker) is shown here, in the page's console.
        if (e.data?.type === 'nimo-plugin-log') {
            const level = ['log', 'info', 'warn', 'error', 'debug'].includes(e.data.level) ? e.data.level : 'log';
            console[level](`[${String(e.data.tag || 'plugin')}]`, ...(Array.isArray(e.data.args) ? e.data.args : []));
        }
    });
    window.addEventListener('beforeunload', (e) => {
        if (pendingWrites > 0) { e.preventDefault(); e.returnValue = ''; } // encrypted changes still uploading
    });
    // Check for a new NimoTavern version now and then.
    navigator.serviceWorker.getRegistration().then(r => setInterval(() => r?.update(), 30 * 60_000));

    async function logout() {
        try { await fetch('/api/nimo/auth/logout', { method: 'POST', headers: { 'X-Nimo-Client': 'web' } }); } catch { /* */ }
        try { await fetch('/api/nimo-local/lock', { method: 'POST' }); } catch { /* */ }
        // Also wipe SillyTavern's own browser caches (IndexedDB / localStorage).
        try { for (const d of await indexedDB.databases()) if (d.name) indexedDB.deleteDatabase(d.name); } catch { /* */ }
        try { localStorage.clear(); sessionStorage.clear(); } catch { /* */ }
        location.replace('/home');
    }

    // Capture-phase: runs before SillyTavern's own jQuery handlers on these buttons.
    window.addEventListener('click', (e) => {
        const t = e.target instanceof Element ? e.target.closest('#logout_button, #account_button') : null;
        if (!t) return;
        e.preventDefault();
        e.stopPropagation();
        if (t.id === 'logout_button') logout();
        else location.href = '/account';
    }, true);

    document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '#logout_button,#account_button,#nimo_wiki_button,#nimo_stats_button{display:flex !important}#admin_button{display:none !important}';
        document.head.append(style);
        const acct = document.getElementById('account_button');
        if (acct) {
            acct.title = 'NimoTavern account, privacy & encryption';
            // Wiki button right next to Account (opens in a new tab so the tavern keeps running).
            const wiki = document.createElement('a');
            wiki.id = 'nimo_wiki_button';
            wiki.className = 'margin0 menu_button_icon menu_button';
            wiki.href = '/wiki'; wiki.target = '_blank'; wiki.rel = 'noopener';
            wiki.title = 'NimoTavern Wiki: guides for every feature, and how your privacy is protected';
            wiki.innerHTML = '<i class="fa-fw fa-solid fa-book-open"></i><span>Wiki</span>';
            acct.after(wiki);
            // Statistics panel: shown only if the server says this account is the admin (the server enforces it too).
            fetch('/api/nimo/auth/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then((me) => {
                if (!me?.admin) return;
                const st = document.createElement('a');
                st.id = 'nimo_stats_button';
                st.className = 'margin0 menu_button_icon menu_button';
                st.href = '/stats'; st.target = '_blank'; st.rel = 'noopener';
                st.title = 'NimoTavern statistics (admin)';
                st.innerHTML = '<i class="fa-fw fa-solid fa-chart-line"></i><span>Stats</span>';
                wiki.after(st);
            }).catch(() => { });
        }
        // Mailbox badge: multiplayer invites and notices waiting on the Account page.
        async function refreshBadge() {
            let n = 0;
            try { const r = await fetch('/api/nimo/mp/inbox/count', { credentials: 'same-origin' }); if (r.ok) n = (await r.json()).n || 0; } catch { return; }
            for (const host of [document.querySelector('#user-settings-button .drawer-toggle'), document.getElementById('account_button')]) {
                if (!host) continue;
                let b = host.querySelector(':scope > .nimo-badge');
                if (!n) { b?.remove(); continue; }
                if (!b) { b = document.createElement('span'); b.className = 'nimo-badge'; host.append(b); }
                b.textContent = n > 9 ? '9+' : String(n);
                b.title = PLAY ? `${n} new in your mailbox (Account)` : `${n} new in your multiplayer mailbox (on play.${location.host})`;
            }
            if (acct) acct.title = n ? `NimoTavern account: ${n} new in your mailbox` : 'NimoTavern account, privacy & encryption';
        }
        refreshBadge();
        setInterval(refreshBadge, 60_000);
        if (PLAY) {
            document.body.classList.add('nimo-play');
            // One reminder per visit: what's different on the multiplayer site.
            if (!sessionStorage.getItem('nimo-play-note')) {
                sessionStorage.setItem('nimo-play-note', '1');
                setTimeout(() => window.toastr?.info('Extensions are off here for everyone\'s safety. Changes you make on this site (settings, characters…) stay on this device and don\'t sync to the main site.', 'Multiplayer site', { timeOut: 12000 }), 3000);
            }
        }
        window.addEventListener('nimo-inbox', refreshBadge); // pushed live by the multiplayer extension
        const ver = document.getElementById('version_display');
        if (ver) {
            const note = document.createElement('small');
            note.innerHTML = ' · <a href="https://sillytavern.app" target="_blank" rel="noopener" style="color:inherit"><i class="fa-solid fa-heart"></i> Built on SillyTavern</a> · <a href="/wiki" target="_blank" style="color:inherit"><i class="fa-solid fa-book-open"></i> Wiki</a> · <a href="/privacy" target="_blank" style="color:inherit"><i class="fa-solid fa-lock"></i> NimoTavern, end-to-end encrypted</a>';
            ver.after(note);
        }
    });
})();
