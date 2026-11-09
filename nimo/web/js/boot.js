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

    if (!('serviceWorker' in navigator)) {
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
        style.textContent = '#logout_button,#account_button{display:flex !important}#admin_button{display:none !important}';
        document.head.append(style);
        const acct = document.getElementById('account_button');
        if (acct) acct.title = 'NimoTavern account, privacy & encryption';
        const ver = document.getElementById('version_display');
        if (ver) {
            const note = document.createElement('small');
            note.innerHTML = ' · <a href="/privacy" target="_blank" style="color:inherit"><i class="fa-solid fa-lock"></i> NimoTavern, end-to-end encrypted</a>';
            ver.after(note);
        }
    });
})();
