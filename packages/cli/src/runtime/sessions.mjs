// Session store: `<userDir>/sessions/<repoDir>/<sessionId>/{session.json,events.jsonl,run.lock}`.
//
// A session is a record that ties a repository workspace (and optionally a worktree and a run) to a title and a set of
// checkpoints. NOTHING here starts a model, a run or a process: it only stores and validates state.
//
// Durability follows the run ledger: events.jsonl is append-only and written FIRST, session.json is the latest snapshot and
// is rewritten atomically afterwards (`lastSeq` = the last event it includes). A crash in between leaves events past the
// snapshot; loading folds them in memory (`behind`) and the next write persists them. Every mutating event carries what it
// changed (`patch`, `checkpoint`, or a whole `record` for created/migrated), so a lost or corrupt snapshot is rebuilt from
// the log. A torn final log line is ignored on read and cut off under the lock before the next append.
//
// Writers take a per-session lock (lock.mjs primitives; the lock file lives inside the session directory) and wait a bounded
// time for a live holder, so two simultaneous fork/archive calls serialise instead of failing or interleaving.
//
// Schema: v2 is current. v1 (id, repoKey, workspace, createdAt, runId; no schemaVersion) is migrated on load: a `.bak-v1`
// copy of the original is kept once, the snapshot is rewritten, nothing is deleted. A newer schema is a read-only error.

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { resolveUserDir } from "../paths.mjs";
import { redactDeep, redactText, sanitizeForTerminal } from "../redact.mjs";
import { parseJsonText, StoreError, writeJsonAtomic } from "../store.mjs";
import { repoDirName } from "./ledger.mjs";
import { acquireRunLock } from "./lock.mjs";

export const SESSION_SCHEMA_VERSION = 2;
export const SESSION_FILE = "session.json";
export const EVENTS_FILE = "events.jsonl";
export const SESSIONS_DIR_NAME = "sessions";
export const MIN_ID_PREFIX = 6;
export const TITLE_MAX = 120;

export const EVENT_VERSION = 1;
const DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EVENT_TYPE = /^[a-z][a-z0-9.-]{0,63}$/;
const RESERVED_EVENT_KEYS = new Set(["v", "seq", "at", "sessionId"]);
const PATCH_KEYS = ["status", "archivedAt", "runId", "node", "title", "goal", "providerSessionId", "usage"];
const USAGE_KEYS = ["tokens", "inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"];
const LIST_DEFAULT = 100;
const LIST_MAX = 1000;
const SEARCH_DEFAULT = 50;
const SEARCH_MAX = 200;
const SCAN_MAX = 2000;
const LOCK_WAIT_MS = 5000;
// Critical sections are short synchronous file operations (a few small writes); the event loop is blocked while they run, so a
// heartbeat timer could not fire anyway. The lock is therefore not heartbeated: it is simply treated as stale only after
// 5 minutes (or at once when its owner process on this host is dead), far longer than any section can take.
const LOCK_STALE_MS = 300_000;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const isoNow = () => new Date().toISOString();
export const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const fsOf = (options) => options?.fs ?? nodeFs;
export const foldCase = (options) => ((options?.platform ?? process.platform) === "win32" ? (value) => String(value).toLowerCase() : (value) => String(value));

