// Login / register / recover pages.
import { api, unlockWithDek, passwordProof, showError, strengthMeter, showPhrase, swSupported, ensureServiceWorker, unsupportedMessage } from './common.js';
import { KDF_DEFAULT, randomBytes, b64, unb64, derivePasswordKeys, deriveRecoveryKeys, newRecoveryPhrase, isValidPhrase, wrapDek, unwrapDek } from '../../shared/crypto.js';
import { scrypt } from 'hash-wasm';

const form = document.querySelector('form[data-page]');
const page = form?.dataset.page;
const err = document.getElementById('err');
const busy = document.getElementById('busy');
const submitBtn = form?.querySelector('button[type=submit]');

function setBusy(on, text) {
    busy.classList.toggle('show', on);
    if (text) busy.querySelector('span').textContent = text;
    submitBtn.disabled = on;
    for (const i of form.querySelectorAll('input,textarea')) i.readOnly = on;
}

const supported = swSupported();
if (!supported && form) {
    // Block everything up front: never claim an account or create keys in a browser that can't run the tavern.
    showError(err, unsupportedMessage());
    form.addEventListener('submit', (e) => { e.preventDefault(); e.stopImmediatePropagation(); showError(err, unsupportedMessage()); }, true);
    submitBtn.disabled = true;
} else if (supported) ensureServiceWorker().catch(() => { }); // warm up early

async function newPasswordMaterial(username, password) {
    const saltPw = randomBytes(16);
    const { kek, authKey } = await derivePasswordKeys(username, password, saltPw, KDF_DEFAULT);
    return { kek, saltPw, authPw: authKey };
}
async function newRecoveryMaterial(username) {
    const phrase = newRecoveryPhrase();
    const saltRec = randomBytes(16);
    const { kek, authKey } = await deriveRecoveryKeys(username, phrase, saltRec);
    return { phrase, kek, saltRec, authRec: authKey };
}

let turnstileToken = null;
async function setupTurnstile() {
    const cfg = await api('/auth/config').catch(() => ({}));
    if (!cfg.turnstileSiteKey) return;
    window.nimoTurnstileCb = (t) => { turnstileToken = t; };
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = () => window.turnstile.render('#turnstile', { sitekey: cfg.turnstileSiteKey, theme: 'dark', callback: window.nimoTurnstileCb, 'expired-callback': () => { turnstileToken = null; } });
    document.head.append(s);
}

function checkPasswords(fd) {
    if (fd.get('password') !== fd.get('password2')) throw new Error('Passwords don\'t match');
    if (String(fd.get('password')).length < 10) throw new Error('Password must be at least 10 characters');
}

if (page === 'login') {
    const panel = document.getElementById('phrase-panel');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(err, '');
        const fd = new FormData(form);
        const username = String(fd.get('username')).trim();
        const password = String(fd.get('password'));
        const next = new URLSearchParams(location.search).get('next');
        const target = next?.startsWith('/') ? next : '/';
        setBusy(true, 'Deriving your key…');
        try {
            const pre = await api('/auth/prelogin', { username });
            if (pre.legacy) return await claimLegacy(username, password, pre.legacy.salt, target);
            const { kek, authKey } = await derivePasswordKeys(username, password, unb64(pre.salt), pre.kdf);
            const res = await api('/auth/login', { username, authKey });
            setBusy(true, 'Decrypting your tavern…');
            const dek = await unwrapDek(kek, res.wrappedPw);
            await unlockWithProgress(dek, res.username);
            location.replace(target);
        } catch (ex) {
            setBusy(false);
            showError(err, ex.status === 401 ? 'Wrong username or password.' : ex.message);
        }
    });

    // First login of an account imported from the previous SillyTavern server.
    async function claimLegacy(username, password, stSalt, target) {
        setBusy(true, 'Checking your SillyTavern password…');
        // Same hash SillyTavern uses (scrypt N=16384, r=8, p=1, 64 bytes), computed here so the password never leaves the browser.
        const stHash = b64(await scrypt({ password: password.normalize(), salt: stSalt, costFactor: 16384, blockSize: 8, parallelism: 1, hashLength: 64, outputType: 'binary' }));
        setBusy(true, 'Creating your encrypted account…');
        const dek = randomBytes(32);
        const pw = await newPasswordMaterial(username, password);
        const rec = await newRecoveryMaterial(username);
        const res = await api('/auth/legacy/claim', {
            username, stHash, kdf: KDF_DEFAULT,
            saltPw: b64(pw.saltPw), authPw: pw.authPw, wrappedPw: await wrapDek(pw.kek, dek),
            saltRec: b64(rec.saltRec), authRec: rec.authRec, wrappedRec: await wrapDek(rec.kek, dek),
        });
        form.hidden = true;
        panel.hidden = false;
        showPhrase(panel, rec.phrase, res.username);
        const status = panel.querySelector('#import-status');
        const btn = panel.querySelector('#enter-tavern');
        let imported = false;
        const updateBtn = () => { btn.disabled = !(imported && panel.querySelector('#saved-phrase').checked); };
        panel.querySelector('#saved-phrase').addEventListener('change', updateBtn);
        btn.addEventListener('click', () => location.replace(target));
        try {
            await unlockWithProgress(dek, res.username, (t) => { status.textContent = t; });
            imported = true;
            status.innerHTML = '<i class="fa-solid fa-check"></i> Your SillyTavern data was imported and encrypted.';
            updateBtn();
        } catch (ex) {
            status.textContent = 'Import interrupted (' + ex.message + '). Log in again to resume, nothing is lost.';
        }
    }
}

