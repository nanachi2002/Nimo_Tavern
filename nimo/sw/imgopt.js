// Image optimizer: converts uploaded PNG / JPEG / BMP pictures to WebP before they are stored.
//
// This runs inside the user's browser (Service Worker), BEFORE the file is encrypted and uploaded, so the
// server never sees the picture either way. It exists to save the user's storage quota and sync time.
//
// It is deliberately conservative: it returns null (= "keep the original") whenever it is not clearly a win.
//   * animated images (GIF, APNG, animated WebP) are never touched
//   * tiny files are skipped
//   * browsers that can't encode WebP in a canvas (Safari silently falls back to PNG) keep the original
//   * if the WebP isn't at least ~12% smaller than the original, the original wins

const QUALITY = 0.86;          // visually near-lossless for art, photos and screenshots
const MAX_SIDE = 4096;         // anything bigger is scaled down (a 4K wallpaper is 3840 px)
const MIN_BYTES = 40 * 1024;   // below this the saving isn't worth a lossy re-encode
const MIN_SAVING = 0.12;

/** @param {Uint8Array} b */
export function sniffImage(b) {
    if (!b || b.length < 16) return null;
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
    if (b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
    if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp';
    return null;
}

/** True when a PNG carries an animation control chunk (APNG) before its image data. */
function isApng(b) {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    let off = 8;
    while (off + 12 <= b.length) {
        const len = dv.getUint32(off);
        const type = String.fromCharCode(b[off + 4], b[off + 5], b[off + 6], b[off + 7]);
        if (type === 'acTL') return true;
        if (type === 'IDAT' || type === 'IEND') return false;
        off += 12 + len;
    }
    return false;
}

/**
 * @param {Uint8Array} bytes original file
 * @returns {Promise<Uint8Array|null>} WebP bytes, or null to keep the original
 */
export async function toWebp(bytes) {
    const kind = sniffImage(bytes);
    if (kind !== 'png' && kind !== 'jpeg' && kind !== 'bmp') return null;
    if (bytes.length < MIN_BYTES) return null;
    if (kind === 'png' && isApng(bytes)) return null;
    if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') return null;

    let bmp;
    try {
        bmp = await createImageBitmap(new Blob([bytes], { type: 'image/' + kind }));
        let w = bmp.width, h = bmp.height;
        const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
        if (scale < 1) { w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale)); }
        const canvas = new OffscreenCanvas(w, h);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(bmp, 0, 0, w, h);
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: QUALITY });
        if (blob.type !== 'image/webp') return null; // browser fell back to PNG: no WebP encoder
        const out = new Uint8Array(await blob.arrayBuffer());
        const needed = scale < 1 ? 1 : 1 - MIN_SAVING; // a downscaled copy only has to be smaller
        if (out.length >= bytes.length * needed) return null;
        return out;
    } catch {
        return null; // undecodable / out of memory: keep the original
    } finally {
        try { bmp?.close(); } catch { /* ignore */ }
    }
}

/** "photo.final.PNG" -> "photo.final.webp" */
export function withWebpExt(name) {
    return String(name || 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.webp';
}

function toBase64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
}

function fromBase64(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

/**
 * Routes whose uploads are pictures we may convert.
 *   multipart: backgrounds, sprites     (file name's extension is rewritten to .webp)
 *   JSON:      chat / generated images  (body.image is base64, body.format is the extension)
 */
const MULTIPART_ROUTES = new Set(['/api/backgrounds/upload', '/api/sprites/upload']);
const JSON_ROUTES = new Set(['/api/images/upload']);

export const isOptimizableMultipart = (pathname) => MULTIPART_ROUTES.has(pathname);
export const isOptimizableJson = (pathname) => JSON_ROUTES.has(pathname);

/** @returns {Promise<{bytes: Uint8Array, name: string, type: string}|null>} */
export async function optimizeUploadedFile(bytes, name) {
    const out = await toWebp(bytes);
    return out ? { bytes: out, name: withWebpExt(name), type: 'image/webp' } : null;
}

/** Mutates a /api/images/upload JSON body when its picture can be stored as WebP. */
export async function optimizeImageBody(body) {
    try {
        if (!body || typeof body.image !== 'string' || !/^(png|jpe?g|bmp)$/i.test(String(body.format))) return;
        const out = await toWebp(fromBase64(body.image));
        if (!out) return;
        body.image = toBase64(out);
        body.format = 'webp';
    } catch { /* keep the original */ }
}
