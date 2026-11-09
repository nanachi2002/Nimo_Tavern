// Multiplayer data at rest. Unlike solo data (encrypted in the browser with the user's key), multiplayer sessions
// are run by the server, which must read them to build the AI prompt. They are still never stored in plaintext:
// every session has its own random key, wrapped with a key derived from NIMO_SECRET, and each value is sealed with
// AES-256-GCM bound (AAD) to its session and kind. A database dump or backup alone reveals nothing.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

export function createSealer(secret) {
    const master = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('nimo-mp-v1'), Buffer.from('session-key-wrap'), 32));
    const noticeKey = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret), Buffer.from('nimo-mp-v1'), Buffer.from('notice'), 32));
    const keyCache = new Map(); // sid -> session key (RAM only)

    function gcm(key, plain, aad) {
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', key, iv);
        c.setAAD(Buffer.from(aad));
        const ct = Buffer.concat([c.update(plain), c.final()]);
        return Buffer.concat([iv, c.getAuthTag(), ct]);
    }
    function ungcm(key, box, aad) {
        const d = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
        d.setAAD(Buffer.from(aad));
        d.setAuthTag(box.subarray(12, 28));
        return Buffer.concat([d.update(box.subarray(28)), d.final()]);
    }

    return {
        /** New random session key and its wrapped form for the database. */
        newKey(sid) {
            const key = crypto.randomBytes(32);
            keyCache.set(sid, key);
            return gcm(master, key, 'mpkey:' + sid);
        },
        key(sid, wrapped) {
            let k = keyCache.get(sid);
            if (!k) { k = ungcm(master, wrapped, 'mpkey:' + sid); keyCache.set(sid, k); }
            return k;
        },
        forget(sid) { keyCache.delete(sid); },
        seal(key, sid, kind, value) {
            const raw = Buffer.isBuffer(value) ? value : zlib.deflateRawSync(Buffer.from(JSON.stringify(value)));
            return gcm(key, raw, `${kind}:${sid}`);
        },
        /** Small values that must outlive their session (mailbox notices). */
        sealNotice(text) { return gcm(noticeKey, Buffer.from(String(text)), 'notice'); },
        openNotice(box) { try { return ungcm(noticeKey, box, 'notice').toString('utf8'); } catch { return ''; } },
        open(key, sid, kind, box, binary = false) {
            const raw = ungcm(key, box, `${kind}:${sid}`);
            return binary ? raw : JSON.parse(zlib.inflateRawSync(raw).toString('utf8'));
        },
    };
}
