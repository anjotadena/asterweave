// Helpers shared by the auth, config and trust commands (not a command itself).

import * as nodeFs from "node:fs";
import { normalizeHost } from "../auth/github.mjs";
import { resolveConfig } from "../config.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { repoFilePath } from "../repo.mjs";
import { readJson } from "../store.mjs";
import { createTerminal } from "../tui/terminal.mjs";

/** Whether stdin and stdout are both a usable interactive terminal. */
export function isInteractive(ctx) {
  return createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env }).isInteractive;
}

/** Environment and filesystem seams forwarded to library calls; only what the caller provided. */
export function seams(ctx, extra = []) {
  const out = { env: ctx.env };
  for (const key of ["platform", "homedir", "fs", ...extra]) if (ctx[key] !== undefined) out[key] = ctx[key];
  return out;
}

/**
 * Repository the config/trust commands act on: the connected clone (repo.json) when it still
 * exists, otherwise the current directory. A missing or unreadable repo.json is not an error here.
 * @returns {{path: string, source: 'connected'|'cwd'}}
 */
export function defaultRepoPath(ctx) {
  const options = seams(ctx);
  try {
    const record = readJson(repoFilePath(options), { fallback: null, fs: options.fs });
    if (record && typeof record.path === "string" && record.path && (options.fs ?? nodeFs).existsSync(record.path)) {
      return { path: record.path, source: "connected" };
    }
  } catch {
    // Fall through to the working directory.
  }
  return { path: ctx.cwd ?? process.cwd(), source: "cwd" };
}

/**
 * Options forwarded to auth.* / repo.mjs library calls (only what the caller provided, so defaults
 * stay in one place). Used by launch and `repo`.
 */
export function runtimeSeams(ctx) {
  const options = { env: ctx.env, spawn: ctx.spawn };
  for (const key of ["exists", "platform", "homedir", "now", "timeoutMs", "fs"]) if (ctx[key] !== undefined) options[key] = ctx[key];
  return options;
}

/**
 * GitHub host: an explicit `--host` wins, otherwise the layered configuration (default github.com).
 * Either way the value is validated here, so a bad host is a usage error before anything is probed.
 */
export function resolveHost(ctx, flag) {
  if (typeof flag === "string") return normalizeHost(flag);
  return resolveConfig(seams(ctx)).entries["github.host"].value;
}

/**
 * launch and `repo connect` select a repository through github.com only in this build. Reads the
 * effective `github.host` and fails fast (before any probe, picker or spawn) for anything else, so a
 * GitHub Enterprise user gets a clear message instead of a github.com sign-in loop.
 * @throws {CliError} GITHUB_HOST_UNSUPPORTED (exit 5)
 */
export function assertGithubComOnly(ctx) {
  const { value, origin } = resolveConfig(seams(ctx)).entries["github.host"];
  if (value === "github.com") return;
  throw new CliError(
    `launch and repo connect support github.com only in this build; github.host is ${sanitizeForTerminal(String(value))} (origin: ${sanitizeForTerminal(String(origin))})`,
    {
      code: "GITHUB_HOST_UNSUPPORTED",
      exitCode: EXIT.CONFIG,
      remediation: "Unset github.host (config file or ASTERWEAVE_GITHUB_HOST), or use `asterweave auth status` / `asterweave doctor` for that host.",
    },
  );
}

/** `ui.color` for text output (`auto` when the configuration cannot be read; config errors are reported elsewhere). */
export function colorMode(ctx) {
  try {
    return resolveConfig(seams(ctx)).entries["ui.color"].value;
  } catch {
    return "auto";
  }
}

/** Value of a string flag (trimmed), `undefined` when absent; a bare `--flag` is a usage error. */
export function stringOption(ctx, name, remediation) {
  const value = ctx.options?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} requires a value.`, { remediation });
  return value.trim();
}
