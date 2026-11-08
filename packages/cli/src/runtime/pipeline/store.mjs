// Pipeline store: `<userDir>/pipelines/<repoDir>/<owner-name>/pr-<n>/{state.json,events.jsonl,run.lock}`.
//
// Event-first, like the run ledger: an event line is appended (and fsynced) FIRST, then state.json is rewritten atomically with
// `lastSeq`. The state is a fold of the events (state.mjs foldEvents), so a crash between the two writes loses nothing: the next
// load folds the events past `state.lastSeq`. A torn final line (an append that did not finish) is ignored on read and cut off by
// `openPipelineSession` under the lock, which records a `store.repaired` event. Writers hold a per-PR lock (lock.mjs; the same
// stale-owner and heartbeat rules as a run lock). Readers take no lock.
//
// Bounds: every file read is capped at 8 MiB (over the cap => PIPELINE_LOG_TOO_LARGE, nothing is truncated or deleted); one event
// is at most 1 MiB; when events.jsonl passes 4 MiB the next append rotates it to events.1.jsonl (one generation is kept) and starts the
// new file with a `checkpoint` record carrying the whole state, so the current file alone always reproduces the state. schemaVersion 1;
// a newer file is refused (exit 5) and left untouched. Every record passes redactDeep before it reaches disk.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../../exit-codes.mjs";
import { resolveUserDir } from "../../paths.mjs";
import { stringifyJson } from "../../json.mjs";
import { redactDeep } from "../../redact.mjs";
import { readJson, writeJsonAtomic } from "../../store.mjs";
import { LOCK_FILE_NAME, acquireRunLock } from "../lock.mjs";
import { STATE_SCHEMA_VERSION, foldEvent, foldEvents, initialState } from "./state.mjs";

export const STATE_FILE = "state.json";
export const EVENTS_FILE = "events.jsonl";
export const ROTATED_FILE = "events.1.jsonl";
export const READ_CAP_BYTES = 8 * 1024 * 1024;
export const ROTATE_AT_BYTES = 4 * 1024 * 1024;
export const EVENT_CAP_BYTES = 1024 * 1024;
/** A checkpoint carries the whole state: it is exempt from the per-event cap but bounded well below the 8 MiB read cap. */
export const CHECKPOINT_CAP_BYTES = 6 * 1024 * 1024;
export const EVENT_VERSION = 1;

const EVENT_TYPE = /^[a-z][a-z0-9.-]{0,63}$/;
const RESERVED = new Set(["v", "seq", "at"]);
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isoNow = () => new Date().toISOString();

const storeError = (message, code, remediation, exitCode = EXIT.ERROR) => new CliError(message, { code, exitCode, remediation });

// Locations ----------------------------------------------------------------------------------------

/** `owner/name` -> { owner, name, full } or null (strict: the same patterns the GitHub tools enforce). */
export function parseRepoSlug(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("/");
  if (parts.length !== 2 || !OWNER.test(parts[0]) || !NAME.test(parts[1])) return null;
  return { owner: parts[0], name: parts[1], full: `${parts[0]}/${parts[1]}` };
}

/** `<userDir>/pipelines`. */
export function pipelinesRoot(options = {}) {
  const platform = options.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), "pipelines");
}

/** Directory of one pull request's monitor state. Throws PIPELINE_ARGS_INVALID for a bad repo or number. */
export function pipelineDir(host, slug, prNumber, options = {}) {
  const repo = typeof slug === "string" ? parseRepoSlug(slug) : slug;
  if (!repo || !Number.isSafeInteger(prNumber) || prNumber < 1) throw storeError("Invalid repository or pull request number.", "PIPELINE_ARGS_INVALID", "Use owner/name and a positive pull request number.", EXIT.USAGE);
  const key = createHash("sha256").update(`${String(host).toLowerCase()}/${repo.full.toLowerCase()}`).digest("hex").slice(0, 32);
  const readable = `${repo.owner}-${repo.name}`.replace(/\.+$/, "_");
  return path.join(pipelinesRoot(options), key, readable, `pr-${prNumber}`);
}

// Reading ------------------------------------------------------------------------------------------

function sizeOf(file, fs) {
  try {
    return fs.statSync(file).size;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw storeError(`Cannot read ${file}: ${error?.message ?? error}`, "PIPELINE_STORE_UNREADABLE", "Check file permissions.");
  }
}

function capped(file, fs) {
  const size = sizeOf(file, fs);
  if (size !== null && size > READ_CAP_BYTES) {
    throw storeError(`${file} is larger than ${READ_CAP_BYTES} bytes.`, "PIPELINE_LOG_TOO_LARGE", "It was left untouched. Move it aside to start monitoring from a clean state.");
  }
  return size;
}

function corrupt(file, detail) {
  return storeError(`${file} is inconsistent: ${detail}.`, "PIPELINE_LOG_CORRUPT", "The log is never rewritten; inspect it or move the pull request directory aside to start again.");
}

