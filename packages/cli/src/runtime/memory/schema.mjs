// Numbered, additive migrations of the memory database (PRAGMA user_version = the last applied number).
//
// Rules for adding one: append a new entry, never edit an applied one; `up` must only ADD (tables, columns, indexes) so an
// older build that meets the new schema is refused by version (MEMORY_SCHEMA_NEWER) instead of misreading it; `down` is the
// documented manual inverse. Each runs in a transaction together with its user_version bump (db.mjs: migrate / rollbackTo).
// `down` is DESTRUCTIVE (it drops what `up` made) and is deliberately not reachable from any command: it exists so the
// inverse is written down and tested, for a person restoring an older build.
//
// Time is stored as UTC ISO-8601 with milliseconds and a trailing Z ("2026-11-11T09:30:00.000Z"): that fixed shape sorts
// lexically, so every range and expiry test is a plain string comparison.

const V1_UP = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Repository identity: see identity.mjs. A repository is known by a canonical remote (or a random id when it has none);
-- clones and worktrees map to it by the git common directory, so a folder NAME never decides identity.
CREATE TABLE repos (
  id               TEXT PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('remote', 'local')),
  remote_canonical TEXT UNIQUE,
  created_at       TEXT NOT NULL
);
CREATE TABLE repo_aliases (
  alias    TEXT PRIMARY KEY,
  repo_id  TEXT NOT NULL REFERENCES repos(id),
  added_at TEXT NOT NULL,
  reason   TEXT
);
CREATE TABLE repo_clones (
  clone_key     TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repos(id),
  kind          TEXT NOT NULL CHECK (kind IN ('git-common-dir', 'directory')),
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE TABLE repo_ambiguities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  clone_key   TEXT NOT NULL,
  repo_id     TEXT NOT NULL REFERENCES repos(id),
  observed    TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution  TEXT CHECK (resolution IN ('same', 'new'))
);
CREATE INDEX repo_ambiguities_open ON repo_ambiguities(clone_key, resolved_at);

CREATE TABLE sessions (
  id               TEXT PRIMARY KEY,
  owner            TEXT NOT NULL,
  repo_id          TEXT NOT NULL REFERENCES repos(id),
  task_id          TEXT,
  visibility       TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  title            TEXT NOT NULL DEFAULT '',
  state            TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'archived')),
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  archived_at      TEXT,
  expires_at       TEXT NOT NULL,
  last_seq         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sessions_repo ON sessions(repo_id, owner);
CREATE INDEX sessions_expiry ON sessions(expires_at);

CREATE TABLE events (
  rid           INTEGER PRIMARY KEY AUTOINCREMENT,
  id            TEXT NOT NULL UNIQUE,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('message', 'tool_call', 'tool_result', 'system')),
  role          TEXT CHECK (role IN ('user', 'assistant', 'tool', 'system')),
  content       TEXT NOT NULL,
  agent_id      TEXT,
  model         TEXT,
  provider      TEXT,
  tool_call_id  TEXT,
  event_time    TEXT NOT NULL,
  ingested_at   TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'complete' CHECK (status IN ('complete', 'incomplete')),
  truncated     INTEGER NOT NULL DEFAULT 0,
  original_chars INTEGER,
  artifact_ref  TEXT,
  UNIQUE (session_id, seq)
);
CREATE INDEX events_expiry ON events(expires_at);
CREATE INDEX events_session_time ON events(session_id, event_time);
CREATE INDEX events_tool_call ON events(session_id, tool_call_id);

CREATE TABLE checkpoints (
  id                         INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id                 TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  version                    INTEGER NOT NULL,
  covered_seq                INTEGER NOT NULL,
  goal                       TEXT,
  decisions                  TEXT,
  completed_work             TEXT,
  blockers                   TEXT,
  next_action                TEXT,
  branch                     TEXT,
  head_commit                TEXT,
  worktree_id                TEXT,
  changed_files_fingerprint  TEXT,
  running_refs               TEXT,
  source_refs                TEXT,
  generation_meta            TEXT,
  created_at                 TEXT NOT NULL,
  expires_at                 TEXT NOT NULL,
  UNIQUE (session_id, version)
);
CREATE INDEX checkpoints_expiry ON checkpoints(expires_at);

