// NimoTavern server.
// A deliberately "dumb" server: accounts + sessions + opaque encrypted blobs + an
// optional, stateless relay. It cannot read user data: all of it is encrypted in the
// browser with keys derived from the user's password, which never reaches us.
//
// Privacy rules for this file:
//   * never log request bodies, headers, IPs, usernames or blob contents
//   * IPs are only held in RAM (keyed hashes) for rate limiting and the daily unique-visitor count, never written anywhere
//   * usage statistics are aggregate counters only, see stats.js
import express from 'express';
import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createStats } from './stats.js';
import { isPublicIp, publicOnlyLookup } from './netguard.js';
import { createSealer } from './mp/seal.js';
import { createEngine } from './mp/engine.js';
import { createHub } from './mp/hub.js';
import { createRoutes } from './mp/routes.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..'); // SillyTavern fork root
const NIMO_DIST = path.resolve(here, '../dist/public');
const NIMO_WEB = path.resolve(here, '../web');
const NIMO_PAGES = path.resolve(here, '../dist/pages');

const env = (k, d) => process.env[k] ?? d;
const CFG = {
    port: Number(env('PORT', 8400)),
    host: env('HOST', '127.0.0.1'),
    db: env('DATABASE_URL', 'postgres:///nimotavern'),
    secret: env('NIMO_SECRET', ''),
    secureCookies: env('COOKIE_SECURE', '1') === '1',
    turnstileSite: env('TURNSTILE_SITE_KEY', ''),
    turnstileSecret: env('TURNSTILE_SECRET', ''),
    registrationOpen: env('REGISTRATION_OPEN', '1') === '1',
    quota: Number(env('DEFAULT_QUOTA_BYTES', 1024 * 1024 * 1024)),
    sourceUrl: env('SOURCE_URL', 'https://github.com/SillyTavern/SillyTavern'),
    sessionDays: Number(env('SESSION_DAYS', 30)),
    statsAdmin: env('STATS_ADMIN', 'ciel2002').toLowerCase(), // the only account allowed to open the stats panel
};
if (!CFG.secret || CFG.secret.length < 32) { console.error('NIMO_SECRET (>=32 chars) is required'); process.exit(1); }

const pool = new pg.Pool({ connectionString: CFG.db, max: 20 });
await pool.query(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
const stats = createStats({ pool, secret: CFG.secret });
await stats.init();
const isAdmin = (s) => !!s && s.username.toLowerCase() === CFG.statsAdmin;

const COOKIE = CFG.secureCookies ? '__Host-nimo' : 'nimo_session';
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.set('etag', false);

// ---------------------------------------------------------------------------
// Security headers
const CSP_APP = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https: wss: http://localhost:* http://127.0.0.1:*",
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP_APP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    if (CFG.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});

