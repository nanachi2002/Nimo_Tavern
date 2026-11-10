// node:crypto subset used by SillyTavern endpoints (hashing, uuids, random bytes).
import { Buffer } from 'buffer';
import { sha256, sha1, md5, sha512 } from './hash.js';
import { hmac } from '@noble/hashes/hmac';
import { sha256 as nSha256 } from '@noble/hashes/sha256';
import { sha512 as nSha512 } from '@noble/hashes/sha512';
import { sha1 as nSha1, md5 as nMd5 } from '@noble/hashes/legacy';
const hmacAlgos = { sha256: nSha256, sha512: nSha512, sha1: nSha1, md5: nMd5 };
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
export function createHmac(alg, key) {
    const fn = hmacAlgos[String(alg).toLowerCase().replace('-', '')];
    if (!fn) throw new Error('Unsupported hmac ' + alg);
    const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key);
    const parts = [];
    const h = {
        update(d, enc) { parts.push(typeof d === 'string' ? Buffer.from(d, enc || 'utf8') : Buffer.from(d)); return h; },
        digest(enc) { const out = Buffer.from(hmac(fn, k, Buffer.concat(parts))); return enc ? out.toString(enc) : out; },
    };
    return h;
}
export function scryptSync() { throw new Error('scrypt is not available in NimoTavern'); }
export const webcrypto = self.crypto;
export default { randomUUID, randomBytes, randomInt, createHash, timingSafeEqual, createHmac, scryptSync, webcrypto };
