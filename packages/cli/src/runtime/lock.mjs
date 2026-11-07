// Per-run lock: one live process may drive a run at a time.
//
// `<runDir>/run.lock` is created exclusively (flag 'wx') and holds { pid, hostname, token, acquiredAt }.
// The owner refreshes the file's mtime (the heartbeat) every few seconds. A lock is STALE when
//   - it was written by this host and its pid is dead (process.kill(pid, 0): ESRCH = dead, EPERM = alive), or
//   - its heartbeat (mtime) is older than `staleMs`.
// A live lock fails with RUN_LOCKED (exit 1). A stale lock is taken over with the rename-aside +
// re-verify + linkSync-restore pattern that src/trust.mjs uses for the trust store lock (copied, not
// shared). Differences from the trust lock: the post-move check repeats the FULL staleness predicate
// (so an owner heartbeat that lands between the check and the rename keeps its lock), and a lock that
// is plainly live fails immediately instead of waiting out the timeout.
//
// Waiting is bounded: every failed attempt sleeps its backoff and counts toward `timeoutMs`, whatever
// the lock looks like, so a lock that can be neither created nor read still ends in RUN_LOCKED.

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { sanitizeForTerminal, suggestCommand } from "../redact.mjs";

export const LOCK_FILE_NAME = "run.lock";
export const DEFAULT_STALE_MS = 60_000;
export const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 2_000;
const BACKOFF_MS = [5, 10, 20, 40, 80, 160];
// Creating the lock fails with EEXIST when it is held. On Windows an antivirus scanner or a pending
// delete also surfaces as EPERM/EBUSY; on POSIX EPERM is a real permission problem, never contention.
const CONTENTION_WIN32 = new Set(["EEXIST", "EPERM", "EBUSY"]);
const CONTENTION_POSIX = new Set(["EEXIST", "EBUSY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** process.kill(pid, 0): ESRCH means no such process; EPERM means it exists. Anything else counts as alive. */
export function defaultPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

/**
 * @typedef {object} LockOptions
 * @property {() => number} [now]          Milliseconds since the epoch (default Date.now).
 * @property {number} [staleMs]            Heartbeat age after which a lock is stale (default 60000).
 * @property {string} [platform]
 * @property {typeof nodeFs} [fs]
 * @property {(pid: number) => boolean} [pidAlive]
 * @property {string} [hostname]
 * @property {number} [pid]
 * @property {number} [timeoutMs]          Bounded wait while a lock cannot be judged (default 2000).
 * @property {(ms: number) => void} [sleep]
 * @property {number} [heartbeatMs]        Interval used by startHeartbeat (default 5000).
 * @property {typeof setInterval} [setInterval]
 * @property {typeof clearInterval} [clearInterval]
 */

function context(options = {}) {
  return {
    fs: options.fs ?? nodeFs,
    now: options.now ?? Date.now,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    platform: options.platform ?? process.platform,
    pidAlive: options.pidAlive ?? defaultPidAlive,
    hostname: options.hostname ?? osHostname(),
  };
}

function readText(lockFile, fs) {
  try {
    return fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** The staleness predicate, applied to the lock text and the mtime. */
function judge(text, mtimeMs, ctx) {
  let owner = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) owner = parsed;
  } catch {
    // An unparseable lock (e.g. being written right now) falls back to the heartbeat age alone.
  }
  const ageMs = ctx.now() - mtimeMs;
  const sameHost = owner !== null && typeof owner.hostname === "string" && owner.hostname === ctx.hostname;
  const pid = owner?.pid;
  const ownerDead = sameHost && Number.isInteger(pid) && pid > 0 && !ctx.pidAlive(pid);
  const expired = ageMs > ctx.staleMs;
  return { owner, ageMs, stale: ownerDead || expired, reason: ownerDead ? "owner-dead" : expired ? "heartbeat-expired" : "live" };
}

function invalidLockError(lockFile, platform) {
  return new CliError(`The run lock ${lockFile} exists but is not a regular file, so it is not a lock Asterweave created.`, {
    code: "RUN_LOCK_INVALID",
    exitCode: EXIT.ERROR,
    remediation: suggestCommand("Remove it and retry: ", lockFile, "", platform),
  });
}

/**
 * Look at the lock file. state: `gone` (no lock), `unknown` (could not be judged, treated as held and
 * retried), `live`, or `stale`. Never modifies anything. Throws RUN_LOCK_INVALID for a non-file.
 */
function classify(lockFile, ctx) {
  let info;
  try {
    info = ctx.fs.lstatSync(lockFile);
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "gone" : "unknown" };
  }
  if (!info.isFile()) throw invalidLockError(lockFile, ctx.platform);
  let text;
  try {
    text = readText(lockFile, ctx.fs);
  } catch {
    return { state: "unknown" };
  }
  if (text === null) return { state: "gone" };
  const verdict = judge(text, info.mtimeMs, ctx);
  return { state: verdict.stale ? "stale" : "live", text, ...verdict };
}

/**
 * Move a stale lock aside and VERIFY what was moved. The check and the rename are not atomic: another
 * taker may have replaced the lock with a live one in between, or the owner may have heartbeated.
 * After the move the text must be unchanged AND the full staleness predicate must still hold on the
 * moved file; otherwise it is put back with a hard link (which, unlike rename, fails if the path has
 * been taken again) and we do not acquire. Returns "removed", "gone" or "held".
 */
function takeOver(lockFile, seen, token, ctx) {
  const { fs } = ctx;
  try {
    if (readText(lockFile, fs) !== seen.text) return "held";
  } catch {
    return "held";
  }
  const aside = `${lockFile}.stale-${token}`;
  try {
    fs.renameSync(lockFile, aside);
  } catch (error) {
    return error?.code === "ENOENT" ? "gone" : "held";
  }
  let movedText = null;
  let movedMtime = null;
  try {
    movedText = readText(aside, fs);
    movedMtime = fs.lstatSync(aside).mtimeMs;
  } catch {
    // Unreadable copy: treated like a different text below (restored, not removed).
  }
  const stillStale = movedText === seen.text && movedMtime !== null && judge(movedText, movedMtime, ctx).stale;
  if (!stillStale) {
    try {
      fs.linkSync(aside, lockFile);
    } catch {
      // The path is taken again by a newer lock; the displaced one cannot be restored over it.
    }
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Best effort: a leftover `.stale-*` file is harmless.
  }
  return stillStale ? "removed" : "held";
}

function lockedError(lockFile, ctx, { seen, timeoutMs } = {}) {
  const owner = seen?.owner;
  const who = owner
    ? `pid ${Number.isInteger(owner.pid) ? owner.pid : "unknown"} on ${sanitizeForTerminal(String(owner.hostname ?? "unknown host")).slice(0, 64)}`
    : "another process";
  const age = seen?.ageMs !== undefined ? ` (last heartbeat ${Math.max(0, Math.round(seen.ageMs / 1000))}s ago)` : "";
  const message = seen?.state === "live" ? `This run is locked by ${who}${age}.` : `The run lock could not be acquired within ${timeoutMs} ms.`;
  const error = new CliError(message, {
    code: "RUN_LOCKED",
    exitCode: EXIT.ERROR,
    remediation: `Wait for the other process to finish. A lock whose owner died, or whose heartbeat is older than ${Math.round(ctx.staleMs / 1000)}s, is taken over automatically. If no Asterweave process is running, ${suggestCommand("remove the lock file ", lockFile, " and retry.", ctx.platform)}`,
  });
  if (owner) error.owner = { pid: owner.pid, hostname: owner.hostname };
  return error;
}

/**
 * Read-only lock state for display (`run show`): `none`, `live`, `stale` or `unknown`.
 * @param {string} dir  Run directory.
 * @param {LockOptions} [options]
 */
export function inspectRunLock(dir, options = {}) {
  const ctx = context(options);
  const seen = classify(path.join(dir, LOCK_FILE_NAME), ctx);
  if (seen.state === "gone") return { state: "none" };
  if (seen.state === "unknown") return { state: "unknown" };
  return { state: seen.state, owner: seen.owner ? { pid: seen.owner.pid, hostname: seen.owner.hostname } : null, ageMs: seen.ageMs, reason: seen.reason };
}

/**
 * Acquire the run lock. Synchronous (it may sleep for a few milliseconds while a stale lock is cleared).
 * @param {string} dir  Run directory (must exist).
 * @param {LockOptions} [options]
 * @returns {{token: string, file: string, readonly lost: boolean, heartbeat: () => boolean,
 *            startHeartbeat: () => void, stopHeartbeat: () => void, release: () => boolean}}
 * @throws {CliError} RUN_LOCKED (exit 1) when a live process holds it or it cannot be acquired in time.
 */
export function acquireRunLock(dir, options = {}) {
  const ctx = context(options);
  const { fs, now } = ctx;
  const sleep = options.sleep ?? sleepSync;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const contention = ctx.platform === "win32" ? CONTENTION_WIN32 : CONTENTION_POSIX;
  const lockFile = path.join(dir, LOCK_FILE_NAME);
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: options.pid ?? process.pid, hostname: ctx.hostname, token, acquiredAt: new Date(now()).toISOString() });

  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!contention.has(error?.code)) {
        throw new CliError(`Cannot create the run lock ${lockFile}: ${error?.message ?? error}`, {
          code: "RUN_LOCK_FAILED",
          exitCode: EXIT.ERROR,
          remediation: "Check that the run directory exists and is writable.",
          cause: error,
        });
      }
      const seen = classify(lockFile, ctx);
      if (seen.state === "live") throw lockedError(lockFile, ctx, { seen });
      if (seen.state === "stale") takeOver(lockFile, seen, token, ctx);
      if (waited >= timeoutMs) throw lockedError(lockFile, ctx, { seen, timeoutMs });
      const delay = Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], timeoutMs - waited);
      sleep(delay);
      waited += delay;
    }
  }

  let lost = false;
  let released = false;
  let timer = null;
  const setTimer = options.setInterval ?? globalThis.setInterval;
  const clearTimer = options.clearInterval ?? globalThis.clearInterval;

  const isOurs = () => {
    try {
      return JSON.parse(readText(lockFile, fs) ?? "null")?.token === token;
    } catch {
      return false;
    }
  };

  function heartbeat() {
    if (released || lost) return false;
    try {
      if (!isOurs()) {
        lost = true;
        return false;
      }
      const seconds = now() / 1000;
      fs.utimesSync(lockFile, seconds, seconds);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") lost = true;
      return false;
    }
  }

  function stopHeartbeat() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  function startHeartbeat() {
    if (timer !== null || released) return;
    timer = setTimer(() => {
      heartbeat();
    }, options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    timer?.unref?.();
  }

  function release() {
    stopHeartbeat();
    if (released) return false;
    released = true;
    try {
      if (!isOurs()) return false;
      fs.unlinkSync(lockFile);
      return true;
    } catch {
      return false; // gone, or no longer ours: nothing to release
    }
  }

  return {
    token,
    file: lockFile,
    get lost() {
      return lost;
    },
    heartbeat,
    startHeartbeat,
    stopHeartbeat,
    release,
  };
}
