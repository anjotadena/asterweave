// MCP server configuration: PARSE ONLY. Nothing in this module starts a process.
//
// Sources (read-only): the repository's `.mcp.json` (source "project"), the user-level Claude file `~/.claude.json` top-level
// `mcpServers` (source "user"), and `.mcp.json` files found under `~/.claude/plugins/cache` (source "plugin", best effort).
// Precedence between sources is NOT verified by this repository's docs or plugin files, so servers are never merged: every
// definition is listed with its source, and a name defined in more than one source is reported as a duplicate.
//
// Env values must be REFERENCES, written `${cred:NAME}` (Asterweave's) or `${NAME}` (the form Claude Code expands from its own
// environment; UNVERIFIED here); the value is resolved at spawn time from the caller's environment by the injected resolver.
// A literal value (or a `${NAME:-default}`) is never passed to a server and is flagged by validate.
//
// Approvals live in `<userDir>/mcp-approvals.json`: { version: 1, approvals: { <repoKey>: { <source>/<server>: {definitionHash,
// descriptorHash, tools, approvedAt} } } } (atomic writes, keyed by repository key and server name).

import * as nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { resolveUserDir } from "../../paths.mjs";
import { resolveBinary } from "../../proc.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { parseJsonText, readJson, writeJsonAtomic } from "../../store.mjs";
import { credentialRef, descriptorHash, envReference } from "./descriptor.mjs";

export { credentialRef, envReference };

export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const SOURCES = Object.freeze(["project", "user", "plugin"]);
const TRANSPORTS = new Set(["stdio", "http", "sse"]);
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SERVERS = 200;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"]);

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safe = (value, length = 300) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, length);

/** Resolve env credential references. Literal values are NOT passed on. @returns {{env: object, missing: string[], literal: string[]}} */
export function resolveServerEnv(env, resolve) {
  const out = {};
  const missing = [];
  const literal = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    const name = credentialRef(value);
    if (name === null) { literal.push(key); continue; }
    const resolved = resolve(name);
    if (typeof resolved !== "string" || resolved === "") missing.push(key);
    else out[key] = resolved;
  }
  return { env: out, missing, literal };
}

function readFileCapped(file, fs) {
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("not a regular file");
  if (stat.size > MAX_FILE_BYTES) throw new Error("file too large");
  return fs.readFileSync(file, "utf8");
}

function collect(file, source, sink, fs, pick, preread) {
  let text;
  try {
    if (preread !== undefined) {
      // The exact bytes a trust check hashed (see trust.mjs `mcp`): no second read of the file.
      if (preread.state === "missing") return;
      if (preread.state !== "present" || preread.bytes === null || preread.bytes.length > MAX_FILE_BYTES) throw new Error("unreadable");
      text = preread.bytes.toString("utf8");
    } else text = readFileCapped(file, fs);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    sink.issues.push({ file, source, message: "cannot be read" });
    return;
  }
  let data;
  try {
    data = parseJsonText(text, file, null);
  } catch {
    sink.issues.push({ file, source, message: "is not valid JSON" });
    return;
  }
  const servers = pick(data);
  if (servers === undefined) return;
  if (!isObject(servers)) { sink.issues.push({ file, source, message: "mcpServers must be an object" }); return; }
  for (const name of Object.keys(servers).slice(0, MAX_SERVERS)) sink.servers.push({ name, source, file, raw: servers[name] });
}

function findPluginFiles(root, fs) {
  const found = [];
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > 6 || visited > 500 || found.length >= 50) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      visited += 1;
      if (entry.isSymbolicLink?.()) continue;
      if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") walk(path.join(dir, entry.name), depth + 1);
      else if (entry.isFile() && entry.name === ".mcp.json") found.push(path.join(dir, entry.name));
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Parse every configured source. Never spawns, never fails on a missing or unreadable file (that becomes an `issues` entry).
 * @param {{repoRoot: string, homedir?: () => string, fs?: typeof nodeFs, userFile?: string, pluginCache?: string,
 *   projectBytes?: {bytes: Buffer|null, state: string}}} options  `projectBytes`: the trusted `.mcp.json` bytes to parse instead of reading the file.
 */
export function loadMcpServers({ repoRoot, homedir, fs = nodeFs, userFile, pluginCache, projectBytes }) {
  const home = (homedir ?? osHomedir)();
  const sink = { servers: [], issues: [] };
  collect(path.join(repoRoot, ".mcp.json"), "project", sink, fs, (data) => data?.mcpServers, projectBytes);
  if (home || userFile) collect(userFile ?? path.join(home, ".claude.json"), "user", sink, fs, (data) => data?.mcpServers);
  if (home || pluginCache) {
    try {
      for (const file of findPluginFiles(pluginCache ?? path.join(home, ".claude", "plugins", "cache"), fs)) collect(file, "plugin", sink, fs, (data) => data?.mcpServers ?? (isObject(data) && !("mcpServers" in data) ? data : undefined));
    } catch { /* best effort */ }
  }
  return { servers: sink.servers.slice(0, MAX_SERVERS).map((entry) => normalizeServer(entry)), issues: sink.issues, precedence: "not verified: servers from different sources are listed separately and never merged" };
}

