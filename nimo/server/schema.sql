-- NimoTavern database. The server only ever stores:
--   * usernames, salts and hashes of client-derived auth keys
--   * the user's data key, wrapped (encrypted) by keys only the user can derive
--   * opaque encrypted blobs addressed by HMAC ids
-- No emails, no IPs, no user agents, no plaintext content.

CREATE TABLE IF NOT EXISTS users (
    id              BIGSERIAL PRIMARY KEY,
    username        TEXT NOT NULL,
    username_lc     TEXT NOT NULL UNIQUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    kdf             JSONB NOT NULL,
    salt_pw         BYTEA NOT NULL,
    auth_pw_hash    BYTEA NOT NULL,
    salt_rec        BYTEA NOT NULL,
    auth_rec_hash   BYTEA NOT NULL,
    wrapped_pw      TEXT NOT NULL,
    wrapped_rec     TEXT NOT NULL,
    seq             BIGINT NOT NULL DEFAULT 0,
    used_bytes      BIGINT NOT NULL DEFAULT 0,
    quota_bytes     BIGINT NOT NULL DEFAULT 1073741824,
    failed_logins   INT NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  BYTEA PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
-- Which site the login was made on: 'main' (the tavern, where extensions may run) or 'play' (play.*, the
-- multiplayer site, which never runs third-party code). Multiplayer only accepts 'play' logins.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'main';

CREATE TABLE IF NOT EXISTS blobs (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    seq         BIGINT NOT NULL,
    size        INT NOT NULL DEFAULT 0,
    data        BYTEA,           -- NULL = tombstone (deleted)
    PRIMARY KEY (user_id, id)
);
CREATE INDEX IF NOT EXISTS blobs_user_seq ON blobs(user_id, seq);
ALTER TABLE blobs ALTER COLUMN data SET STORAGE EXTERNAL; -- ciphertext doesn't compress, skip TOAST compression

-- Accounts imported from an existing SillyTavern instance, waiting to be claimed on first login.
-- The archive is plaintext SillyTavern data (which the operator already had); it is deleted as
-- soon as the owner's browser has re-encrypted and uploaded it.
-- Aggregate usage counters for the operator's stats panel. Nothing here identifies a user, device or IP:
--   stats_daily   one row per UTC day of plain counters
--   stats_active  how many distinct accounts were active in a day / week / month (a number, not a list)
--   stats_seen    dedupe set for the CURRENT period only: keyed hashes, purged as soon as the period ends
CREATE TABLE IF NOT EXISTS stats_daily (
    day          DATE PRIMARY KEY,
    visitors     INT NOT NULL DEFAULT 0,
    pageviews    INT NOT NULL DEFAULT 0,
    wiki_views   INT NOT NULL DEFAULT 0,
    logins       INT NOT NULL DEFAULT 0,
    signups      INT NOT NULL DEFAULT 0,
    relay_calls  INT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS stats_active (
    kind    CHAR(1) NOT NULL,   -- d | w | m
    period  TEXT NOT NULL,
    n       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, period)
);
CREATE TABLE IF NOT EXISTS stats_seen (
    kind    CHAR(1) NOT NULL,
    period  TEXT NOT NULL,
    h       BYTEA NOT NULL,
    PRIMARY KEY (kind, period, h)
);

CREATE TABLE IF NOT EXISTS legacy_accounts (
    username_lc   TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    st_salt       TEXT NOT NULL,
    st_hash       TEXT NOT NULL,
    archive       TEXT NOT NULL,
    size          BIGINT NOT NULL DEFAULT 0,
    claimed_user  BIGINT REFERENCES users(id) ON DELETE CASCADE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Multiplayer sessions. The server runs the AI for these, so it can read them while generating; everything with
-- content is sealed at rest (see mp/seal.js): config, personas, avatars, messages. Plain columns hold only ids,
-- counters and the turn state (member ids, round number). Ending a session deletes every row; so does deleting
-- the host's account. Inactive sessions are deleted after 90 days.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mp_invites TEXT NOT NULL DEFAULT 'anyone';
CREATE TABLE IF NOT EXISTS mp_sessions (
    id           UUID PRIMARY KEY,
    host_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    max_players  INT NOT NULL DEFAULT 6,
    rev          BIGINT NOT NULL DEFAULT 0,
    wrapped_key  BYTEA NOT NULL,
    config       BYTEA NOT NULL,   -- sealed: character, world, lorebook, prompts, AI provider + key, sampling
    info         BYTEA NOT NULL,   -- sealed: what members see (title, character name + avatar)
    state        JSONB NOT NULL    -- turn state: member ids and counters only
);
CREATE INDEX IF NOT EXISTS mp_sessions_host ON mp_sessions(host_id);
CREATE TABLE IF NOT EXISTS mp_members (
    session_id   UUID NOT NULL REFERENCES mp_sessions(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mid          TEXT NOT NULL,     -- random member id shown to clients (never the account id)
    role         TEXT NOT NULL,     -- host | player
    persona      BYTEA,             -- sealed {name, description}; NULL until the player picks one
    avatar       BYTEA,             -- sealed image
    joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, user_id),
    UNIQUE (session_id, mid)
);
CREATE INDEX IF NOT EXISTS mp_members_user ON mp_members(user_id);
CREATE TABLE IF NOT EXISTS mp_messages (
    session_id   UUID NOT NULL REFERENCES mp_sessions(id) ON DELETE CASCADE,
    id           BIGINT NOT NULL,   -- position in the chat
    rev          BIGINT NOT NULL,   -- session revision of the last change (clients sync by rev)
    data         BYTEA,             -- sealed message; NULL = deleted
    PRIMARY KEY (session_id, id)
);
CREATE INDEX IF NOT EXISTS mp_messages_rev ON mp_messages(session_id, rev);
ALTER TABLE mp_messages ALTER COLUMN data SET STORAGE EXTERNAL;
CREATE TABLE IF NOT EXISTS mp_invites (
    id           BIGSERIAL PRIMARY KEY,
    session_id   UUID NOT NULL REFERENCES mp_sessions(id) ON DELETE CASCADE,
    from_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    to_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, to_id)
);
CREATE INDEX IF NOT EXISTS mp_invites_to ON mp_invites(to_id);
CREATE TABLE IF NOT EXISTS mp_notices (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id   UUID REFERENCES mp_sessions(id) ON DELETE SET NULL,
    kind         TEXT NOT NULL,     -- turn | joined | declined | kicked | ended
    who          TEXT,              -- username the notice is about
    title        BYTEA,             -- sealed session title (kept for "ended" notices after the session is gone)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    seen         BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS mp_notices_user ON mp_notices(user_id);
CREATE TABLE IF NOT EXISTS mp_blocks (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    blocked_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, blocked_id)
);
