// `asterweave context [runId | --session id] [--json]`: the accounting view of a run (read-only, offline, no model call).
// Three numbers stay separate: the context size (latest measured working context), the cumulative usage (sum per counter)
// and the budget remaining (limit - used). A value nobody measured is "unknown" (null in JSON), never 0.
//
// JSON: { ok: true, context: { version, source, runId, sessionId, title, status, contextTokens, window, percentUsed,
//   cumulative, counters, budget, byNode, byModel, attachments, route, policy } }   (see runtime/usage-view.mjs)
//
// This module also builds the read-only views the interactive session shows for /context, /usage, /attachments and
// /image (`createSessionViews`). The attachment store belongs to runtime/attachments.mjs; it is imported lazily and every
// caller treats its absence as "unknown", so the views work without it.

import { resolveModelConfig } from "../config.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { listRuns, loadRun, runDir } from "../runtime/ledger.mjs";
import { loadPolicy } from "../runtime/policy.mjs";
import { configOfPinned, resolveRoute, routingDrift, routingFromEntries } from "../runtime/routing.mjs";
import { listSessions, loadSession } from "../runtime/sessions.mjs";
import { buildAccountingView, formatAccounting, formatAccountingCompact, formatAttachmentLines, formatUsageCompact } from "../runtime/usage-view.mjs";
import { resolveRepo } from "./run.mjs";
import { seams } from "./shared.mjs";
import { listTraces, traceTotals } from "../runtime/memory/context.mjs";
import { openMemory } from "../runtime/memory/db.mjs";
import { existingOwner } from "../runtime/memory/sessions.mjs";
import { buildUsageReport, limitsOf } from "./usage.mjs";

export const contextCommandMeta = Object.freeze({ summary: "Show context size, cumulative usage and budgets of a run (read-only)", boolean: ["json"], options: ["json", "session"] });
const USAGE = "Usage: asterweave context [runId | --session <id>] [--json]";

export const contextHelpText = `${[
  "asterweave context - context size, cumulative usage and budgets of a run (read-only)",
  "",
  USAGE,
  "",
  "Three separate numbers: the latest MEASURED context size (not a sum), the cumulative usage (sum of measured",
  "counters) and the budget remaining (limit - used). A value nobody measured is 'unknown' (null in JSON), never 0.",
  "The context window and the percent used are shown only when the static model catalog documents a window.",
  "Also shows per-node and per-model usage, staged image attachments (count, bytes; sent once, with the first",
  "turn) and the route with its drift. Without arguments: the newest run of this repository. Makes no model call.",
  "",
  'JSON: {"ok":true,"context":{"contextTokens","window","percentUsed","cumulative","counters","budget","byNode","byModel","attachments","route"}}',
  "",
  "Exit codes: 0 ok · 1 run or session not found or unreadable · 2 usage",
].join("\n")}\n`;

/** The attachment store (Track I), or null when this build does not have it. `ctx.attachmentsApi` is the test seam. */
export async function loadAttachmentsApi(ctx) {
  if (ctx?.attachmentsApi) return ctx.attachmentsApi;
  try {
    const module = await import("../runtime/attachments.mjs");
    return typeof module.listAttachments === "function" ? module : null;
  } catch {
    return null;
  }
}

const asList = (value) => (Array.isArray(value) ? value : Array.isArray(value?.attachments) ? value.attachments : null);

/** Staged attachments of a session: a list, or null when unknown (no store, no session, unreadable). */
async function attachmentsOf(ctx, api, repoKey, sessionId) {
  if (!api || !sessionId) return sessionId ? null : [];
  try {
    return asList(await api.listAttachments(sessionId, { repoKey, ...seams(ctx) }));
  } catch {
    return null;
  }
}

function routeOf(ctx, run) {
  let current = null;
  try {
    current = routingFromEntries(resolveModelConfig(seams(ctx)).entries);
  } catch {
    // an invalid configuration leaves the current route unknown; a pinned route still shows
  }
  const pinned = configOfPinned(run?.routing);
  const config = pinned ?? current;
  if (!config) return null;
  const route = resolveRoute({ config, node: typeof run?.currentNode === "string" ? run.currentNode : "implement" });
  return { model: route.model, effort: route.effort, source: route.source, pinned: pinned !== null, drift: current ? routingDrift(run?.routing, current) : null };
}

function policyOf(ctx, run) {
  try {
    const { policy } = loadPolicy(seams(ctx));
    return { mode: policy?.mode ?? null, hash: typeof run?.policyHash === "string" ? run.policyHash : null };
  } catch {
    return null;
  }
}

