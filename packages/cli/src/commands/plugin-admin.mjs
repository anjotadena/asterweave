// `asterweave plugin install|uninstall|enable|disable`: scoped delegation to `claude plugin ...` through the shared mutation
// envelope (src/runtime/claude/mutate.mjs + admin.mjs, loaded lazily). This module owns only the plugin-specific rules:
//   - strict ids; the marketplace must ALREADY be known (known_marketplaces.json): Asterweave never adds a marketplace;
//   - scope mapping through the admin module's single toClaudeScope (global -> user, repo -> project; local never);
//   - --config values validated (no secrets in argv);
//   - a loud warning that plugins can run hooks and MCP servers;
//   - a plugin-specific `snapshot` + `verify` pair the envelope calls BEFORE and AFTER the change: the result must be exactly the
//     one intended plugin change (no other settings key, no other scope, no marketplace change), else the envelope reports
//     UNEXPECTED_CHANGE and never re-grants repository trust.
//
// Contract assumed from the envelope (documented, injectable as ctx.mutation in tests):
//   mutation.toClaudeScope(scope: 'global'|'repo', kind: 'plugin') -> 'user'|'project'        (admin.mjs, exists)
//   mutation.buildPluginArgs({ action, scope, id, config, keepData }) -> string[] after the binary      (admin.mjs, exists)
//   mutation.applyMutation({ ctx, kind: 'plugin', action, scope, id, repoRoot, args, warnings, summary, files, snapshot, verify, yes, trust, json })
//     -> { ok, exitCode?, command, verified, trust: { state, remediation? }, ... }   (throws CliError for refusals: 7 agent markers, 2 needs --yes, 1 UNEXPECTED_CHANGE)

import { createHash } from "node:crypto";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { isSecretKeyName, redactText, sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { assertHumanContext } from "../runtime/approvals.mjs";
import { inspectInstalled } from "../runtime/plugin-inspect.mjs";
import { QUALIFIED_PLUGIN_ID, enabledMap, isValidPluginId, plain, readJsonFile, readPluginState, show } from "../runtime/plugins.mjs";
import { stringOption } from "./shared.mjs";
import { repeatedOption } from "./images.mjs";

export const ADMIN_USAGE = "install <name@marketplace> --scope global|repo [--config k=v]... [--yes] [--trust] [--json] | uninstall <id> --scope global|repo [--keep-data] [--yes] [--trust] [--json] | enable|disable <id> --scope global|repo [--yes] [--trust] [--json]";

export const ADMIN_FLAGS = Object.freeze({
  install: ["json", "scope", "path", "config", "yes", "trust"],
  uninstall: ["json", "scope", "path", "keep-data", "yes", "trust"],
  enable: ["json", "scope", "path", "yes", "trust"],
  disable: ["json", "scope", "path", "yes", "trust"],
});

export const ADMIN_HELP = [
  "  install    claude plugin install -s user|project [--config k=v] <name@marketplace>; the marketplace must already be known to Claude Code; plugins can RUN CODE (hooks, MCP servers)",
  "  uninstall  claude plugin uninstall -s user|project [--keep-data] <id>",
  "  enable | disable   claude plugin enable|disable -s user|project <id>",
  "             All four show the exact command and the files that may change, then need a y/N at a terminal (or --yes without one). --scope is required:",
  "             global = Claude user scope, repo = Claude project scope (.claude/settings.json, so the repository becomes untrusted until re-granted; --trust re-grants",
  "             only after the change was verified as exactly the intended plugin entry). --config values must not be secrets (use a ${NAME} reference or Claude's own prompt).",
];

const WARNING_CODE = "Plugins can run code: hooks and MCP servers start with your permissions as soon as the plugin is enabled. Asterweave has NOT reviewed this plugin; read its source in the marketplace first.";
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const CONFIG_REF = /^\$\{[A-Za-z_][A-Za-z0-9_]{0,63}\}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_CONFIGS = 20;

const safe = (text, limit = 80) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const write = (stream, text) => stream.write(text);

/**
 * Validate repeated `--config key=value`. Decision (UNVERIFIED semantics of claude's --config): no secret ever travels in argv. A key that
 * looks like a secret name accepts ONLY a whole `${NAME}` reference, and any `key=value` the redactor flags is refused unless the value is such a
 * reference (the admin runner accepts those too). Other values must be plain (no control characters, at most 500 characters). A reference is
 * passed verbatim and never expanded by Asterweave.
 * @returns {string[]} `key=value` strings
 */
export function parseConfigValues(values, usage) {
  if (values.length > MAX_CONFIGS) throw new UsageError(`At most ${MAX_CONFIGS} --config values are accepted.`, { remediation: usage });
  const seen = new Set();
  return values.map((raw) => {
    if (typeof raw !== "string" || !raw.includes("=")) throw new UsageError("--config needs key=value.", { remediation: usage });
    const split = raw.indexOf("=");
    const key = raw.slice(0, split);
    const value = raw.slice(split + 1);
    if (!CONFIG_KEY.test(key)) throw new UsageError(`--config key '${safe(key, 40)}' is not valid (letters, digits, _ . -; must start with a letter or _).`, { remediation: usage });
    if (seen.has(key)) throw new UsageError(`--config key '${safe(key, 40)}' is given twice.`, { remediation: usage });
    seen.add(key);
    if (value === "" || value.length > 500 || CONTROL.test(value)) throw new UsageError(`--config ${safe(key, 40)} needs a plain value of 1 to 500 characters without control characters.`, { remediation: usage });
    const isRef = CONFIG_REF.test(value);
    if (value.includes("${") && !isRef) throw new UsageError(`--config ${safe(key, 40)} mixes text with a \${NAME} reference; a reference must be the whole value.`, { remediation: usage });
    // A whole ${NAME} reference is always fine (the admin runner accepts it); anything else for a secret-looking key, or that the redactor flags, is refused here with a clear message.
    if (!isRef && (isSecretKeyName(key) || redactText(`${key}=${value}`).count > 0)) {
      throw new UsageError(`--config ${safe(key, 40)} looks like a secret; secrets are never put in the command line (the value was not echoed).`, { remediation: "Let Claude Code prompt for it or set it in the plugin's own environment; Only a whole ${NAME} reference is accepted for a secret-looking key." });
    }
    return `${key}=${value}`;
  });
}

// --- plugin-specific snapshot and verification ---------------------------------------------------

const sortKeys = (value) => (Array.isArray(value) ? value.map(sortKeys) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])])) : value);
const canonical = (value) => stringifyJson(sortKeys(value));
const sha = (read) => (read.bytes ? createHash("sha256").update(read.bytes).digest("hex") : read.state);

