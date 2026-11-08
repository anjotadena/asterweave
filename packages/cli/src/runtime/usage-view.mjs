// The accounting view behind `asterweave context` and the TUI /context: PURE (no disk, no model, no clock).
//
// Three numbers, never merged:
//   contextTokens   the latest MEASURED size of the working context (a gauge, not a sum); null = unknown
//   cumulative      the sums per counter over the measured usage reports (null per counter nobody measured)
//   budget          limit - used per budget (remaining null when there is no limit or the usage is unknown)
// Nothing is estimated: a value no executor reported is null here and "unknown" in text, never 0.
//
// The context window comes ONLY from a static catalog entry that documents one (`contextWindow`, a positive integer);
// the shipped catalog documents none, so the window and the percent used are unknown. UNVERIFIED: whether the runner
// reports a context size at all, and what the window of any model is.

import { sanitizeForTerminal } from "../redact.mjs";
import { CATALOG } from "./routing.mjs";

export const CONTEXT_VIEW_VERSION = 1;
const COUNTERS = Object.freeze(["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"]);
const MAX_ITEMS = 50;
const MAX_NODES = 40;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= 1e12;
const known = (value) => (isCount(value) ? value : null);
const text = (value, max = 80) => (typeof value === "string" && value !== "" ? sanitizeForTerminal(value).slice(0, max) : null);

function bucketView(bucket) {
  return {
    events: isCount(bucket?.events) ? bucket.events : 0,
    inputTokens: known(bucket?.inputTokens),
    outputTokens: known(bucket?.outputTokens),
    cacheReadTokens: known(bucket?.cacheReadTokens),
    cacheCreationTokens: known(bucket?.cacheCreationTokens),
    tokens: known(bucket?.tokens),
  };
}

function budgetView(line) {
  const limit = Number.isFinite(line?.limit) && line.limit > 0 ? line.limit : null;
  return { used: known(line?.used), limit, remaining: limit === null ? null : known(line?.remaining) };
}

/** The context window of a model, only when the static catalog documents one. */
export function contextWindowOf(model, catalog = CATALOG) {
  if (typeof model !== "string" || !Object.hasOwn(catalog, model)) return null;
  const value = catalog[model]?.contextWindow;
  return Number.isInteger(value) && value > 0 ? value : null;
}

function attachmentsView(list) {
  const items = (Array.isArray(list) ? list : []).filter(isObject).slice(0, MAX_ITEMS).map((item) => ({
    id: text(item.id, 40),
    name: text(item.name, 80),
    format: text(item.format, 12),
    bytes: known(item.bytes),
    width: known(item.width),
    height: known(item.height),
    sha256: typeof item.sha256 === "string" && /^[0-9a-f]{64}$/.test(item.sha256) ? item.sha256 : null,
    sentRunId: text(item.sentRunId, 64), // null = staged, not sent yet; a run id = already sent with that run's first turn
  }));
  const total = (rows) => (rows.length === 0 ? 0 : rows.every((row) => row.bytes !== null) ? rows.reduce((sum, row) => sum + row.bytes, 0) : null);
  const ok = Array.isArray(list);
  const staged = items.filter((item) => item.sentRunId === null);
  return {
    count: ok ? list.length : null,
    staged: ok ? list.filter((item) => !isObject(item) || text(item.sentRunId, 64) === null).length : null,
    sent: ok ? list.filter((item) => isObject(item) && text(item.sentRunId, 64) !== null).length : null,
    bytes: ok ? total(items) : null,
    stagedBytes: ok ? total(staged) : null,
    sentOn: "first-turn",
    note: "Staged images are sent once, with the first turn of a run started by asterweave run start --session <id>; images already sent are not sent again.",
    items,
  };
}

function routeView(route) {
  if (!isObject(route)) return { model: null, effort: null, source: null, pinned: false, drifted: false, changes: [] };
  const drift = isObject(route.drift) ? route.drift : {};
  return {
    model: text(route.model, 64),
    effort: text(route.effort, 16),
    source: text(route.source, 24),
    pinned: route.pinned === true || drift.pinned === true,
    drifted: drift.drifted === true,
    changes: (Array.isArray(drift.changes) ? drift.changes : []).slice(0, 20).map((change) => ({ key: text(change?.key, 40), pinned: text(String(change?.pinned ?? ""), 80), current: text(String(change?.current ?? ""), 80) })),
  };
}

