// `asterweave model [show|explain <node>] [--json]`: which model each stage uses and why. Read-only, no network.
//
// The ACTIVE route is the one pinned by the newest run of this repository (a run keeps the route it started with);
// without a pinned run it is the current configuration. `drift` says when the configuration changed after that run
// started. The catalog is static and unverified; auth is "not checked" (nothing here probes a provider).
//
// JSON show:    { ok, active: 'pinned'|'current', runId, routes: [route], pinned: {runId, routing}|null, current, drift, catalog, auth }
// JSON explain: { ok, node, route, active, runId, catalog: entry|null, drift, auth }

import { resolveModelConfig } from "../config.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { listRuns, loadRun } from "../runtime/ledger.mjs";
import { CATALOG, configOfPinned, resolveRoute, routingDrift, routingFromEntries, STAGE_NODES } from "../runtime/routing.mjs";
import { resolveRepo } from "./run.mjs";
import { seams } from "./shared.mjs";

export const modelCommandMeta = Object.freeze({ summary: "Show which model each stage uses and why (read-only)", boolean: ["json"], options: ["json"] });
const USAGE = "Usage: asterweave model [show | explain <node>] [--json]";
const AUTH = "not checked";

/** The newest readable run's pinned routing, or null (no repository, no run, unreadable run). */
async function pinnedRouting(ctx) {
  try {
    const repo = await resolveRepo(ctx);
    const latest = listRuns(repo.key, seams(ctx)).find((item) => item.error === undefined);
    if (!latest) return null;
    const { run } = loadRun(latest.dir, ctx.fs ? { fs: ctx.fs } : {});
    return { runId: run.runId, routing: run.routing ?? null };
  } catch {
    return null;
  }
}

const catalogView = () => Object.values(CATALOG).map((entry) => ({ id: entry.id, family: entry.family, features: { ...entry.features }, effort: [...entry.effort], source: entry.source, availability: entry.availability }));
const entryFor = (model) => (model !== null && Object.hasOwn(CATALOG, model) ? catalogView().find((item) => item.id === model) : null);

function view(ctx, pinned) {
  const current = routingFromEntries(resolveModelConfig(seams(ctx)).entries);
  const pinnedConfig = configOfPinned(pinned?.routing);
  const config = pinnedConfig ?? current;
  return { current, active: pinnedConfig ? "pinned" : "current", runId: pinnedConfig ? pinned.runId : null, config, drift: routingDrift(pinned?.routing, current), routes: STAGE_NODES.map((node) => resolveRoute({ config, node })) };
}

const cell = (value) => (value === null || value === undefined ? "(runner default)" : String(value));
const listCell = (value) => (Array.isArray(value) ? cell(value.length ? value.join(",") : null) : cell(value));

function formatShow(v) {
  const lines = [
    v.active === "pinned" ? `Active route: pinned by run ${v.runId} (a run keeps the route it started with)` : "Active route: current configuration (no run has pinned one)",
    "Model ids come from a static catalog and are unverified; nothing was checked against a provider. Auth: not checked.",
    "",
    ...v.routes.map((r) => `  ${r.node.padEnd(24)} ${cell(r.model).padEnd(20)} ${r.source}${r.effort ? `, effort ${r.effort}` : ""}${r.availability === "unknown-model" ? "  [unknown model]" : ""}`),
    "",
    `Fallback (transient failures only): ${v.config.fallback.length ? v.config.fallback.join(" -> ") : "none"}`,
  ];
  if (v.drift.pinned && !v.drift.drifted) lines.push("", "Configuration matches the pinned route.");
  if (v.drift.drifted) {
    lines.push("", "DRIFT: the configuration changed since the run started. The run keeps its pinned route; changes:");
    for (const c of v.drift.changes) lines.push(`  ${c.key}: pinned ${listCell(c.pinned)}, now ${listCell(c.current)}`);
  }
  return lines;
}

function formatExplain(v, route) {
  const known = entryFor(route.model);
  const catalog = known
    ? `${known.id}, ${known.source}, availability ${known.availability}; features: ${Object.keys(known.features).join(", ")}; effort levels: ${known.effort.join(", ") || "none documented"}`
    : route.model === null
      ? "n/a (the runner chooses)"
      : "not in the static catalog (unknown-model: allowed, not vouched for)";
  const lines = [
    `Stage     ${route.node}`,
    `Model     ${cell(route.model)} (${route.source})`,
    `Why       ${route.reason}`,
    `Effort    ${route.effort ?? "(runner default)"}`,
    `Catalog   ${catalog}`,
    `Fallback  ${route.fallbackChain.length ? route.fallbackChain.join(" -> ") : "none"} (transient failures only: rate-limit, overloaded, timeout, 5xx)`,
    `Auth      ${AUTH}`,
    `Route     ${v.active === "pinned" ? `pinned by run ${v.runId}` : "from the current configuration"}${v.drift.drifted ? "; the configuration has DRIFTED since" : ""}`,
  ];
  for (const warning of route.warnings) lines.push(`Warning   ${warning}`);
  return lines;
}

/** Handler for `asterweave model ...`. */
export async function modelCommand(ctx) {
  const [sub = "show", ...rest] = ctx.positionals ?? [];
  if (sub !== "show" && sub !== "explain") throw new UsageError(`Unknown model subcommand '${sanitizeForTerminal(sub).slice(0, 40)}'.`, { remediation: USAGE });
  if (sub === "show" && rest.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(rest[0]).slice(0, 40)}'.`, { remediation: USAGE });
  if (sub === "explain" && rest.length !== 1) throw new UsageError(rest.length === 0 ? "model explain needs a node." : `Unexpected argument '${sanitizeForTerminal(rest[1]).slice(0, 40)}'.`, { remediation: `${USAGE} Nodes: ${STAGE_NODES.join(", ")}` });
  if (sub === "explain" && !STAGE_NODES.includes(rest[0])) throw new CliError(`Unknown stage '${sanitizeForTerminal(rest[0]).slice(0, 40)}'.`, { code: "MODEL_NODE_UNKNOWN", exitCode: EXIT.USAGE, remediation: `Stages: ${STAGE_NODES.join(", ")}` });
  const pinned = await pinnedRouting(ctx);
  const v = view(ctx, pinned);
  const json = ctx.options?.json === true;
  if (sub === "show") {
    if (json) ctx.stdout.write(`${stringifyJson({ ok: true, active: v.active, runId: v.runId, routes: v.routes, pinned: pinned?.routing ? { runId: pinned.runId, routing: pinned.routing } : null, current: v.current, drift: v.drift, catalog: catalogView(), auth: AUTH })}\n`);
    else ctx.stdout.write(`${sanitizeLines(formatShow(v))}\n`);
    return EXIT.OK;
  }
  const route = v.routes.find((candidate) => candidate.node === rest[0]);
  if (json) ctx.stdout.write(`${stringifyJson({ ok: true, node: route.node, route, active: v.active, runId: v.runId, catalog: entryFor(route.model), drift: v.drift, auth: AUTH })}\n`);
  else ctx.stdout.write(`${sanitizeLines(formatExplain(v, route))}\n`);
  return EXIT.OK;
}
