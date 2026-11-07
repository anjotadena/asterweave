// `asterweave usage [runId] [--json]`: what a run has used, what it may still use. Read-only and offline: it takes no run
// lock (a run being written is fine: complete events are read, a torn tail is ignored) and never calls a model.
//
// Three numbers are shown separately and never merged: the context size (the latest measured working context), the
// cumulative usage (sum per counter) and the budget remaining (limit - used, or "no limit"). A counter nobody measured
// is "unknown" (null in JSON), never 0 and never added to a known number.
//
// JSON: { ok: true, runId, usage: { totals, byNode, byModel, context, budgets } }
//   totals / byNode[node] / byModel[model]: { events, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, tokens }
//     (null = unknown; byNode also has toolCalls); totals also has skipped (malformed usage events ignored)
//   context: { tokens, node, model, at } (tokens null = unknown)
//   budgets: { run: { tokens, toolCalls, iterations, wallMs: { used, limit, remaining } },
//              perNode: { limits: { tokens, toolCalls, iterations }, nodes: { [node]: { tokens, toolCalls } } } }

import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { listRuns, loadRun, runDir } from "../runtime/ledger.mjs";
import { DEFAULT_BUDGETS, loadPolicy, resolveBudgets, resolveNodeBudgets } from "../runtime/policy.mjs";
import { aggregateUsage, budgetLine, toolCallsByNode } from "../runtime/usage.mjs";
import { resolveRepo } from "./run.mjs";
import { seams } from "./shared.mjs";

export const usageCommandMeta = Object.freeze({ summary: "Show token usage and budgets of a run (read-only)", boolean: ["json"], options: ["json"] });
const USAGE = "Usage: asterweave usage [runId] [--json]";

function limitsOf(ctx) {
  try {
    const { policy } = loadPolicy(seams(ctx));
    return { run: resolveBudgets(policy), node: resolveNodeBudgets(policy) };
  } catch {
    return { run: { ...DEFAULT_BUDGETS }, node: {} };
  }
}

/** The stable usage report for a loaded run (pure). */
export function buildUsageReport({ run, events, limits }) {
  const agg = aggregateUsage(events);
  const used = run.budgets?.used ?? {};
  const calls = toolCallsByNode(events);
  // A snapshot token counter above 0 with no usage events is a run from before the usage ledger: still a measured number.
  // A run can mix both (usage before the ledger existed, then events): never under-report, take the larger known number.
  const known = [agg.totals.tokens, typeof used.tokens === "number" && used.tokens > 0 ? used.tokens : null].filter((value) => value !== null);
  const tokensUsed = known.length === 0 ? null : Math.max(...known);
  const nodes = {};
  for (const id of Object.keys(run.nodes ?? {})) {
    const tokens = agg.byNode[id]?.tokens ?? null;
    const toolCalls = calls[id] ?? 0;
    if (tokens !== null || toolCalls > 0) nodes[id] = { tokens: budgetLine(tokens, limits.node.tokens), toolCalls: budgetLine(toolCalls, limits.node.toolCalls) };
  }
  return {
    totals: { ...agg.totals, tokens: tokensUsed, skipped: agg.skipped },
    byNode: Object.fromEntries(Object.entries(agg.byNode).map(([id, bucket]) => [id, { ...bucket, toolCalls: calls[id] ?? 0 }])),
    byModel: { ...agg.byModel },
    context: agg.context ?? { tokens: null, node: null, model: null, at: null },
    budgets: {
      run: {
        tokens: budgetLine(tokensUsed, limits.run.tokens),
        toolCalls: budgetLine(used.toolCalls ?? 0, limits.run.toolCalls),
        iterations: budgetLine(used.iterations ?? 0, limits.run.iterations),
        wallMs: budgetLine(used.wallMs ?? 0, limits.run.wallMs),
      },
      perNode: { limits: { tokens: limits.node.tokens ?? null, toolCalls: limits.node.toolCalls ?? null, iterations: limits.node.iterations ?? null }, nodes },
    },
  };
}

