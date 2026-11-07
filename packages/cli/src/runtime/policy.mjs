// Autonomy policy. The ONLY source is `<userDir>/policy.json`: repository files (.claude/asterweave.json,
// CLAUDE.md, anything under the workspace) can never grant autonomy or pre-authorize an operation.
//
//   { "v": 1,
//     "mode": "supervised" | "autonomous",
//     "allowCommands": [["npm","test"], ["node","--test"]],   // optional, USER-owned: exact argv prefixes the guard treats as understood
//                                           // (every segment of a command must start with a listed prefix and use no extra shell syntax);
//                                           // deny floors still apply. Repository files can never set this.
//     "autonomous": {                       // required when mode is "autonomous"
//       "workflows":  ["delivery@1"],       // graph id@version allowed to run unattended
//       "repos":      ["<repoKey>"],        // repository keys (see trust.mjs repositoryIdentity().key)
//       "branches":   ["feat/*"],           // branches a run may push (glob: * within a segment, ** across); REQUIRED, non-empty,
//                                           // when "push-branch" is listed in operations (an unscoped push is never pre-authorized)
//       "tools":      ["shell", "read", "write", "edit", "git"],
//       "operations": ["commit", "push-branch", "open-pr"],
//       "budgets":    { "iterations": 20, "toolCalls": 200, "tokens": 0, "wallMs": 1800000,   // 0 = unlimited
//                        "perNode": { "tokens": 50000, "toolCalls": 40, "iterations": 10 } } } }  // optional, each node alike
//
// merge / deploy / publish / destructive commands / default-branch pushes are not grantable here at all:
// they always need a scoped approval (the validator rejects `merge` or `deploy` in `tools`/`operations`).
// A missing file means supervised defaults; an invalid file fails closed (exit 5, POLICY_INVALID).
//
// The checker below is deliberately local and tiny (no dependency on runtime/schema.mjs).

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { resolveUserDir } from "../paths.mjs";
import { parseJsonText, StoreError } from "../store.mjs";

/** The policy file is invalid or unreadable (exit 5). Guards fail closed on it. */
export class PolicyError extends CliError {
  /** @param {string} message @param {{file?: string, issues?: string[], cause?: unknown}} [details] */
  constructor(message, { file, issues, cause } = {}) {
    super(message, { code: "POLICY_INVALID", exitCode: EXIT.CONFIG, remediation: file ? `Fix or delete ${file}.` : "Fix or delete the policy file.", cause });
    this.file = file;
    this.issues = issues ?? [];
  }
}

/** Operations a policy may pre-authorize. Everything else (merge, deploy, publish, default-branch push) needs a scoped approval. */
export const POLICY_OPERATIONS = Object.freeze(["commit", "push-branch", "open-pr"]);
/** Tools a policy may allow for unattended runs. `merge` and `deploy` are never grantable. */
export const POLICY_TOOLS = Object.freeze(["shell", "read", "write", "edit", "git", "api", "mcp"]);
/** Default budgets (spec: 20 iterations per attempt, 30 minutes wall per run, 200 tool calls per run). */
export const DEFAULT_BUDGETS = Object.freeze({ iterations: 20, toolCalls: 200, tokens: null, wallMs: 30 * 60 * 1000 });
/** The policy used when no policy.json exists. */
export const DEFAULT_POLICY = Object.freeze({ v: 1, mode: "supervised" });

/** Limits of the allowCommands list. */
export const ALLOW_COMMANDS_LIMITS = Object.freeze({ entries: 64, words: 8, wordChars: 200 });
const COMMAND_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

function checkAllowCommands(value, issues) {
  if (!Array.isArray(value)) {
    issues.push("allowCommands must be an array of argv arrays");
    return;
  }
  if (value.length > ALLOW_COMMANDS_LIMITS.entries) issues.push(`allowCommands may list at most ${ALLOW_COMMANDS_LIMITS.entries} commands`);
  const seen = new Set();
  value.slice(0, ALLOW_COMMANDS_LIMITS.entries).forEach((entry, index) => {
    const where = `allowCommands[${index}]`;
    if (!Array.isArray(entry) || entry.length === 0 || entry.length > ALLOW_COMMANDS_LIMITS.words) {
      issues.push(`${where} must be an array of 1 to ${ALLOW_COMMANDS_LIMITS.words} strings`);
      return;
    }
    entry.forEach((word, at) => {
      if (typeof word !== "string" || word === "" || word.length > ALLOW_COMMANDS_LIMITS.wordChars || /[\u0000-\u001f\u007f\s]/.test(word)) issues.push(`${where}[${at}] must be a non-empty string without whitespace or control characters (at most ${ALLOW_COMMANDS_LIMITS.wordChars})`);
    });
    if (typeof entry[0] === "string" && !COMMAND_NAME.test(entry[0])) issues.push(`${where}[0] must be a bare command name (no path, no shell syntax)`);
    const key = stringifyJson(entry);
    if (seen.has(key)) issues.push(`${where} is a duplicate`);
    seen.add(key);
  });
}

