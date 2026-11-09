// NimoTavern in-browser SillyTavern "server".
// Mounts SillyTavern's own endpoint routers on a mini-express app that runs in the
// Service Worker, on top of the encrypted VFS. The real NimoTavern server never sees
// any of this traffic.
import './preinit.js';
import path from 'path-browserify';
import mime from 'mime-types';
import yaml from 'yaml';
import express from './shims/express.js';
import { vfs } from './vfs.js';
import { nimoState } from './state.js';
import { USER_DIRECTORY_TEMPLATE } from '../../src/constants.js';
import { setConfigFilePath } from '../../src/util.js';

import { router as movingUIRouter } from '../../src/endpoints/moving-ui.js';
import { router as imagesRouter } from '../../src/endpoints/images.js';
import { router as quickRepliesRouter } from '../../src/endpoints/quick-replies.js';
import { router as avatarsRouter } from '../../src/endpoints/avatars.js';
import { router as themesRouter } from '../../src/endpoints/themes.js';
import { router as openAiRouter } from '../../src/endpoints/openai.js';
import { router as googleRouter } from '../../src/endpoints/google.js';
import { router as anthropicRouter } from '../../src/endpoints/anthropic.js';
import { router as tokenizersRouter } from '../../src/endpoints/tokenizers.js';
import { router as presetsRouter } from '../../src/endpoints/presets.js';
import { router as secretsRouter } from '../../src/endpoints/secrets.js';
import { router as thumbnailRouter } from '../../src/endpoints/thumbnails.js';
import { router as novelAiRouter } from '../../src/endpoints/novelai.js';
import { router as extensionsRouter } from '../../src/endpoints/extensions.js';
import { router as assetsRouter } from '../../src/endpoints/assets.js';
import { router as filesRouter } from '../../src/endpoints/files.js';
import { router as charactersRouter } from '../../src/endpoints/characters.js';
import { router as chatsRouter } from '../../src/endpoints/chats.js';
import { router as groupsRouter } from '../../src/endpoints/groups.js';
import { router as worldInfoRouter } from '../../src/endpoints/worldinfo.js';
import { router as statsRouter } from '../../src/endpoints/stats.js';
import { router as contentManagerRouter, checkForNewContent } from '../../src/endpoints/content-manager.js';
import { router as settingsRouter } from '../../src/endpoints/settings.js';
import { router as backgroundsRouter } from '../../src/endpoints/backgrounds.js';
import { router as spritesRouter } from '../../src/endpoints/sprites.js';
import { router as stableDiffusionRouter } from '../../src/endpoints/stable-diffusion.js';
import { router as hordeRouter } from '../../src/endpoints/horde.js';
import { router as translateRouter } from '../../src/endpoints/translate.js';
import { router as searchRouter } from '../../src/endpoints/search.js';
import { router as openRouterRouter } from '../../src/endpoints/openrouter.js';
import { router as nanogptRouter } from '../../src/endpoints/nanogpt.js';
import { router as chatCompletionsRouter } from '../../src/endpoints/backends/chat-completions.js';
import { router as koboldRouter } from '../../src/endpoints/backends/kobold.js';
import { router as textCompletionsRouter } from '../../src/endpoints/backends/text-completions.js';
import { router as speechRouter } from '../../src/endpoints/speech.js';
import { router as azureRouter } from '../../src/endpoints/azure.js';
import { router as volcengineRouter } from '../../src/endpoints/volcengine.js';
import { router as minimaxRouter } from '../../src/endpoints/minimax.js';
import { router as dataMaidRouter } from '../../src/endpoints/data-maid.js';
import { router as backupsRouter } from '../../src/endpoints/backups.js';
import { router as imageMetadataRouter } from '../../src/endpoints/image-metadata.js';
import { nimoUsersRouter } from './users-router.js';

export const DATA_ROOT = '/data';
export const USER_HANDLE = 'default-user';

globalThis.DATA_ROOT = DATA_ROOT;
globalThis.COMMAND_LINE_ARGS = { dataRoot: DATA_ROOT, enableAccounts: false };

export function getUserDirectories() {
    const d = {};
    for (const [k, v] of Object.entries(USER_DIRECTORY_TEMPLATE)) d[k] = path.join(DATA_ROOT, USER_HANDLE, v);
    return d;
}

import { SW_CONFIG } from './config.js';
export { SW_CONFIG };

export function initServerFiles() {
    // Re-create ephemeral server files (VFS is reset on lock/logout).
    vfs.mkdirSync('/srv/public', { recursive: true });
    vfs.mkdirSync(DATA_ROOT + '/_uploads', { recursive: true });
    vfs.writeFileSync('/srv/config.yaml', yaml.stringify(SW_CONFIG));
}

