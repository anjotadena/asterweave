// The Asterweave guard. Pure decision logic, fail closed.
//
//   Decision = { decision: "allow" | "deny" | "require-approval" | "unavailable", reason, ruleId, detail }
//
// `unavailable` is treated exactly like `deny` by every consumer (see `isBlocking`). Anything that throws
// inside the guard becomes `unavailable` / GUARD_UNAVAILABLE; an unknown decision string ranks as deny.
//
// `reason` is one of REASONS (or "ALLOWED" / "APPROVED"). `detail` is an object: `{message, findings?, scope?,
// scopes?, mutating?, operations?}`. `scope = {operation, target}` is what an approval for this decision must
// name (`target` is the exact command text, or the canonical JSON of a merge/deploy input).
//
// Evaluation points, each taking the guard context:
//   evaluateDispatch(action, ctx)    every tool dispatch (classification + tool allow-list + budgets)
//   evaluateMutation(action, ctx)    before any mutation (write/edit/mutating shell or git/merge/deploy): needs the run lock
//   evaluateAdvancement(ctx, p)      before graph advancement (pass / approve): needs a valid plan approval at `approve`
//   evaluateRetry(ctx, p)            before a retry: attempt budget, repeated failure signature, run budgets
//   evaluateResume(ctx, p)           on resume: lock held, policy-hash drift, stale approvals
//
// Guard context (`ctx`):
//   workspaceRoot (required), cwd, mode ("supervised" | "autonomous"), policy (validated object, required for
//   autonomous), platform (PATH semantics), dialect (shell syntax: "posix" | "powershell" | "cmd", or an array of them;
//   see shell-classify.mjs), homedir, userDir, env, branchOf(directory), hooksPathOf(directory) (the repository's core.hooksPath; tests inject it), remotesOf(directory) (the names of the configured remotes, or null; a push is only understood to a configured remote; tests inject it),
//   defaultBranches, realpath, readdir, lstat, readlink,
//   allowCommands (argv prefixes the USER's policy.json treats as understood; also read from policy.allowCommands),
//   maxCommandChars (can only lower the 64 KiB cap), budgetMs (time budget of one classification),
//   approvals: [{scope:{operation,target}}]  already-VALID scoped approvals (a deny is never overridden by one),
//   budgets: {limits:{iterations,toolCalls,tokens,wallMs}, used:{...}}  (0 or null limit = unlimited).
//
// Policy can only turn an operation tag (commit / push-branch / open-pr) from "ask" into "allow" in autonomous
// mode. It never affects deny, DEFAULT_BRANCH_PUSH, merge, deploy, publish or network findings. In autonomous mode
// `push-branch` additionally REQUIRES a non-empty `branches` list in the policy (no list = deny).
//
// The classifier behind `evaluate` is an ALLOW-LIST and a heuristic, not a sandbox: it only allows command forms it fully
// understands; whatever else is UNPARSEABLE_COMMAND (ask when supervised, deny when autonomous) unless the user's policy.json lists
// it in allowCommands. A command over the size cap, or one that exhausts the time / file-system budget, is denied.

import { redactText } from "../redact.mjs";
import { classifyShell } from "./shell-classify.mjs";
import { canonicalJson, globMatch } from "./policy.mjs";

/** Reason codes of the guard. */
export const REASONS = Object.freeze([
  "DESTRUCTIVE_COMMAND",
  "DEFAULT_BRANCH_PUSH",
  "OUT_OF_POLICY_OPERATION",
  "NETWORK_EGRESS",
  "PATH_OUTSIDE_WORKSPACE",
  "SECRET_ACCESS",
  "APPROVAL_SELF_GRANT",
  "PROTECTED_PATH",
  "UNPARSEABLE_COMMAND",
  "UNDISPLAYABLE_TARGET",
  "TOOL_NOT_ALLOWED",
  "BUDGET_EXHAUSTED",
  "STALE_APPROVAL",
  "HOOK_BLOCKED",
  "HOOK_FAILED",
  "GUARD_UNAVAILABLE",
]);

/** Tool names an action may use. */
export const TOOLS = Object.freeze(["shell", "read", "write", "edit", "git", "merge", "deploy"]);

