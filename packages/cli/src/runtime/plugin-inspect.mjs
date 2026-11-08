// Manifest summary of ONE installed plugin, from its cache directory. PARSE ONLY: no hook, script or server is started and no
// plugin code is loaded. Component counts come from directory names only. Symbolic links are never followed (a plugin directory
// is untrusted content), and the install path must resolve inside `<home>/.claude/plugins`.

import * as nodeFs from "node:fs";
import path from "node:path";
import { normalizeServer, displayServer, lintServer } from "./tools/mcp-config.mjs";
import { readJsonFile, show } from "./plugins.mjs";

const MAX_COUNT = 1000;
const MAX_ITEMS = 50;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const COMPONENTS = Object.freeze(["skills", "agents", "commands", "hooks"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Whether `child` is `parent` or inside it (case-insensitive on Windows). */
export function isInside(parent, child, platform = process.platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const relative = p.relative(fold(p.resolve(parent)), fold(p.resolve(child)));
  return relative === "" || (!relative.startsWith("..") && !p.isAbsolute(relative));
}

function realpath(fs, target) {
  try { return (fs.realpathSync.native ?? fs.realpathSync)(target); } catch { return null; }
}

/** Resolve a recorded install path to a directory inside the plugins directory, or explain why not. */
export function resolveInstallDir(installPath, pluginsDir, { fs = nodeFs, platform = process.platform } = {}) {
  if (typeof installPath !== "string" || installPath === "") return { dir: null, reason: "no install path is recorded" };
  const real = realpath(fs, installPath);
  const root = realpath(fs, pluginsDir);
  if (real === null) return { dir: null, reason: "the install directory does not exist" };
  if (root === null || !isInside(root, real, platform)) return { dir: null, reason: "the recorded install path is outside the plugins directory: not read" };
  let stat;
  try { stat = fs.statSync(real); } catch { return { dir: null, reason: "the install directory cannot be read" }; }
  return stat.isDirectory() ? { dir: real, reason: null } : { dir: null, reason: "the install path is not a directory" };
}

function countEntries(dir, name, fs) {
  const target = path.join(dir, name);
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { present: false, count: 0 }; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return { present: false, count: 0, skipped: stat.isSymbolicLink() ? "symbolic link not followed" : "not a directory" };
  let count = 0;
  try {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (entry.isSymbolicLink?.()) continue;
      count += 1;
      if (count >= MAX_COUNT) break;
    }
  } catch { return { present: true, count: 0 }; }
  return { present: true, count, ...(count >= MAX_COUNT ? { capped: true } : {}) };
}

/** Hook command strings found anywhere in a hooks document: each is code that will run when the plugin is enabled. */
export function hookCommands(data) {
  const found = [];
  const visit = (node, event, depth) => {
    if (found.length >= MAX_ITEMS || depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, event, depth + 1); return; }
    if (!isObject(node)) return;
    if (typeof node.command === "string") found.push({ event: show(event, 60), type: show(node.type ?? "command", 30), command: show(node.command, 300), runsCode: true });
    for (const key of Object.keys(node)) if (key !== "command") visit(node[key], depth === 0 || event === "" ? key : event, depth + 1);
  };
  visit(isObject(data) && isObject(data.hooks) ? data.hooks : data, "", 0);
  return found;
}

const MAX_DECLARED = 20;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Resolve a path DECLARED by the manifest (`./cfg/h.json`) to something inside the install directory: relative only, no link as its
 * last component, realpath still inside the directory. @returns {{real: string, stat: object}|{reason: string}}
 */
function resolveDeclared(dir, relative, fs, platform) {
  if (typeof relative !== "string" || relative === "" || relative.length > 300 || CONTROL.test(relative)) return { reason: "not a usable path" };
  if (path.posix.isAbsolute(relative) || path.win32.isAbsolute(relative)) return { reason: "absolute path" };
  const target = path.resolve(dir, relative);
  if (!isInside(dir, target, platform)) return { reason: "outside the plugin directory" };
  let stat;
  try { stat = fs.lstatSync(target); } catch { return { reason: "cannot be read" }; }
  if (stat.isSymbolicLink()) return { reason: "symbolic link not followed" };
  const real = realpath(fs, target);
  if (real === null || !isInside(dir, real, platform)) return { reason: "outside the plugin directory" };
  return { real, stat };
}

/** The entries of a manifest field: one path, one inline object, or a list of either. */
const declaredItems = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value]).slice(0, MAX_DECLARED);

/**
 * @returns {{dir: string|null, reason: string|null, complete: boolean, manifest: object|null, components: object, hooks: object[], mcpServers: object[], issues: string[]}}
 *   `complete` is false whenever something the plugin declares could not be read: never an all-clear.
 */
