-- Times are milliseconds since the Unix epoch. Sizes are bytes.

CREATE TABLE roles (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    -- 'admin' and 'user' ship with the app and can't be deleted; admin can't be edited.
    builtin     TEXT,
    -- JSON array of permission names.
    permissions TEXT NOT NULL DEFAULT '[]',
    created_at  INTEGER NOT NULL
);

CREATE TABLE users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role_id       INTEGER NOT NULL REFERENCES roles (id),
    locale        TEXT,
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
);

-- Per-user exceptions to the role: granted (allow = 1) or withdrawn (allow = 0).
CREATE TABLE user_permissions (
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    allow      INTEGER NOT NULL,
    PRIMARY KEY (user_id, permission)
) WITHOUT ROWID;

CREATE TABLE sessions (
    -- SHA-256 of the cookie value: a stolen database can't be replayed.
    token_hash BLOB PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
) WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE streamers (
    id             INTEGER PRIMARY KEY,
    twitch_id      TEXT NOT NULL UNIQUE,
    login          TEXT NOT NULL,
    display_name   TEXT NOT NULL,
    avatar_url     TEXT,
    monitored      INTEGER NOT NULL DEFAULT 1,
    -- Days recordings are kept; NULL follows the global setting.
    retention_days INTEGER,
    live_title     TEXT,
    live_game      TEXT,
    live_since     INTEGER,
    created_at     INTEGER NOT NULL
);
CREATE INDEX streamers_login ON streamers (login);

CREATE TABLE streams (
    id               INTEGER PRIMARY KEY,
    streamer_id      INTEGER NOT NULL REFERENCES streamers (id) ON DELETE CASCADE,
    twitch_stream_id TEXT NOT NULL,
    -- A broadcast whose picture format changes midway continues in a new part.
    part             INTEGER NOT NULL DEFAULT 1,
    title            TEXT NOT NULL DEFAULT '',
    game             TEXT,
    -- 'recording', 'done', 'failed'.
    status           TEXT NOT NULL,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    -- Wall-clock time of the first picture, which chat times are measured from.
    video_start_at   INTEGER,
    duration_ms      INTEGER NOT NULL DEFAULT 0,
    size_bytes       INTEGER NOT NULL DEFAULT 0,
    video_codec      TEXT,
    audio_codec      TEXT,
    width            INTEGER,
    height           INTEGER,
    fps              REAL,
    chat_messages    INTEGER NOT NULL DEFAULT 0,
    ads_skipped_ms   INTEGER NOT NULL DEFAULT 0,
    gaps             INTEGER NOT NULL DEFAULT 0,
    keep_forever     INTEGER NOT NULL DEFAULT 0,
    -- Folder under the streams directory.
    dir              TEXT NOT NULL,
    has_thumbnail    INTEGER NOT NULL DEFAULT 0,
    error            TEXT
);
CREATE INDEX streams_streamer ON streams (streamer_id, started_at DESC);
CREATE INDEX streams_status ON streams (status);

-- Title and category changes during a broadcast, as chapters.
CREATE TABLE stream_chapters (
    stream_id INTEGER NOT NULL REFERENCES streams (id) ON DELETE CASCADE,
    at_ms     INTEGER NOT NULL,
    title     TEXT NOT NULL,
    game      TEXT,
    PRIMARY KEY (stream_id, at_ms)
) WITHOUT ROWID;

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE alerts (
    id         INTEGER PRIMARY KEY,
    -- 'info', 'warning', 'error'.
    level      TEXT NOT NULL,
    kind       TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    resolved   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX alerts_open ON alerts (resolved, created_at DESC);

CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY,
    user_id    INTEGER REFERENCES users (id) ON DELETE SET NULL,
    action     TEXT NOT NULL,
    detail     TEXT,
    created_at INTEGER NOT NULL
);
