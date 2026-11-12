// The memory database: `<userDir>/memory/memory.db`, a SQLite file opened through Node's built-in `node:sqlite`.
//
// - NOT ENCRYPTED. The file is protected only by the directory/file mode (0700 / 0600 where the platform honours it; on
//   Windows the user-profile ACL is inherited and nothing here changes it). Anyone who can read the file can read the
//   (redacted) history.
// - `node:sqlite` is loaded lazily and synchronously on the first open, never at import time: the CLI imports every command
//   module up front and `engines` is `>=22`, where the module may be missing. Its ExperimentalWarning is suppressed for that
//   one load only. A failed load is a typed MEMORY_UNAVAILABLE error (capture turns it into a degraded result).
// - Concurrency is SQLite's: WAL journal, a busy timeout, and `BEGIN IMMEDIATE` for every write so two processes serialise.
// - `secure_delete` is ON and forget/maintenance finish with an FTS `optimize` and a WAL checkpoint(TRUNCATE), so deleted
//   text does not linger in the file or the -wal file (see `scrub`).
// - Every timestamp is UTC ISO-8601 with milliseconds (see schema.mjs); `toIso` accepts a Date, epoch milliseconds or a
//   parseable string, because `now` seams in this codebase return different shapes.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../../exit-codes.mjs";
import { resolveUserDir } from "../../paths.mjs";
import { sanitizeForTerminal } from "../../redact.mjs";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.mjs";

export const MEMORY_DIR_NAME = "memory";
export const MEMORY_DB_FILE = "memory.db";
const BUSY_TIMEOUT_MS = 5000;
const require = createRequire(import.meta.url);

/** The memory store cannot be used (no node:sqlite, or the file cannot be opened). Exit 1. */
export class MemoryError extends CliError {
  /** @param {string} message @param {{code?: string, remediation?: string, cause?: unknown, exitCode?: number}} [details] */
  constructor(message, { code = "MEMORY_UNAVAILABLE", remediation, cause, exitCode = EXIT.ERROR } = {}) {
    super(message, { code, exitCode, remediation, cause });
  }
}

// Time ---------------------------------------------------------------------------------------------

/** Normalise a Date, epoch milliseconds or date string to the canonical UTC ISO form. Throws TypeError when unparseable. */
export function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`Not a valid time: ${String(value).slice(0, 40)}`);
  return date.toISOString();
}

/** A function returning the current time as canonical ISO, from the `now` seam (any of the shapes) or the real clock. */
export function clockOf(options) {
  const now = options?.now;
  return () => toIso(typeof now === "function" ? now() : Date.now());
}

/** ISO time plus whole or fractional days (UTC arithmetic: no daylight-saving ambiguity). */
export function addDays(iso, days) {
  return new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
}

/**
 * The one predicate for "still readable at :now". `expires_at` NULL means durable (confirmed items), so the NULL branch must
 * never be forgotten; every read query composes this instead of writing `expires_at > ?` by hand.
 * @param {string} column  e.g. "e.expires_at"
 * @param {string} [param] the named parameter holding the current time
 */
export function notExpired(column, param = ":now") {
  return `(${column} IS NULL OR ${column} > ${param})`;
}

// Locations ----------------------------------------------------------------------------------------

