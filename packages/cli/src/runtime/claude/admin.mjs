// The ONE door through which Asterweave asks `claude` to change MCP or plugin configuration.
//
// Hybrid design: Asterweave owns trust, policy, approval and the effective view; the WRITES are delegated to
//   claude mcp add | remove                          claude plugin install | uninstall | enable | disable
// This module is a strict allow-list of argv shapes in front of a supervised spawn. Anything else is refused BEFORE a process
// exists: any other subcommand (`mcp list|get|serve|add-json|add-from-claude-desktop|reset-project-choices` spawn servers or
// import foreign state, `plugin marketplace|update|prune` fetch code), Claude's `local` scope (never used), a missing scope, an
// unknown flag, a value that starts with '-' where a name is expected, a secret-looking argument.
//
// Scope mapping (one function, `toClaudeScope`): Asterweave `global` = Claude `user`, Asterweave `repo` = Claude `project`
// (the repository's own `.mcp.json` / `.claude/settings.json`, the shareable declaration: no new repo file). `local` is impossible.
//
// Argument order produced by the builders (UNVERIFIED against a real claude): positionals first, then options, then (stdio)
// `-- command args`. `-e` and `-H` are variadic in claude's help, so a positional placed AFTER them could be swallowed. The
// validator accepts options in any order before `--` and never looks at anything after it except the command word itself.
//
// Safety of the spawn: shell:false, allow-listed environment (env.mjs: no tokens), stdin ignored, windowsHide, a deadline plus an
// AbortSignal with a whole-tree kill, stdout and stderr bounded (64 KiB), sanitized and redacted. Repo scope runs in the
// repository root; GLOBAL scope runs in a fresh private temporary directory, so a repository's `.claude/settings.json` or
// `.mcp.json` can never influence a user-level change. NO live claude call is made by this repository's tests (fake-claude admin mode).

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../../exit-codes.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { killProcessTree } from "../tools/mcp-client.mjs";
import { isAbsolutePath } from "./argv.mjs";
import { describeFailure } from "./classify.mjs";
import { buildClaudeEnv } from "./env.mjs";
import { checkClaude } from "./run.mjs";

export const ADMIN_LIMITS = Object.freeze({ maxOutputBytes: 64 * 1024, defaultDeadlineMs: 60_000, maxDeadlineMs: 10 * 60_000, killGraceMs: 1500, maxArgs: 128, maxArgChars: 4096 });

/** MCP server names / plugin ids. A leading '-' is refused separately (it would read as an option). */
export const MCP_NAME = /^[A-Za-z0-9._-]{1,64}$/;
// Same shape as plugins.mjs isValidPluginId: `name` or `name@marketplace`, no "/" and no "..", at most 100 characters in total.
const PLUGIN_PART = "[A-Za-z0-9][A-Za-z0-9._-]{0,63}";
export const PLUGIN_ID = new RegExp(`^${PLUGIN_PART}(?:@${PLUGIN_PART})?$`);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const CONFIG_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}$/;
/** `${NAME}` (NAME upper case: the form Claude Code expands) or Asterweave's `${cred:NAME}`. Never a default (`${NAME:-x}`). */
const REFERENCE = "\\$\\{(?:cred:[A-Za-z_][A-Za-z0-9_]{0,63}|[A-Z_][A-Z0-9_]{0,63})\\}";
const ENV_VALUE = new RegExp(`^${REFERENCE}$`);
const HEADER_VALUE = new RegExp(`^(?:(?:Bearer|Basic|Token) )?${REFERENCE}$`);

/** A refused request (exit 2). Nothing was spawned. */
export class AdminError extends UsageError {
  constructor(message, options = {}) {
    super(message, { code: "ADMIN_REFUSED", ...options });
  }
}

const refuse = (message, remediation) => { throw new AdminError(message, { remediation }); };
const shown = (value) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, 60);

/** Asterweave scope to Claude scope. `local` (and anything else) is impossible. @param {"global"|"repo"} scope @param {"mcp"|"plugin"} kind */
export function toClaudeScope(scope, kind) {
  if (kind !== "mcp" && kind !== "plugin") refuse("The kind must be mcp or plugin.");
  if (scope === "global") return "user";
  if (scope === "repo") return "project";
  return refuse(`Unknown scope '${shown(scope)}': use global or repo.`, "Asterweave maps global to Claude's user scope and repo to its project scope; Claude's local scope is never used.");
}

