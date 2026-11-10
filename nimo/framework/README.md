# NimoFramework

**Port SillyTavern server plugins so they run on NimoTavern.**

The full guide, with animated explanations and a "port check" that tells you what to change in your plugin, is on the wiki: **https://nimorp.lol/wiki/nimoframework**. This file is the short version.

NimoTavern is a public, end-to-end encrypted SillyTavern. Each user's SillyTavern "server" runs in their own browser (in a Service Worker), on their own encrypted files. Our real server only stores encrypted blobs it can't read.

## Why server plugins are blocked

A normal SillyTavern [server plugin](https://docs.sillytavern.app/for-contributors/server-plugins/) is Node.js code that runs on the server.

On a server shared by thousands of people, that code would run next to everyone else's data. One buggy or malicious plugin could read other users' accounts or take the site down. So NimoTavern never runs anyone's code on its server. This won't change.

## What NimoFramework does instead

It runs your plugin's backend **in the user's own browser**, next to SillyTavern's own (also ported) server code. Your routes stay the same (`/api/plugins/<id>/...`), so your extension's front-end code doesn't change.

- The plugin can reach the data of the person who installed it, and nothing else: never other users, never NimoTavern's server.
- Users accept a warning before their first extension install.
- Extensions, ported plugins included, never run on the multiplayer site.

## Quick start

1. **Add a `nimo` field to your UI extension's `manifest.json`:**

   ```json
   {
       "display_name": "My extension",
       "js": "index.js",
       "nimo": { "framework": 1, "server": "server.cjs" }
   }
   ```

   Regular SillyTavern ignores this field, so the same repository keeps working there.

2. **Put your plugin in `server.cjs`**: one CommonJS file exporting the usual plugin shape. `init(router)` receives an Express-style router mounted at `/api/plugins/<info.id>/`.

   ```js
   module.exports = {
       info: { id: 'my-plugin', name: 'My plugin', description: '...' },
       async init(router) {
           router.post('/probe', (req, res) => res.sendStatus(204));
           router.get('/hello', (req, res) => res.json({ hello: nimo.user.name }));
           router.post('/save', (req, res) => { nimo.storage.set('last', req.body); res.json({ ok: true }); });
       },
       async exit() { /* optional */ },
   };
   ```

3. **If your plugin uses ES modules, several files or npm packages, bundle it** (skip this for a plain single CommonJS file):

   ```bash
   npx esbuild src/index.js --bundle --platform=node --format=cjs --external:express --external:node-fetch --outfile=server.cjs
   ```

   Node built-ins stay as `require()` calls, which NimoFramework provides. **Commit the built `server.cjs`**: NimoTavern installs straight from GitHub and doesn't build anything.

4. **Install it in NimoTavern from its GitHub URL** (Extensions → Install extension). Your plugin starts on the first request to `/api/plugins/`, and the browser console shows:

   ```
   [NimoFramework] loaded "my-plugin" from the extension "my-extension": /api/plugins/my-plugin/
   ```

A complete working example is in [`example/`](example/): a UI part (`index.js`) and a backend (`server.cjs`) with a per-user counter. The same `server.cjs` also works as a regular SillyTavern plugin. Install it on NimoTavern with `https://github.com/nanachi2002/Nimo_Tavern/tree/main/nimo/framework/example`.

## What's available

**Modules** (with or without the `node:` prefix): `express`, `node-fetch`, `fs`, `fs/promises`, `path`, `path/posix`, `crypto`, `os`, `url`, `querystring`, `buffer`, `events`, `stream`, `stream/promises`, `string_decoder`, `readline`, `util`, `assert`, `timers`, `timers/promises`, `perf_hooks`, `process`, `console`, `tty`. The list lives in [`../shared/framework-modules.js`](../shared/framework-modules.js).

| In your plugin | What it is |
| --- | --- |
| `require('express')` | `Router()` with the usual methods, route parameters and sub-routers. `json()` / `urlencoded()` are no-ops because bodies are already parsed. |
| `req.body` | JSON → object, multipart → text fields, URL-encoded → object, anything else → a **string** (send binary as multipart or base64-in-JSON). |
| `req.file` | First file of a multipart upload, multer-style (`originalname`, `mimetype`, `size`, `path`). |
| `req.user.directories` | SillyTavern's usual user directories (characters, chats, worlds...). |
| `res.*` | `json/send/status/sendStatus/set/type/sendFile/download/redirect`, and streaming with `res.write()`. |
| `fs`, `fs/promises` | The user's own encrypted files (`/data/default-user/...`). Writes are encrypted and synced to their other devices. |
| `node-fetch` / `nimo.fetch` | `fetch()` from the user's browser (CORS applies). If the user turned on NimoTavern's opt-in relay, blocked requests are retried through it. |
| `nimo.version` | The NimoFramework version (currently `1`). |
| `nimo.user.name` | The user's NimoTavern username. |
| `nimo.storage.get(key, fallback)` / `.set` / `.delete` / `.keys()` | A small synchronous JSON key/value store for your plugin, encrypted and synced. |
| `nimo.dataDir` | A folder reserved for your plugin's files. |
| `nimo.extensionDir` | Where your extension is installed: read files shipped in your repository from here. |
| `nimo.relay` | `true` when the user enabled the opt-in relay. |

Anything else you `require()` throws an error that says what to do instead.

## What can't work in a browser

- **Native addons**, `child_process`, Python or other executables.
- **Raw sockets** (`net`, `tls`, `dgram`) or listening on a port: your routes are your server.
- **Background jobs.** Browsers stop an idle Service Worker after about 30 seconds. `init()` runs again on the next request, so keep state in `nimo.storage` or files, not in variables. A request in progress is fine (streaming works).
- **`process.env`** is empty: store settings with `nimo.storage`.

## Telling NimoTavern apart from SillyTavern

- Server side: `typeof nimo !== 'undefined'`.
- UI side: `window.NimoTavern?.framework` (`1` on NimoTavern, `undefined` on SillyTavern).
- Is my backend running? Give your plugin a `POST /probe` route answering `204` (SillyTavern's usual convention); it works on both.
- `GET /api/plugins/status` (NimoTavern only) lists loaded plugins, their routes, and errors.

## Debugging

If the server part can't start, the rest of the extension still loads. The user gets a toast naming the extension and the reason, and the browser console has the details (`[NimoFramework] ...` lines, plus your plugin's own `console.log` output tagged `[<extension folder>]`). See https://nimorp.lol/wiki/nimoframework#debugging for every message and its fix.

## Security model, in one paragraph

Your plugin has exactly the same power as your extension's browser code: it can read and change the installing user's data, and nothing else. It's not sandboxed beyond that, which is why users are warned before their first install. Extensions are **always off on the multiplayer site** (`play.<site>`), a separate browser origin, so no extension can see group sessions or the other players.

## Versioning

`"framework": 1` is the current API. If a future version changes it, older NimoTavern builds refuse plugins that ask for a newer version, and say why.
