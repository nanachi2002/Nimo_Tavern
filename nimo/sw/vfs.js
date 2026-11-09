// NimoTavern virtual filesystem.
// An in-memory POSIX-ish filesystem that backs SillyTavern's server code when it
// runs inside the browser's Service Worker. Nothing here ever leaves the browser in
// plaintext: the sync layer (store.js) encrypts dirty files before upload.
//
// Two kinds of file entries:
//   - data entries: { data: Uint8Array }
//   - ref entries:  { ref: '/nimo-defaults/...' } -> public default content (themes,
//     backgrounds, Seraphina...). Shared by everyone, fetched lazily, copy-by-reference.

import { Buffer } from 'buffer';
import pathPosix from 'path-browserify';

const enc = new TextEncoder();

export class NeedsLoadError extends Error {
    constructor(paths) {
        super('VFS_NEEDS_LOAD');
        this.paths = paths;
    }
}

function fsError(code, syscall, p) {
    const msgs = { ENOENT: 'no such file or directory', EEXIST: 'file already exists', ENOTDIR: 'not a directory', EISDIR: 'illegal operation on a directory', ENOTEMPTY: 'directory not empty' };
    const e = new Error(`${code}: ${msgs[code] || code}, ${syscall} '${p}'`);
    e.code = code; e.errno = -1; e.syscall = syscall; e.path = p;
    return e;
}

export class Stats {
    constructor(entry, isDir) {
        const now = entry?.mtime ?? Date.now();
        this._dir = isDir;
        this.size = isDir ? 0 : (entry.data ? entry.data.byteLength : (entry.size ?? 0));
        this.mtimeMs = now; this.ctimeMs = now; this.birthtimeMs = entry?.btime ?? now; this.atimeMs = now;
        this.mtime = new Date(now); this.ctime = new Date(now); this.birthtime = new Date(this.birthtimeMs); this.atime = new Date(now);
        this.mode = isDir ? 0o40755 : 0o100644;
        this.uid = 0; this.gid = 0; this.ino = 0; this.dev = 0; this.nlink = 1; this.blksize = 4096; this.blocks = Math.ceil(this.size / 512);
    }
    isDirectory() { return this._dir; }
    isFile() { return !this._dir; }
    isSymbolicLink() { return false; }
    isFIFO() { return false; }
    isSocket() { return false; }
    isBlockDevice() { return false; }
    isCharacterDevice() { return false; }
}

class Dirent {
    constructor(name, isDir, parentPath) { this.name = name; this._dir = isDir; this.parentPath = parentPath; this.path = parentPath; }
    isDirectory() { return this._dir; }
    isFile() { return !this._dir; }
    isSymbolicLink() { return false; }
}

export class VFS {
    constructor() {
        /** @type {Map<string, {data?: Uint8Array, ref?: string, size?: number, mtime: number, btime?: number}>} */
        this.files = new Map();
        /** @type {Set<string>} */
        this.dirs = new Set(['/']);
        /** paths changed since last flush (files written or deleted) */
        this.dirty = new Set();
        /** prefixes that are persisted (user data). Everything else is ephemeral. */
        this.persistRoots = [];
        /** ref loader: async (refUrl) => Uint8Array */
        this.refLoader = null;
        this.listeners = new Set();
        /** unloaded ref paths that were read (even if the caller swallowed the error) */
        this.misses = new Set();
        /** incremented on every persisted write; lets the dispatcher know if a retry is safe */
        this.writeCount = 0;
    }

    norm(p) {
        if (p instanceof URL) p = p.pathname;
        if (Buffer.isBuffer(p)) p = p.toString();
        p = String(p).replace(/\\/g, '/');
        if (!p.startsWith('/')) p = '/' + p;
        return pathPosix.normalize(p).replace(/\/+$/, '') || '/';
    }

    isPersisted(p) { return this.persistRoots.some(r => p === r || p.startsWith(r + '/')); }

    markDirty(p) {
        this.writeCount++;
        if (this.isPersisted(p)) {
            this.dirty.add(p);
            for (const l of this.listeners) l(p);
        }
    }

    ensureParents(p) {
        let d = pathPosix.dirname(p);
        const stack = [];
        while (!this.dirs.has(d)) {
            if (this.files.has(d)) throw fsError('ENOTDIR', 'mkdir', d);
            stack.push(d);
            d = pathPosix.dirname(d);
        }
        for (const x of stack) this.dirs.add(x);
    }

