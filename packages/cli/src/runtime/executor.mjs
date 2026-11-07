// The executor contract of the run loop.
//
// An EXECUTOR is the part that decides what to do next (a scripted fake today, a model later). It never
// runs anything: it returns an ACTION, and only the loop performs it, after validation, the guard and the
// hooks (loop.mjs). Tool actions are carried out by a TOOL DISPATCHER, also supplied to the loop.
//
//   Executor = {
//     id: string,
//     observe(ctx): Promise<Observation>                 read-only view of the situation
//     decide(ctx, observation): Promise<unknown>         the next action (validated by validateAction)
//     verify?(ctx, result): Promise<Verification>        optional check of a tool result
//     describe?(ctx, action): {idempotent?, delayMs?}    optional hints for an action
//     usage?(ctx): {tokens?, inputTokens?, outputTokens?, cacheReadTokens?, cacheCreationTokens?, contextTokens?, model?} | null
//                                                        optional accounting; each counter is a non-negative integer or
//                                                        null (unknown, never 0). See usage.mjs.
//   }
//   ctx = { runId, goal, node, attempt, step, iteration, signal, feedback, lastResult, approvals }
//   Verification = { ok: boolean, reason?: string, evidence?: Evidence[] }
//
//   ToolDispatcher = { id: string, dispatch(action, ctx): Promise<{ok: boolean, output?: string, error?: string}> }
//
// ACTION (v1), one JSON object, unknown fields rejected:
//   { v: 1, type: "tool" | "evidence" | "complete" | "request-approval" | "wait", reason?,
//     tool?: {name: "shell"|"read"|"write"|"edit"|"git"|"merge"|"deploy", input: object},   // type tool
//     evidence?: {kind, summary, result: "pass"|"fail"|"info", path?, sha256?},             // type evidence
//     outcome?, signature?,                                                                  // type complete
//     approval?: {operation, target},                                                        // type request-approval
//     ms?: number }                                                                          // type wait
//
// Validation never echoes a raw value into a message: errors name a path and a rule, nothing else, and
// are redacted and length-capped on top of that.

import { createHash } from "node:crypto";
import { CliError, EXIT } from "../exit-codes.mjs";
import { redactText, sanitizeForTerminal } from "../redact.mjs";
import { canonicalJson, OUTCOMES } from "./graph.mjs";
import { TOOLS } from "./guard.mjs";
import { check } from "./schema.mjs";

export const ACTION_VERSION = 1;
export const ACTION_TYPES = Object.freeze(["tool", "evidence", "complete", "request-approval", "wait"]);
export const TOOL_NAMES = TOOLS;

export const LIMITS = Object.freeze({
  reason: 2000,
  signature: 512,
  summary: 4000,
  kind: 128,
  path: 1024,
  operation: 128,
  target: 100_000,
  inputString: 200_000,
  inputBytes: 1_000_000,
  inputDepth: 10,
  waitMs: 60_000,
});

const SHA256 = "^[0-9a-f]{64}$";

const ACTION_SPEC = {
  type: "object",
  required: ["v", "type"],
  additionalProperties: false,
  properties: {
    v: { const: ACTION_VERSION },
    type: { enum: ACTION_TYPES },
    reason: { type: "string", maxLength: LIMITS.reason },
    tool: {
      type: "object",
      required: ["name", "input"],
      additionalProperties: false,
      properties: { name: { enum: TOOL_NAMES }, input: { type: "object" } },
    },
    evidence: {
      type: "object",
      required: ["kind", "summary", "result"],
      additionalProperties: false,
      properties: {
        kind: { type: "string", minLength: 1, maxLength: LIMITS.kind },
        summary: { type: "string", minLength: 1, maxLength: LIMITS.summary },
        result: { enum: ["pass", "fail", "info"] },
        path: { type: ["string", "null"], maxLength: LIMITS.path },
        sha256: { type: ["string", "null"], pattern: SHA256 },
      },
    },
    outcome: { enum: OUTCOMES },
    signature: { type: "string", maxLength: LIMITS.signature },
    approval: {
      type: "object",
      required: ["operation", "target"],
      additionalProperties: false,
      properties: {
        operation: { type: "string", minLength: 1, maxLength: LIMITS.operation },
        target: { type: "string", maxLength: LIMITS.target },
      },
    },
    ms: { type: "integer", min: 0, max: LIMITS.waitMs },
  },
};

