// Repository trust. A repository's own config can make Asterweave (or `claude`) execute code:
// quality-gate shell commands, hooks, MCP servers, settings. So executable repo config is only
// honoured after the user explicitly grants trust, and the grant is bound to a content hash:
// any byte change in any of the four governing files makes the repository untrusted again.
//
// trust.json (in the user directory): { "<realpath>": { "sha256": "<hex>", "trustedAt": "<iso>" } }
// Keys are the repository realpath (lower-cased on win32, where the filesystem is case-insensitive).

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./exit-codes.mjs";
import { userFilePath } from "./paths.mjs";
import { suggestCommand } from "./redact.mjs";
import { readJson, StoreError, writeJsonAtomic } from "./store.mjs";

/** Files whose bytes decide trust, relative to the repository root. Order is part of the hash. */
export const TRUST_FILES = Object.freeze([".claude/asterweave.json", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]);

const ADAPTER_FILE = TRUST_FILES[0];
const HASH_DOMAIN = "asterweave-trust-v1";
/** Shown when trust.json cannot be read; the store is never rewritten by a read. */
export const TRUST_STORE_WARNING = "trust store unreadable: run asterweave trust revoke/grant to recreate";
/** Remediation for a corrupt trust.json: consistent with TRUST_STORE_WARNING (grant/revoke replace the file). */
export const TRUST_STORE_CORRUPT_REMEDIATION = "Run `asterweave trust revoke` or `asterweave trust grant` (with --path) to replace it with a fresh store; nothing else stays trusted.";

/** Repository trust is required for the requested purpose (exit 4). */
export class TrustError extends CliError {
  /** @param {string} message @param {{repoPath: string, status?: object, remediation?: string}} details */
  constructor(message, { repoPath, status, remediation }) {
    super(message, { code: "TRUST_REQUIRED", exitCode: EXIT.TRUST, remediation });
    this.repoPath = repoPath;
    this.status = status;
  }
}

/**
 * @typedef {object} TrustOptions
 * @property {Record<string,string|undefined>} [env]   Used to locate the user directory.
 * @property {string} [platform]
 * @property {() => string} [homedir]
 * @property {string} [trustFile]   Explicit trust.json path (overrides the user directory).
 * @property {typeof nodeFs} [fs]
 * @property {() => string} [now]   ISO timestamp provider (tests).
 * @property {string} [expectedHash]   grantTrust only: the hash the user reviewed; a mismatch refuses the grant.
 */

function trustFilePath(options) {
  return options.trustFile ?? userFilePath("trust", options);
}

/**
 * Canonical identity of a repository: its realpath (symlinks, junctions and 8.3 names resolved).
 * Throws a CliError when the path does not exist.
 * @param {string} repoPath
 * @param {{fs?: typeof nodeFs, platform?: string}} [options]
 * @returns {{realpath: string, key: string}}  `key` is the normalised form used in trust.json.
 */
export function repositoryIdentity(repoPath, { fs = nodeFs, platform = process.platform } = {}) {
  let realpath;
  try {
    realpath = (fs.realpathSync.native ?? fs.realpathSync)(path.resolve(repoPath));
  } catch (error) {
    throw new CliError(`Repository path does not exist or is unreadable: ${repoPath}`, {
      code: "REPO_PATH_INVALID",
      exitCode: EXIT.ERROR,
      remediation: "Pass an existing repository directory with --path.",
      cause: error,
    });
  }
  return { realpath, key: platform === "win32" ? realpath.toLowerCase() : realpath };
}

function frame(hash, label, content) {
  hash.update(`${label}\0`);
  if (content === null) {
    hash.update("MISSING\0");
  } else if (typeof content === "string") {
    hash.update(`${content}\0`);
  } else {
    hash.update(`${content.length}\0`);
    hash.update(content);
    hash.update("\0");
  }
}

