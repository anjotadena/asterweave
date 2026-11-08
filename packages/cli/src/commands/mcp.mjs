// `asterweave mcp list|inspect|validate|test`.
//
// list / inspect / validate only PARSE configuration (repo `.mcp.json`, the user-level Claude file, plugin `.mcp.json` files):
// they never start a process. `mcp test` is the ONLY command that spawns a server, and only to run initialize + tools/list
// (never tools/call), after the repository is trusted (project servers) and an approval bound to the definition hash exists.
// An approval is granted ONLY by an interactive y/N prompt (stdin and stdout both a TTY, no --json). `--approve <hash>` does not
// grant anything by itself: it is a PIN that must match the definition hash (or, after a tool-list change, the new descriptor
// hash) and the prompt is still asked. Without a terminal the command exits 6 "approve in a terminal". It refuses (exit 7)
// when the environment shows an agent context (ASTERWEAVE_RUN_ID, ASTERWEAVE_SESSION_ID, CLAUDECODE, CLAUDE_CODE_*); that check is
// advisory and the whole mechanism is defence in depth, not a sandbox (see website/docs/cli/policy-and-guards.md).
// It records the discovered tools in <userDir>/mcp-approvals.json.
//
// Exit codes: 0 ok · 1 unavailable server / error · 2 usage · 4 repository not trusted · 5 `validate` found problems
// (the CLI's configuration-invalid code; 3 is authentication) · 6 approval required · 7 refused (agent environment markers, wrong confirmation) · 130 interrupted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { assertHumanContext } from "../runtime/approvals.mjs";
import { stringifyJson } from "../json.mjs";
import { resolveBinary } from "../proc.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { McpError, startMcpClient } from "../runtime/tools/mcp-client.mjs";
import {
  approvalState, credentialRef, cwdLabel, envReference, definitionHashOf, definitionOf, displayServer, lintServer, loadMcpServers, readApproval, resolveServerEnv, saveApproval,
} from "../runtime/tools/mcp-config.mjs";
import { descriptorHash } from "../runtime/tools/descriptor.mjs";
import { assertTrusted, repositoryIdentity, safeTrustStatus } from "../trust.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { defaultRepoPath, isInteractive, seams, stringOption } from "./shared.mjs";
import { ADMIN_HELP, ADD_USAGE, mcpAddCommand, mcpEnableDisable, mcpRemoveCommand, MCP_ADMIN_BOOLEAN, MCP_ADMIN_OPTIONS, REMOVE_USAGE, rejectOptions } from "./mcp-admin.mjs";

export const mcpCommandMeta = Object.freeze({ summary: "List, inspect, validate and test MCP server definitions", boolean: ["json", ...MCP_ADMIN_BOOLEAN], options: ["json", "approve", "source", "path", ...MCP_ADMIN_OPTIONS] });

const USAGE = `Usage: asterweave mcp list [--json] | inspect <name> [--source project|user|plugin] [--json] | validate [--json] | test <name> [--source s] [--approve <definitionHash>] [--json] | ${ADD_USAGE.replace("asterweave mcp ", "")} | ${REMOVE_USAGE.replace("asterweave mcp ", "")}`;

export const mcpHelpText = `${[
  "asterweave mcp - MCP server definitions (parse-only except `test`)",
  "",
  USAGE,
  "",
  "  list      servers from .mcp.json, the user Claude file and plugin caches, with trust/approval state; never starts a server",
  "  inspect   one definition: redacted, descriptor hash, what a spawn would run, warnings; never starts a server",
  "  validate  schema, duplicate names, secrets, env values that are not ${NAME} or ${cred:NAME} references; exit 5 when problems are found",
  "  test      the ONLY command that starts a server: initialize + tools/list, never tools/call; needs repository trust and an approval given at a terminal prompt (--approve <hash> only pins what you reviewed)",
  "",
  ...ADMIN_HELP,
  "",
  "Source precedence between project, user and plugin definitions is not verified here: they are listed separately, never merged.",
  "Exit codes: 0 ok · 1 server unavailable or error · 2 usage · 4 repository not trusted (also: add/remove --scope repo applied and verified, repository now untrusted) · 5 validate found problems · 6 approval required (mcp test) · 7 refused (agent environment markers, wrong confirmation) · 130 interrupted",
].join("\n")}\n`;

const write = (stream, text) => stream.write(text);
const safe = (text) => sanitizeForTerminal(String(text ?? ""));

