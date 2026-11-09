import fs from './fs.js';
const p = fs.promises;
export default p;
export const { readFile, writeFile, stat, lstat, readdir, unlink, mkdir, rm, rmdir, rename, copyFile, cp, access, open, appendFile } = p;