    // ---- loading (used by store.js and the request dispatcher)
    loadFile(p, data, mtime, btime) {
        p = this.norm(p);
        this.ensureParents(p);
        this.files.set(p, { data, mtime: mtime ?? Date.now(), btime });
    }
    loadRef(p, ref, size, mtime) {
        p = this.norm(p);
        this.ensureParents(p);
        this.files.set(p, { ref, size, mtime: mtime ?? 0 });
    }
    async resolveRefs(paths) {
        await Promise.all(paths.map(async (p) => {
            const e = this.files.get(p);
            if (e && !e.data && e.ref && this.refLoader) {
                const data = await this.refLoader(e.ref);
                e.data = data; e.size = data.byteLength;
            }
        }));
    }

    _entryData(p, syscall) {
        const e = this.files.get(p);
        if (!e) {
            if (this.dirs.has(p)) throw fsError('EISDIR', syscall, p);
            throw fsError('ENOENT', syscall, p);
        }
        if (!e.data) { this.misses.add(p); throw new NeedsLoadError([p]); }
        return e.data;
    }

    // ---- sync API
    existsSync(p) { p = this.norm(p); return this.files.has(p) || this.dirs.has(p); }

    statSync(p, opts) {
        p = this.norm(p);
        if (this.dirs.has(p)) return new Stats({ mtime: 0 }, true);
        const e = this.files.get(p);
        if (!e) { if (opts?.throwIfNoEntry === false) return undefined; throw fsError('ENOENT', 'stat', p); }
        return new Stats(e, false);
    }
    lstatSync(p, o) { return this.statSync(p, o); }

    readFileSync(p, opts) {
        if (typeof p === 'number') throw fsError('ENOENT', 'read', String(p));
        p = this.norm(p);
        const data = this._entryData(p, 'open');
        const encoding = typeof opts === 'string' ? opts : opts?.encoding;
        const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        return encoding ? buf.toString(encoding) : Buffer.from(buf); // copy so callers can't mutate store
    }

