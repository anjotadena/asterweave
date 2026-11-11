// Skill catalog and intent router for `asterweave skill ...`.
//
// A skill is a Claude Code SKILL.md (skills/<id>/SKILL.md). This module only READS them; it never runs a skill, a script
// or a hook, and it never copies a skill body into the catalog (bodies are read by `skill show --body` only).
//
// Sources and precedence (first match wins for a bare id, the same order Claude Code documents for personal over project):
//   user     <home>/.claude/skills        personal skills
//   repo     <repo>/.claude/skills        project skills, honoured ONLY when the repository is trusted (see below)
//   bundled  plugins/asterweave/skills    the Asterweave plugin in this checkout; also addressable as `asterweave:<id>`
// Aliases resolve to the owning skill, never shadow a real skill id, and lose to an id or an earlier alias.
//
// Metadata: `asterweave-skill: <n>` marks a versioned definition (validated by plugins/asterweave/scripts/validate-plugin.mjs).
// A SKILL.md without it is a LEGACY definition: it is still listed, with `metadata: 0` and only name and description.
//
// Trust: the repository trust hash covers .claude/settings*.json, .mcp.json and .claude/asterweave.json, NOT .claude/skills.
// So a trusted repository does not pin its skill files; an untrusted one never wins. Text inside a skill, an issue or a web
// page can never grant a permission: routing only chooses a skill and a workflow, authorization stays with policy and approvals.

import nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactText, sanitizeForTerminal } from "../redact.mjs";

export const SOURCES = Object.freeze(["user", "repo", "bundled"]);
export const MAX_SKILL_BYTES = 64 * 1024;
export const SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const LIST_KEYS = ["aliases", "triggers", "capabilities", "follow-ups"];

export const BUNDLED_DIR = fileURLToPath(new URL("../../../../plugins/asterweave/skills", import.meta.url));

const clean = (value, max = 300) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, max);
const list = (value) => String(value ?? "").split(",").map((item) => item.trim()).filter(Boolean);

/** Frontmatter as flat key: value pairs plus the body. @returns {{meta: object, body: string} | null} */
export function splitSkill(text) {
  const match = String(text).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const meta = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) meta[field[1]] = field[2].trim().replace(/^['"]|['"]$/g, "");
  }
  return { meta, body: match[2] };
}

/** One definition from SKILL.md text; `problems` is non-empty when it cannot be used. */
export function parseSkill(text, { dirName, source, file }) {
  const split = splitSkill(text);
  const problems = [];
  if (!split) return { problems: ["missing frontmatter"], id: dirName, source, file };
  const { meta } = split;
  if (!meta.name) problems.push("missing name");
  else if (meta.name !== dirName) problems.push("name does not match its directory");
  if (!SKILL_ID.test(dirName)) problems.push("directory is not a kebab-case id");
  if (!meta.description) problems.push("missing description");
  const version = meta["asterweave-skill"] === undefined ? 0 : Number(meta["asterweave-skill"]);
  if (!Number.isInteger(version) || version < 0) problems.push("unsupported asterweave-skill version");
  const def = {
    id: dirName,
    description: clean(meta.description, 600),
    metadata: Number.isInteger(version) ? version : null,
    legacy: version === 0,
    aliases: list(meta.aliases).filter((alias) => SKILL_ID.test(alias)),
    triggers: list(meta.triggers).map((item) => clean(item, 80)),
    inputs: clean(meta.inputs),
    prerequisites: clean(meta.prerequisites),
    outputs: clean(meta.outputs),
    capabilities: list(meta.capabilities).map((item) => clean(item, 40)),
    verification: clean(meta.verification),
    stopWhen: clean(meta["stop-when"]),
    followUps: list(meta["follow-ups"]).filter((item) => SKILL_ID.test(item)),
    argumentHint: clean(meta["argument-hint"], 100),
    source,
    file,
    problems,
  };
  return def;
}

function readSkillDir(dir, source, fs) {
  const found = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    return { state: error?.code === "ENOENT" ? "missing" : "unreadable", found };
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue; // symlinks are Dirent.isSymbolicLink(): never followed
    const file = path.join(dir, entry.name, "SKILL.md");
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > MAX_SKILL_BYTES) {
        found.push({ id: entry.name, source, file, problems: ["SKILL.md is not a regular file within the size limit"] });
        continue;
      }
      found.push(parseSkill(fs.readFileSync(file, "utf8"), { dirName: entry.name, source, file }));
    } catch (error) {
      if (error?.code !== "ENOENT") found.push({ id: entry.name, source, file, problems: ["SKILL.md is unreadable"] });
    }
  }
  return { state: "ok", found };
}