function sessionError(message, code, remediation, exitCode = EXIT.ERROR) {
  return new CliError(message, { code, exitCode, remediation });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Locations ----------------------------------------------------------------------------------------

/** `<userDir>/sessions`. `options.userDir` overrides the user directory (test seam). */
export function sessionsRoot(options) {
  const p = (options?.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  return p.join(options?.userDir ?? resolveUserDir(options), SESSIONS_DIR_NAME);
}

/** `<userDir>/sessions/<repoDir>`. */
export function repoSessionsDir(repoKey, options) {
  return path.join(sessionsRoot(options), repoDirName(repoKey));
}

export function isValidSessionId(id) {
  return typeof id === "string" && DIR_NAME.test(id);
}

/** `<userDir>/sessions/<repoDir>/<sessionId>`. */
export function sessionDir(repoKey, id, options) {
  if (!isValidSessionId(id)) throw new UsageError("Invalid session id.", { code: "SESSION_ID_INVALID", remediation: "Session ids look like s_0123456789abcdef; list them with `asterweave session list`." });
  return path.join(repoSessionsDir(repoKey, options), id);
}

const newId = () => `s_${randomBytes(8).toString("hex")}`;

// Normalisation ------------------------------------------------------------------------------------

const clip = (value, limit) => {
  const text = String(value);
  return text.length > limit ? text.slice(0, limit) : text;
};
const strOrNull = (value, limit) => (typeof value === "string" && value !== "" ? clip(redactText(value).text, limit) : null);

/** A title safe to store and print: secrets redacted, controls neutralised, whitespace collapsed, at most 120 characters. */
export function cleanTitle(text) {
  return clip(sanitizeForTerminal(redactText(String(text ?? "")).text).replace(/\s+/g, " ").trim(), TITLE_MAX);
}

function normalizeCheckpoint(raw) {
  if (!isObject(raw)) return null;
  return {
    at: strOrNull(raw.at, 40),
    runId: strOrNull(raw.runId, 64),
    node: strOrNull(raw.node, 64),
    seq: Number.isInteger(raw.seq) && raw.seq >= 0 ? raw.seq : null,
    note: strOrNull(sanitizeForTerminal(raw.note ?? ""), 300),
  };
}

function normalizeWorktree(raw) {
  if (!isObject(raw) || typeof raw.path !== "string" || raw.path === "") return null;
  return { path: clip(raw.path, 4096), branch: strOrNull(raw.branch, 200), base: strOrNull(raw.base, 200), created: raw.created === true };
}

function normalizeUsage(raw) {
  const usage = {};
  for (const key of USAGE_KEYS) usage[key] = isObject(raw) && typeof raw[key] === "number" && Number.isFinite(raw[key]) ? raw[key] : null;
  return usage;
}

/** Validate and complete a v2 record. Returns null when the essentials (id, repoKey) are missing. */
function normalizeV2(raw) {
  if (!isObject(raw) || !isValidSessionId(raw.id) || typeof raw.repoKey !== "string" || raw.repoKey === "") return null;
  return {
    schemaVersion: SESSION_SCHEMA_VERSION,
    id: raw.id,
    repoKey: raw.repoKey,
    workspace: typeof raw.workspace === "string" ? clip(raw.workspace, 4096) : "",
    branch: strOrNull(raw.branch, 200),
    worktree: normalizeWorktree(raw.worktree),
    providerSessionId: strOrNull(raw.providerSessionId, 200),
    runId: strOrNull(raw.runId, 64),
    node: strOrNull(raw.node, 64),
    parentSessionId: strOrNull(raw.parentSessionId, 64),
    goal: strOrNull(raw.goal, 400),
    title: cleanTitle(raw.title),
    status: raw.status === "archived" ? "archived" : "active",
    checkpoints: Array.isArray(raw.checkpoints) ? raw.checkpoints.map(normalizeCheckpoint).filter(Boolean) : [],
    approvals: Array.isArray(raw.approvals)
      ? raw.approvals.filter((a) => isObject(a) && typeof a.id === "string").map((a) => ({ id: clip(a.id, 64), kind: strOrNull(a.kind, 64), subject: strOrNull(a.subject, 16), at: strOrNull(a.at, 40) }))
      : [],
    usage: normalizeUsage(raw.usage),
    createdAt: strOrNull(raw.createdAt, 40),
    updatedAt: strOrNull(raw.updatedAt, 40),
    archivedAt: strOrNull(raw.archivedAt, 40),
    lastSeq: Number.isInteger(raw.lastSeq) && raw.lastSeq >= 0 ? raw.lastSeq : 0,
  };
}

/** v1 (id, repoKey, workspace, createdAt, runId) to v2. The directory name is the id. */
function migrateV1(raw, id) {
  if (!isObject(raw) || typeof raw.repoKey !== "string" || raw.repoKey === "") return null;
  return normalizeV2({ ...raw, id, schemaVersion: SESSION_SCHEMA_VERSION, updatedAt: raw.updatedAt ?? raw.createdAt, lastSeq: 0 });
}

// Bounded reads -------------------------------------------------------------------------------------

/** Read at most `limit` bytes of a file: a Buffer, null when it does not exist, or `{tooLarge: true}` (never loaded whole). */
function readCapped(fs, file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw sessionError(`Cannot read ${file}: ${error?.message ?? error}`, "SESSION_UNREADABLE", "Check file permissions.");
  }
  try {
    if (fs.fstatSync(fd).size > limit) return { tooLarge: true };
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, limit) + 1);
    let got = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, got, buffer.length - got, got);
      if (read === 0) break;
      got += read;
      if (got > limit) return { tooLarge: true };
    }
    return buffer.subarray(0, got);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw sessionError(`Cannot read ${file}: ${error?.message ?? error}`, "SESSION_UNREADABLE", "Check file permissions.");
  } finally {
    fs.closeSync(fd);
  }
}

