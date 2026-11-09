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
