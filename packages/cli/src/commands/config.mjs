// `asterweave config show [--json] [--path dir] [--runner v] [--github-host v] [--ui-color v]`.
// Shows the effective configuration with the origin of every key. Read-only.

import path from "node:path";
import { configView, readExecutableRepoConfig, resolveConfig } from "../config.mjs";
import { EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, suggestCommand } from "../redact.mjs";
import { classifyExecutableConfig } from "../trust.mjs";
import { defaultRepoPath, seams, stringOption } from "./shared.mjs";

export const configCommandMeta = Object.freeze({ summary: "Show the effective configuration and where each value comes from", boolean: ["json", "strict"], options: ["json", "strict", "runner", "github-host", "ui-color", "path"] });

const USAGE = "Usage: asterweave config show [--json] [--strict] [--path dir] [--runner local] [--github-host host] [--ui-color auto|always|never]";
/** Flag name -> configuration key. */
const FLAG_KEYS = Object.freeze({ runner: "runner", "github-host": "github.host", "ui-color": "ui.color" });

/** Handler for `asterweave config ...`. */
export async function configCommand(ctx) {
  const [sub, ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${extra[0]}'.`, { remediation: USAGE });
  if (sub !== "show") throw new UsageError(sub ? `Unknown config subcommand '${sub}'.` : "Missing config subcommand.", { remediation: USAGE });

  const flags = {};
  for (const [flag, key] of Object.entries(FLAG_KEYS)) {
    const value = ctx.options?.[flag];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new UsageError(`--${flag} requires a value.`, { remediation: USAGE });
    flags[key] = value;
  }

  // --path layers that repository in under the same trust rules as the default one.
  const pathFlag = stringOption(ctx, "path", USAGE);
  const repoPath = pathFlag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), pathFlag);
  const resolved = resolveConfig({ ...seams(ctx), flags, repoPath });
  // --strict: executable repository config that is not trusted is an error (exit 4), decided by the real
  // trust check (readExecutableRepoConfig -> assertTrusted), not by a second implementation of it.
  if (ctx.options?.strict === true && resolved.repo && !resolved.repo.trusted && hasExecutableConfig(resolved.repo, ctx.fs)) {
    readExecutableRepoConfig(resolved.repo.path, "use the executable repository config (config show --strict)", seams(ctx));
  }
  const view = configView(resolved);
  if (ctx.options?.json === true) {
    ctx.stdout.write(`${stringifyJson({ ok: true, ...view })}\n`);
    return EXIT.OK;
  }
  ctx.stdout.write(formatConfig(view, resolved));
  return EXIT.OK;
}

/** True when the repository layer skipped an executable key or the repository has settings / MCP files. */
function hasExecutableConfig(repo, fs) {
  if (repo.skipped.length > 0) return true;
  return classifyExecutableConfig(repo.path, fs ? { fs } : undefined).length > 0;
}

function displayValue(key, value) {
  if (value === null) return "(unset)";
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(",");
  if (key === "qualityGates.required" && Array.isArray(value)) {
    return value.length === 0 ? "[]" : `[${value.length} gate(s): ${value.map((gate) => gate?.id).join(", ")}]`;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

/** Text rows `key  value  (origin)` plus the precedence line and any trust notes. */
export function formatConfig(view, resolved) {
  // Keys, values (gate ids included), origins and paths come from config files and the repository:
  // every dynamic piece is sanitised. JSON output is unaffected.
  const safe = (text) => sanitizeForTerminal(text);
  const keys = Object.keys(view.entries);
  const keyWidth = Math.max(...keys.map((key) => safe(key).length));
  const rows = keys.map((key) => [safe(key), safe(displayValue(key, view.entries[key].value)), `(${safe(view.entries[key].origin)})`]);
  const valueWidth = Math.max(...rows.map((row) => row[1].length));
  const lines = rows.map(([key, value, origin]) => `${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}  ${origin}`);
  lines.push("", `Precedence (lowest to highest): ${view.precedence.join(" < ")}`);
  if (view.repo) {
    if (view.repo.warning) lines.push(`Warning: ${safe(view.repo.warning)}`);
    lines.push(`Repository: ${safe(view.repo.path)} (${view.repo.trusted ? "trusted" : `untrusted: ${safe(view.repo.trustReason)}`}${view.repo.hasAdapter ? "" : "; no .claude/asterweave.json"})`);
    if (view.repo.skipped.length > 0) {
      lines.push(
        `Note: repository config ${safe(view.repo.file)} was only partly applied: ${view.repo.skipped.map(safe).join(", ")} skipped because the repository is not trusted.`,
        safe(suggestCommand("      Review it, then run: asterweave trust grant --path ", view.repo.path)),
      );
    }
  }
  if (resolved.unknown.length > 0) {
    lines.push(`Ignored unknown keys: ${resolved.unknown.map((item) => safe(item.key)).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}