/**
 * Hash the repository's trust-governing files. Each file contributes its relative name, then either
 * a MISSING marker, a DIRECTORY/UNREADABLE marker, or its length and bytes, so content can never
 * migrate between files without changing the hash. The repository realpath is part of the input.
 *
 * @param {string} repoPath
 * @param {{fs?: typeof nodeFs, platform?: string}} [options]
 * @returns {{realpath: string, key: string, hash: string, files: Array<{file: string, state: 'present'|'missing'|'unreadable'}>}}
 */
export function computeTrustHash(repoPath, options = {}) {
  const fs = options.fs ?? nodeFs;
  const { realpath, key } = repositoryIdentity(repoPath, options);
  const hash = createHash("sha256");
  frame(hash, HASH_DOMAIN, key);
  const files = [];
  let adapter = { bytes: null, state: "missing" };
  let mcp = { bytes: null, state: "missing" };
  for (const relative of TRUST_FILES) {
    const absolute = path.join(realpath, ...relative.split("/"));
    let content = null;
    let state = "present";
    try {
      content = fs.readFileSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        state = "missing";
      } else {
        state = "unreadable"; // e.g. EISDIR or EACCES: still deterministic, never "missing"
        content = `UNREADABLE:${error?.code ?? "UNKNOWN"}`;
      }
    }
    frame(hash, relative, content);
    files.push({ file: relative, state });
    if (relative === ADAPTER_FILE) adapter = { bytes: state === "present" ? Buffer.from(content) : null, state };
    if (relative === TRUST_FILES[3]) mcp = { bytes: state === "present" ? Buffer.from(content) : null, state };
  }
  // `adapter` carries the exact bytes of .claude/asterweave.json that went into the hash, so a caller
  // that parses the adapter parses what was hashed (no second read, no check/use gap). It is not
  // enumerable: it never shows up in JSON output or deep-equality comparisons.
  const result = { realpath, key, hash: hash.digest("hex"), files };
  Object.defineProperty(result, "adapter", { value: adapter, enumerable: false });
  // Likewise the exact bytes of .mcp.json that were hashed: `mcp test` parses these, never a second read.
  Object.defineProperty(result, "mcp", { value: mcp, enumerable: false });
  return result;
}

/**
 * Current trust state of a repository.
 *
 * `reason`: `TRUSTED`, `NOT_GRANTED` (never trusted), or `CHANGED` (trusted before, but the
 * governing files changed since — `previousHash` is the granted hash).
 *
 * @param {string} repoPath
 * @param {TrustOptions} [options]
 * @returns {{trusted: boolean, reason: 'TRUSTED'|'NOT_GRANTED'|'CHANGED', realpath: string, hash: string,
 *            trustedAt: string|null, previousHash?: string, files: Array<{file: string, state: string}>}}
 */
export function trustStatus(repoPath, options = {}) {
  return statusFor(computeTrustHash(repoPath, options), options);
}

/** Compare an already computed hash with the stored entry (throws StoreError when trust.json is unreadable). */
function statusFor(computed, options) {
  let store;
  try {
    store = readJson(trustFilePath(options), { fallback: {}, fs: options.fs });
  } catch (error) {
    // The generic "fix or delete the file" advice would contradict TRUST_STORE_WARNING: for trust.json, grant/revoke recreate it.
    if (error instanceof StoreError && error.reason === "CORRUPT") error.remediation = TRUST_STORE_CORRUPT_REMEDIATION;
    throw error;
  }
  const entry = store && typeof store === "object" && !Array.isArray(store) ? store[computed.key] : undefined;
  const base = { realpath: computed.realpath, hash: computed.hash, files: computed.files };
  const withAdapter = (status) => Object.defineProperty(Object.defineProperty(status, "adapter", { value: computed.adapter, enumerable: false }), "mcp", { value: computed.mcp, enumerable: false });
  if (!entry || typeof entry.sha256 !== "string") return withAdapter({ trusted: false, reason: "NOT_GRANTED", trustedAt: null, ...base });
  if (entry.sha256 !== computed.hash) return withAdapter({ trusted: false, reason: "CHANGED", trustedAt: entry.trustedAt ?? null, previousHash: entry.sha256, ...base });
  return withAdapter({ trusted: true, reason: "TRUSTED", trustedAt: entry.trustedAt ?? null, ...base });
}