// Events -------------------------------------------------------------------------------------------

/** Complete lines parsed; invalid or out-of-shape lines are skipped (counted). A final unterminated fragment is `torn`. */
function readEvents(file, fs, limit = MAX_FILE_BYTES) {
  const buffer = readCapped(fs, file, limit);
  if (buffer === null) return { events: [], torn: false, validBytes: 0, skipped: 0, lastSeq: 0 };
  if (buffer.tooLarge) throw sessionError(`${path.basename(file)} is larger than ${Math.round(limit / 1048576)} MiB, so it was not read.`, "SESSION_TOO_LARGE", "The file was left untouched; inspect or remove the session directory by hand.");
  const validBytes = buffer.lastIndexOf(0x0a) + 1;
  const lines = buffer.subarray(0, validBytes).toString("utf8").split("\n");
  lines.pop();
  const events = [];
  let skipped = 0;
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const event = JSON.parse(line);
      if (isObject(event) && Number.isInteger(event.seq) && event.seq >= 1 && typeof event.type === "string") {
        events.push(event);
        continue;
      }
    } catch {
      // counted below
    }
    skipped += 1;
  }
  return { events, torn: validBytes < buffer.length, validBytes, skipped, lastSeq: events.reduce((max, event) => Math.max(max, event.seq), 0) };
}

/** The one place an event changes a record: used live (after the append) and when folding events past the snapshot. */
function applyEvent(record, event) {
  let next = record === null ? null : { ...record };
  if ((event.type === "created" || event.type === "migrated") && isObject(event.record)) next = normalizeV2(event.record) ?? next;
  else if (next === null) return null;
  else if (event.type === "checkpoint" && isObject(event.checkpoint)) next.checkpoints = [...next.checkpoints, normalizeCheckpoint(event.checkpoint)].filter(Boolean);
  else if (isObject(event.patch)) {
    for (const key of PATCH_KEYS) if (Object.hasOwn(event.patch, key)) next[key] = event.patch[key];
    next = normalizeV2({ ...next, id: record.id, repoKey: record.repoKey }) ?? record;
  }
  if (next === null) return null;
  next.lastSeq = event.seq;
  next.updatedAt = typeof event.at === "string" ? event.at : next.updatedAt;
  return next;
}

