// form-data (npm) shim on top of the browser FormData.
import { Buffer } from 'buffer';
export default class FormDataShim {
    constructor() { this.__nimoFormData = new FormData(); }
    append(name, value, opts) {
        const filename = typeof opts === 'string' ? opts : opts?.filename;
        const type = typeof opts === 'object' ? opts?.contentType : undefined;
        if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
            this.__nimoFormData.append(name, new Blob([value], type ? { type } : {}), filename || 'blob');
        } else if (value instanceof Blob) {
            this.__nimoFormData.append(name, value, filename);
        } else {
            this.__nimoFormData.append(name, String(value));
        }
    }
    getHeaders() { return {}; }
    getBuffer() { throw new Error('form-data getBuffer unsupported'); }
    getBoundary() { return ''; }
}
export { Buffer };