/**
 * CLAUDE_CONFIG_DIR moves Claude's user-level files; Asterweave verifies `~/.claude.json` and `~/.claude/`, so ANY change while it is present
 * (even a repo-scope plugin install writes the user-level installed_plugins.json) could write somewhere Asterweave does not look. It is refused,
 * not passed on silently; an empty value counts as present (its meaning for claude is not known), so it is refused too.
 */
export function assertSupportedEnvironment(scope, env, platform = process.platform) {
  const name = Object.keys(env ?? {}).find((key) => (platform === "win32" ? key.toUpperCase() : key) === "CLAUDE_CONFIG_DIR" && typeof env[key] === "string");
  if (name !== undefined) refuse("CLAUDE_CONFIG_DIR is set: Claude Code would write its user-level files somewhere Asterweave does not verify, so the change is refused.", "Unset CLAUDE_CONFIG_DIR for this command, or run the claude command yourself. Nothing was changed.");
}

/** Whether `value` is an environment reference accepted for a NEW definition: `${NAME}` (upper case) or `${cred:NAME}`. */
export const isEnvReference = (value) => typeof value === "string" && ENV_VALUE.test(value);
export const isHeaderReference = (value) => typeof value === "string" && HEADER_VALUE.test(value);

/** https, or http only to localhost; no userinfo; bounded. @returns {string|null} a problem, or null */
export function remoteUrlProblem(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048 || !URL.canParse(value)) return "the url is not valid";
  const url = new URL(value);
  if (url.username !== "" || url.password !== "") return "the url must not carry credentials";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return null;
  return "the url must be https (http is accepted only for localhost)";
}

const SCOPE_OPTIONS = { "-s": "scope", "--scope": "scope" };
const SHAPES = Object.freeze({
  "mcp add": { values: { ...SCOPE_OPTIONS, "-t": "transport", "--transport": "transport", "-e": "env", "--env": "env", "-H": "header", "--header": "header" }, repeat: ["env", "header"], flags: {}, positionals: [1, 2], dashdash: true },
  "mcp remove": { values: SCOPE_OPTIONS, repeat: [], flags: {}, positionals: [1, 1], dashdash: false },
  "plugin install": { values: { ...SCOPE_OPTIONS, "--config": "config" }, repeat: ["config"], flags: {}, positionals: [1, 1], dashdash: false },
  "plugin uninstall": { values: SCOPE_OPTIONS, repeat: [], flags: { "--keep-data": "keepData" }, positionals: [1, 1], dashdash: false },
  "plugin enable": { values: SCOPE_OPTIONS, repeat: [], flags: {}, positionals: [1, 1], dashdash: false },
  "plugin disable": { values: SCOPE_OPTIONS, repeat: [], flags: {}, positionals: [1, 1], dashdash: false },
});

function checkValue(name, value) {
  if (name === "transport" && !["stdio", "http", "sse"].includes(value)) refuse(`Unknown transport '${shown(value)}'.`, "Use stdio, http or sse.");
  if (name === "env") {
    const at = value.indexOf("=");
    if (at <= 0 || !ENV_KEY.test(value.slice(0, at)) || !ENV_VALUE.test(value.slice(at + 1))) refuse("An environment entry must be KEY=${NAME} or KEY=${cred:NAME}: a reference, never a literal value.", "Export the variable and pass a reference; the file is shareable.");
  }
  if (name === "header") {
    const at = value.indexOf(": ");
    if (at <= 0 || !HEADER_NAME.test(value.slice(0, at)) || !HEADER_VALUE.test(value.slice(at + 2))) refuse("A header must be 'Name: ${NAME}' (optionally 'Bearer ${NAME}'): a reference, never a literal value.", "Export the variable and pass a reference; the file is shareable.");
  }
  if (name === "config") {
    const at = value.indexOf("=");
    // A whole ${NAME} reference is never a secret (the same rule displayCommand uses); anything else must not look like one.
    const reference = at > 0 && CONFIG_REFERENCE.test(value.slice(at + 1));
    // eslint-disable-next-line no-control-regex
    if (at <= 0 || !CONFIG_KEY.test(value.slice(0, at)) || value.length > 600 || /[\x00-\x1f\x7f]/.test(value) || (!reference && redactText(value).count > 0)) refuse("A --config entry must be key=value without control characters or a literal that looks like a secret (a whole ${NAME} reference is accepted).");
  }
}

/**
 * Validate the argv of an admin call against the allow-list. Pure; throws AdminError.
 * @param {string[]} args  Everything after the `claude` binary.
 * @param {"global"|"repo"} scope
 * @returns {{kind: "mcp"|"plugin", action: string, claudeScope: "user"|"project", positionals: string[], values: object, flags: object, rest: string[]}}
 */
