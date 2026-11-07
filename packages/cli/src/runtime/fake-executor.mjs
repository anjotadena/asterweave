// The scripted executor used by the hidden dev path (`run start --executor fake --script <file>`) and
// by the tests. It makes no decisions of its own: it replays a script.
//
//   { "v": 1, "steps": [
//       { "node": "intake",  "action": { ...action v1... } },               an action
//       { "node": "intake",  "action": {...}, "idempotent": false },       ... declared NOT repeatable
//       { "node": "intake",  "action": {...}, "delayMs": 200 },            ... whose tool call takes that long
//       { "node": "intake",  "malformed": "not json" },                    raw output that fails validation
//       { "node": "intake",  "delayMs": 50 } ] }                           a plain wait
//
// Steps are consumed IN ORDER PER NODE across the whole run (attempts included). The position comes from
// the loop (`ctx.step`, derived from the ledger), so a restarted process continues where the previous one
// stopped. When a node has no step left the executor answers `needs-human`.
// Usage is unknown for a script: `usage()` reports `{tokens: null}`, never 0.

import { readFileSync, statSync } from "node:fs";
import { CliError, EXIT } from "../exit-codes.mjs";
import { redactText, sanitizeForTerminal } from "../redact.mjs";
import { parseJsonText, StoreError } from "../store.mjs";
import { ID_PATTERN } from "./graph.mjs";
import { check } from "./schema.mjs";
import { validateAction } from "./executor.mjs";

export const SCRIPT_VERSION = 1;
export const MAX_SCRIPT_STEPS = 5000;
export const MAX_SCRIPT_BYTES = 2_000_000;
const MAX_DELAY_MS = 60_000;

const STEP_SPEC = {
  type: "object",
  required: ["node"],
  additionalProperties: false,
  properties: {
    node: { type: "string", pattern: ID_PATTERN },
    action: { type: "object" },
    malformed: { type: "string", maxLength: 100_000 },
    delayMs: { type: "integer", min: 0, max: MAX_DELAY_MS },
    idempotent: { type: "boolean" },
  },
};
const SCRIPT_SPEC = {
  type: "object",
  required: ["v", "steps"],
  additionalProperties: false,
  properties: { v: { const: SCRIPT_VERSION }, steps: { type: "array", maxItems: MAX_SCRIPT_STEPS, items: STEP_SPEC } },
};

const invalid = (errors) =>
  new CliError(`The fake executor script is invalid: ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? `; and ${errors.length - 5} more` : ""}.`, {
    code: "SCRIPT_INVALID",
    exitCode: EXIT.USAGE,
    remediation: 'A script is {"v":1,"steps":[{"node":"intake","action":{...}}]}.',
  });

/** @returns {string[]} problems (empty when the script is usable). Values are never echoed. */
export function validateScript(script) {
  const errors = check(script, SCRIPT_SPEC, "script").map((message) => redactText(sanitizeForTerminal(message)).text.slice(0, 200));
  if (errors.length > 0) return errors;
  script.steps.forEach((step, index) => {
    const at = `script.steps[${index}]`;
    const kinds = ["action", "malformed"].filter((key) => step[key] !== undefined);
    if (kinds.length > 1) errors.push(`${at}: use either action or malformed, not both`);
    if (kinds.length === 0 && step.delayMs === undefined) errors.push(`${at}: needs an action, a malformed output or a delayMs`);
    if (step.malformed !== undefined && (step.delayMs !== undefined || step.idempotent !== undefined)) errors.push(`${at}: a malformed step takes no delayMs or idempotent`);
    if (step.action === undefined && step.idempotent !== undefined) errors.push(`${at}: idempotent needs an action`);
    if (step.action !== undefined) {
      const verdict = validateAction(step.action);
      if (!verdict.ok) errors.push(...verdict.errors.map((message) => `${at}: ${message}`));
    }
  });
  return errors.slice(0, 20);
}

/**
 * Read and validate a script file.
 * @throws {CliError} SCRIPT_INVALID (exit 2)
 */
export function loadScript(file, { fs = { readFileSync, statSync } } = {}) {
  const unreadable = (detail) => new CliError(`Cannot read the script ${sanitizeForTerminal(String(file))}: ${sanitizeForTerminal(String(detail))}`, { code: "SCRIPT_UNREADABLE", exitCode: EXIT.USAGE });
  let text;
  try {
    // Only a regular file, and only up to the limit IN BYTES, is ever read: a FIFO or a device would block or never
    // end, and a huge file would be read whole before any size check.
    const stat = (fs.statSync ?? statSync)(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > MAX_SCRIPT_BYTES) throw invalid(["script: file is too large"]);
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw unreadable(error?.message ?? error);
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCRIPT_BYTES) throw invalid(["script: file is too large"]);
  let script;
  try {
    script = parseJsonText(text, String(file), null);
  } catch (error) {
    if (error instanceof StoreError) throw invalid(["script: not valid JSON"]);
    throw error;
  }
  const errors = validateScript(script);
  if (errors.length > 0) throw invalid(errors);
  return script;
}

/**
 * @param {{v: 1, steps: object[]}} script
 * @param {{id?: string}} [options]
 */
export function createFakeExecutor(script, { id = "fake" } = {}) {
  const errors = validateScript(script);
  if (errors.length > 0) throw invalid(errors);
  const byNode = new Map();
  for (const step of script.steps) {
    if (!byNode.has(step.node)) byNode.set(step.node, []);
    byNode.get(step.node).push(step);
  }
  const stepFor = (ctx) => byNode.get(ctx?.node)?.[ctx?.step ?? 0];

  return {
    id,
    async observe(ctx) {
      return { goal: ctx.goal, node: ctx.node, attempt: ctx.attempt, step: ctx.step, feedback: ctx.feedback ?? null };
    },
    async decide(ctx) {
      const step = stepFor(ctx);
      if (step === undefined) {
        return { v: 1, type: "complete", outcome: "needs-human", signature: "fake:script-exhausted", reason: "the script has no more steps for this node" };
      }
      if (step.malformed !== undefined) return step.malformed;
      if (step.action === undefined) return { v: 1, type: "wait", ms: step.delayMs, reason: "scripted delay" };
      return structuredClone(step.action);
    },
    describe(ctx) {
      const step = stepFor(ctx);
      if (step === undefined) return {};
      return { ...(step.idempotent === undefined ? {} : { idempotent: step.idempotent }), ...(step.delayMs === undefined ? {} : { delayMs: step.delayMs }) };
    },
    usage() {
      return { tokens: null };
    },
  };
}