/** Canonical text of a settings file without `enabledPlugins[id]`; on any doubt (invalid, odd shape, absurd nesting) the digest of the bytes. */
export function restOfSettings(read, id) {
  if (read.state === "missing") return canonical({}); // a file that does not exist yet is the same as an empty object
  if (!read.bytes) return `state:${read.state}`;
  try {
    const text = read.bytes.toString("utf8");
    const parsed = text.trim() === "" ? {} : JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); // own "__proto__" keys survive JSON.parse
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return `bytes:${sha(read)}`;
    const raw = { ...parsed };
    if (raw.enabledPlugins && typeof raw.enabledPlugins === "object" && !Array.isArray(raw.enabledPlugins)) {
      raw.enabledPlugins = { ...raw.enabledPlugins };
      delete raw.enabledPlugins[id];
      if (Object.keys(raw.enabledPlugins).length === 0) delete raw.enabledPlugins; // an empty map is the same as none
    }
    return canonical(raw);
  } catch {
    return `bytes:${sha(read)}`;
  }
}

/** A read-like record ({state, data, bytes}) of a governing file from the TEXT the envelope already hashed (null = missing). */
function readOfText(text) {
  if (text === null || text === undefined) return { state: "missing", data: null, bytes: null };
  if (text.startsWith("\u0000")) return { state: "unreadable", data: null, bytes: null };
  const bytes = Buffer.from(text, "utf8");
  try {
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    return { state: "ok", data: body.trim() === "" ? null : plain(JSON.parse(body)), bytes };
  } catch {
    return { state: "invalid", data: null, bytes };
  }
}
const textDigest = (text) => (text === null || text === undefined ? "missing" : text.startsWith("\u0000") ? "unreadable" : createHash("sha256").update(text).digest("hex"));

/**
 * What an install/uninstall/enable/disable of `id` in `scope` may change, captured from the parse-only readers. `governing` (repo scope, given by
 * the mutation envelope) holds the TEXT of the trust-governing files that was hashed: those are judged from it and never re-read, so a
 * write-then-revert between the hash and this capture cannot hide.
 */
