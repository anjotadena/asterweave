// `asterweave skill list|show|route`.
//
// Read-only. list / show read SKILL.md files from the user, the (trusted) repository and the bundled plugin, and say which
// definition WINS and from which source. route maps a request to a skill, an authorization scope and a workflow with a
// deterministic rule set (no model call). Nothing is executed and nothing is installed: installing a downloaded skill goes
// through `asterweave plugin install`, which owns trust and approval.
//
// Exit codes: 0 ok · 1 error (unknown skill, no route) · 2 usage.

import { readFileSync } from "node:fs";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { loadCatalog, resolveSkill, routeIntent, splitSkill } from "../runtime/skills.mjs";
import { repositoryIdentity, safeTrustStatus } from "../trust.mjs";
import { defaultRepoPath, seams, stringOption } from "./shared.mjs";

export const skillCommandMeta = Object.freeze({
  summary: "List, show and route Asterweave skills (bug-fix, contribute, repo-audit, ...)",
  boolean: ["json", "body", "failing-test"],
  options: ["json", "body", "path", "failing-test"],
});

const USAGE = "Usage: asterweave skill list [--json] | show <id|alias|asterweave:id> [--body] [--json] | route <request...> [--failing-test] [--json]";
const FLAGS = { list: ["json", "path"], show: ["json", "body", "path"], route: ["json", "path", "failing-test"] };

export const skillHelpText = `${[
  "asterweave skill - discover, inspect and route skills (read-only; nothing is executed or installed)",
  "",
  USAGE,
  "",
  "  list    every skill with the winning source (user > repo > bundled) and what it shadows; a repository's skills count only when it is trusted",
  "  show    one definition: metadata version, source file, inputs, outputs, follow-ups; --body adds the instructions",
  "  route   which skill, scope (discovery|implement) and workflow a request selects, with the rule and signals that decided it",
  "",
  "Examples:",
  "  asterweave skill show bug-fix",
  "  asterweave skill route Fix issue 42",
  "  asterweave skill route Audit this repository and find something I can contribute",
  "  asterweave run start \"Search resets when I open a project and go back\" --workflow auto",
  "JSON (stable):  list { ok, skills, aliases, shadowed, invalid, sources }  show { ok, via, skill, shadows }  route { ok, route }",
  "Exit codes: 0 ok · 1 unknown skill or no route · 2 usage",
].join("\n")}\n`;

const safe = (text, limit = 80) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const write = (stream, text) => stream.write(text);

function check(ctx, sub, positionals, min, max) {
  for (const key of Object.keys(ctx.options ?? {})) {
    if (!FLAGS[sub].includes(key)) throw new UsageError(`Option --${safe(key, 40)} does not apply to 'skill ${sub}'.`, { remediation: USAGE });
  }
  if (positionals.length < min) throw new UsageError(`'skill ${sub}' needs ${sub === "route" ? "a request" : "a skill id"}.`, { remediation: USAGE });
  if (positionals.length > max) throw new UsageError(`Unexpected argument '${safe(positionals[max], 40)}'.`, { remediation: USAGE });
}

/** Load the catalog for the repository around --path or the cwd; outside a repository only user and bundled skills exist. */
export function catalogFor(ctx) {
  let repoRoot = null;
  let repoTrusted = null;
  try {
    const flag = stringOption(ctx, "path", USAGE);
    const repoPath = flag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), flag);
    const options = seams(ctx);
    repoRoot = repositoryIdentity(repoPath, options).realpath;
    repoTrusted = safeTrustStatus(repoRoot, options).trusted;
  } catch (error) {
    if (error instanceof UsageError) throw error;
    repoRoot = null; // not a repository: only the user and bundled sources apply
  }
  return { catalog: loadCatalog({ repoRoot, repoTrusted, homedir: ctx.homedir, fs: ctx.fs }), repoRoot, repoTrusted };
}

const brief = (skill) => ({ id: skill.id, source: skill.source, metadata: skill.metadata, legacy: skill.legacy, description: skill.description, aliases: skill.aliases, followUps: skill.followUps, file: skill.file });

