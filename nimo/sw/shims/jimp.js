// Wraps SillyTavern's Jimp so Jimp.read(path) reads from the VFS (in browsers it would fetch the path as a URL).
import { Jimp, JimpMime } from '../../../src/jimp.js';
import { vfs } from '../vfs.js';

const originalRead = Jimp.read.bind(Jimp);
Jimp.read = (src, ...rest) => {
    if (typeof src === 'string' && !/^(https?:|data:|blob:)/.test(src)) return originalRead(vfs.readFileSync(src), ...rest);
    return originalRead(src, ...rest);
};

export default Jimp;
export { Jimp, JimpMime };