export function capturePluginState({ homedir, repoRoot, fs, platform, scope, id, governing }) {
  const state = readPluginState({ homedir, repoRoot: scope === "repo" ? repoRoot : undefined, fs, platform });
  const fromGoverning = scope === "repo" && governing !== undefined && governing !== null;
  const settingsRead = fromGoverning ? readOfText(governing[".claude/settings.json"]) : readJsonFile(scope === "global" ? state.paths.userSettings : state.paths.projectSettings, { fs });
  const map = enabledMap(fromGoverning ? settingsRead.data : state.settingsData[scope]);
  // "Everything but this plugin's own entry" is judged on the RAW parse of the file bytes, not on the reader's sanitized copy (which drops
  // __proto__ / constructor / prototype keys): the trust hash covers the raw bytes, so a change under such a key must be seen here too.
  const rest = restOfSettings(settingsRead, id);
  const digests = { marketplaces: state.digests.marketplaces };
  if (scope === "repo") {
    digests.userSettings = state.digests.userSettings;
    digests.localSettings = fromGoverning ? textDigest(governing[".claude/settings.local.json"]) : state.digests.localSettings;
    digests.projectMcp = fromGoverning ? textDigest(governing[".mcp.json"]) : sha(readJsonFile(state.paths.projectMcp, { fs }));
    digests.asterweave = fromGoverning ? textDigest(governing[".claude/asterweave.json"]) : sha(readJsonFile(path.join(repoRoot, ".claude", "asterweave.json"), { fs }));
  }
  // files this change may legitimately touch, as digests, only to LABEL what changed (never compared by verify)
  const touched = { "~/.claude/plugins/installed_plugins.json": state.digests.installed };
  if (scope === "global") touched["~/.claude/settings.json"] = state.digests.userSettings;
  else touched[".claude/settings.json"] = state.digests.projectSettings;
  return {
    touched,
    installed: state.rows.filter((row) => row.scope === scope && row.installed).map((row) => row.id).sort(),
    enabled: Object.hasOwn(map, id) ? map[id] : undefined,
    rest,
    others: canonical(state.rows.filter((row) => row.scope !== scope).map(({ id: rowId, scope: rowScope, installed, enabled }) => [rowId, rowScope, installed, enabled])),
    digests,
  };
}

/** Labels of the plugin files whose bytes differ between two snapshots (for the changed-files report). */
export function pluginChangedLabels(before, after) {
  return Object.keys(after.touched ?? {}).filter((label) => before.touched?.[label] !== after.touched[label]);
}

/** @returns {{ok: boolean, problems: string[]}} ok only for exactly the intended plugin change. UNVERIFIED expectations are noted in the docs. */
export function verifyPluginChange(before, after, { action, id }) {
  const problems = [];
  if (before.rest !== after.rest) problems.push("settings outside this plugin's own entry changed");
  if (before.others !== after.others) problems.push("plugins in another scope changed");
  for (const key of Object.keys(after.digests)) if (before.digests[key] !== after.digests[key]) problems.push(key === "marketplaces" ? "known_marketplaces.json changed (a marketplace must never be added through asterweave)" : `${key} changed`);
  const added = after.installed.filter((item) => !before.installed.includes(item));
  const removed = before.installed.filter((item) => !after.installed.includes(item));
  if (added.some((item) => item !== id) || removed.some((item) => item !== id)) problems.push("other plugins were installed or removed");
  const installedNow = after.installed.includes(id);
  if (action === "install" && !installedNow && after.enabled !== true) problems.push("the plugin is not installed after the change");
  if (action === "install" && removed.length > 0) problems.push("an install removed a plugin");
  if (action === "uninstall" && installedNow) problems.push("the plugin is still installed after the change");
  if (action === "uninstall" && added.length > 0) problems.push("an uninstall added a plugin");
  if (action === "enable" && (after.enabled !== true || added.length + removed.length > 0)) problems.push("the plugin is not enabled after the change, or installs changed");
  if (action === "disable" && (after.enabled !== false || added.length + removed.length > 0)) problems.push("the plugin is not disabled after the change, or installs changed");
  return { ok: problems.length === 0, problems };
}

// --- the lazily loaded envelope ----------------------------------------------------------------