/** Complete lines parsed and sequence-checked, plus the length of the valid prefix and any torn fragment. */
function readLog(file, fs) {
  if (capped(file, fs) === null) return { events: [], torn: false, tornBytes: 0, validBytes: 0 };
  let buffer;
  try {
    buffer = fs.readFileSync(file);
  } catch (error) {
    if (error?.code === "ENOENT") return { events: [], torn: false, tornBytes: 0, validBytes: 0 };
    throw storeError(`Cannot read ${file}: ${error?.message ?? error}`, "PIPELINE_STORE_UNREADABLE", "Check file permissions.");
  }
  const validBytes = buffer.lastIndexOf(0x0a) + 1;
  const lines = buffer.subarray(0, validBytes).toString("utf8").split("\n");
  lines.pop();
  const events = [];
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      throw corrupt(file, `line ${index + 1} is not valid JSON`);
    }
    if (!isObject(event) || !Number.isSafeInteger(event.seq) || typeof event.type !== "string" || (events.length > 0 && event.seq !== events.at(-1).seq + 1)) {
      throw corrupt(file, `line ${index + 1} breaks the event sequence`);
    }
    events.push(event);
  });
  return { events, torn: buffer.length > validBytes, tornBytes: buffer.length - validBytes, validBytes };
}

function readSnapshot(dir, fs) {
  const file = path.join(dir, STATE_FILE);
  capped(file, fs);
  const data = readJson(file, { fallback: null, fs });
  if (data === null) return null;
  if (!isObject(data) || !Number.isSafeInteger(data.schemaVersion) || !Number.isSafeInteger(data.lastSeq) || data.lastSeq < 0 || !isObject(data.slots) || !isObject(data.pr) || !isObject(data.poll) || !isObject(data.counters) || !isObject(data.links)) {
    throw storeError(`${file} is not a valid pipeline state.`, "PIPELINE_STATE_CORRUPT", `Inspect ${file}; events.jsonl beside it is the audit trail.`);
  }
  if (data.schemaVersion > STATE_SCHEMA_VERSION) {
    throw storeError(`${file} was written by a newer Asterweave (pipeline schema v${data.schemaVersion}; this version supports v${STATE_SCHEMA_VERSION}).`, "PIPELINE_SCHEMA_TOO_NEW", "Upgrade Asterweave to read it. It was left untouched.", EXIT.CONFIG);
  }
  return data;
}

/**
 * Read a pipeline directory without a lock. `state` is the snapshot with the events past it folded in memory (null when nothing was
 * ever recorded); `behind` counts those events. A torn final line is ignored (`torn`).
 * @returns {{exists: boolean, state: object|null, lastSeq: number, behind: number, torn: boolean, tornBytes: number, events: object[]}}
 */
export function loadPipeline(dir, { fs = nodeFs } = {}) {
  const snapshot = readSnapshot(dir, fs);
  const log = readLog(path.join(dir, EVENTS_FILE), fs);
  const logLast = log.events.length > 0 ? log.events.at(-1).seq : 0;
  const snapshotSeq = snapshot?.lastSeq ?? 0;
  if (snapshot && snapshotSeq > logLast && log.events.length > 0) throw corrupt(path.join(dir, EVENTS_FILE), `state.json records seq ${snapshotSeq} but the log ends at ${logLast}`);
  if (snapshot && log.events.length > 0 && log.events[0].seq > snapshotSeq + 1) throw corrupt(path.join(dir, EVENTS_FILE), "the log starts after the state it should extend");
  const { lastSeq: _ignored, ...base } = snapshot ?? {};
  const pending = log.events.filter((event) => event.seq > snapshotSeq);
  const state = snapshot ? foldEvents(base, pending) : foldEvents(null, pending);
  return { exists: state !== null, state, lastSeq: Math.max(snapshotSeq, logLast), behind: pending.length, torn: log.torn, tornBytes: log.tornBytes, events: log.events };
}

// Writing ------------------------------------------------------------------------------------------

function writeAll(fs, fd, buffer) {
  for (let written = 0; written < buffer.length; ) written += fs.writeSync(fd, buffer, written, buffer.length - written);
}

