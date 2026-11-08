// `asterweave mcp add|remove`: scoped MCP changes delegated to `claude mcp add|remove` through the shared mutation envelope
// (src/runtime/claude/mutate.mjs + admin.mjs). Asterweave owns the rules around the write:
//   - scope is explicit: global = Claude user scope (~/.claude.json), repo = Claude project scope (the repository's .mcp.json). Never `local`;
//   - env values and headers must be REFERENCES (`${NAME}` or `${cred:NAME}`), never literals: the file is shareable. A literal is refused
//     (exit 2) without being echoed. `${cred:NAME}` is an Asterweave reference that Claude Code does NOT expand (UNVERIFIED): a warning says so;
//   - http/sse urls must be https (http only for localhost); the resulting definition goes through the same linter as `mcp validate`;
//   - the result must be exactly the one intended entry, else UNEXPECTED_CHANGE; a repo-scope change makes the repository untrusted
//     (exit 4) until `asterweave trust grant` (or --trust, see mutate.mjs);
//   - `remove` (and `add`) delete the server's stored approval record so an identical re-add cannot revive it. `add` never creates one.
// Claude Code has NO CLI to enable or disable an MCP server: `mcp enable|disable` is a usage error that says so.

import * as nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { assertHumanContext } from "../runtime/approvals.mjs";
import { buildMcpAddArgs, buildMcpRemoveArgs, isEnvReference, isHeaderReference, remoteUrlProblem, toClaudeScope } from "../runtime/claude/admin.mjs";
import { diffUnits, parseUnits, serverEntryProblems } from "../runtime/claude/diff.mjs";
import { applyMutation } from "../runtime/claude/mutate.mjs";
import { lintServer, normalizeServer, removeApprovals, SERVER_NAME } from "../runtime/tools/mcp-config.mjs";
import { repositoryIdentity, TRUST_FILES } from "../trust.mjs";
import { repeatedOption } from "./images.mjs";
import { defaultRepoPath, seams, stringOption } from "./shared.mjs";

export const MCP_ADMIN_OPTIONS = Object.freeze(["scope", "transport", "env", "header", "yes", "trust"]);
export const MCP_ADMIN_BOOLEAN = Object.freeze(["yes", "trust"]);
export const ADD_USAGE = "asterweave mcp add <name> --scope global|repo [--transport stdio|http|sse] [--env KEY='${VAR}']... [--header 'Name: ${VAR}']... [--yes] [--trust] [--json] (-- <command> [args...] | <url>)";
export const REMOVE_USAGE = "asterweave mcp remove <name> --scope global|repo [--yes] [--trust] [--json]";
export const ADMIN_HELP = [
  "  add       claude mcp add -s user|project: --scope global (user) or repo (the repository's .mcp.json, which then needs trust again). env/header values must be",
  "            references (--env KEY='${VAR}', single-quoted so your shell does not expand it); literals are refused. stdio: after `--`; http/sse: a https url. Shows the exact command; y/N or --yes",
  "  remove    claude mcp remove -s user|project, and deletes the server's stored approval record",
  "            --trust (repo scope) re-grants trust only if the repository was trusted before and the result is verified as exactly this change. Claude Code has no enable/disable CLI: use remove/add",
];

const safe = (text, limit = 80) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const COLLECTIONS = Object.freeze({ ".mcp.json": ["mcpServers"], ".claude/settings.json": ["enabledPlugins"], ".claude/settings.local.json": ["enabledPlugins"], ".claude/asterweave.json": [] });
const USER_LABEL = "~/.claude.json";

/** Admin-only options are refused on the read-only subcommands, and the read-only ones on add/remove. */
export function rejectOptions(ctx, names, sub) {
  const bad = names.find((name) => ctx.options?.[name] !== undefined);
  if (bad !== undefined) throw new UsageError(`--${bad} does not apply to 'mcp ${sub}'.`);
}

function repoOf(ctx, { required }) {
  const flag = stringOption(ctx, "path", "Usage: " + ADD_USAGE);
  const target = flag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), flag);
  try {
    return repositoryIdentity(target, seams(ctx));
  } catch (error) {
    if (required) throw error;
    return null;
  }
}

function readServers(file, fs) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return { servers: new Map(), text: null };
    throw new CliError(`${safe(path.basename(file))} cannot be read.`, { code: "MCP_FILE_UNREADABLE", remediation: "Nothing was changed." });
  }
  const units = parseUnits(text, { collections: ["mcpServers"], only: ["mcpServers"] });
  if (units.state === "invalid") throw new CliError(`${safe(path.basename(file))} is not valid JSON, so it is not changed.`, { code: "MCP_FILE_INVALID", remediation: "Fix the file, then retry. Nothing was changed." });
  return { servers: units.values, text };
}

