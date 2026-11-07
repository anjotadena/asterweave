// Run ledger: `<userDir>/runs/<repoDir>/<runId>/{run.json,events.jsonl,run.lock}`.
//
// events.jsonl is the append-only audit trail, run.json is the latest snapshot. The ledger does not
// know graph semantics: it stores what callers give it (always through redactDeep, so a token-shaped
// string never reaches disk), numbers events, and keeps the two files honest.
//
// Ordering: an event line is written (and fsynced) FIRST, then run.json is rewritten atomically with
// lastSeq set to that event. A crash between the two leaves a recoverable run: loadRun reports
// `behind` > 0 and the events past run.lastSeq in `pending`, which the caller folds into the snapshot.
// `v`, `seq`, `at` and `runId` are the first members of every line, and any member of the record under those
// names is DROPPED before the line is built (RESERVED_EVENT_KEYS), so a record can never override them.
// events.jsonl is never rewritten or truncated, with ONE exception: a torn final line
// (an append that did not finish) is ignored on read and may be cut off by `repairTail`, which needs
// the run lock token and leaves a `ledger.repaired` event behind.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { runsDir } from "../paths.mjs";
import { redactDeep, sanitizeForTerminal } from "../redact.mjs";
import { readJson, writeJsonAtomic } from "../store.mjs";
import { LOCK_FILE_NAME } from "./lock.mjs";

export const RUN_SCHEMA_VERSION = 1;
export const EVENT_VERSION = 1;
export const RUN_FILE = "run.json";
export const EVENTS_FILE = "events.jsonl";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const EVENT_TYPE = /^[a-z][a-z0-9.-]{0,63}$/;
const RESERVED_EVENT_KEYS = new Set(["v", "seq", "at", "runId"]);

const isoNow = () => new Date().toISOString();
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function ledgerError(message, code, remediation, exitCode = EXIT.ERROR) {
  return new CliError(message, { code, exitCode, remediation });
}

// Locations ---------------------------------------------------------------------------------------

/** `<userDir>/runs`. */
export function runsRoot(options) {
  return runsDir(options);
}

/**
 * Filesystem-safe directory name for a repository key (the realpath of the git common dir, lower-cased
 * on win32): the first 32 hex characters of its sha256. No path characters can leak into the name.
 * @param {string} repoKey
 */
export function repoDirName(repoKey) {
  if (typeof repoKey !== "string" || repoKey === "") throw new TypeError("repoKey must be a non-empty string");
  return createHash("sha256").update(repoKey).digest("hex").slice(0, 32);
}

/** Whether `runId` is acceptable as a directory name on every platform. */
export function isValidRunId(runId) {
  return typeof runId === "string" && RUN_ID.test(runId) && !WINDOWS_RESERVED.test(runId);
}

function assertRunId(runId) {
  if (!isValidRunId(runId)) {
    throw new CliError(`Invalid run id '${sanitizeForTerminal(String(runId).slice(0, 80))}': use 1-64 letters, digits, '-' or '_'.`, { code: "RUN_ID_INVALID", exitCode: EXIT.USAGE });
  }
}

/** `<userDir>/runs/<repoDir>/<runId>`. */
export function runDir(repoKey, runId, options) {
  assertRunId(runId);
  return path.join(runsRoot(options), repoDirName(repoKey), runId);
}

// Reading ------------------------------------------------------------------------------------------

function supportedOf(options) {
  return options?.supportedVersion ?? RUN_SCHEMA_VERSION;
}

function readRun(dir, fs, supported) {
  const file = path.join(dir, RUN_FILE);
  const run = readJson(file, { fallback: null, fs });
  if (run === null) {
    throw ledgerError(`No run found at ${dir}.`, "RUN_NOT_FOUND", "List runs with `asterweave run show` or check the run id.");
  }
  if (!isObject(run) || !Number.isInteger(run.v) || run.v < 1 || typeof run.runId !== "string" || !isValidRunId(run.runId)) {
    throw ledgerError(`${file} is not a valid run snapshot.`, "RUN_CORRUPT", `Inspect ${file}; events.jsonl next to it is the audit trail and is never rewritten.`);
  }
  if (run.v > supported) {
    throw ledgerError(
      `${file} was written by a newer Asterweave (run schema v${run.v}; this version supports up to v${supported}).`,
      "RUN_SCHEMA_TOO_NEW",
      "Upgrade Asterweave to open this run. It was left untouched.",
      EXIT.CONFIG,
    );
  }
  if (!Number.isInteger(run.lastSeq) || run.lastSeq < 0) {
    throw ledgerError(`${file} has no valid lastSeq.`, "RUN_CORRUPT", `Inspect ${file}.`);
  }
  return run;
}