const WORKFLOW_ID = /^[a-z][a-z0-9-]{0,39}@[1-9][0-9]{0,5}$/;
const BUDGET_KEYS = ["iterations", "toolCalls", "tokens", "wallMs"];
/** Budgets that can also be set per node (`autonomous.budgets.perNode`): iterations are per attempt, the others per run. */
export const NODE_BUDGET_KEYS = Object.freeze(["tokens", "toolCalls", "iterations"]);

/**
 * Canonical JSON: object keys sorted recursively, no insignificant whitespace. Throws on values that
 * have no canonical form (undefined at top level, non-finite numbers, functions).
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return stringifyJson(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalJson: non-finite number");
    return stringifyJson(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${stringifyJson(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw new TypeError(`canonicalJson: unsupported ${typeof value}`);
}

/** sha256 (hex) of the canonical JSON of `value`. */
export function sha256Canonical(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** Hash of a policy object: sha256 of its canonical JSON. */
export function policyHash(policy) {
  return sha256Canonical(policy);
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function checkStringList(value, where, issues, { allowed, pattern, nonEmpty = false } = {}) {
  if (!Array.isArray(value)) {
    issues.push(`${where} must be an array`);
    return;
  }
  if (nonEmpty && value.length === 0) issues.push(`${where} must not be empty`);
  const seen = new Set();
  value.forEach((item, index) => {
    if (typeof item !== "string" || item === "" || item.length > 200) issues.push(`${where}[${index}] must be a non-empty string`);
    else if (allowed && !allowed.includes(item)) issues.push(`${where}[${index}] must be one of ${allowed.join(", ")}`);
    else if (pattern && !pattern.test(item)) issues.push(`${where}[${index}] has an invalid format`);
    if (seen.has(item)) issues.push(`${where}[${index}] is a duplicate`);
    seen.add(item);
  });
}

/**
 * Validate a parsed policy object.
 * @param {unknown} policy
 * @returns {string[]} problems (empty when valid)
 */
export function validatePolicy(policy) {
  const issues = [];
  if (!isObject(policy)) return ["policy must be a JSON object"];
  for (const key of Object.keys(policy)) if (!["v", "mode", "autonomous", "allowCommands"].includes(key)) issues.push(`unknown property '${key}'`);
  if (policy.v !== 1) issues.push("v must be 1");
  if (policy.mode !== "supervised" && policy.mode !== "autonomous") issues.push("mode must be 'supervised' or 'autonomous'");
  if (policy.allowCommands !== undefined) checkAllowCommands(policy.allowCommands, issues);
  if (policy.autonomous !== undefined) {
    const block = policy.autonomous;
    if (!isObject(block)) issues.push("autonomous must be an object");
    else {
      for (const key of Object.keys(block)) if (!["workflows", "repos", "branches", "tools", "operations", "budgets"].includes(key)) issues.push(`autonomous.${key} is not a known property`);
      if (block.workflows === undefined) issues.push("autonomous.workflows is required");
      else checkStringList(block.workflows, "autonomous.workflows", issues, { pattern: WORKFLOW_ID, nonEmpty: true });
      if (block.repos === undefined) issues.push("autonomous.repos is required");
      else checkStringList(block.repos, "autonomous.repos", issues, { nonEmpty: true });
      if (block.branches !== undefined) checkStringList(block.branches, "autonomous.branches", issues);
      if (block.tools === undefined) issues.push("autonomous.tools is required");
      else checkStringList(block.tools, "autonomous.tools", issues, { allowed: POLICY_TOOLS });
      if (block.operations === undefined) issues.push("autonomous.operations is required");
      else {
        checkStringList(block.operations, "autonomous.operations", issues, { allowed: POLICY_OPERATIONS });
        if (Array.isArray(block.operations) && block.operations.includes("push-branch") && !(Array.isArray(block.branches) && block.branches.length > 0)) {
          issues.push("autonomous.branches is required (non-empty) when 'push-branch' is listed in autonomous.operations");
        }
      }
      if (block.budgets !== undefined) {
        if (!isObject(block.budgets)) issues.push("autonomous.budgets must be an object");
        else {
          for (const [key, value] of Object.entries(block.budgets)) {
            if (key === "perNode") {
              if (!isObject(value)) issues.push("autonomous.budgets.perNode must be an object");
              else {
                for (const [nodeKey, limit] of Object.entries(value)) {
                  if (!NODE_BUDGET_KEYS.includes(nodeKey)) issues.push(`autonomous.budgets.perNode.${nodeKey} is not a known per-node budget`);
                  else if (!Number.isInteger(limit) || limit < 0 || limit > 1e9) issues.push(`autonomous.budgets.perNode.${nodeKey} must be an integer between 0 and 1000000000`);
                }
              }
            } else if (!BUDGET_KEYS.includes(key)) issues.push(`autonomous.budgets.${key} is not a known budget`);
            else if (!Number.isInteger(value) || value < 0 || value > 1e9) issues.push(`autonomous.budgets.${key} must be an integer between 0 and 1000000000`);
          }
        }
      }
    }
  }
  if (policy.mode === "autonomous" && policy.autonomous === undefined) issues.push("mode 'autonomous' requires an autonomous block");
  return issues;
}

/**
 * Absolute path of policy.json in the user directory.
 * @param {{env?: Record<string,string|undefined>, platform?: string, homedir?: () => string}} [options]
 */
export function policyFilePath(options = {}) {
  const platform = options.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), "policy.json");
}