/**
 * @param {{repoRoot?: string|null, repoTrusted?: boolean|null, homedir?: string, bundledDir?: string, fs?: object}} [options]
 * @returns {{sources: object[], skills: Map<string, object>, shadowed: object[], invalid: object[], aliases: Map<string, string>}}
 */
export function loadCatalog({ repoRoot = null, repoTrusted = null, homedir = osHomedir(), bundledDir = BUNDLED_DIR, fs = nodeFs } = {}) {
  const dirs = [
    { name: "user", dir: path.join(homedir, ".claude", "skills") },
    { name: "repo", dir: repoRoot ? path.join(repoRoot, ".claude", "skills") : null },
    { name: "bundled", dir: bundledDir },
  ];
  const sources = [];
  const skills = new Map();
  const shadowed = [];
  const invalid = [];
  const all = [];
  for (const { name, dir } of dirs) {
    if (dir === null) {
      sources.push({ name, dir: null, state: "unavailable", reason: "not inside a repository", count: 0 });
      continue;
    }
    const { state, found } = readSkillDir(dir, name, fs);
    const untrusted = name === "repo" && found.length > 0 && repoTrusted !== true;
    sources.push({ name, dir, state: untrusted ? "untrusted" : state, ...(untrusted ? { reason: "repository is not trusted: its skills are listed but never selected" } : {}), count: found.length });
    for (const def of found) {
      if (def.problems.length > 0) {
        invalid.push({ id: def.id, source: name, file: def.file, problems: def.problems });
        continue;
      }
      if (untrusted) {
        shadowed.push({ id: def.id, source: name, file: def.file, reason: "untrusted-repository" });
        continue;
      }
      all.push(def);
    }
  }
  for (const def of all) {
    const winner = skills.get(def.id);
    if (winner) shadowed.push({ id: def.id, source: def.source, file: def.file, reason: `shadowed by ${winner.source}` });
    else skills.set(def.id, def);
  }
  const aliases = new Map();
  for (const def of skills.values()) {
    for (const alias of def.aliases) {
      if (skills.has(alias) || aliases.has(alias)) continue; // an id or an earlier alias wins
      aliases.set(alias, def.id);
    }
  }
  return { sources, skills, shadowed, invalid, aliases };
}