const DECISION_RANK = Object.freeze({ allow: 0, "require-approval": 1, deny: 2, unavailable: 2 });
const DENY_ORDER = ["DESTRUCTIVE_COMMAND", "APPROVAL_SELF_GRANT", "PROTECTED_PATH", "SECRET_ACCESS", "PATH_OUTSIDE_WORKSPACE"];
const ASK_ORDER = ["DEFAULT_BRANCH_PUSH", "OUT_OF_POLICY_OPERATION", "NETWORK_EGRESS"];

/** Strictness rank: allow 0, require-approval 1, deny = unavailable = anything unknown 2. */
export function rank(decision) {
  const value = DECISION_RANK[decision?.decision];
  return value === undefined ? 2 : value;
}

/** True for `deny`, `unavailable` and anything that is not exactly `allow` / `require-approval`. */
export function isBlocking(decision) {
  return rank(decision) >= 2;
}

/** The stricter of two decisions (`a` wins ties). Hooks use this: a later decision can only tighten. */
export function stricter(a, b) {
  return rank(b) > rank(a) ? b : a;
}

export function makeDecision(decision, reason, ruleId, detail = {}) {
  return { decision, reason, ruleId, detail: { ...detail, message: redactText(String(detail.message ?? "")).text } };
}

const allow = (detail) => makeDecision("allow", "ALLOWED", "allow", detail);

function unavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return makeDecision("unavailable", "GUARD_UNAVAILABLE", "guard-unavailable", { message: `the guard could not evaluate this action (${message})` });
}