function context(ctx) {
  const pathFlag = stringOption(ctx, "path", USAGE);
  const repoPath = pathFlag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), pathFlag);
  const options = seams(ctx);
  const identity = repositoryIdentity(repoPath, options);
  const loaded = loadMcpServers({ repoRoot: identity.realpath, homedir: ctx.homedir, fs: ctx.fs });
  return { identity, options, ...loaded };
}

function trustOf(server, c) {
  if (server.source !== "project") return { trusted: true, label: `${server.source}-defined` };
  const status = safeTrustStatus(c.identity.realpath, c.options);
  return { trusted: status.trusted, label: status.trusted ? "trusted" : `untrusted (${status.reason})` };
}

function row(server, c) {
  const definitionHash = definitionHashOf(server, cwdLabel(server, c.identity.realpath));
  const approval = readApproval(c.identity.key, server.source, server.name, c.options);
  const refs = Object.entries(server.env).filter(([, value]) => credentialRef(value) !== null);
  const present = refs.filter(([, value]) => typeof c.options.env?.[credentialRef(value)] === "string" && c.options.env[credentialRef(value)] !== "").length;
  const duplicates = c.servers.filter((other) => other.name === server.name).length;
  return {
    ...displayServer(server),
    trust: trustOf(server, c).label,
    approval: approvalState(approval, definitionHash),
    auth: refs.length === 0 ? "not checked" : present === refs.length ? "present" : "missing",
    health: "not checked",
    duplicateSources: duplicates > 1,
    definitionHash,
  };
}

function pick(c, name, ctx) {
  if (name === undefined) throw new UsageError("Missing server name.", { remediation: USAGE });
  const source = stringOption(ctx, "source", USAGE);
  const matches = c.servers.filter((server) => server.name === name && (source === undefined || server.source === source));
  if (matches.length === 0) throw new CliError(`No MCP server named '${safe(name).slice(0, 64)}' is configured.`, { code: "MCP_NOT_FOUND", remediation: "Run `asterweave mcp list` to see the configured servers." });
  if (matches.length > 1) throw new UsageError(`'${safe(name).slice(0, 64)}' is defined in ${matches.length} sources.`, { remediation: "Choose one with --source project|user|plugin (precedence between them is not verified)." });
  return matches[0];
}

function noExtra(extra) {
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${safe(extra[0]).slice(0, 40)}'.`, { remediation: USAGE });
}

// --- list ---------------------------------------------------------------------------------

function listServers(ctx) {
  const c = context(ctx);
  const rows = c.servers.map((server) => row(server, c));
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, precedence: c.precedence, servers: rows.map(({ definitionHash: _hash, ...rest }) => rest), issues: c.issues })}\n`);
    return EXIT.OK;
  }
  const lines = rows.length === 0 ? ["No MCP servers are configured."] : rows.map((r) => `${r.name}  [${r.source}] ${r.file}\n    ${r.transport}  ${r.command ? `${r.command} ${r.args.join(" ")}`.trim() : r.url ?? "(no command)"}${r.enabled ? "" : "  (disabled)"}\n    trust: ${r.trust}  approval: ${r.approval}  auth: ${r.auth}  health: ${r.health}${r.duplicateSources ? "  DUPLICATE NAME across sources" : ""}`);
  for (const issue of c.issues) lines.push(`Warning: ${issue.file} ${issue.message}`);
  lines.push("", `Precedence: ${c.precedence}.`);
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

// --- inspect ------------------------------------------------------------------------------

function inspectServer(ctx, name) {
  const c = context(ctx);
  const server = pick(c, name, ctx);
  const r = row(server, c);
  const warnings = lintServer(server, { env: c.options.env, platform: c.options.platform, exists: ctx.exists }).map((f) => ({ level: f.level, code: f.code, message: f.message }));
  const spawnPlan = server.transport === "stdio" ? { command: r.command, args: r.args, cwd: server.source === "project" ? c.identity.realpath : "a new empty temporary directory", envRefs: Object.fromEntries(Object.entries(server.env).map(([k, v]) => [safe(k).slice(0, 60), envReference(v) === null ? "[literal]" : envReference(v).kind === "var" ? `env:${envReference(v).name}` : envReference(v).name])), shell: false, note: "display only; nothing was started" } : null;
  const view = { ...r, spawn: spawnPlan, warnings };
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, server: view })}\n`);
    return EXIT.OK;
  }
  const lines = [
    `${r.name} [${r.source}] ${r.file}`,
    `transport: ${r.transport}${r.enabled ? "" : " (disabled)"}`,
    r.command ? `command: ${r.command} ${r.args.join(" ")}`.trimEnd() : `url: ${r.url ?? "(none)"}`,
    `env: ${Object.keys(r.env).length === 0 ? "(none)" : Object.entries(r.env).map(([k, v]) => `${k} <- ${v}`).join(", ")}`,
    `definition hash: ${r.definitionHash}`,
    `trust: ${r.trust}  approval: ${r.approval}  auth: ${r.auth}  health: ${r.health}`,
    spawnPlan ? `a spawn would run: ${spawnPlan.command} ${spawnPlan.args.join(" ")} (cwd ${spawnPlan.cwd}, shell: no, env: PATH + ${Object.entries(spawnPlan.envRefs).map(([k, v]) => `${k} <- ${v === "[literal]" ? v : server.env[Object.keys(server.env).find((key) => safe(key).slice(0, 60) === k)]}`).join(", ") || "nothing else"})` : "a spawn is not supported for this transport in this build",
    ...warnings.map((w) => `${w.level === "error" ? "Problem" : "Warning"}: ${w.message}`),
  ];
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

