// Shared plumbing for the credential planes: probe cwd, tolerant JSON extraction, and the
// interactive hand-off used by `auth login`. Nothing here ever sees or stores a token.

import { mkdirSync } from "node:fs";
import { CliError, EXIT } from "../exit-codes.mjs";
import { resolveUserDir } from "../paths.mjs";
import { resolveBinary, runInherited } from "../proc.mjs";

/**
 * Working directory for provider probes: the Asterweave user directory, so a repository's
 * `.claude/settings.json` / `.mcp.json` is never loaded by `claude`. Created if missing. Fails
 * closed (CliError USER_DIR_UNAVAILABLE) when it cannot be created: the shared OS temp directory
 * is never used, because another local user could plant `.claude/settings.json` or `.mcp.json` there.
 */
export function probeCwd({ env = process.env, platform = process.platform, homedir, mkdir = mkdirSync } = {}) {
  const directory = resolveUserDir({ env, platform, homedir });
  try {
    mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  } catch (error) {
    throw new CliError(`Cannot use the Asterweave user directory ${directory} (${error?.code ?? "unavailable"}).`, {
      code: "USER_DIR_UNAVAILABLE",
      exitCode: EXIT.ERROR,
      remediation: `Make ${directory} writable, or set ASTERWEAVE_CONFIG_DIR to a writable absolute directory.`,
      cause: error,
    });
  }
}

/** Parse a JSON object from provider output, tolerating banner lines before/after it. */
export function parseJsonObject(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  const accept = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : null);
  try {
    return accept(JSON.parse(trimmed));
  } catch {
    // Fall through to the tolerant path.
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return accept(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
  return null;
}

/** Error for a login that did not complete (Ctrl+C, abort, signal, or non-zero child exit). Exit 130. */
export function interruptedLogin(label) {
  return new CliError(`${label} sign-in was interrupted; nothing was saved.`, {
    code: "LOGIN_INTERRUPTED",
    exitCode: EXIT.INTERRUPTED,
  });
}

/**
 * Hand the terminal to a provider login command and classify the outcome.
 * Resolves on a clean exit 0; throws CliError otherwise:
 *   - binary missing / shim-only  -> exit 3 with the caller's codes
 *   - aborted, signalled, non-zero exit -> LOGIN_INTERRUPTED, exit 130
 *   - the child could not start   -> `<LABEL>_LOGIN_FAILED`, exit 1
 */
export async function handoffLogin({ binary, args, label, codes, installRemediation, env, spawn, exists, platform, cwd, signal }) {
  const resolution = resolveBinary(binary, { env, platform, exists });
  if (!resolution.path) {
    const shim = resolution.reason === "SHELL_SHIM_ONLY";
    throw new CliError(shim ? `${binary} is only installed as a shell shim, which Asterweave does not run.` : `${binary} was not found on PATH.`, {
      code: shim ? codes.shim : codes.notInstalled,
      exitCode: EXIT.AUTH,
      remediation: installRemediation,
    });
  }
  if (signal?.aborted) throw interruptedLogin(label);
  const result = await runInherited(resolution.path, args, { cwd, env, spawn, signal });
  if (result.aborted || result.signal) throw interruptedLogin(label);
  if (result.error && result.code === null) {
    throw new CliError(`${label} sign-in could not start: ${result.error.message}`, { code: codes.loginFailed, exitCode: EXIT.ERROR, cause: result.error });
  }
  if (result.code !== 0) throw interruptedLogin(label);
}
