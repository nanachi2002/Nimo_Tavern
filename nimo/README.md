# NimoTavern

A privacy-first, multi-user public instance of [SillyTavern](https://github.com/SillyTavern/SillyTavern).
All credit for the interface and features goes to the SillyTavern team and contributors. NimoTavern is
an independent fork (AGPL-3.0), not affiliated with them.

## Idea

Stock SillyTavern has a Node server that reads/writes the user's files and forwards prompts + API keys
to AI providers, so whoever runs a public instance can read everything. NimoTavern moves that server
**into the user's browser**:

```
Browser                                                     NimoTavern server
┌────────────────────────────────────────────┐              ┌──────────────────────────┐
│ SillyTavern UI (public/, unchanged)        │              │ accounts + sessions      │
│        │ fetch('/api/...')                 │              │ opaque encrypted blobs   │
│        ▼                                   │  ciphertext  │ (PostgreSQL)             │
│ Service Worker (nimo/sw)                   │ ───────────► │ optional no-log relay    │
│  • SillyTavern's own src/endpoints/*       │              └──────────────────────────┘
│  • mini-express + node shims               │
│  • in-memory VFS ◄─► AES-256-GCM store     │   prompts + API keys
│  • node-fetch → direct browser fetch ──────┼──────────────────────────► AI provider
└────────────────────────────────────────────┘
```

* `nimo/sw/` – the Service Worker. `app.js` mounts SillyTavern's routers exactly like
  `src/server-startup.js`; `shims/` replaces `fs`, `express`, `node-fetch`, `crypto`, … with browser
  versions; `vfs.js` is the virtual file system; `store.js` encrypts/syncs it.
* `nimo/shared/crypto.js` – key derivation and encryption (Argon2id, HKDF, AES-GCM, HMAC ids).
* `nimo/server/` – Express + PostgreSQL: auth, blob storage, relay, page serving.
* `nimo/web/` – NimoTavern pages (home, login, register, recover, account, privacy) styled with
  SillyTavern's theme, and `boot.js` injected into SillyTavern's `index.html`.

## Security model

* Password → Argon2id (64 MiB, t=3) → HKDF → **KEK** (never leaves the browser) + **auth key** (sent,
  stored scrypt-hashed).
* Random 256-bit **data key**, stored on the server only wrapped by the password KEK and by a
  12-word BIP39 recovery phrase KEK.
* Every file = deflate → AES-256-GCM, AAD = blob id; blob id = HMAC-SHA256(path), so paths are hidden.
* Default content (themes, backgrounds, Seraphina, tokenizer models) is public and shared by
  reference, never duplicated per user.
* Server stores no email/IP/user agent; no access logs; rate limiting uses salted IP hashes in RAM.
* Limitations: users trust the served JS (like any web app); the chosen AI provider sees prompts;
  server-side ML features (vectors, captioning, classify) are disabled; third-party extensions that
  need server-side installation are unavailable.

## Build & deploy

```bash
npm ci                      # SillyTavern deps + NimoTavern build deps
node nimo/build-lib.mjs     # SillyTavern's webpack lib.js -> dist/lib.js
node nimo/build.mjs all     # Service Worker + pages -> nimo/dist
nimo/deploy.sh              # package + push to the Proxmox LXC, restart, auto-rollback on failure
```

Server env (`/etc/nimotavern.env`): `NIMO_SECRET`, `DATABASE_URL`, `PORT`, `COOKIE_SECURE`,
`REGISTRATION_OPEN`, `DEFAULT_QUOTA_BYTES`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`, `SOURCE_URL`.

## Updating from upstream SillyTavern

NimoTavern does not modify SillyTavern's code; it bundles it. Merge upstream `release`, rebuild, and run
the E2E checks. Build-time patches (see `nimo/build.mjs`) fail loudly if their target code changed.
