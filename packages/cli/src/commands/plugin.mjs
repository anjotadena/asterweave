// `asterweave plugin list|inspect|install|uninstall|enable|disable`.
//
// list / inspect only PARSE Claude Code's plugin files (see runtime/plugins.mjs): they never run `claude`, never load plugin code
// and never start a hook or server. install / uninstall / enable / disable are DELEGATED to `claude plugin ...` through the shared
// admin runner and mutation envelope (see plugin-admin.mjs); Asterweave only maps scopes (global = Claude user, repo = Claude
// project, local is never written), checks the marketplace is already known, shows what will run, asks, verifies the result and
// handles repository trust afterwards.
//
// Exit codes: 0 ok · 1 error / unexpected change · 2 usage · 4 repository not trusted after a repo-scope change · 7 refused (agent environment markers) · 130 interrupted.

import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { inspectInstalled } from "../runtime/plugin-inspect.mjs";
import { isValidPluginId, readPluginState, show } from "../runtime/plugins.mjs";
import { repositoryIdentity, safeTrustStatus } from "../trust.mjs";
import { defaultRepoPath, seams, stringOption } from "./shared.mjs";
import { ADMIN_USAGE, ADMIN_HELP, ADMIN_FLAGS, adminCommand } from "./plugin-admin.mjs";

const SUBCOMMAND_FLAGS = { list: ["json", "scope", "path"], inspect: ["json", "path"], ...ADMIN_FLAGS };

export const pluginCommandMeta = Object.freeze({
  summary: "List, inspect and (scoped, delegated) install Claude Code plugins",
  boolean: ["json", "yes", "trust", "keep-data"],
  options: ["json", "scope", "path", "config", "yes", "trust", "keep-data"],
});

const USAGE = `Usage: asterweave plugin list [--scope global|repo|all] [--json] | inspect <id> [--json] | ${ADMIN_USAGE}`;

export const pluginHelpText = `${[
  "asterweave plugin - Claude Code plugins (list and inspect parse files only; changes are delegated to `claude plugin`)",
  "",
  USAGE,
  "",
  "  list       installs and enabledPlugins per scope: global (Claude user), repo (Claude project), and local (shown, not managed by asterweave); never executes anything",
  "  inspect    manifest summary from the installed cache directory: component counts by directory name, hook commands (they RUN CODE), MCP servers with warnings",
  ...ADMIN_HELP,
  "",
  "Scopes: global = Claude `user`, repo = Claude `project` (.claude/settings.json). Claude `local` scope is never written. Precedence between scopes is not verified:",
  "they are listed separately and never merged. A repository change makes the repository untrusted until `asterweave trust grant` (or --trust on an exactly verified change).",
  "JSON (stable):",
  "  list       { ok, plugins: [{ id, name, marketplace, scope, claudeScope, installed, version, enabled, file, managed, note, trust, conflict }], marketplaces: [name], issues, precedence }",
  "  inspect    { ok, plugin: { id, scopes: [{ scope, installed, enabled, version, file, note }], inspection: { complete, manifest, components, hooks, mcpServers, issues, reason } } }",
  "  install | uninstall | enable | disable   { ok, action, id, scope, claudeScope, command, verified, trust, ... }",
  "Exit codes: 0 ok · 1 error or unexpected change · 2 usage · 4 repository untrusted after a repo-scope change · 7 refused (agent environment markers) · 130 interrupted",
].join("\n")}\n`;

const write = (stream, text) => stream.write(text);
const safe = (text, limit = 80) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);

/** Enforce the per-subcommand option list and the positional count (exit 2). */
export function checkArgs(ctx, sub, positionals, max) {
  const allowed = new Set(SUBCOMMAND_FLAGS[sub]);
  for (const key of Object.keys(ctx.options ?? {})) {
    if (!allowed.has(key)) throw new UsageError(`Option --${safe(key, 40)} does not apply to 'plugin ${sub}'.`, { remediation: USAGE });
  }
  if (positionals.length > max) throw new UsageError(`Unexpected argument '${safe(positionals[max], 40)}'.`, { remediation: USAGE });
}

/** The repository the command acts on (--path, else the connected clone or the current directory). */
export function repoContext(ctx) {
  const pathFlag = stringOption(ctx, "path", USAGE);
  const repoPath = pathFlag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), pathFlag);
  const options = seams(ctx);
  return { identity: repositoryIdentity(repoPath, options), options };
}

export function readState(ctx, repo) {
  const trusted = repo ? safeTrustStatus(repo.identity.realpath, repo.options).trusted : null;
  return readPluginState({ homedir: ctx.homedir, repoRoot: repo?.identity.realpath, fs: ctx.fs, platform: ctx.platform, repoTrusted: trusted });
}

function viewRow(row) {
  const { installPath: _installPath, ...rest } = row;
  return { ...rest, id: show(row.id, 140), name: show(row.name, 70), marketplace: row.marketplace === null ? null : show(row.marketplace, 70) };
}