function appendLine(fs, file, text) {
  const fd = fs.openSync(file, "a", 0o600);
  try {
    writeAll(fs, fd, Buffer.from(text, "utf8"));
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Take the per-PR lock, repair a torn tail, create the state when it does not exist, and return a writer. Always `close()` it.
 * @param {string} dir
 * @param {{repo: string, host: string, prNumber: number}} init  Used only when the directory holds no state yet.
 * @param {{fs?: typeof nodeFs, now?: () => string, lock?: object}} [options]
 */
export function openPipelineSession(dir, init, options = {}) {
  const fs = options.fs ?? nodeFs;
  const now = options.now ?? isoNow;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let lock;
  try {
    lock = acquireRunLock(dir, { fs, ...(options.lock ?? {}) });
  } catch (error) {
    if (error?.code === "RUN_LOCKED") throw storeError("Another Asterweave process is monitoring this pull request.", "PIPELINE_LOCKED", "Wait for it to finish, or use `asterweave pipeline status` to read the recorded state.");
    throw error;
  }
  const eventsFile = path.join(dir, EVENTS_FILE);
  let state = null;
  let lastSeq = 0;
  let closed = false;

  const assertLock = () => {
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(path.join(dir, LOCK_FILE_NAME), "utf8"))?.token ?? null;
    } catch {
      held = null;
    }
    if (closed || lock.lost || held !== lock.token) throw storeError("The pipeline lock is no longer held by this process.", "PIPELINE_LOCK_LOST", "Another process took it over; rerun the command.");
  };

  function writeSnapshot() {
    writeJsonAtomic(path.join(dir, STATE_FILE), redactDeep({ ...state, lastSeq }).value, { fs });
  }

  function writeEvent(rec, file = eventsFile, { commit = true, cap = EVENT_CAP_BYTES } = {}) {
    if (!isObject(rec) || typeof rec.type !== "string" || !EVENT_TYPE.test(rec.type)) throw new TypeError("A pipeline event needs a `type` like 'poll'.");
    const rest = Object.fromEntries(Object.entries(redactDeep(rec).value).filter(([key]) => !RESERVED.has(key)));
    const at = now();
    const seq = lastSeq + 1;
    const line = `${stringifyJson({ v: EVENT_VERSION, seq, at, ...rest })}\n`;
    if (Buffer.byteLength(line) > cap) throw storeError(`A pipeline event is larger than ${cap / (1024 * 1024)} MiB.`, "PIPELINE_EVENT_TOO_LARGE", "This is a bug in Asterweave; nothing was written.");
    appendLine(fs, file, line);
    if (commit) lastSeq = seq;
    return { seq, at, event: JSON.parse(line) };
  }

  function rotateIfNeeded() {
    const size = sizeOf(eventsFile, fs);
    if (size === null || size < ROTATE_AT_BYTES) return;
    // The checkpoint is written (and fsynced) into a NEW file first, then the generations are swapped: a failure at any point leaves either the
    // old log or the old log plus the new one, never a log without its checkpoint and never a sequence gap.
    const fresh = path.join(dir, `${EVENTS_FILE}.new`);
    try {
      fs.unlinkSync(fresh);
    } catch {
      // No leftover from an interrupted rotation.
    }
    const written = writeEvent({ type: "checkpoint", state }, fresh, { commit: false, cap: CHECKPOINT_CAP_BYTES });
    fs.renameSync(eventsFile, path.join(dir, ROTATED_FILE)); // replaces the previous generation
    fs.renameSync(fresh, eventsFile);
    lastSeq = written.seq;
  }

  try {
    let loaded = loadPipeline(dir, { fs });
    if (loaded.torn) {
      const { validBytes } = readLog(eventsFile, fs);
      const fragment = fs.readFileSync(eventsFile).subarray(validBytes);
      const fd = fs.openSync(eventsFile, "r+");
      try {
        fs.ftruncateSync(fd, validBytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      lastSeq = loaded.lastSeq;
      state = loaded.state;
      writeEvent({ type: "store.repaired", reason: "torn-tail", droppedBytes: loaded.tornBytes, droppedSha256: createHash("sha256").update(fragment).digest("hex") });
      loaded = loadPipeline(dir, { fs });
    }
    state = loaded.state;
    lastSeq = loaded.lastSeq;
    if (state === null) {
      const slug = typeof init.repo === "string" ? init.repo : "";
      if (!parseRepoSlug(slug) || !Number.isSafeInteger(init.prNumber)) throw new TypeError("openPipelineSession needs init.repo and init.prNumber for a new pipeline.");
      const written = writeEvent({ type: "init", repo: slug, host: init.host ?? "github.com", prNumber: init.prNumber });
      state = initialState({ repo: slug, prNumber: init.prNumber, host: init.host ?? "github.com", now: written.at });
      writeSnapshot();
    } else if (loaded.behind > 0 || loaded.torn) {
      writeSnapshot();
    }
  } catch (error) {
    lock.release();
    throw error;
  }
  lock.startHeartbeat();

  return {
    dir,
    get state() {
      return state;
    },
    get lastSeq() {
      return lastSeq;
    },
    get lock() {
      return lock;
    },
    /** Append one event (event first), fold it into the state and rewrite the snapshot. Returns the new state. */
    append(rec) {
      assertLock();
      rotateIfNeeded();
      const written = writeEvent(rec);
      state = foldEvent(state, written.event);
      writeSnapshot();
      return state;
    },
    close() {
      if (closed) return;
      lock.release();
      closed = true;
    },
  };
}
