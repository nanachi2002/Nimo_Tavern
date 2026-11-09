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