CREATE TABLE memory_items (
  rid               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL UNIQUE,
  owner             TEXT NOT NULL,
  repo_id           TEXT REFERENCES repos(id),
  session_id        TEXT,
  visibility        TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'shared')),
  scope             TEXT NOT NULL CHECK (scope IN ('user', 'repository', 'session')),
  kind              TEXT NOT NULL CHECK (kind IN ('decision', 'requirement', 'constraint', 'preference', 'observation')),
  content           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'confirmed', 'disputed', 'superseded', 'deleted')),
  origin            TEXT NOT NULL CHECK (origin IN ('user_decision', 'assistant_suggestion', 'tool_observation')),
  confidence        REAL,
  source_event_ids  TEXT NOT NULL DEFAULT '[]',
  recorded_at       TEXT NOT NULL,
  effective_at      TEXT,
  last_verified_at  TEXT,
  expires_at        TEXT,
  supersedes        TEXT,
  replaced_by       TEXT,
  source_expired    INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL
);
CREATE INDEX memory_items_repo ON memory_items(repo_id, owner);
CREATE INDEX memory_items_expiry ON memory_items(expires_at);
CREATE TABLE item_sources (
  item_id  TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY (item_id, event_id)
);
CREATE INDEX item_sources_event ON item_sources(event_id);

-- Full-text indexes. Standalone FTS5 tables whose rowid is the owning row's rid; triggers keep them in step so no code path
-- can leave an indexed copy of deleted or rewritten text. 'secure-delete' makes FTS5 erase removed segment data.
CREATE VIRTUAL TABLE events_fts USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO events_fts(events_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
  INSERT INTO events_fts(rowid, content) VALUES (new.rid, new.content);
END;
CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.rid;
END;
CREATE TRIGGER events_au AFTER UPDATE OF content ON events BEGIN
  DELETE FROM events_fts WHERE rowid = old.rid;
  INSERT INTO events_fts(rowid, content) VALUES (new.rid, new.content);
END;
CREATE VIRTUAL TABLE items_fts USING fts5(content, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO items_fts(items_fts, rank) VALUES ('secure-delete', 1);
CREATE TRIGGER items_ai AFTER INSERT ON memory_items BEGIN
  INSERT INTO items_fts(rowid, content) VALUES (new.rid, new.content);
END;
CREATE TRIGGER items_ad AFTER DELETE ON memory_items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rid;
END;
CREATE TRIGGER items_au AFTER UPDATE OF content ON memory_items BEGIN
  DELETE FROM items_fts WHERE rowid = old.rid;
  INSERT INTO items_fts(rowid, content) VALUES (new.rid, new.content);
END;

-- Content-free: only a hash of the id and when it was deleted. Consulted before any insert so forgotten data cannot return.
CREATE TABLE tombstones (
  hash       TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('event', 'session', 'item')),
  deleted_at TEXT NOT NULL
);

-- What a retrieval chose and why. Ids and numbers only, never content.
CREATE TABLE retrieval_traces (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner          TEXT NOT NULL,
  repo_id        TEXT,
  session_id     TEXT,
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  selected_ids   TEXT NOT NULL DEFAULT '[]',
  rationale      TEXT NOT NULL DEFAULT '',
  token_estimate INTEGER,
  cache_state    TEXT,
  timing_ms      INTEGER
);
CREATE INDEX retrieval_traces_expiry ON retrieval_traces(expires_at);

CREATE TABLE maintenance_progress (
  task              TEXT PRIMARY KEY,
  cursor            TEXT,
  state             TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'partial')),
  rows_removed      INTEGER NOT NULL DEFAULT 0,
  updated_at        TEXT NOT NULL,
  last_completed_at TEXT
);
`;

const V1_DOWN = `
DROP TRIGGER IF EXISTS items_au;
DROP TRIGGER IF EXISTS items_ad;
DROP TRIGGER IF EXISTS items_ai;
DROP TRIGGER IF EXISTS events_au;
DROP TRIGGER IF EXISTS events_ad;
DROP TRIGGER IF EXISTS events_ai;
DROP TABLE IF EXISTS items_fts;
DROP TABLE IF EXISTS events_fts;
DROP TABLE IF EXISTS maintenance_progress;
DROP TABLE IF EXISTS retrieval_traces;
DROP TABLE IF EXISTS tombstones;
DROP TABLE IF EXISTS item_sources;
DROP TABLE IF EXISTS memory_items;
DROP TABLE IF EXISTS checkpoints;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS repo_ambiguities;
DROP TABLE IF EXISTS repo_clones;
DROP TABLE IF EXISTS repo_aliases;
DROP TABLE IF EXISTS repos;
DROP TABLE IF EXISTS meta;
`;

/** @type {ReadonlyArray<{version: number, name: string, up: string, down: string}>} */
export const MIGRATIONS = Object.freeze([{ version: 1, name: "initial memory schema", up: V1_UP, down: V1_DOWN }]);

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