export function parseAdminArgs(args, scope) {
  if (!Array.isArray(args) || args.length < 3 || args.length > ADMIN_LIMITS.maxArgs || args.some((arg) => typeof arg !== "string" || arg.length > ADMIN_LIMITS.maxArgChars || arg.includes("\u0000"))) refuse("The claude arguments are not a bounded list of strings.");
  const [kind, action, ...tail] = args;
  const shape = SHAPES[`${kind} ${action}`];
  if (shape === undefined) refuse(`'claude ${shown(kind)} ${shown(action)}' is not an operation Asterweave delegates.`, "Only: mcp add|remove and plugin install|uninstall|enable|disable. Asterweave never runs list, get, serve, add-json, marketplace, update or prune.");
  const claudeScope = toClaudeScope(scope, kind);
  const dashdash = tail.indexOf("--");
  const head = dashdash === -1 ? tail : tail.slice(0, dashdash);
  const rest = dashdash === -1 ? [] : tail.slice(dashdash + 1);
  if (dashdash !== -1 && !shape.dashdash) refuse("This operation takes no '--' section.");
  const values = Object.create(null);
  const flags = Object.create(null);
  const positionals = [];
  let variadicSeen = false; // -e, -H and --config are variadic in claude's help: a positional after them could be swallowed as one more value
  for (let i = 0; i < head.length; i += 1) {
    const token = head[i];
    if (Object.hasOwn(shape.values, token)) {
      const name = shape.values[token];
      const value = head[i + 1];
      if (value === undefined || value === "--") refuse(`${shown(token)} needs a value.`);
      if (name === "scope") {
        if (/^(?:local)$/i.test(value)) refuse("Claude's local scope is never used.", "Use --scope global (user) or --scope repo (project).");
        if (value !== claudeScope) refuse(`The claude scope '${shown(value)}' does not match the Asterweave scope '${shown(scope)}' (expected ${claudeScope}).`);
      } else checkValue(name, value);
      if (shape.repeat.includes(name)) { (values[name] ??= []).push(value); variadicSeen = true; }
      else if (Object.hasOwn(values, name)) refuse(`${shown(token)} was given more than once.`);
      else values[name] = value;
      i += 1;
    } else if (Object.hasOwn(shape.flags, token)) {
      flags[shape.flags[token]] = true;
    } else if (token.startsWith("-")) {
      refuse(`Unknown or forbidden flag '${shown(token)}' for 'claude ${kind} ${action}'.`, /^--?scope=?|^-s/.test(token) ? "Pass the scope as '-s <user|project>'." : undefined);
    } else {
      if (variadicSeen) refuse("A positional argument may not follow -e, -H or --config (claude could read it as another value): put the name first.", "Use the order <name> [<url>] -s .. -t .. -e .. -H .. -- command (see buildMcpAddArgs / buildPluginArgs).");
      positionals.push(token);
    }
  }
  if (values.scope === undefined) refuse("An explicit scope (-s user|project) is required: claude's default (local) is never used.");
  const [min, max] = shape.positionals;
  if (positionals.length < min || positionals.length > max) refuse(`Expected ${min === max ? min : `${min} or ${max}`} positional argument(s), got ${positionals.length}.`);
  const name = positionals[0];
  if (name.startsWith("-") || /^\.+$/.test(name) || !(kind === "mcp" ? MCP_NAME : PLUGIN_ID).test(name)) refuse(`'${shown(name)}' is not a valid ${kind === "mcp" ? "server name" : "plugin id"}.`, kind === "mcp" ? "Letters, digits, . _ - ; at most 64 characters." : "Letters, digits, . _ @ / - ; at most 100 characters.");
  if (kind === "mcp" && action === "add") {
    const transport = values.transport ?? "stdio";
    const remote = transport === "http" || transport === "sse";
    if (remote) {
      if (positionals.length !== 2 || rest.length > 0 || dashdash !== -1) refuse("An http/sse server takes exactly one url and no '--' command.");
      const problem = remoteUrlProblem(positionals[1]);
      if (problem !== null) refuse(`Refused: ${problem}.`);
      if (values.env !== undefined) refuse("An http/sse server takes headers (-H), not environment entries.");
    } else {
      if (positionals.length !== 1 || rest.length === 0) refuse("A stdio server needs a command after '--'.");
      if (values.header !== undefined) refuse("A stdio server takes environment entries (-e), not headers.");
      if (rest[0] === "" || rest[0].startsWith("-")) refuse("The server command must be a program name or path, not an option.");
    }
    // The command line is visible to every process on the machine and lands in a shareable file: no token-shaped argument.
    if ([...rest, positionals[1] ?? ""].some((arg) => redactText(arg).count > 0)) refuse("An argument looks like a secret; pass credentials through an environment reference instead.");
  }
  return { kind, action, claudeScope, positionals, values, flags, rest };
}

