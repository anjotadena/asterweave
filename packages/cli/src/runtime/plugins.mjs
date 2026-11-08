// Claude Code plugin state: PARSE ONLY. Nothing here executes `claude`, starts a process or loads plugin code.
//
// Sources (all read-only, 8 MiB cap each, regular files only, null-prototype copies of the parsed JSON):
//   <home>/.claude/plugins/installed_plugins.json   installs (user / project / local scope)   shape UNVERIFIED, parsed defensively
//   <home>/.claude/plugins/known_marketplaces.json  marketplaces that were added to Claude Code
//   <home>/.claude/settings.json                    `enabledPlugins` for the user scope        (global)
//   <repo>/.claude/settings.json                    `enabledPlugins` for the project scope     (repo)
//   <repo>/.claude/settings.local.json              `enabledPlugins` for the local scope       (shown, NOT managed by Asterweave)
// Precedence between the scopes is UNVERIFIED: every scope is listed separately and never merged; a plugin declared differently in
// two scopes is labelled a conflict. Asterweave maps global to Claude `user` and repo to Claude `project`; `local` is never written.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { redactText, sanitizeForTerminal } from "../redact.mjs";

export const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 24;
const MAX_NODES = 200_000;
const MAX_PLUGINS = 1000;

/** Strict plugin id: `name` or `name@marketplace`. A strict subset of the admin runner's id pattern. */
const PART = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
export const PLUGIN_ID = new RegExp(`^${PART}(?:@${PART})?$`);
export const QUALIFIED_PLUGIN_ID = new RegExp(`^${PART}@${PART}$`);
export const MARKETPLACE_NAME = new RegExp(`^${PART}$`);

// at most 100 characters in total: the admin runner's own limit, so it never refuses an id accepted here
export const isValidPluginId = (value) => typeof value === "string" && value.length <= 100 && PLUGIN_ID.test(value);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/** Sanitized, redacted, bounded text for display. */
export const show = (value, length = 200) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, length);

export const SCOPES = Object.freeze({ global: "user", repo: "project", local: "local" });
const CLAUDE_TO_SCOPE = Object.freeze({ user: "global", project: "repo", local: "local" });

/** Paths of the Claude Code files Asterweave reads. `home` is injectable (tests never touch the real one). */
export function pluginPaths({ homedir = osHomedir, repoRoot } = {}) {
  const home = homedir();
  const claudeDir = path.join(home, ".claude");
  const pluginsDir = path.join(claudeDir, "plugins");
  return {
    home,
    claudeDir,
    pluginsDir,
    installed: path.join(pluginsDir, "installed_plugins.json"),
    marketplaces: path.join(pluginsDir, "known_marketplaces.json"),
    userSettings: path.join(claudeDir, "settings.json"),
    ...(repoRoot ? {
      projectSettings: path.join(repoRoot, ".claude", "settings.json"),
      localSettings: path.join(repoRoot, ".claude", "settings.local.json"),
      projectMcp: path.join(repoRoot, ".mcp.json"),
    } : {}),
  };
}