// ---------------------------------------------------------------------------
// Rate limiting (RAM only; keys are salted hashes of IP / user id)
const buckets = new Map();
const ipKey = (req) => crypto.createHmac('sha256', CFG.secret).update(String(req.ip)).digest('base64').slice(0, 16);
function limit(name, max, windowMs, keyFn = ipKey) {
    return (req, res, next) => {
        const k = name + ':' + keyFn(req);
        const now = Date.now();
        let b = buckets.get(k);
        if (!b || b.reset < now) { b = { n: 0, reset: now + windowMs }; buckets.set(k, b); }
        if (++b.n > max) { res.setHeader('Retry-After', Math.ceil((b.reset - now) / 1000)); return res.status(429).json({ error: 'Too many requests, slow down.' }); }
        next();
    };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

// ---------------------------------------------------------------------------
// Helpers
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const parseCookies = (h) => Object.fromEntries((h || '').split(';').map(s => s.trim().split('=')).filter(a => a.length === 2).map(([k, v]) => [k, decodeURIComponent(v)]));
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^[A-Za-z0-9+/=]{16,512}$/;
const BLOB_ID = /^[0-9a-f]{40}$/;

function scryptAsync(pw, salt) {
    return new Promise((res, rej) => crypto.scrypt(pw, salt, 32, { N: 16384, r: 8, p: 1 }, (e, k) => e ? rej(e) : res(k)));
}
async function hashAuth(authHex, salt) { return scryptAsync(Buffer.from(authHex, 'hex'), Buffer.concat([Buffer.from('nimo-auth:'), salt])); }
async function verifyAuth(authHex, salt, stored) {
    if (!HEX64.test(authHex || '')) return false;
    const h = await hashAuth(authHex, salt);
    return h.length === stored.length && crypto.timingSafeEqual(h, stored);
}
function fakeSalt(usernameLc, kind) { return crypto.createHmac('sha256', CFG.secret).update(kind + ':' + usernameLc).digest().subarray(0, 16); }

const KDF = { alg: 'argon2id', m: 65536, t: 3, p: 1 };
function validKdf(k) { return k && k.alg === 'argon2id' && Number.isInteger(k.m) && k.m >= 19456 && k.m <= 1048576 && Number.isInteger(k.t) && k.t >= 2 && k.t <= 10 && k.p === 1; }

// Multiplayer lives on its own subdomain (play.<site>): a separate browser origin, so extensions installed on the
// main site can never reach it. Same app, told apart by the Host header (nginx only forwards our own names).
const isPlayHost = (req) => String(req.hostname || req.headers?.host || '').toLowerCase().startsWith('play.');
const scopeOf = (req) => (isPlayHost(req) ? 'play' : 'main');

async function createSession(res, userId, req) {
    const token = crypto.randomBytes(32);
    const expires = new Date(Date.now() + CFG.sessionDays * 86400_000);
    await pool.query('INSERT INTO sessions (token_hash, user_id, expires_at, scope) VALUES ($1,$2,$3,$4)', [sha256(token), userId, expires, scopeOf(req)]);
    stats.count('logins');
    stats.markActive(userId);
    res.setHeader('Set-Cookie', `${COOKIE}=${token.toString('base64url')}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${CFG.secureCookies ? '; Secure' : ''}`);
}
function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${CFG.secureCookies ? '; Secure' : ''}`);
    // Shared computers: wipe everything this site stored in the browser (caches, IndexedDB, local storage, and any
    // Service Worker an extension may have registered), so nothing carries over to the next person.
    res.setHeader('Clear-Site-Data', '"cache", "storage"');
}

async function getSession(req) {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (!tok || tok.length > 64) return null;
    const { rows } = await pool.query('SELECT s.user_id, s.scope, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()', [sha256(Buffer.from(tok, 'base64url'))]);
    // A login only counts on the site it was made on (cookies are host-only anyway; this is defence in depth).
    if (!rows[0] || rows[0].scope !== scopeOf(req)) return null;
    return { userId: rows[0].user_id, username: rows[0].username, scope: rows[0].scope, tokenHash: sha256(Buffer.from(tok, 'base64url')) };
}

// CSRF: state-changing API calls must carry our custom header (cannot be sent cross-site without CORS preflight, which we never allow).
function requireClientHeader(req, res, next) {
    if (req.method !== 'GET' && !req.headers['x-nimo-client']) return res.status(403).json({ error: 'Missing client header' });
    next();
}
async function requireSession(req, res, next) {
    try {
        const s = await getSession(req);
        if (!s) return res.status(401).json({ error: 'Not logged in' });
        req.session = s;
        stats.markActive(s.userId);
        next();
    } catch (e) { next(e); }
}

async function verifyTurnstile(token) {
    if (!CFG.turnstileSecret) return true;
    if (!token || typeof token !== 'string') return false;
    try {
        const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: new URLSearchParams({ secret: CFG.turnstileSecret, response: token }) });
        return (await r.json()).success === true;
    } catch { return false; }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const jsonSmall = express.json({ limit: '16kb' });

// ---------------------------------------------------------------------------
// Auth API
const auth = express.Router();
auth.use(requireClientHeader);

auth.get('/config', (_req, res) => res.json({ turnstileSiteKey: CFG.turnstileSite || null, registrationOpen: CFG.registrationOpen, kdf: KDF, quota: CFG.quota }));

auth.post('/prelogin', limit('prelogin', 30, 60_000), jsonSmall, wrap(async (req, res) => {
    const u = String(req.body?.username || '');
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Invalid username' });
    const { rows } = await pool.query('SELECT salt_pw, kdf FROM users WHERE username_lc = $1', [u.toLowerCase()]);
    if (rows[0]) return res.json({ salt: rows[0].salt_pw.toString('base64'), kdf: rows[0].kdf });
    // Account imported from the old SillyTavern instance, not claimed yet.
    const { rows: leg } = await pool.query('SELECT st_salt FROM legacy_accounts WHERE username_lc = $1 AND claimed_user IS NULL', [u.toLowerCase()]);
    if (leg[0]) return res.json({ salt: fakeSalt(u.toLowerCase(), 'pw').toString('base64'), kdf: KDF, legacy: { salt: leg[0].st_salt } });
    // Unknown users get a stable fake salt so the endpoint doesn't reveal who has an account.
    res.json({ salt: fakeSalt(u.toLowerCase(), 'pw').toString('base64'), kdf: KDF });
}));

auth.post('/register', limit('register', 5, 3600_000), jsonSmall, wrap(async (req, res) => {
    if (!CFG.registrationOpen) return res.status(403).json({ error: 'Registration is closed' });
    if (isPlayHost(req)) return res.status(403).json({ error: 'Create your account on the main site first, then log in here.' });
    const b = req.body || {};
    if (!USERNAME_RE.test(b.username || '')) return res.status(400).json({ error: 'Username must be 3-32 characters: letters, numbers, _ . -' });
    if (!validKdf(b.kdf) || !HEX64.test(b.authPw || '') || !HEX64.test(b.authRec || '') || !B64.test(b.wrappedPw || '') || !B64.test(b.wrappedRec || '')) return res.status(400).json({ error: 'Invalid registration data' });
    const saltPw = Buffer.from(String(b.saltPw || ''), 'base64'); const saltRec = Buffer.from(String(b.saltRec || ''), 'base64');
    if (saltPw.length !== 16 || saltRec.length !== 16) return res.status(400).json({ error: 'Invalid salt' });
    const { rows: reserved } = await pool.query('SELECT 1 FROM legacy_accounts WHERE username_lc = $1', [b.username.toLowerCase()]);
    if (reserved[0]) return res.status(409).json({ error: 'This username belongs to an imported SillyTavern account. Log in with its existing password instead.' });
    if (!await verifyTurnstile(b.turnstile)) return res.status(400).json({ error: 'Captcha failed, please retry.' });
    try {
        const { rows } = await pool.query(
            `INSERT INTO users (username, username_lc, kdf, salt_pw, auth_pw_hash, salt_rec, auth_rec_hash, wrapped_pw, wrapped_rec, quota_bytes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [b.username, b.username.toLowerCase(), b.kdf, saltPw, await hashAuth(b.authPw, saltPw), saltRec, await hashAuth(b.authRec, saltRec), b.wrappedPw, b.wrappedRec, CFG.quota]);
        await createSession(res, rows[0].id, req);
        stats.count('signups');
        res.json({ ok: true, username: b.username });
    } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'This username is taken' });
        throw e;
    }
}));