    writeFileSync(p, content, opts) {
        p = this.norm(p);
        if (this.dirs.has(p)) throw fsError('EISDIR', 'open', p);
        if (!this.dirs.has(pathPosix.dirname(p))) throw fsError('ENOENT', 'open', p);
        const encoding = typeof opts === 'string' ? opts : (opts?.encoding || 'utf8');
        let data;
        if (typeof content === 'string') data = encoding === 'utf8' || encoding === 'utf-8' ? enc.encode(content) : Uint8Array.from(Buffer.from(content, encoding));
        else if (content instanceof Uint8Array) data = new Uint8Array(content); // copy
        else if (content instanceof ArrayBuffer) data = new Uint8Array(content.slice(0));
        else if (ArrayBuffer.isView(content)) data = new Uint8Array(content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength));
        else data = enc.encode(String(content));
        const prev = this.files.get(p);
        this.files.set(p, { data, mtime: Date.now(), btime: prev?.btime ?? Date.now() });
        this.markDirty(p);
    }

    appendFileSync(p, content, opts) {
        p = this.norm(p);
        let prev = new Uint8Array(0);
        if (this.files.has(p)) prev = this._entryData(p, 'open');
        const add = typeof content === 'string' ? enc.encode(content) : new Uint8Array(content);
        const out = new Uint8Array(prev.byteLength + add.byteLength);
        out.set(prev, 0); out.set(add, prev.byteLength);
        this.writeFileSync(p, out, opts);
    }

    mkdirSync(p, opts) {
        p = this.norm(p);
        const recursive = typeof opts === 'object' && opts?.recursive;
        if (this.dirs.has(p)) { if (recursive) return undefined; throw fsError('EEXIST', 'mkdir', p); }
        if (this.files.has(p)) throw fsError('EEXIST', 'mkdir', p);
        if (!recursive && !this.dirs.has(pathPosix.dirname(p))) throw fsError('ENOENT', 'mkdir', p);
        this.ensureParents(p);
        this.dirs.add(p);
        return p;
    }

    readdirSync(p, opts) {
        p = this.norm(p);
        if (!this.dirs.has(p)) {
            if (this.files.has(p)) throw fsError('ENOTDIR', 'scandir', p);
            throw fsError('ENOENT', 'scandir', p);
        }
        const prefix = p === '/' ? '/' : p + '/';
        const names = new Map();
        for (const d of this.dirs) if (d !== p && d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) names.set(d.slice(prefix.length), true);
        for (const f of this.files.keys()) if (f.startsWith(prefix) && !f.slice(prefix.length).includes('/')) names.set(f.slice(prefix.length), false);
        const sorted = [...names.keys()].sort();
        if (opts?.recursive) {
            const out = [];
            const walk = (dir, rel) => {
                for (const name of this.readdirSync(dir)) {
                    const full = dir === '/' ? '/' + name : dir + '/' + name;
                    const r = rel ? rel + '/' + name : name;
                    out.push(opts.withFileTypes ? new Dirent(name, this.dirs.has(full), dir) : r);
                    if (this.dirs.has(full)) walk(full, r);
                }
            };
            walk(p, '');
            return out;
        }
        if (opts?.withFileTypes) return sorted.map(n => new Dirent(n, names.get(n), p));
        return sorted;
    }

    unlinkSync(p) {
        p = this.norm(p);
        if (this.dirs.has(p)) throw fsError('EISDIR', 'unlink', p);
        if (!this.files.delete(p)) throw fsError('ENOENT', 'unlink', p);
        this.markDirty(p);
    }

    rmdirSync(p, opts) { return this.rmSync(p, { recursive: !!opts?.recursive }); }

    rmSync(p, opts) {
        p = this.norm(p);
        if (this.files.has(p)) return this.unlinkSync(p);
        if (!this.dirs.has(p)) { if (opts?.force) return; throw fsError('ENOENT', 'rm', p); }
        const prefix = p + '/';
        const children = [...this.files.keys()].filter(f => f.startsWith(prefix));
        const childDirs = [...this.dirs].filter(d => d.startsWith(prefix));
        if (!opts?.recursive && (children.length || childDirs.length)) throw fsError('ENOTEMPTY', 'rm', p);
        for (const f of children) { this.files.delete(f); this.markDirty(f); }
        for (const d of childDirs) this.dirs.delete(d);
        this.dirs.delete(p);
    }

    renameSync(a, b) {
        a = this.norm(a); b = this.norm(b);
        if (this.files.has(a)) {
            this.ensureParents(b);
            this.files.set(b, { ...this.files.get(a), mtime: Date.now() });
            this.files.delete(a);
            this.markDirty(a); this.markDirty(b);
            return;
        }
        if (this.dirs.has(a)) {
            const prefix = a + '/';
            for (const [f, e] of [...this.files]) if (f.startsWith(prefix)) { const nf = b + f.slice(a.length); this.ensureParents(nf); this.files.set(nf, e); this.files.delete(f); this.markDirty(f); this.markDirty(nf); }
            for (const d of [...this.dirs]) if (d === a || d.startsWith(prefix)) { this.dirs.delete(d); this.dirs.add(b + d.slice(a.length)); }
            this.ensureParents(b);
            return;
        }
        throw fsError('ENOENT', 'rename', a);
    }

    copyFileSync(a, b, mode) {
        a = this.norm(a); b = this.norm(b);
        const e = this.files.get(a);
        if (!e) throw fsError('ENOENT', 'copyfile', a);
        if (mode === 1 && this.files.has(b)) throw fsError('EEXIST', 'copyfile', b); // COPYFILE_EXCL
        if (!this.dirs.has(pathPosix.dirname(b))) throw fsError('ENOENT', 'copyfile', b);
        if (e.ref) this.files.set(b, { ref: e.ref, size: e.size, data: e.data, mtime: Date.now(), btime: Date.now() }); // shared default: copy by reference
        else this.files.set(b, { data: new Uint8Array(e.data), mtime: Date.now(), btime: Date.now() });
        this.markDirty(b);
    }

    cpSync(a, b, opts) {
        a = this.norm(a); b = this.norm(b);
        if (this.files.has(a)) {
            if (opts?.force === false && this.files.has(b)) { if (opts?.errorOnExist) throw fsError('EEXIST', 'cp', b); return; }
            this.ensureParents(b);
            return this.copyFileSync(a, b);
        }
        if (!this.dirs.has(a)) throw fsError('ENOENT', 'cp', a);
        this.mkdirSync(b, { recursive: true });
        const prefix = a + '/';
        for (const d of [...this.dirs]) if (d.startsWith(prefix)) this.mkdirSync(b + d.slice(a.length), { recursive: true });
        for (const f of [...this.files.keys()]) if (f.startsWith(prefix)) {
            const nf = b + f.slice(a.length);
            if (opts?.force === false && this.files.has(nf)) continue;
            this.copyFileSync(f, nf);
        }
    }

    accessSync(p) { if (!this.existsSync(p)) throw fsError('ENOENT', 'access', this.norm(p)); }
    chmodSync() { }
    utimesSync(p) { const e = this.files.get(this.norm(p)); if (e) e.mtime = Date.now(); }
    realpathSync(p) { return this.norm(p); }
}

export const vfs = new VFS();