/**
 * Single-quote a string for a POSIX-style shell. Every command the guard builds with it (file paths, git arguments,
 * hook argv) is classified with the `posix` dialect on every platform, so this quoting is right on Windows too.
 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function requireContext(ctx) {
  if (ctx === null || typeof ctx !== "object") throw new TypeError("guard context is missing");
  if (typeof ctx.workspaceRoot !== "string" || ctx.workspaceRoot === "") throw new TypeError("guard context has no workspaceRoot");
  const mode = ctx.mode ?? "supervised";
  if (mode !== "supervised" && mode !== "autonomous") throw new TypeError(`unknown guard mode '${String(mode)}'`);
  if (mode === "autonomous" && (ctx.policy === null || typeof ctx.policy !== "object" || ctx.policy.autonomous === null || typeof ctx.policy.autonomous !== "object")) {
    throw new TypeError("autonomous mode requires a policy with an autonomous block");
  }
  return mode;
}

function classifierOptions(ctx, input, { synthesized = false } = {}) {
  const options = { cwd: input?.cwd ?? ctx.cwd ?? ctx.workspaceRoot, workspaceRoot: ctx.workspaceRoot };
  for (const key of ["platform", "dialect", "homedir", "userDir", "env", "branchOf", "defaultBranches", "realpath", "readdir", "lstat", "readlink", "hooksPathOf", "remotesOf", "maxCommandChars", "budgetMs"]) if (ctx[key] !== undefined) options[key] = ctx[key];
  // The user's own list of commands that count as understood: from policy.json only (a repository file can never set it).
  const allowCommands = ctx.allowCommands ?? ctx.policy?.allowCommands;
  if (Array.isArray(allowCommands)) options.allowCommands = allowCommands;
  if (synthesized) options.dialect = "posix";
  return options;
}

function approved(ctx, scope) {
  return (ctx.approvals ?? []).some((approval) => approval?.scope?.operation === scope.operation && approval?.scope?.target === scope.target);
}

/** Build the decision for a set of findings (shell command or synthetic file access). */
function decideFindings({ findings, operations, mutating }, { ctx, mode, target }) {
  const detailBase = { findings: findings.map(({ code, ruleId, detail }) => ({ code, ruleId, detail })), operations, mutating };
  for (const code of DENY_ORDER) {
    const hit = findings.find((finding) => finding.code === code);
    if (hit) return makeDecision("deny", code, hit.ruleId, { ...detailBase, message: hit.detail });
  }
  const refused = findings.find((finding) => finding.code === "UNPARSEABLE_COMMAND" && finding.hard === true);
  if (refused) return makeDecision("deny", "UNPARSEABLE_COMMAND", refused.ruleId, { ...detailBase, message: `${refused.detail}; a command this size or shape cannot be reviewed, so it is refused in every mode` });
  const unparseable = findings.find((finding) => finding.code === "UNPARSEABLE_COMMAND");
  if (unparseable && mode === "autonomous") {
    return makeDecision("deny", "UNPARSEABLE_COMMAND", unparseable.ruleId, { ...detailBase, message: `${unparseable.detail}; unattended runs cannot execute commands the guard cannot follow` });
  }
  // Findings that need a scoped approval, plus operations an autonomous policy has not pre-authorized.
  const asks = [];
  for (const code of [...ASK_ORDER, "UNPARSEABLE_COMMAND"]) {
    for (const finding of findings.filter((entry) => entry.code === code)) asks.push({ reason: code, ruleId: finding.ruleId, message: finding.detail, scope: { operation: finding.operation ?? code.toLowerCase(), target } });
  }
  if (mode === "autonomous") {
    const block = ctx.policy.autonomous;
    for (const operation of operations) {
      if (operation.name === "push-branch" && (!Array.isArray(block.branches) || block.branches.length === 0)) {
        return makeDecision("deny", "OUT_OF_POLICY_OPERATION", "push-branch-requires-branches", { ...detailBase, message: "the autonomous policy lists 'push-branch' but no 'branches' scope; an unscoped push cannot be told from a push to a protected branch" });
      }
      const listed = Array.isArray(block.operations) && block.operations.includes(operation.name);
      const branchOk = operation.name !== "push-branch" || block.branches.some((glob) => globMatch(glob, operation.target ?? ""));
      if (!listed) asks.push({ reason: "OUT_OF_POLICY_OPERATION", ruleId: `operation-${operation.name}`, message: `the policy does not pre-authorize '${operation.name}'`, scope: { operation: operation.name, target } });
      else if (!branchOk) asks.push({ reason: "OUT_OF_POLICY_OPERATION", ruleId: "operation-push-branch-scope", message: `branch '${operation.target}' is outside the policy's branch scope`, scope: { operation: "push-branch", target } });
    }
  }
  const pending = asks.filter((entry) => !approved(ctx, entry.scope));
  if (pending.length > 0) {
    const first = pending[0];
    return makeDecision("require-approval", first.reason, first.ruleId, { ...detailBase, message: first.message, scope: first.scope, scopes: pending.map((entry) => entry.scope) });
  }
  if (asks.length > 0) return makeDecision("allow", "APPROVED", "scoped-approval", { ...detailBase, message: "every approval-gated step has a valid scoped approval", scopes: asks.map((entry) => entry.scope) });
  return allow(detailBase);
}

