// NimoTavern client-side cryptography. Runs only in the user's browser.
//
// password --Argon2id(salt_pw)--> master --HKDF--> KEK_pw  (never leaves the browser)
//                                         \-HKDF--> authKey (sent to server, stored hashed)
// recovery phrase (128-bit, 12 BIP39 words) --HKDF(salt_rec)--> KEK_rec / authKey_rec
// DEK: random 256-bit data key, stored on server only wrapped (AES-GCM) by KEK_pw and KEK_rec
// DEK --HKDF--> encKey (AES-256-GCM, file encryption) and idKey (HMAC-SHA256, blob ids)
import { argon2id } from 'hash-wasm';
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

const subtle = crypto.subtle;
const te = new TextEncoder();

export const KDF_DEFAULT = { alg: 'argon2id', m: 65536, t: 3, p: 1 };

export function randomBytes(n) { const b = new Uint8Array(n); crypto.getRandomValues(b); return b; }
export function b64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
export function unb64(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
export function hex(u8) { return [...u8].map(b => b.toString(16).padStart(2, '0')).join(''); }

async function hkdfBytes(ikm, info, salt = new Uint8Array(32), len = 32) {
    const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: te.encode(info) }, k, len * 8));
}

async function aesKey(raw, extractable = false) {
    return subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, ['encrypt', 'decrypt']);
}

async function seal(key, plain, aad) {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, key, plain));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return out;
}
async function open(key, sealed, aad) {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: sealed.subarray(0, 12), additionalData: aad }, key, sealed.subarray(12)));
}

/** Password -> { kek, authKey(hex) } */
export async function derivePasswordKeys(username, password, salt, kdf = KDF_DEFAULT) {
    const master = await argon2id({
        password: te.encode(password.normalize('NFKC')),
        salt, iterations: kdf.t, memorySize: kdf.m, parallelism: kdf.p, hashLength: 32, outputType: 'binary',
    });
    const ctx = te.encode('nimotavern:' + username.toLowerCase());
    const kek = await aesKey(await hkdfBytes(master, 'nimo-kek-v1', ctx));
    const authKey = hex(await hkdfBytes(master, 'nimo-auth-v1', ctx));
    return { kek, authKey };
}

/** Recovery phrase -> { kek, authKey(hex) }. 128 bits of entropy, so HKDF alone is enough. */
export async function deriveRecoveryKeys(username, phrase, salt) {
    const entropy = mnemonicToEntropy(normalizePhrase(phrase), wordlist);
    const ctx = te.encode('nimotavern-rec:' + username.toLowerCase());
    const ikm = new Uint8Array([...entropy, ...salt]);
    const kek = await aesKey(await hkdfBytes(ikm, 'nimo-rec-kek-v1', ctx));
    const authKey = hex(await hkdfBytes(ikm, 'nimo-rec-auth-v1', ctx));
    return { kek, authKey };
}

export function normalizePhrase(p) { return String(p).toLowerCase().trim().split(/\s+/).join(' '); }
export function newRecoveryPhrase() { return generateMnemonic(wordlist, 128); }
export function isValidPhrase(p) { return validateMnemonic(normalizePhrase(p), wordlist); }

const WRAP_AAD = te.encode('nimo-dek-v1');
export async function wrapDek(kek, dek) { return b64(await seal(kek, dek, WRAP_AAD)); }
export async function unwrapDek(kek, wrapped) { return open(kek, unb64(wrapped), WRAP_AAD); }

/** DEK -> non-extractable working keys stored in IndexedDB. */
export async function deriveWorkingKeys(dek) {
    const encKey = await aesKey(await hkdfBytes(dek, 'nimo-enc-v1'));
    const idRaw = await hkdfBytes(dek, 'nimo-id-v1');
    const idKey = await subtle.importKey('raw', idRaw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return { encKey, idKey };
}

export async function blobId(idKey, path) {
    const mac = new Uint8Array(await subtle.sign('HMAC', idKey, te.encode('path:' + path)));
    return hex(mac.subarray(0, 20));
}

export async function encryptBlob(encKey, id, plain) { return seal(encKey, plain, te.encode('blob:' + id)); }
export async function decryptBlob(encKey, id, sealed) { return open(encKey, sealed, te.encode('blob:' + id)); }

// ---- key storage shared by pages and the Service Worker (same origin IndexedDB)
const KEY_DB = 'nimo-keys';
function idb(name, stores) {
    return new Promise((res, rej) => {
        const r = indexedDB.open(name, 1);
        r.onupgradeneeded = () => { for (const s of stores) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
    });
}
export async function idbGet(dbName, store, key) {
    const db = await idb(dbName, [store]);
    return new Promise((res, rej) => { const t = db.transaction(store).objectStore(store).get(key); t.onsuccess = () => { res(t.result); db.close(); }; t.onerror = () => rej(t.error); });
}
export async function idbPut(dbName, store, key, val) {
    const db = await idb(dbName, [store]);
    return new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(val, key); tx.oncomplete = () => { res(); db.close(); }; tx.onerror = () => rej(tx.error); });
}
export async function saveKeys(record) { await idbPut(KEY_DB, 'keys', 'current', record); }
export async function loadKeys() { try { return await idbGet(KEY_DB, 'keys', 'current'); } catch { return null; } }
export async function wipeLocal() {
    for (const name of ['nimo-keys', 'nimo-cache']) {
        await new Promise((res) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
    }
}