// Guessing protection per account. With Turnstile configured, an account that has seen CAPTCHA_AFTER failed
// attempts requires a captcha for every further attempt (instead of a lockout, which anyone could use to lock a
// known username out). Unknown usernames are counted the same way, in RAM only, so the captcha prompt doesn't
// reveal which accounts exist.
const CAPTCHA_AFTER = 5;
const nameFails = new Map(); // HMAC(kind:username) -> { n, reset }
const nameKey = (kind, ulc) => crypto.createHmac('sha256', CFG.secret).update(kind + ':' + ulc).digest('base64').slice(0, 16);
function ramFails(kind, ulc) { const b = nameFails.get(nameKey(kind, ulc)); return b && b.reset > Date.now() ? b.n : 0; }
function bumpRamFails(kind, ulc) {
    const k = nameKey(kind, ulc); const now = Date.now();
    let b = nameFails.get(k); if (!b || b.reset < now) { b = { n: 0, reset: now + 24 * 3600_000 }; nameFails.set(k, b); }
    return ++b.n;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of nameFails) if (b.reset < now) nameFails.delete(k); }, 3600_000).unref();
const captchaOn = () => !!CFG.turnstileSecret;
const captchaNeeded = (res) => res.status(403).json({ error: 'Too many failed attempts on this account. Please complete the check below, then try again.', captcha: true, siteKey: CFG.turnstileSite });

auth.post('/login', limit('login', 20, 15 * 60_000), jsonSmall, wrap(async (req, res) => {
    const u = String(req.body?.username || '');
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Invalid credentials' });
    const ulc = u.toLowerCase();
    const { rows } = await pool.query('SELECT id, username, salt_pw, auth_pw_hash, wrapped_pw, failed_logins, locked_until FROM users WHERE username_lc = $1', [ulc]);
    const user = rows[0];
    const fails = user ? user.failed_logins : ramFails('login', ulc);
    if (captchaOn()) {
        if (fails >= CAPTCHA_AFTER && !await verifyTurnstile(req.body?.turnstile)) return captchaNeeded(res);
    } else if (user?.locked_until && user.locked_until > new Date()) return res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });
    const ok = user ? await verifyAuth(req.body.authKey, user.salt_pw, user.auth_pw_hash) : (await hashAuth('0'.repeat(64), Buffer.alloc(16)), false);
    if (!ok) {
        let n;
        if (user) {
            const r = await pool.query(`UPDATE users SET failed_logins = failed_logins + 1, locked_until = CASE WHEN $2 AND failed_logins + 1 >= 10 THEN now() + interval '15 minutes' ELSE NULL END WHERE id = $1 RETURNING failed_logins`, [user.id, !captchaOn()]);
            n = r.rows[0].failed_logins;
        } else n = bumpRamFails('login', ulc);
        return res.status(401).json({ error: 'Invalid username or password', captcha: captchaOn() && n >= CAPTCHA_AFTER, siteKey: CFG.turnstileSite });
    }
    await pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);
    await createSession(res, user.id, req);
    res.json({ ok: true, username: user.username, wrappedPw: user.wrapped_pw });
}));

auth.post('/logout', wrap(async (req, res) => {
    const s = await getSession(req);
    if (s) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [s.tokenHash]);
    clearCookie(res);
    res.json({ ok: true });
}));

auth.get('/me', wrap(async (req, res) => {
    const s = await getSession(req);
    if (!s) return res.status(401).json({ error: 'Not logged in' });
    const { rows } = await pool.query('SELECT username, created_at, used_bytes, quota_bytes FROM users WHERE id = $1', [s.userId]);
    const { rows: leg } = await pool.query('SELECT size FROM legacy_accounts WHERE claimed_user = $1', [s.userId]);
    res.json({ username: rows[0].username, created: rows[0].created_at, used: Number(rows[0].used_bytes), quota: Number(rows[0].quota_bytes), legacyPending: leg[0] ? Number(leg[0].size) : 0, admin: isAdmin(s) });
}));

// Recovery: step 1 returns the recovery salt (fake for unknown users)
auth.post('/recover/start', limit('recover', 10, 3600_000), jsonSmall, wrap(async (req, res) => {
    const u = String(req.body?.username || '');
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Invalid username' });
    const { rows } = await pool.query('SELECT salt_rec FROM users WHERE username_lc = $1', [u.toLowerCase()]);
    res.json({ salt: (rows[0]?.salt_rec ?? fakeSalt(u.toLowerCase(), 'rec')).toString('base64') });
}));