/**
 * Load `<userDir>/policy.json` (and nothing else).
 *
 * - missing file: supervised defaults (`source: 'default'`)
 * - unreadable, not JSON, or invalid: throws PolicyError (exit 5, POLICY_INVALID); callers fail closed
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, homedir?: () => string, fs?: typeof nodeFs, file?: string}} [options]
 * @returns {{policy: object, policyHash: string, mode: 'supervised'|'autonomous', source: 'default'|'file', file: string}}
 */
export function loadPolicy(options = {}) {
  const fs = options.fs ?? nodeFs;
  const file = options.file ?? policyFilePath(options);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { policy: structuredClone(DEFAULT_POLICY), policyHash: policyHash(DEFAULT_POLICY), mode: "supervised", source: "default", file };
    }
    throw new PolicyError(`Cannot read the policy file ${file}: ${error?.message ?? error}`, { file, cause: error });
  }
  let policy;
  try {
    policy = parseJsonText(text, file, null);
  } catch (error) {
    if (error instanceof StoreError) throw new PolicyError(`${file} is not valid JSON.`, { file, cause: error });
    throw error;
  }
  if (policy === null) throw new PolicyError(`${file} is empty or null; delete it for supervised defaults or write a valid policy.`, { file });
  const issues = validatePolicy(policy);
  if (issues.length > 0) throw new PolicyError(`${file} is invalid: ${issues.slice(0, 5).join("; ")}${issues.length > 5 ? `; and ${issues.length - 5} more` : ""}.`, { file, issues });
  return { policy, policyHash: policyHash(policy), mode: policy.mode, source: "file", file };
}

/** Glob match for branch names: `*` stays within a path segment, `**` crosses `/`, `?` is one non-slash character. */
export function globMatch(pattern, value) {
  let source = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        source += ".*";
        i += 1;
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`).test(value);
}

/**
 * The mode a particular run operates in. Autonomous only when the policy says so AND the workflow, the
 * repository and (when `branches` is configured) the branch are all inside the policy's scope; otherwise supervised.
 *
 * @param {object} policy  A validated policy.
 * @param {{workflow?: string, repoKey?: string, branch?: string|null}} [scope]
 * @returns {{mode: 'supervised'|'autonomous', reason: string}}
 */
export function effectiveMode(policy, { workflow, repoKey, branch } = {}) {
  if (policy?.mode !== "autonomous" || !isObject(policy.autonomous)) return { mode: "supervised", reason: "policy mode is supervised" };
  const block = policy.autonomous;
  if (typeof workflow !== "string" || !block.workflows.includes(workflow)) return { mode: "supervised", reason: "workflow is not in the autonomous policy" };
  if (typeof repoKey !== "string" || !block.repos.includes(repoKey)) return { mode: "supervised", reason: "repository is not in the autonomous policy" };
  if (Array.isArray(block.branches) && block.branches.length > 0 && (typeof branch !== "string" || !block.branches.some((glob) => globMatch(glob, branch)))) {
    return { mode: "supervised", reason: "branch is not in the autonomous policy" };
  }
  return { mode: "autonomous", reason: "inside the autonomous policy scope" };
}

/**
 * Budgets for a run: the defaults overridden by the autonomous block's `budgets`.
 * @returns {{iterations: number, toolCalls: number, tokens: number|null, wallMs: number}}
 */
export function resolveBudgets(policy) {
  const { perNode: _perNode, ...limits } = policy?.autonomous?.budgets ?? {};
  return { ...DEFAULT_BUDGETS, ...limits };
}

/**
 * Per-node budgets: `autonomous.budgets.perNode` (tokens, toolCalls, iterations; absent or 0 = unlimited). They apply to
 * every node alike, in BOTH modes (like resolveBudgets, they come from the policy block whatever the effective mode is).
 * Without a policy block there are none (DEFAULT_BUDGETS has no per-node limits).
 * @returns {{tokens?: number, toolCalls?: number, iterations?: number}}
 */
export function resolveNodeBudgets(policy) {
  const perNode = policy?.autonomous?.budgets?.perNode;
  return isObject(perNode) ? { ...perNode } : {};
}