/** `bug-fix`, an alias, or `asterweave:bug-fix` (bundled only). @returns {{skill: object, via: string} | null} */
export function resolveSkill(catalog, name, { bundledDir = BUNDLED_DIR, fs = nodeFs } = {}) {
  const raw = String(name ?? "").trim().replace(/^\//, "");
  if (raw.startsWith("asterweave:")) {
    const id = raw.slice("asterweave:".length);
    if (!SKILL_ID.test(id)) return null;
    const winner = catalog.skills.get(id);
    if (winner?.source === "bundled") return { skill: winner, via: "namespace" };
    const file = path.join(bundledDir, id, "SKILL.md");
    try {
      const def = parseSkill(fs.readFileSync(file, "utf8"), { dirName: id, source: "bundled", file });
      return def.problems.length === 0 ? { skill: def, via: "namespace" } : null;
    } catch {
      return null;
    }
  }
  if (catalog.skills.has(raw)) return { skill: catalog.skills.get(raw), via: "id" };
  if (catalog.aliases.has(raw)) return { skill: catalog.skills.get(catalog.aliases.get(raw)), via: "alias" };
  return null;
}

// ---------------------------------------------------------------------------------------------
// Intent routing: deterministic, text plus evidence, no model call.
// ---------------------------------------------------------------------------------------------

const IMPLEMENT_VERBS = /\b(fix|patch|implement|deliver|resolve|submit|solve)\b/i;
const ISSUE_REF = /(?:\bissues?\s*#?\s*\d+\b|#\d+\b|\/issues\/\d+)/i;
const PR_REF = /\b(?:pr|pull request)\b/i;
const STACK_TRACE = /(?:^|\n)\s*at\s+\S+.*:\d+(?::\d+)?\)?|Traceback \(most recent call last\)|\b\w+(?:Error|Exception):/;
const SYMPTOM = /\b(fix|bug|crash(?:es|ed)?|regression|broken|breaks?|wrong|incorrect|resets?|reset|fails?|failing|not working|doesn'?t work|does not work|stack ?trace|exception|error|freez(?:e|es)|loses?|lost|duplicat(?:e|es)ed?)\b/i;

/** Workflow for a routed skill and scope (null: the skill runs inside the current session, no graph). */
export function workflowFor(skillId, scope) {
  if (skillId === "contribute") return scope === "discovery" ? "audit" : "contribute";
  if (skillId === "repo-audit") return "audit";
  if (skillId === "bug-fix") return "bugfix";
  if (skillId === "feature-implement") return "delivery";
  return null;
}

/**
 * @param {string} text  the user's request (treated as data)
 * @param {{failingTest?: boolean, explicit?: string|null}} [evidence]  repository evidence the caller observed
 * @returns {{skill: string|null, scope: 'discovery'|'implement'|null, preSteps: string[], workflow: string|null, rule: string, signals: string[], reason: string}}
 */
export function routeIntent(text, evidence = {}) {
  const input = String(text ?? "").slice(0, 4000);
  const signals = [];
  const result = (skill, scope, rule, reason, preSteps = []) => ({ skill, scope, preSteps, workflow: skill === null ? null : workflowFor(skill, scope), rule, signals, reason });

  const explicit = input.match(/^\s*\/?(?:asterweave:)?(contribute|repo-audit|issue-triage|bug-fix|feature-implement|test-verify|pr-review|pr-prepare)\b/i);
  if (explicit) {
    signals.push("explicit skill name");
    const id = explicit[1].toLowerCase();
    return result(id, id === "repo-audit" || id === "issue-triage" || id === "pr-review" ? "discovery" : "implement", "explicit", "named by the user");
  }
  const wantsImplement = IMPLEMENT_VERBS.test(input);

  if (/\breview\b/i.test(input) && (PR_REF.test(input) || /\b(diff|my changes|these changes)\b/i.test(input))) {
    signals.push("review + pull request or diff");
    return result("pr-review", "discovery", "review", "a review request over a diff or pull request");
  }
  if (/\b(prepare|package|write|draft)\b/i.test(input) && (PR_REF.test(input) || /\bcontribution\b/i.test(input))) {
    signals.push("prepare + pull request or contribution");
    return result("pr-prepare", "implement", "prepare", "prepare a contribution for review");
  }
  if (/\b(triage|duplicates?|fixable)\b/i.test(input)) {
    signals.push("triage vocabulary");
    return result("issue-triage", "discovery", "triage", "evaluate an issue or finding for action");
  }
  if (/\bcontribut(?:e|ion|ing)\b/i.test(input) || /\bhelp (?:with |out )?(?:this |the |an? )?(?:open[- ]source |existing )?(?:project|repo|repository)\b/i.test(input)) {
    signals.push("contribution vocabulary");
    const scope = wantsImplement ? "implement" : "discovery";
    signals.push(scope === "implement" ? "implementation verb: implementation authorized" : "no implementation verb: discovery only");
    return result("contribute", scope, "contribute", scope === "discovery" ? "a contribution request without an instruction to implement stops at reviewed findings" : "a contribution request that includes implementation", ["repo-audit", "issue-triage"]);
  }
  if (/\b(audit|assess|inspect|review (?:the )?(?:site|repo|repository|module|codebase)|look for (?:bugs|defects|gaps)|find (?:bugs|defects|gaps))\b/i.test(input)) {
    signals.push("audit vocabulary");
    if (wantsImplement) {
      signals.push("implementation verb present");
      return result("contribute", "implement", "audit+implement", "an audit that also asks for the fix", ["repo-audit", "issue-triage"]);
    }
    return result("repo-audit", "discovery", "audit", "an audit request is discovery only");
  }
  if (/\b(run (?:the )?tests?|verify|why is .{0,40}(?:failing|red)|check (?:the )?(?:change|build))\b/i.test(input) && !/\bfix\b/i.test(input)) {
    signals.push("verification vocabulary");
    return result("test-verify", "implement", "verify", "validate a change or investigate a check");
  }
  const issueRef = ISSUE_REF.test(input);
  if (SYMPTOM.test(input) || STACK_TRACE.test(input) || evidence.failingTest === true) {
    if (STACK_TRACE.test(input)) signals.push("stack trace");
    if (evidence.failingTest === true) signals.push("failing test observed in the repository");
    if (SYMPTOM.test(input)) signals.push("defect symptom");
    if (issueRef) signals.push("issue reference");
    return result("bug-fix", "implement", "bug", issueRef ? "a defect report by issue reference: triage first, then fix" : "a defect symptom", issueRef ? ["issue-triage"] : []);
  }
  if (issueRef && wantsImplement) {
    signals.push("issue reference + implementation verb");
    return result("bug-fix", "implement", "issue", "an issue to resolve: triage decides defect or feature", ["issue-triage"]);
  }
  if (/\b(add|build|implement|create|support|introduce|enable)\b/i.test(input)) {
    signals.push("feature vocabulary");
    return result("feature-implement", "implement", "feature", "a request to add behavior");
  }
  return result(null, null, "none", "no skill matches this request");
}