/** A raw definition as a uniform record. `problems` lists structural errors (messages hold no raw values). */
export function normalizeServer({ name, source, file, raw }) {
  const problems = [];
  const def = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push("the definition must be an object");
  if (!SERVER_NAME.test(name)) problems.push("the server name is not valid (letters, digits, _ . - ; at most 64)");
  const declared = typeof def.type === "string" ? def.type : def.command !== undefined ? "stdio" : def.url !== undefined ? "http" : "unknown";
  const transport = TRANSPORTS.has(declared) ? declared : "unknown";
  if (transport === "unknown") problems.push("the transport is not stdio, http or sse");
  if (transport === "stdio" && (typeof def.command !== "string" || def.command.trim() === "")) problems.push("a stdio server needs a command");
  if (def.args !== undefined && !(Array.isArray(def.args) && def.args.every((arg) => typeof arg === "string"))) problems.push("args must be an array of strings");
  if (def.env !== undefined && !(isObject(def.env) && Object.values(def.env).every((value) => typeof value === "string"))) problems.push("env must be an object of strings");
  if ((transport === "http" || transport === "sse") && (typeof def.url !== "string" || !URL.canParse(def.url))) problems.push("a remote server needs a valid url");
  return {
    name, source, file,
    transport,
    command: typeof def.command === "string" ? def.command : null,
    args: Array.isArray(def.args) ? def.args.filter((arg) => typeof arg === "string") : [],
    env: isObject(def.env) ? Object.fromEntries(Object.entries(def.env).filter(([, value]) => typeof value === "string")) : {},
    url: typeof def.url === "string" ? def.url : null,
    enabled: def.disabled !== true,
    problems,
  };
}

/**
 * Where a server runs. Project servers run in the repository root; user and plugin servers run in a neutral temporary directory
 * (never the repository, which they did not come from). The descriptor hash records the label, not the random directory name.
 */
export const NEUTRAL_CWD = "<neutral-temp>";
export const cwdLabel = (server, repoRoot) => (server.source === "project" ? repoRoot : NEUTRAL_CWD);

/** The descriptor-hash input for a server (cwd is where it would run). */
export const definitionOf = (server, cwd) => ({ transport: server.transport, command: server.command, args: server.args, cwd, env: server.env, url: server.url });
export const definitionHashOf = (server, cwd) => descriptorHash(definitionOf(server, cwd), null);

/** URL with userinfo removed and query values replaced, safe to display. */
export function redactUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.pathname = url.pathname.split("/").map((part) => (/^[A-Za-z0-9_-]{24,}$/.test(part) ? "[redacted]" : part)).join("/");
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "[redacted]");
    return safe(url.toString(), 500);
  } catch {
    return "[invalid url]";
  }
}

/** Display form of a server: redacted, sanitized, env values shown only as credential references. */
export function displayServer(server) {
  return {
    name: safe(server.name, 80),
    source: server.source,
    file: safe(server.file, 500),
    transport: server.transport,
    command: server.command === null ? null : safe(server.command, 500),
    args: server.args.map((arg) => safe(arg, 500)),
    url: redactUrl(server.url),
    env: Object.fromEntries(Object.entries(server.env).map(([key, value]) => [safe(key, 80), credentialRef(value) === null ? "[literal value hidden]" : value])),
    enabled: server.enabled,
  };
}

