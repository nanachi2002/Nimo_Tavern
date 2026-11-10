// The "server" half of the example, ported to NimoFramework.
//
// On regular SillyTavern this exact file is a server plugin: copy it to SillyTavern/plugins/nimo-example.cjs and it
// runs in Node on the server. On NimoTavern it runs in the user's own browser (their Service Worker). Same routes:
//   POST /api/plugins/nimo-example/probe   "are you there?"  (SillyTavern's usual convention)
//   GET  /api/plugins/nimo-example/hello
//   POST /api/plugins/nimo-example/count
//
// `nimo` only exists on NimoTavern, so the file checks for it and falls back to plain Node on SillyTavern.
const fs = require('fs');
const path = require('path');

const onNimo = typeof nimo !== 'undefined';

// A tiny key/value store: nimo.storage on NimoTavern (encrypted + synced), a JSON file on SillyTavern.
const store = onNimo ? nimo.storage : (() => {
    const file = path.join(process.cwd(), 'plugins', 'nimo-example.json');
    const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; } };
    return {
        get: (key, fallback) => read()[key] ?? fallback,
        set: (key, value) => fs.writeFileSync(file, JSON.stringify({ ...read(), [key]: value })),
    };
})();

module.exports = {
    info: {
        id: 'nimo-example',          // lowercase letters, digits, "-" or "_": this is the URL of your plugin
        name: 'NimoFramework example',
        description: 'Shows how a SillyTavern server plugin runs on NimoTavern.',
    },

    async init(router) {
        // The UI half calls this first to know whether its backend is running.
        router.post('/probe', (_req, res) => res.sendStatus(204));

        router.get('/hello', (req, res) => {
            res.json({
                hello: onNimo ? nimo.user.name : req.user.profile.handle,
                framework: onNimo ? nimo.version : 0,
            });
        });

        // A counter kept in the plugin's own storage.
        router.post('/count', (_req, res) => {
            const count = store.get('count', 0) + 1;
            store.set('count', count);
            res.json({ count });
        });
    },

    async exit() {
        // Called when the plugin is disabled, updated or removed. Nothing to clean up here.
    },
};