/** Append one event (the caller holds the session lock). Cuts a torn tail first. */
function appendEventLine(dir, rec, options) {
  const fs = fsOf(options);
  if (!isObject(rec) || typeof rec.type !== "string" || !EVENT_TYPE.test(rec.type)) throw new TypeError("An event needs a `type` like 'archived'.");
  const file = path.join(dir, EVENTS_FILE);
  const log = readEvents(file, fs, options.maxFileBytes);
  if (log.torn) {
    const fd = fs.openSync(file, "r+");
    try {
      fs.ftruncateSync(fd, log.validBytes);
    } finally {
      fs.closeSync(fd);
    }
  }
  const at = options.at ?? (options.now ?? isoNow)();
  const rest = Object.fromEntries(Object.entries(redactDeep(rec).value).filter(([key]) => !RESERVED_EVENT_KEYS.has(key)));
  const event = { v: EVENT_VERSION, seq: log.lastSeq + 1, at, sessionId: path.basename(dir), ...rest };
  const fd = fs.openSync(file, "a", 0o600);
  try {
    const bytes = Buffer.from(`${stringifyJson(event)}\n`, "utf8");
    for (let written = 0; written < bytes.length; ) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
  return event;
}

/** Event first, snapshot second. Returns the new record. */
function commit(dir, record, rec, options) {
  const event = appendEventLine(dir, rec, options);
  const next = applyEvent(record, event);
  writeJsonAtomic(path.join(dir, SESSION_FILE), next, { fs: fsOf(options) });
  return next;
}

// Locking ------------------------------------------------------------------------------------------

/** Run `work` while holding the session lock; a live holder is waited for (bounded), a stale one is taken over. */
export function withSessionLock(dir, options, work) {
  const fs = fsOf(options);
  const deadline = Date.now() + (options.lockWaitMs ?? LOCK_WAIT_MS);
  for (;;) {
    let lock;
    try {
      lock = acquireRunLock(dir, { fs, staleMs: LOCK_STALE_MS, ...(options.lock ?? {}) });
    } catch (error) {
      if (error?.code === "RUN_LOCKED" && Date.now() < deadline) {
        sleepSync(15);
        continue;
      }
      if (typeof error?.code === "string" && error.code.startsWith("RUN_LOCK")) {
        throw sessionError("This session is being changed by another Asterweave process.", "SESSION_LOCKED", "Retry in a moment; a lock left by a dead process is taken over automatically.");
      }
      throw error;
    }
    try {
      return work();
    } finally {
      lock.release();
    }
  }
}

// Reading ------------------------------------------------------------------------------------------

/**
 * Pure read of one session directory. `repair` says what a writer should do: null, "legacy" (v1 migration), "corrupt"
 * (quarantine the snapshot, rebuilt from the log) or "missing" (snapshot lost, rebuilt from the log).
 */
export function inspectDir(dir, id, options) {
  const fs = fsOf(options);
  const file = path.join(dir, SESSION_FILE);
  const limit = options.maxFileBytes ?? MAX_FILE_BYTES;
  const bytes = readCapped(fs, file, limit);
  const oversize = bytes !== null && bytes.tooLarge === true;
  const text = bytes === null || oversize ? null : bytes.toString("utf8");
  const log = readEvents(path.join(dir, EVENTS_FILE), fs, limit);
  const notes = [];
  if (log.skipped > 0) notes.push(`${log.skipped} unreadable event line(s) were ignored`);

  let raw = null;
  let broken = oversize ? "corrupt" : text === null ? "missing" : null;
  if (text !== null) {
    try {
      raw = parseJsonText(text, file, undefined);
    } catch (error) {
      if (!(error instanceof StoreError)) throw error;
    }
    if (!isObject(raw)) broken = "corrupt";
  }

  if (!broken) {
    const version = raw.schemaVersion ?? raw.v ?? 1;
    if (!Number.isInteger(version) || version < 1) broken = "corrupt";
    else if (version > SESSION_SCHEMA_VERSION) {
      throw sessionError(`Session ${id} was written by a newer asterweave (session schema v${version}; this version supports up to v${SESSION_SCHEMA_VERSION}).`, "SESSION_SCHEMA_TOO_NEW", "Upgrade Asterweave to open this session. It was left untouched.");
    } else if (version < SESSION_SCHEMA_VERSION) {
      const record = migrateV1(raw, id);
      if (record === null) broken = "corrupt";
      else {
        record.lastSeq = log.lastSeq;
        notes.push(`migrated from session schema v${version}`);
        return { record, behind: 0, torn: log.torn, notes, repair: "legacy", legacyVersion: version, eventCount: log.events.length };
      }
    } else {
      const record = normalizeV2(raw);
      if (record === null || record.id !== id) broken = "corrupt";
      else {
        const pending = log.events.filter((event) => event.seq > record.lastSeq).sort((a, b) => a.seq - b.seq);
        let folded = record;
        for (const event of pending) folded = applyEvent(folded, event) ?? folded;
        if (pending.length > 0) notes.push(`${pending.length} event(s) were not yet in the snapshot`);
        return { record: folded, behind: pending.length, torn: log.torn, notes, repair: null, eventCount: log.events.length };
      }
    }
  }

  // The snapshot is missing or unusable: rebuild from the log when it holds a created/migrated record.
  const ordered = [...log.events].sort((a, b) => a.seq - b.seq);
  const start = ordered.findLastIndex((event) => (event.type === "created" || event.type === "migrated") && normalizeV2(event.record)?.id === id);
  if (start < 0) {
    if (broken === "missing" && log.events.length === 0) throw sessionError(`No session found at ${path.basename(dir)}.`, "SESSION_NOT_FOUND", "List sessions with `asterweave session list --all`.");
    throw sessionError(`The snapshot of session ${id} is ${broken === "missing" ? "missing" : "unreadable"} and its event log has no record to rebuild it from.`, "SESSION_CORRUPT", "The directory was left as it is; inspect it or remove it by hand.");
  }
  let rebuilt = null;
  for (const event of ordered.slice(start)) rebuilt = applyEvent(rebuilt, event) ?? rebuilt;
  notes.push(`rebuilt from events.jsonl (snapshot ${broken})`);
  return { record: rebuilt, behind: ordered.length - start, torn: log.torn, notes, repair: broken, eventCount: log.events.length };
}

export function listDirNames(repoKey, options) {
  const base = repoSessionsDir(repoKey, options);
  try {
    return fsOf(options).readdirSync(base, { withFileTypes: true }).filter((entry) => entry.isDirectory() && DIR_NAME.test(entry.name)).map((entry) => entry.name);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

/** An exact id, or a unique prefix of at least 6 characters. */
export function resolveSessionId(repoKey, input, options = {}) {
  const text = typeof input === "string" ? input : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(text)) throw new UsageError("Missing or invalid session id.", { code: "SESSION_ID_INVALID", remediation: "Pass a session id (or a unique prefix of at least 6 characters) from `asterweave session list`." });
  const names = listDirNames(repoKey, options);
  if (names.includes(text)) return text;
  if (text.length < MIN_ID_PREFIX) throw new UsageError(`A session id prefix needs at least ${MIN_ID_PREFIX} characters.`, { code: "SESSION_ID_INVALID", remediation: "Pass more of the id; see `asterweave session list`." });
  const matches = names.filter((name) => name.startsWith(text)).sort();
  if (matches.length === 0) throw sessionError(`No session '${text}' in this repository.`, "SESSION_NOT_FOUND", "Sessions are kept per repository; run this from inside the repository and check `asterweave session list --all`.");
  if (matches.length > 1) throw new UsageError(`'${text}' matches ${matches.length} sessions: ${matches.slice(0, 5).join(", ")}${matches.length > 5 ? ", ..." : ""}.`, { code: "SESSION_AMBIGUOUS", remediation: "Pass more characters of the id." });
  return matches[0];
}

/** Apply the repair `state` asks for. The caller holds the session lock. */
function repairLocked(dir, state, options) {
  const fs = fsOf(options);
  const file = path.join(dir, SESSION_FILE);
  const at = (options.now ?? isoNow)();
  if (state.repair === "legacy") {
    try {
      fs.copyFileSync(file, `${file}.bak-v${state.legacyVersion}`, nodeFs.constants.COPYFILE_EXCL);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const record = commit(dir, state.record, { type: "migrated", from: state.legacyVersion, to: SESSION_SCHEMA_VERSION, record: state.record }, { ...options, at });
    return { ...state, record, repair: null };
  }
  let quarantined = null;
  if (state.repair === "corrupt") {
    quarantined = `${SESSION_FILE}.corrupt-${at.replace(/[^0-9A-Za-z]/g, "-")}`;
    fs.renameSync(file, path.join(dir, quarantined));
  }
  const record = commit(dir, state.record, { type: "repaired", reason: `snapshot-${state.repair}`, quarantined }, { ...options, at });
  return { ...state, record, repair: null, quarantined, notes: [...state.notes, ...(quarantined ? [`the unreadable snapshot was kept as ${quarantined}`] : [])] };
}

function persistRepair(dir, id, options) {
  return withSessionLock(dir, options, () => {
    const state = inspectDir(dir, id, options);
    return state.repair === null ? state : repairLocked(dir, state, options);
  });
}

/**
 * Load one session by id or unique prefix. A v1 record is migrated (backup kept), a lost or corrupt snapshot is rebuilt from
 * the event log (the corrupt file is kept as `session.json.corrupt-<time>`), events past the snapshot are folded.
 * `options.repair === false` makes the call strictly read-only.
 * @returns {{session: object, dir: string, behind: number, torn: boolean, notes: string[], quarantined?: string}}
 */
export function loadSession(repoKey, idOrPrefix, options = {}) {
  return loadResolved(repoKey, resolveSessionId(repoKey, idOrPrefix, options), options);
}

/** loadSession for an id that is already resolved (no directory listing). */
function loadResolved(repoKey, id, options) {
  const dir = sessionDir(repoKey, id, options);
  let state = inspectDir(dir, id, options);
  if (state.repair !== null && options.repair !== false) {
    try {
      state = persistRepair(dir, id, options);
    } catch (error) {
      if (error?.code !== "SESSION_LOCKED") throw error;
      state.notes.push("repair deferred: the session is locked");
    }
  }
  return { session: state.record, dir, behind: state.behind, torn: state.torn, notes: state.notes, ...(state.quarantined ? { quarantined: state.quarantined } : {}) };
}

/** What `list` and `search` show for one session. */
export function summarizeSession(record) {
  return {
    id: record.id,
    title: record.title,
    status: record.status,
    branch: record.branch,
    runId: record.runId,
    node: record.node,
    parentSessionId: record.parentSessionId,
    worktree: record.worktree === null ? null : record.worktree.path,
    checkpoints: record.checkpoints.length,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archivedAt: record.archivedAt,
  };
}

export const stamp = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
};
const newestFirst = (a, b) => stamp(b.createdAt) - stamp(a.createdAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export function readAll(repoKey, options) {
  const sessions = [];
  const problems = [];
  for (const name of listDirNames(repoKey, options).slice(0, SCAN_MAX)) {
    try {
      sessions.push(loadResolved(repoKey, name, options));
    } catch (error) {
      problems.push({ id: name, error: error?.code ?? "SESSION_UNREADABLE", message: sanitizeForTerminal(String(error?.message ?? "")).slice(0, 200) });
    }
  }
  return { sessions, problems };
}

/**
 * Sessions of one repository, newest first. A session that cannot be read is reported in `problems` (never fails the listing).
 * @param {string} repoKey
 * @param {{status?: "active"|"archived", limit?: number} & object} [options]
 * @returns {{sessions: object[], problems: object[], truncated: boolean}}
 */
export function listSessions(repoKey, options = {}) {
  const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : LIST_DEFAULT, 1), LIST_MAX);
  const { sessions, problems } = readAll(repoKey, options);
  const rows = sessions.map((loaded) => loaded.session).filter((record) => options.status === undefined || record.status === options.status).map(summarizeSession).sort(newestFirst);
  return { sessions: rows.slice(0, limit), problems, truncated: rows.length > limit };
}

/** Case-insensitive substring search over title, branch, goal, run id and id. The query is never a pattern. */
export function searchSessions(repoKey, query, options = {}) {
  const needle = String(query ?? "").trim().toLowerCase();
  if (needle === "" || needle.length > 200) throw new UsageError("Search text must be 1 to 200 characters.", { code: "SESSION_QUERY_INVALID", remediation: "Usage: asterweave session search <text>" });
  const limit = Math.min(Math.max(Number.isInteger(options.limit) ? options.limit : SEARCH_DEFAULT, 1), SEARCH_MAX);
  const { sessions } = readAll(repoKey, options);
  const hits = [];
  for (const { session } of sessions) {
    const matched = ["title", "branch", "goal", "runId", "id"].filter((field) => typeof session[field] === "string" && session[field].toLowerCase().includes(needle));
    if (matched.length > 0) hits.push({ ...summarizeSession(session), matched });
  }
  hits.sort(newestFirst);
  return { query: clip(needle, 200), results: hits.slice(0, limit), truncated: hits.length > limit };
}

// Writing ------------------------------------------------------------------------------------------

/**
 * Create a session record (no runner is started). Events first (`created` carries the whole record), snapshot second.
 * @param {{repoKey: string, workspace: string, branch?: string|null, worktree?: object|null, title?: string, goal?: string|null,
 *   runId?: string|null, node?: string|null, parentSessionId?: string|null, checkpoints?: object[], fromCheckpoint?: object|null}} input
 * @returns {{session: object, dir: string}}
 */
export function createSession(input, options = {}) {
  const fs = fsOf(options);
  if (!isObject(input) || typeof input.repoKey !== "string" || input.repoKey === "" || typeof input.workspace !== "string" || input.workspace === "") {
    throw new TypeError("createSession needs repoKey and workspace.");
  }
  const base = repoSessionsDir(input.repoKey, options);
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  let id;
  let dir;
  for (let attempt = 0; ; attempt += 1) {
    id = newId();
    dir = path.join(base, id);
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt >= 5) throw sessionError(`Cannot create ${dir}: ${error?.message ?? error}`, "SESSION_CREATE_FAILED", "Check that the Asterweave user directory is writable.");
    }
  }
  const at = (options.now ?? isoNow)();
  const record = normalizeV2({
    ...input,
    id,
    schemaVersion: SESSION_SCHEMA_VERSION,
    status: "active",
    providerSessionId: null,
    approvals: [],
    usage: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    lastSeq: 0,
  });
  const session = commit(dir, null, { type: "created", record, ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}), ...(input.fromCheckpoint ? { fromCheckpoint: input.fromCheckpoint } : {}), ...(input.forkedFromBranch ? { forkedFromBranch: input.forkedFromBranch } : {}) }, { ...options, at });
  return { session, dir };
}

