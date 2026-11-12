// The live memory pipeline of one run: capture, checkpoints, summary, decision extraction, resume and the context builder,
// wired to an executor through four calls (see run-runner.mjs and claude/executor.mjs):
//
//   createMemoryPipeline(...)      opens the store, maps the run to a memory session, computes the resume gap BEFORE anything
//                                  is captured, validates the checkpoint on a cold resume, captures the user's goal
//   context(ctx, obs, {fresh})     the memory section for the NEXT model request (context.mjs), or null
//   onTurn({...})                  after each model turn: captures the visible reply and tool calls INCREMENTALLY (not at exit)
//   onCommitted(run, effects)      after each committed run transition (loop option): deterministic checkpoint
//   finish(result)                 pause / handoff / end: last checkpoint, summary if due; then close()
//
// SESSION MAPPING. One memory session per RUN: id `ms_run_<runId>`, task_id = runId, owner = the local owner id, repository by
// identity.mjs (never a folder name), branch and worktree recorded, and `external_session_id` = the file session (run start
// --session) when there is one. A file session spans many runs; the latest memory session linked to it is the one a new run
// resumes from. Worktrees have their own file sessions, so they share repository decisions but never task state.
//
// EVENT IDS are derived from (runId, node, attempt, iteration, turn, index): a retried or re-driven turn writes the same ids, so
// capture's idempotency makes it a no-op (an interrupted reply is stored `incomplete` and upgraded once if it later completes).
// Only VISIBLE text is stored: the final reply text, tool names with their one-line input summaries, and for each tool result either
// BOUNDED EVIDENCE or a content-free marker. With memory.toolResultExcerptChars > 0 (default 2000) the executor asks the stream parser
// for an excerpt of each result's TEXT output (never images or other blocks), redacted and cut to the limit inside the parser; it
// is stored here through capture (redacted again, bounded) with its source length (`original_chars`, `truncated`) and a one-line
// header (excerpt length, error flag). With 0, or when a result has no excerpt, the marker is stored. Excerpts are paired with
// their tool call by tool-use id, then in order. Hidden reasoning never reaches this module.
//
// FAILURE IS VISIBLE. Every write result is checked; the first failure produces one "degraded persistence" line (onDegraded) and
// each DISTINCT failure one `memory.status` ledger record (drainEvents) carrying the running saved/failed counts; the final counts
// are in status() and the run result's `memory` field. Nothing here reports a write as saved unless the store said so.
// memory.enabled = false (`memory capture off`) means no pipeline at all: the store is not opened.
//
// A LOCKED OR FAILING DISK never stalls the run: the live store waits at most LIVE_BUSY_TIMEOUT_MS for a lock (node:sqlite waits
// synchronously, blocking the event loop, so Ctrl-C and step deadlines could not fire), and the first SQLITE_BUSY / IO failure
// closes the store: the pipeline is inert for the rest of the run, and later failures are only counted.
//
// DEFERRED START (deferStart: true, the CLI). Construction only reads (identity, resume gap, checkpoint validation); every write
// of the start (an invalidated checkpoint, the session row, the goal, the start checkpoint) and the resume note wait for the first
// context/onTurn/onCommitted/finish call, which the loop makes only while it holds the run lock: a `run resume` that loses the
// lock to another process writes nothing and says nothing. (The identity lookup still refreshes repo_clones.last_seen_at.)

