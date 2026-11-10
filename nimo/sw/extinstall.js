// Third-party extensions, installed entirely in the browser.
// SillyTavern installs extensions with `git clone` on its server. NimoTavern's "server" is this Service Worker,
// so instead we download the files straight from GitHub (api.github.com + raw.githubusercontent.com both allow
// cross-origin requests) into the user's own encrypted extensions folder. NimoTavern's server never sees which
// extension anyone installs, and the code only ever runs in this user's browser.
//
// Replaces SillyTavern's /api/extensions/{install,update,version,branches,switch} (mounted before its router).
// delete/discover stay SillyTavern's own; global installs are always refused (that folder is ours).
import path from 'path-browserify';
import sanitize from 'sanitize-filename';
import express from './shims/express.js';
import { vfs } from './vfs.js';
import { nimoState } from './state.js';

const META = '.nimo-ext.json';
const MAX_FILES = 2000;
const MAX_BYTES = 30 * 1024 * 1024;
const MAX_FILE = 10 * 1024 * 1024;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const WIKI = '/wiki/nimoframework';

class InstallError extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }

/** github.com/owner/repo[.git][/tree/<ref>[/sub/folder]] */
export function parseRepoUrl(url, branch) {
    let u;
    try { u = new URL(String(url).trim()); } catch { throw new InstallError('That is not a valid URL.'); }
    if (u.protocol !== 'https:' || !['github.com', 'www.github.com'].includes(u.hostname.toLowerCase())) {
        throw new InstallError('NimoTavern can install extensions from GitHub only (https://github.com/owner/repo). Other git hosts are not supported yet.');
    }
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2) throw new InstallError('Use the address of a GitHub repository, like https://github.com/owner/repo');
    const owner = parts[0], repo = parts[1].replace(/\.git$/i, '');
    if (!/^[\w.-]{1,100}$/.test(owner) || !/^[\w.-]{1,100}$/.test(repo)) throw new InstallError('That GitHub address looks wrong.');
    let ref = branch ? String(branch).replace(/^origin\//, '') : '';
    let sub = '';
    if (parts[2] === 'tree' && parts[3]) {
        if (!ref) ref = decodeURIComponent(parts[3]);
        sub = parts.slice(4).map(decodeURIComponent).join('/');
    }
    if (sub.split('/').some((s) => s === '..' || s === '.')) throw new InstallError('That GitHub address looks wrong.');
    return { owner, repo, ref, sub };
}