/**
 * Build the accounting view.
 * @param {{run?: object|null, session?: object|null, usageReport?: object|null, route?: object|null, attachments?: object[], policy?: object|null, catalog?: object}} input
 *   `usageReport` is commands/usage.mjs `buildUsageReport(...)`; `route` is `{model, effort, source, pinned, drift}`;
 *   `policy` is `{mode, hash}` (shown, never interpreted). All optional: a missing source gives unknown values.
 */
export function buildAccountingView({ run = null, session = null, usageReport = null, route = null, attachments = [], policy = null, catalog = CATALOG } = {}) {
  const report = isObject(usageReport) ? usageReport : null;
  const totals = report?.totals ?? {};
  const context = report?.context ?? {};
  const contextTokens = known(context.tokens);
  const routed = routeView(route);
  const windowModel = text(context.model, 64) ?? routed.model;
  const windowTokens = contextWindowOf(windowModel, catalog);
  const budgets = report?.budgets ?? {};
  const nodes = Object.entries(report?.byNode ?? {}).slice(0, MAX_NODES);
  const models = Object.entries(report?.byModel ?? {}).slice(0, MAX_NODES);
  const sums = Object.fromEntries(COUNTERS.map((key) => [key, known(totals[key])]));
  return {
    version: CONTEXT_VIEW_VERSION,
    source: run ? "run" : session ? "session" : "none",
    runId: text(run?.runId, 64),
    sessionId: text(session?.id, 64),
    title: text(session?.title, 120),
    status: text(run?.status ?? session?.status, 24),
    contextTokens: { tokens: contextTokens, measured: contextTokens !== null, node: text(context.node, 40), model: text(context.model, 64), at: text(context.at, 40) },
    window: { tokens: windowTokens, model: windowModel, source: windowTokens === null ? null : "static-catalog" },
    percentUsed: contextTokens !== null && windowTokens !== null ? Math.round((contextTokens / windowTokens) * 1000) / 10 : null,
    cumulative: { ...sums, tokens: known(totals.tokens), events: isCount(totals.events) ? totals.events : 0, skipped: isCount(totals.skipped) ? totals.skipped : 0 },
    counters: Object.fromEntries([...COUNTERS, "tokens"].map((key) => [key, (key === "tokens" ? known(totals.tokens) : sums[key]) === null ? "unknown" : "measured"])),
    budget: { tokens: budgetView(budgets.run?.tokens), toolCalls: budgetView(budgets.run?.toolCalls), iterations: budgetView(budgets.run?.iterations), wallMs: budgetView(budgets.run?.wallMs) },
    byNode: Object.fromEntries(nodes.map(([id, bucket]) => [text(id, 40) ?? "?", { ...bucketView(bucket), toolCalls: isCount(bucket?.toolCalls) ? bucket.toolCalls : 0 }])),
    byModel: Object.fromEntries(models.map(([id, bucket]) => [text(id, 64) ?? "?", bucketView(bucket)])),
    attachments: attachmentsView(attachments),
    route: routed,
    policy: isObject(policy) ? { mode: text(policy.mode, 24), hash: text(policy.hash, 80) } : null,
  };
}