export function ensureUserDirectories() {
    for (const dir of Object.values(getUserDirectories())) vfs.mkdirSync(dir, { recursive: true });
}

export async function seedContent() {
    await checkForNewContent([getUserDirectories()]);
}

const userMiddleware = (req, _res, next) => {
    req.user = {
        profile: { handle: USER_HANDLE, name: nimoState.username || 'User', admin: false, enabled: true, created: 0, password: '', salt: '' },
        directories: getUserDirectories(),
    };
    next();
};

function staticFrom(getDir) {
    return (req, res) => {
        try {
            const rel = decodeURIComponent(req.params[0] || req.path.replace(/^\//, ''));
            const base = getDir(req);
            const full = path.normalize(path.join(base, rel));
            if (!full.startsWith(base + '/') || !vfs.existsSync(full) || vfs.statSync(full).isDirectory()) return res.sendStatus(404);
            res.setHeader('Content-Type', mime.contentType(path.basename(full)) || 'application/octet-stream');
            res.setHeader('Cache-Control', 'no-cache');
            return res.sendFile(full);
        } catch (e) {
            if (e?.message === 'VFS_NEEDS_LOAD') throw e;
            return res.sendStatus(404);
        }
    };
}

export const app = express();
app.use(userMiddleware);

// user data static paths (same as SillyTavern's users.js router)
app.get('/backgrounds/*', staticFrom(r => r.user.directories.backgrounds));
app.get('/characters/*', staticFrom(r => r.user.directories.characters));
app.get('/User Avatars/*', staticFrom(r => r.user.directories.avatars));
app.get('/assets/*', staticFrom(r => r.user.directories.assets));
app.get('/user/images/*', staticFrom(r => r.user.directories.userImages));
app.get('/user/files/*', staticFrom(r => r.user.directories.files));
app.get('/scripts/extensions/third-party/*', staticFrom(r => r.user.directories.extensions));

app.get('/csrf-token', (_req, res) => res.json({ token: 'disabled' }));
app.get('/version', (_req, res) => res.json({ agent: 'NimoTavern', pkgVersion: __ST_VERSION__, gitRevision: 'nimotavern', gitBranch: 'nimotavern', isLatest: true }));
app.post('/api/ping', (_req, res) => res.sendStatus(204));
app.get('/api/ping', (_req, res) => res.sendStatus(204));
app.post('/api/plugins/list', (_req, res) => res.json([]));

app.use('/api/users', nimoUsersRouter);
app.use('/api/moving-ui', movingUIRouter);
app.use('/api/images', imagesRouter);
app.use('/api/quick-replies', quickRepliesRouter);
app.use('/api/avatars', avatarsRouter);
app.use('/api/themes', themesRouter);
app.use('/api/openai', openAiRouter);
app.use('/api/google', googleRouter);
app.use('/api/anthropic', anthropicRouter);
app.use('/api/tokenizers', tokenizersRouter);
app.use('/api/presets', presetsRouter);
app.use('/api/secrets', secretsRouter);
app.use('/thumbnail', thumbnailRouter);
app.use('/api/novelai', novelAiRouter);
app.use('/api/extensions', extensionsRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/files', filesRouter);
app.use('/api/characters', charactersRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/groups', groupsRouter);
app.use('/api/worldinfo', worldInfoRouter);
app.use('/api/stats', statsRouter);
app.use('/api/backgrounds', backgroundsRouter);
app.use('/api/sprites', spritesRouter);
app.use('/api/content', contentManagerRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/sd', stableDiffusionRouter);
app.use('/api/horde', hordeRouter);
app.use('/api/translate', translateRouter);
app.use('/api/search', searchRouter);
app.use('/api/backends/text-completions', textCompletionsRouter);
app.use('/api/openrouter', openRouterRouter);
app.use('/api/nanogpt', nanogptRouter);
app.use('/api/backends/kobold', koboldRouter);
app.use('/api/backends/chat-completions', chatCompletionsRouter);
app.use('/api/speech', speechRouter);
app.use('/api/azure', azureRouter);
app.use('/api/volcengine', volcengineRouter);
app.use('/api/minimax', minimaxRouter);
app.use('/api/data-maid', dataMaidRouter);
app.use('/api/backups', backupsRouter);
app.use('/api/image-metadata', imageMetadataRouter);

// Features that need server-side ML models are not available in zero-knowledge mode.
for (const p of ['/api/vector', '/api/extra/classify', '/api/extra/caption']) {
    app.use(p, (_req, res) => res.status(501).send('This feature requires server-side processing and is disabled in NimoTavern for privacy.'));
}
