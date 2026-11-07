// Small JSON file store: atomic writes (temp file + rename), 0600 on POSIX, and tolerant reads.

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./exit-codes.mjs";

/** Raised when a stored file exists but cannot be read or parsed as JSON. */
export class StoreError extends CliError {
  /** @param {string} message @param {{file: string, reason: 'CORRUPT'|'UNREADABLE'|'WRITE_FAILED', cause?: unknown}} details */
  constructor(message, { file, reason, cause }) {
    super(message, {
      code: `STORE_${reason}`,
      exitCode: EXIT.ERROR,
      remediation: reason === "CORRUPT" ? `Fix or delete ${file} and retry.` : undefined,
      cause,
    });
    this.file = file;
    this.reason = reason;
  }
}

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read and parse a JSON file.
 *
 * A missing file yields `fallback`. An unreadable file or malformed JSON throws `StoreError`
 * (reason `UNREADABLE` / `CORRUPT`); the file is never modified or deleted by a read.
 *
 * @template T
 * @param {string} file
 * @param {{fallback?: T, fs?: typeof nodeFs}} [options]
 * @returns {T | unknown}
 */
export function readJson(file, { fallback = null, fs = nodeFs } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return fallback;
    throw new StoreError(`Cannot read ${file}: ${error?.message ?? error}`, { file, reason: "UNREADABLE", cause: error });
  }
  return parseJsonText(text, file, fallback);
}

/**
 * Parse JSON text that has already been read (BOM tolerated, empty text yields `fallback`). Lets a
 * caller parse the very bytes it hashed or inspected instead of reading the file a second time.
 * @throws {StoreError} reason CORRUPT
 */
export function parseJsonText(text, file, fallback = null) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return fallback;
  try {
    return JSON.parse(text);
  } catch (error) {
    // JSON.parse's message quotes a snippet of the (possibly attacker-controlled) file: never include it.
    throw new StoreError(`${file} is not valid JSON.`, { file, reason: "CORRUPT", cause: error });
  }
}

/**
 * Atomically write `value` as pretty JSON: temp file in the same directory, then rename over the
 * target. Retries EPERM/EBUSY/EACCES (Windows antivirus / indexer locks) with a short backoff.
 * Creates parent directories. Mode 0600 on POSIX (directory 0700 when created).
 *
 * @param {string} file
 * @param {unknown} value
 * @param {{fs?: typeof nodeFs, sleep?: (ms: number) => void, platform?: string}} [options]
 */
export function writeJsonAtomic(file, value, { fs = nodeFs, sleep = sleepSync, platform = process.platform } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const directory = path.dirname(file);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new StoreError(`Cannot create ${directory}: ${error.message}`, { file, reason: "WRITE_FAILED", cause: error });
  }
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" }); // exclusive: never follow a planted file or link
    if (platform !== "win32") fs.chmodSync(temporary, 0o600);
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(temporary, file);
        return;
      } catch (error) {
        if (!RETRYABLE.has(error?.code) || attempt >= RETRY_DELAYS_MS.length) throw error;
        sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw new StoreError(`Cannot write ${file}: ${error.message}`, { file, reason: "WRITE_FAILED", cause: error });
  }
}

/** Delete a file if present. Returns true when something was removed. */
export function removeFile(file, { fs = nodeFs } = {}) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new StoreError(`Cannot remove ${file}: ${error.message}`, { file, reason: "WRITE_FAILED", cause: error });
  }
}