/** Load Track A's modules; fail closed with a clear error when this build does not have them. */
export async function loadMutation() {
  try {
    const mutate = await import("../runtime/claude/mutate.mjs");
    const admin = await import("../runtime/claude/admin.mjs");
    if (typeof mutate.applyMutation !== "function" || typeof admin.toClaudeScope !== "function" || typeof admin.buildPluginArgs !== "function") throw new Error("missing export");
    return { toClaudeScope: admin.toClaudeScope, buildPluginArgs: admin.buildPluginArgs, applyMutation: mutate.applyMutation, previewMutation: mutate.previewMutation, runClaudeAdmin: admin.runClaudeAdmin };
  } catch (error) {
    if (error?.code !== "ERR_MODULE_NOT_FOUND" && error?.message !== "missing export") throw error;
    throw new CliError("Changing plugins needs the Claude admin runner, which is not available in this build.", { code: "PLUGIN_ADMIN_UNAVAILABLE", remediation: "Use `claude plugin ...` yourself, then `asterweave plugin list` to review the result." });
  }
}

// --- the command --------------------------------------------------------------------------------

export async function adminCommand(ctx, action, kit) {
  const { usage, checkArgs, repoContext, readState } = kit;
  assertHumanContext(ctx.env, "Plugin changes");
  const rest = ctx.positionals.slice(1);
  checkArgs(ctx, action, rest, 1);
  const id = rest[0];
  if (id === undefined) throw new UsageError("Missing plugin id.", { remediation: usage });
  if (!isValidPluginId(id) || (action === "install" && !QUALIFIED_PLUGIN_ID.test(id))) {
    throw new UsageError(action === "install" ? `'${safe(id)}' is not a valid plugin id: use name@marketplace (letters, digits, . _ -).` : `'${safe(id)}' is not a valid plugin id (name or name@marketplace: letters, digits, . _ -).`, { remediation: usage });
  }
  const scope = stringOption(ctx, "scope", usage);
  if (scope === undefined) throw new UsageError("--scope global|repo is required.", { remediation: usage });
  if (scope === "local") throw new UsageError("The local scope is not managed by asterweave.", { remediation: "Use --scope global (Claude user) or --scope repo (Claude project)." });
  if (scope !== "global" && scope !== "repo") throw new UsageError("--scope must be global or repo.", { remediation: usage });
  if (scope === "global" && ctx.options?.trust === true) throw new UsageError("--trust applies to --scope repo only (a global change does not touch repository trust).", { remediation: usage });
  if (scope === "global" && ctx.options?.path !== undefined) throw new UsageError("--path applies to --scope repo only (a global change does not use a repository).", { remediation: usage });
  const configs = action === "install" ? parseConfigValues(repeatedOption(ctx, "config"), usage) : [];

  const repo = scope === "repo" ? repoContext(ctx) : null;
  const state = readState(ctx, repo);
  if (action === "install") {
    const marketplace = id.split("@")[1];
    if (!state.marketplacesReadable) throw new CliError("known_marketplaces.json cannot be read, so the marketplace cannot be checked.", { code: "PLUGIN_MARKETPLACE_UNVERIFIABLE", remediation: "Fix or remove the file with Claude Code, then retry. Nothing was changed." });
    if (!state.marketplaces.includes(marketplace)) {
      throw new UsageError(`The marketplace '${safe(marketplace, 64)}' is not known to Claude Code. Asterweave never adds a marketplace.`, { code: "PLUGIN_MARKETPLACE_UNKNOWN", remediation: "Add it yourself in Claude Code (claude plugin marketplace add ...), review it, then retry. Nothing was changed." });
    }
  } else {
    const known = state.rows.some((row) => row.scope === scope && (wantedMatch(row, id))) || !state.installedShapeRecognized;
    if (!known) throw new CliError(`'${safe(id)}' is not installed or declared in the ${scope} scope.`, { code: "PLUGIN_NOT_FOUND", remediation: "Run `asterweave plugin list --scope " + scope + "` to see what is there. Nothing was changed." });
  }

  const mutation = ctx.mutation ?? await loadMutation();
  const claudeScope = mutation.toClaudeScope(scope, "plugin");
  const args = mutation.buildPluginArgs({ action, scope, id, config: configs, keepData: action === "uninstall" && ctx.options?.["keep-data"] === true });
  // A global change passes the ambient repository (when the current directory is one) so the envelope can prove it did not move the repository's trust hash.
  let repoRoot = repo?.identity.realpath;
  if (scope === "global") { try { repoRoot = repoContext(ctx).identity.realpath; } catch { repoRoot = undefined; } }
  const capture = (governing) => capturePluginState({ homedir: ctx.homedir, repoRoot, fs: ctx.fs, platform: ctx.platform, scope, id, governing });
  const warnings = action === "install" || action === "enable" ? [WARNING_CODE, ...inspectionWarnings(ctx, state, id, action)] : [];
  const summary = [
    `Plugin ${action}: ${safe(id)}  scope: ${scope} (Claude ${claudeScope})`,
    scope === "repo" ? "May change .claude/settings.json in the repository, which makes it untrusted until re-granted." : "May change your user-level Claude plugin files (not the repository).",
  ];
  const labels = new Set();
  // Ctrl-C: the envelope installs the shared interrupt handler itself (kill tree, INTERRUPTED, exit 130)
  const result = await mutation.applyMutation({
    ctx, kind: "plugin", action, scope, id, repoRoot, args, warnings, summary,
    files: scope === "repo" ? [".claude/settings.json"] : ["~/.claude/settings.json", "~/.claude/plugins/installed_plugins.json"],
    snapshot: capture,
    changedLabels: pluginChangedLabels,
    verify: (before, after) => { for (const label of pluginChangedLabels(before, after)) labels.add(label); return verifyPluginChange(before, after, { action, id }); },
    yes: ctx.options?.yes === true, trust: ctx.options?.trust === true, json: ctx.options?.json === true,
  });
  const changedFiles = [...new Set([...(Array.isArray(result?.changedFiles) ? result.changedFiles : []), ...labels])];
  return render(ctx, { action, id, scope, claudeScope, warnings, result, changedFiles });
}

