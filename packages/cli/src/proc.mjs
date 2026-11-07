// Child-process helpers. Policy: never a shell, always argument arrays, injectable `spawn`.
// Node 22 refuses to spawn `.cmd`/`.bat` without a shell (CVE-2024-27980 mitigation) and we never
// use a shell, so `resolveBinary` reports shim-only installs instead of trying to run them.

import { spawn as nodeSpawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const KILL_GRACE_MS = 2_000;

/**
 * @typedef {object} RunResult
 * @property {number|null} code       Exit code; null when killed by a signal or the spawn failed.
 * @property {string|null} signal     Terminating signal, if any.
 * @property {string} stdout
 * @property {string} stderr
 * @property {(Error & {code?: string})|null} error  Spawn failure (e.g. ENOENT) or a timeout (`code: 'ETIMEDOUT'`).
 * @property {boolean} timedOut
 * @property {boolean} truncated      True when stdout or stderr exceeded `maxOutputBytes` (excess is dropped).
 */

/**
 * Run a command to completion with captured output. Never throws and never uses a shell.
 *
 * @param {string} cmd   Executable (use `resolveBinary` first for PATH lookups on Windows).
 * @param {string[]} [args]
 * @param {{cwd?: string, env?: Record<string,string|undefined>, timeoutMs?: number, input?: string|Buffer,
 *          maxOutputBytes?: number, spawn?: Function}} [options]
 *   `timeoutMs` 0 disables the timeout; `killGraceMs` is how long a child may ignore SIGTERM before SIGKILL. `env` replaces the environment entirely when given.
 *   Without `input`, the child's stdin is closed (`ignore`) so it can never hang waiting for input.
 * @returns {Promise<RunResult>}
 */
export function run(cmd, args = [], { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, input, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES, spawn = nodeSpawn, killGraceMs = KILL_GRACE_MS } = {}) {
  return new Promise((resolve) => {
    const result = { code: null, signal: null, stdout: "", stderr: "", error: null, timedOut: false, truncated: false };
    let settled = false;
    let timer = null;
    let killTimer = null;
    let child;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      resolve(result);
    };

    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      result.error = error;
      finish();
      return;
    }

    const capture = (stream, key) => {
      if (!stream || typeof stream.on !== "function") return;
      const decoder = new StringDecoder("utf8");
      let bytes = 0;
      stream.on("data", (chunk) => {
        const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
        const room = maxOutputBytes - bytes;
        if (room <= 0) {
          result.truncated = true; // keep draining so the child never blocks on a full pipe
          return;
        }
        const slice = buffer.length > room ? buffer.subarray(0, room) : buffer;
        if (buffer.length > room) result.truncated = true;
        bytes += slice.length;
        result[key] += decoder.write(slice);
      });
      stream.on("error", () => {});
    };
    capture(child.stdout, "stdout");
    capture(child.stderr, "stderr");

    if (input !== undefined && child.stdin) {
      child.stdin.on?.("error", () => {}); // EPIPE when the child exits before reading
      child.stdin.end(input);
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        result.timedOut = true;
        result.error = Object.assign(new Error(`${cmd} timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" });
        try {
          child.kill("SIGTERM");
        } catch {
          // Already gone.
        }
        killTimer = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            // Already gone.
          }
          finish(); // a child that ignores SIGKILL's close event must not hang the caller
        }, killGraceMs);
        killTimer.unref?.();
      }, timeoutMs);
      timer.unref?.();
    }

    child.on("error", (error) => {
      if (!result.error) result.error = error;
      // A child that never started emits no (reliable) close event.
      if (child.pid === undefined) finish();
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      result.code = code ?? null;
      result.signal = signal ?? null;
      finish();
    });
  });
}

/**
 * Run a command with the parent's terminal attached (stdin/stdout/stderr inherited) for interactive
 * hand-off such as `gh auth login --web`. Never throws; no output is captured.
 *
 * Aborting (`signal`) terminates the child. The caller decides what an interrupted hand-off means
 * (e.g. exit 130 and write no state): a non-zero `code`, a non-null `signal`, or `aborted: true`.
 *
 * @param {string} cmd
 * @param {string[]} [args]
 * @param {{cwd?: string, env?: Record<string,string|undefined>, spawn?: Function, signal?: AbortSignal}} [options]
 * @returns {Promise<{code: number|null, signal: string|null, error: Error|null, aborted: boolean}>}
 */
export function runInherited(cmd, args = [], { cwd, env, spawn = nodeSpawn, signal } = {}) {
  return new Promise((resolve) => {
    const result = { code: null, signal: null, error: null, aborted: false };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    let child;
    const onAbort = () => {
      result.aborted = true;
      try {
        child?.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    };
    if (signal?.aborted) {
      result.aborted = true;
      resolve(result);
      return;
    }
    try {
      child = spawn(cmd, args, { cwd, env, shell: false, windowsHide: false, stdio: "inherit" });
    } catch (error) {
      result.error = error;
      finish();
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    child.on("error", (error) => {
      result.error = error;
      if (child.pid === undefined) finish();
    });
    child.on("close", (code, termination) => {
      if (settled) return;
      result.code = code ?? null;
      result.signal = termination ?? null;
      finish();
    });
  });
}

// ---------------------------------------------------------------------------------------------
// Binary resolution

const NATIVE_EXTENSIONS = [".exe", ".com"];
const SHIM_EXTENSIONS = [".cmd", ".bat"];

/** Default existence check: a regular file that is executable on POSIX. */
export function isExecutableFile(file, platform = process.platform) {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== "win32") accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function envLookup(env, key, platform) {
  if (platform !== "win32") return env[key];
  const actual = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actual === undefined ? undefined : env[actual];
}

/**
 * Find an executable on PATH without a shell.
 *
 * On win32 the lookup is case-insensitive for PATH/PATHEXT, honours PATHEXT, scans ALL PATH
 * directories for a native `.exe`/`.com` before settling for a shell shim, and prefers `.exe`
 * over `.cmd`/`.bat` (an npm `.cmd` shim often precedes the native binary on PATH).
 *
 * Relative PATH entries (including `.` and empty entries) and relative command names with a
 * separator are ignored, so the result is always an absolute path and the current directory is
 * never searched. `runBinary` spawns that absolute path, never the bare name.
 *
 * @param {string} name   Command name, with or without extension.
 * @param {{env?: Record<string,string|undefined>, platform?: string, exists?: (file: string) => boolean}} [options]
 * @returns {{path: string, candidates: string[]} | {reason: 'NOT_FOUND'|'SHELL_SHIM_ONLY', candidates: string[]}}
 *   `candidates` lists every matching file in PATH order (shims included).
 */
export function resolveBinary(name, { env = process.env, platform = process.platform, exists } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const check = exists ?? ((file) => isExecutableFile(file, platform));
  const delimiter = platform === "win32" ? ";" : ":";
  // Only absolute locations are ever considered: a relative PATH entry (`.`, an empty entry, `bin`,
  // `\x`, `C:x`) resolves against the current directory, i.e. possibly an untrusted clone.
  const isAbsolute = (value) => (platform === "win32" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value) : value.startsWith("/"));
  const hasSeparator = /[\\/]/.test(name) && (platform === "win32" || name.includes("/"));
  const directories = hasSeparator
    ? isAbsolute(name) ? [""] : []
    : (envLookup(env, "PATH", platform) ?? "")
        .split(delimiter)
        .map((entry) => (platform === "win32" ? entry.replace(/^"(.*)"$/, "$1") : entry).trim())
        .filter((entry) => entry && isAbsolute(entry));

  let suffixes = [""];
  if (platform === "win32") {
    const configured = (envLookup(env, "PATHEXT", platform) ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter(Boolean);
    const known = [...NATIVE_EXTENSIONS, ...SHIM_EXTENSIONS];
    // Always consider the four we classify, in preference order, even when PATHEXT omits some.
    const ordered = [...new Set([...NATIVE_EXTENSIONS.filter((ext) => configured.includes(ext)), ...SHIM_EXTENSIONS.filter((ext) => configured.includes(ext))])];
    suffixes = known.includes(p.extname(name).toLowerCase()) ? [""] : ordered.length ? ordered : known;
  }

  const candidates = [];
  for (const directory of directories) {
    for (const suffix of suffixes) {
      const file = directory ? p.join(directory, `${name}${suffix}`) : `${name}${suffix}`;
      if (check(file)) candidates.push(file);
    }
  }

  const native = candidates.find((file) => platform !== "win32" || NATIVE_EXTENSIONS.includes(p.extname(file).toLowerCase()));
  if (native) return { path: native, candidates };
  if (candidates.length > 0) return { reason: "SHELL_SHIM_ONLY", candidates };
  return { reason: "NOT_FOUND", candidates };
}

/**
 * Resolve then run. If the binary cannot be resolved, nothing is spawned and the result carries
 * `error.code` of `'NOT_FOUND'` or `'SHELL_SHIM_ONLY'`.
 *
 * @param {string} name
 * @param {string[]} args
 * @param {Parameters<typeof run>[2] & {platform?: string, exists?: (file: string) => boolean}} [options]
 *   `env` is also used for PATH lookup (defaults to process.env for lookup, child env unchanged).
 * @returns {Promise<RunResult & {resolution: ReturnType<typeof resolveBinary>}>}
 */
export async function runBinary(name, args = [], options = {}) {
  const { platform, exists, ...runOptions } = options;
  const resolution = resolveBinary(name, { env: options.env ?? process.env, platform, exists });
  if (!resolution.path) {
    const message = resolution.reason === "SHELL_SHIM_ONLY" ? `${name} is only available as a shell shim (${resolution.candidates.join(", ")})` : `${name} was not found on PATH`;
    return {
      code: null, signal: null, stdout: "", stderr: "", timedOut: false, truncated: false,
      error: Object.assign(new Error(message), { code: resolution.reason }),
      resolution,
    };
  }
  return { ...(await run(resolution.path, args, runOptions)), resolution };
}
