// Encrypted persistence for the VFS.
// Local cache: IndexedDB 'nimo-cache' holds ciphertext blobs (same bytes as the server).
// Remote: /api/nimo/blobs (opaque ids + ciphertext only).
import { zlibSync, unzlibSync } from 'fflate';
import { vfs } from './vfs.js';
import { encryptBlob, decryptBlob, blobId } from '../shared/crypto.js';

const te = new TextEncoder();
const td = new TextDecoder();
const CACHE_DB = 'nimo-cache';

let db = null;
function openCache() {
    if (db) return Promise.resolve(db);
    return new Promise((res, rej) => {
        const r = indexedDB.open(CACHE_DB, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore('blobs'); r.result.createObjectStore('meta'); };
        r.onsuccess = () => {
            db = r.result;
            db.onversionchange = () => { db.close(); db = null; }; // allow wipe on logout
            db.onclose = () => { db = null; }; // browser dropped the connection (iOS Safari does): reopen next time
            res(db);
        };
        r.onerror = () => rej(r.error);
    });
}
function tx(store, mode, fn) {
    return openCache().then(d => new Promise((res, rej) => {
        const t = d.transaction(store, mode);
        const out = fn(t.objectStore(store));
        t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
        t.onerror = () => rej(t.error);
    }));
}
const cacheGetAll = () => openCache().then(d => new Promise((res, rej) => {
    const out = [];
    const c = d.transaction('blobs').objectStore('blobs').openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { out.push([cur.key, cur.value]); cur.continue(); } else res(out); };
    c.onerror = () => rej(c.error);
}));
const cachePut = (id, val) => tx('blobs', 'readwrite', s => s.put(val, id));
const cacheDel = (id) => tx('blobs', 'readwrite', s => s.delete(id));
const metaGet = (k) => tx('meta', 'readonly', s => s.get(k));
const metaPut = (k, v) => tx('meta', 'readwrite', s => s.put(v, k));

export function closeCache() { if (db) { db.close(); db = null; } }

// ---- blob format: [u32 headerLen][header JSON][payload]; header {p, m, b, r?, s?, z?}
const COMPRESSIBLE = /\.(json|jsonl|txt|md|css|yaml|yml|html|js|csv)$/i;

function packFile(p, entry) {
    const header = { p, m: entry.mtime, b: entry.btime };
    let payload = new Uint8Array(0);
    if (entry.ref) { header.r = entry.ref; header.s = entry.size; } // unmodified shared default file: sync as a reference
    else if (COMPRESSIBLE.test(p) && entry.data.byteLength > 256) { payload = zlibSync(entry.data, { level: 6 }); header.z = 1; }
    else payload = entry.data;
    const h = te.encode(JSON.stringify(header));
    const out = new Uint8Array(4 + h.length + payload.length);
    new DataView(out.buffer).setUint32(0, h.length);
    out.set(h, 4); out.set(payload, 4 + h.length);
    return out;
}
function unpackFile(buf) {
    const hl = new DataView(buf.buffer, buf.byteOffset).getUint32(0);
    const header = JSON.parse(td.decode(buf.subarray(4, 4 + hl)));
    let payload = buf.subarray(4 + hl);
    if (header.z) payload = unzlibSync(payload);
    return { header, payload };
}

export class Store {
    constructor(keys) {
        this.encKey = keys.encKey;
        this.idKey = keys.idKey;
        this.idCache = new Map(); // path -> blob id
        this.pathById = new Map(); // blob id -> path
        this.flushing = Promise.resolve();
        this.cursor = 0;
        this.onAuthError = null;
        this.quota = null;
        // Play site (multiplayer): reads the user's storage but never writes back to it. Changes stay in this
        // browser's encrypted local cache only, so nothing from a multiplayer session can ever reach the shared
        // storage that extensions on the main site can read.
        this.localOnly = !!keys.localOnly;
    }