import { createHash } from "node:crypto";
import { stringifyJson } from "../../json.mjs";
import { appendEvent, readEvents } from "./capture.mjs";
import { currentCheckpointVersion, latestValidCheckpoint, saveCheckpoint, SUMMARY_MAX } from "./checkpoints.mjs";
import { buildMemoryContext, createContextCache } from "./context.mjs";
import { isLockOrIoFailure, notExpired, openMemory } from "./db.mjs";
import { extractDecisions } from "./extract.mjs";
import { resolveRepoIdentity } from "./identity.mjs";
import { classifyGap, isNewTopic, resumeNote, validateCheckpoint } from "./resume.mjs";
import { localOwner, openSession, toSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";
import { probeWorkspace } from "./workspace.mjs";

export const sessionIdForRun = (runId) => `ms_run_${String(runId).slice(0, 100)}`;
/** How long a live write waits for another connection's lock (CLI maintenance commands keep db.mjs's 5000 ms). */
export const LIVE_BUSY_TIMEOUT_MS = 250;
const SUMMARY_PAGE = 400;
const TOOL_RESULT_MARKER = "[tool result received; its output is not captured]";
const excerptHeader = (item, kept) => `[tool result${item.isError ? " (error)" : ""}: excerpt of ${kept} of ${item.originalChars} chars${item.truncated ? ", truncated" : ""}]`;

/** Pair bounded excerpts with tool calls: by tool-use id first, then the unmatched ones in order. Pure. */
export function pairExcerpts(tools, excerpts) {
  const list = Array.isArray(excerpts) ? excerpts.filter((item) => item && typeof item.excerpt === "string") : [];
  const used = new Set();
  const out = tools.map((tool) => {
    const index = list.findIndex((item, i) => !used.has(i) && item.toolUseId && item.toolUseId === tool.id);
    if (index === -1) return null;
    used.add(index);
    return list[index];
  });
  const rest = list.filter((_, i) => !used.has(i));
  return out.map((item) => item ?? rest.shift() ?? null);
}
/** How an invalidation is worded (as in context.mjs): only run-status moves are "the run state changed". */
const changedWhat = (changes) => (Array.isArray(changes) && changes.length > 0 && changes.every((change) => String(change).startsWith("run status ")) ? "the run state changed" : "the workspace changed");
const STALE = new Set(["stale_version", "stale_coverage", "stale_summary"]);
const QUIET = new Set(["disabled", "forgotten", "skipped", "expired"]);
const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 24);
const clip = (text, max) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
};

/**
 * The default summarizer: deterministic and extractive (no model call, 0 tokens). Keeps the tail of the previous summary and a
 * one-line digest of each newly covered visible message and tool call. A model-backed summarizer is a seam only:
 * `{name, summarize({previous, checkpoint, events}) => string}`.
 */
export const extractiveSummarizer = Object.freeze({
  name: "extractive",
  model: false,
  summarize({ previous, events }) {
    const lines = previous ? previous.split("\n").slice(-20) : [];
    for (const event of events) {
      if (event.type === "message" && (event.role === "user" || event.role === "assistant")) lines.push(`${event.role}: ${clip(event.content.split(/\r?\n/).find((line) => line.trim() !== "") ?? "", 160)}${event.status === "incomplete" ? " (cut off)" : ""}`);
      else if (event.type === "tool_call") lines.push(`tool: ${clip(event.content, 80)}`);
    }
    return lines.slice(-40).join("\n").slice(0, SUMMARY_MAX);
  },
});

/** Completed work, blockers and next action from the run state (graph.mjs shape). Pure, deterministic. */
export function deriveTaskState(run) {
  const completed = [];
  const refs = [];
  for (const [id, node] of Object.entries(run?.nodes ?? {})) {
    if (node.status !== "passed") continue;
    const evidence = node.attemptLog?.at(-1)?.evidence ?? [];
    completed.push(`${id}${evidence.length > 0 ? ` (evidence: ${evidence.map((item) => `${item.kind} ${item.result ?? ""}`.trim()).join(", ")})` : ""}`);
    for (const item of evidence.slice(0, 5)) refs.push({ node: id, kind: item.kind, result: item.result ?? null });
  }
  const blockers = [];
  for (const [id, node] of Object.entries(run?.nodes ?? {})) if (node.status === "blocked" || node.status === "failed") blockers.push(`${id}: ${node.status}${node.failureSignatures?.at(-1) ? ` (${node.failureSignatures.at(-1)})` : ""}`);
  const pending = (run?.approvals ?? []).filter((approval) => approval.status === "pending" || approval.state === "pending");
  for (const approval of pending.slice(0, 5)) blockers.push(`approval ${approval.id} pending (${approval.kind ?? "approval"})`);
  const status = run?.status ?? "active";
  const node = run?.currentNode ?? null;
  const nextAction =
    status === "completed" ? "The run is complete; nothing is pending."
      : status === "aborted" ? "The run was aborted."
        : status === "waiting-approval" ? `A person must answer the pending approval at ${node} (asterweave run approve).`
          : status === "blocked" ? `Unblock ${node}, then resume the run.`
            : status === "paused" ? `Resume the run at ${node}.`
              : `Continue the ${node} stage.`;
  return { completed, blockers, nextAction, refs, status, node };
}

