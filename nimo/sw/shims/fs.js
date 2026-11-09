// node:fs shim backed by the NimoTavern VFS.
import { Readable, Writable } from 'stream-browserify';
import { Buffer } from 'buffer';
import { vfs, Stats } from '../vfs.js';

const syncNames = ['existsSync', 'statSync', 'lstatSync', 'readFileSync', 'writeFileSync', 'appendFileSync', 'mkdirSync', 'readdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'renameSync', 'copyFileSync', 'cpSync', 'accessSync', 'chmodSync', 'utimesSync', 'realpathSync'];

const fs = {};
for (const n of syncNames) fs[n] = (...a) => vfs[n](...a);

// callback API
for (const n of syncNames) {
    if (n === 'existsSync') continue;
    const base = n.replace(/Sync$/, '');
    fs[base] = (...args) => {
        const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
        let res, err = null;
        try { res = vfs[n](...args); } catch (e) { err = e; }
        if (cb) queueMicrotask(() => cb(err, res));
    };
}
fs.exists = (p, cb) => queueMicrotask(() => cb(vfs.existsSync(p)));

// promise API. Async so errors become rejections; NeedsLoadError propagates to the dispatcher.
const promises = {};
for (const n of syncNames) {
    if (n === 'existsSync') continue;
    promises[n.replace(/Sync$/, '')] = async (...a) => vfs[n](...a);
}
promises.access = async (p) => vfs.accessSync(p);
promises.open = async (p, flags) => {
    p = vfs.norm(p);
    if (/[wa]/.test(flags || '') && !vfs.existsSync(p)) vfs.writeFileSync(p, '');
    return {
        readFile: async (o) => vfs.readFileSync(p, o),
        writeFile: async (d, o) => vfs.writeFileSync(p, d, o),
        stat: async () => vfs.statSync(p),
        close: async () => { },
    };
};
fs.promises = promises;

fs.createReadStream = (p, opts) => {
    let data;
    try { data = vfs.readFileSync(p); } catch (e) {
        const r = new Readable({ read() { } });
        queueMicrotask(() => r.destroy(e));
        return r;
    }
    if (opts?.start !== undefined || opts?.end !== undefined) data = data.subarray(opts.start ?? 0, (opts.end ?? data.length - 1) + 1);
    const encoding = typeof opts === 'string' ? opts : opts?.encoding;
    const chunk = 64 * 1024;
    let off = 0;
    return new Readable({
        encoding,
        read() {
            if (off >= data.length) { this.push(null); return; }
            this.push(data.subarray(off, off + chunk));
            off += chunk;
        },
    });
};

fs.createWriteStream = (p, opts) => {
    const chunks = [];
    const append = opts?.flags === 'a';
    const w = new Writable({
        write(c, e, cb) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c, e)); cb(); },
        final(cb) {
            try {
                const buf = Buffer.concat(chunks);
                if (append) vfs.appendFileSync(p, buf); else vfs.writeFileSync(p, buf);
                cb();
            } catch (e) { cb(e); }
        },
    });
    w.path = p;
    w.close = (cb) => w.end(cb);
    return w;
};

fs.Stats = Stats;
fs.constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, O_RDONLY: 0 };
fs.watch = () => ({ close() { }, on() { return this; } });
fs.watchFile = () => { };
fs.unwatchFile = () => { };

export default fs;
export { promises, Stats };
export const { existsSync, statSync, lstatSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync, unlinkSync, rmSync, rmdirSync, renameSync, copyFileSync, cpSync, accessSync, chmodSync, createReadStream, createWriteStream, constants, watch } = fs;
export const { readFile, writeFile, stat, readdir, unlink, mkdir, rm, rename, copyFile, access, exists } = fs;
