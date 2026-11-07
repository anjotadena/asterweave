// User directory resolution. Everything is injectable so tests can exercise every platform
// from any host: platform selects win32 vs posix path semantics, not the host's.

import { homedir as osHomedir } from "node:os";
import path from "node:path";

export const APP_DIR_NAME = "asterweave";

/**
 * Directory holding config.json, credentials.json and trust.json.
 *
 * Order: ASTERWEAVE_CONFIG_DIR (must be absolute, else ignored) → platform default:
 * win32 `%APPDATA%\asterweave` (falls back to `<home>\AppData\Roaming`), darwin
 * `~/Library/Application Support/asterweave`, others `$XDG_CONFIG_HOME/asterweave`
 * (absolute only) else `~/.config/asterweave`.
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, homedir?: () => string}} [options]
 * @returns {string}
 */
export function resolveUserDir({ env = process.env, platform = process.platform, homedir = osHomedir } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const override = env.ASTERWEAVE_CONFIG_DIR;
  if (override && p.isAbsolute(override)) return p.normalize(override);
  if (platform === "win32") {
    const base = env.APPDATA && p.isAbsolute(env.APPDATA) ? env.APPDATA : p.join(homedir(), "AppData", "Roaming");
    return p.join(base, APP_DIR_NAME);
  }
  if (platform === "darwin") return p.join(homedir(), "Library", "Application Support", APP_DIR_NAME);
  const xdg = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(homedir(), ".config");
  return p.join(xdg, APP_DIR_NAME);
}

/** Files inside the user directory. */
export const USER_FILES = Object.freeze({
  config: "config.json",
  credentials: "credentials.json",
  trust: "trust.json",
  repo: "repo.json",
});

/** Directory (inside the user directory) holding run state: `runs/<repoDir>/<runId>/`. */
export const RUNS_DIR_NAME = "runs";

/**
 * Absolute path of the directory that holds every run (`<userDir>/runs`). Separate from USER_FILES
 * because it is a directory, not a file.
 * @param {Parameters<typeof resolveUserDir>[0]} [options]
 */
export function runsDir(options) {
  const platform = options?.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), RUNS_DIR_NAME);
}

/**
 * Absolute path of a named user file (`config`, `credentials`, `trust`, `repo`).
 * @param {keyof typeof USER_FILES} name
 * @param {Parameters<typeof resolveUserDir>[0]} [options]
 */
export function userFilePath(name, options) {
  const file = USER_FILES[name];
  if (!file) throw new Error(`Unknown user file '${name}'.`);
  const platform = options?.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), file);
}
