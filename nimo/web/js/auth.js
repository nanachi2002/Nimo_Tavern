// Login / register / recover pages.
import { api, unlockWithDek, passwordProof, showError, strengthMeter, showPhrase, swSupported, ensureServiceWorker } from './common.js';
import { KDF_DEFAULT, randomBytes, b64, unb64, derivePasswordKeys, deriveRecoveryKeys, newRecoveryPhrase, isValidPhrase, wrapDek, unwrapDek } from '../../shared/crypto.js';

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

if (!swSupported()) showError(err, 'Your browser doesn\'t support the features NimoTavern needs (Service Workers, IndexedDB, WebCrypto). Try an up-to-date Firefox, Chrome or Safari, outside private browsing.');
else ensureServiceWorker().catch(() => { }); // warm up early

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
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showError(err, '');
        const fd = new FormData(form);
        const username = String(fd.get('username')).trim();
        setBusy(true, 'Deriving your key…');
        try {
            const { kek, authKey } = await passwordProof(username, String(fd.get('password')));
            const res = await api('/auth/login', { username, authKey });
            setBusy(true, 'Decrypting your tavern…');
            const dek = await unwrapDek(kek, res.wrappedPw);
            await unlockWithDek(dek, res.username);
            location.replace(new URLSearchParams(location.search).get('next')?.startsWith('/') ? new URLSearchParams(location.search).get('next') : '/');
        } catch (ex) {
            setBusy(false);
            showError(err, ex.status === 401 ? 'Wrong username or password.' : ex.message);
        }
    });
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