    async id(p) {
        let id = this.idCache.get(p);
        if (!id) { id = await blobId(this.idKey, p); this.idCache.set(p, id); }
        return id;
    }

    async applyBlob(id, sealed) {
        const plain = await decryptBlob(this.encKey, id, sealed);
        const { header, payload } = unpackFile(plain);
        this.pathById.set(id, header.p);
        this.idCache.set(header.p, id);
        if (header.r) vfs.loadRef(header.p, header.r, header.s, header.m);
        else vfs.loadFile(header.p, payload, header.m, header.b);
    }

    /** Decrypt everything from the local cache into the VFS. */
    async loadFromCache() {
        const c = await metaGet('cursor');
        this.cursor = Number.isFinite(c) ? c : 0;
        const all = await cacheGetAll();
        const results = await Promise.allSettled(all.map(([id, v]) => this.applyBlob(id, v.data)));
        const bad = results.filter(r => r.status === 'rejected').length;
        if (bad) console.warn(`[nimo] ${bad} cached blobs failed to decrypt`);
        return all.length;
    }

    async api(path, init = {}) {
        const r = await fetch('/api/nimo' + path, { credentials: 'same-origin', ...init, headers: { 'X-Nimo-Client': 'sw', ...(init.headers || {}) } });
        if (r.status === 401) { this.onAuthError?.(); throw new Error('Session expired'); }
        return r;
    }