function corruptLedger(file, detail) {
  return ledgerError(`${file} is inconsistent: ${detail}.`, "RUN_LEDGER_CORRUPT", "The audit trail is never rewritten; inspect the file and the run.json beside it.");
}

/** Complete (newline-terminated) lines parsed and checked, plus the unterminated tail fragment. */
function readEvents(file, runId, fs) {
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], torn: false, tornBytes: 0, validBytes: 0 };
    throw ledgerError(`Cannot read ${file}: ${error?.message ?? error}`, "RUN_LEDGER_UNREADABLE", "Check file permissions.");
  }
  const lastNewline = buffer.lastIndexOf(0x0a);
  const validBytes = lastNewline + 1;
  const tornBytes = buffer.length - validBytes;
  const events = [];
  const lines = buffer.subarray(0, validBytes).toString("utf8").split("\n");
  lines.pop();
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw corruptLedger(file, `line ${index + 1} is not valid JSON`);
    }
    if (!isObject(event) || event.seq !== events.length + 1 || typeof event.type !== "string") {
      throw corruptLedger(file, `line ${index + 1} breaks the event sequence (expected seq ${events.length + 1})`);
    }
    if (event.runId !== runId) throw corruptLedger(file, `line ${index + 1} belongs to a different run`);
    events.push(event);
  });
  return { events, torn: tornBytes > 0, tornBytes, validBytes };
}

/**
 * Load a run. `events` are all complete events; `pending` are those past `run.lastSeq` (an event whose
 * snapshot write did not finish): fold them into the run. `behind` is `pending.length`. A torn final
 * line is ignored (`torn`, `tornBytes`); it is only cut off by `repairTail` under the lock.
 * Throws RUN_SCHEMA_TOO_NEW (exit 5) for a run written by a newer schema, RUN_LEDGER_CORRUPT when the
 * snapshot claims events that the log does not hold.
 *
 * @param {string} dir
 * @param {{fs?: typeof nodeFs, supportedVersion?: number}} [options]  `supportedVersion` is a test seam; defaults to RUN_SCHEMA_VERSION.
 * @returns {{dir: string, run: object, events: object[], pending: object[], behind: number, torn: boolean, tornBytes: number}}
 */
export function loadRun(dir, options = {}) {
  const fs = options.fs ?? nodeFs;
  const run = readRun(dir, fs, supportedOf(options));
  const file = path.join(dir, EVENTS_FILE);
  const { events, torn, tornBytes } = readEvents(file, run.runId, fs);
  const lastEventSeq = events.length;
  if (run.lastSeq > lastEventSeq) throw corruptLedger(file, `run.json records seq ${run.lastSeq} but the log ends at ${lastEventSeq}`);
  const pending = events.filter((event) => event.seq > run.lastSeq);
  return { dir, run, events, pending, behind: pending.length, torn, tornBytes };
}

/** Last complete line's seq, and whether the file ends with a newline. Reads only the end of the file. */
function scanTail(fs, file) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    if (error?.code === "ENOENT") return { terminated: true, lastSeq: 0 };
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    if (size === 0) return { terminated: true, lastSeq: 0 };
    for (let span = 16_384; ; span *= 4) {
      const length = Math.min(size, span);
      const start = size - length;
      const buffer = Buffer.alloc(length);
      for (let got = 0; got < length; ) {
        const read = fs.readSync(fd, buffer, got, length - got, start + got);
        if (read === 0) break;
        got += read;
      }
      const terminated = buffer[length - 1] === 0x0a;
      const lines = buffer.toString("utf8").split("\n");
      lines.pop(); // the empty string after the final newline, or the torn fragment
      if (start > 0) lines.shift(); // may be cut in the middle
      const complete = lines.filter((line) => line.trim() !== "");
      if (complete.length > 0) {
        let seq = null;
        try {
          const parsed = JSON.parse(complete.at(-1));
          if (isObject(parsed) && Number.isInteger(parsed.seq) && parsed.seq >= 1) seq = parsed.seq;
        } catch {
          // handled below
        }
        if (seq === null) throw corruptLedger(file, "the last event is not valid");
        return { terminated, lastSeq: seq };
      }
      if (start === 0) return { terminated, lastSeq: 0 };
    }
  } finally {
    fs.closeSync(fd);
  }
}

// Writing ------------------------------------------------------------------------------------------

