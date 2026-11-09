// Registers exported SillyTavern accounts (accounts.json from tools/export-sillytavern.mjs) as
// claimable legacy accounts. Run as the service user: node import-legacy.mjs [legacyDir]
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';

const dir = process.argv[2] || process.env.LEGACY_DIR || '/var/lib/nimotavern/legacy';
const accounts = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
for (const a of accounts) {
    const taken = await pool.query('SELECT 1 FROM users WHERE username_lc = $1', [a.username.toLowerCase()]);
    if (taken.rowCount) { console.log(`skip ${a.username}: a NimoTavern account with this name already exists`); continue; }
    if (!fs.existsSync(path.join(dir, a.archive))) { console.log(`skip ${a.username}: archive missing`); continue; }
    await pool.query(`INSERT INTO legacy_accounts (username_lc, username, st_salt, st_hash, archive, size) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (username_lc) DO UPDATE SET st_salt = EXCLUDED.st_salt, st_hash = EXCLUDED.st_hash, archive = EXCLUDED.archive, size = EXCLUDED.size
        WHERE legacy_accounts.claimed_user IS NULL`, [a.username.toLowerCase(), a.username, a.salt, a.hash, a.archive, a.size]);
    console.log(`ready: ${a.username} (${(a.size / 1048576).toFixed(1)} MB)`);
}
fs.rmSync(path.join(dir, 'accounts.json')); // hashes now live only in the database
await pool.end();