function scopeOf(ctx, usage) {
  const scope = stringOption(ctx, "scope", usage);
  if (scope === undefined) throw new UsageError("--scope global|repo is required.", { remediation: usage });
  if (scope === "local") throw new UsageError("The local scope is never used.", { remediation: "Use --scope global (Claude user) or --scope repo (Claude project)." });
  if (scope !== "global" && scope !== "repo") throw new UsageError("--scope must be global or repo.", { remediation: usage });
  return scope;
}

/** snapshot + verify for one server change: text of the watched files; exactly one unit may differ. */
function watcher({ scope, repoRoot, userFile, fs, name, action, want }) {
  const files = scope === "repo" ? TRUST_FILES.map((relative) => ({ label: relative, file: path.join(repoRoot, ...relative.split("/")) })) : [{ label: USER_LABEL, file: userFile }];
  const target = scope === "repo" ? ".mcp.json" : USER_LABEL;
  // repo scope: the envelope hands over the bytes it hashed (never re-read here); global scope reads its own file
  const snapshot = (governing) => (scope === "repo" && governing ? { ...governing } : Object.fromEntries(files.map(({ label, file }) => {
    try { return [label, fs.readFileSync(file, "utf8")]; } catch (error) { return [label, error?.code === "ENOENT" || error?.code === "ENOTDIR" ? null : "\u0000unreadable"]; }
  })));
  const parse = (label, text) => parseUnits(text, { collections: COLLECTIONS[label] ?? ["mcpServers"], only: scope === "global" ? ["mcpServers"] : null });
  const verify = (before, after) => {
    const problems = [];
    const changes = [];
    let entry;
    for (const { label } of files) {
      const was = parse(label, before[label]);
      const now = parse(label, after[label]);
      for (const change of diffUnits(was, now)) changes.push({ label, ...change });
      if (label === target) entry = now.values.get(`mcpServers.${name}`);
    }
    const expectedOp = action === "add" ? "added" : "removed";
    const wanted = changes.filter((change) => change.label === target && change.unit === `mcpServers.${name}` && change.op === expectedOp);
    if (wanted.length !== 1) problems.push(`the ${action === "add" ? "new" : "removed"} entry is not what changed`);
    const others = changes.length - wanted.length;
    if (others > 0) problems.push(`${others} other change(s): ${changes.filter((c) => !wanted.includes(c)).slice(0, 5).map((c) => `${c.label} ${c.unit}`).join(", ")}`);
    if (action === "add" && wanted.length === 1) problems.push(...serverEntryProblems(entry, want));
    return { ok: problems.length === 0, problems };
  };
  const changedLabels = (before, after) => files.filter(({ label }) => before[label] !== after[label]).map(({ label }) => label);
  return { snapshot, verify, changedLabels, target };
}

function refs(values, check, what, usage) {
  return values.map((raw) => {
    if (typeof raw !== "string") throw new UsageError(`--${what} needs a value.`, { remediation: usage });
    const at = what === "env" ? raw.indexOf("=") : raw.indexOf(": ");
    const key = at > 0 ? raw.slice(0, at) : "";
    const value = at > 0 ? raw.slice(at + (what === "env" ? 1 : 2)) : "";
    if (at <= 0 || (what === "env" && !ENV_KEY.test(key))) throw new UsageError(`--${what} needs ${what === "env" ? "KEY=${VAR}" : "'Name: ${VAR}'"}.`, { remediation: usage });
    if (!check(value)) {
      throw new UsageError(`--${what} ${safe(key, 40)} is not a reference: the value must be \${NAME} (upper case) or \${cred:NAME}, never a literal (it was not echoed).`, {
        code: "MCP_ENV_LITERAL",
        remediation: "Export the variable and pass a reference, single-quoted so your shell does not expand it, e.g. --env API_KEY='${MY_API_KEY}'. The file is shareable, so it must never hold a secret.",
      });
    }
    return { key, value, raw };
  });
}

function render(ctx, body, lines) {
  if (ctx.options?.json === true) ctx.stdout.write(`${stringifyJson(body)}\n`);
  else ctx.stdout.write(`${sanitizeLines(lines.join("\n"))}\n`);
  return Number.isInteger(body.exitCode) ? body.exitCode : EXIT.OK;
}