function listCommand(ctx) {
  check(ctx, "list", ctx.positionals.slice(1), 0, 0);
  const { catalog } = catalogFor(ctx);
  const skills = [...catalog.skills.values()].sort((a, b) => a.id.localeCompare(b.id)).map(brief);
  const aliases = Object.fromEntries(catalog.aliases);
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, skills, aliases, shadowed: catalog.shadowed, invalid: catalog.invalid, sources: catalog.sources })}\n`);
    return EXIT.OK;
  }
  const lines = skills.map((s) => `${s.id.padEnd(18)} [${s.source}] ${s.legacy ? "legacy " : `v${s.metadata}  `}${safe(s.description, 90)}${s.aliases.length ? `  (aliases: ${s.aliases.join(", ")})` : ""}`);
  lines.push("", "Sources", ...catalog.sources.map((s) => `  ${s.name.padEnd(8)} ${s.state}${s.reason ? ` - ${s.reason}` : ""}  ${s.dir ?? ""}`));
  for (const item of catalog.shadowed) lines.push(`Shadowed: ${item.id} from ${item.source} (${item.reason})`);
  for (const item of catalog.invalid) lines.push(`Invalid:  ${item.id} from ${item.source}: ${item.problems.join("; ")}`);
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

function showCommand(ctx) {
  const rest = ctx.positionals.slice(1);
  check(ctx, "show", rest, 1, 1);
  const { catalog } = catalogFor(ctx);
  const hit = resolveSkill(catalog, rest[0], { fs: ctx.fs });
  if (!hit) throw new CliError(`No skill '${safe(rest[0], 60)}'.`, { code: "SKILL_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Run `asterweave skill list` to see the available skills." });
  const { skill, via } = hit;
  const shadows = catalog.shadowed.filter((item) => item.id === skill.id);
  let body;
  if (ctx.options?.body === true) body = splitSkill(readFileSync(skill.file, "utf8"))?.body ?? "";
  const { problems: _problems, ...full } = skill;
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: true, via, skill: full, shadows, ...(body === undefined ? {} : { body }) })}\n`);
    return EXIT.OK;
  }
  const lines = [
    `${skill.id}  [${skill.source}] ${skill.legacy ? "legacy definition (no versioned metadata)" : `asterweave-skill v${skill.metadata}`}${via === "alias" ? `  (resolved from alias ${safe(rest[0], 40)})` : ""}`,
    `file      ${skill.file}`,
    `about     ${skill.description}`,
    ...(skill.argumentHint ? [`argument  ${skill.argumentHint}`] : []),
    ...(skill.aliases.length ? [`aliases   ${skill.aliases.join(", ")}`] : []),
    ...(skill.triggers.length ? [`triggers  ${skill.triggers.join("; ")}`] : []),
    ...(skill.inputs ? [`inputs    ${skill.inputs}`] : []),
    ...(skill.prerequisites ? [`needs     ${skill.prerequisites}`] : []),
    ...(skill.outputs ? [`outputs   ${skill.outputs}`] : []),
    ...(skill.capabilities.length ? [`tools     ${skill.capabilities.join(", ")}`] : []),
    ...(skill.verification ? [`verifies  ${skill.verification}`] : []),
    ...(skill.stopWhen ? [`stops     ${skill.stopWhen}`] : []),
    ...(skill.followUps.length ? [`then      ${skill.followUps.join(", ")}`] : []),
    ...shadows.map((item) => `shadows   ${item.source}: ${item.file} (${item.reason})`),
  ];
  if (body !== undefined) lines.push("", body.trimEnd());
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

function routeCommand(ctx) {
  const rest = ctx.positionals.slice(1);
  check(ctx, "route", rest, 1, 200);
  const { catalog } = catalogFor(ctx);
  const route = routeIntent(rest.join(" "), { failingTest: ctx.options?.["failing-test"] === true });
  const hit = route.skill === null ? null : resolveSkill(catalog, route.skill, { fs: ctx.fs });
  if (route.skill !== null && !hit) throw new CliError(`The request routes to '${route.skill}', which is not available in this catalog.`, { code: "SKILL_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Run `asterweave skill list`." });
  const view = { ...route, source: hit?.skill.source ?? null, file: hit?.skill.file ?? null };
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: route.skill !== null, route: view })}\n`);
    return route.skill === null ? EXIT.ERROR : EXIT.OK;
  }
  if (route.skill === null) {
    write(ctx.stdout, "No skill matches this request. Name one explicitly, for example: asterweave skill show bug-fix\n");
    return EXIT.ERROR;
  }
  const lines = [
    `skill     ${route.skill}  [${view.source}]`,
    `scope     ${route.scope}${route.scope === "discovery" ? "  (ends with reviewed findings; no implementation authorized)" : ""}`,
    `workflow  ${route.workflow ?? "none (runs in the current session)"}`,
    ...(route.preSteps.length ? [`first     ${route.preSteps.join(", ")}`] : []),
    `because   ${route.reason} (rule ${route.rule}; ${route.signals.join(", ")})`,
  ];
  write(ctx.stdout, `${sanitizeLines(lines.join("\n"))}\n`);
  return EXIT.OK;
}

/** Handler for `asterweave skill ...`. */
export async function skillCommand(ctx) {
  ctx = { ...ctx, positionals: ctx.positionals ?? [] };
  const sub = ctx.positionals[0];
  switch (sub) {
    case "list":
      return listCommand(ctx);
    case "show":
      return showCommand(ctx);
    case "route":
      return routeCommand(ctx);
    default:
      throw new UsageError(sub ? `Unknown skill subcommand '${safe(sub, 40)}'.` : "Missing skill subcommand.", { remediation: USAGE });
  }
}
