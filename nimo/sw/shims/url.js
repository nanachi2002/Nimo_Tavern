export const URL = self.URL;
export const URLSearchParams = self.URLSearchParams;
export function fileURLToPath(u) { return decodeURIComponent(new URL(u).pathname); }
export function pathToFileURL(p) { return new URL('file://' + p); }
export function parse(u) { try { const x = new URL(u); return { protocol: x.protocol, host: x.host, hostname: x.hostname, port: x.port, pathname: x.pathname, search: x.search, query: x.search.slice(1), hash: x.hash, href: x.href, path: x.pathname + x.search }; } catch { return { pathname: u, path: u, href: u }; } }
export function format(o) { return typeof o === 'string' ? o : (o.href || ''); }
export default { URL, URLSearchParams, fileURLToPath, pathToFileURL, parse, format };
