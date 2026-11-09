import fs from './fs.js';
export function sync(p, data, opts) { fs.writeFileSync(p, data, opts); }
export default async function writeFileAtomic(p, data, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    try { fs.writeFileSync(p, data, opts); if (cb) cb(null); } catch (e) { if (cb) cb(e); else throw e; }
}
writeFileAtomic.sync = sync;
