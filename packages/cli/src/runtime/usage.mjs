// Usage accounting: the `usage` ledger event, its validation, and the pure aggregation used by budgets and by
// `asterweave usage`. Nothing here calls a model or touches the disk.
//
// A usage event (one per executor report that measured something):
//   { type: "usage", node, attempt, source: "executor"|"tool"|"mcp",
//     inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextTokens, tokens, model? }
// Every counter is a non-negative integer or null. null means UNKNOWN and is never turned into 0 and never added to a
// known number. `tokens` is the total when an executor reports only a total (the pre-Phase-C `{tokens}` shape);
// otherwise the event total is inputTokens + outputTokens over whichever of the two were measured.
//
// Three numbers are kept apart on purpose and never merged:
//   contextTokens   the latest measured size of the working context (a gauge, not a sum)
//   cumulative      the sum per counter over the events (null while a counter was never measured)
//   remaining       limit - used, or null when there is no limit or the usage is unknown

import { MODEL_ID_PATTERN } from "./routing.mjs";

export const USAGE_SOURCES = Object.freeze(["executor", "tool", "mcp"]);
/** Counters that are summed. */
export const SUM_COUNTERS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]);
/** Every numeric field of a usage report. */
export const REPORT_COUNTERS = Object.freeze([...SUM_COUNTERS, "contextTokens", "tokens"]);
export const MAX_COUNTER = 1e12;
export const UNKNOWN_MODEL = "unknown";

const REPORT_KEYS = new Set([...REPORT_COUNTERS, "model"]);
const EVENT_KEYS = new Set(["v", "seq", "at", "runId", "type", "node", "attempt", "source", "used", "tx", ...REPORT_KEYS]);
const NODE_ID = /^[a-z][a-z0-9-]{0,39}$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCounter = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_COUNTER;

function checkReport(raw, allowed, problems) {
  for (const key of Object.keys(raw)) if (!allowed.has(key)) problems.push(`usage.${/^[A-Za-z]{1,24}$/.test(key) ? key : "<field>"}: unexpected field`);
  for (const key of REPORT_COUNTERS) {
    const value = raw[key];
    if (value !== undefined && value !== null && !isCounter(value)) problems.push(`usage.${key}: must be a non-negative integer (at most ${MAX_COUNTER}) or null`);
  }
  if (raw.model !== undefined && raw.model !== null && !(typeof raw.model === "string" && MODEL_ID_PATTERN.test(raw.model))) problems.push("usage.model: not a valid model id");
}

/**
 * Validate what an executor's `usage(ctx)` returned. Unknown fields are rejected, counters are bounded, values are
 * never echoed.
 * @returns {{ok: true, report: object} | {ok: false, errors: string[]}}
 */
export function normalizeUsageReport(raw) {
  if (!isObject(raw)) return { ok: false, errors: ["usage: expected an object"] };
  const problems = [];
  checkReport(raw, REPORT_KEYS, problems);
  if (problems.length > 0) return { ok: false, errors: problems.slice(0, 10) };
  const report = {};
  for (const key of REPORT_COUNTERS) report[key] = raw[key] ?? null;
  report.model = raw.model ?? null;
  return { ok: true, report };
}

/** Whether a normalized report measured at least one counter (otherwise there is nothing to record). */
export function hasMeasurement(report) {
  return REPORT_COUNTERS.some((key) => report?.[key] !== null && report?.[key] !== undefined);
}

/** The `usage` ledger record for a report, or null when nothing was measured. */
export function buildUsageEvent({ node, attempt, source = "executor", report }) {
  if (!hasMeasurement(report)) return null;
  return { type: "usage", node, attempt, source, ...Object.fromEntries(REPORT_COUNTERS.map((key) => [key, report[key] ?? null])), model: report.model ?? null };
}

