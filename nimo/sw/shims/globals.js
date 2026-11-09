// Injected into every module of the SW bundle.
import { Buffer } from 'buffer';
import process from './process.js';
export { Buffer, process };
export const setImmediate = (fn, ...a) => setTimeout(fn, 0, ...a);
export const clearImmediate = (t) => clearTimeout(t);
