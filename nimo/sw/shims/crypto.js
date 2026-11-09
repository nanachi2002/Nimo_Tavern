// node:crypto subset used by SillyTavern endpoints (hashing, uuids, random bytes).
import { Buffer } from 'buffer';
import { sha256, sha1, md5, sha512 } from './hash.js';
const algos = { sha256, sha1, md5, sha512 };
export function randomUUID() { return self.crypto.randomUUID(); }
export function randomBytes(n) { const b = Buffer.alloc(n); self.crypto.getRandomValues(b); return b; }
export function randomInt(a, b) { if (b === undefined) { b = a; a = 0; } const r = new Uint32Array(1); self.crypto.getRandomValues(r); return a + (r[0] % (b - a)); }
export function createHash(alg) {
    const fn = algos[String(alg).toLowerCase().replace('-', '')];
    if (!fn) throw new Error('Unsupported hash ' + alg);
    const parts = [];
    const h = {
        update(d, enc) { parts.push(typeof d === 'string' ? Buffer.from(d, enc || 'utf8') : Buffer.from(d)); return h; },
        digest(enc) { const out = Buffer.from(fn(Buffer.concat(parts))); return enc ? out.toString(enc) : out; },
    };
    return h;
}
export function timingSafeEqual(a, b) { if (a.length !== b.length) return false; let r = 0; for (let i = 0; i < a.length; i++) r |= a[i] ^ b[i]; return r === 0; }
export function createHmac() { throw new Error('createHmac is not available in NimoTavern'); }
export function scryptSync() { throw new Error('scrypt is not available in NimoTavern'); }
export const webcrypto = self.crypto;
export default { randomUUID, randomBytes, randomInt, createHash, timingSafeEqual, createHmac, scryptSync, webcrypto };