/**
 * @param {object} o
 * @param {object} o.settings  memory settings (settingsFromEntries)
 * @param {object} o.storeOptions  openMemory options: userDir, now, loadSqlite, fs
 * @param {{cloneKey: string, kind?: string, remote?: string|null, anchor?: string|null, unavailable?: string}} o.repo
 *   `anchor`: identity.mjs readCloneAnchor. `unavailable`: the identity could not be read this run (git failed): nothing is
 *   opened, checked or captured, and no ambiguity is recorded; one degraded line says why.
 * @param {boolean} [o.deferStart]  defer the start writes and the resume note to the first use (see DEFERRED START)
 * @param {(note: string) => void} [o.onNote]  the resume note, said once
 * @param {string} o.runId @param {string} o.goal @param {object} [o.run]  the run state at start
 * @param {string|null} [o.externalSessionId] @param {string} o.workspace @param {string|null} [o.branch]
 * @param {string|null} [o.model]  routed model ("default" when none) @param {boolean} [o.providerContextLost]
 * @param {string} [o.owner] @param {object} [o.summarizer] @param {Function} [o.probe]  (cwd) => probeWorkspace result
 * @param {object} [o.probeOptions] @param {(line: string) => void} [o.onDegraded] @param {object} [o.catalog]
 * @returns {Promise<object|null>} null when memory is disabled
 */