/** Unlock and forward the Service Worker's progress messages (used for big imports). */
async function unlockWithProgress(dek, username, onProgress) {
    const show = onProgress || ((t) => setBusy(true, t));
    const listener = (e) => { if (e.data?.type === 'nimo-progress') show(e.data.text); };
    navigator.serviceWorker.addEventListener('message', listener);
    try { await unlockWithDek(dek, username); } finally { navigator.serviceWorker.removeEventListener('message', listener); }
}

if (page === 'register') {
    strengthMeter(form.password, document.getElementById('strength'));
    setupTurnstile();
    const panel = document.getElementById('phrase-panel');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(err, '');
        const fd = new FormData(form);
        try { checkPasswords(fd); } catch (ex) { return showError(err, ex.message); }
        const username = String(fd.get('username')).trim();
        setBusy(true, 'Generating your keys…');
        try {
            const dek = randomBytes(32);
            const pw = await newPasswordMaterial(username, String(fd.get('password')));
            const rec = await newRecoveryMaterial(username);
            await api('/auth/register', {
                username, kdf: KDF_DEFAULT,
                saltPw: b64(pw.saltPw), authPw: pw.authPw, wrappedPw: await wrapDek(pw.kek, dek),
                saltRec: b64(rec.saltRec), authRec: rec.authRec, wrappedRec: await wrapDek(rec.kek, dek),
                turnstile: turnstileToken,
            });
            setBusy(true, 'Setting up your tavern…');
            const dekCopy = new Uint8Array(dek);
            dek.fill(0);
            const unlocking = unlockWithDek(dekCopy, username);
            form.hidden = true;
            panel.hidden = false;
            showPhrase(panel, rec.phrase, username);
            panel.querySelector('#enter-tavern').addEventListener('click', async (ev) => {
                ev.currentTarget.disabled = true;
                ev.currentTarget.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Opening…';
                try { await unlocking; location.replace('/'); } catch (ex2) { alert(ex2.message); location.replace('/login'); }
            });
        } catch (ex) {
            setBusy(false);
            showError(err, ex.message);
            if (window.turnstile) window.turnstile.reset();
        }
    });
}

if (page === 'recover') {
    strengthMeter(form.password, document.getElementById('strength'));
    const panel = document.getElementById('phrase-panel');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(err, '');
        const fd = new FormData(form);
        const username = String(fd.get('username')).trim();
        const phrase = String(fd.get('phrase'));
        try {
            checkPasswords(fd);
            if (!isValidPhrase(phrase)) throw new Error('That recovery phrase isn\'t valid. Check the spelling and the word order.');
        } catch (ex) { return showError(err, ex.message); }
        setBusy(true, 'Checking your recovery phrase…');
        try {
            const start = await api('/auth/recover/start', { username });
            const old = await deriveRecoveryKeys(username, phrase, unb64(start.salt));
            const a = await api('/auth/recover/finish', { username, authRec: old.authKey });
            const dek = await unwrapDek(old.kek, a.wrappedRec);
            setBusy(true, 'Setting your new password…');
            const pw = await newPasswordMaterial(username, String(fd.get('password')));
            const rec = await newRecoveryMaterial(username);
            const done = await api('/auth/recover/finish', {
                username, authRec: old.authKey,
                reset: {
                    kdf: KDF_DEFAULT,
                    saltPw: b64(pw.saltPw), authPw: pw.authPw, wrappedPw: await wrapDek(pw.kek, dek),
                    saltRec: b64(rec.saltRec), authRec: rec.authRec, wrappedRec: await wrapDek(rec.kek, dek),
                },
            });
            const unlocking = unlockWithDek(dek, done.username);
            form.hidden = true;
            panel.hidden = false;
            showPhrase(panel, rec.phrase, done.username);
            panel.querySelector('#enter-tavern').addEventListener('click', async (ev) => {
                ev.currentTarget.disabled = true;
                try { await unlocking; location.replace('/'); } catch (ex2) { alert(ex2.message); location.replace('/login'); }
            });
        } catch (ex) {
            setBusy(false);
            showError(err, ex.status === 401 ? 'Wrong username or recovery phrase.' : ex.message);
        }
    });
}