function verifyLock(dir, lockToken, fs) {
  let held = null;
  if (typeof lockToken === "string" && lockToken !== "") {
    try {
      held = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE_NAME), "utf8"))?.token ?? null;
    } catch {
      held = null;
    }
  }
  if (held === null || held !== lockToken) {
    throw ledgerError("The run lock is not held by this process.", "RUN_LOCK_REQUIRED", "Acquire the run lock (acquireRunLock) before changing the run's ledger.");
  }
}

function writeAll(fs, fd, buffer) {
  for (let written = 0; written < buffer.length; ) written += fs.writeSync(fd, buffer, written, buffer.length - written);
}

function syncQuietly(fs, fd) {
  try {
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
  }
}

function appendLine(fs, file, text) {
  const fd = fs.openSync(file, "a", 0o600);
  try {
    writeAll(fs, fd, Buffer.from(text, "utf8"));
    syncQuietly(fs, fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeEvent(dir, rec, options, { snapshot }) {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? isoNow;
  if (!isObject(rec) || typeof rec.type !== "string" || !EVENT_TYPE.test(rec.type)) {
    throw new TypeError("An event needs a `type` like 'node.entered'.");
  }
  if (options.lockToken !== undefined) verifyLock(dir, options.lockToken, fs);
  const current = readRun(dir, fs, supportedOf(options));
  if (options.run !== undefined && (!isObject(options.run) || options.run.runId !== current.runId)) {
    throw new TypeError("The snapshot passed to appendEvent belongs to a different run.");
  }
  const eventsFile = path.join(dir, EVENTS_FILE);
  const tail = scanTail(fs, eventsFile);
  if (!tail.terminated) {
    throw ledgerError(
      "events.jsonl ends with a partial line from an interrupted write.",
      "RUN_TAIL_TORN",
      "Resume the run (it repairs the tail under the run lock) before appending.",
    );
  }
  if (tail.lastSeq < current.lastSeq) throw corruptLedger(eventsFile, `run.json records seq ${current.lastSeq} but the log ends at ${tail.lastSeq}`);
  if (snapshot && tail.lastSeq > current.lastSeq && options.run === undefined) {
    throw ledgerError(
      `run.json is ${tail.lastSeq - current.lastSeq} event(s) behind the log; fold the pending events and pass the resulting run.`,
      "RUN_BEHIND",
      "Call loadRun, fold `pending` into the run, then appendEvent(dir, rec, { run }).",
    );
  }
  const seq = tail.lastSeq + 1;
  const at = now();
  const rest = Object.fromEntries(Object.entries(redactDeep(rec).value).filter(([key]) => !RESERVED_EVENT_KEYS.has(key)));
  const event = { v: EVENT_VERSION, seq, at, runId: current.runId, ...rest };
  appendLine(fs, eventsFile, `${JSON.stringify(event)}\n`);
  if (!snapshot) return { seq, at, event, run: current };
  const next = redactDeep({ ...(options.run ?? current), v: current.v, runId: current.runId, lastSeq: seq, updatedAt: at }).value;
  writeJsonAtomic(path.join(dir, RUN_FILE), next, { fs });
  return { seq, at, event, run: next };
}

/**
 * Append one event and update the snapshot, in that order. `rec` needs a `type`; every string in it is
 * redacted, and `v`/`seq`/`at`/`runId` are assigned here (a record's own values are dropped).
 * The caller must hold the run lock; pass `lockToken` to have the ledger verify that.
 *
 * `options.run` is the already-folded run state to store; without it the stored snapshot is kept and
 * only `lastSeq`/`updatedAt` move (refused with RUN_BEHIND when events are pending). Refused with
 * RUN_TAIL_TORN while the log ends in a partial line (see repairTail).
 *
 * @param {string} dir
 * @param {{type: string, [key: string]: unknown}} rec
 * @param {{run?: object, lockToken?: string, now?: () => string, fs?: typeof nodeFs, supportedVersion?: number}} [options]
 * @returns {{seq: number, at: string, event: object, run: object}}
 */
export function appendEvent(dir, rec, options = {}) {
  return writeEvent(dir, rec, options, { snapshot: true });
}

/**
 * Cut off a torn final line (an unfinished append) and record a `ledger.repaired` event. The lock token
 * is mandatory and checked against run.lock. Complete lines are never touched.
 * @param {string} dir
 * @param {{lockToken: string, now?: () => string, fs?: typeof nodeFs, supportedVersion?: number}} options
 * @returns {{repaired: false} | {repaired: true, droppedBytes: number, seq: number, at: string}}
 */
export function repairTail(dir, options) {
  const fs = options?.fs ?? nodeFs;
  verifyLock(dir, options?.lockToken, fs);
  const run = readRun(dir, fs, supportedOf(options));
  const file = path.join(dir, EVENTS_FILE);
  const { torn, tornBytes, validBytes } = readEvents(file, run.runId, fs);
  if (!torn) return { repaired: false };
  const fragment = fs.readFileSync(file).subarray(validBytes);
  const fd = fs.openSync(file, "r+");
  try {
    fs.ftruncateSync(fd, validBytes);
    syncQuietly(fs, fd);
  } finally {
    fs.closeSync(fd);
  }
  const tail = scanTail(fs, file);
  const record = { type: "ledger.repaired", reason: "torn-tail", droppedBytes: tornBytes, droppedSha256: createHash("sha256").update(fragment).digest("hex") };
  // When the snapshot was already behind, leave it so the caller still folds the pending events.
  const result = writeEvent(dir, record, { ...options, lockToken: options.lockToken }, { snapshot: tail.lastSeq === run.lastSeq });
  return { repaired: true, droppedBytes: tornBytes, seq: result.seq, at: result.at };
}

/**
 * Create a run directory with its snapshot and a `run.created` event. Refuses an existing run id.
 * `run.lastSeq` is reset to 0 and `createdAt`/`updatedAt` are set when absent.
 * Creation is the one place where the snapshot is written before the event: there is no earlier state
 * to disagree with, and a crash in between leaves a valid run with an empty log.
 *
 * @param {string} repoKey
 * @param {{runId: string, [key: string]: unknown}} run
 * @param {{env?: object, platform?: string, homedir?: () => string, fs?: typeof nodeFs, now?: () => string, supportedVersion?: number}} [options]
 * @returns {{dir: string, run: object}}
 */
export function createRun(repoKey, run, options = {}) {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? isoNow;
  if (!isObject(run)) throw new TypeError("run must be an object");
  const dir = runDir(repoKey, run.runId, options);
  if ((run.v ?? RUN_SCHEMA_VERSION) > supportedOf(options)) {
    throw ledgerError(`Run schema v${run.v} is newer than this Asterweave supports.`, "RUN_SCHEMA_TOO_NEW", "Upgrade Asterweave.", EXIT.CONFIG);
  }
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw ledgerError(`Run ${run.runId} already exists.`, "RUN_EXISTS", "Choose another run id; existing runs are never overwritten.");
    }
    throw ledgerError(`Cannot create ${dir}: ${error?.message ?? error}`, "RUN_CREATE_FAILED", "Check that the Asterweave user directory is writable.");
  }
  const at = now();
  const snapshot = redactDeep({ ...run, v: run.v ?? RUN_SCHEMA_VERSION, lastSeq: 0, createdAt: run.createdAt ?? at, updatedAt: at }).value;
  writeJsonAtomic(path.join(dir, RUN_FILE), snapshot, { fs });
  const created = writeEvent(dir, { type: "run.created", graph: snapshot.graph ?? null, repo: snapshot.repo ?? null, goal: snapshot.goal ?? null }, { ...options, run: snapshot, now: () => at }, { snapshot: true });
  return { dir, run: created.run };
}

/**
 * Runs of one repository, newest first (by createdAt, then run id). A run whose snapshot cannot be
 * read is listed last with an `error` code instead of failing the listing.
 * @param {string} repoKey
 * @param {{env?: object, platform?: string, homedir?: () => string, fs?: typeof nodeFs, supportedVersion?: number}} [options]
 */
export function listRuns(repoKey, options = {}) {
  const fs = options.fs ?? nodeFs;
  const base = path.join(runsRoot(options), repoDirName(repoKey));
  let entries;
  try {
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidRunId(entry.name)) continue;
    const dir = path.join(base, entry.name);
    try {
      const run = readRun(dir, fs, supportedOf(options));
      runs.push({ runId: run.runId, dir, status: run.status ?? null, currentNode: run.currentNode ?? null, goal: run.goal ?? null, graph: run.graph ?? null, createdAt: run.createdAt ?? null, updatedAt: run.updatedAt ?? null, lastSeq: run.lastSeq });
    } catch (error) {
      runs.push({ runId: entry.name, dir, error: error?.code ?? "RUN_UNREADABLE", createdAt: null });
    }
  }
  const stamp = (item) => {
    const time = Date.parse(item.createdAt ?? "");
    return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
  };
  return runs.sort((a, b) => stamp(b) - stamp(a) || (a.runId < b.runId ? 1 : a.runId > b.runId ? -1 : 0));
}