export async function createMemoryPipeline(o) {
  const cfg = withDefaults(o.settings);
  if (cfg.enabled === false) return null;
  const summarizer = o.summarizer ?? extractiveSummarizer;
  const probe = o.probe ?? ((cwd) => probeWorkspace(cwd, o.probeOptions ?? {}));
  const state = {
    mem: null, owner: null, repoId: null, sessionId: sessionIdForRun(o.runId), priorSessionId: null, run: o.run ?? null, probe: null,
    saved: 0, failed: 0, degraded: [], ledger: [], announced: false, lastSignature: null, resume: { mode: "new", reasons: [], invalidated: false, changes: [], newTopic: false, note: null },
    summarizerCalls: 0, lastUsage: null, cache: createContextCache(), paused: null, turnCounter: new Map(),
  };

  /** @param {unknown} [failure]  the error or degraded result behind it (a lock / IO failure stops the pipeline) */
  function degrade(what, reason, failure) {
    state.failed += 1;
    if (state.stopped) return; // already inert after a lock / IO failure: later failures are only counted
    let line = `${what}: ${clip(reason, 160)}`;
    if (failure && isLockOrIoFailure(failure)) {
      state.stopped = true;
      line = `${what}: the memory database is locked or failing (${clip(failure.message ?? failure.reason ?? "busy", 80)}); capture stopped for the rest of this run`;
      try {
        state.mem?.close();
      } catch {
        /* already closed */
      }
      state.mem = null;
    }
    if (!state.degraded.includes(line)) {
      state.degraded.push(line);
      state.ledger.push({ type: "memory.status", state: "degraded", reason: clip(line, 180), saved: state.saved, failed: state.failed });
    }
    if (!state.announced) {
      state.announced = true;
      try {
        o.onDegraded?.(`Memory: degraded persistence (${line}). This run's conversation is NOT fully saved to memory; the run itself continues.${state.remediation ? ` ${state.remediation}` : ""}`);
      } catch {
        /* reporting must not break the run */
      }
    }
  }
  /** Count a write result honestly. */
  function track(result, what) {
    if (result?.saved === true) {
      state.saved += 1;
      return true;
    }
    if (!result || QUIET.has(result.status) || STALE.has(result.status)) return false;
    if (result.code === "ITEM_EXISTS") return false;
    degrade(what, result.reason ?? result.code ?? result.status ?? "write failed", result);
    return false;
  }

  const noop = (reasonLine) => {
    if (reasonLine) degrade("memory", reasonLine);
    return api(true);
  };

  // The identity could not be read (a transient git failure): no store, no identity check, no capture, no ambiguity.
  if (typeof o.repo?.unavailable === "string") return noop(`not used for this run: ${o.repo.unavailable}`);
  try {
    state.mem = openMemory({ busyTimeoutMs: LIVE_BUSY_TIMEOUT_MS, ...(o.storeOptions ?? {}) });
  } catch (error) {
    // node:sqlite missing (Node 22.0-22.12): say what fixes it, once per run.
    if (error?.code === "MEMORY_UNAVAILABLE") state.remediation = `${error.remediation ?? "Upgrade Node.js."} Or turn memory off: \`asterweave memory capture off\`.`;
    return noop(`the store could not be opened (${error?.code ?? "error"})`);
  }
  const { mem } = state;
  try {
    state.owner = o.owner ?? localOwner(mem);
    const identity = resolveRepoIdentity(mem, o.repo);
    if (identity.ambiguous) {
      mem.close();
      state.mem = null;
      state.paused = `${identity.reason === "history" ? "this path now holds a repository with a different history than the one memory knows" : "the repository's remote changed"}; run \`asterweave memory repo resolve same|new\``;
      return noop(`capture paused: ${state.paused}`);
    }
    state.repoId = identity.repoId;
    state.probe = await probe(o.workspace);

    // The gap is read BEFORE this turn is captured: capture moves last_activity_at.
    const existing = mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(state.sessionId);
    const prior = o.externalSessionId
      ? mem.db.prepare("SELECT * FROM sessions WHERE external_session_id = ? AND owner = ? AND repo_id = ? AND id != ? AND expires_at > ? ORDER BY last_activity_at DESC LIMIT 1").get(o.externalSessionId, state.owner, state.repoId, state.sessionId, mem.now())
      : null;
    if (prior) state.priorSessionId = prior.id;
    const source = existing ?? prior ?? null;
    const sourceCp = source ? latestValidCheckpoint(mem, source.id).checkpoint : null;
    const recordedModel = sourceCp?.generationMeta?.model ?? null;
    const gap = classifyGap({
      lastActivityAt: source?.last_activity_at ?? null, now: mem.now(), idleRefreshMinutes: cfg.idleRefreshMinutes, coldResumeMinutes: cfg.coldResumeMinutes,
      providerContextLost: source ? o.providerContextLost === true : false, modelChanged: Boolean(recordedModel && o.model && recordedModel !== o.model),
    });
    state.resume = { mode: gap.mode, gapMinutes: gap.gapMinutes, reasons: gap.reasons, invalidated: false, changes: [], newTopic: false, note: null, sourceSessionId: source ? source.id : null };
    if (sourceCp && !existing && isNewTopic(o.goal, sourceCp)) state.resume.newTopic = true;
    if (gap.mode === "cold" && sourceCp && !state.resume.newTopic) {
      const validation = validateCheckpoint(sourceCp, state.probe, { runStatus: existing ? state.run?.status ?? null : null });
      state.resume.changes = validation.changes;
      state.resume.invalidated = !validation.unchanged;
      state.resume.note = resumeNote(sourceCp, validation, state.probe);
      if (!validation.unchanged) state.invalidate = { source, sourceCp, validation };
    }
  } catch (error) {
    degrade("memory", error?.message ?? String(error), error);
  }
  if (o.deferStart !== true) activate();
  return api(false);

  // --- internals ------------------------------------------------------------------------------------------------------

  /** The start writes, once (see DEFERRED START). @returns {boolean} whether the pipeline is live */
  function activate() {
    if (state.activated) return state.mem !== null;
    state.activated = true;
    if (!state.mem) return false;
    const { mem } = state;
    try {
      if (state.invalidate) {
        const { source, sourceCp, validation } = state.invalidate;
        state.invalidate = null;
        const latestCovered = Number(mem.db.prepare("SELECT MAX(covered_seq) AS c FROM checkpoints WHERE session_id = ?").get(source.id)?.c ?? sourceCp.coveredSeq);
        track(saveCheckpoint(mem, source.id, {
          expectedVersion: currentCheckpointVersion(mem, source.id), coveredSeq: Math.max(sourceCp.coveredSeq, latestCovered), goal: sourceCp.goal, decisions: sourceCp.decisions,
          completedWork: sourceCp.completedWork ? `[UNVERIFIED: ${changedWhat(validation.changes)} (${validation.changes.join("; ")}); re-verify]\n${sourceCp.completedWork}` : null,
          blockers: sourceCp.blockers, nextAction: sourceCp.nextAction, branch: sourceCp.branch, headCommit: sourceCp.headCommit, worktreeId: sourceCp.worktreeId,
          changedFilesFingerprint: sourceCp.changedFilesFingerprint, runningRefs: sourceCp.runningRefs, sourceRefs: sourceCp.sourceRefs,
          generationMeta: { ...(sourceCp.generationMeta ?? {}), invalidated: true, invalidatedAt: mem.now(), reasons: validation.changes },
        }, cfg, { viewer: state.owner }), "checkpoint");
      }
      if (!state.mem) return false;
      const opened = openSession(mem, { id: state.sessionId, owner: state.owner, repoId: state.repoId, taskId: o.runId, title: clip(o.goal, 200), externalSessionId: o.externalSessionId ?? null, branch: o.branch ?? state.probe?.branch ?? null, worktreeId: state.probe?.worktreeId ?? null }, cfg);
      if (opened.status === "forgotten") {
        // the user forgot this run's memory session: honour it quietly (no capture, no injection, no degraded line)
        stop();
        return false;
      }
      if (!opened.ok || opened.saved === false) {
        track(opened, "session");
        if (!opened.ok) {
          stop();
          return false;
        }
      }
      const goal = capture({ id: `${o.runId}:goal`, type: "message", role: "user", content: o.goal }, "user");
      if (goal?.status === "forgotten") state.goalForgotten = true; // nor is the goal copied into a new checkpoint
      writeCheckpoint("start");
      if (state.resume.note && state.mem) {
        try {
          o.onNote?.(state.resume.note);
        } catch {
          /* reporting must not break the run */
        }
      }
    } catch (error) {
      degrade("memory", error?.message ?? String(error), error);
    }
    return state.mem !== null;
  }

  function stop() {
    try {
      state.mem?.close();
    } catch {
      /* already closed */
    }
    state.mem = null;
  }

  function capture(event, role) {
    if (!state.mem) return null;
    const result = appendEvent(state.mem, state.sessionId, event, cfg, { viewer: state.owner });
    const ok = track(result, "event");
    if (ok && !result.duplicate && (role === "user" || role === "assistant") && result.status === "complete") {
      const extracted = extractDecisions(state.mem, { owner: state.owner, repoId: state.repoId, sessionId: state.sessionId, eventId: event.id, role, content: event.content }, cfg);
      if (extracted.failed) degrade("decision extraction", extracted.failed.message ?? extracted.failed.code ?? "failed", extracted.failed);
      if (extracted.proposed.length > 0) state.decisionsChanged = true;
    }
    return result;
  }

  function lastSeq() {
    return Number(state.mem.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(state.sessionId)?.last_seq ?? 0);
  }

  function decisionLines() {
    return state.mem.db
      .prepare(`SELECT content, status FROM memory_items WHERE owner = :owner AND repo_id = :repo AND status IN ('proposed', 'confirmed', 'disputed') AND ${notExpired("expires_at")}
        AND id IN (SELECT item_id FROM item_sources WHERE event_id IN (SELECT id FROM events WHERE session_id = :session AND ${notExpired("expires_at")})) ORDER BY recorded_at DESC LIMIT 5`)
      .all({ owner: state.owner, repo: state.repoId, session: state.sessionId, now: state.mem.now() })
      .map((row) => `${clip(row.content, 200)} (${row.status})`);
  }

  function writeCheckpoint(trigger, extra = {}) {
    if (!state.mem) return null;
    try {
      const task = deriveTaskState(state.run);
      const fields = {
        goal: state.goalForgotten ? null : o.goal, completedWork: task.completed.length > 0 ? (state.resume.invalidated ? [`[UNVERIFIED after ${changedWhat(state.resume.changes) === "the run state changed" ? "a run state change" : "a workspace change"}: re-verify]`, ...task.completed] : task.completed) : null,
        blockers: task.blockers.length > 0 ? task.blockers : null, nextAction: task.nextAction, decisions: decisionLines(),
        branch: state.probe?.branch ?? o.branch ?? null, headCommit: state.probe?.head ?? null, worktreeId: state.probe?.worktreeId ?? null, changedFilesFingerprint: state.probe?.fingerprint ?? null,
        runningRefs: { runId: o.runId, status: task.status, node: task.node }, sourceRefs: task.refs,
      };
      const coveredSeq = lastSeq();
      const signature = sha(stringifyJson(fields) + (extra.summary ? `#${coveredSeq}` : ""));
      if (signature === state.lastSignature && !extra.summary) return null;
      for (let tries = 0; tries < 2; tries += 1) {
        const previous = latestValidCheckpoint(state.mem, state.sessionId).checkpoint;
        const result = saveCheckpoint(state.mem, state.sessionId, {
          ...fields, ...extra, expectedVersion: currentCheckpointVersion(state.mem, state.sessionId), coveredSeq,
          generationMeta: { kind: "deterministic", trigger, model: o.model ?? null, verifiable: state.probe?.verifiable === true, probedAt: state.probe ? state.mem.now() : null, summaryAt: extra.summary ? state.mem.now() : previous?.generationMeta?.summaryAt ?? null, summarizer: extra.summary ? summarizer.name : previous?.generationMeta?.summarizer ?? null, invalidated: state.resume.invalidated },
        }, cfg, { viewer: state.owner });
        if (result.status === "stale_version") continue;
        if (track(result, "checkpoint")) state.lastSignature = signature;
        return result;
      }
    } catch (error) {
      degrade("checkpoint", error?.message ?? String(error), error);
    }
    return null;
  }

  async function maybeSummarize(meaningful) {
    if (!state.mem) return;
    const cp = latestValidCheckpoint(state.mem, state.sessionId).checkpoint;
    const seq = lastSeq();
    const covered = cp?.summaryCoveredSeq ?? 0;
    const uncovered = seq - covered;
    if (uncovered <= 0) return;
    const lastAt = cp?.generationMeta?.summaryAt ?? null;
    const debounced = lastAt !== null && Date.parse(state.mem.now()) - Date.parse(lastAt) < cfg.summaryDebounceMinutes * 60_000;
    if (!(meaningful || (uncovered >= cfg.summaryMinNewEvents && !debounced))) return;
    let summary;
    let coveredTo = seq;
    try {
      state.summarizerCalls += 1;
      const events = readEvents(state.mem, state.sessionId, { afterSeq: covered, limit: SUMMARY_PAGE });
      // A full page may not be everything: the summary covers what was READ, the rest stays uncovered for the next refresh.
      if (events.length >= SUMMARY_PAGE) coveredTo = Number(events.at(-1).seq);
      summary = await summarizer.summarize({ previous: cp?.summary ?? null, checkpoint: cp, events });
      if (typeof summary !== "string" || summary.trim() === "") throw new Error("the summarizer returned nothing");
    } catch (error) {
      degrade("summary", `refresh failed (${clip(error?.message ?? error, 80)}); the events are kept and the last valid summary plus bounded recent messages are used`);
      return;
    }
    if (!state.mem) return;
    writeCheckpoint(meaningful ? "summary:state-change" : "summary:threshold", { summary, summaryCoveredSeq: coveredTo });
  }

  function api(inert) {
    return {
      get sessionId() { return state.sessionId; },
      get owner() { return state.owner; },
      get repoId() { return state.repoId; },
      get resume() { return { ...state.resume }; },
      get summarizerCalls() { return state.summarizerCalls; },
      get cacheStats() { return { ...state.cache.stats }; },
      /** Characters of tool output to keep per result (memory.toolResultExcerptChars); 0 when nothing is captured. */
      get toolResultExcerptChars() { return inert || !state.mem ? 0 : Math.max(0, Number(cfg.toolResultExcerptChars) || 0); },
      get inert() { return inert || (state.activated && !state.mem); },
      /** The memory section for the next model request, or null. Never throws. */
      context(ctx, observation, { freshProviderSession = true, model = null } = {}) {
        if (inert || !activate()) return null;
        try {
          const request = [o.goal, observation?.objective, ctx?.feedback].filter(Boolean).join("\n");
          const current = latestValidCheckpoint(state.mem, state.sessionId).checkpoint;
          const usePrior = state.priorSessionId && !state.resume.newTopic && !current?.completedWork;
          // This run's own checkpoint is shown only when it says something the request does not (completed work or blockers) and the
          // model does not already hold it (a fresh provider session): no echo of the goal on a first turn.
          const ownUseful = Boolean(current?.completedWork || current?.blockers) && freshProviderSession;
          const checkpointSessionId = usePrior ? state.priorSessionId : ownUseful ? state.sessionId : null;
          const built = buildMemoryContext(state.mem, {
            owner: state.owner, repoId: state.repoId, sessionId: state.sessionId, checkpointSessionId, taskId: o.runId,
            branch: state.probe?.branch ?? o.branch ?? null, workspaceFingerprint: state.probe?.fingerprint ?? null, request, model: model ?? (o.model === "default" ? null : o.model),
            freshProviderSession, resume: { note: state.resume.note, invalidated: state.resume.invalidated, reasons: state.resume.changes, newTopic: state.resume.newTopic },
            excludeSourceIds: [`${o.runId}:goal`], runId: o.runId, node: ctx?.node, attempt: ctx?.attempt, providerUsage: state.lastUsage, catalog: o.catalog,
          }, cfg, { cache: state.cache });
          for (const note of built.degraded) if (!state.degraded.includes(`context: ${note}`)) degrade("context", note);
          return built.text;
        } catch (error) {
          degrade("context", error?.message ?? String(error), error);
          return null;
        }
      },
      /** After one model turn: capture its visible output incrementally. */
      async onTurn({ node, attempt, iteration = 0, result, interrupted = false }) {
        if (inert || !activate()) return;
        try {
          const key = `${node}:a${attempt}:i${iteration}`;
          const turn = state.turnCounter.get(key) ?? 0;
          state.turnCounter.set(key, turn + 1);
          const base = `${o.runId}:${key}:t${turn}`;
          const cut = interrupted || result?.killed === true;
          const tools = Array.isArray(result?.toolEvents) ? result.toolEvents.slice(0, 200) : [];
          const results = Number.isInteger(result?.toolResults) ? result.toolResults : 0;
          const limit = Math.max(0, Number(cfg.toolResultExcerptChars) || 0);
          const excerpts = limit > 0 ? pairExcerpts(tools, result?.toolResultExcerpts) : tools.map(() => null);
          tools.forEach((tool, index) => {
            const callId = clip(tool.id || `${base}:tool${index}`, 120);
            capture({ id: `${base}:tool${index}`, type: "tool_call", role: "assistant", content: `${tool.name} ${tool.inputSummary ?? ""}`.trim(), toolCallId: callId, eventTime: tool.at, model: result?.model, provider: "claude" }, "tool");
            const item = excerpts[index];
            if (item) {
              const kept = item.excerpt.slice(0, limit); // the parser already cut it; re-bounded in case of a foreign executor
              const sourceChars = Number.isSafeInteger(item.originalChars) && item.originalChars >= 0 ? item.originalChars : kept.length;
              const truncated = item.truncated === true || sourceChars > kept.length;
              capture({ id: `${base}:result${index}`, type: "tool_result", role: "tool", content: `${excerptHeader({ ...item, originalChars: sourceChars, truncated }, kept.length)}\n${kept}`, toolCallId: callId, sourceChars, sourceTruncated: truncated }, "tool");
            } else if (index < results) capture({ id: `${base}:result${index}`, type: "tool_result", role: "tool", content: TOOL_RESULT_MARKER, toolCallId: callId }, "tool");
          });
          const text = typeof result?.resultText === "string" ? result.resultText : "";
          if (text.trim() !== "") capture({ id: `${base}:assistant`, type: "message", role: "assistant", content: text, model: result?.model, provider: result?.provider ?? "claude", status: cut || result?.ok === false ? "incomplete" : "complete" }, "assistant");
          // The resume note is said once: cleared after a turn that went through, so a section rebuilt after a failed first turn
          // (the executor's model fallback) still carries it.
          if (!cut && result?.ok !== false) state.resume.note = null;
          if (result?.usage) state.lastUsage = { inputTokens: result.usage.inputTokens ?? null, outputTokens: result.usage.outputTokens ?? null, cacheReadTokens: result.usage.cacheReadTokens ?? null };
          if (tools.length > 0) {
            try {
              state.probe = await probe(o.workspace);
            } catch {
              /* the previous probe stays; its time is recorded */
            }
          }
          writeCheckpoint(tools.length > 0 ? "tool-completion" : "turn");
          if (state.decisionsChanged) {
            state.decisionsChanged = false;
            writeCheckpoint("decision");
          }
          await maybeSummarize(false);
        } catch (error) {
          degrade("capture", error?.message ?? String(error), error);
        }
      },
      /** A committed run transition (loop option onCommitted): deterministic checkpoint; a node completion is a meaningful change. */
      onCommitted(run, effects = []) {
        if (inert || !activate()) return;
        state.run = run;
        const meaningful = effects.some((effect) => effect?.type === "node.completed" || effect?.type === "run.completed");
        writeCheckpoint(meaningful ? "transition" : "state");
        if (meaningful) state.pendingSummary = true;
      },
      /** The run stopped (completed, paused, waiting for a person, blocked): last checkpoint and, if due, a summary. */
      async finish(result) {
        if (inert || !activate()) return;
        try {
          if (result?.run) state.run = result.run;
          writeCheckpoint(`finish:${state.run?.status ?? "unknown"}`);
          await maybeSummarize(state.pendingSummary === true);
          state.pendingSummary = false;
        } catch (error) {
          degrade("memory", error?.message ?? String(error), error);
        }
      },
      /** Ledger records for the loop (memory.status). */
      drainEvents() {
        const out = state.ledger;
        state.ledger = [];
        return out;
      },
      status() {
        return { sessionId: state.sessionId, saved: state.saved, failed: state.failed, degraded: [...state.degraded], paused: state.paused, resume: { ...state.resume }, summarizerCalls: state.summarizerCalls, cache: { ...state.cache.stats } };
      },
      session() {
        if (!state.mem) return null;
        const row = state.mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(state.sessionId);
        return row ? toSession(row) : null;
      },
      close() {
        state.mem?.close();
        state.mem = null;
      },
    };
  }
}