function sessionFor(ctx, repoKey, run, sessionId) {
  const options = { ...seams(ctx), repair: false };
  if (sessionId) return loadSession(repoKey, sessionId, options).session;
  if (!run) return null;
  try {
    const hit = listSessions(repoKey, options).sessions.find((item) => item.runId === run.runId);
    return hit ? loadSession(repoKey, hit.id, options).session : null;
  } catch {
    return null;
  }
}

/**
 * The session that /context, /attachments and /image all act on when none is named: the session of the newest run, else the
 * newest active session. Staged images are picked up only by `asterweave run start --session <id>` for THAT session.
 */
function defaultSession(ctx, repoKey) {
  const options = { ...seams(ctx), repair: false };
  try {
    const latest = listRuns(repoKey, seams(ctx)).find((item) => item.error === undefined);
    if (latest) {
      const run = loadRun(latest.dir, ctx.fs ? { fs: ctx.fs } : {}).run;
      const owner = sessionFor(ctx, repoKey, run, null);
      if (owner) return owner;
    }
  } catch {
    // an unreadable newest run falls through to the newest active session
  }
  const newest = listSessions(repoKey, { ...options, status: "active", limit: 1 }).sessions[0];
  return newest ? loadSession(repoKey, newest.id, options).session : null;
}

/**
 * Gather the inputs and build the view.
 * @param {object} ctx  Seams only (env, fs, ...).
 * @param {{repoKey: string, runId?: string|null, sessionId?: string|null, requireRun?: boolean, pickSession?: boolean}} target
 *   `pickSession`: when no session is named or linked to the run, use the default session (see defaultSession).
 * @returns {Promise<{view: object, usageReport: object|null, run: object|null, session: object|null}>}
 */
export async function collectAccounting(ctx, { repoKey, runId = null, sessionId = null, requireRun = true, pickSession = false }) {
  const options = seams(ctx);
  let session = sessionId ? sessionFor(ctx, repoKey, null, sessionId) : null;
  let loaded = null;
  const wanted = runId ?? session?.runId ?? null;
  if (wanted) loaded = loadRun(runDir(repoKey, wanted, options), ctx.fs ? { fs: ctx.fs } : {});
  else if (!sessionId) {
    const latest = listRuns(repoKey, options).find((item) => item.error === undefined);
    if (latest) loaded = loadRun(latest.dir, ctx.fs ? { fs: ctx.fs } : {});
    else if (requireRun) throw new CliError("There are no runs for this repository.", { code: "RUN_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Runs are kept per repository; run this command from inside the repository the run belongs to, or start one with `asterweave run start`." });
  }
  const run = loaded?.run ?? null;
  session ??= sessionFor(ctx, repoKey, run, null);
  if (!session && pickSession) session = defaultSession(ctx, repoKey);
  const usageReport = loaded ? buildUsageReport({ run, events: loaded.events, limits: limitsOf(ctx) }) : null;
  const attachments = await attachmentsOf(ctx, await loadAttachmentsApi(ctx), repoKey, session?.id ?? null);
  const view = buildAccountingView({ run, session, usageReport, route: routeOf(ctx, run), attachments, policy: policyOf(ctx, run) });
  return { view, usageReport, run, session };
}

/**
 * What the memory context builder attached to this run's requests (memory/context.mjs traces): totals only, never content.
 * null when there is no memory store or no trace for the run (the view is then exactly what it was before memory existed).
 * Memory tokens are ESTIMATES (characters / 4); the provider's own input/output/cached counts are the usage lines above.
 */
export function memoryContextOf(ctx, runId) {
  if (!runId) return null;
  let mem = null;
  try {
    mem = openMemory({ ...seams(ctx), ...(ctx.userDir ? { userDir: ctx.userDir } : {}), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.loadSqlite ? { loadSqlite: ctx.loadSqlite } : {}), create: false });
    if (mem === null) return null;
    const owner = ctx.memoryOwner ?? existingOwner(mem);
    if (!owner) return null;
    const traces = listTraces(mem, { owner, runId, limit: 1000 });
    if (traces.length === 0) return null;
    return { runId, ...traceTotals(traces) };
  } catch {
    return null;
  } finally {
    mem?.close();
  }
}

const memoryLine = (m) => `Memory      ${m.requests} request(s) with memory built, ~${m.memoryTokens} memory tokens injected (estimated, chars/4), ${m.selected} memories selected, cache ${m.cacheHits} hit(s) / ${m.cacheMisses} miss(es), ${m.retrievalMs} ms retrieval; summary/extraction tokens 0 (deterministic). Details: asterweave memory trace ${m.runId}`;

