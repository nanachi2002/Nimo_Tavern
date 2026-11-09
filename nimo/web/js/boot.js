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

    let pendingWrites = 0;
    navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'nimo-locked') goLogin();
        if (e.data?.type === 'nimo-pending') pendingWrites = e.data.n;
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
        const ver = document.getElementById('version_display');
        if (ver) {
            const note = document.createElement('small');
            note.innerHTML = ' · <a href="https://sillytavern.app" target="_blank" rel="noopener" style="color:inherit"><i class="fa-solid fa-heart"></i> Fork of SillyTavern</a> · <a href="/wiki" target="_blank" style="color:inherit"><i class="fa-solid fa-book-open"></i> Wiki</a> · <a href="/privacy" target="_blank" style="color:inherit"><i class="fa-solid fa-lock"></i> NimoTavern, end-to-end encrypted</a>';
            ver.after(note);
        }
    });
})();