const bare = /^[A-Za-z0-9_@%+=:,./-]+$/;
/**
 * Display form of the command line (never executed through a shell): single-quoted where needed, sanitized and redacted. A validated
 * env/header REFERENCE (`KEY=${NAME}`) is shown as it is: the redactor would hide the very text a person must review, and it holds no secret.
 */
export function displayCommand(args) {
  const reference = (arg) => { const at = arg.search(/=|: /); return at > 0 && (ENV_VALUE.test(arg.slice(at + 1)) || HEADER_VALUE.test(arg.slice(arg.indexOf(": ") + 2))); };
  const quoted = args.map((arg) => {
    const text = sanitizeForTerminal(String(arg));
    const shownText = reference(text) ? text : redactText(text).text;
    return bare.test(shownText) ? shownText : `'${shownText.replaceAll("'", "'\\''")}'`;
  });
  return ["claude", ...quoted].join(" ");
}

// --- builders: ONE place that knows the argv order ------------------------------------------------------------------------

/**
 * `claude mcp add` argv. Positionals first, then options, then (stdio) `-- command args`.
 * @param {{scope: "global"|"repo", name: string, transport?: "stdio"|"http"|"sse", env?: string[], headers?: string[], command?: string, args?: string[], url?: string}} spec
 *   `env`: ["KEY=${NAME}", ...]; `headers`: ["Name: ${NAME}", ...] (already in claude's wire form).
 */
export function buildMcpAddArgs({ scope, name, transport = "stdio", env = [], headers = [], command, args = [], url }) {
  const out = ["mcp", "add", name];
  if (transport === "http" || transport === "sse") out.push(url ?? "");
  out.push("-s", toClaudeScope(scope, "mcp"), "-t", transport);
  for (const entry of env) out.push("-e", entry);
  for (const entry of headers) out.push("-H", entry);
  if (transport === "stdio") out.push("--", command ?? "", ...args);
  return out;
}

export const buildMcpRemoveArgs = ({ scope, name }) => ["mcp", "remove", name, "-s", toClaudeScope(scope, "mcp")];

/** `claude plugin install|uninstall|enable|disable` argv (id first, then options). `config`: ["key=value", ...]. */
export function buildPluginArgs({ action, scope, id, config = [], keepData = false }) {
  const out = ["plugin", action, id, "-s", toClaudeScope(scope, "plugin")];
  for (const entry of config) out.push("--config", entry);
  if (keepData) out.push("--keep-data");
  return out;
}

// --- the supervised spawn -------------------------------------------------------------------------------------------------

const sanitizeOutput = (buffer) => redactText(sanitizeForTerminal(buffer.toString("utf8"))).text;

async function removeDirectory(directory, platform) {
  // On Windows a just-killed child can hold its working directory for a moment: wait, then retry the removal.
  if (platform === "win32") await new Promise((resolve) => setTimeout(resolve, 250));
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort */ }
}

/**
 * Run ONE allow-listed admin command and wait for it.
 *
 * Throws (nothing spawned): AdminError (exit 2) for a refused argv; CliError CLAUDE_UNAVAILABLE (exit 1) when claude is not installed
 * or too old. Otherwise resolves with the outcome, including a non-zero exit (`ok: false`): the caller decides what that means
 * and MUST still look at the files (a failed claude may have written half a change).
 *
 * @param {object} options
 * @param {string[]} options.args  After the binary, e.g. buildMcpAddArgs(...). Validated by parseAdminArgs against `scope`.
 * @param {"global"|"repo"} options.scope
 * @param {string} [options.cwd]  REQUIRED absolute repository root for scope "repo"; ignored for "global" (a fresh private temp dir is used).
 * @param {Function} [options.spawn] @param {Record<string,string|undefined>} [options.env]  Host env (filtered by env.mjs).
 * @param {string} [options.platform] @param {string} [options.claudePath]  Absolute path (test seam: node) @param {string[]} [options.claudeArgs]  Prefix before args (test seam).
 * @param {string} [options.claudeVersion] @param {number} [options.timeoutMs] @param {AbortSignal} [options.signal] @param {Function} [options.exists] @param {Function} [options.killTree]
 * @returns {Promise<{ok: boolean, exitCode: number|null, stdout: string, stderr: string, killed: boolean, timedOut: boolean, truncated: boolean, command: string, cwd: "repo"|"neutral", cwdPath: string}>}
 */