/** Findings that make a server risky; `error` ones fail `mcp validate`. */
export function lintServer(server, { env = process.env, platform = process.platform, exists } = {}) {
  const findings = [];
  const add = (level, code, message) => findings.push({ level, code, message });
  for (const problem of server.problems) add("error", "MCP_DEFINITION_INVALID", problem);
  const argText = server.args.join(" ");
  if (redactText(argText).count > 0) add("error", "MCP_SECRET_IN_ARGS", "arguments contain what looks like a secret; use an env credential reference");
  if (server.url && (redactText(server.url).count > 0 || /\/\/[^/@\s]+@/.test(server.url) || /[?&](?:token|key|api[_-]?key|secret|password|access_token)=/i.test(server.url))) add("error", "MCP_SECRET_IN_URL", "the url contains credentials");
  for (const [key, value] of Object.entries(server.env)) {
    if (credentialRef(value) === null) add("error", "MCP_ENV_LITERAL", `env ${safe(key, 60)} is not an environment reference (use \${NAME} or \${cred:NAME}); literal values are never passed to the server`);
  }
  if ((server.transport === "http" || server.transport === "sse") && server.url && URL.canParse(server.url) && new URL(server.url).protocol !== "https:") add("warn", "MCP_NO_TLS", "the remote server is not reached over https");
  if (server.transport === "stdio" && server.command) {
    const base = path.basename(server.command.replace(/\\/g, "/")).toLowerCase();
    if (SHELLS.has(base) && server.args.some((arg) => /^(?:-c|-lc|-command|\/c|-encodedcommand)$/i.test(arg))) add("warn", "MCP_SHELL_WRAPPER", "the server is started through a shell wrapper; the real program is hidden from review");
    if (/^(?:npx|uvx|pipx|bunx)(?:\.cmd|\.exe)?$/.test(base)) {
      const pkg = server.args.find((arg) => !arg.startsWith("-"));
      if (pkg === undefined || !/.+@(?!latest$)[^/@]+$/.test(pkg)) add("warn", "MCP_UNPINNED_PACKAGE", "the package is not pinned to a version; each start may run different code");
    }
    const found = resolveBinary(server.command, { env, platform, ...(exists ? { exists } : {}) });
    if (found.reason === "SHELL_SHIM_ONLY") add("warn", "MCP_SHELL_SHIM", "the command resolves only to a .cmd/.bat shim, which this build does not start (no shell is used)");
    else if (found.reason === "NOT_FOUND") add("warn", "MCP_COMMAND_MISSING", "the command was not found on PATH");
  }
  return findings;
}

// --- approvals -------------------------------------------------------------------------------

export const approvalsFile = (options) => path.join(resolveUserDir(options), "mcp-approvals.json");

function readStore(options) {
  const data = readJson(approvalsFile(options), { fallback: null, fs: options.fs });
  return isObject(data) && isObject(data.approvals) ? data : { version: 1, approvals: {} };
}

/** The stored approval of one server, or null. */
export const approvalKey = (source, name) => `${source}/${name}`; // server names never hold '/'

export function readApproval(repoKey, source, name, options = {}) {
  const key = approvalKey(source, name);
  let store;
  try { store = readStore(options); } catch { return null; }
  const forRepo = Object.hasOwn(store.approvals, repoKey) && isObject(store.approvals[repoKey]) ? store.approvals[repoKey] : null;
  const entry = forRepo && Object.hasOwn(forRepo, key) ? forRepo[key] : null;
  if (!isObject(entry) || typeof entry.definitionHash !== "string" || typeof entry.descriptorHash !== "string" || !Array.isArray(entry.tools)) return null;
  return { definitionHash: entry.definitionHash, descriptorHash: entry.descriptorHash, tools: entry.tools.filter((tool) => typeof tool === "string"), approvedAt: String(entry.approvedAt ?? "") };
}

export function saveApproval(repoKey, source, name, record, options = {}) {
  const store = readStore(options);
  const approvals = Object.assign(Object.create(null), store.approvals);
  approvals[repoKey] = Object.assign(Object.create(null), isObject(approvals[repoKey]) ? approvals[repoKey] : {});
  approvals[repoKey][approvalKey(source, name)] = { definitionHash: record.definitionHash, descriptorHash: record.descriptorHash, tools: record.tools, approvedAt: record.approvedAt };
  writeJsonAtomic(approvalsFile(options), { version: 1, approvals }, { fs: options.fs });
}

/**
 * Delete the stored approval(s) of one server so an identical re-add cannot revive them. A project server's approval lives under its
 * repository key; a USER server is shared by every repository, so its record is removed under every repository key.
 * @returns {number} how many records were removed
 */
export function removeApprovals(repoKey, source, name, options = {}) {
  const store = readStore(options);
  const key = approvalKey(source, name);
  const approvals = Object.assign(Object.create(null), store.approvals);
  let removed = 0;
  for (const repo of source === "project" ? [repoKey] : Object.keys(approvals)) {
    if (!isObject(approvals[repo]) || !Object.hasOwn(approvals[repo], key)) continue;
    approvals[repo] = Object.assign(Object.create(null), approvals[repo]);
    delete approvals[repo][key];
    removed += 1;
  }
  if (removed > 0) writeJsonAtomic(approvalsFile(options), { version: 1, approvals }, { fs: options.fs });
  return removed;
}

/** valid / stale / none, judged on the definition hash only (the tool list needs a spawn; `mcp test` re-checks it). */
export function approvalState(approval, definitionHash) {
  if (approval === null) return "none";
  return approval.definitionHash === definitionHash ? "valid" : "stale";
}