export function inspectInstalled(installPath, { pluginsDir, fs = nodeFs, platform = process.platform, env = process.env, exists } = {}) {
  const resolved = resolveInstallDir(installPath, pluginsDir, { fs, platform });
  const out = { dir: resolved.dir, reason: resolved.reason, complete: false, manifest: null, components: {}, hooks: [], mcpServers: [], issues: [] };
  if (resolved.dir === null) return out;
  const dir = resolved.dir;
  const read = (relative) => readJsonFile(path.join(dir, ...relative.split("/")), { fs, maxBytes: MAX_MANIFEST_BYTES, noFollow: true });
  const notInspected = (kind, shown, reason) => out.issues.push(`manifest declares ${kind} at ${show(shown, 120)}: not inspected (${reason}), treat as code`);
  /** Parsed JSON of a declared path, or null with an issue recorded. */
  const declaredJson = (kind, relative) => {
    const found = resolveDeclared(dir, relative, fs, platform);
    if (found.reason) { notInspected(kind, relative, found.reason); return null; }
    if (!found.stat.isFile()) { notInspected(kind, relative, "not a file"); return null; }
    const file = readJsonFile(found.real, { fs, maxBytes: MAX_MANIFEST_BYTES, noFollow: true });
    if (file.state !== "ok" || file.data === null) { notInspected(kind, relative, file.state === "ok" ? "empty" : file.state); return null; }
    return file.data;
  };
  let manifestRead = read(".claude-plugin/plugin.json");
  if (manifestRead.state === "missing") manifestRead = read("plugin.json");
  const manifest = manifestRead.state === "ok" && isObject(manifestRead.data) ? manifestRead.data : null;
  if (manifest) {
    out.manifest = { name: typeof manifest.name === "string" ? show(manifest.name, 100) : null, version: typeof manifest.version === "string" ? show(manifest.version, 50) : null, description: typeof manifest.description === "string" ? show(manifest.description, 300) : null };
  } else if (manifestRead.state !== "missing") out.issues.push(`plugin manifest: ${manifestRead.state}, treat as code`);
  for (const name of COMPONENTS) out.components[name] = countEntries(dir, name, fs);
  // skills / agents / commands declared by path (or list of paths) in the manifest: counted from what they point at
  for (const name of ["skills", "agents", "commands"]) {
    for (const item of declaredItems(manifest?.[name])) {
      if (typeof item !== "string") continue;
      const found = resolveDeclared(dir, item, fs, platform);
      if (found.reason) { out.issues.push(`manifest declares ${name} at ${show(item, 120)}: not inspected (${found.reason})`); continue; }
      if (isInside(path.join(dir, name), found.real, platform)) continue; // inside the default directory: already counted
      let count = 1;
      if (found.stat.isDirectory()) { try { count = Math.min(MAX_COUNT, fs.readdirSync(found.real).length); } catch { count = 0; } }
      out.components[name] = { present: true, count: (out.components[name]?.count ?? 0) + count };
    }
  }
  const mcpFile = read(".mcp.json");
  out.components.mcp = { present: mcpFile.state === "ok", count: 0 };

  const hooksFile = read("hooks/hooks.json");
  if (hooksFile.state === "ok") out.hooks.push(...hookCommands(hooksFile.data));
  else if (!["missing", "not-a-file"].includes(hooksFile.state)) out.issues.push(`hooks/hooks.json: ${hooksFile.state}, treat as code`);
  for (const item of declaredItems(manifest?.hooks)) {
    if (typeof item === "string") { const data = declaredJson("hooks", item); if (data !== null) out.hooks.push(...hookCommands(data)); }
    else if (isObject(item)) out.hooks.push(...hookCommands(item));
  }
  out.hooks = out.hooks.slice(0, MAX_ITEMS);

  const rawServers = [];
  const addServers = (doc, file) => {
    if (!isObject(doc)) return;
    const servers = isObject(doc.mcpServers) ? doc.mcpServers : doc;
    for (const name of Object.keys(servers).slice(0, MAX_ITEMS)) rawServers.push({ name, raw: servers[name], file });
  };
  if (mcpFile.state === "ok") addServers(mcpFile.data, ".mcp.json");
  else if (!["missing", "not-a-file"].includes(mcpFile.state)) out.issues.push(`.mcp.json: ${mcpFile.state}, treat as code`);
  for (const item of declaredItems(manifest?.mcpServers)) {
    if (typeof item === "string") { const data = declaredJson("mcpServers", item); if (data !== null) addServers(data, show(item, 80)); }
    else if (isObject(item)) addServers({ mcpServers: item }, "plugin.json");
  }
  for (const entry of rawServers.slice(0, MAX_ITEMS)) {
    const server = normalizeServer({ name: entry.name, source: "plugin", file: entry.file, raw: entry.raw });
    const warnings = lintServer(server, { env, platform, exists }).map((finding) => ({ level: finding.level, code: finding.code, message: finding.message }));
    out.mcpServers.push({ ...displayServer(server), warnings, runsCode: server.transport === "stdio" });
  }
  out.components.mcp.count = out.mcpServers.length;
  out.complete = out.issues.length === 0;
  return out;
}
