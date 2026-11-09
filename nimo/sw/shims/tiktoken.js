// tiktoken (Node WASM) replacement built on js-tiktoken. Rank tables are shared public files
// loaded lazily through the VFS (/srv/tiktoken/<encoding>.json).
import { Tiktoken, getEncodingNameForModel } from 'js-tiktoken/lite';
import { vfs } from '../vfs.js';

const cache = new Map();
const te = new TextEncoder();

function load(encoding) {
    let t = cache.get(encoding);
    if (t) return t;
    const ranks = JSON.parse(vfs.readFileSync(`/srv/tiktoken/${encoding}.json`, 'utf8'));
    const enc = new Tiktoken(ranks);
    t = {
        encode: (text, allowed, disallowed) => Uint32Array.from(enc.encode(text, allowed, disallowed)),
        decode: (ids) => te.encode(enc.decode(Array.from(ids))), // tiktoken returns UTF-8 bytes
        free() { },
    };
    cache.set(encoding, t);
    return t;
}

export function get_encoding(name) { return load(name); }
export function encoding_for_model(model) {
    let name;
    try { name = getEncodingNameForModel(model); } catch { name = /gpt-4o|o1|o3|o4|gpt-5|gpt-4\.1/.test(model) ? 'o200k_base' : 'cl100k_base'; }
    return load(name);
}
export default { get_encoding, encoding_for_model };