function mutate(repoKey, idOrPrefix, options, work) {
  const id = resolveSessionId(repoKey, idOrPrefix, options);
  const dir = sessionDir(repoKey, id, options);
  return withSessionLock(dir, options, () => {
    let state = inspectDir(dir, id, options);
    if (state.repair !== null) state = repairLocked(dir, state, options);
    return work({ dir, record: state.record, id });
  });
}

/** Archive a session (idempotent). `changed` tells whether this call did it. */
export function archiveSession(repoKey, idOrPrefix, options = {}) {
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => {
    if (record.status === "archived") return { session: record, changed: false };
    const at = (options.now ?? isoNow)();
    return { session: commit(dir, record, { type: "archived", patch: { status: "archived", archivedAt: at } }, { ...options, at }), changed: true };
  });
}

/** Record a checkpoint (a run position the session can come back to). */
export function addCheckpoint(repoKey, idOrPrefix, checkpoint, options = {}) {
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => {
    const at = (options.now ?? isoNow)();
    const cp = normalizeCheckpoint({ ...checkpoint, at });
    return { session: commit(dir, record, { type: "checkpoint", checkpoint: cp }, { ...options, at }) };
  });
}

/** Point the session at a run (and its current node). */
export function linkRun(repoKey, idOrPrefix, link, options = {}) {
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => {
    const patch = { runId: link.runId ?? null, node: link.node ?? null };
    if (typeof link.goal === "string") patch.goal = link.goal;
    return { session: commit(dir, record, { type: "run-linked", patch }, options) };
  });
}