/** Deep copy into null-prototype objects: `__proto__` / `constructor` / `prototype` keys are dropped, depth and size are bounded. */
export function plain(value, budget = { nodes: 0 }, depth = 0) {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) throw new Error("too deeply nested or too large");
  if (Array.isArray(value)) return value.map((item) => plain(item, budget, depth + 1));
  if (isObject(value)) {
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      out[key] = plain(value[key], budget, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Read one JSON file safely. Never throws.
 * @returns {{state: 'missing'|'ok'|'unreadable'|'too-large'|'not-a-file'|'invalid', data: unknown, bytes: Buffer|null}}
 */
export function readJsonFile(file, { fs = nodeFs, maxBytes = MAX_READ_BYTES, noFollow = false } = {}) {
  let stat;
  try {
    stat = noFollow ? fs.lstatSync(file) : fs.statSync(file);
  } catch (error) {
    return { state: error?.code === "ENOENT" || error?.code === "ENOTDIR" ? "missing" : "unreadable", data: null, bytes: null };
  }
  if (!stat.isFile()) return { state: "not-a-file", data: null, bytes: null };
  if (stat.size > maxBytes) return { state: "too-large", data: null, bytes: null };
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { state: "unreadable", data: null, bytes: null };
  }
  if (bytes.length > maxBytes) return { state: "too-large", data: null, bytes: null };
  let text = bytes.toString("utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.trim() === "") return { state: "ok", data: null, bytes };
  try {
    return { state: "ok", data: plain(JSON.parse(text)), bytes };
  } catch {
    return { state: "invalid", data: null, bytes };
  }
}

export const digestOf = (read) => (read.bytes ? createHash("sha256").update(read.bytes).digest("hex") : read.state);

/** `enabledPlugins` of a settings document: id -> true | false. Entries with other value types are ignored. */
export function enabledMap(data) {
  const out = Object.create(null);
  const map = isObject(data) ? data.enabledPlugins : undefined;
  if (!isObject(map)) return out;
  for (const id of Object.keys(map).slice(0, MAX_PLUGINS)) if (typeof map[id] === "boolean") out[id] = map[id];
  return out;
}

const str = (value, length = 500) => (typeof value === "string" ? value.slice(0, length) : null);

/**
 * Install records. UNVERIFIED shapes, both accepted: { version, plugins: { "<id>": [ {scope, installPath, version, projectPath, ...} ] } }
 * (an entry may also be a single object), or a flat map { "<id>": {...} }. A record without a recognised scope is `user`.
 * @returns {{records: Array<{id: string, claudeScope: string, scope: string, version: string|null, installPath: string|null, projectPath: string|null, installedAt: string|null}>, recognized: boolean}}
 */
export function installRecords(data) {
  const records = [];
  const root = isObject(data) ? (isObject(data.plugins) ? data.plugins : data) : null;
  if (root === null) return { records, recognized: false };
  let recognized = false;
  for (const id of Object.keys(root).slice(0, MAX_PLUGINS)) {
    if (!isValidPluginId(id)) continue;
    const entries = Array.isArray(root[id]) ? root[id] : [root[id]];
    for (const entry of entries.slice(0, 20)) {
      if (!isObject(entry)) continue;
      recognized = true;
      const claudeScope = typeof entry.scope === "string" && Object.hasOwn(CLAUDE_TO_SCOPE, entry.scope) ? entry.scope : "user";
      records.push({ id, claudeScope, scope: CLAUDE_TO_SCOPE[claudeScope], version: str(entry.version, 100), installPath: str(entry.installPath, 1000), projectPath: str(entry.projectPath, 1000), installedAt: str(entry.installedAt ?? entry.installed_at, 60) });
    }
  }
  return { records, recognized: recognized || Object.keys(root).length === 0 };
}

/** Marketplace names from known_marketplaces.json (an object keyed by name; an array of {name} is also tolerated). */
export function marketplaceNames(data) {
  const names = [];
  if (isObject(data)) names.push(...Object.keys(data));
  else if (Array.isArray(data)) for (const item of data) if (isObject(item) && typeof item.name === "string") names.push(item.name);
  return names.filter((name) => MARKETPLACE_NAME.test(name)).slice(0, MAX_PLUGINS);
}

const samePath = (a, b, platform) => (platform === "win32" ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

/**
 * Everything the readers know, per scope. Never merged. `trust` (a boolean) is the repository trust state, supplied by the caller.
 * @param {{homedir?: () => string, repoRoot?: string, fs?: object, platform?: string, repoTrusted?: boolean|null}} options
 */
export function readPluginState({ homedir, repoRoot, fs = nodeFs, platform = process.platform, repoTrusted = null } = {}) {
  const paths = pluginPaths({ homedir, repoRoot });
  const issues = [];
  const note = (file, read, label) => { if (!["ok", "missing"].includes(read.state)) issues.push({ file: label, state: read.state }); };
  const installedRead = readJsonFile(paths.installed, { fs });
  const marketsRead = readJsonFile(paths.marketplaces, { fs });
  const userRead = readJsonFile(paths.userSettings, { fs });
  note(paths.installed, installedRead, "installed_plugins.json");
  note(paths.marketplaces, marketsRead, "known_marketplaces.json");
  note(paths.userSettings, userRead, "~/.claude/settings.json");
  const installs = installRecords(installedRead.data);
  const declared = { global: enabledMap(userRead.data), repo: Object.create(null), local: Object.create(null) };
  let projectRead = null;
  let localRead = null;
  if (repoRoot) {
    projectRead = readJsonFile(paths.projectSettings, { fs });
    localRead = readJsonFile(paths.localSettings, { fs });
    note(paths.projectSettings, projectRead, ".claude/settings.json");
    note(paths.localSettings, localRead, ".claude/settings.local.json");
    declared.repo = enabledMap(projectRead.data);
    declared.local = enabledMap(localRead.data);
  }
  // A project/local install belongs to the repository it was made for; a record naming another project is not this repository's.
  const mine = (record) => record.claudeScope === "user" || !repoRoot || record.projectPath === null || samePath(record.projectPath, repoRoot, platform);
  const rows = [];
  for (const scope of ["global", "repo", "local"]) {
    if ((scope !== "global") && !repoRoot) continue;
    const ids = new Set(Object.keys(declared[scope]));
    const records = installs.records.filter((record) => record.scope === scope && mine(record));
    for (const record of records) ids.add(record.id);
    for (const id of [...ids].sort()) {
      if (!isValidPluginId(id)) continue;
      const install = records.find((record) => record.id === id) ?? null;
      const [name, marketplace = null] = id.split("@");
      rows.push({
        id, name, marketplace, scope, claudeScope: SCOPES[scope],
        installed: install !== null,
        version: install?.version ?? null,
        enabled: Object.hasOwn(declared[scope], id) ? declared[scope][id] : null,
        file: scope === "global" ? "~/.claude/settings.json" : scope === "repo" ? ".claude/settings.json" : ".claude/settings.local.json",
        managed: scope !== "local",
        note: scope === "local" ? "local, not managed by asterweave" : scope === "repo" ? "declared in the repository: needs trust" : "user-level",
        trust: scope === "repo" ? (repoTrusted === null ? "unknown" : repoTrusted ? "trusted" : "untrusted") : null,
        installPath: install?.installPath ?? null,
      });
    }
  }
  const byId = new Map();
  for (const row of rows) byId.set(row.id, [...(byId.get(row.id) ?? []), row]);
  for (const row of rows) {
    const others = byId.get(row.id).filter((other) => other !== row && other.enabled !== null && row.enabled !== null && other.enabled !== row.enabled);
    row.conflict = others.length > 0 ? `declared ${others.map((other) => `${other.enabled ? "enabled" : "disabled"} in ${other.scope}`).join(", ")}; precedence is not verified` : null;
  }
  return {
    paths,
    rows,
    marketplaces: marketplaceNames(marketsRead.data),
    marketplacesReadable: ["ok", "missing"].includes(marketsRead.state),
    installedShapeRecognized: installs.recognized || installedRead.state === "missing",
    installRecords: installs.records,
    issues,
    digests: {
      installed: digestOf(installedRead),
      marketplaces: digestOf(marketsRead),
      userSettings: digestOf(userRead),
      projectSettings: projectRead ? digestOf(projectRead) : null,
      localSettings: localRead ? digestOf(localRead) : null,
    },
    settingsData: { global: userRead.data, repo: projectRead?.data ?? null },
    precedence: "not verified: scopes are listed separately and never merged",
  };
}
