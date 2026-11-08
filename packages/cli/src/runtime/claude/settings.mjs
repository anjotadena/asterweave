// Per-run Claude Code settings file: registers this CLI's `hook pre-tool-use` as a PreToolUse hook for every tool.
//
// UNVERIFIED: the settings/hook schema below ({hooks: {PreToolUse: [{matcher, hooks: [{type: "command", command, timeout}]}]}})
// follows the shape documented in docs/cli/policy-and-guards.md and has never been checked against a live `claude`; neither
// has the shell Claude Code runs the hook command with on each platform. The command is therefore written to be valid for
// POSIX shells and cmd.exe alike: absolute, quoted paths (forward slashes on Windows), no PATH lookup of `node`.
// Nothing else is configured here: no permission rules, no setting sources are changed.

import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "../../store.mjs";
import { isAbsolutePath } from "./argv.mjs";

export class SettingsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SettingsError";
    this.code = "CLAUDE_SETTINGS_INVALID";
  }
}

/** Absolute path of this CLI's executable entry, derived from this file's location (never from PATH). */
export const DEFAULT_BIN_PATH = fileURLToPath(new URL("../../../bin/asterweave.mjs", import.meta.url));

// eslint-disable-next-line no-control-regex
const UNQUOTABLE_WIN = /[$`%!"\u0000-\u001f\u007f-\u009f]/;

/** Quote one absolute path for the hook command line. Throws SettingsError for a path that cannot be quoted safely. */
export function quoteHookPath(value, platform = process.platform) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) throw new SettingsError("a hook path must be a non-empty string");
  if (!isAbsolutePath(value, platform)) throw new SettingsError("a hook path must be absolute");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new SettingsError("a hook path contains a control character");
  if (platform === "win32") {
    if (UNQUOTABLE_WIN.test(value)) throw new SettingsError("a hook path contains a character that cannot be quoted safely for Windows shells");
    return `"${value.replaceAll("\\", "/")}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The hook command line: `<node> <bin> hook pre-tool-use`. */
export function hookCommand({ nodePath = process.execPath, binPath = DEFAULT_BIN_PATH, platform = process.platform } = {}) {
  return `${quoteHookPath(nodePath, platform)} ${quoteHookPath(binPath, platform)} hook pre-tool-use`;
}

/** The settings document (pure). */
export function buildSettings({ nodePath, binPath, platform, timeoutSeconds = 10 } = {}) {
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new SettingsError("timeoutSeconds must be an integer from 1 to 600");
  return {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: hookCommand({ nodePath, binPath, platform }), timeout: timeoutSeconds }] }],
    },
  };
}

/**
 * Write the settings file atomically (mode 0600) into a private directory (0700) under the run directory.
 * @param {{runDir: string, nodePath?: string, binPath?: string, platform?: string, timeoutSeconds?: number, fs?: object}} options
 * @returns {{path: string, settings: object}}
 */
export function writeRunSettings({ runDir, nodePath, binPath, platform = process.platform, timeoutSeconds, fs } = {}) {
  if (typeof runDir !== "string" || !isAbsolutePath(runDir, platform)) throw new SettingsError("runDir must be an absolute path");
  const settings = buildSettings({ nodePath, binPath, platform, timeoutSeconds });
  const directory = path.join(runDir, "claude");
  (fs?.mkdirSync ?? mkdirSync)(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "settings.json");
  writeJsonAtomic(file, settings, fs === undefined ? {} : { fs });
  return { path: file, settings };
}