/** Record the provider (claude) session id of the runner on the session, so a later turn can resume it. Idempotent. */
export function setProviderSession(repoKey, idOrPrefix, providerSessionId, options = {}) {
  if (typeof providerSessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/.test(providerSessionId)) throw new TypeError("providerSessionId is not a valid provider session id.");
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => {
    if (record.providerSessionId === providerSessionId) return { session: record, changed: false };
    return { session: commit(dir, record, { type: "provider-session", patch: { providerSessionId } }, options), changed: true };
  });
}

/** Audit event: a resume was planned and found ready. The session is not otherwise changed. */
export function markResumed(repoKey, idOrPrefix, options = {}) {
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => ({ session: commit(dir, record, { type: "resumed", planned: true }, options) }));
}

/**
 * Fork a session: a new active session with a new id, `parentSessionId` set, and the checkpoints up to the last verified one.
 * `options.verified(checkpoint)` decides what is verified (default: has a run id and a sequence number). The provider session id
 * is NOT copied, and neither are the run link or the worktree: the runner forks those later.
 */
export function forkSession(repoKey, idOrPrefix, options = {}) {
  const verified = options.verified ?? ((cp) => cp.runId !== null && cp.seq !== null);
  return mutate(repoKey, idOrPrefix, options, ({ dir, record }) => {
    let last = -1;
    record.checkpoints.forEach((cp, index) => {
      if (verified(cp)) last = index;
    });
    const kept = record.checkpoints.slice(0, last + 1);
    const child = createSession(
      {
        repoKey: record.repoKey,
        workspace: record.workspace,
        // A worktree's branch is checked out THERE, so a fork (which gets no worktree) cannot be expected to sit on it:
        // the branch is not inherited as a resume expectation and is kept only in the created event.
        branch: record.worktree === null ? record.branch : null,
        forkedFromBranch: record.worktree === null ? null : record.worktree.branch ?? record.branch,
        title: options.title === undefined ? `Fork of ${record.title || record.id}` : options.title,
        goal: record.goal,
        parentSessionId: record.id,
        checkpoints: kept,
        fromCheckpoint: kept.at(-1) ?? null,
      },
      options,
    );
    const parent = commit(dir, record, { type: "forked", childId: child.session.id, keptCheckpoints: kept.length }, options);
    return { session: child.session, parent, keptCheckpoints: kept.length };
  });
}