/**
 * Like `trustStatus`, but a trust.json that cannot be read or parsed yields an UNTRUSTED status
 * (`reason: 'STORE_UNREADABLE'`, plus `warning`) instead of throwing. For read-only consumers that
 * never need trust to function (launch, repo status, doctor, config): untrusted is the fail-closed
 * answer for anything executable. The file is never modified by a read.
 */
export function safeTrustStatus(repoPath, options = {}) {
  const computed = computeTrustHash(repoPath, options); // hashed once: the status and its hash describe the same read
  try {
    return statusFor(computed, options);
  } catch (error) {
    if (!(error instanceof StoreError)) throw error;
    const status = { trusted: false, reason: "STORE_UNREADABLE", trustedAt: null, warning: TRUST_STORE_WARNING, realpath: computed.realpath, hash: computed.hash, files: computed.files };
    return Object.defineProperty(status, "adapter", { value: computed.adapter, enumerable: false });
  }
}

/**
 * Existing store for a read-modify-write. A corrupt file (invalid JSON, or JSON that is not an
 * object) is replaced: an explicit grant/revoke recreates it, trusting nothing. `recreated` tells
 * the caller that the file on disk was not a usable store. An unreadable file still throws.
 * @returns {{store: Record<string, unknown>, recreated: boolean}}
 */