/** `<userDir>/memory`. `options.userDir` overrides the user directory (test seam). */
export function memoryDir(options) {
  const p = (options?.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  return p.join(options?.userDir ?? resolveUserDir(options), MEMORY_DIR_NAME);
}

/** `<userDir>/memory/memory.db`. */
export function memoryDbPath(options) {
  const p = (options?.platform ?? process.platform) === "win32" ? path.win32 : path.posix;
  return p.join(memoryDir(options), MEMORY_DB_FILE);
}

// SQLite loading -----------------------------------------------------------------------------------

let cachedSqlite = null;

function loadSqlite(options) {
  if (typeof options?.loadSqlite === "function") return options.loadSqlite();
  if (cachedSqlite) return cachedSqlite;
  const original = process.emitWarning;
  // Filter ONLY the one experimental-feature warning of this load; every other warning passes through untouched.
  process.emitWarning = function emitWarning(warning, ...rest) {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    if (/sqlite/i.test(text) && /experimental/i.test(text)) return undefined;
    return original.call(process, warning, ...rest);
  };
  try {
    cachedSqlite = require("node:sqlite");
  } finally {
    process.emitWarning = original;
  }
  return cachedSqlite;
}

// Opening ------------------------------------------------------------------------------------------

/**
 * @typedef {object} Memory
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {string} path
 * @property {() => string} now   current time, canonical ISO
 * @property {() => void} close
 * @property {object} options
 */

function tightenPermissions(fs, target, mode, platform) {
  if (platform === "win32") return; // chmod only toggles the read-only bit there; the profile ACL is what protects the file
  try {
    fs.chmodSync(target, mode);
  } catch {
    // Not ours to change (e.g. a shared mount): leave it, the creation mode already applied where we created it.
  }
}

/**
 * Open (creating if needed) the memory database and bring its schema up to date.
 * With `create: false` a missing database yields `null` and nothing is created (read-only commands on a fresh machine).
 *
 * @param {{userDir?: string, env?: object, platform?: string, homedir?: Function, fs?: typeof nodeFs, now?: Function,
 *   create?: boolean, loadSqlite?: Function, migrations?: typeof MIGRATIONS}} [options]
 * @returns {Memory | null}
 * @throws {MemoryError} MEMORY_UNAVAILABLE, MEMORY_OPEN_FAILED or MEMORY_SCHEMA_NEWER
 */
export function openMemory(options = {}) {
  const fs = options.fs ?? nodeFs;
  const platform = options.platform ?? process.platform;
  const file = memoryDbPath(options);
  const create = options.create !== false;
  if (!create && !fs.existsSync(file)) return null;

  let sqlite;
  try {
    sqlite = loadSqlite(options);
    if (typeof sqlite?.DatabaseSync !== "function") throw new Error("node:sqlite has no DatabaseSync");
  } catch (error) {
    throw new MemoryError("The memory store needs Node's built-in SQLite (node:sqlite), which is not available in this Node.js.", {
      code: "MEMORY_UNAVAILABLE",
      remediation: "Upgrade to a current Node.js 22 release (22.13 or newer). Nothing else in Asterweave needs it.",
      cause: error,
    });
  }

  let db;
  try {
    if (create) {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      tightenPermissions(fs, path.dirname(file), 0o700, platform);
      if (!fs.existsSync(file)) fs.closeSync(fs.openSync(file, "a", 0o600)); // restrictive from the first byte
      tightenPermissions(fs, file, 0o600, platform);
    }
    db = new sqlite.DatabaseSync(file);
    // The live pipeline passes a short busy timeout (a synchronous wait blocks the event loop); maintenance commands keep the default.
    const busy = Number.isSafeInteger(options.busyTimeoutMs) && options.busyTimeoutMs >= 0 ? options.busyTimeoutMs : BUSY_TIMEOUT_MS;
    db.exec(`PRAGMA busy_timeout = ${busy}; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA synchronous = NORMAL;`);
    try {
      db.exec("PRAGMA journal_mode = WAL;");
    } catch {
      // A file system without shared memory (some network mounts) keeps the default rollback journal.
    }
    migrate(db, { migrations: options.migrations ?? MIGRATIONS });
  } catch (error) {
    try {
      db?.close();
    } catch {
      // already closed
    }
    if (error instanceof MemoryError) throw error;
    throw new MemoryError(`The memory database could not be opened: ${sanitizeForTerminal(error?.message ?? error).slice(0, 160)}`, {
      code: "MEMORY_OPEN_FAILED",
      remediation: `Check that ${path.dirname(file)} is writable, or move ${file} aside (its contents are the stored history).`,
      cause: error,
    });
  }
  let closed = false;
  return {
    db,
    path: file,
    options,
    now: clockOf(options),
    close() {
      if (closed) return;
      closed = true;
      try {
        db.close();
      } catch {
        // already closed
      }
    },
  };
}

/** Open, run `work(mem)`, always close. Returns `null` (without calling `work`) when `create:false` finds no database. */
export function withMemory(options, work) {
  const mem = openMemory(options);
  if (mem === null) return null;
  try {
    return work(mem);
  } finally {
    mem.close();
  }
}

// Migrations ---------------------------------------------------------------------------------------

export function schemaVersion(db) {
  return Number(db.prepare("PRAGMA user_version").get().user_version);
}

/**
 * Apply every pending migration, each in its own `BEGIN IMMEDIATE` transaction together with the user_version bump.
 * A database written by a NEWER build is refused (read nothing, write nothing).
 */
export function migrate(db, { migrations = MIGRATIONS } = {}) {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  if (schemaVersion(db) > latest) throw newerSchema(schemaVersion(db), latest);
  for (const step of migrations) {
    if (schemaVersion(db) >= step.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (schemaVersion(db) < step.version) {
        // re-checked under the write lock: another process may have applied it while this one waited
        db.exec(step.up);
        db.exec(`PRAGMA user_version = ${step.version}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // nothing open
      }
      throw error;
    }
  }
}

function newerSchema(found, supported) {
  return new MemoryError(`The memory database has schema version ${found}, newer than this Asterweave supports (${supported}).`, {
    code: "MEMORY_SCHEMA_NEWER",
    remediation: "Use the Asterweave version that created it, or upgrade Asterweave. The file was not modified.",
  });
}

/** The documented inverse of `migrate`: run each `down` newer than `target`, newest first. DESTRUCTIVE; not exposed by any command. */
export function rollbackTo(db, target, { migrations = MIGRATIONS } = {}) {
  for (const step of [...migrations].reverse()) {
    if (step.version <= target || schemaVersion(db) < step.version) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(step.down);
      db.exec(`PRAGMA user_version = ${step.version - 1}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // nothing open
      }
      throw error;
    }
  }
}

// Transactions -------------------------------------------------------------------------------------

/** Run `work` inside `BEGIN IMMEDIATE ... COMMIT`; any throw rolls back and is re-thrown. Not re-entrant. */
export function transaction(mem, work) {
  const { db } = mem;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // the failure may have closed the transaction already
    }
    throw error;
  }
}