/**
 * Wire a pipeline to an executor that does not call it itself (the scripted fake executor, test executors): the memory section
 * is built before each decision (exposed as `lastMemorySection()`, since such an executor has no prompt), the decided action is
 * captured as the assistant's visible output, and memory.status records reach the ledger. Getters and every other member of
 * the executor stay live (Object.create, not a copy).
 */
export function attachMemory(executor, memory) {
  if (!memory) return executor;
  const wrapped = Object.create(executor);
  let lastSection = null;
  wrapped.decide = async (ctx, observation) => {
    lastSection = memory.context(ctx, observation, { freshProviderSession: true });
    let raw;
    try {
      raw = await executor.decide(ctx, observation);
    } catch (error) {
      await memory.onTurn({ node: ctx.node, attempt: ctx.attempt, iteration: ctx.iteration ?? 0, result: { ok: false, resultText: "", killed: true }, interrupted: true });
      throw error;
    }
    const text = typeof raw === "string" ? raw : stringifyJson(raw);
    await memory.onTurn({ node: ctx.node, attempt: ctx.attempt, iteration: ctx.iteration ?? 0, result: { ok: true, resultText: text, toolEvents: [], model: null, provider: String(executor.id ?? "executor") } });
    return raw;
  };
  wrapped.drainEvents = (ctx) => [...(executor.drainEvents?.(ctx) ?? []), ...memory.drainEvents()];
  wrapped.lastMemorySection = () => lastSection;
  return wrapped;
}