function readStoreForUpdate(file, fs) {
  let parsed;
  try {
    parsed = readJson(file, { fallback: {}, fs });
  } catch (error) {
    if (error instanceof StoreError && error.reason === "CORRUPT") return { store: {}, recreated: true };
    throw error;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { store: { ...parsed }, recreated: false };
  return { store: {}, recreated: true };
}

// Store lock ------------------------------------------------------------------------------------
//
// grant/revoke are read-modify-write on one file shared by every repository, so two processes granting
// different repositories at once could each read the old store and the second rename would drop the
// first entry. A sidecar lock (`trust.json.lock`, created exclusively with flag 'wx') serialises them.
// It records the owner's pid, a timestamp and a random token; it is released in a finally block and
// only if the token is still ours. A lock older than LOCK_STALE_MS belongs to a process that died and is
// taken over. Waiting is bounded (LOCK_TIMEOUT_MS) and ends in a typed TRUST_STORE_BUSY error.

const LOCK_TIMEOUT_MS = 2000;
const LOCK_STALE_MS = 30_000;
const LOCK_BACKOFF_MS = [5, 10, 20, 40, 80, 160];
// Creating the lock fails with EEXIST when it is held. On Windows an antivirus scanner or a pending
// delete also surfaces as EPERM/EBUSY; on POSIX EPERM is a real permission problem, never contention.
const CONTENTION_WIN32 = new Set(["EEXIST", "EPERM", "EBUSY"]);
const CONTENTION_POSIX = new Set(["EEXIST", "EBUSY"]);

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Text of the lock file, or null when it is gone. Any other error propagates (the lock is "held"). */
function readLock(lockFile, fs) {
  try {
    return fs.readFileSync(lockFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function lockBusyError(lockFile, message, cause, platform) {
  return new CliError(message, {
    code: "TRUST_STORE_BUSY",
    exitCode: EXIT.ERROR,
    remediation: `Retry in a moment. If no other asterweave command is running, ${suggestCommand("remove the stale lock file ", lockFile, " and retry.", platform)}`,
    cause,
  });
}

/**
 * Look at a lock that blocked us and remove it when its owner is gone.
 * Returns "removed" (a stale lock was removed), "gone" (it vanished) or "held" (a live lock, or one we
 * could not judge). The caller waits and tries to create the lock again in every case. Nothing is
 * concluded from an error other than ENOENT: an unreadable lock is a held lock. Throws
 * TRUST_STORE_BUSY for a lock path that is not a regular file (a directory or link we never created).
 */
function inspectLock(lockFile, { fs, now, staleMs, token, platform }) {
  let info;
  try {
    info = fs.lstatSync(lockFile);
  } catch (error) {
    return error?.code === "ENOENT" ? "gone" : "held";
  }
  if (!info.isFile()) {
    throw lockBusyError(lockFile, `The trust store lock ${lockFile} exists but is not a regular file, so it is not a lock Asterweave created.`, undefined, platform);
  }
  let text;
  try {
    text = readLock(lockFile, fs);
  } catch {
    return "held";
  }
  if (text === null) return "gone";
  let acquiredAt;
  try {
    acquiredAt = JSON.parse(text)?.at;
  } catch {
    // An unparseable lock falls back to the file's modification time below.
  }
  if (typeof acquiredAt !== "number") acquiredAt = info.mtimeMs;
  if (now() - acquiredAt <= staleMs) return "held";
  // Re-check the content right before moving it: a different text means someone replaced the lock.
  try {
    if (readLock(lockFile, fs) !== text) return "held";
  } catch {
    return "held";
  }
  // Move it aside, then VERIFY what was moved. The check above and the rename are not atomic: another
  // taker may have removed the stale lock and created its own LIVE one in between, and rename moves
  // whatever sits at the path. If the moved file is not the stale text, put it back with a hard link
  // (which, unlike rename, fails if the path has been taken again) and do not acquire.
  const aside = `${lockFile}.stale-${token}`;
  try {
    fs.renameSync(lockFile, aside);
  } catch (error) {
    return error?.code === "ENOENT" ? "gone" : "held";
  }
  let moved = null;
  try {
    moved = readLock(aside, fs);
  } catch {
    // Unreadable copy: treated like a different text below (restored, not removed).
  }
  if (moved !== text) {
    try {
      fs.linkSync(aside, lockFile);
    } catch {
      // The path is taken again by a newer lock; the displaced one cannot be restored over it.
    }
    try {
      fs.unlinkSync(aside);
    } catch {
      // Best effort: a leftover `.stale-*` file is harmless.
    }
    return "held";
  }
  try {
    fs.unlinkSync(aside);
  } catch {
    // Best effort: a leftover `.stale-*` file is harmless.
  }
  return "removed";
}

/**
 * Run `fn` while holding the trust store lock. Always releases it (when it is still ours).
 *
 * Every failed attempt sleeps its backoff and counts toward the wait, whatever the lock looks like, so
 * a lock that can be neither created nor read still ends in TRUST_STORE_BUSY within the timeout. Two
 * processes taking over the same stale lock are not separated by the rename alone: `inspectLock`
 * verifies what it moved and restores a live lock it displaced. A narrow window remains in which the
 * restored lock is briefly absent, so this is a best-effort guard for crash recovery, not a mutex.
 * @template T
 * @param {string} file  trust.json path
 * @param {TrustOptions & {sleep?: (ms: number) => void, lockTimeoutMs?: number, lockStaleMs?: number, lockNow?: () => number}} options
 * @param {() => T} fn
 * @returns {T}
 * @throws {CliError} TRUST_STORE_BUSY (exit 1) when the lock stays held for the whole wait
 */
function withStoreLock(file, options, fn) {
  const fs = options.fs ?? nodeFs;
  const sleep = options.sleep ?? sleepSync;
  const now = options.lockNow ?? Date.now;
  const timeoutMs = options.lockTimeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.lockStaleMs ?? LOCK_STALE_MS;
  const platform = options.platform ?? process.platform;
  const contention = platform === "win32" ? CONTENTION_WIN32 : CONTENTION_POSIX;
  const lockFile = `${file}.lock`;
  const token = randomBytes(8).toString("hex");
  const body = JSON.stringify({ pid: process.pid, at: now(), token });
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    // The write below reports an unusable directory with the proper error.
  }
  let waited = 0;
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.writeFileSync(lockFile, body, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if (!contention.has(error?.code)) {
        throw new StoreError(`Cannot lock ${file}: ${error?.message ?? error}`, { file, reason: "WRITE_FAILED", cause: error });
      }
      inspectLock(lockFile, { fs, now, staleMs, token, platform });
      if (waited >= timeoutMs) {
        throw lockBusyError(lockFile, `The trust store ${file} is being updated by another Asterweave process (waited ${timeoutMs} ms).`, error, platform);
      }
      const delay = Math.min(LOCK_BACKOFF_MS[Math.min(attempt, LOCK_BACKOFF_MS.length - 1)], timeoutMs - waited);
      sleep(delay);
      waited += delay;
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (JSON.parse(readLock(lockFile, fs) ?? "null")?.token === token) fs.unlinkSync(lockFile);
    } catch {
      // The lock is gone or no longer ours; nothing to release.
    }
  }
}

/**
 * Trust the repository in its current state (records the current hash).
 * @param {string} repoPath
 * @param {TrustOptions} [options]
 * @returns {{trusted: true, realpath: string, hash: string, trustedAt: string}}
 */
export function grantTrust(repoPath, options = {}) {
  const computed = computeTrustHash(repoPath, options);
  // A grant is bound to what the user reviewed: when the caller passes the hash it previewed, the
  // governing files must still hash to it, otherwise nothing is recorded.
  if (options.expectedHash !== undefined && computed.hash !== options.expectedHash) {
    throw new CliError(`The trust-governing files of ${computed.realpath} changed after they were reviewed; trust was not granted.`, {
      code: "TRUST_CHANGED_DURING_GRANT",
      exitCode: EXIT.ERROR,
      remediation: suggestCommand("Review the repository config again, then rerun trust grant: asterweave trust grant --path ", computed.realpath),
    });
  }
  const file = trustFilePath(options);
  const trustedAt = (options.now ?? (() => new Date().toISOString()))();
  withStoreLock(file, options, () => {
    const { store: next } = readStoreForUpdate(file, options.fs);
    next[computed.key] = { sha256: computed.hash, trustedAt };
    writeJsonAtomic(file, next, options.fs ? { fs: options.fs } : undefined);
  });
  return { trusted: true, realpath: computed.realpath, hash: computed.hash, trustedAt };
}

/**
 * Remove trust for the repository. Idempotent. When the existing store is corrupt it is replaced by
 * a fresh empty one (`recreated: true`, `removed: false`): that is how a user recovers from a corrupt
 * trust.json, and nothing stays trusted.
 * @param {string} repoPath
 * @param {TrustOptions} [options]
 * @returns {{trusted: false, realpath: string, hash: string, removed: boolean, recreated: boolean}}
 */
export function revokeTrust(repoPath, options = {}) {
  const computed = computeTrustHash(repoPath, options);
  const file = trustFilePath(options);
  const { removed, recreated } = withStoreLock(file, options, () => {
    const { store: next, recreated: replaced } = readStoreForUpdate(file, options.fs);
    const had = Object.hasOwn(next, computed.key);
    if (had) delete next[computed.key];
    if (had || replaced) writeJsonAtomic(file, next, options.fs ? { fs: options.fs } : undefined);
    return { removed: had, recreated: replaced };
  });
  return { trusted: false, realpath: computed.realpath, hash: computed.hash, removed, recreated };
}

/**
 * Throw `TrustError` (exit 4) unless the repository is currently trusted.
 * @param {string} repoPath
 * @param {string} purpose  Human description of what needs trust, e.g. "run quality gates".
 * @param {TrustOptions} [options]
 * @returns {ReturnType<typeof trustStatus>} the (trusted) status
 */
export function assertTrusted(repoPath, purpose, options = {}) {
  const status = trustStatus(repoPath, options);
  if (status.trusted) return status;
  const why = status.reason === "CHANGED" ? "its trust-governing files changed since trust was granted" : "it has not been trusted";
  throw new TrustError(`Cannot ${purpose}: repository ${status.realpath} is untrusted (${why}).`, {
    repoPath: status.realpath,
    status,
    remediation: suggestCommand("Review .claude/asterweave.json, .claude/settings*.json and .mcp.json, then run: asterweave trust grant --path ", status.realpath),
  });
}

/**
 * Quality-gate command and repository hook findings in the text of .claude/asterweave.json (none when it does not
 * parse). Hooks are executable config: every entry of the `hooks` key is a finding (field names only, never the argv).
 */
function gateFindings(text) {
  const found = [];
  try {
    const adapter = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const gates = adapter?.qualityGates?.required;
    if (Array.isArray(gates)) {
      gates.forEach((gate, index) => {
        if (gate && typeof gate === "object" && "command" in gate) {
          found.push({ field: `qualityGates.required[${index}].command`, file: ADAPTER_FILE, kind: "command" });
        }
      });
    }
    const hooks = adapter?.hooks;
    if (Array.isArray(hooks)) {
      hooks.forEach((_hook, index) => {
        found.push({ field: `hooks[${index}].argv`, file: ADAPTER_FILE, kind: "hook" });
      });
    }
  } catch {
    // Unparseable adapter: config validation reports it; nothing executable can be read from it.
  }
  return found;
}

/**
 * Executable-config findings derived from a trust status, i.e. from the very bytes (and file states)
 * that went into its hash: no second read of the repository, so what a preview lists is exactly what
 * a grant covers. A settings or MCP file that exists but cannot be read still counts as a finding.
 * @param {{adapter?: {bytes: Buffer|null, state: string}, files: Array<{file: string, state: string}>}} status
 * @returns {Array<{field: string, file: string, kind: 'command'|'settings'|'mcp'}>}
 */
export function classifyExecutableFromStatus(status) {
  const found = [];
  if (status.adapter?.state === "present" && status.adapter.bytes) found.push(...gateFindings(status.adapter.bytes.toString("utf8")));
  const exists = (relative) => status.files.some((item) => item.file === relative && item.state !== "missing");
  for (const relative of TRUST_FILES.slice(1, 3)) if (exists(relative)) found.push({ field: relative, file: relative, kind: "settings" });
  if (exists(TRUST_FILES[3])) found.push({ field: TRUST_FILES[3], file: TRUST_FILES[3], kind: "mcp" });
  return found;
}

/**
 * Which repository config can make code run. Pure inspection (no trust decision).
 *
 * - `qualityGates.required[i].command` in `.claude/asterweave.json`: shell commands Asterweave runs.
 * - `.claude/settings.json`, `.claude/settings.local.json`: presence (even unreadable) means `claude` run in the
 *   repo loads hooks, env, helpers and permissions from it.
 * - `.mcp.json`: presence (even unreadable) means `claude` run in the repo may start MCP servers.
 *
 * @param {string} repoPath
 * @param {{fs?: typeof nodeFs}} [options]
 * @returns {Array<{field: string, file: string, kind: 'command'|'settings'|'mcp'}>}
 */
export function classifyExecutableConfig(repoPath, { fs = nodeFs } = {}) {
  const root = (fs.realpathSync.native ?? fs.realpathSync)(path.resolve(repoPath));
  const found = [];
  // Same notion as the hash and `classifyExecutableFromStatus`: anything but ENOENT/ENOTDIR counts as present
  // (a directory or an unreadable file is a finding, fail-closed).
  const present = (relative) => {
    try {
      fs.statSync(path.join(root, ...relative.split("/")));
      return true;
    } catch (error) {
      return !(error?.code === "ENOENT" || error?.code === "ENOTDIR");
    }
  };
  if (present(".claude/asterweave.json")) {
    try {
      found.push(...gateFindings(fs.readFileSync(path.join(root, ".claude", "asterweave.json"), "utf8")));
    } catch {
      // Unreadable adapter: config validation reports it; nothing executable can be read from it.
    }
  }
  for (const relative of [".claude/settings.json", ".claude/settings.local.json"]) {
    if (present(relative)) found.push({ field: relative, file: relative, kind: "settings" });
  }
  if (present(".mcp.json")) found.push({ field: ".mcp.json", file: ".mcp.json", kind: "mcp" });
  return found;
}