function listCommand(ctx) {
  checkArgs(ctx, "list", ctx.positionals.slice(1), 0);
  const scope = stringOption(ctx, "scope", USAGE) ?? "all";
  if (!["global", "repo", "all"].includes(scope)) throw new UsageError("--scope must be global, repo or all.", { remediation: USAGE });
  const state = readState(ctx, scope === "global" ? null : repoContext(ctx));
  const rows = state.rows.filter((row) => scope === "all" || row.scope === scope).map(viewRow);
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, plugins: rows, marketplaces: state.marketplaces, issues: state.issues, precedence: state.precedence })}\n`);
    return EXIT.OK;
  }
  const lines = rows.length === 0 ? ["No plugins are installed or declared in the selected scope(s)."] : rows.map((row) => [
    `${row.id}  [${row.scope}] ${row.file}${row.managed ? "" : "  (local, not managed by asterweave)"}`,
    `    installed: ${row.installed ? `yes${row.version ? ` (${row.version})` : ""}` : "no (declared only)"}  enabled: ${row.enabled === null ? "not declared" : row.enabled}${row.trust ? `  trust: ${row.trust}` : ""}`,
    ...(row.conflict ? [`    CONFLICT: ${row.conflict}`] : []),
  ].join("\n"));
  for (const issue of state.issues) lines.push(`Warning: ${issue.file} is ${issue.state}`);
  lines.push("", `Precedence: ${state.precedence}.`);
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

function inspectCommand(ctx) {
  const rest = ctx.positionals.slice(1);
  checkArgs(ctx, "inspect", rest, 1);
  const wanted = rest[0];
  if (wanted === undefined) throw new UsageError("Missing plugin id.", { remediation: USAGE });
  if (!isValidPluginId(wanted)) throw new UsageError(`'${safe(wanted)}' is not a valid plugin id (name or name@marketplace: letters, digits, . _ -).`, { remediation: USAGE });
  const state = readState(ctx, repoContext(ctx));
  const matches = state.rows.filter((row) => (wanted.includes("@") ? row.id === wanted : row.name === wanted));
  if (matches.length === 0) throw new CliError(`No plugin '${safe(wanted)}' is installed or declared.`, { code: "PLUGIN_NOT_FOUND", remediation: "Run `asterweave plugin list` to see what is known." });
  const ids = [...new Set(matches.map((row) => row.id))];
  if (ids.length > 1) throw new UsageError(`'${safe(wanted)}' matches ${ids.length} plugins (${ids.slice(0, 5).map((id) => safe(id)).join(", ")}).`, { remediation: "Use the full name@marketplace id." });
  const withPath = matches.find((row) => row.installPath !== null);
  const inspection = withPath
    ? inspectInstalled(withPath.installPath, { pluginsDir: state.paths.pluginsDir, fs: ctx.fs, platform: ctx.platform, env: ctx.env, exists: ctx.exists })
    : { dir: null, reason: "no install record with a path (declared only, or the installed_plugins.json shape was not recognised)", manifest: null, components: {}, hooks: [], mcpServers: [], issues: [] };
  const { dir: _dir, ...shownInspection } = inspection;
  const view = { id: show(ids[0], 140), scopes: matches.map((row) => ({ scope: row.scope, installed: row.installed, enabled: row.enabled, version: row.version, file: row.file, note: row.note })), inspection: shownInspection };
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, plugin: view })}\n`);
    return EXIT.OK;
  }
  const lines = [
    `${view.id}`,
    ...view.scopes.map((s) => `  [${s.scope}] installed: ${s.installed ? `yes${s.version ? ` (${s.version})` : ""}` : "no"}  enabled: ${s.enabled === null ? "not declared" : s.enabled}  (${s.note})`),
  ];
  if (inspection.reason) lines.push(`Not inspected: ${inspection.reason}.`, "COULD NOT BE FULLY INSPECTED: treat this plugin as code.");
  else {
    const m = inspection.manifest;
    lines.push(m ? `manifest: ${m.name ?? "(no name)"} ${m.version ?? ""} - ${m.description ?? "(no description)"}`.trimEnd() : "manifest: none found");
    lines.push(`components (by directory name): ${["skills", "agents", "commands", "hooks", "mcp"].map((k) => `${k} ${inspection.components[k]?.count ?? 0}`).join(", ")}`);
    if (inspection.hooks.length > 0) lines.push("HOOKS RUN CODE when the plugin is enabled:", ...inspection.hooks.map((h) => `  [${h.event}] ${h.command}`));
    if (inspection.mcpServers.length > 0) {
      lines.push("MCP servers (started by Claude Code when enabled; asterweave did not start them):");
      for (const s of inspection.mcpServers) lines.push(`  ${s.name}  ${s.transport}  ${s.command ? `${s.command} ${s.args.join(" ")}`.trim() : s.url ?? "(no command)"}`, ...s.warnings.map((w) => `    ${w.level === "error" ? "Problem" : "Warning"}: ${w.message}`));
    }
    for (const issue of inspection.issues) lines.push(`Warning: ${issue}`);
    if (!inspection.complete) lines.push("COULD NOT BE FULLY INSPECTED: what is shown above may be incomplete; treat this plugin as code.");
  }
  lines.push("Nothing was executed.");
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

/** Handler for `asterweave plugin ...`. */
export async function pluginCommand(ctx) {
  ctx = { ...ctx, positionals: ctx.positionals ?? [] };
  const sub = ctx.positionals[0];
  switch (sub) {
    case "list":
      return listCommand(ctx);
    case "inspect":
      return inspectCommand(ctx);
    case "install":
    case "uninstall":
    case "enable":
    case "disable":
      return adminCommand(ctx, sub, { usage: USAGE, checkArgs, repoContext, readState });
    default:
      throw new UsageError(sub ? `Unknown plugin subcommand '${safe(sub, 40)}'.` : "Missing plugin subcommand.", { remediation: USAGE });
  }
}