async function run(ctx, { action, name, scope, repo, args, summary, warnings, want, source }) {
  const fs = ctx.fs ?? nodeFs;
  const userFile = path.join((ctx.homedir ?? osHomedir)(), ".claude.json");
  const w = watcher({ scope, repoRoot: repo?.realpath, userFile, fs, name, action, want });
  const file = scope === "repo" ? path.join(repo.realpath, ".mcp.json") : userFile;
  const entryGone = () => { try { return !readServers(file, fs).servers.has(`mcpServers.${name}`); } catch { return false; } };
  // The stored approval of a server must not outlive the server: delete it whenever the file shows the entry gone (also after an
  // unexpected change or a claude failure that wrote first), and say so when the deletion fails. `add` clears a leftover record on success.
  const warn = [];
  const dropApproval = () => {
    try { return removeApprovals(repo?.key ?? null, source, name, seams(ctx)); } catch (error) {
      warn.push(`The stored approval record of '${safe(name)}' could not be deleted (${safe(error?.message, 100)}); remove it by editing mcp-approvals.json or re-approve with mcp test.`);
      return 0;
    }
  };
  let result;
  try {
    result = await applyMutation({
      ctx, kind: "mcp", action, scope, id: name, repoRoot: repo?.realpath, args, warnings, summary,
      files: scope === "repo" ? [".mcp.json (other trust-governing files are checked)"] : ["~/.claude.json (the mcpServers entry; other keys are Claude's own and ignored)"],
      snapshot: w.snapshot, verify: w.verify, changedLabels: w.changedLabels, expectedFiles: [".mcp.json"],
      yes: ctx.options?.yes === true, trust: ctx.options?.trust === true, json: ctx.options?.json === true,
    });
  } catch (error) {
    if (action === "remove" && entryGone()) dropApproval();
    for (const line of warn) ctx.stderr.write(`Warning: ${line}
`);
    throw error;
  }
  const approvalsRemoved = action === "remove" || action === "add" ? dropApproval() : 0;
  const body = { ok: true, action, name: safe(name), scope, claudeScope: toClaudeScope(scope, "mcp"), command: result.command, verified: true, changedFiles: result.changedFiles, trust: result.trust, approvalsRemoved, warnings: [...warnings, ...warn], exitCode: result.exitCode };
  const { exitCode: _exit, ...doc } = body;
  const lines = [
    `Done: mcp ${action} ${safe(name)} (${scope} scope, Claude ${body.claudeScope}).`,
    `verified: yes, exactly the intended change`,
    `repository trust: ${result.trust.state}`,
    ...(result.trust.remediation ? [result.trust.remediation] : []),
    ...warn.map((line) => `Warning: ${line}`),
    ...(approvalsRemoved > 0 ? [`removed ${approvalsRemoved} stored approval record(s) for this server.`] : []),
    ...(action === "add" ? ["Next: asterweave mcp inspect then mcp test to review and approve it (nothing was started)."] : []),
  ];
  render(ctx, doc, lines);
  return body.exitCode;
}

