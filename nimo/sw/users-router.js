// Replacement for SillyTavern's /api/users endpoints. Account management (password,
// recovery key, deletion) lives on the NimoTavern account page, not here.
import { zipSync } from 'fflate';
import express from './shims/express.js';
import { vfs } from './vfs.js';
import { nimoState } from './state.js';

export const nimoUsersRouter = express.Router();

nimoUsersRouter.get('/me', (req, res) => res.json({
    handle: req.user.profile.handle,
    name: nimoState.username || 'User',
    avatar: '/img/ai4.png',
    admin: false,
    password: true,
    created: 0,
}));

nimoUsersRouter.post('/logout', async (_req, res) => {
    self.dispatchEvent(new CustomEvent('nimo-logout'));
    res.sendStatus(204);
});

nimoUsersRouter.post('/backup', async (req, res) => {
    // Export the user's decrypted data as a SillyTavern-compatible zip, built locally.
    const root = req.user.directories.root;
    const files = {};
    const pending = [];
    for (const [p, e] of vfs.files) if (p.startsWith(root + '/')) { if (!e.data) pending.push(p); }
    await vfs.resolveRefs(pending);
    for (const [p, e] of vfs.files) if (p.startsWith(root + '/') && e.data) files[p.slice(root.length + 1)] = e.data;
    const zip = zipSync(files, { level: 1 });
    res.setHeader('Content-Type', 'application/zip');
    res.attachment(`nimotavern-${nimoState.username || 'user'}-${new Date().toISOString().slice(0, 10)}.zip`);
    res.end(zip);
});

nimoUsersRouter.post('/change-password', (_req, res) => res.status(400).json({ error: 'Change your password from the NimoTavern account page (/account).' }));
nimoUsersRouter.post('/change-name', (_req, res) => res.sendStatus(204));
nimoUsersRouter.post('/change-avatar', (_req, res) => res.sendStatus(204));
nimoUsersRouter.post('/reset-settings', (_req, res) => res.status(400).json({ error: 'Not available' }));
nimoUsersRouter.use((_req, res) => res.status(404).json({ error: 'Not available in NimoTavern' }));
