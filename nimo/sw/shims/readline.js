// node:readline shim: createInterface over a Readable, async-iterable by line.
import { EventEmitter } from 'events';
import { StringDecoder } from 'string_decoder';
export function createInterface({ input }) {
    const rl = new EventEmitter();
    const lines = []; let waiting = null; let done = false; let buf = '';
    const dec = new StringDecoder('utf8');
    const push = (l) => { rl.emit('line', l); if (waiting) { const w = waiting; waiting = null; w(); } else lines.push(l); };
    input.on('data', (c) => { buf += typeof c === 'string' ? c : dec.write(c); let i; while ((i = buf.indexOf('\n')) >= 0) { push(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); } });
    input.on('end', () => { buf += dec.end(); if (buf.length) push(buf.replace(/\r$/, '')); done = true; rl.emit('close'); if (waiting) { const w = waiting; waiting = null; w(); } });
    input.on('error', (e) => rl.emit('error', e));
    rl.close = () => { if (!done) { done = true; input.destroy?.(); rl.emit('close'); } };
    rl[Symbol.asyncIterator] = async function* () {
        while (true) {
            if (lines.length) { yield lines.shift(); continue; }
            if (done) return;
            await new Promise(r => { waiting = r; });
        }
    };
    return rl;
}
export default { createInterface };
