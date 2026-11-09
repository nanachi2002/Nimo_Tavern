// Export accounts from an existing SillyTavern (user accounts mode) for import into NimoTavern.
// Run with cwd = the SillyTavern install (uses its own node_modules):
//   node export-sillytavern.mjs <outDir> [handle=newUsername ...]
// Writes <outDir>/<username>.zip per account and <outDir>/accounts.json (username, salt, hash, size).
// Overrides for renamed accounts are read from env NIMO_OVERRIDES as JSON:
//   {"default-user": {"username": "ciel2002", "salt": "...", "hash": "..."}}
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import archiver from 'archiver';

const outDir = process.argv[2];
if (!outDir) { console.error('usage: node export-sillytavern.mjs <outDir>'); process.exit(1); }
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
const overrides = JSON.parse(process.env.NIMO_OVERRIDES || '{}');
const DATA = path.resolve('data');
const SKIP_DIRS = new Set(['backups', 'thumbnails', 'vectors']);
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

// Hashes of SillyTavern's default content: identical user files become shared references.
const defaults = new Map();
for (const sub of ['content', 'scaffold']) {
    const base = path.resolve('default', sub);
    if (!fs.existsSync(base)) continue;
    for (const rel of fs.readdirSync(base, { recursive: true })) {
        const full = path.join(base, rel);
        if (!fs.statSync(full).isFile()) continue;
        const h = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
        if (!defaults.has(h)) defaults.set(h, sub + '/' + rel.split(path.sep).join('/'));
    }
}

const records = [];
for (const f of fs.readdirSync(path.join(DATA, '_storage'))) {
    const rec = JSON.parse(fs.readFileSync(path.join(DATA, '_storage', f), 'utf8'));
    const u = rec.value;
    if (!u?.handle || !u.password || !u.salt) continue;
    if (u.enabled === false) { console.log(`skip ${u.handle}: disabled`); continue; }
    const userDir = path.join(DATA, u.handle);
    if (!fs.existsSync(userDir)) { console.log(`skip ${u.handle}: no data folder`); continue; }
    const o = overrides[u.handle] || {};
    const username = o.username || u.handle;
    if (!USERNAME_RE.test(username)) { console.log(`skip ${u.handle}: username "${username}" not allowed in NimoTavern`); continue; }

    const zipPath = path.join(outDir, username + '.zip');
    const out = fs.createWriteStream(zipPath, { mode: 0o600 });
    const zip = archiver('zip', { zlib: { level: 6 } });
    zip.pipe(out);
    const refs = [];
    let files = 0, bytes = 0;
    const walk = (dir, rel) => {
        for (const name of fs.readdirSync(dir)) {
            const full = path.join(dir, name);
            const r = rel ? rel + '/' + name : name;
            const st = fs.statSync(full);
            if (st.isDirectory()) { if (!(rel === '' && SKIP_DIRS.has(name))) walk(full, r); continue; }
            const data = fs.readFileSync(full);
            const def = defaults.get(crypto.createHash('sha256').update(data).digest('hex'));
            if (def) { refs.push({ path: r, default: def, size: data.length }); continue; }
            zip.append(data, { name: r, date: st.mtime, store: /\.(png|jpe?g|webp|gif|zip|gz|mp3|mp4|ogg|wav)$/i.test(name) });
            files++; bytes += data.length;
        }
    };
    walk(userDir, '');
    zip.append(JSON.stringify({ from: 'SillyTavern', handle: u.handle, refs }), { name: 'nimo-manifest.json' });
    await zip.finalize();
    await new Promise(r => out.on('close', r));
    const size = fs.statSync(zipPath).size;
    records.push({ username, salt: o.salt || u.salt, hash: o.hash || u.password, archive: path.basename(zipPath), size });
    console.log(`${u.handle} -> ${username}: ${files} files (${(bytes / 1048576).toFixed(1)} MB raw), ${refs.length} shared defaults, zip ${(size / 1048576).toFixed(1)} MB`);
}
fs.writeFileSync(path.join(outDir, 'accounts.json'), JSON.stringify(records, null, 1), { mode: 0o600 });
console.log(`done: ${records.length} accounts`);