/** What to add to the code-execution warning from a parse-only inspection of the cached plugin (never an all-clear when it was incomplete). */
export function inspectionWarnings(ctx, state, id, action) {
  const row = state.rows.find((r) => r.installPath !== null && (id.includes("@") ? r.id === id : r.name === id));
  if (!row) {
    return [action === "install"
      ? "A plugin cannot be inspected before it is installed. After installing, run `asterweave plugin inspect " + id + "`; anything it reports as not inspected must be treated as code."
      : "This plugin has no readable install record, so it could NOT be inspected: treat it as code."];
  }
  const inspection = inspectInstalled(row.installPath, { pluginsDir: state.paths.pluginsDir, fs: ctx.fs, platform: ctx.platform, env: ctx.env, exists: ctx.exists });
  const out = [];
  if (inspection.reason) out.push("The installed plugin could NOT be inspected (" + inspection.reason + "): treat it as code.");
  else {
    if (inspection.hooks.length > 0) out.push("It declares " + inspection.hooks.length + " hook command(s) that RUN CODE when enabled.");
    if (!inspection.complete) out.push("The inspection was INCOMPLETE and is not an all-clear: " + inspection.issues.slice(0, 3).join("; ") + (inspection.issues.length > 3 ? "; ..." : "") + ". Treat the plugin as code.");
  }
  return out;
}

const wantedMatch = (row, id) => (id.includes("@") ? row.id === id : row.name === id);

function render(ctx, { action, id, scope, claudeScope, warnings, result, changedFiles }) {
  const command = Array.isArray(result?.command) ? result.command.map((part) => show(part, 200)) : typeof result?.command === "string" ? [show(result.command, 500)] : [];
  const trust = result?.trust && typeof result.trust === "object" ? { state: show(result.trust.state, 40), remediation: result.trust.remediation ? show(result.trust.remediation, 300) : null } : { state: scope === "repo" ? "unknown" : "not applicable", remediation: null };
  const ok = result?.ok !== false;
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok, action, id: show(id, 140), scope, claudeScope, command, verified: result?.verified === true, changedFiles: changedFiles.map((file) => show(file, 120)), trust, warnings })}\n`);
  } else {
    const lines = [
      `${ok ? "Done" : "Failed"}: plugin ${action} ${safe(id, 140)} (${scope} scope, Claude ${claudeScope}).`,
      ...(command.length > 0 ? [`command: ${command.join(" ")}`] : []),
      `verified: ${result?.verified === true ? "yes, exactly the intended change" : "no"}`,
      `changed: ${changedFiles.length === 0 ? "nothing" : changedFiles.map((file) => show(file, 120)).join(", ")}`,
      `repository trust: ${trust.state}`,
      ...(trust.remediation ? [trust.remediation] : []),
    ];
    write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  }
  return Number.isInteger(result?.exitCode) ? result.exitCode : EXIT.OK;
}