// Recovery: step 2 proves knowledge of the phrase, returns the DEK wrapped by the recovery key, and
// accepts a new password (and a rotated recovery phrase) in the same request.
auth.post('/recover/finish', limit('recover', 10, 3600_000), jsonSmall, wrap(async (req, res) => {
    const b = req.body || {};
    const u = String(b.username || '');
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Invalid username' });
    const { rows } = await pool.query('SELECT id, username, salt_rec, auth_rec_hash, wrapped_rec FROM users WHERE username_lc = $1', [u.toLowerCase()]);
    const user = rows[0];
    if (!user || !await verifyAuth(b.authRec, user.salt_rec, user.auth_rec_hash)) return res.status(401).json({ error: 'Invalid username or recovery phrase' });
    if (!b.reset) return res.json({ ok: true, wrappedRec: user.wrapped_rec }); // phase A: let the client unwrap the DEK
    const r = b.reset;
    const saltPw = Buffer.from(String(r.saltPw || ''), 'base64'); const saltRec = Buffer.from(String(r.saltRec || ''), 'base64');
    if (!validKdf(r.kdf) || saltPw.length !== 16 || saltRec.length !== 16 || !HEX64.test(r.authPw || '') || !HEX64.test(r.authRec || '') || !B64.test(r.wrappedPw || '') || !B64.test(r.wrappedRec || '')) return res.status(400).json({ error: 'Invalid data' });
    await pool.query(`UPDATE users SET kdf=$2, salt_pw=$3, auth_pw_hash=$4, wrapped_pw=$5, salt_rec=$6, auth_rec_hash=$7, wrapped_rec=$8, failed_logins=0, locked_until=NULL WHERE id=$1`,
        [user.id, r.kdf, saltPw, await hashAuth(r.authPw, saltPw), r.wrappedPw, saltRec, await hashAuth(r.authRec, saltRec), r.wrappedRec]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    await createSession(res, user.id, req);
    res.json({ ok: true, username: user.username });
}));

async function reauth(req) {
    const { rows } = await pool.query('SELECT salt_pw, auth_pw_hash FROM users WHERE id = $1', [req.session.userId]);
    return rows[0] && verifyAuth(req.body?.currentAuth, rows[0].salt_pw, rows[0].auth_pw_hash);
}

// Returns the password-wrapped data key (after re-proving the password) so the client can re-wrap it.
auth.post('/wrapped', limit('sensitive', 20, 3600_000), requireSession, jsonSmall, wrap(async (req, res) => {
    if (!await reauth(req)) return res.status(401).json({ error: 'Password is wrong' });
    const { rows } = await pool.query('SELECT wrapped_pw FROM users WHERE id = $1', [req.session.userId]);
    res.json({ wrappedPw: rows[0].wrapped_pw });
}));

auth.post('/change-password', limit('sensitive', 10, 3600_000), requireSession, jsonSmall, wrap(async (req, res) => {
    if (!await reauth(req)) return res.status(401).json({ error: 'Current password is wrong' });
    const r = req.body;
    const saltPw = Buffer.from(String(r.saltPw || ''), 'base64');
    if (!validKdf(r.kdf) || saltPw.length !== 16 || !HEX64.test(r.authPw || '') || !B64.test(r.wrappedPw || '')) return res.status(400).json({ error: 'Invalid data' });
    await pool.query('UPDATE users SET kdf=$2, salt_pw=$3, auth_pw_hash=$4, wrapped_pw=$5 WHERE id=$1', [req.session.userId, r.kdf, saltPw, await hashAuth(r.authPw, saltPw), r.wrappedPw]);
    await pool.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.session.userId, req.session.tokenHash]);
    res.json({ ok: true });
}));

auth.post('/rotate-recovery', limit('sensitive', 10, 3600_000), requireSession, jsonSmall, wrap(async (req, res) => {
    if (!await reauth(req)) return res.status(401).json({ error: 'Current password is wrong' });
    const r = req.body;
    const saltRec = Buffer.from(String(r.saltRec || ''), 'base64');
    if (saltRec.length !== 16 || !HEX64.test(r.authRec || '') || !B64.test(r.wrappedRec || '')) return res.status(400).json({ error: 'Invalid data' });
    await pool.query('UPDATE users SET salt_rec=$2, auth_rec_hash=$3, wrapped_rec=$4 WHERE id=$1', [req.session.userId, saltRec, await hashAuth(r.authRec, saltRec), r.wrappedRec]);
    res.json({ ok: true });
}));

auth.post('/logout-all', requireSession, wrap(async (req, res) => {
    await pool.query('DELETE FROM sessions WHERE user_id = $1', [req.session.userId]);
    clearCookie(res);
    res.json({ ok: true });
}));

auth.post('/delete-account', limit('sensitive', 10, 3600_000), requireSession, jsonSmall, wrap(async (req, res) => {
    if (!await reauth(req)) return res.status(401).json({ error: 'Password is wrong' });
    await pool.query('DELETE FROM users WHERE id = $1', [req.session.userId]); // cascades to sessions + blobs
    clearCookie(res);
    res.json({ ok: true });
}));


// ---------------------------------------------------------------------------
// Migration from the old SillyTavern instance.
// The browser proves it knows the old password by computing SillyTavern's scrypt hash itself
// (the password is still never sent), creates a normal NimoTavern account, then downloads the
// plaintext archive, encrypts it locally and uploads it. The archive is then deleted.
const LEGACY_DIR = env('LEGACY_DIR', '/var/lib/nimotavern/legacy');

