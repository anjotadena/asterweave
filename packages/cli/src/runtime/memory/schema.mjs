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

const V2_UP = `
-- M2: the live pipeline. Sessions remember the file session they belong to (a file session spans many runs; a memory session is
-- one run: task_id = runId), the branch and the worktree. A checkpoint carries the session summary (with its own coverage
-- watermark) and an integrity digest. Traces name the run/request they were written for. A content-free version counter in meta
-- moves on every change that can alter what retrieval may return (the context cache is keyed by it).
ALTER TABLE sessions ADD COLUMN external_session_id TEXT;
ALTER TABLE sessions ADD COLUMN branch TEXT;
ALTER TABLE sessions ADD COLUMN worktree_id TEXT;
CREATE INDEX sessions_external ON sessions(external_session_id);
ALTER TABLE checkpoints ADD COLUMN summary TEXT;
ALTER TABLE checkpoints ADD COLUMN summary_covered_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE checkpoints ADD COLUMN digest TEXT;
ALTER TABLE retrieval_traces ADD COLUMN run_id TEXT;
ALTER TABLE retrieval_traces ADD COLUMN node TEXT;
ALTER TABLE retrieval_traces ADD COLUMN attempt INTEGER;
ALTER TABLE retrieval_traces ADD COLUMN memory_tokens INTEGER;
ALTER TABLE retrieval_traces ADD COLUMN estimated INTEGER NOT NULL DEFAULT 1;
ALTER TABLE retrieval_traces ADD COLUMN cache_hit INTEGER NOT NULL DEFAULT 0;
ALTER TABLE retrieval_traces ADD COLUMN stats TEXT;
CREATE INDEX retrieval_traces_run ON retrieval_traces(run_id);
INSERT OR IGNORE INTO meta (key, value) VALUES ('memory_version', '0');
CREATE TRIGGER mv_items_ai AFTER INSERT ON memory_items BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_items_au AFTER UPDATE ON memory_items BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_items_ad AFTER DELETE ON memory_items BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_events_ad AFTER DELETE ON events BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_sessions_au AFTER UPDATE OF visibility, state ON sessions BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_sessions_ad AFTER DELETE ON sessions BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_checkpoints_ad AFTER DELETE ON checkpoints BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
CREATE TRIGGER mv_tombstones_ai AFTER INSERT ON tombstones BEGIN UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'memory_version'; END;
`;

const V2_DOWN = `
DROP TRIGGER IF EXISTS mv_tombstones_ai;
DROP TRIGGER IF EXISTS mv_checkpoints_ad;
DROP TRIGGER IF EXISTS mv_sessions_ad;
DROP TRIGGER IF EXISTS mv_sessions_au;
DROP TRIGGER IF EXISTS mv_events_ad;
DROP TRIGGER IF EXISTS mv_items_ad;
DROP TRIGGER IF EXISTS mv_items_au;
DROP TRIGGER IF EXISTS mv_items_ai;
DELETE FROM meta WHERE key = 'memory_version';
DROP INDEX IF EXISTS retrieval_traces_run;
ALTER TABLE retrieval_traces DROP COLUMN stats;
ALTER TABLE retrieval_traces DROP COLUMN cache_hit;
ALTER TABLE retrieval_traces DROP COLUMN estimated;
ALTER TABLE retrieval_traces DROP COLUMN memory_tokens;
ALTER TABLE retrieval_traces DROP COLUMN attempt;
ALTER TABLE retrieval_traces DROP COLUMN node;
ALTER TABLE retrieval_traces DROP COLUMN run_id;
ALTER TABLE checkpoints DROP COLUMN digest;
ALTER TABLE checkpoints DROP COLUMN summary_covered_seq;
ALTER TABLE checkpoints DROP COLUMN summary;
DROP INDEX IF EXISTS sessions_external;
ALTER TABLE sessions DROP COLUMN worktree_id;
ALTER TABLE sessions DROP COLUMN branch;
ALTER TABLE sessions DROP COLUMN external_session_id;
`;

const V3_UP = `
-- M3: the opt-in Claude Code transcript import (claude-import.mjs). One row per transcript file: how far it was read (a byte
-- offset that always ends on a complete line), the size and mtime seen then, and the last record uuid with the offset where its
-- line starts, so a rotated, truncated or compacted file is detected and rescanned. Paths only: no transcript content.
CREATE TABLE claude_import_files (
  path              TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL,
  size              INTEGER NOT NULL,
  offset            INTEGER NOT NULL,
  last_uuid         TEXT,
  last_uuid_offset  INTEGER,
  mtime             TEXT,
  imported_at       TEXT NOT NULL,
  rescans           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX claude_import_files_repo ON claude_import_files(repo_id);
`;

const V3_DOWN = `
DELETE FROM meta WHERE key = 'claude_import_last_at';
DROP INDEX IF EXISTS claude_import_files_repo;
DROP TABLE IF EXISTS claude_import_files;
`;

// V4: a clone without a remote is identified by its path only, so a different repository at a reused path (rm -rf + git init, a
// reused folder) would inherit the old memory. The ANCHOR is something intrinsic recorded at bind time (identity.mjs): the root
// commit(s) (`git:<sha>,...`), `unborn` before the first commit, or `dir:<ino>:<birthtime>` outside git. NULL = recorded before V4.
// An ambiguity raised by an anchor mismatch keeps `observed = '<none>'` and names the anchor seen in `observed_anchor`.
const V4_UP = `
ALTER TABLE repo_clones ADD COLUMN anchor TEXT;
ALTER TABLE repo_ambiguities ADD COLUMN observed_anchor TEXT;
`;

const V4_DOWN = `
ALTER TABLE repo_ambiguities DROP COLUMN observed_anchor;
ALTER TABLE repo_clones DROP COLUMN anchor;
`;

/** @type {ReadonlyArray<{version: number, name: string, up: string, down: string}>} */
export const MIGRATIONS = Object.freeze([
  { version: 1, name: "initial memory schema", up: V1_UP, down: V1_DOWN },
  { version: 2, name: "live pipeline: session links, summaries, trace detail, memory version", up: V2_UP, down: V2_DOWN },
  { version: 3, name: "Claude Code import watermarks", up: V3_UP, down: V3_DOWN },
  { version: 4, name: "clone anchors: intrinsic identity of a clone without a remote", up: V4_UP, down: V4_DOWN },
]);

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;