// Which optional members each action type must / may carry.
const SHAPES = {
  tool: { required: ["tool"], allowed: ["tool", "reason"] },
  evidence: { required: ["evidence"], allowed: ["evidence", "reason"] },
  complete: { required: ["outcome"], allowed: ["outcome", "signature", "reason"] },
  "request-approval": { required: ["approval"], allowed: ["approval", "reason"] },
  wait: { required: [], allowed: ["ms", "reason"] },
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function safeMessage(message) {
  return redactText(sanitizeForTerminal(String(message))).text.slice(0, 200);
}

// Tool input must be plain bounded JSON data (no functions, symbols, bigints, cycles, class instances).
function checkInputData(value, path, errors, budget, depth = 0) {
  if (errors.length >= 20) return;
  if (depth > LIMITS.inputDepth) return void errors.push(`${path}: nested too deeply`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) errors.push(`${path}: number is not finite`);
    return;
  }
  if (typeof value === "string") {
    budget.bytes += value.length;
    if (value.length > LIMITS.inputString) errors.push(`${path}: string longer than ${LIMITS.inputString}`);
    if (budget.bytes > LIMITS.inputBytes) errors.push(`${path}: input larger than ${LIMITS.inputBytes} characters`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => checkInputData(item, `${path}[${index}]`, errors, budget, depth + 1));
    return;
  }
  if (isObject(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    for (const key of Object.keys(value)) {
      budget.bytes += key.length;
      if (value[key] === undefined) continue;
      checkInputData(value[key], `${path}.${key.length > 40 ? "<long key>" : key.replace(/[^\w-]/g, "?")}`, errors, budget, depth + 1);
    }
    return;
  }
  errors.push(`${path}: not plain JSON data`);
}

/**
 * Validate the raw output of `executor.decide`.
 * @param {unknown} raw  An object, or a JSON string holding one.
 * @returns {{ok: true, action: object} | {ok: false, errors: string[]}}
 */
export function validateAction(raw) {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length > LIMITS.inputBytes) return { ok: false, errors: ["$: output longer than the limit"] };
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, errors: ["$: output is not valid JSON"] };
    }
  }
  if (!isObject(value)) return { ok: false, errors: ["$: expected an action object"] };
  const errors = check(value, ACTION_SPEC, "action");
  if (errors.length === 0) {
    const shape = SHAPES[value.type];
    for (const key of shape.required) if (value[key] === undefined) errors.push(`action: ${value.type} actions need ${key}`);
    for (const key of Object.keys(value)) {
      if (key === "v" || key === "type" || value[key] === undefined) continue;
      if (!shape.allowed.includes(key)) errors.push(`action: ${key} is not allowed on ${value.type} actions`);
    }
    if (value.type === "tool" && isObject(value.tool?.input)) checkInputData(value.tool.input, "action.tool.input", errors, { bytes: 0 });
    if (value.type === "complete" && value.signature !== undefined && value.signature.trim() === "") errors.push("action.signature: must not be blank");
  }
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 10).map(safeMessage) };
  return { ok: true, action: structuredClone(value) };
}

/** The operation an action performs, without its free-text `reason`: what identifies it for idempotency. */
export function canonicalAction(action) {
  const { reason: _reason, ...rest } = action ?? {};
  return canonicalJson(rest);
}

/**
 * Idempotency key of one action in one attempt: sha256 (hex) of the canonical JSON of
 * `{runId, node, attempt, stepIndex, action}`.
 */
export function actionKey({ runId, node, attempt, stepIndex, action }) {
  return createHash("sha256").update(canonicalJson({ runId, node, attempt, stepIndex, action: JSON.parse(canonicalAction(action)) })).digest("hex");
}

/**
 * Whether re-running an action after a crash is safe BY DEFAULT: reads and whole-file writes only. `edit` is NOT
 * (re-applying a patch on an already patched file is not provably harmless), and neither are commands, git, merge
 * and deploy. The executor is untrusted: the loop lets it only DOWNGRADE this (hints.idempotent === false), never
 * declare an action repeatable (loop.mjs idempotentFor).
 */
export function defaultIdempotent(action) {
  return action?.type === "tool" && ["read", "write"].includes(action.tool?.name);
}

/** Throws a CliError (exit 2) when `executor` does not satisfy the contract. */
export function assertExecutor(executor) {
  if (!isObject(executor) || typeof executor.id !== "string" || typeof executor.observe !== "function" || typeof executor.decide !== "function") {
    throw new CliError("The executor must provide an id, observe() and decide().", { code: "EXECUTOR_INVALID", exitCode: EXIT.USAGE });
  }
  for (const method of ["verify", "describe", "usage"]) {
    if (executor[method] !== undefined && typeof executor[method] !== "function") {
      throw new CliError(`The executor's ${method} must be a function.`, { code: "EXECUTOR_INVALID", exitCode: EXIT.USAGE });
    }
  }
}

/**
 * The default tool dispatcher: SIMULATED, deterministic, side-effect free. It records every call and runs
 * only the functions the caller injects through `effects` (keyed by tool name), e.g. a test writing a
 * marker file through an injected fs. It never starts a process and never touches the disk by itself.
 *
 * @param {{effects?: Record<string, (input: object, ctx: object) => unknown>}} [options]
 */
export function simulatedDispatcher({ effects = {} } = {}) {
  const calls = [];
  return {
    id: "simulated",
    calls,
    async dispatch(action, ctx = {}) {
      const name = action?.tool?.name;
      const input = action?.tool?.input ?? {};
      calls.push({ tool: name, input: structuredClone(input), node: ctx.node ?? null, step: ctx.step ?? null, key: ctx.key ?? null });
      if (typeof ctx.delayMs === "number" && ctx.delayMs > 0 && typeof ctx.sleep === "function") await ctx.sleep(ctx.delayMs, ctx.signal);
      const effect = Object.hasOwn(effects, name) ? effects[name] : undefined;
      if (typeof effect === "function") {
        try {
          const produced = await effect(input, ctx);
          if (produced !== null && typeof produced === "object" && "ok" in produced) return produced;
          return { ok: true, output: typeof produced === "string" ? produced : `simulated ${name}` };
        } catch (error) {
          return { ok: false, error: safeMessage(error?.message ?? error) };
        }
      }
      return { ok: true, output: `simulated ${name}` };
    },
  };
}