export async function runClaudeAdmin(options = {}) {
  const parsed = parseAdminArgs(options.args, options.scope);
  const platform = options.platform ?? process.platform;
  assertSupportedEnvironment(options.scope, options.env ?? process.env, platform);
  const spawn = options.spawn ?? nodeSpawn;
  const hostEnv = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? ADMIN_LIMITS.defaultDeadlineMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ADMIN_LIMITS.maxDeadlineMs) refuse("timeoutMs must be an integer from 1 to 600000.");
  const repoScope = options.scope === "repo";
  if (repoScope && (typeof options.cwd !== "string" || !isAbsolutePath(options.cwd, platform))) refuse("A repo-scope call needs the absolute repository root as cwd.");
  const command = displayCommand(options.args);
  const base = { ok: false, exitCode: null, stdout: "", stderr: "", killed: false, timedOut: false, truncated: false, command, cwd: repoScope ? "repo" : "neutral" };
  const neutral = repoScope ? null : mkdtempSync(path.join(tmpdir(), "asterweave-claude-admin-"));
  const cwd = neutral ?? options.cwd;
  const killTree = options.killTree ?? ((child) => killProcessTree(child, { platform, env: hostEnv }));
  try {
    if (options.signal?.aborted) return { ...base, killed: true, cwdPath: cwd };
    const checked = await checkClaude({ ...options, platform, spawn, env: hostEnv, killTree, cwd });
    if (!checked.ok) {
      if (checked.failure.class === "killed") return { ...base, killed: true, cwdPath: cwd };
      const described = describeFailure(checked.failure.class);
      throw new CliError(`${described.message}: ${shown(checked.failure.detail)}`, { code: "CLAUDE_UNAVAILABLE", exitCode: EXIT.ERROR, remediation: `${described.remediation} Nothing was changed.` });
    }
    const env = buildClaudeEnv(hostEnv, { platform });
    const raw = await new Promise((resolve) => {
      let settled = false;
      let stopping = false;
      let timedOut = false;
      let aborted = false;
      let spawnError = null;
      let exitCode = null;
      let truncated = false;
      const out = [Buffer.alloc(0), Buffer.alloc(0)];
      let child;
      const timers = [];
      const finish = () => {
        if (settled) return;
        settled = true;
        for (const timer of timers) clearTimeout(timer);
        options.signal?.removeEventListener?.("abort", onAbort);
        for (const stream of [child?.stdout, child?.stderr]) { try { stream?.destroy?.(); } catch { /* closed */ } }
        resolve({ timedOut, aborted, spawnError, exitCode, truncated, out });
      };
      const terminate = () => {
        if (settled || stopping) return;
        stopping = true;
        try { killTree(child); } catch { /* gone */ }
        timers.push(setTimeout(finish, options.killGraceMs ?? ADMIN_LIMITS.killGraceMs)); // never wait for a close that may not come
      };
      function onAbort() { aborted = true; terminate(); }
      try {
        child = spawn(checked.command, [...checked.prefix, ...options.args], { cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
      } catch (error) {
        spawnError = error;
        finish();
        return;
      }
      options.signal?.addEventListener?.("abort", onAbort, { once: true });
      timers.push(setTimeout(() => { timedOut = true; terminate(); }, timeoutMs));
      [child.stdout, child.stderr].forEach((stream, index) => {
        stream?.on("data", (chunk) => {
          if (settled) return;
          const room = ADMIN_LIMITS.maxOutputBytes - out[index].length;
          if (chunk.length > room) truncated = true;
          if (room > 0) out[index] = Buffer.concat([out[index], chunk.subarray(0, room)]);
        });
        stream?.on("error", () => {});
      });
      child.on("error", (error) => { spawnError ??= error; if (!child.pid) finish(); });
      child.on("close", (code) => { exitCode = code ?? null; finish(); });
    });
    const killed = raw.timedOut || raw.aborted;
    if (raw.spawnError && raw.exitCode === null && !killed) {
      throw new CliError(`claude could not be started (${shown(raw.spawnError.code ?? raw.spawnError.message)}).`, { code: "CLAUDE_UNAVAILABLE", exitCode: EXIT.ERROR, remediation: "Nothing was changed. Check that `claude` is a native executable on PATH." });
    }
    return { ...base, ok: !killed && raw.exitCode === 0, exitCode: raw.exitCode, stdout: sanitizeOutput(raw.out[0]), stderr: sanitizeOutput(raw.out[1]), killed, timedOut: raw.timedOut, truncated: raw.truncated, cwdPath: cwd };
  } finally {
    if (neutral !== null) await removeDirectory(neutral, platform);
  }
}