function pathAccess(ctx, mode, text, { writer, operationName }) {
  if (typeof text !== "string" || text === "" || /[\n\r\0']/.test(text)) {
    return makeDecision("deny", "TOOL_NOT_ALLOWED", "invalid-path-argument", { message: `${operationName} needs a plain, non-empty file path` });
  }
  // The tool path is classified AS A PATH (no shell parsing, no $ / % / ~ expansion; Windows stream, 8.3, trailing dot and space forms are normalized).
  const result = classifyShell(text, { ...classifierOptions(ctx, {}, { synthesized: true }), asPath: writer ? "write" : "read" });
  const decision = decideFindings({ ...result, mutating: writer }, { ctx, mode, target: text });
  return decision;
}

function gitCommand(input) {
  if (Array.isArray(input.args) && input.args.every((arg) => typeof arg === "string")) return ["git", ...input.args].map((part, index) => (index === 0 ? part : shellQuote(part))).join(" ");
  if (typeof input.command === "string" && /^\s*git\b/.test(input.command)) return input.command;
  return null;
}

/**
 * Evaluate one action. Never throws: any internal failure is `unavailable` / GUARD_UNAVAILABLE.
 *
 * @param {object} action  `{type:"tool", tool:{name,input}}`, or a bare `{name, input}`. Other action types are not tool use and are allowed here.
 * @param {object} ctx     See the module comment.
 * @returns {{decision: string, reason: string, ruleId: string, detail: object}}
 */
export function evaluate(action, ctx) {
  try {
    const mode = requireContext(ctx);
    if (action === null || typeof action !== "object") return makeDecision("deny", "TOOL_NOT_ALLOWED", "malformed-action", { message: "the action is not an object" });
    const tool = action.type === undefined && typeof action.name === "string" ? action : action.tool;
    if (action.type !== undefined && action.type !== "tool") return allow({ message: `'${String(action.type)}' is not a tool action` });
    if (tool === null || typeof tool !== "object" || typeof tool.name !== "string") return makeDecision("deny", "TOOL_NOT_ALLOWED", "malformed-action", { message: "the tool action has no tool name" });
    const input = tool.input !== null && typeof tool.input === "object" ? tool.input : {};
    if (!TOOLS.includes(tool.name)) return makeDecision("deny", "TOOL_NOT_ALLOWED", "unknown-tool", { message: `tool '${tool.name}' is not a known tool` });
    if (mode === "autonomous" && tool.name !== "merge" && tool.name !== "deploy" && !(ctx.policy.autonomous.tools ?? []).includes(tool.name)) {
      return makeDecision("deny", "TOOL_NOT_ALLOWED", "tool-not-in-policy", { message: `tool '${tool.name}' is not allowed by the autonomous policy` });
    }
    switch (tool.name) {
      case "shell": {
        if (typeof input.command !== "string") return makeDecision("deny", "UNPARSEABLE_COMMAND", "command-not-string", { message: "the shell command is not a string" });
        return decideFindings(classifyShell(input.command, classifierOptions(ctx, input)), { ctx, mode, target: input.command });
      }
      case "git": {
        const command = gitCommand(input);
        if (command === null) return makeDecision("deny", "TOOL_NOT_ALLOWED", "invalid-git-input", { message: "the git tool needs an args array of strings" });
        return decideFindings(classifyShell(command, classifierOptions(ctx, input, { synthesized: Array.isArray(input.args) })), { ctx, mode, target: command });
      }
      case "read":
        return pathAccess(ctx, mode, input.path ?? input.file_path, { writer: false, operationName: "read" });
      case "write":
      case "edit":
        return pathAccess(ctx, mode, input.path ?? input.file_path, { writer: true, operationName: tool.name });
      default: {
        // merge / deploy: always a scoped approval, never grantable by policy.
        const scope = { operation: tool.name, target: canonicalJson(input) };
        const finding = { code: "OUT_OF_POLICY_OPERATION", ruleId: `tool-${tool.name}`, detail: `${tool.name} needs an explicit scoped approval`, operation: tool.name };
        const detail = { findings: [{ code: finding.code, ruleId: finding.ruleId, detail: finding.detail }], operations: [], mutating: true };
        if (approved(ctx, scope)) return makeDecision("allow", "APPROVED", "scoped-approval", { ...detail, message: `${tool.name} has a valid scoped approval`, scopes: [scope] });
        return makeDecision("require-approval", finding.code, finding.ruleId, { ...detail, message: finding.detail, scope, scopes: [scope] });
      }
    }
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * First exhausted budget, or null. A limit of 0 / null / undefined means unlimited.
 * @returns {{name: string, used: number, limit: number} | null}
 */
export function exhaustedBudget(budgets) {
  const limits = budgets?.limits ?? {};
  const used = budgets?.used ?? {};
  for (const name of ["iterations", "toolCalls", "tokens", "wallMs"]) {
    const limit = limits[name];
    if (Number.isFinite(limit) && limit > 0 && Number(used[name] ?? 0) >= limit) return { name, used: Number(used[name] ?? 0), limit };
  }
  return null;
}

function budgetDecision(ctx) {
  const hit = exhaustedBudget(ctx?.budgets);
  return hit ? makeDecision("deny", "BUDGET_EXHAUSTED", `budget-${hit.name}`, { message: `the ${hit.name} budget is exhausted (${hit.used}/${hit.limit})`, budget: hit }) : null;
}

/** Tool dispatch: budgets first, then the action itself. */
export function evaluateDispatch(action, ctx) {
  try {
    return budgetDecision(ctx) ?? evaluate(action, ctx);
  } catch (error) {
    return unavailable(error);
  }
}

/** Before any mutation: the action must pass, and a mutating action needs the run lock (`ctx.lockHeld === true`). */
export function evaluateMutation(action, ctx) {
  try {
    const decision = evaluate(action, ctx);
    if (decision.decision !== "allow" || decision.detail?.mutating !== true) return decision;
    if (ctx.lockHeld !== true) return makeDecision("unavailable", "GUARD_UNAVAILABLE", "lock-not-held", { message: "a mutation needs the run lock, which this process does not hold", mutating: true });
    return decision;
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Before graph advancement.
 * @param {object} ctx
 * @param {{node: string, outcome?: string, approvals?: Array<{kind: string, valid: boolean}>}} step
 *   At node `approve` a `pass` needs a valid `plan` approval; otherwise advancement is allowed unless a budget is exhausted.
 */
export function evaluateAdvancement(ctx, { node, outcome = "pass", approvals = [] } = {}) {
  try {
    const budget = budgetDecision(ctx);
    if (budget) return budget;
    if (node === "approve" && outcome === "pass") {
      const plan = approvals.filter((approval) => approval?.kind === "plan");
      if (!plan.some((approval) => approval.valid === true)) {
        return makeDecision("require-approval", "STALE_APPROVAL", "plan-approval-missing", {
          message: plan.length > 0 ? "the plan approval is stale (the plan or the policy changed since it was granted)" : "the plan has not been approved",
          scope: { operation: "plan", target: node },
        });
      }
    }
    return allow({ message: "advancement allowed" });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Before a retry.
 * @param {object} ctx
 * @param {{node: string, attempts: number, maxAttempts: number, signature?: string, signatureCounts?: Record<string, number>}} step
 */
export function evaluateRetry(ctx, { node, attempts, maxAttempts, signature, signatureCounts = {} } = {}) {
  try {
    const budget = budgetDecision(ctx);
    if (budget) return budget;
    if (!Number.isInteger(attempts) || !Number.isInteger(maxAttempts)) return makeDecision("unavailable", "GUARD_UNAVAILABLE", "retry-state-missing", { message: "attempt counters are missing" });
    if (attempts >= maxAttempts) return makeDecision("deny", "BUDGET_EXHAUSTED", "attempts-exhausted", { message: `node '${node}' used all ${maxAttempts} attempts` });
    if (signature !== undefined && Number(signatureCounts[signature] ?? 0) >= 2) {
      return makeDecision("deny", "BUDGET_EXHAUSTED", "stable-failure", { message: `the same failure signature repeated ${signatureCounts[signature]} times at node '${node}'` });
    }
    return allow({ message: "retry allowed" });
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * On resume.
 * @param {object} ctx
 * @param {{lockHeld?: boolean, runPolicyHash?: string, approvals?: Array<{valid: boolean}>}} state
 */
export function evaluateResume(ctx, { lockHeld, runPolicyHash, approvals = [] } = {}) {
  try {
    if (lockHeld !== true) return makeDecision("unavailable", "GUARD_UNAVAILABLE", "lock-not-held", { message: "the run lock is not held, so the run cannot be resumed" });
    const budget = budgetDecision(ctx);
    if (budget) return budget;
    if (typeof ctx?.policyHash === "string" && typeof runPolicyHash === "string" && ctx.policyHash !== runPolicyHash) {
      return makeDecision("require-approval", "STALE_APPROVAL", "policy-hash-drift", { message: "the policy changed since this run started; approvals granted under the old policy are stale", scope: { operation: "resume", target: runPolicyHash } });
    }
    if (approvals.some((approval) => approval?.valid === false)) {
      return makeDecision("require-approval", "STALE_APPROVAL", "approval-stale", { message: "an approval is no longer valid for the current plan or policy" });
    }
    return allow({ message: "resume allowed" });
  } catch (error) {
    return unavailable(error);
  }
}
