// Prebuilds SillyTavern's frontend library bundle (public/lib.js -> dist/lib.js).
import webpack from 'webpack';
import fs from 'node:fs';
import path from 'node:path';
import getPublicLibConfig from '../webpack.config.js';

globalThis.DATA_ROOT = path.resolve('data');
const config = getPublicLibConfig({ forceDist: true });
await new Promise((resolve, reject) => webpack(config).run((err, stats) => {
    if (err || stats.hasErrors()) return reject(err || new Error(stats.toString('errors-only')));
    resolve();
}));
fs.mkdirSync('dist', { recursive: true });
fs.copyFileSync(path.join(config.output.path, config.output.filename), 'dist/lib.js');
console.log('lib.js built:', fs.statSync('dist/lib.js').size, 'bytes');