auth.post('/legacy/claim', limit('login', 20, 15 * 60_000), jsonSmall, wrap(async (req, res) => {
    if (isPlayHost(req)) return res.status(403).json({ error: 'Log in on the main site once first to import your account.' });
    const b = req.body || {};
    const u = String(b.username || '');
    if (!USERNAME_RE.test(u)) return res.status(400).json({ error: 'Invalid credentials' });
    if (!validKdf(b.kdf) || !HEX64.test(b.authPw || '') || !HEX64.test(b.authRec || '') || !B64.test(b.wrappedPw || '') || !B64.test(b.wrappedRec || '')) return res.status(400).json({ error: 'Invalid data' });
    const saltPw = Buffer.from(String(b.saltPw || ''), 'base64'); const saltRec = Buffer.from(String(b.saltRec || ''), 'base64');
    if (saltPw.length !== 16 || saltRec.length !== 16) return res.status(400).json({ error: 'Invalid salt' });
    const ulc = u.toLowerCase();
    if (captchaOn() && ramFails('legacy', ulc) >= CAPTCHA_AFTER && !await verifyTurnstile(b.turnstile)) return captchaNeeded(res);
    if (!captchaOn() && ramFails('legacy', ulc) >= 10) return res.status(429).json({ error: 'Too many failed attempts. Try again later.' });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [leg] } = await client.query('SELECT * FROM legacy_accounts WHERE username_lc = $1 AND claimed_user IS NULL FOR UPDATE', [ulc]);
        const given = Buffer.from(String(b.stHash || ''), 'base64');
        const stored = leg ? Buffer.from(leg.st_hash, 'base64') : Buffer.alloc(64);
        if (!leg || given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
            await client.query('ROLLBACK');
            const n = bumpRamFails('legacy', ulc);
            return res.status(401).json({ error: 'Invalid username or password', captcha: captchaOn() && n >= CAPTCHA_AFTER, siteKey: CFG.turnstileSite });
        }
        const { rows: [user] } = await client.query(
            `INSERT INTO users (username, username_lc, kdf, salt_pw, auth_pw_hash, salt_rec, auth_rec_hash, wrapped_pw, wrapped_rec, quota_bytes)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
            [leg.username, leg.username_lc, b.kdf, saltPw, await hashAuth(b.authPw, saltPw), saltRec, await hashAuth(b.authRec, saltRec), b.wrappedPw, b.wrappedRec, Math.max(CFG.quota, Number(leg.size) * 2)]);
        await client.query('UPDATE legacy_accounts SET claimed_user = $2 WHERE username_lc = $1', [leg.username_lc, user.id]);
        await client.query('COMMIT');
        await createSession(res, user.id, req);
        stats.count('signups');
        res.json({ ok: true, username: leg.username, legacySize: Number(leg.size) });
    } catch (e) { await client.query('ROLLBACK').catch(() => { }); throw e; } finally { client.release(); }
}));

app.get('/api/nimo/legacy/archive', requireSession, wrap(async (req, res) => {
    const { rows: [leg] } = await pool.query('SELECT archive FROM legacy_accounts WHERE claimed_user = $1', [req.session.userId]);
    if (!leg) return res.status(404).json({ error: 'Nothing to import' });
    const file = path.join(LEGACY_DIR, path.basename(leg.archive));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/zip');
    res.sendFile(file, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}));

app.post('/api/nimo/legacy/finish', requireClientHeader, requireSession, wrap(async (req, res) => {
    const { rows: [leg] } = await pool.query('DELETE FROM legacy_accounts WHERE claimed_user = $1 RETURNING archive', [req.session.userId]);
    if (leg) fs.rmSync(path.join(LEGACY_DIR, path.basename(leg.archive)), { force: true }); // plaintext copy gone for good
    res.json({ ok: true });
}));

app.use('/api/nimo/auth', auth);

// ---------------------------------------------------------------------------
// Encrypted blob storage
const blobs = express.Router();
blobs.use(requireClientHeader, requireSession, limit('blobs', 600, 60_000, (req) => 'u' + req.session.userId));

blobs.get('/changes', wrap(async (req, res) => {
    const since = Math.max(0, parseInt(String(req.query.since || '0'), 10) || 0);
    const [{ rows }, u] = await Promise.all([
        pool.query('SELECT id, seq, size, data IS NULL AS deleted FROM blobs WHERE user_id = $1 AND seq > $2 ORDER BY seq', [req.session.userId, since]),
        pool.query('SELECT seq, used_bytes, quota_bytes FROM users WHERE id = $1', [req.session.userId]),
    ]);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ changes: rows.map(r => ({ id: r.id, seq: Number(r.seq), size: r.size, deleted: r.deleted })), cursor: Number(u.rows[0].seq), quota: { used: Number(u.rows[0].used_bytes), limit: Number(u.rows[0].quota_bytes) } });
}));

const FETCH_MAX_BYTES = 96 * 1024 * 1024;
blobs.post('/fetch', express.json({ limit: '64kb' }), wrap(async (req, res) => {
    const asked = Array.isArray(req.body?.ids) ? req.body.ids.filter(i => BLOB_ID.test(i)).slice(0, 200) : [];
    // Bound the memory one request can use (the app client asks for ~4 MB batches; one blob is at most 64 MB).
    const { rows: sizes } = await pool.query('SELECT id, size FROM blobs WHERE user_id = $1 AND id = ANY($2) AND data IS NOT NULL', [req.session.userId, asked]);
    const ids = []; let total = 0;
    for (const r of sizes) { if (ids.length && total + r.size > FETCH_MAX_BYTES) break; ids.push(r.id); total += r.size; }
    const { rows } = await pool.query('SELECT id, seq, data FROM blobs WHERE user_id = $1 AND id = ANY($2) AND data IS NOT NULL', [req.session.userId, ids]);
    const parts = [];
    for (const r of rows) {
        const head = Buffer.alloc(2 + r.id.length + 8 + 4);
        head.writeUInt16BE(r.id.length, 0); head.write(r.id, 2, 'latin1');
        head.writeBigUInt64BE(BigInt(r.seq), 2 + r.id.length); head.writeUInt32BE(r.data.length, 10 + r.id.length);
        parts.push(head, r.data);
    }
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(Buffer.concat(parts));
}));

const MAX_BLOB = 64 * 1024 * 1024;
blobs.post('/put', express.raw({ type: 'application/octet-stream', limit: '72mb' }), wrap(async (req, res) => {
    const buf = req.body;
    if (!Buffer.isBuffer(buf)) return res.status(400).json({ error: 'Bad body' });
    const items = [];
    let off = 0;
    while (off < buf.length) {
        const idLen = buf.readUInt16BE(off); off += 2;
        const id = buf.toString('latin1', off, off + idLen); off += idLen;
        const len = buf.readUInt32BE(off); off += 4;
        if (!BLOB_ID.test(id) || len > MAX_BLOB || off + len > buf.length) return res.status(400).json({ error: 'Bad frame' });
        items.push({ id, data: buf.subarray(off, off + len) }); off += len;
    }
    // The same id twice in one batch would be counted twice against the stored size (and could be used to
    // push used_bytes down and bypass the quota). Only the last copy of each id is kept, as the client intends.
    const byId = new Map();
    for (const it of items) byId.set(it.id, it);
    items.length = 0; items.push(...byId.values());
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [u] } = await client.query('SELECT seq, used_bytes, quota_bytes FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const prev = Number(u.seq);
        const { rows: old } = await client.query('SELECT id, size FROM blobs WHERE user_id = $1 AND id = ANY($2)', [req.session.userId, items.map(i => i.id)]);
        const oldSize = new Map(old.map(r => [r.id, r.size]));
        let delta = 0;
        for (const it of items) delta += it.data.length - (oldSize.get(it.id) || 0);
        if (Number(u.used_bytes) + delta > Number(u.quota_bytes)) {
            await client.query('ROLLBACK');
            return res.status(413).json({ error: `Storage quota exceeded (${Math.round(Number(u.quota_bytes) / 1048576)} MB).` });
        }
        let seq = prev;
        const seqs = {};
        for (const it of items) {
            seq++;
            seqs[it.id] = seq;
            await client.query(`INSERT INTO blobs (user_id, id, seq, size, data) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (user_id, id) DO UPDATE SET seq = EXCLUDED.seq, size = EXCLUDED.size, data = EXCLUDED.data`, [req.session.userId, it.id, seq, it.data.length, it.data]);
        }
        await client.query('UPDATE users SET seq = $2, used_bytes = used_bytes + $3 WHERE id = $1', [req.session.userId, seq, delta]);
        await client.query('COMMIT');
        res.json({ seqs, cursor: seq, prev });
    } catch (e) { await client.query('ROLLBACK').catch(() => { }); throw e; } finally { client.release(); }
}));

blobs.post('/delete', express.json({ limit: '256kb' }), wrap(async (req, res) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.filter(i => BLOB_ID.test(i)).slice(0, 2000) : [];
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { rows: [u] } = await client.query('SELECT seq FROM users WHERE id = $1 FOR UPDATE', [req.session.userId]);
        const prev = Number(u.seq);
        let seq = prev, freed = 0;
        for (const id of ids) {
            seq++;
            const r = await client.query('UPDATE blobs SET seq = $3, data = NULL, size = 0 WHERE user_id = $1 AND id = $2 AND data IS NOT NULL RETURNING (SELECT size FROM blobs WHERE user_id = $1 AND id = $2) AS old', [req.session.userId, id, seq]);
            if (!r.rowCount) { seq--; continue; }
            freed += Number(r.rows[0].old || 0);
        }
        await client.query('UPDATE users SET seq = $2, used_bytes = GREATEST(0, used_bytes - $3) WHERE id = $1', [req.session.userId, seq, freed]);
        await client.query('COMMIT');
        res.json({ cursor: seq, prev });
    } catch (e) { await client.query('ROLLBACK').catch(() => { }); throw e; } finally { client.release(); }
}));

app.use('/api/nimo/blobs', blobs);

// ---------------------------------------------------------------------------
// Optional relay for AI providers that block browser (CORS) requests.
// Opt-in per user, authenticated, rate limited, public HTTPS targets only.
// Streams bytes through; nothing is logged or stored.
const HOP = new Set(['host', 'cookie', 'connection', 'content-length', 'transfer-encoding', 'origin', 'referer', 'x-nimo-target', 'x-nimo-relay', 'x-nimo-client', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop', 'accept-encoding', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'user-agent', 'accept-language', 'priority', 'true-client-ip']);

// Only headers a provider client actually needs are passed back; nothing that could change how the
// browser treats our origin (CSP, CORS, cookies, redirects, caching...).
const RELAY_RESP_HEADERS = /^(content-type|content-encoding|retry-after|x-request-id|request-id|x-ratelimit-[a-z0-9-]+|anthropic-ratelimit-[a-z0-9-]+|openai-[a-z0-9-]+)$/;

app.all('/api/nimo/relay', requireClientHeaderRelay, requireSession, limit('relay', 120, 60_000, (req) => 'u' + req.session.userId), (req, res) => {
    stats.count('relay_calls');
    let target;
    try { target = new URL(String(req.headers['x-nimo-target'] || '')); } catch { return res.status(400).send('Bad target'); }
    if (target.protocol !== 'https:' || target.username || target.password) return res.status(400).send('Relay only supports public https:// endpoints');
    if (net.isIP(target.hostname.replace(/^\[|\]$/g, '')) && !isPublicIp(target.hostname.replace(/^\[|\]$/g, ''))) return res.status(400).send('Relay refuses private or unresolvable addresses');
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase()) && !k.startsWith('x-nimo')) headers[k] = v;
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const up = https.request(target, { method: req.method, headers, lookup: publicOnlyLookup, timeout: 600_000 }, (upRes) => {
        res.status(upRes.statusCode || 502);
        for (const [k, v] of Object.entries(upRes.headers)) if (RELAY_RESP_HEADERS.test(k) && v !== undefined) res.setHeader(k, v);
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        upRes.on('error', () => res.end());
        upRes.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', (e) => {
        if (res.headersSent) return res.end();
        if (e.code === 'NIMO_PRIVATE') return res.status(400).send('Relay refuses private or unresolvable addresses');
        res.status(502).send('Relay could not reach the provider');
    });
    // Client went away before we finished: stop talking to the provider.
    res.on('close', () => { if (!res.writableFinished) up.destroy(); });
    if (hasBody) req.pipe(up); else up.end();
});
function requireClientHeaderRelay(req, res, next) { if (!req.headers['x-nimo-relay']) return res.status(403).end(); next(); }

// ---------------------------------------------------------------------------
// Multiplayer sessions (mp/): run by the server with the host's multiplayer API key, sealed at rest.
const mpEngine = createEngine({ pool, sealer: createSealer(CFG.secret) });
const mpHub = createHub({ getSession, engine: mpEngine });
mpEngine.setHub(mpHub);
// Multiplayer only answers on the play site (with a play login). The main site may only read the mailbox count
// for its badge; everything else, including session titles, stays out of reach of main-site extensions.
app.use('/api/nimo/mp', (req, res, next) => {
    if (isPlayHost(req) || (req.method === 'GET' && req.path === '/inbox/count')) return next();
    res.status(403).json({ error: 'Multiplayer is on the play site', play: true });
});
app.use('/api/nimo/mp', createRoutes({ engine: mpEngine, requireSession, requireClientHeader, limit, wrap }));
setInterval(() => mpEngine.housekeeping().catch((e) => console.error('[nimotavern] mp housekeeping:', e?.message?.slice(0, 200))), 60_000).unref();

// ---------------------------------------------------------------------------
// Pages & static files
const BUILD = (() => { try { return JSON.parse(fs.readFileSync(path.resolve(here, '../dist/build.json'), 'utf8')).build; } catch { return 'dev'; } })();
const PAGES = new Map();
function sendPage(res, name) {
    // Pages reference assets as ...?v={{V}} so browsers/CDN never mix versions across deploys.
    let html = PAGES.get(name);
    if (!html) { html = fs.readFileSync(path.join(NIMO_PAGES, name), 'utf8').replaceAll('{{V}}', BUILD); PAGES.set(name, html); }
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(html);
}
function readIndex() {
    let html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    html = html.replace('<head>', `<head>\n    <script src="/nimo/js/nimo-boot.js?v=${BUILD}"></script>\n    <link rel="stylesheet" href="/nimo/css/nimo-app.css?v=${BUILD}">`);
    html = html.replace(/<title>[^<]*<\/title>/, '<title>NimoTavern</title>');
    return html;
}
let INDEX_HTML = readIndex();

const noStore = (res) => res.setHeader('Cache-Control', 'no-store');

app.get('/', wrap(async (req, res) => {
    noStore(res);
    const s = await getSession(req);
    stats.view(req);
    if (s) { stats.markActive(s.userId); res.type('html').send(INDEX_HTML); return; }
    if (isPlayHost(req)) return res.redirect('/login');
    sendPage(res, 'home.html');
}));
// The play site has no sign-up or legacy import: those happen on the main site.
const mainUrl = (req) => `${req.protocol}://${String(req.headers.host || '').replace(/^play\./i, '')}`;
app.get(['/register', '/home'], (req, res, next) => (isPlayHost(req) ? res.redirect(mainUrl(req) + req.path) : next()));
app.get('/index.html', (_req, res) => res.redirect('/'));
for (const p of ['login', 'register', 'recover', 'account', 'privacy', 'home']) app.get('/' + p, (req, res) => { stats.view(req); sendPage(res, p + '.html'); });

// Stats panel: aggregate counters only (see stats.js). Only the configured admin account can open it;
// everyone else, logged in or not, gets the same 404 as any unknown page.
app.get('/stats', wrap(async (req, res, next) => {
    if (!isAdmin(await getSession(req))) return next();
    res.setHeader('X-Robots-Tag', 'noindex');
    sendPage(res, 'stats.html');
}));
app.get('/api/nimo/stats', wrap(async (req, res, next) => {
    if (!isAdmin(await getSession(req))) return res.status(404).json({ error: 'Not found' });
    noStore(res);
    res.json(await stats.summary(Number(req.query.days) || 30));
}));

// Wiki (public, static, built from nimo/web/wiki)
app.get('/wiki', (req, res) => { stats.view(req, true); sendPage(res, 'wiki/index.html'); });
app.get('/wiki/search.json', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=300'); res.type('json').sendFile(path.join(NIMO_PAGES, 'wiki/search.json')); });
app.get('/wiki/:slug', (req, res, next) => {
    const slug = req.params.slug.replace(/\.html$/, '');
    if (!/^[a-z0-9-]{1,60}$/.test(slug) || !fs.existsSync(path.join(NIMO_PAGES, 'wiki', slug + '.html'))) return next();
    if (slug === 'index') return res.redirect('/wiki');
    stats.view(req, true);
    sendPage(res, 'wiki/' + slug + '.html');
});
app.get('/source', (_req, res) => res.redirect(CFG.sourceUrl));
app.get('/nimo-sw.js', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Service-Worker-Allowed', '/');
    res.sendFile(path.join(NIMO_DIST, 'nimo-sw.js'));
});
app.use('/nimo/js', express.static(path.join(NIMO_DIST, 'nimo/js'), { maxAge: 0 }));
app.use('/nimo/wasm', express.static(path.join(NIMO_DIST, 'nimo/wasm'), { maxAge: '7d' }));
app.use('/nimo', express.static(path.join(NIMO_WEB, 'static'), { maxAge: '1h' }));

// Public default content (identical for all users): served with a generated bundle manifest.
let DEFAULTS_BUNDLE = null;
function buildDefaultsBundle() {
    const files = [];
    const TEXT = /\.(json|txt|md|css|yaml|yml)$/i;
    for (const sub of ['content', 'scaffold']) {
        const base = path.join(ROOT, 'default', sub);
        if (!fs.existsSync(base)) continue;
        for (const rel of fs.readdirSync(base, { recursive: true })) {
            const full = path.join(base, rel);
            if (!fs.statSync(full).isFile()) continue;
            const p = sub + '/' + rel.split(path.sep).join('/');
            if (TEXT.test(full)) files.push({ path: p, text: fs.readFileSync(full, 'utf8') });
            else files.push({ path: p, size: fs.statSync(full).size });
        }
    }
    // Tokenizer models (SillyTavern loads them from src/tokenizers) and tiktoken rank tables.
    for (const f of fs.readdirSync(path.join(ROOT, 'src/tokenizers'))) {
        files.push({ path: 'src/tokenizers/' + f, vfs: '/src/tokenizers/' + f, url: '/nimo-tokenizers/' + f, size: fs.statSync(path.join(ROOT, 'src/tokenizers', f)).size });
    }
    const tk = path.join(NIMO_DIST, 'nimo/tiktoken');
    if (fs.existsSync(tk)) for (const f of fs.readdirSync(tk)) files.push({ path: 'tiktoken/' + f, vfs: '/srv/tiktoken/' + f, url: '/nimo/tiktoken/' + f, size: fs.statSync(path.join(tk, f)).size });
    // Default character avatar: SillyTavern's server reads it for cards without a picture (JSON/YAML/CHARX/BYAF
    // imports, "create character" without an image). Without it those imports fail with "invalid or corrupted".
    files.push({ path: 'public/img/ai4.png', vfs: '/public/img/ai4.png', url: '/img/ai4.png', size: fs.statSync(path.join(ROOT, 'public/img/ai4.png')).size });
    // NimoTavern Multiplayer, served to SillyTavern as a global third-party extension (in memory, never per user).
    const mpDir = path.join(NIMO_DIST, 'nimo/mp');
    if (fs.existsSync(mpDir)) for (const f of fs.readdirSync(mpDir)) files.push({ path: 'nimo-multiplayer/' + f, vfs: '/public/scripts/extensions/third-party/nimo-multiplayer/' + f, text: fs.readFileSync(path.join(mpDir, f), 'utf8') });
    // Built-in extension manifests (SillyTavern discovers extensions by listing this folder).
    const extDir = path.join(ROOT, 'public/scripts/extensions');
    for (const name of fs.readdirSync(extDir)) {
        const mf = path.join(extDir, name, 'manifest.json');
        if (name !== 'third-party' && fs.existsSync(mf)) files.push({ path: `public/scripts/extensions/${name}/manifest.json`, text: fs.readFileSync(mf, 'utf8') });
    }
    return JSON.stringify({ files });
}
app.get('/nimo-defaults/bundle.json', (_req, res) => {
    DEFAULTS_BUNDLE ??= buildDefaultsBundle();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('json').send(DEFAULTS_BUNDLE);
});
app.use('/nimo-tokenizers', express.static(path.join(ROOT, 'src/tokenizers'), { maxAge: '7d', index: false }));
app.use('/nimo/tiktoken', express.static(path.join(NIMO_DIST, 'nimo/tiktoken'), { maxAge: '7d', index: false }));
app.use('/nimo-defaults', express.static(path.join(ROOT, 'default'), { maxAge: '7d', index: false, dotfiles: 'deny' }));

// SillyTavern frontend (static). lib.js is the prebuilt webpack bundle.
app.get('/css/user.css', (_req, res) => { res.type('css').setHeader('Cache-Control', 'public, max-age=3600'); res.send('/* NimoTavern: use Custom CSS in User Settings */\n'); });
app.get('/lib.js', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=3600'); res.sendFile(path.join(ROOT, 'dist/lib.js')); });
app.use(express.static(path.join(ROOT, 'public'), { index: false, maxAge: '1h', dotfiles: 'deny' }));

// If a SillyTavern API call reaches the real server, the Service Worker isn't active: send to login.
app.use('/api', (_req, res) => res.status(401).json({ error: 'login-required', nimo: 'login-required' }));
app.use((_req, res) => { res.status(404); sendPage(res, '404.html'); });

app.use((err, _req, res, _next) => {
    // Log only the error class/message, never request data.
    console.error('[nimotavern] error:', err?.code || '', err?.message?.slice(0, 200));
    if (!res.headersSent) res.status(err?.status || 500).json({ error: err?.type === 'entity.too.large' ? 'Payload too large' : 'Server error' });
});

// Housekeeping: expired sessions.
setInterval(() => pool.query('DELETE FROM sessions WHERE expires_at < now()').catch(() => { }), 3600_000).unref();

const server = app.listen(CFG.port, CFG.host, () => console.log(`NimoTavern listening on ${CFG.host}:${CFG.port}`));
server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname === '/api/nimo/mp/ws' && isPlayHost(req)) mpHub.upgrade(req, socket, head);
    else socket.destroy();
});
// Last line of defence: a stray rejection must never take the whole site down. Logs the message only.
process.on('unhandledRejection', (e) => console.error('[nimotavern] unhandled rejection:', e?.message?.slice(0, 200)));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { server.close(); try { await stats.flush(); } catch { /* */ } process.exit(0); });