const num = (value) => (value === null || value === undefined ? "unknown" : String(value));
const label = (value) => (value === null || value === undefined ? "unknown" : `${value} (measured)`);
const line = (budget) => `${num(budget.used)}${budget.limit ? ` / ${budget.limit}` : ""}, ${budget.remaining === null ? (budget.limit ? "remaining unknown" : "no limit") : `${budget.remaining} remaining`}`;

/** Text form of the report (the caller sanitises every line). */
export function formatUsage(runId, usage) {
  const t = usage.totals;
  const out = [
    `Run ${runId}`,
    "",
    "Cumulative usage",
    `  input tokens            ${label(t.inputTokens)}`,
    `  output tokens           ${label(t.outputTokens)}`,
    `  cache read tokens       ${label(t.cacheReadTokens)}`,
    `  cache creation tokens   ${label(t.cacheCreationTokens)}`,
    `  total (budget counter)  ${label(t.tokens)}`,
    "",
    "Context size (latest measured, not a sum)",
    `  ${usage.context.tokens === null ? "unknown" : `${usage.context.tokens} tokens at ${usage.context.node}${usage.context.model ? ` (${usage.context.model})` : ""} (measured)`}`,
    "",
    "By node",
  ];
  const nodes = Object.entries(usage.byNode);
  if (nodes.length === 0) out.push("  no usage recorded");
  for (const [id, b] of nodes) out.push(`  ${id}  total ${num(b.tokens)}  in ${num(b.inputTokens)}  out ${num(b.outputTokens)}  tool calls ${b.toolCalls}`);
  out.push("", "By model");
  const models = Object.entries(usage.byModel);
  if (models.length === 0) out.push("  no usage recorded");
  for (const [id, b] of models) out.push(`  ${id}  total ${num(b.tokens)}  in ${num(b.inputTokens)}  out ${num(b.outputTokens)}`);
  const r = usage.budgets.run;
  out.push("", "Budgets remaining", `  tokens      ${line(r.tokens)}`, `  tool calls  ${line(r.toolCalls)}`, `  iterations  ${line(r.iterations)} (this attempt)`);
  const per = usage.budgets.perNode;
  const set = Object.entries(per.limits).filter(([, limit]) => limit);
  if (set.length > 0) {
    out.push(`  per node limits: ${set.map(([key, limit]) => `${key} ${limit}`).join(", ")}`);
    for (const [id, n] of Object.entries(per.nodes)) out.push(`    ${id}  tokens ${line(n.tokens)}; tool calls ${line(n.toolCalls)}`);
  }
  if (t.skipped > 0) out.push("", `${t.skipped} malformed usage event(s) were ignored.`);
  return out;
}

/** Handler for `asterweave usage [runId]`. */
export async function usageCommand(ctx) {
  const [runId, ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation: USAGE });
  const repo = await resolveRepo(ctx);
  const options = seams(ctx);
  let dir;
  if (runId !== undefined) dir = runDir(repo.key, runId, options);
  else {
    const latest = listRuns(repo.key, options).find((item) => item.error === undefined);
    if (!latest) throw new CliError("There are no runs for this repository.", { code: "RUN_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Runs are kept per repository; run this command from inside the repository the run belongs to." });
    dir = latest.dir;
  }
  const loaded = loadRun(dir, ctx.fs ? { fs: ctx.fs } : {});
  const usage = buildUsageReport({ run: loaded.run, events: loaded.events, limits: limitsOf(ctx) });
  if (ctx.options?.json === true) ctx.stdout.write(`${stringifyJson({ ok: true, runId: loaded.run.runId, usage })}\n`);
  else ctx.stdout.write(`${sanitizeLines(formatUsage(loaded.run.runId, usage))}\n`);
  return EXIT.OK;
}