/**
 * Run `work` in a transaction and ALWAYS roll it back; returns what `work` returned. How a dry run is exactly the real run:
 * the plan is computed by executing the change and counting, then discarding it.
 */
export function dryRun(mem, work) {
  const { db } = mem;
  db.exec("BEGIN IMMEDIATE");
  try {
    return work();
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      // nothing open
    }
  }
}

/**
 * After deleting content: have FTS5 merge away erased segments and truncate the write-ahead log, so the deleted text is
 * not left behind in the -wal file. Best effort (a concurrent reader can hold the checkpoint back).
 */
export function scrub(mem) {
  try {
    mem.db.exec("INSERT INTO events_fts(events_fts) VALUES ('optimize'); INSERT INTO items_fts(items_fts) VALUES ('optimize');");
    mem.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } catch {
    // the deletes themselves are already committed
  }
}

// Helpers ------------------------------------------------------------------------------------------

export const newId = (prefix) => `${prefix}_${randomBytes(8).toString("hex")}`;

/** `?,?,?` for an IN list. */
export const placeholders = (count) => Array.from({ length: count }, () => "?").join(",");

/**
 * The explicit result of a write that could not be made. `saved` is false and `degraded` true: callers must never report
 * such a write as stored.
 */
export function degradedResult(error, extra = {}) {
  const code = error?.code && typeof error.code === "string" ? error.code : "MEMORY_WRITE_FAILED";
  return {
    ok: false,
    saved: false,
    degraded: true,
    status: "degraded",
    reason: code,
    message: sanitizeForTerminal(String(error?.message ?? error ?? "unknown error")).slice(0, 200),
    ...(Number.isInteger(error?.errcode) ? { errcode: error.errcode } : {}),
    ...extra,
  };
}

/**
 * True for a failure that says the database is locked by another connection or the disk failed (SQLITE_BUSY, SQLITE_LOCKED,
 * SQLITE_IOERR and their extended codes): a write retried right away would block again. Accepts an error or a degraded result.
 */
export function isLockOrIoFailure(failure) {
  const primary = Number.isInteger(failure?.errcode) ? failure.errcode & 0xff : null;
  if (primary === 5 || primary === 6 || primary === 10) return true;
  return /database (?:table )?is locked|database is busy|SQLITE_BUSY|disk I\/O error/i.test(String(failure?.message ?? ""));
}

export { SCHEMA_VERSION };