async function gh(pathname, accept = 'application/vnd.github+json') {
    let r;
    try { r = await fetch(API + pathname, { headers: { Accept: accept }, credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { throw new InstallError('Could not reach GitHub. Check your connection.', 502); }
    if (r.status === 404) throw new InstallError('GitHub could not find that repository or branch (is it public?).', 404);
    if (r.status === 403 || r.status === 429) {
        const reset = Number(r.headers.get('x-ratelimit-reset')) * 1000;
        const mins = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60000)) : 60;
        throw new InstallError(`GitHub's limit for downloads without an account was reached on your network. Try again in about ${mins} minute(s).`, 429);
    }
    if (!r.ok) throw new InstallError('GitHub answered with an error (' + r.status + ').', 502);
    return accept.includes('sha') ? (await r.text()).trim() : r.json();
}

async function resolveCommit(src) {
    if (!src.ref) src.ref = (await gh(`/repos/${src.owner}/${src.repo}`)).default_branch;
    const sha = await gh(`/repos/${src.owner}/${src.repo}/commits/${encodeURIComponent(src.ref)}`, 'application/vnd.github.sha');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new InstallError('GitHub returned an unexpected answer.', 502);
    return sha;
}

/** Download the repository (or its sub folder) at `sha` into `dir`. */
async function download(src, sha, dir) {
    const tree = await gh(`/repos/${src.owner}/${src.repo}/git/trees/${sha}?recursive=1`);
    if (tree.truncated) throw new InstallError('This repository is too big to install.');
    const prefix = src.sub ? src.sub.replace(/\/+$/, '') + '/' : '';
    const files = tree.tree.filter((e) => e.type === 'blob' && e.mode !== '120000' && e.path.startsWith(prefix))
        .map((e) => ({ rel: e.path.slice(prefix.length), size: e.size || 0 }))
        .filter((f) => f.rel && !/(^|\/)\.git(\/|$)/.test(f.rel) && !f.rel.startsWith('.github/') && !f.rel.endsWith('.map')); // source maps: dev-only, they'd just use the user's storage
    if (!files.some((f) => f.rel === 'manifest.json')) {
        const looksLikePlugin = files.some((f) => f.rel === 'package.json');
        throw new InstallError(looksLikePlugin
            ? `This looks like a SillyTavern server plugin (Node.js code), not a browser extension. Server plugins can't run on NimoTavern for everyone's safety, unless the author ports it to NimoFramework (see ${WIKI}).`
            : 'This repository has no manifest.json, so it is not a SillyTavern extension.');
    }
    if (files.length > MAX_FILES) throw new InstallError(`This extension has too many files (${files.length}, the limit is ${MAX_FILES}).`);
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_BYTES) throw new InstallError(`This extension is too big (${Math.round(total / 1048576)} MB, the limit is ${MAX_BYTES / 1048576} MB).`);
    const big = files.find((f) => f.size > MAX_FILE);
    if (big) throw new InstallError(`"${big.rel}" is larger than ${MAX_FILE / 1048576} MB.`);

    const base = `${RAW}/${src.owner}/${src.repo}/${sha}/${prefix}`;
    let next = 0;
    const worker = async () => {
        while (next < files.length) {
            const f = files[next++];
            const url = base + f.rel.split('/').map(encodeURIComponent).join('/');
            let r;
            try { r = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer' }); } catch { throw new InstallError('The download was interrupted. Please try again.', 502); }
            if (!r.ok) throw new InstallError(`Could not download "${f.rel}" (${r.status}).`, 502);
            const target = path.join(dir, f.rel);
            if (!target.startsWith(dir + '/')) continue;
            vfs.mkdirSync(path.dirname(target), { recursive: true });
            vfs.writeFileSync(target, new Uint8Array(await r.arrayBuffer()));
        }
    };
    await Promise.all(Array.from({ length: Math.min(8, files.length) }, worker));
}

function readManifest(dir) {
    try {
        const m = JSON.parse(vfs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error();
        return m;
    } catch { throw new InstallError('The extension\'s manifest.json is not valid JSON.'); }
}

const readMeta = (dir) => { try { return JSON.parse(vfs.readFileSync(path.join(dir, META), 'utf8')); } catch { return null; } };

/** Download into a temporary folder, then swap it in (an update never leaves a half-written extension). */
async function installInto(root, folder, src) {
    const sha = await resolveCommit(src);
    const tmp = `/srv/ext-tmp/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; // outside the synced folders
    try {
        vfs.mkdirSync(tmp, { recursive: true });
        await download(src, sha, tmp);
        const manifest = readManifest(tmp);
        vfs.writeFileSync(path.join(tmp, META), JSON.stringify({ url: `https://github.com/${src.owner}/${src.repo}`, owner: src.owner, repo: src.repo, ref: src.ref, sub: src.sub, commit: sha, installed: Date.now() }));
        const dir = path.join(root, folder);
        if (vfs.existsSync(dir)) vfs.rmSync(dir, { recursive: true, force: true });
        vfs.renameSync(tmp, dir);
        return { manifest, sha, dir };
    } catch (e) {
        try { vfs.rmSync(tmp, { recursive: true, force: true }); } catch { /* */ }
        throw e;
    }
}

const latestCache = new Map(); // "owner/repo@ref" -> { sha, at }
async function latestCommit(meta) {
    const k = `${meta.owner}/${meta.repo}@${meta.ref}`;
    const hit = latestCache.get(k);
    if (hit && Date.now() - hit.at < 30 * 60_000) return hit.sha;
    const sha = await resolveCommit({ owner: meta.owner, repo: meta.repo, ref: meta.ref, sub: meta.sub });
    latestCache.set(k, { sha, at: Date.now() });
    return sha;
}

function fail(res, e) {
    if (e?.message === 'VFS_NEEDS_LOAD') throw e;
    const status = e instanceof InstallError ? e.status : 500;
    if (!(e instanceof InstallError)) console.error('[nimo] extension install', e);
    return res.status(status).send(e instanceof InstallError ? e.message : 'Installing the extension failed: ' + (e?.message || e));
}

function extensionDir(req) {
    const name = sanitize(String(req.body?.extensionName || ''));
    if (!name || name.startsWith('.')) throw new InstallError('A valid extension name is required.');
    if (req.body?.global) throw new InstallError('NimoTavern has no global extensions: each account installs its own.', 403);
    const dir = path.join(req.user.directories.extensions, name);
    if (!vfs.existsSync(dir)) throw new InstallError('That extension is not installed.', 404);
    return dir;
}

export const extensionsOverride = express.Router();

extensionsOverride.post('/install', async (req, res) => {
    try {
        if (nimoState.play) throw new InstallError('Extensions are turned off on the multiplayer site.', 403);
        if (!nimoState.extensionsConsent) throw new InstallError('Please read and accept the extension warning first (it appears when you install an extension).', 403);
        // "Install for all users" (SillyTavern shows it because there's one user per browser here) means "for me":
        // every account has its own extensions, the shared global folder is NimoTavern's own.
        const src = parseRepoUrl(req.body?.url, req.body?.branch);
        const root = req.user.directories.extensions;
        vfs.mkdirSync(root, { recursive: true });
        const folder = sanitize(src.sub ? src.sub.split('/').filter(Boolean).pop() : src.repo);
        if (!folder || folder.startsWith('.')) throw new InstallError('Could not work out a folder name for this extension.');
        if (folder === 'nimo-multiplayer') throw new InstallError('That name is reserved.');
        if (vfs.existsSync(path.join(root, folder))) throw new InstallError(`An extension named "${folder}" is already installed.`, 409);
        const { manifest, dir } = await installInto(root, folder, src);
        const { version, author, display_name } = manifest;
        return res.send({ version, author, display_name, extensionPath: dir, folderName: folder });
    } catch (e) { return fail(res, e); }
});

extensionsOverride.post('/version', async (req, res) => {
    try {
        if (req.body?.global) return res.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        const meta = readMeta(extensionDir(req));
        if (!meta) return res.send({ currentBranchName: '', currentCommitHash: '', isUpToDate: true, remoteUrl: '' });
        let isUpToDate = true;
        try { isUpToDate = (await latestCommit(meta)) === meta.commit; } catch { /* offline / rate limited: don't nag */ }
        return res.send({ currentBranchName: meta.ref, currentCommitHash: meta.commit, isUpToDate, remoteUrl: meta.url });
    } catch (e) { return fail(res, e); }
});

extensionsOverride.post('/update', async (req, res) => {
    try {
        if (nimoState.play) throw new InstallError('Extensions are turned off on the multiplayer site.', 403);
        const dir = extensionDir(req);
        const meta = readMeta(dir);
        if (!meta) throw new InstallError('This extension was not installed from GitHub, so it can\'t be updated.');
        latestCache.delete(`${meta.owner}/${meta.repo}@${meta.ref}`);
        const latest = await latestCommit(meta);
        let sha = meta.commit;
        const isUpToDate = latest === meta.commit;
        if (!isUpToDate) ({ sha } = await installInto(path.dirname(dir), path.basename(dir), { owner: meta.owner, repo: meta.repo, ref: meta.ref, sub: meta.sub }));
        return res.send({ shortCommitHash: sha.slice(0, 7), extensionPath: dir, isUpToDate, remoteUrl: meta.url });
    } catch (e) { return fail(res, e); }
});

extensionsOverride.post('/branches', async (req, res) => {
    try {
        const meta = readMeta(extensionDir(req));
        if (!meta) return res.send([]);
        const list = await gh(`/repos/${meta.owner}/${meta.repo}/branches?per_page=100`);
        return res.send(list.map((b) => ({ current: b.name === meta.ref, commit: b.commit?.sha?.slice(0, 7), name: b.name, label: b.name })));
    } catch (e) { return fail(res, e); }
});

extensionsOverride.post('/switch', async (req, res) => {
    try {
        if (nimoState.play) throw new InstallError('Extensions are turned off on the multiplayer site.', 403);
        const dir = extensionDir(req);
        const meta = readMeta(dir);
        const branch = String(req.body?.branch || '').replace(/^origin\//, '');
        if (!meta || !branch) throw new InstallError('A branch is required.');
        if (branch !== meta.ref) await installInto(path.dirname(dir), path.basename(dir), { owner: meta.owner, repo: meta.repo, ref: branch, sub: meta.sub });
        return res.sendStatus(204);
    } catch (e) { return fail(res, e); }
});

extensionsOverride.post('/move', (_req, res) => res.status(403).send('NimoTavern has no global extensions: each account installs its own.'));