    /** Pull changes from the server since our cursor. */
    async pull() {
        const r = await this.api(`/blobs/changes?since=${this.cursor}`);
        if (!r.ok) throw new Error('Sync failed: ' + r.status);
        const { changes, cursor, quota } = await r.json();
        this.quota = quota;
        const toFetch = [];
        for (const c of changes) {
            if (c.deleted) {
                const p = this.pathById.get(c.id);
                if (p && vfs.files.has(p) && !vfs.dirty.has(p)) vfs.files.delete(p);
                this.pathById.delete(c.id);
                await cacheDel(c.id);
            } else toFetch.push(c);
        }
        const totalBytes = toFetch.reduce((n, c) => n + (c.size || 0), 0);
        let gotBytes = 0;
        // Batches of ~4 MB (max 100 blobs), 4 downloads in flight.
        const batches = [];
        for (let i = 0, cur = [], sz = 0; i < toFetch.length; i++) {
            cur.push(toFetch[i]); sz += toFetch[i].size || 0;
            if (cur.length >= 100 || sz >= 4 * 1048576 || i === toFetch.length - 1) { batches.push(cur); cur = []; sz = 0; }
        }
        const fetchBatch = async (batch) => {
            const br = await this.api('/blobs/fetch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch.map(b => b.id) }) });
            if (!br.ok) throw new Error('Blob fetch failed: ' + br.status);
            const buf = new Uint8Array(await br.arrayBuffer());
            const dv = new DataView(buf.buffer);
            let off = 0;
            while (off < buf.length) {
                const idLen = dv.getUint16(off); off += 2;
                const id = td.decode(buf.subarray(off, off + idLen)); off += idLen;
                const seq = Number(dv.getBigUint64(off)); off += 8;
                const len = dv.getUint32(off); off += 4;
                const data = buf.slice(off, off + len); off += len;
                const p = this.pathById.get(id);
                if (p && vfs.dirty.has(p)) continue; // local unsynced edit wins
                try { await this.applyBlob(id, data); await cachePut(id, { seq, data }); } catch (e) { console.warn('[nimo] bad blob', id, e); }
            }
            gotBytes += batch.reduce((n, c) => n + (c.size || 0), 0);
            if (totalBytes > 5 * 1048576) this.onPull?.(gotBytes, totalBytes);
        };
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(4, batches.length) }, async () => {
            while (next < batches.length) await fetchBatch(batches[next++]);
        }));
        this.cursor = Math.max(this.cursor, cursor);
        await metaPut('cursor', this.cursor);
        return changes.length;
    }

    /** Encrypt and upload all dirty files. Serialized. */
    flush() {
        this.flushing = this.flushing.then(() => this._flush()).catch(e => console.error('[nimo] flush failed', e));
        return this.flushing;
    }

    async _flush() {
        if (!vfs.dirty.size) return;
        this.uploading = true;
        try { await this._flushInner(); } finally { this.uploading = false; }
    }

    async _flushInner() {
        if (this.localOnly) return this._flushLocal();
        const paths = [...vfs.dirty];
        vfs.dirty.clear();
        const dels = [];
        const done = new Set();
        const BATCH = 8 * 1024 * 1024;
        let batch = [], size = 0;
        try {
            // Encrypt and upload batch by batch, so memory stays bounded for large imports.
            for (const p of paths) {
                const id = await this.id(p);
                const e = vfs.files.get(p);
                if (!e) { dels.push({ id, p }); continue; }
                const sealed = await encryptBlob(this.encKey, id, packFile(p, e));
                batch.push({ id, p, sealed }); size += sealed.length;
                if (size >= BATCH) { await this._upload(batch); batch.forEach(x => done.add(x.p)); batch = []; size = 0; }
            }
            if (batch.length) { await this._upload(batch); batch.forEach(x => done.add(x.p)); }
            if (dels.length) {
                const r = await this.api('/blobs/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: dels.map(d => d.id) }) });
                if (!r.ok) throw new Error('Delete failed: ' + r.status);
                const { cursor, prev } = await r.json();
                for (const d of dels) { this.pathById.delete(d.id); await cacheDel(d.id); done.add(d.p); }
                if (prev === this.cursor) { this.cursor = cursor; await metaPut('cursor', this.cursor); }
            }
        } catch (e) {
            // Put back what wasn't uploaded so the next flush retries it.
            for (const p of paths) if (!done.has(p)) vfs.dirty.add(p);
            this.lastError = e;
            throw e;
        }
        this.lastError = null;
    }

    /** Play site: keep changes in the local encrypted cache only (never uploaded). */
    async _flushLocal() {
        const paths = [...vfs.dirty];
        vfs.dirty.clear();
        for (const p of paths) {
            const id = await this.id(p);
            const e = vfs.files.get(p);
            if (!e) { await cacheDel(id); continue; }
            await cachePut(id, { seq: 0, data: await encryptBlob(this.encKey, id, packFile(p, e)) });
            this.pathById.set(id, p);
        }
    }

    /** Upload one framed batch: [u16 idLen][id][u32 len][data]... */
    async _upload(batch) {
        const body = new Uint8Array(batch.reduce((n, b) => n + 2 + b.id.length + 4 + b.sealed.length, 0));
        const dv = new DataView(body.buffer); let off = 0;
        for (const b of batch) {
            dv.setUint16(off, b.id.length); off += 2; body.set(te.encode(b.id), off); off += b.id.length;
            dv.setUint32(off, b.sealed.length); off += 4; body.set(b.sealed, off); off += b.sealed.length;
        }
        const r = await this.api('/blobs/put', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body });
        if (r.status === 413) {
            const j = await r.json().catch(() => ({}));
            throw Object.assign(new Error(j.error || 'Storage quota exceeded'), { quota: true });
        }
        if (!r.ok) throw new Error('Upload failed: ' + r.status);
        const { seqs, cursor, prev } = await r.json();
        for (const b of batch) { this.pathById.set(b.id, b.p); await cachePut(b.id, { seq: seqs[b.id], data: b.sealed }); }
        this.uploadedBytes = (this.uploadedBytes || 0) + body.length;
        this.onUpload?.(this.uploadedBytes);
        // Only advance the cursor if nobody else wrote in between (otherwise the next pull catches up).
        if (prev === this.cursor) { this.cursor = cursor; await metaPut('cursor', this.cursor); }
    }
}