/** Validate a stored usage event (reading a ledger): same rules, plus the event envelope. */
export function validateUsageEvent(event) {
  if (!isObject(event) || event.type !== "usage") return ["usage: not a usage event"];
  const problems = [];
  checkReport(event, EVENT_KEYS, problems);
  if (typeof event.node !== "string" || !NODE_ID.test(event.node)) problems.push("usage.node: invalid node id");
  if (event.attempt !== null && event.attempt !== undefined && !(Number.isInteger(event.attempt) && event.attempt >= 0)) problems.push("usage.attempt: invalid");
  if (!USAGE_SOURCES.includes(event.source)) problems.push("usage.source: invalid");
  return problems;
}

/**
 * The tokens an event adds to the cumulative total (the counter that budgets use): the reported `tokens` total, else
 * the sum of whichever of inputTokens / outputTokens were measured, else null (unknown, adds nothing).
 */
export function eventTotal(event) {
  if (isCounter(event?.tokens)) return event.tokens;
  const parts = [event?.inputTokens, event?.outputTokens].filter(isCounter);
  return parts.length === 0 ? null : parts.reduce((sum, part) => sum + part, 0);
}

const addKnown = (sum, value) => (isCounter(value) ? (sum ?? 0) + value : sum);

function emptyBucket() {
  return { events: 0, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, tokens: null };
}

function addTo(bucket, event) {
  bucket.events += 1;
  for (const key of SUM_COUNTERS) bucket[key] = addKnown(bucket[key], event[key]);
  const total = eventTotal(event);
  if (total !== null) bucket.tokens = (bucket.tokens ?? 0) + total;
}

/**
 * Aggregate the usage events of a ledger. Malformed usage events are skipped and counted in `skipped`.
 * `byNode` / `byModel` are prototype-less maps; events without a model go to "unknown".
 * @param {object[]} events
 * @returns {{totals: object, byNode: object, byModel: object, context: object|null, skipped: number}}
 */
export function aggregateUsage(events) {
  const totals = emptyBucket();
  const byNode = Object.create(null);
  const byModel = Object.create(null);
  let context = null;
  let skipped = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== "usage") continue;
    if (validateUsageEvent(event).length > 0) {
      skipped += 1;
      continue;
    }
    addTo(totals, event);
    addTo((byNode[event.node] ??= emptyBucket()), event);
    addTo((byModel[event.model ?? UNKNOWN_MODEL] ??= emptyBucket()), event);
    if (isCounter(event.contextTokens)) context = { tokens: event.contextTokens, node: event.node, model: event.model ?? null, at: typeof event.at === "string" ? event.at : null };
  }
  return { totals, byNode, byModel, context, skipped };
}

/** limit - used, never below 0; null when there is no limit (0 / null = unlimited) or the usage is unknown. */
export function remaining(limit, used) {
  if (!Number.isFinite(limit) || limit <= 0 || !isCounter(used)) return null;
  return Math.max(0, limit - used);
}

/** One budget line: { used, limit, remaining }; `limit` is null when unlimited, `used` null when unknown. */
export function budgetLine(used, limit) {
  const hasLimit = Number.isFinite(limit) && limit > 0;
  return { used: isCounter(used) ? used : null, limit: hasLimit ? limit : null, remaining: remaining(limit, used) };
}

/** Per-node tool-call counts from the `action.started` events (a call that started counts, finished or not). */
export function toolCallsByNode(events) {
  const counts = Object.create(null);
  for (const event of Array.isArray(events) ? events : []) {
    if ((event?.type === "action.started" || event?.type === "tool.observed") && typeof event.node === "string") counts[event.node] = (counts[event.node] ?? 0) + 1;
  }
  return counts;
}

/** Whether the ledger holds a measured token total (so a 0 counter in the snapshot is a real 0, not "unknown"). */
export function hasMeasuredTotal(events) {
  return (Array.isArray(events) ? events : []).some((event) => event?.type === "usage" && eventTotal(event) !== null);
}
