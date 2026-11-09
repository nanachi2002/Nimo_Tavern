// Account page: relay preference, password change, recovery rotation, export, deletion.
import { api, passwordProof, showError, swMessage, ensureServiceWorker } from './common.js';
import { KDF_DEFAULT, randomBytes, b64, derivePasswordKeys, deriveRecoveryKeys, newRecoveryPhrase, wrapDek, unwrapDek, wipeLocal } from '../../shared/crypto.js';

const $ = (s) => document.querySelector(s);
const fmt = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.ceil(b / 1024) + ' KB';
let me;

async function init() {
    try { me = await api('/auth/me'); } catch { location.replace('/login?next=/account'); return; }
    $('#acc-name').textContent = me.username;
    $('#acc-info').textContent = `Member since ${new Date(me.created).toLocaleDateString()} · ${fmt(me.used)} of ${fmt(me.quota)} encrypted storage used`;
    $('#quota-bar').style.width = Math.min(100, me.used / me.quota * 100).toFixed(1) + '%';
    await ensureServiceWorker();
    const st = await fetch('/api/nimo-local/status').then(r => r.json()).catch(() => ({}));
    if (!st.unlocked) { location.replace('/login?next=/account'); return; }
    $('#relay-enabled').checked = !!st.relayEnabled;
    $('#relay-always').checked = !!st.relayAlways;
    $('#relay-always').disabled = !st.relayEnabled;
    $('#img-optimize').checked = st.optimizeImages !== false;
}

$('#img-optimize').addEventListener('change', async () => {
    const r = await fetch('/api/nimo-local/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optimizeImages: $('#img-optimize').checked }) });
    $('#img-msg').textContent = r.ok ? 'Saved (encrypted, synced to your other devices). Applies to new uploads only.' : 'Could not save.';
});

async function saveRelay() {
    const relayEnabled = $('#relay-enabled').checked;
    $('#relay-always').disabled = !relayEnabled;
    if (!relayEnabled) $('#relay-always').checked = false;
    const r = await fetch('/api/nimo-local/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ relayEnabled, relayAlways: $('#relay-always').checked }) });
    $('#relay-msg').textContent = r.ok ? 'Saved (encrypted, synced to your other devices).' : 'Could not save.';
}
$('#relay-enabled').addEventListener('change', saveRelay);
$('#relay-always').addEventListener('change', saveRelay);

/** Re-prove the current password and get the data key back. */
async function unlockDek(current) {
    const { kek, authKey } = await passwordProof(me.username, current);
    const { wrappedPw } = await api('/auth/wrapped', { currentAuth: authKey });
    return { dek: await unwrapDek(kek, wrappedPw), currentAuth: authKey };
}

$('#pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget; const fd = new FormData(f);
    showError($('#pw-err'), ''); $('#pw-ok').innerHTML = '';
    if (fd.get('password') !== fd.get('password2')) return showError($('#pw-err'), 'New passwords don\'t match');
    f.querySelector('button').disabled = true;
    try {
        const { dek, currentAuth } = await unlockDek(String(fd.get('current')));
        const saltPw = randomBytes(16);
        const { kek, authKey } = await derivePasswordKeys(me.username, String(fd.get('password')), saltPw, KDF_DEFAULT);
        await api('/auth/change-password', { currentAuth, kdf: KDF_DEFAULT, saltPw: b64(saltPw), authPw: authKey, wrappedPw: await wrapDek(kek, dek) });
        dek.fill(0);
        f.reset();
        $('#pw-ok').innerHTML = '<div class="nimo-ok">Password changed. Your other devices have been logged out.</div>';
    } catch (ex) { showError($('#pw-err'), ex.status === 401 ? 'Current password is wrong' : ex.message); }
    f.querySelector('button').disabled = false;
});

$('#rec-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.currentTarget; const fd = new FormData(f);
    showError($('#rec-err'), '');
    f.querySelector('button').disabled = true;
    try {
        const { dek, currentAuth } = await unlockDek(String(fd.get('current')));
        const phrase = newRecoveryPhrase();
        const saltRec = randomBytes(16);
        const { kek, authKey } = await deriveRecoveryKeys(me.username, phrase, saltRec);
        await api('/auth/rotate-recovery', { currentAuth, saltRec: b64(saltRec), authRec: authKey, wrappedRec: await wrapDek(kek, dek) });
        dek.fill(0);
        f.reset();
        const box = $('#phrase'); box.innerHTML = '';
        for (const w of phrase.split(' ')) { const s = document.createElement('span'); s.textContent = w; box.append(s); }
        $('#rec-out').hidden = false;
    } catch (ex) { showError($('#rec-err'), ex.status === 401 ? 'Password is wrong' : ex.message); }
    f.querySelector('button').disabled = false;
});

$('#export').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try {
        const r = await fetch('/api/users/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!r.ok) throw new Error('Export failed');
        const blob = await r.blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `nimotavern-${me.username}-${new Date().toISOString().slice(0, 10)}.zip`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (ex) { alert(ex.message); }
    btn.disabled = false;
});

$('#logout-all').addEventListener('click', async () => {
    if (!confirm('Log out on all devices, including this one?')) return;
    await api('/auth/logout-all', {});
    await swMessage({ type: 'nimo-lock', wipe: true }).catch(() => { });
    await wipeLocal();
    location.replace('/login');
});

$('#del-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    showError($('#del-err'), '');
    if (!confirm('Permanently delete your NimoTavern account and all of its data? This can\'t be undone.')) return;
    try {
        const { authKey } = await passwordProof(me.username, String(fd.get('current')));
        await api('/auth/delete-account', { currentAuth: authKey });
        await swMessage({ type: 'nimo-lock', wipe: true }).catch(() => { });
        await wipeLocal();
        location.replace('/home');
    } catch (ex) { showError($('#del-err'), ex.status === 401 ? 'Password is wrong' : ex.message); }
});

init();
