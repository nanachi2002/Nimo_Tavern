// Minimal Express-compatible router that runs inside the Service Worker.
// SillyTavern's endpoint modules register handlers on these routers; the dispatcher
// turns a fetch Request into req/res objects and returns a web Response.
import { EventEmitter } from 'events';
import { Buffer } from 'buffer';
import mime from 'mime-types';
import { vfs } from '../vfs.js';

function compile(pattern, end) {
    if (pattern instanceof RegExp) return { re: pattern, keys: [] };
    const keys = [];
    let src = '';
    const parts = pattern.split('/').filter(Boolean);
    for (const part of parts) {
        let m;
        if ((m = part.match(/^:(\w+)(\(\*\)|\(\.\*\))?(\?)?$/))) {
            keys.push(m[1]);
            const body = m[2] ? '(.*)' : '([^/]+)';
            src += m[3] ? `(?:/${body})?` : `/${body}`;
        } else if (part === '*') {
            keys.push('0');
            src += '/(.*)';
        } else {
            src += '/' + part.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        }
    }
    const re = new RegExp('^' + (src || '') + (end ? '/?$' : '(?=/|$)'), 'i');
    return { re, keys };
}

class Layer {
    constructor(method, path, handlers, end) {
        this.method = method; // null = any (use)
        this.path = path;
        this.handlers = handlers.flat();
        this.end = end;
        this.matcher = compile(path, end);
    }
    match(p) {
        const m = this.matcher.re.exec(p);
        if (!m) return null;
        const params = {};
        this.matcher.keys.forEach((k, i) => { if (m[i + 1] !== undefined) params[k] = decodeURIComponent(m[i + 1]); });
        return { params, matched: m[0] };
    }
}

export function Router() {
    const layers = [];
    const router = function (req, res, next) { return router.handle(req, res, next); };
    const add = (method, end) => (path, ...h) => {
        if (typeof path === 'function' || Array.isArray(path)) { h.unshift(path); path = '/'; }
        layers.push(new Layer(method, path, h, end));
        return router;
    };
    router.use = add(null, false);
    for (const m of ['get', 'post', 'put', 'delete', 'patch', 'all', 'head', 'options']) router[m] = add(m === 'all' ? '*' : m.toUpperCase(), true);
    router.route = (path) => {
        const r = {};
        for (const m of ['get', 'post', 'put', 'delete', 'patch', 'all']) r[m] = (...h) => { router[m](path, ...h); return r; };
        return r;
    };
    router.layers = layers;
    router.handle = async (req, res, done) => {
        const basePath = req.path;
        const baseUrl = req.baseUrl || '';
        let idx = 0;
        const next = async (err) => {
            if (res.headersSent && !err) return;
            while (idx < layers.length) {
                const layer = layers[idx++];
                if (layer.method && layer.method !== '*' && layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) continue;
                const m = layer.match(basePath);
                if (!m) continue;
                req.params = { ...(req.params || {}), ...m.params };
                if (!layer.end) {
                    // mount: strip prefix for nested handler
                    req.path = basePath.slice(m.matched.length) || '/';
                    req.baseUrl = baseUrl + m.matched;
                }
                let hi = 0;
                const runHandlers = async (e) => {
                    if (hi >= layer.handlers.length) { req.path = basePath; req.baseUrl = baseUrl; return next(e); }
                    const h = layer.handlers[hi++];
                    try {
                        if (e) {
                            if (h.length === 4) return await h(e, req, res, runHandlers);
                            return runHandlers(e);
                        }
                        if (h.length === 4) return runHandlers();
                        return await h(req, res, runHandlers);
                    } catch (ex) {
                        return runHandlers(ex);
                    }
                };
                return runHandlers(err);
            }
            req.path = basePath; req.baseUrl = baseUrl;
            return done ? done(err) : undefined;
        };
        return next();
    };
    return router;
}

const noop = () => (_req, _res, next) => next();
function express() { return Router(); }
express.Router = Router;
express.json = noop; express.urlencoded = noop; express.raw = noop; express.text = noop; express.static = noop;
export default express;
export const json = noop, urlencoded = noop, raw = noop;

// ---------------------------------------------------------------------------
// Request / response objects

export function createReq({ method, url, headers, body, user, file, signal }) {
    const u = new URL(url);
    const socket = new EventEmitter();
    socket.remoteAddress = '127.0.0.1';
    socket.setTimeout = () => { };
    if (signal) signal.addEventListener('abort', () => { socket.emit('close'); req.emit('close'); req.emit('aborted'); });
    const req = new EventEmitter();
    Object.assign(req, {
        method,
        url: u.pathname + u.search,
        originalUrl: u.pathname + u.search,
        path: decodeURIComponent(u.pathname),
        baseUrl: '',
        query: Object.fromEntries(u.searchParams),
        params: {},
        headers,
        body: body ?? {},
        user,
        file,
        socket,
        connection: socket,
        ip: '127.0.0.1',
        ips: [],
        protocol: u.protocol.replace(':', ''),
        secure: u.protocol === 'https:',
        hostname: u.hostname,
        host: u.host,
        session: {},
        cookies: {},
        signal,
        get(h) { return headers[String(h).toLowerCase()]; },
        header(h) { return headers[String(h).toLowerCase()]; },
        is(t) { return String(headers['content-type'] || '').includes(t); },
        accepts() { return true; },
    });
    return req;
}