// --- validate -----------------------------------------------------------------------------

function validateServers(ctx) {
  const c = context(ctx);
  const problems = c.issues.map((issue) => ({ server: null, file: safe(issue.file), code: "MCP_FILE_INVALID", message: `${issue.file} ${issue.message}` }));
  const names = new Map();
  for (const server of c.servers) names.set(server.name, [...(names.get(server.name) ?? []), server.source]);
  for (const server of c.servers) {
    for (const finding of lintServer(server, { env: c.options.env, platform: c.options.platform, exists: ctx.exists })) {
      if (finding.level === "error") problems.push({ server: safe(server.name).slice(0, 64), file: safe(server.file), code: finding.code, message: finding.message });
    }
    if (names.get(server.name).length > 1 && names.get(server.name)[0] === server.source) problems.push({ server: safe(server.name).slice(0, 64), file: safe(server.file), code: "MCP_DUPLICATE_NAME", message: `defined in more than one source (${names.get(server.name).join(", ")})` });
  }
  const clean = problems.length === 0;
  if (ctx.options?.json === true) write(ctx.stdout, `${stringifyJson({ ok: clean, checked: c.servers.length, problems })}\n`);
  else write(ctx.stdout, `${sanitizeLines(clean ? `${c.servers.length} MCP server(s) checked: no problems.` : [`${problems.length} problem(s) in ${c.servers.length} MCP server(s):`, ...problems.map((p) => `  ${p.server ?? "-"} ${p.code}: ${safe(p.message)}`)].join("\n"))}\n`);
  return clean ? EXIT.OK : EXIT.CONFIG;
}

// --- test ---------------------------------------------------------------------------------

async function confirm(ctx, lines) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(`${sanitizeLines(lines)} `);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

function unavailable(error) {
  return new CliError(`MCP server unavailable: ${safe(error.message)}`, { code: error.code, exitCode: EXIT.ERROR, remediation: error.remediation ?? "Check the server definition with `asterweave mcp inspect`." });
}

const hexPrefix = (value) => typeof value === "string" && /^[0-9a-f]{12,64}$/i.test(value);

/** `KEY <- ${NAME}` / `KEY <- ${cred:NAME}` lines: which variable each env key would receive (names only, never values). */
const envPlan = (server) => Object.entries(server.env).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => `  ${safe(key).slice(0, 60)} <- ${credentialRef(value) === null ? "[literal value: refused]" : value}`);