const num = (value) => (value === null || value === undefined ? "unknown" : String(value));
const measured = (value) => (value === null || value === undefined ? "unknown" : `${value} (measured)`);
const size = (bytes) => (bytes === null || bytes === undefined ? "unknown size" : bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`);

function budgetLine(label, line) {
  const used = num(line.used);
  const limit = line.limit === null ? "" : ` / ${line.limit}`;
  let tail;
  if (line.limit === null) tail = "no limit";
  else if (line.remaining === null) tail = "remaining unknown";
  else tail = line.remaining === 0 ? "0 remaining (EXHAUSTED)" : `${line.remaining} remaining`;
  return `  ${label.padEnd(11)} ${used}${limit}, ${tail}`;
}

/** "1 staged (2.0 KiB), 1 sent": staged images go out with the first turn of a run, sent ones never again. */
function attachmentSummary(view) {
  return `${view.staged} staged${view.staged === 0 ? "" : ` (${size(view.stagedBytes)})`}, ${view.sent} sent`;
}

/** One staged image per line: hashes and sizes only (the caller sanitises the lines). */
export function formatAttachmentLines(view) {
  const items = view.items ?? [];
  if (items.length === 0) return ["  none staged"];
  return items.map((item) => `  ${item.id ?? "?"}  ${item.sentRunId ? `sent by ${item.sentRunId}` : "staged"}  ${item.name ?? "?"}  ${item.format ?? "?"}  ${size(item.bytes)}  ${item.width !== null && item.height !== null ? `${item.width}x${item.height}` : "unknown dimensions"}  sha256 ${item.sha256 ? item.sha256.slice(0, 12) : "unknown"}`);
}

/** Text form of the view. */
export function formatAccounting(view) {
  const c = view.contextTokens;
  const u = view.cumulative;
  const where = view.source === "none" ? "no run yet" : view.source === "run" ? `run ${view.runId}${view.sessionId ? ` (session ${view.sessionId})` : ""}` : `session ${view.sessionId} (no run linked)`;
  const out = [`Context and usage: ${where}${view.title ? ` - ${view.title}` : ""}${view.status ? ` [${view.status}]` : ""}`];
  if (view.source === "none") out.push("  Nothing has been measured: every value below is unknown, not 0.");
  out.push(
    "",
    "1. Context size (latest measured working context, not a sum)",
    `  ${c.tokens === null ? "unknown" : `${c.tokens} tokens${c.node ? ` at ${c.node}` : ""}${c.model ? ` (${c.model})` : ""} (measured)`}`,
    `  window   ${view.window.tokens === null ? `unknown (the static catalog documents none${view.window.model ? ` for ${view.window.model}` : ""})` : `${view.window.tokens} tokens (static catalog)`}`,
    `  used     ${view.percentUsed === null ? "unknown (needs a measured context size and a documented window)" : `${view.percentUsed}%`}`,
    "",
    "2. Cumulative usage (sum of measured reports; not the context size)",
    `  input tokens            ${measured(u.inputTokens)}`,
    `  output tokens           ${measured(u.outputTokens)}`,
    `  cache read tokens       ${measured(u.cacheReadTokens)}`,
    `  cache creation tokens   ${measured(u.cacheCreationTokens)}`,
    `  total (budget counter)  ${measured(u.tokens)}`,
    "",
    "3. Budget remaining (limit - used)",
    budgetLine("tokens", view.budget.tokens),
    budgetLine("tool calls", view.budget.toolCalls),
    budgetLine("iterations", view.budget.iterations),
    budgetLine("wall ms", view.budget.wallMs),
    "",
    "By node",
  );
  const nodes = Object.entries(view.byNode);
  if (nodes.length === 0) out.push("  no usage recorded");
  for (const [id, b] of nodes) out.push(`  ${id}  total ${num(b.tokens)}  in ${num(b.inputTokens)}  out ${num(b.outputTokens)}  tool calls ${b.toolCalls}`);
  out.push("", "By model");
  const models = Object.entries(view.byModel);
  if (models.length === 0) out.push("  no usage recorded");
  for (const [id, b] of models) out.push(`  ${id}  total ${num(b.tokens)}  in ${num(b.inputTokens)}  out ${num(b.outputTokens)}`);
  if (view.attachments.count === null) out.push("", "Attachments: unknown (the attachment store could not be read)");
  else out.push("", `Attachments: ${attachmentSummary(view.attachments)}`, `  ${view.attachments.note}`, ...formatAttachmentLines(view.attachments));
  const r = view.route;
  out.push("", `Route: ${r.model ?? "(runner default)"}${r.effort ? `, effort ${r.effort}` : ""}${r.source ? ` (${r.source})` : ""}${r.pinned ? ", pinned by the run" : ", current configuration"}`);
  if (r.drifted) {
    out.push("  DRIFT: the configuration changed since the run started; the run keeps its pinned route.");
    for (const change of r.changes) out.push(`    ${change.key}: pinned ${change.pinned || "(none)"}, now ${change.current || "(none)"}`);
  }
  if (view.policy) out.push(`Policy: ${view.policy.mode ?? "unknown"}${view.policy.hash ? ` ${view.policy.hash.slice(0, 16)}` : ""}`);
  out.push("", "Counters are measured only when an executor reported them; nothing is estimated.");
  if (u.skipped > 0) out.push(`${u.skipped} malformed usage event(s) were ignored.`);
  return out;
}

const budgetShort = (label, line) => {
  const limit = line.limit === null ? "" : `/${line.limit}`;
  const tail = line.limit === null ? "no limit" : line.remaining === null ? "remaining unknown" : line.remaining === 0 ? "0 left, EXHAUSTED" : `${line.remaining} left`;
  return `${label} ${num(line.used)}${limit} (${tail})`;
};

const where = (view) => (view.source === "none" ? "no run yet" : view.source === "run" ? `run ${view.runId}${view.sessionId ? ` (session ${view.sessionId})` : ""}` : `session ${view.sessionId} (no run linked)`);

/** The same three numbers in ten lines or fewer, for the interactive session (the full text is `asterweave context`). */
export function formatAccountingCompact(view) {
  const c = view.contextTokens;
  const u = view.cumulative;
  const r = view.route;
  const out = [`Context and usage: ${where(view)}${view.status ? ` [${view.status}]` : ""}`];
  if (view.source === "none") out.push("  Nothing has been measured: every value is unknown, not 0.");
  out.push(
    `Context size: ${c.tokens === null ? "unknown" : `${c.tokens} tokens${c.node ? ` at ${c.node}` : ""} (measured, latest, not a sum)`}`,
    `  window ${view.window.tokens === null ? "unknown (none documented)" : `${view.window.tokens} (static catalog)`}, used ${view.percentUsed === null ? "unknown" : `${view.percentUsed}%`}`,
    `Cumulative usage: in ${num(u.inputTokens)}, out ${num(u.outputTokens)}, cache read ${num(u.cacheReadTokens)}, cache creation ${num(u.cacheCreationTokens)}, total ${num(u.tokens)}`,
    `Budget remaining: ${budgetShort("tokens", view.budget.tokens)}; ${budgetShort("tool calls", view.budget.toolCalls)}; ${budgetShort("iterations", view.budget.iterations)}`,
    view.attachments.count === null ? "Attachments: unknown" : `Attachments: ${attachmentSummary(view.attachments)}${view.attachments.staged > 0 ? "; staged images go out with: asterweave run start --session <id>" : ""}`,
    `Route: ${r.model ?? "(runner default)"}${r.effort ? `, effort ${r.effort}` : ""}${r.drifted ? ", DRIFTED since the run started" : ""}`,
    "Full report: asterweave context",
  );
  return out;
}

/** Per-counter, per-node and per-model usage in about a dozen lines, for the interactive session. */
export function formatUsageCompact(view) {
  const u = view.cumulative;
  const out = [`Usage of ${where(view)} (measured only; unknown is not 0)`];
  if (view.source === "none") return [...out, "  Nothing has been measured yet."];
  out.push(
    `  input ${measured(u.inputTokens)}, output ${measured(u.outputTokens)}`,
    `  cache read ${measured(u.cacheReadTokens)}, cache creation ${measured(u.cacheCreationTokens)}`,
    `  total (budget counter) ${measured(u.tokens)}`,
    `  context size ${view.contextTokens.tokens === null ? "unknown" : `${view.contextTokens.tokens} (latest measured, not a sum)`}`,
  );
  const nodes = Object.entries(view.byNode);
  out.push(nodes.length === 0 ? "  nodes: no usage recorded" : `  nodes: ${nodes.slice(0, 6).map(([id, b]) => `${id} ${num(b.tokens)}`).join(" · ")}${nodes.length > 6 ? ` · +${nodes.length - 6} more` : ""}`);
  const models = Object.entries(view.byModel);
  out.push(models.length === 0 ? "  models: no usage recorded" : `  models: ${models.slice(0, 6).map(([id, b]) => `${id} ${num(b.tokens)}`).join(" · ")}${models.length > 6 ? ` · +${models.length - 6} more` : ""}`);
  out.push(`  budget: ${budgetShort("tokens", view.budget.tokens)}; ${budgetShort("tool calls", view.budget.toolCalls)}`, "Full report: asterweave usage");
  return out;
}