export function createRes(req) {
    const res = new EventEmitter();
    let controller = null;
    let resolveResponse;
    const responsePromise = new Promise(r => { resolveResponse = r; });
    const headers = new Headers();
    let started = false;
    let ended = false;

    const start = (streaming, body) => {
        if (started) return;
        started = true;
        res.isStreaming = !!streaming;
        res.headersSent = true;
        const init = { status: res.statusCode, headers };
        if (res.statusMessage) init.statusText = res.statusMessage.replace(/[^\t\x20-\x7e]/g, '');
        if (streaming) {
            const stream = new ReadableStream({
                start(c) { controller = c; },
                cancel() { req.socket.emit('close'); req.emit('close'); res.emit('close'); },
            });
            resolveResponse(new Response(nullBodyStatus(res.statusCode) ? null : stream, init));
        } else {
            resolveResponse(new Response(nullBodyStatus(res.statusCode) || req.method === 'HEAD' ? null : body, init));
        }
    };
    const toBytes = (chunk, encoding) => {
        if (chunk == null) return null;
        if (typeof chunk === 'string') return Buffer.from(chunk, encoding || 'utf8');
        if (chunk instanceof Uint8Array) return chunk;
        if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
        return Buffer.from(String(chunk));
    };

    Object.assign(res, {
        statusCode: 200,
        statusMessage: '',
        headersSent: false,
        locals: {},
        socket: req.socket,
        connection: req.socket,
        writableEnded: false,
        finished: false,
        req,
        status(c) { res.statusCode = c; return res; },
        setHeader(k, v) { headers.set(k, Array.isArray(v) ? v.join(', ') : String(v)); return res; },
        getHeader(k) { return headers.get(k); },
        removeHeader(k) { headers.delete(k); },
        hasHeader(k) { return headers.has(k); },
        set(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) res.setHeader(a, b); } else res.setHeader(k, v); return res; },
        header(k, v) { return res.set(k, v); },
        append(k, v) { headers.append(k, v); return res; },
        type(t) { res.setHeader('Content-Type', mime.contentType(t) || t); return res; },
        contentType(t) { return res.type(t); },
        attachment(name) { if (name) res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`); return res; },
        writeHead(code, msg, hdrs) { res.statusCode = code; if (typeof msg === 'object') hdrs = msg; if (hdrs) res.set(hdrs); return res; },
        flushHeaders() { start(true); },
        flush() { },
        write(chunk, encoding, cb) {
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            start(true);
            const b = toBytes(chunk, encoding);
            if (b && controller && !ended) { try { controller.enqueue(b); } catch { /* closed */ } }
            if (cb) cb();
            return true;
        },
        end(chunk, encoding, cb) {
            if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
            if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
            if (ended) return res;
            if (!started) {
                const b = toBytes(chunk, encoding);
                start(false, b);
            } else {
                if (chunk != null) res.write(chunk, encoding);
                try { controller?.close(); } catch { /* already closed */ }
            }
            ended = true;
            res.writableEnded = true; res.finished = true;
            res.emit('finish');
            if (cb) cb();
            return res;
        },
        send(body) {
            if (ended) return res;
            if (body === undefined || body === null) return res.end();
            if (typeof body === 'number') { res.statusCode = body; return res.end(); }
            if (typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ArrayBuffer)) return res.json(body);
            if (typeof body === 'string' && !headers.has('content-type')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
            if (body instanceof Uint8Array && !headers.has('content-type')) res.setHeader('Content-Type', 'application/octet-stream');
            return res.end(body);
        },
        json(obj) {
            if (!headers.has('content-type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.end(JSON.stringify(obj));
        },
        sendStatus(code) {
            res.statusCode = code;
            if (!headers.has('content-type')) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            return res.end(STATUS_TEXT[code] || String(code));
        },
        sendFile(p, opts, cb) {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            let full = String(p);
            if (opts?.root) full = opts.root.replace(/\/$/, '') + '/' + full.replace(/^\//, '');
            try {
                const data = vfs.readFileSync(full);
                if (!headers.has('content-type')) res.setHeader('Content-Type', mime.contentType(full.split('/').pop()) || 'application/octet-stream');
                if (opts?.headers) res.set(opts.headers);
                res.end(data);
                if (cb) cb();
            } catch (e) {
                if (e?.message === 'VFS_NEEDS_LOAD') throw e;
                if (cb) cb(e); else res.sendStatus(404);
            }
        },
        download(p, name, cb) {
            res.attachment(name || String(p).split('/').pop());
            return res.sendFile(p, {}, typeof name === 'function' ? name : cb);
        },
        redirect(a, b) {
            const [code, loc] = typeof a === 'number' ? [a, b] : [302, a];
            res.statusCode = code; res.setHeader('Location', loc); return res.end();
        },
        on(ev, fn) { EventEmitter.prototype.on.call(res, ev, fn); return res; },
    });
    res.responsePromise = responsePromise;
    res.isStarted = () => started;
    return res;
}

function nullBodyStatus(s) { return s === 101 || s === 204 || s === 205 || s === 304; }

const STATUS_TEXT = { 200: 'OK', 201: 'Created', 204: 'No Content', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 413: 'Payload Too Large', 429: 'Too Many Requests', 500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable' };