async function testServer(ctx, name) {
  assertHumanContext(ctx.env, "MCP approvals");
  const approveFlag = ctx.options?.approve;
  if (approveFlag === true) throw new UsageError("--approve needs the hash shown by `asterweave mcp inspect`.", { remediation: USAGE });
  if (typeof approveFlag === "string" && !hexPrefix(approveFlag)) throw new UsageError("--approve needs at least 12 hex characters of a hash.", { remediation: USAGE });
  const c = context(ctx);
  let server = pick(c, name, ctx);
  if (server.source === "project") {
    // Trust is checked on the bytes of .mcp.json that were hashed, and the definition is built from THOSE bytes (no second read).
    const status = assertTrusted(c.identity.realpath, "start repository-defined MCP servers", c.options);
    server = pick({ servers: loadMcpServers({ repoRoot: c.identity.realpath, homedir: ctx.homedir, fs: ctx.fs, projectBytes: status.mcp }).servers }, name, { options: { source: "project" } });
  }
  if (server.problems.length > 0) throw new CliError("The server definition is invalid; run `asterweave mcp validate`.", { code: "MCP_DEFINITION_INVALID", exitCode: EXIT.CONFIG, remediation: "Run `asterweave mcp validate` for the list." });
  if (server.transport !== "stdio") throw new CliError(`Only stdio servers can be tested in this build (this one is ${server.transport}).`, { code: "MCP_TRANSPORT_UNSUPPORTED", remediation: "No process was started." });
  if (!server.enabled) throw new CliError("The server is disabled in its configuration.", { code: "MCP_DISABLED", remediation: "No process was started." });

  const label = cwdLabel(server, c.identity.realpath);
  const definitionHash = definitionHashOf(server, label);
  const stored = readApproval(c.identity.key, server.source, server.name, c.options);
  const preApproved = approvalState(stored, definitionHash) === "valid";
  const shown = displayServer(server);
  const plan = [
    `MCP server '${shown.name}' [${shown.source}] would run: ${shown.command} ${shown.args.join(" ")}`.trimEnd(),
    `cwd: ${server.source === "project" ? c.identity.realpath : "a new empty temporary directory (not the repository)"}  shell: no`,
    `env: PATH${Object.keys(server.env).length === 0 ? " only" : " plus"}`,
    ...envPlan(server),
    `definition hash: ${definitionHash}`,
    "Only initialize and tools/list are sent; no tool is called.",
  ];

  // Only a person at a terminal can approve: stdin and stdout are a TTY and there is no --json. --approve is a pin, never a grant.
  const canPrompt = isInteractive(ctx) && ctx.options?.json !== true;
  let fresh = false; // approved in THIS invocation for the definition (or no approval was needed)
  if (!preApproved) {
    if (typeof approveFlag === "string" && !definitionHash.startsWith(approveFlag.toLowerCase())) throw new UsageError("--approve does not match the definition hash of this server.", { remediation: `Review it with \`asterweave mcp inspect ${safe(server.name).slice(0, 64)}\` and quote at least 12 hex characters of its definition hash.` });
    if (!canPrompt) {
      throw new CliError("Starting this MCP server needs an approval, and approvals are only given at an interactive terminal prompt.", { code: "APPROVAL_REQUIRED", exitCode: EXIT.APPROVAL_REQUIRED, remediation: `Approve in a terminal (no --json): asterweave mcp test ${safe(server.name).slice(0, 64)} --approve ${definitionHash.slice(0, 16)}` });
    }
    const answer = await confirm(ctx, [...plan, "Start it and approve the tools it lists? [y/N]"]);
    if (answer.interrupted) return EXIT.INTERRUPTED;
    if (answer.yes !== true) throw new CliError("Not approved; nothing was started.", { code: "APPROVAL_DECLINED", remediation: "Nothing was changed." });
    fresh = true;
  }

  const resolved = resolveServerEnv(server.env, (ref) => ctx.env?.[ref]);
  if (resolved.literal.length > 0) throw new CliError(`env ${resolved.literal.map((k) => safe(k).slice(0, 40)).join(", ")} ${resolved.literal.length > 1 ? "are" : "is"} not a credential reference.`, { code: "MCP_ENV_LITERAL", exitCode: EXIT.ERROR, remediation: "Write env values as ${NAME} or ${cred:NAME}; nothing was started." });
  if (resolved.missing.length > 0) throw new CliError(`No value for the credential reference(s) of env ${resolved.missing.map((k) => safe(k).slice(0, 40)).join(", ")}.`, { code: "MCP_CREDENTIAL_MISSING", remediation: "Set the referenced environment variable(s); nothing was started." });
  const found = resolveBinary(server.command, { env: c.options.env ?? process.env, platform: c.options.platform, ...(ctx.exists ? { exists: ctx.exists } : {}) });
  if (!found.path) throw new CliError(found.reason === "SHELL_SHIM_ONLY" ? "The command resolves only to a .cmd/.bat shim, which is not started (no shell is used)." : "The server command was not found on PATH.", { code: "MCP_COMMAND_MISSING", remediation: found.reason === "SHELL_SHIM_ONLY" ? "Point the definition at the real executable." : "Install the server or fix its command; nothing was started." });

  // User and plugin servers never run in the repository: they get an empty directory of their own.
  const neutral = server.source === "project" ? null : mkdtempSync(path.join(tmpdir(), "asterweave-mcp-"));
  const started = performance.now();
  let client;
  let info;
  let listing;
  try {
    client = startMcpClient({ command: found.path, args: server.args, cwd: neutral ?? c.identity.realpath, env: resolved.env }, { spawn: ctx.spawn, hostEnv: c.options.env ?? process.env, platform: c.options.platform, signal: ctx.signal, deadlineMs: 30_000 });
    info = await client.initialize();
    listing = await client.listTools();
  } catch (error) {
    if (error instanceof McpError) throw unavailable(error);
    throw error;
  } finally {
    client?.close();
    // On Windows the killed child can hold its working directory for a moment: wait, then retry the removal.
    if (neutral !== null) { await new Promise((resolve) => setTimeout(resolve, 250)); try { rmSync(neutral, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* best effort */ } }
  }
  const latencyMs = Math.round(performance.now() - started);
  const hash = descriptorHash(definitionOf(server, label), listing.tools);
  const names = listing.tools.map((tool) => tool.name);
  const changed = stored !== null && preApproved && stored.descriptorHash !== hash;
  if (changed) {
    // The old token (the definition hash) never re-approves a changed tool list: the NEW full descriptor hash must be quoted.
    const confirmed = typeof approveFlag === "string" && hash.startsWith(approveFlag.toLowerCase());
    const added = names.filter((n) => !stored.tools.includes(n));
    const removed = stored.tools.filter((n) => !names.includes(n));
    const summary = `added: ${added.map((n) => safe(n).slice(0, 80)).join(", ") || "none"}; removed: ${removed.map((n) => safe(n).slice(0, 80)).join(", ") || "none"}`;
    if (!confirmed || !canPrompt) {
      throw new CliError(`The tool list, a tool description or a tool schema changed since approval (${summary}). The approval is stale.`, { code: "APPROVAL_REQUIRED", exitCode: EXIT.APPROVAL_REQUIRED, remediation: `Review the tools, then approve in a terminal (no --json): asterweave mcp test ${safe(server.name).slice(0, 64)} --approve ${hash}` });
    }
    const answer = await confirm(ctx, [`MCP server '${shown.name}' changed since you approved it (${summary}).`, `New tool list: ${names.map((n) => safe(n).slice(0, 80)).join(", ") || "(none)"}`, "Approve the new tool list? [y/N]"]);
    if (answer.interrupted) return EXIT.INTERRUPTED;
    if (answer.yes !== true) throw new CliError("Not approved; the stored approval was left as it was.", { code: "APPROVAL_DECLINED", remediation: "Nothing was changed." });
  }
  let approvalResult = "existing";
  if (fresh || changed || stored === null) {
    saveApproval(c.identity.key, server.source, server.name, { definitionHash, descriptorHash: hash, tools: names, approvedAt: (ctx.now ? ctx.now() : new Date().toISOString()) }, c.options);
    approvalResult = "recorded";
  }
  const result = { ok: true, server: { name: shown.name, source: shown.source }, serverInfo: info, protocolVersion: client.protocolVersion, latencyMs, definitionHash, descriptorHash: hash, tools: listing.tools.map((tool) => ({ name: tool.name, description: tool.description.slice(0, 200) })), warnings: listing.warnings, approval: approvalResult };
  if (ctx.options?.json === true) write(ctx.stdout, `${stringifyJson(result)}\n`);
  else {
    const lines = [`${shown.name}: ${safe(info.name)} ${safe(info.version)} (MCP ${client.protocolVersion}), ${latencyMs}ms, ${names.length} tool(s)`, ...result.tools.map((tool) => `  ${tool.name}${tool.description ? ` - ${tool.description}` : ""}`), ...listing.warnings.map((w) => `Warning: ${w}`), `descriptor hash: ${hash}`, `approval: ${approvalResult}`];
    write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  }
  return EXIT.OK;
}

/** Handler for `asterweave mcp ...`. */
export async function mcpCommand(ctx) {
  const [sub, ...rest] = ctx.positionals ?? [];
  switch (sub) {
    case "add":
      return mcpAddCommand(ctx, rest);
    case "remove":
      return mcpRemoveCommand(ctx, rest);
    case "enable":
    case "disable":
      return mcpEnableDisable(sub);
    case "list":
      noExtra(rest);
      rejectOptions(ctx, MCP_ADMIN_OPTIONS, sub);
      return listServers(ctx);
    case "validate":
      noExtra(rest);
      rejectOptions(ctx, MCP_ADMIN_OPTIONS, sub);
      return validateServers(ctx);
    case "inspect":
      noExtra(rest.slice(1));
      rejectOptions(ctx, MCP_ADMIN_OPTIONS, sub);
      return inspectServer(ctx, rest[0]);
    case "test":
      noExtra(rest.slice(1));
      rejectOptions(ctx, MCP_ADMIN_OPTIONS, sub);
      return testServer(ctx, rest[0]);
    default:
      throw new UsageError(sub ? `Unknown mcp subcommand '${safe(sub).slice(0, 40)}'.` : "Missing mcp subcommand.", { remediation: USAGE });
  }
}