export async function mcpAddCommand(ctx, rest) {
  assertHumanContext(ctx.env, "MCP changes");
  rejectOptions(ctx, ["approve", "source"], "add");
  const [name, url, ...extra] = rest;
  if (name === undefined) throw new UsageError("Missing server name.", { remediation: `Usage: ${ADD_USAGE}` });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${safe(extra[0], 40)}'.`, { remediation: `Usage: ${ADD_USAGE}` });
  if (!SERVER_NAME.test(name)) throw new UsageError(`'${safe(name, 40)}' is not a valid server name (letters, digits, _ . - ; at most 64; no leading symbol).`, { remediation: `Usage: ${ADD_USAGE}` });
  const scope = scopeOf(ctx, `Usage: ${ADD_USAGE}`);
  const transport = stringOption(ctx, "transport", `Usage: ${ADD_USAGE}`) ?? (url === undefined ? "stdio" : "http");
  if (!["stdio", "http", "sse"].includes(transport)) throw new UsageError(`Unknown transport '${safe(transport, 20)}'.`, { remediation: "Use stdio, http or sse." });
  const remote = transport !== "stdio";
  const command = ctx.rest ?? [];
  if (remote) {
    if (url === undefined || command.length > 0) throw new UsageError(`An ${transport} server takes exactly one url and no '--' command.`, { remediation: `Usage: ${ADD_USAGE}` });
    const problem = remoteUrlProblem(url);
    if (problem !== null) throw new UsageError(`Refused: ${problem}.`, { remediation: "Use an https url (http is accepted only for localhost) without credentials in it; pass credentials as a --header reference." });
  } else if (url !== undefined || command.length === 0) throw new UsageError("A stdio server needs its command after `--`.", { remediation: `Usage: ${ADD_USAGE}` });
  const envEntries = refs(repeatedOption(ctx, "env"), isEnvReference, "env", `Usage: ${ADD_USAGE}`);
  const headerEntries = refs(repeatedOption(ctx, "header"), isHeaderReference, "header", `Usage: ${ADD_USAGE}`);
  if (remote && envEntries.length > 0) throw new UsageError("An http/sse server takes --header, not --env.", { remediation: `Usage: ${ADD_USAGE}` });
  if (!remote && headerEntries.length > 0) throw new UsageError("A stdio server takes --env, not --header.", { remediation: `Usage: ${ADD_USAGE}` });

  const repo = repoOf(ctx, { required: scope === "repo" });
  const source = scope === "repo" ? "project" : "user";
  const file = scope === "repo" ? path.join(repo.realpath, ".mcp.json") : path.join((ctx.homedir ?? osHomedir)(), ".claude.json");
  if (readServers(file, ctx.fs ?? nodeFs).servers.has(`mcpServers.${name}`)) {
    throw new CliError(`An MCP server named '${safe(name, 40)}' already exists in the ${scope} scope.`, { code: "MCP_EXISTS", remediation: `Remove it first (asterweave mcp remove ${safe(name, 40)} --scope ${scope}), then add it again. Nothing was changed.` });
  }
  const want = remote
    ? { transport, url, headers: Object.fromEntries(headerEntries.map((h) => [h.key, h.value])) }
    : { transport, command: command[0], args: command.slice(1), env: Object.fromEntries(envEntries.map((e) => [e.key, e.value])) };
  const raw = remote ? { type: transport, url, headers: want.headers } : { type: "stdio", command: command[0], args: want.args, env: want.env };
  const findings = lintServer(normalizeServer({ name, source, file, raw }), { env: ctx.env, platform: ctx.platform, exists: ctx.exists });
  const errors = findings.filter((f) => f.level === "error");
  if (errors.length > 0) throw new UsageError(`The definition is not acceptable: ${errors.map((f) => `${f.code}: ${f.message}`).join("; ")}`, { code: "MCP_DEFINITION_INVALID", remediation: "Fix the definition (`asterweave mcp validate` uses the same checks). Nothing was changed." });
  const warnings = findings.filter((f) => f.level === "warn" && f.code !== "MCP_COMMAND_MISSING").map((f) => f.message);
  if ([...envEntries, ...headerEntries].some((e) => e.value.includes("${cred:"))) warnings.push("${cred:NAME} is Asterweave's reference form; Claude Code does not expand it (UNVERIFIED), so only `asterweave mcp test` resolves it. Use ${NAME} for Claude Code.");
  const args = buildMcpAddArgs({ scope, name, transport, env: envEntries.map((e) => e.raw), headers: headerEntries.map((h) => h.raw), command: command[0], args: command.slice(1), url });
  const summary = [`MCP add: ${safe(name)}  scope: ${scope} (Claude ${toClaudeScope(scope, "mcp")})  transport: ${transport}`, ...envEntries.map((e) => `  env ${safe(e.key, 60)} <- ${e.value}`), ...headerEntries.map((h) => `  header ${safe(h.key, 60)} <- ${h.value}`)];
  return run(ctx, { action: "add", name, scope, repo, args, summary, warnings, want, source });
}

export async function mcpRemoveCommand(ctx, rest) {
  assertHumanContext(ctx.env, "MCP changes");
  rejectOptions(ctx, ["approve", "source", "transport", "env", "header"], "remove");
  const [name, ...extra] = rest;
  if (name === undefined) throw new UsageError("Missing server name.", { remediation: `Usage: ${REMOVE_USAGE}` });
  if (extra.length > 0 || (ctx.rest ?? []).length > 0) throw new UsageError("Unexpected argument.", { remediation: `Usage: ${REMOVE_USAGE}` });
  if (!SERVER_NAME.test(name)) throw new UsageError(`'${safe(name, 40)}' is not a valid server name.`, { remediation: `Usage: ${REMOVE_USAGE}` });
  const scope = scopeOf(ctx, `Usage: ${REMOVE_USAGE}`);
  const repo = repoOf(ctx, { required: scope === "repo" });
  const file = scope === "repo" ? path.join(repo.realpath, ".mcp.json") : path.join((ctx.homedir ?? osHomedir)(), ".claude.json");
  if (!readServers(file, ctx.fs ?? nodeFs).servers.has(`mcpServers.${name}`)) {
    throw new CliError(`No MCP server named '${safe(name, 40)}' is defined in the ${scope} scope.`, { code: "MCP_NOT_FOUND", remediation: "Run `asterweave mcp list` to see the configured servers. Nothing was changed." });
  }
  const args = buildMcpRemoveArgs({ scope, name });
  const summary = [`MCP remove: ${safe(name)}  scope: ${scope} (Claude ${toClaudeScope(scope, "mcp")})`, "Its stored approval record is deleted too."];
  return run(ctx, { action: "remove", name, scope, repo, args, summary, warnings: [], want: null, source: scope === "repo" ? "project" : "user" });
}

export function mcpEnableDisable(sub) {
  throw new UsageError(`'mcp ${sub}' does not exist: Claude Code has no CLI to enable or disable an MCP server.`, { remediation: "Use `asterweave mcp remove <name> --scope ...` and `asterweave mcp add ...` instead. Nothing was changed." });
}