/** Handler for `asterweave context [runId | --session id]`. */
export async function contextCommand(ctx) {
  const [runId, ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation: USAGE });
  const sessionId = ctx.options?.session;
  if (sessionId !== undefined && (typeof sessionId !== "string" || sessionId === "")) throw new UsageError("--session needs a session id.", { remediation: USAGE });
  if (runId !== undefined && sessionId !== undefined) throw new UsageError("Give either a run id or --session, not both.", { remediation: USAGE });
  const repo = await resolveRepo(ctx);
  const { view, run } = await collectAccounting(ctx, { repoKey: repo.key, runId: runId ?? null, sessionId: sessionId ?? null, pickSession: runId === undefined && sessionId === undefined });
  const memory = memoryContextOf(ctx, run?.runId ?? null);
  if (ctx.options?.json === true) ctx.stdout.write(`${stringifyJson({ ok: true, context: memory ? { ...view, memory } : view })}\n`);
  else ctx.stdout.write(`${sanitizeLines([...formatAccounting(view), ...(memory ? [memoryLine(memory)] : [])])}\n`);
  return EXIT.OK;
}

// --- the interactive session's views ----------------------------------------------------------------------------

const oneLine = (error) => sanitizeForTerminal(String(error?.message ?? "unknown error")).slice(0, 160);

/**
 * Read-only views for the TUI. Each function returns an array of plain lines (the TUI sanitises and bounds them) and never
 * throws; none of them calls a model. `repoKey` may be null (no repository identity): every view then says so.
 * @param {object} ctx  Seams (env, fs, ...), plus `attachmentsApi` in tests.
 * @param {{repoKey?: string|null, resolveKey?: () => Promise<string|null>}} target
 *   `resolveKey` finds the repository key on first use (so opening the session spawns nothing).
 */
export function createSessionViews(ctx, { repoKey = null, resolveKey } = {}) {
  const missing = ["No repository identity is available, so no run or session can be read."];
  let key = repoKey;
  const guarded = (work) => async (...args) => {
    try {
      key ??= (await resolveKey?.()) ?? null;
      if (!key) return missing;
      return await work(key, ...args);
    } catch (error) {
      return [`Could not read this: ${oneLine(error)}`];
    }
  };
  /** The session /context, /attachments and /image all act on (see defaultSession). */
  const activeSession = (repoKey) => {
    const session = defaultSession(ctx, repoKey);
    return session ? { id: session.id, title: session.title, status: session.status } : null;
  };
  const NO_SESSION = ["There is no active session to attach images to.", "Create one with: asterweave session start"];
  const SENT_BY = "Staged images are sent with the first turn of: asterweave run start --session <id>";
  const problemText = (problem) => sanitizeForTerminal(String(problem?.message ?? problem)).slice(0, 200);
  return {
    context: guarded(async (repoKey) => formatAccountingCompact((await collectAccounting(ctx, { repoKey, requireRun: false, pickSession: true })).view)),
    usage: guarded(async (repoKey) => formatUsageCompact((await collectAccounting(ctx, { repoKey, requireRun: false })).view)),
    attachments: guarded(async (repoKey) => {
      const session = activeSession(repoKey);
      if (!session) return NO_SESSION;
      const list = await attachmentsOf(ctx, await loadAttachmentsApi(ctx), repoKey, session.id);
      if (list === null) return [`Session ${session.id}: the attachment store is not available in this build, so staged images are unknown.`];
      const view = buildAccountingView({ session, attachments: list }).attachments;
      return [`Session ${session.id}: ${view.staged} staged image(s), ${view.sent} sent. Hashes and sizes only; image bytes are never shown.`, SENT_BY, ...formatAttachmentLines(view)];
    }),
    image: guarded(async (repoKey, sourcePath) => {
      const session = activeSession(repoKey);
      if (!session) return NO_SESSION;
      if (session.status === "archived") return [`Session ${session.id} is archived; images cannot be staged on it.`, "Create one with: asterweave session start"];
      const api = await loadAttachmentsApi(ctx);
      if (!api || typeof api.addAttachment !== "function") return ["Image attachments are not available in this build."];
      const result = await api.addAttachment(session.id, sourcePath, { repoKey, ...seams(ctx) });
      if (!result?.ok) return ["Image not staged:", ...(Array.isArray(result?.problems) ? result.problems : ["it was refused"]).slice(0, 5).map((problem) => `  ${problemText(problem)}`)];
      const view = buildAccountingView({ session, attachments: [result.attachment] }).attachments;
      return [`Staged on session ${session.id}; nothing was sent now. ${SENT_BY}`, ...formatAttachmentLines(view)];
    }),
  };
}
