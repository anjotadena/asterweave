// The run loop: Observe -> Decide -> validate -> guard -> Act -> Verify -> Checkpoint, one run at a time.
//
// Only this module performs tool actions, and only after the guard and the hooks have seen them. Executors
// (executor.mjs) only propose; the dispatcher (executor.mjs simulatedDispatcher by default) only carries out
// what the loop hands it. Nothing here writes to the terminal: runLoop returns data and the commands render it.
//
// PERSISTENCE. Every state change goes through the ledger: the event line first, then the run.json snapshot
// (ledger.appendEvent). A reducer transition (graph.mjs `transition`) is written as a GROUP of events, one per
// effect, each carrying `tx = {id, i, n, node, step, hold}`; the first one also carries the reducer `input` (and
// the remaining effects as `rest`). So the log alone can rebuild the snapshot:
//
//   foldEvents(run, graph, events)   re-applies pending events (those past run.lastSeq) in order
//
// Other state changes are self-describing records (approval.*, policy.bound, run.rewound) applied by
// applyLoopEvent, and every event carries the budget counters (`used`) as they stood before it.
// A crash between the event and the snapshot leaves `behind` events; the next runLoop folds them. A crash in
// the middle of a group is completed from the first event's `rest`.
//
// SIDE EFFECTS. A tool action is recorded as action.proposed, then (after the guard allowed it)
// action.started{key}, then action.completed{key,result}. On resume an action that started but did not complete
// is re-run when it is idempotent and otherwise stops the node for a human (node.recovered, SIDE_EFFECT_UNKNOWN).
// A crash-interrupted attempt continues as the SAME attempt: nothing here starts a new one.
//
// EXIT CODES (exitCodeFor): completed 0; waiting-approval 6; blocked by policy-denied 7; blocked by
// needs-human / security-escalation 6; other blocked 1; aborted 1; paused (interrupted) 130; waiting-external 0.
//
// TRUST. The executor (and the model behind it) is UNTRUSTED. It can propose actions and may only DOWNGRADE how an
// action is treated (idempotentFor: it can mark an action NOT repeatable, never repeatable). It cannot get an
// approval request created for a target that would not display faithfully (refuseUndisplayable). Phase B carries
// out SIMULATED tools only; the ASTERWEAVE_RUN_ID refusal in approvals.mjs is advisory, so a real dispatcher must
// not ship before approvals have a non-forgeable path and the dispatched processes are isolated by the OS.

import * as nodeFs from "node:fs";
import { CliError, EXIT } from "../exit-codes.mjs";
import { redactText } from "../redact.mjs";
import {
  applyApprovalEvent,
  displayProblem,
  invalidateApproval,
  invalidateDependents,
  isValid,
  pendingApprovals,
  requestApproval,
  scopeHash,
  validScopedApprovals,
} from "./approvals.mjs";
import { actionKey, assertExecutor, canonicalAction, defaultIdempotent, simulatedDispatcher, validateAction } from "./executor.mjs";
import { GraphError, graphHash, initialRun, transition } from "./graph.mjs";
import { evaluateAdvancement, evaluateDispatch, evaluateMutation, evaluateResume, evaluateRetry, isBlocking, makeDecision } from "./guard.mjs";
import { appendEvent, createRun, loadRun, repairTail } from "./ledger.mjs";
import { acquireRunLock } from "./lock.mjs";
import { DEFAULT_POLICY, effectiveMode, policyHash as hashPolicy, resolveBudgets, resolveNodeBudgets } from "./policy.mjs";
import { HOOK_EVENTS, runHooks as defaultRunHooks } from "./hooks.mjs";
import { aggregateUsage, buildUsageEvent, eventTotal, hasMeasuredTotal, normalizeUsageReport, toolCallsByNode } from "./usage.mjs";

export const MAX_REASKS = 2;
export const DEFAULT_STEP_MS = 120_000;
const MAX_TURNS = 20_000;
const RESULT_OUTPUT_CAP = 8000;
const RESULT_ERROR_CAP = 2000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isoNow = () => new Date().toISOString();

// ---------------------------------------------------------------------------------------------
// Applying records to a run (shared by the live path and by crash-recovery folding)
// ---------------------------------------------------------------------------------------------

/**
 * The reducer plus the loop-level bookkeeping that must be reproducible from the log: entering a node starts a
 * fresh iteration count (iterations are budgeted per attempt).
 * @returns {{run: object, effects: object[]}}
 */
export function applyInput(run, graph, input) {
  const result = transition(run, graph, input);
  if ((input.type === "enter" || input.type === "approve") && result.effects.some((effect) => effect.type === "node.entered")) {
    result.run.budgets.used.iterations = 0;
  }
  return result;
}

/**
 * applyInput plus the artifact reconciliation it implies (approval.invalidated, run.rewound), computed from the
 * state before and after. The reconciliation is part of the SAME transition: it is written inside the event group
 * and recomputed identically when the log is folded, so a crash can never separate it from the transition.
 * @returns {{run: object, effects: object[], extra: object[]}}  `extra` are the loop-level reconciliation records.
 */
export function applyInputReconciled(run, graph, input) {
  const result = applyInput(run, graph, input);
  const now = typeof input.now === "string" && input.now !== "" ? input.now : result.run.updatedAt;
  const reconciled = reconcileArtifacts(result.run, graph, run.artifacts, { now });
  return { run: reconciled.run, effects: result.effects, extra: reconciled.events };
}

/** Counts of failure signatures in a prototype-less map: a signature is executor text, `__proto__` included. */
export function signatureCounts(signatures) {
  const counts = Object.create(null);
  for (const signature of signatures) counts[signature] = (counts[signature] ?? 0) + 1;
  return counts;
}

/** Apply a loop-level (non-reducer) record: approval.*, policy.bound, run.rewound. Returns a NEW run. */
export function applyLoopEvent(run, event) {
  switch (event.type) {
    case "approval.requested":
    case "approval.granted":
    case "approval.invalidated":
      return applyApprovalEvent(run, event);
    case "policy.bound": {
      const next = structuredClone(run);
      next.policyHash = event.to ?? null;
      return next;
    }
    case "usage": {
      // The cumulative token counter (the one budgets use). An event that measured no total adds nothing: unknown is never 0.
      const total = eventTotal(event);
      return total === null ? run : withUsed(run, { tokens: (run.budgets?.used?.tokens ?? 0) + total });
    }
    case "run.rewound": {
      const next = structuredClone(run);
      for (const id of Array.isArray(event.nodes) ? event.nodes : []) {
        if (Object.hasOwn(next.nodes, id)) {
          next.nodes[id].status = "pending";
          next.nodes[id].outcome = null;
        }
      }
      if (typeof event.to === "string" && Object.hasOwn(next.nodes, event.to)) next.currentNode = event.to;
      return next;
    }
    default:
      return run;
  }
}

function withUsed(run, used) {
  const next = structuredClone(run);
  next.budgets = { ...(next.budgets ?? {}), used: { iterations: 0, toolCalls: 0, tokens: null, wallMs: 0, ...(next.budgets?.used ?? {}), ...used } };
  return next;
}

/**
 * Rebuild the snapshot from the events past it. Group events after the first are skipped (the first carries the
 * reducer input); every event with `used` restores the budget counters first.
 * @param {object} run  The snapshot (state as of run.lastSeq).
 * @param {object} graph
 * @param {object[]} events  The pending events, in order.
 * @returns {{run: object, applied: number}}
 */
export function foldEvents(run, graph, events) {
  let current = run;
  let applied = 0;
  for (const event of events) {
    if (isObject(event.tx) && event.tx.i > 0) continue;
    if (isObject(event.used)) current = withUsed(current, event.used);
    if (isObject(event.tx)) {
      if (!isObject(event.tx.input)) throw new CliError(`Event ${event.seq} is part of a transition but has no input to replay.`, { code: "RUN_FOLD_FAILED", exitCode: EXIT.ERROR });
      try {
        current = applyInputReconciled(current, graph, event.tx.input).run;
      } catch (error) {
        if (error instanceof GraphError) throw new CliError(`Event ${event.seq} cannot be replayed (${error.code}).`, { code: "RUN_FOLD_FAILED", exitCode: EXIT.ERROR, cause: error });
        throw error;
      }
    } else {
      current = applyLoopEvent(current, event);
    }
    applied += 1;
  }
  return { run: current, applied };
}

// ---------------------------------------------------------------------------------------------
// Cursor: where the script of actions stands, derived from the ledger
// ---------------------------------------------------------------------------------------------

export function emptyCursor() {
  return { steps: {}, pending: null, completedKeys: new Set() };
}

/** Advance `cursor` by one ledger event (mutates and returns it). */
export function advanceCursor(cursor, event) {
  switch (event.type) {
    case "action.proposed":
      cursor.steps[event.node] = Math.max(cursor.steps[event.node] ?? 0, event.step + 1);
      cursor.pending = { node: event.node, step: event.step, attempt: event.attempt, key: event.key, idempotent: event.idempotent === true, action: event.action, started: false };
      return cursor;
    case "action.rejected":
      cursor.steps[event.node] = Math.max(cursor.steps[event.node] ?? 0, event.step + 1);
      if (cursor.pending && cursor.pending.node === event.node && cursor.pending.step === event.step) cursor.pending = null;
      return cursor;
    case "action.started":
      if (cursor.pending && cursor.pending.key === event.key && cursor.pending.step === event.step) cursor.pending.started = true;
      return cursor;
    case "action.completed":
      if (typeof event.key === "string") cursor.completedKeys.add(event.key);
      if (cursor.pending && cursor.pending.node === event.node && cursor.pending.step === event.step) cursor.pending = null;
      return cursor;
    default:
      if (isObject(event.tx) && event.tx.i === 0 && cursor.pending && event.tx.step != null && event.tx.step === cursor.pending.step && event.tx.node === cursor.pending.node) {
        if (event.tx.hold !== true) cursor.pending = null;
      }
      return cursor;
  }
}

export function deriveCursor(events) {
  const cursor = emptyCursor();
  for (const event of events) advanceCursor(cursor, event);
  return cursor;
}

// ---------------------------------------------------------------------------------------------
// Persistence helpers (also used by the commands: `run approve`, `run abort`)
// ---------------------------------------------------------------------------------------------

/**
 * Apply a reducer input and persist it as an event group. Nothing is written when the reducer rejects the input
 * (GraphError).
 * @param {{dir: string, graph: object, lockToken: string, now?: () => string, fs?: typeof nodeFs}} env
 * @param {object} run
 * @param {object} input  A reducer event (`now` is filled in).
 * @param {{step?: number|null, hold?: boolean}} [meta]
 * @returns {{run: object, effects: object[], seq: number}}  `effects` are the reducer's; the artifact
 *   reconciliation records travel in the same group (and are not part of `effects`).
 */
export function commitTransition(env, run, input, meta = {}) {
  const now = env.now ?? isoNow;
  const stamped = { ...input, now: input.now ?? now() };
  const { run: next, effects, extra } = applyInputReconciled(run, env.graph, stamped);
  const all = [...effects, ...extra];
  const list = all.length > 0 ? all : [{ type: "run.updated" }];
  const id = `tx${run.lastSeq + 1}`;
  const used = { ...run.budgets.used };
  let last = { run, seq: run.lastSeq };
  list.forEach((effect, i) => {
    const tx = { id, i, n: list.length, node: run.currentNode, step: meta.step ?? null, hold: meta.hold === true, ...(i === 0 ? { input: stamped, ...(list.length > 1 ? { rest: list.slice(1) } : {}) } : {}) };
    last = appendEvent(env.dir, { ...effect, used, tx }, { run: next, lockToken: env.lockToken, now, fs: env.fs });
  });
  return { run: last.run, effects, seq: last.seq };
}

/**
 * A crash in the middle of an event group: write the records that never made it (taken from the `rest` of the
 * group's first event). Shared by the loop start and by the commands that take the run lock (`run approve|abort`).
 * The latest GROUP event is searched backwards past non-transition events (ledger.repaired, hook.result, ...), so a
 * torn tail that was cut off, or anything appended after the crash, cannot hide the unfinished group. The records
 * are appended WITHOUT being applied again: every event of a group already carries the final snapshot.
 * @param {{dir: string, lockToken: string, now?: () => string, fs?: typeof nodeFs}} env
 * @param {object} run  The up-to-date (folded) run.
 * @param {object[]} events  All complete events of the ledger.
 * @returns {{run: object, written: number, seq: number | null}}
 */
export function completeInterruptedGroup(env, run, events) {
  const last = events.findLast((event) => isObject(event.tx));
  if (!last || last.tx.i >= last.tx.n - 1) return { run, written: 0, seq: null };
  const first = events.findLast((event) => event.tx?.id === last.tx.id && event.tx.i === 0);
  const rest = Array.isArray(first?.tx?.rest) ? first.tx.rest : [];
  let current = run;
  let written = 0;
  let seq = null;
  for (let i = last.tx.i + 1; i < last.tx.n; i += 1) {
    if (!isObject(rest[i - 1])) break;
    const { id, n, node, step, hold } = last.tx;
    const result = appendEvent(env.dir, { ...rest[i - 1], used: { ...current.budgets.used }, tx: { id, i, n, node, step, hold } }, { run: current, lockToken: env.lockToken, now: env.now ?? isoNow, fs: env.fs });
    current = result.run;
    seq = result.seq;
    written += 1;
  }
  return { run: current, written, seq };
}

/**
 * Persist loop-level records (approval.*, policy.bound, run.rewound, or plain log records) one by one, applying
 * each to the run before its snapshot is written.
 * @returns {{run: object, seq: number}}
 */
export function commitRecords(env, run, records) {
  const now = env.now ?? isoNow;
  let current = run;
  let seq = run.lastSeq;
  for (const record of records) {
    const next = applyLoopEvent(current, record);
    const result = appendEvent(env.dir, { ...record, used: { ...current.budgets.used } }, { run: next, lockToken: env.lockToken, now, fs: env.fs });
    current = result.run;
    seq = result.seq;
  }
  return { run: current, seq };
}

/**
 * Create a run directory for a graph. Convenience over initialRun + ledger.createRun.
 * @param {{graph: object, goal: string, repo: {key: string, realpath: string}, runId: string, policyHash?: string|null, routing?: object|null, now?: () => string}} options
 *   plus any ledger options (env, platform, homedir, fs).
 * @returns {{dir: string, run: object}}
 */
export function createRunForGraph({ graph, goal, repo, runId, policyHash = null, routing = null, now = isoNow, ...ledgerOptions }) {
  const run = initialRun(graph, { runId, goal, repo, now: now(), policyHash });
  if (routing !== null) run.routing = routing; // pinned model route (routing.mjs pinRouting); absent on older runs
  return createRun(repo.key, run, { ...ledgerOptions, now });
}

/**
 * When an artifact got a new revision: invalidate the approvals of it and of everything depending on it, and put a
 * run that already moved past a dependent node back at that node. Pure.
 * @param {object} run @param {object} graph
 * @param {Record<string, {revision: number}>} previous  The artifacts as they were before.
 * @returns {{run: object, events: object[]}}
 */
export function reconcileArtifacts(run, graph, previous, { now }) {
  const changed = Object.entries(run.artifacts ?? {})
    .filter(([name, artifact]) => artifact.revision > (previous?.[name]?.revision ?? 0))
    .map(([name]) => name);
  let current = run;
  const events = [];
  const order = Object.keys(graph.nodes);
  for (const name of changed) {
    const invalidated = invalidateDependents(current, name, { now });
    current = invalidated.run;
    events.push(...invalidated.events);
    if (Object.hasOwn(graph.terminals, current.currentNode)) continue;
    const here = order.indexOf(current.currentNode);
    const stale = order.filter((id, index) => index < here && (graph.nodes[id].dependsOn ?? []).includes(name) && current.nodes[id].status === "passed");
    if (stale.length > 0) {
      const event = { type: "run.rewound", from: current.currentNode, to: stale[0], nodes: order.slice(order.indexOf(stale[0]), here + 1), cause: `artifact-changed:${name}` };
      current = applyLoopEvent(current, event);
      events.push(event);
    }
  }
  return { run: current, events };
}

/** Exit code for a run in its current state (see the module comment). */
export function exitCodeFor(run) {
  switch (run?.status) {
    case "completed":
    case "waiting-external":
      return EXIT.OK;
    case "waiting-approval":
      return EXIT.APPROVAL_REQUIRED;
    case "paused":
      return EXIT.INTERRUPTED;
    case "blocked": {
      const outcome = run.nodes?.[run.currentNode]?.outcome;
      if (outcome === "policy-denied") return EXIT.POLICY_DENIED;
      if (outcome === "needs-human" || outcome === "security-escalation") return EXIT.APPROVAL_REQUIRED;
      return EXIT.ERROR;
    }
    default:
      return EXIT.ERROR;
  }
}

// ---------------------------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------------------------

function abortError(signal) {
  const error = new Error(signal?.reason?.name === "TimeoutError" ? "the step deadline was exceeded" : "aborted");
  error.name = signal?.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  if (!signal) return pending;
  if (signal.aborted) {
    pending.catch(() => {});
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const cap = (value, length) => {
  const text = redactText(String(value ?? "")).text;
  return text.length > length ? `${text.slice(0, length)}...` : text;
};

function normalizeResult(result) {
  if (!isObject(result)) return { ok: false, error: "the dispatcher returned no result" };
  return {
    ok: result.ok === true,
    ...(result.output === undefined ? {} : { output: cap(result.output, RESULT_OUTPUT_CAP) }),
    ...(result.error === undefined ? {} : { error: cap(result.error, RESULT_ERROR_CAP) }),
  };
}

const slimHook = (r) => ({ id: r.id, source: r.source, kind: r.kind, status: r.status, effect: r.effect, reason: r.reason ?? null, code: r.code ?? null, durationMs: r.durationMs ?? 0 });

// ---------------------------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------------------------

class Session {
  constructor(options) {
    this.o = options;
    this.dir = options.dir;
    this.graph = options.graph;
    this.fs = options.fs ?? nodeFs;
    this.nowIso = options.now ?? isoNow;
    this.sleep = options.sleep ?? defaultSleep;
    this.executor = options.executor;
    this.dispatcher = options.dispatcher ?? simulatedDispatcher();
    this.policy = options.policy ?? structuredClone(DEFAULT_POLICY);
    this.policyHash = options.policyHash ?? hashPolicy(this.policy);
    this.limits = { ...resolveBudgets(this.policy), ...(options.budgets ?? {}) };
    this.nodeLimits = { ...resolveNodeBudgets(this.policy), ...(options.nodeBudgets ?? {}) };
    this.nodeTokens = Object.create(null); // per-node cumulative tokens (measured only); rebuilt from the ledger at start
    this.nodeCalls = Object.create(null); // per-node tool calls started
    this.hooks = Array.isArray(options.hooks) ? options.hooks : (options.hooks?.hooks ?? []);
    this.runHooks = options.runHooks ?? defaultRunHooks;
    this.stepMs = options.stepMs ?? DEFAULT_STEP_MS;
    this.malformed = 0;
    this.feedback = null;
    this.lastResult = null;
    this.lastDecision = null;
    this.stopReason = null;
    this.exitOverride = null;
    this.cursor = emptyCursor();
    this.run = null;
    this.lock = null;
    this.seq = 0;
  }

  // -- clocks, signals ------------------------------------------------------------------------

  userAborted() {
    return this.o.signal?.aborted === true;
  }

  /**
   * The deadline of one step combined with the caller's signal (AbortSignal.any([signal, timeout])). The timer is
   * a normal (ref'd) one on purpose: an unref'd AbortSignal.timeout would let the process exit while a hung
   * executor is still being waited for. `close()` must be called when the step ends.
   */
  openStep() {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(Object.assign(new Error("the step deadline was exceeded"), { name: "TimeoutError" })), this.stepMs);
    const signal = this.o.signal ? AbortSignal.any([deadline.signal, this.o.signal]) : deadline.signal;
    return { signal, close: () => clearTimeout(timer) };
  }

  syncWall() {
    const elapsed = Math.max(0, Date.parse(this.nowIso()) - this.startMs);
    this.patchUsed({ wallMs: this.baseWallMs + elapsed });
  }

  patchUsed(patch) {
    this.run = withUsed(this.run, patch);
  }

  // -- persistence ----------------------------------------------------------------------------

  env() {
    return { dir: this.dir, graph: this.graph, lockToken: this.lock.token, now: this.nowIso, fs: this.fs };
  }

  /** Append one record that does not change run state beyond what `applyLoopEvent` knows. */
  append(record) {
    this.syncWall();
    const result = commitRecords(this.env(), this.run, [record]);
    this.run = result.run;
    this.seq = result.seq;
    advanceCursor(this.cursor, { ...record, seq: result.seq });
    return result;
  }

  /** Apply a reducer input and persist it (artifact reconciliation included, in the same group); then run the hooks. */
  async commit(input, meta = {}) {
    this.syncWall();
    const nodeBefore = this.run.currentNode;
    const result = commitTransition(this.env(), this.run, input, meta);
    this.run = result.run;
    this.seq = result.seq;
    advanceCursor(this.cursor, { type: "tx", seq: result.seq, tx: { i: 0, step: meta.step ?? null, node: nodeBefore, hold: meta.hold === true } });
    for (const effect of result.effects) {
      if (effect.type === "node.completed") await this.fire("node.completed", { node: effect.node, outcome: effect.outcome, next: effect.next ?? null });
    }
    return result;
  }

  // -- guard and hooks ------------------------------------------------------------------------

  guardCtx() {
    const run = this.run;
    const workspaceRoot = this.o.workspaceRoot ?? run.repo.realpath;
    const { mode } = effectiveMode(this.policy, { workflow: `${this.graph.id}@${this.graph.version}`, repoKey: run.repo.key, branch: this.o.branch });
    const { toolCalls, tokens, wallMs } = this.limits;
    return {
      workspaceRoot,
      cwd: this.o.cwd ?? workspaceRoot,
      mode,
      // Every shell dialect, on every platform: a command must be understood in all of them (the host's shell is not known here).
      dialect: ["posix", "powershell", "cmd"],
      policy: this.policy,
      policyHash: this.policyHash,
      approvals: validScopedApprovals(run, this.policyHash),
      budgets: { limits: { toolCalls, tokens: tokens ?? 0, wallMs }, used: run.budgets.used },
      lockHeld: this.lock.lost !== true,
      ...(this.o.guardOptions ?? {}),
    };
  }

  /** Run `evaluate(ctx)`; when it asks for approvals that were granted (matched by scope hash), ask again with them. */
  guarded(evaluate) {
    const base = this.guardCtx();
    let decision = evaluate(base);
    if (decision.decision === "require-approval") {
      const scopes = decision.detail?.scopes ?? (decision.detail?.scope ? [decision.detail.scope] : []);
      const granted = scopes.filter((scope) => this.run.approvals.some((approval) => approval.kind === "operation" && isValid(this.run, approval, this.policyHash) && approval.subjectHash === scopeHash(scope)));
      if (granted.length > 0) decision = evaluate({ ...base, approvals: [...base.approvals, ...granted.map((scope) => ({ scope }))] });
    }
    return decision;
  }

  async fire(event, payload, decision) {
    const empty = { results: [], decision };
    if (this.hooks.length === 0 || !Object.hasOwn(HOOK_EVENTS, event)) return empty;
    try {
      const out = await this.runHooks(event, payload, {
        hooks: this.hooks,
        decision,
        runId: this.run.runId,
        seq: this.seq,
        cwd: this.o.repoPath ?? this.o.workspaceRoot ?? this.run.repo.realpath,
        guardCtx: this.guardCtx(),
        ...(this.o.hookOptions ?? {}),
      });
      if (out.results.length > 0) this.append({ type: "hook.result", event, hooks: out.results.map(slimHook) });
      return out;
    } catch (error) {
      this.append({ type: "hook.result", event, error: cap(error?.message ?? error, 300) });
      if (decision && HOOK_EVENTS[event].blocking) {
        return { results: [], decision: makeDecision("deny", "HOOK_FAILED", "hooks-unavailable", { message: "the hooks could not be run, so the action is refused" }) };
      }
      return empty;
    }
  }

  recordDecision(point, decision, extra = {}) {
    this.lastDecision = { point, decision: decision.decision, reason: decision.reason, ruleId: decision.ruleId, message: decision.detail?.message ?? "" };
    this.append({
      type: "tool.decision",
      point,
      node: this.run.currentNode,
      decision: decision.decision,
      reason: decision.reason,
      ruleId: decision.ruleId,
      message: decision.detail?.message ?? "",
      scope: decision.detail?.scope ?? null,
      ...extra,
    });
  }

  /** A validate hook's require-approval has no scope of its own: give it one the guard-less path can match. */
  settle(decision, action) {
    if (decision.decision !== "require-approval" || decision.detail?.scope) return decision;
    const scope = { operation: String(decision.ruleId).slice(0, 128), target: canonicalAction(action) };
    if (this.run.approvals.some((approval) => approval.kind === "operation" && isValid(this.run, approval, this.policyHash) && approval.subjectHash === scopeHash(scope))) {
      return makeDecision("allow", "APPROVED", "scoped-approval", { message: "the hook's question has a valid scoped approval" });
    }
    return { ...decision, detail: { ...decision.detail, scope, scopes: [scope] } };
  }

  // -- approvals ------------------------------------------------------------------------------

  async requestOperation(scope, reason, requestedBy = "guard") {
    const result = requestApproval(this.run, { kind: "operation", scope, now: this.nowIso(), reason, requestedBy });
    for (const event of result.events) {
      this.append(event);
      await this.fire("approval.requested", { approvalId: result.approval.id, kind: "operation", scope: result.approval.scope, requestedBy });
    }
    return result.approval;
  }

  /**
   * The scope of a requested approval would not display faithfully (too long, control / invisible characters, text
   * that redaction rewrites): what a person would approve could differ from what they saw. No request is created;
   * the node ends policy-denied (UNDISPLAYABLE_TARGET, exit 7) and the decision is recorded.
   */
  async refuseUndisplayable(problem, pendingAction) {
    const decision = makeDecision("deny", "UNDISPLAYABLE_TARGET", "approval-display", { message: `no approval can be requested: ${problem}` });
    if (this.run.nodes[this.run.currentNode].status !== "running") await this.commit({ type: "enter" });
    if (this.run.status !== "active" || this.run.nodes[this.run.currentNode].status !== "running") return;
    this.recordDecision("approval", decision, { step: pendingAction?.step });
    return this.deny(decision, pendingAction);
  }

  async hold(decision, pendingAction) {
    const scopes = decision.detail?.scopes ?? (decision.detail?.scope ? [decision.detail.scope] : []);
    if (scopes.length === 0) return this.deny(decision, pendingAction);
    for (const scope of scopes) {
      const problem = displayProblem(scope);
      if (problem !== null) return this.refuseUndisplayable(problem, pendingAction);
    }
    const requestedBy = String(decision.ruleId).startsWith("hook:") ? "hook" : "guard";
    for (const scope of scopes) await this.requestOperation(scope, decision.reason, requestedBy);
    this.stopReason = decision.reason;
    await this.commit({ type: "pause", reason: `approval required: ${decision.reason}`, status: "waiting-approval" }, { step: pendingAction?.step, hold: true });
  }

  async deny(decision, pendingAction) {
    this.stopReason = decision.reason;
    await this.commit({ type: "complete", outcome: "policy-denied", signature: `policy-denied:${decision.reason}` }, { step: pendingAction?.step });
  }

  // -- budgets --------------------------------------------------------------------------------

  preBudget() {
    const used = this.run.budgets.used;
    const { iterations, wallMs, tokens } = this.limits;
    if (iterations > 0 && used.iterations >= iterations) return { name: "iterations", used: used.iterations, limit: iterations };
    if (wallMs > 0 && used.wallMs >= wallMs) return { name: "wallMs", used: used.wallMs, limit: wallMs };
    if (tokens > 0 && typeof used.tokens === "number" && used.tokens >= tokens) return { name: "tokens", used: used.tokens, limit: tokens };
    return this.nodeBudget();
  }

  /**
   * The per-node budgets (policy `autonomous.budgets.perNode`) of the current node. Tokens count measured usage only.
   * Iterations are per attempt and reset when the node is entered, so a resume check (`resume: true`) skips them.
   */
  nodeBudget({ resume = false } = {}) {
    const node = this.run.currentNode;
    const limits = this.nodeLimits;
    const used = this.run.budgets.used;
    if (!resume && limits.iterations > 0 && used.iterations >= limits.iterations) return { scope: "node", name: "iterations", used: used.iterations, limit: limits.iterations };
    const calls = this.nodeCalls[node] ?? 0;
    if (limits.toolCalls > 0 && calls >= limits.toolCalls) return { scope: "node", name: "toolCalls", used: calls, limit: limits.toolCalls };
    const tokens = this.nodeTokens[node];
    if (limits.tokens > 0 && typeof tokens === "number" && tokens >= limits.tokens) return { scope: "node", name: "tokens", used: tokens, limit: limits.tokens };
    return null;
  }

  async blockForBudget(hit, pendingAction) {
    const scope = hit.scope ?? "run";
    this.stopReason = "BUDGET_EXHAUSTED";
    this.append({ type: "budget.exhausted", scope, budget: hit.name, value: hit.used, limit: hit.limit, node: this.run.currentNode });
    if (this.run.nodes[this.run.currentNode].status !== "running") await this.commit({ type: "enter" });
    if (this.run.status === "active" && this.run.nodes[this.run.currentNode].status === "running") {
      await this.commit({ type: "complete", outcome: "blocked", signature: scope === "node" ? `budget:node.${hit.name}` : `budget:${hit.name}` }, { step: pendingAction?.step });
    }
  }

  // -- startup --------------------------------------------------------------------------------

  async start() {
    this.lock = acquireRunLock(this.dir, { fs: this.fs, ...(this.o.lockOptions ?? {}) });
    this.lock.startHeartbeat();
    let loaded = loadRun(this.dir, { fs: this.fs });
    if (loaded.torn) {
      repairTail(this.dir, { lockToken: this.lock.token, now: this.nowIso, fs: this.fs });
      loaded = loadRun(this.dir, { fs: this.fs });
    }
    const run = loaded.run;
    const wanted = this.graph;
    if (run.graph?.id !== wanted.id || run.graph?.version !== wanted.version || run.graph?.hash !== graphHash(wanted)) {
      throw new CliError(`This run belongs to ${run.graph?.id}@${run.graph?.version}, not ${wanted.id}@${wanted.version}.`, { code: "GRAPH_MISMATCH", exitCode: EXIT.CONFIG });
    }
    this.startStatus = run.status;
    this.cursor = deriveCursor(loaded.events);
    this.startMs = Date.parse(this.nowIso());
    this.run = loaded.behind > 0 ? foldEvents(run, this.graph, loaded.pending).run : run;
    this.seq = loaded.events.length;
    this.baseWallMs = this.run.budgets?.used?.wallMs ?? 0;
    if (loaded.behind > 0) this.append({ type: "ledger.folded", count: loaded.behind, fromSeq: loaded.pending[0].seq, toSeq: this.seq });
    const completed = completeInterruptedGroup(this.env(), this.run, loaded.events);
    this.run = completed.run;
    if (completed.seq !== null) this.seq = completed.seq;
    // A 0 token counter from run creation means "nothing reported yet"; once the ledger holds a measured total it is a real 0.
    if (this.run.budgets.used.tokens === 0 && !hasMeasuredTotal(loaded.events)) this.patchUsed({ tokens: null });
    for (const [node, bucket] of Object.entries(aggregateUsage(loaded.events).byNode)) if (bucket.tokens !== null) this.nodeTokens[node] = bucket.tokens;
    Object.assign(this.nodeCalls, toolCallsByNode(loaded.events));
  }

  /** Decide whether the run may continue. Returns false when it must stop right here. */
  async prepare() {
    const { status } = this.run;
    if (status === "completed" || status === "aborted") return false;
    if (this.run.policyHash == null) this.append({ type: "policy.bound", from: null, to: this.policyHash });
    const drift = typeof this.run.policyHash === "string" && this.run.policyHash !== this.policyHash;
    if (status === "active" && !drift) return true;
    // (With a policy change the pending requests are stale: the change is dealt with first, below.)
    if (!drift && status === "waiting-approval" && pendingApprovals(this.run).length > 0) {
      this.stopReason = "APPROVAL_PENDING";
      return false;
    }

    // The policy changed since the run started: a person has to accept that.
    if (drift) {
      const scope = { operation: "resume", target: `${this.run.policyHash}->${this.policyHash}` };
      const accepted = this.run.approvals.some((approval) => approval.kind === "operation" && approval.scope.operation === scope.operation && approval.scope.target === scope.target && approval.grantedAt !== null && approval.invalidatedAt === null && approval.subjectHash === scopeHash(scope));
      const asked = this.run.approvals.some((approval) => approval.kind === "operation" && approval.scope.operation === scope.operation && approval.scope.target === scope.target && approval.grantedAt === null && approval.invalidatedAt === null);
      if (!accepted && asked) {
        // Still waiting for the person: nothing new to record.
        this.stopReason = "STALE_APPROVAL";
        this.exitOverride = EXIT.APPROVAL_REQUIRED;
        return false;
      }
      if (!accepted) {
        const decision = evaluateResume(this.guardCtx(), { lockHeld: this.lock.lost !== true, runPolicyHash: this.run.policyHash });
        this.recordDecision("resume", decision);
        if (decision.decision === "require-approval") {
          await this.requestOperation(scope, "STALE_APPROVAL");
          this.stopReason = "STALE_APPROVAL";
          this.exitOverride = EXIT.APPROVAL_REQUIRED;
          if (status === "active") await this.commit({ type: "pause", reason: "approval required: STALE_APPROVAL", status: "waiting-approval" });
        } else {
          this.stopReason = decision.reason;
          this.exitOverride = decision.reason === "BUDGET_EXHAUSTED" ? EXIT.ERROR : EXIT.POLICY_DENIED;
        }
        return false;
      }
      this.append({ type: "policy.bound", from: this.run.policyHash, to: this.policyHash });
    }
    // Approvals that stopped matching (artifact or policy moved on) are retired explicitly.
    // A request still waiting for a person under the OLD policy can no longer be granted (run approve refuses it):
    // it is retired as well, and the run asks again under the new policy.
    for (const approval of [...this.run.approvals]) {
      const stale = approval.grantedAt !== null ? !isValid(this.run, approval, this.policyHash) : typeof approval.policyHash === "string" && approval.policyHash !== this.policyHash;
      if (approval.invalidatedAt === null && stale) {
        for (const event of invalidateApproval(this.run, approval.id, { now: this.nowIso(), cause: "no-longer-valid" }).events) this.append(event);
      }
    }
    if (status === "active") return true;
    if (status === "waiting-approval" && pendingApprovals(this.run).length > 0) {
      this.stopReason = "APPROVAL_PENDING";
      return false;
    }

    const views = this.run.approvals.filter((approval) => approval.grantedAt !== null && approval.invalidatedAt === null).map((approval) => ({ kind: approval.kind, valid: isValid(this.run, approval, this.policyHash) }));
    const decision = evaluateResume(this.guardCtx(), { lockHeld: this.lock.lost !== true, runPolicyHash: this.run.policyHash ?? undefined, approvals: views });
    this.recordDecision("resume", decision);
    if (decision.decision !== "allow") {
      this.stopReason = decision.reason;
      this.exitOverride = decision.decision === "require-approval" ? EXIT.APPROVAL_REQUIRED : decision.reason === "BUDGET_EXHAUSTED" ? EXIT.ERROR : EXIT.POLICY_DENIED;
      return false;
    }
    // The guard only knows the run-level budgets: a node still over its own budget is refused the same way.
    const nodeHit = this.nodeBudget({ resume: true });
    if (nodeHit) {
      this.recordDecision("resume", makeDecision("deny", "BUDGET_EXHAUSTED", `budget-node-${nodeHit.name}`, { message: `the ${nodeHit.name} budget of node '${this.run.currentNode}' is exhausted (${nodeHit.used}/${nodeHit.limit})`, budget: nodeHit }));
      this.stopReason = "BUDGET_EXHAUSTED";
      this.exitOverride = EXIT.ERROR;
      return false;
    }
    await this.commit({ type: "resume" });
    return this.run.status === "active";
  }

  // -- the loop -------------------------------------------------------------------------------

  async interrupt() {
    this.stopReason = "INTERRUPTED";
    if (this.run.status === "active") await this.commit({ type: "pause", reason: "interrupted", status: "paused" });
  }

  async main() {
    await this.start();
    if (!(await this.prepare())) return;
    await this.fire("run.started", { status: this.run.status, node: this.run.currentNode });
    const resumed = this.run.nodes[this.run.currentNode]?.status === "running" && ["active", "paused"].includes(this.startStatus);
    if (resumed) {
      const attempt = this.run.nodes[this.run.currentNode].attemptLog.at(-1);
      this.append({ type: "node.recovered", node: this.run.currentNode, attempt: attempt?.n ?? null, reason: "interrupted-attempt", continued: true });
    }
    for (let turn = 0; ; turn += 1) {
      if (turn > MAX_TURNS) throw new CliError("The run loop made no progress.", { code: "LOOP_RUNAWAY", exitCode: EXIT.ERROR });
      if (this.userAborted()) return this.interrupt();
      if (this.run.status !== "active" || Object.hasOwn(this.graph.terminals, this.run.currentNode)) return;
      const rec = this.run.nodes[this.run.currentNode];
      if (rec.status === "running") await this.iteration();
      else await this.enterNode();
    }
  }

  async enterNode() {
    const id = this.run.currentNode;
    const def = this.graph.nodes[id];
    const rec = this.run.nodes[id];
    if (def.kind === "approval") return this.approvalNode(id, def);
    const hooked = await this.enterHook(id, rec);
    if (hooked.decision === "require-approval") {
      // A validate hook asked a question before the node starts: hold BEFORE entering (nothing is half-started).
      this.recordDecision("node.before-enter", hooked);
      return this.hold(hooked, null);
    }
    let retry = null;
    if (rec.attempts > 0) {
      const signatures = rec.failureSignatures;
      retry = evaluateRetry(this.guardCtx(), { node: id, attempts: rec.attempts, maxAttempts: rec.maxAttempts, signature: signatures.at(-1), signatureCounts: signatureCounts(signatures) });
      this.recordDecision("retry", retry);
    }
    await this.commit({ type: "enter" });
    if (this.run.status !== "active" || this.run.nodes[id].status !== "running") return;
    this.malformed = 0;
    this.feedback = null;
    if (isBlocking(hooked)) {
      this.recordDecision("node.before-enter", hooked);
      return this.deny(hooked);
    }
    if (retry && isBlocking(retry) && retry.ruleId !== "attempts-exhausted") {
      if (retry.reason === "BUDGET_EXHAUSTED") return this.blockForBudget({ name: retry.detail?.budget?.name ?? retry.ruleId, used: retry.detail?.budget?.used ?? 0, limit: retry.detail?.budget?.limit ?? 0 });
      return this.deny(retry);
    }
  }

  /**
   * The node.before-enter hooks. Returns the decision: a hook can tighten it (deny, or require-approval, which gets a
   * scope of its own: the hook and the node attempt, so a retry asks again).
   */
  async enterHook(id, rec) {
    const attempt = rec.attempts + 1;
    const hooked = await this.fire("node.before-enter", { node: id, attempt }, makeDecision("allow", "ALLOWED", "allow", { message: "no hook objected" }));
    const decision = hooked.decision ?? makeDecision("allow", "ALLOWED", "allow", { message: "no hook objected" });
    return decision.decision === "require-approval" ? this.settle(decision, { type: "enter", node: id, attempt }) : decision;
  }

  async approvalNode(id, def) {
    const hook = await this.enterHook(id, this.run.nodes[id]);
    if (hook.decision === "require-approval") {
      this.recordDecision("node.before-enter", hook);
      return this.hold(hook, null);
    }
    if (isBlocking(hook)) {
      // The node cannot be left half-entered: enter it and stop it.
      await this.commit({ type: "enter" });
      if (this.run.status !== "active" || this.run.nodes[id].status !== "running") return;
      this.recordDecision("node.before-enter", hook);
      return this.deny(hook);
    }
    const artifact = def.dependsOn?.[0] ?? null;
    const candidates = this.run.approvals.filter((approval) => approval.kind === "plan" && approval.grantedAt !== null && approval.invalidatedAt === null);
    const views = candidates.map((approval) => ({ kind: approval.kind, valid: isValid(this.run, approval, this.policyHash) && approval.artifact === artifact }));
    // The guard's plan-approval rule is keyed on the node named "approve"; every approval-kind node gets it here.
    const decision = evaluateAdvancement(this.guardCtx(), { node: "approve", outcome: "pass", approvals: views });
    this.recordDecision("advancement", decision, { node: id });
    if (decision.decision === "allow") {
      const index = views.findIndex((view) => view.valid);
      const approval = candidates[index];
      await this.commit({ type: "approve", by: approval.by.name, summary: `plan approved (${approval.id}, subject ${approval.subjectHash.slice(0, 12)})` });
      return;
    }
    if (decision.decision === "require-approval") {
      const result = requestApproval(this.run, { kind: "plan", scope: { operation: "plan", target: id }, artifact, now: this.nowIso(), reason: decision.reason, requestedBy: "guard" });
      for (const event of result.events) {
        this.append(event);
        await this.fire("approval.requested", { approvalId: result.approval.id, kind: "plan", scope: result.approval.scope });
      }
      this.stopReason = decision.reason;
      await this.commit({ type: "pause", reason: `approval required: ${decision.reason}`, status: "waiting-approval" });
      return;
    }
    // deny / unavailable: the node cannot be left half-entered, so enter it and stop it.
    await this.commit({ type: "enter" });
    if (this.run.status !== "active" || this.run.nodes[id].status !== "running") return;
    if (decision.reason === "BUDGET_EXHAUSTED") return this.blockForBudget({ name: decision.detail?.budget?.name ?? "budget", used: decision.detail?.budget?.used ?? 0, limit: decision.detail?.budget?.limit ?? 0 });
    return this.deny(decision);
  }

  execCtx(step, attempt, signal) {
    return {
      runId: this.run.runId,
      goal: this.run.goal,
      node: this.run.currentNode,
      attempt: attempt.n,
      step,
      iteration: this.run.budgets.used.iterations,
      signal,
      feedback: this.feedback,
      lastResult: this.lastResult,
      approvals: this.run.approvals.filter((approval) => isValid(this.run, approval, this.policyHash)).map((approval) => ({ id: approval.id, kind: approval.kind, scope: approval.scope })),
    };
  }

  async reject(step, attempt, errors, node = this.run.currentNode) {
    this.append({ type: "action.rejected", node, step, attempt: attempt.n, errors: errors.slice(0, 10).map((message) => cap(message, 300)) });
    this.feedback = errors.slice(0, 3).join("; ");
    this.malformed += 1;
    if (this.malformed > MAX_REASKS) {
      this.malformed = 0;
      await this.commit({ type: "complete", outcome: "fail-retryable", signature: "executor:malformed-output" });
    }
  }

  async iteration() {
    const step = this.openStep();
    try {
      return await this.iterate(step.signal);
    } finally {
      step.close();
    }
  }

  async iterate(signal) {
    const id = this.run.currentNode;
    const attempt = this.run.nodes[id].attemptLog.at(-1);
    let pending = this.cursor.pending;
    if (pending && (pending.node !== id || pending.attempt !== attempt.n)) {
      this.cursor.pending = null;
      pending = null;
    }
    const exhausted = this.preBudget();
    if (exhausted) return this.blockForBudget(exhausted, pending);
    this.patchUsed({ iterations: this.run.budgets.used.iterations + 1 });
    if (pending) return this.resumePending(pending, signal);

    const step = this.cursor.steps[id] ?? 0;
    const ctx = this.execCtx(step, attempt, signal);
    let raw;
    try {
      const observation = await abortable(this.executor.observe(ctx), signal);
      raw = await abortable(this.executor.decide(ctx, observation), signal);
    } catch (error) {
      this.recordUsage(ctx); // an executor that failed or was cut off may still have used tokens
      if (this.userAborted()) return;
      return this.reject(step, attempt, [error?.name === "TimeoutError" ? "executor: the step deadline was exceeded" : "executor: failed to produce an action"]);
    }
    this.recordUsage(ctx);
    if (this.userAborted()) return;
    const verdict = validateAction(raw);
    if (!verdict.ok) return this.reject(step, attempt, verdict.errors);

    const action = verdict.action;
    const key = actionKey({ runId: this.run.runId, node: id, attempt: attempt.n, stepIndex: step, action });
    let hints = {};
    try {
      hints = this.executor.describe?.(ctx, action) ?? {};
    } catch {
      hints = {};
    }
    // The executor is untrusted: it may only DOWNGRADE (idempotent: false), never declare a shell / git / deploy /
    // edit action repeatable. A repeatable action is re-run after a crash; anything else stops for a human.
    const idempotent = defaultIdempotent(action) && hints.idempotent !== false;
    this.append({ type: "action.proposed", node: id, step, attempt: attempt.n, key, idempotent, action, ...(hints.delayMs ? { delayMs: hints.delayMs } : {}) });
    return this.perform({ ...this.cursor.pending, delayMs: hints.delayMs }, signal);
  }

  /**
   * Record what the executor says it used as a `usage` event (applyLoopEvent adds its total to the token counter).
   * The executor is untrusted: a report with unknown fields or out-of-range values is rejected as a whole
   * (`usage.rejected`, paths only) and counts for nothing; a report that measured nothing records nothing.
   */
  recordUsage(ctx) {
    let raw = null;
    try {
      raw = this.executor.usage?.(ctx) ?? null;
    } catch {
      raw = null;
    }
    if (raw === null) return;
    const node = this.run.currentNode;
    const verdict = normalizeUsageReport(raw);
    if (!verdict.ok) {
      this.append({ type: "usage.rejected", node, attempt: ctx.attempt, errors: verdict.errors.map((message) => cap(message, 200)) });
      return;
    }
    const event = buildUsageEvent({ node, attempt: ctx.attempt, source: "executor", report: verdict.report });
    if (event === null) return;
    this.append(event);
    const total = eventTotal(event);
    if (total !== null) this.nodeTokens[node] = (this.nodeTokens[node] ?? 0) + total;
  }

  async resumePending(pending, signal) {
    if (!pending.started) return this.perform(pending, signal);
    const intact = actionKey({ runId: this.run.runId, node: pending.node, attempt: pending.attempt, stepIndex: pending.step, action: pending.action }) === pending.key;
    const base = { type: "node.recovered", node: pending.node, attempt: pending.attempt, step: pending.step, key: pending.key };
    if (this.cursor.completedKeys.has(pending.key)) {
      this.append({ ...base, reason: "ALREADY_COMPLETED", skipped: true });
      this.cursor.pending = null;
      return;
    }
    if (pending.idempotent && intact && pending.action.type === "tool") {
      this.append({ ...base, reason: "IDEMPOTENT_RERUN", rerun: true });
      return this.perform(pending, signal);
    }
    this.append({ ...base, reason: "SIDE_EFFECT_UNKNOWN" });
    this.stopReason = "SIDE_EFFECT_UNKNOWN";
    await this.commit({ type: "complete", outcome: "needs-human", signature: "side-effect-unknown" }, { step: pending.step });
  }

  async perform(pending, signal) {
    const { action } = pending;
    switch (action.type) {
      case "evidence":
        return this.apply(pending, { type: "evidence", ...action.evidence });
      case "complete":
        return this.performComplete(pending);
      case "request-approval": {
        const problem = displayProblem(action.approval);
        if (problem !== null) return this.refuseUndisplayable(problem, pending);
        await this.requestOperation(action.approval, "requested by the executor", "executor");
        this.stopReason = "APPROVAL_REQUESTED";
        await this.commit({ type: "pause", reason: "approval requested by the executor", status: "waiting-approval" }, { step: pending.step });
        return;
      }
      case "wait": {
        try {
          await abortable(this.sleep(action.ms ?? 0, signal), signal);
        } catch {
          if (this.userAborted()) return;
        }
        this.append({ type: "action.completed", node: pending.node, step: pending.step, attempt: pending.attempt, key: pending.key, result: { ok: true, waitedMs: action.ms ?? 0 } });
        this.malformed = 0;
        return;
      }
      default:
        return this.performTool(pending, signal);
    }
  }

  /** Apply a reducer input for an executor action; a reducer rejection is bad executor output, not a crash. */
  async apply(pending, input) {
    try {
      await this.commit(input, { step: pending.step });
      this.malformed = 0;
    } catch (error) {
      if (!(error instanceof GraphError)) throw error;
      const attempt = this.run.nodes[pending.node].attemptLog.at(-1);
      await this.reject(pending.step, attempt, [`${error.code}: ${error.message}`], pending.node);
    }
  }

  async performComplete(pending) {
    const { outcome, signature } = pending.action;
    if (outcome !== "pass") return this.apply(pending, { type: "complete", outcome, ...(signature === undefined ? {} : { signature }) });
    const decision = evaluateAdvancement(this.guardCtx(), { node: pending.node, outcome, approvals: [] });
    this.recordDecision("advancement", decision, { step: pending.step });
    if (decision.decision === "allow") return this.apply(pending, { type: "complete", outcome: "pass" });
    if (decision.reason === "BUDGET_EXHAUSTED") return this.blockForBudget({ name: decision.detail?.budget?.name ?? "budget", used: decision.detail?.budget?.used ?? 0, limit: decision.detail?.budget?.limit ?? 0 }, pending);
    if (decision.decision === "require-approval") return this.hold(decision, pending);
    return this.deny(decision, pending);
  }

  async performTool(pending, signal) {
    const { action } = pending;
    const toolName = action.tool.name;
    let decision = this.guarded((ctx) => {
      const dispatch = evaluateDispatch(action, ctx);
      return dispatch.decision === "allow" && dispatch.detail?.mutating === true ? evaluateMutation(action, ctx) : dispatch;
    });
    const hooked = await this.fire("tool.before", { node: pending.node, step: pending.step, tool: toolName, input: action.tool.input }, decision);
    decision = this.settle(hooked.decision ?? decision, action);
    this.recordDecision("dispatch", decision, { step: pending.step, tool: toolName });

    if (decision.decision === "allow") return this.dispatch(pending, signal);
    if (decision.reason === "BUDGET_EXHAUSTED") return this.blockForBudget({ name: decision.detail?.budget?.name ?? "toolCalls", used: decision.detail?.budget?.used ?? 0, limit: decision.detail?.budget?.limit ?? 0 }, pending);
    if (decision.decision === "require-approval") return this.hold(decision, pending);
    return this.deny(decision, pending);
  }

  async dispatch(pending, signal) {
    const { action } = pending;
    if (this.userAborted()) return;
    this.patchUsed({ toolCalls: this.run.budgets.used.toolCalls + 1 });
    this.nodeCalls[pending.node] = (this.nodeCalls[pending.node] ?? 0) + 1;
    this.append({ type: "action.started", node: pending.node, step: pending.step, attempt: pending.attempt, key: pending.key });
    const ctx = { runId: this.run.runId, node: pending.node, attempt: pending.attempt, step: pending.step, key: pending.key, signal, sleep: this.sleep, delayMs: pending.delayMs, workspaceRoot: this.o.workspaceRoot ?? this.run.repo.realpath };
    let result;
    try {
      result = await abortable(this.dispatcher.dispatch(action, ctx), signal);
    } catch (error) {
      if (this.userAborted()) return; // left started-without-completed on purpose: resume decides what to do
      result = { ok: false, error: error?.name === "TimeoutError" ? "the step deadline was exceeded" : `dispatch failed: ${error?.message ?? error}` };
    }
    result = normalizeResult(result);
    this.append({ type: "action.completed", node: pending.node, step: pending.step, attempt: pending.attempt, key: pending.key, result });
    this.malformed = 0;
    this.lastResult = result;
    await this.fire("tool.after", { node: pending.node, step: pending.step, tool: action.tool.name, ok: result.ok });
    if (typeof this.executor.verify !== "function") return;
    let verification;
    try {
      verification = await abortable(this.executor.verify(this.execCtx(pending.step, this.run.nodes[pending.node].attemptLog.at(-1), signal), result), signal);
    } catch {
      if (this.userAborted()) return;
      verification = { ok: false, reason: "verification failed" };
    }
    this.append({ type: "action.verified", node: pending.node, step: pending.step, ok: verification?.ok === true, reason: cap(verification?.reason ?? "", 300) });
    this.feedback = verification?.ok === false ? cap(verification.reason ?? "verification failed", 300) : null;
    for (const evidence of Array.isArray(verification?.evidence) ? verification.evidence : []) {
      const checked = validateAction({ v: 1, type: "evidence", evidence });
      if (!checked.ok) continue;
      try {
        await this.commit({ type: "evidence", ...checked.action.evidence });
      } catch (error) {
        if (!(error instanceof GraphError)) throw error;
      }
    }
  }

  result() {
    const run = this.run;
    const exitCode = this.exitOverride ?? exitCodeFor(run);
    return {
      status: run.status,
      exitCode,
      run,
      reason: this.stopReason,
      decision: this.lastDecision,
      pendingApprovals: pendingApprovals(run),
      usage: { tokens: run.budgets.used.tokens ?? null },
      seq: this.seq,
    };
  }
}

/**
 * Drive one run until it completes, stops for a person, is blocked, or is interrupted.
 *
 * @param {object} options
 * @param {string} options.dir        Run directory (ledger.runDir / createRunForGraph).
 * @param {object} options.graph      The defined graph the run was created with.
 * @param {object} options.executor   See executor.mjs.
 * @param {object} [options.dispatcher]  ToolDispatcher; default: simulated (no real side effects).
 * @param {object} [options.policy] @param {string} [options.policyHash]  From policy.loadPolicy (default: supervised).
 * @param {Array|{hooks: Array}} [options.hooks]  From hooks.loadHooks.
 * @param {object} [options.hookOptions]  Forwarded to runHooks (run, resolve, env, platform, killGraceMs).
 * @param {Function} [options.runHooks]   Seam replacing hooks.runHooks.
 * @param {{iterations?, toolCalls?, tokens?, wallMs?}} [options.budgets]  Overrides of the defaults.
 * @param {AbortSignal} [options.signal]  Abort => the run is paused and the call returns exit 130.
 * @param {() => string} [options.now]    ISO timestamps (default the real clock). Also drives wall-time accounting.
 * @param {(ms: number, signal?: AbortSignal) => Promise<void>} [options.sleep]
 * @param {string} [options.repoPath] @param {string} [options.workspaceRoot] @param {string} [options.branch]
 * @param {number} [options.stepMs]       Per-step deadline.
 * @param {object} [options.guardOptions] Extra guard context (platform, homedir, userDir, env, branchOf, ...).
 * @param {object} [options.lockOptions]  Forwarded to acquireRunLock. @param {typeof nodeFs} [options.fs]
 * @returns {Promise<{status: string, exitCode: number, run: object, reason: string|null, decision: object|null,
 *   pendingApprovals: object[], usage: {tokens: number|null}, seq: number}>}
 * @throws {CliError} RUN_LOCKED (exit 1) when another live process drives the run
 */
export async function runLoop(options) {
  if (!isObject(options) || typeof options.dir !== "string" || !isObject(options.graph)) throw new TypeError("runLoop needs { dir, graph, executor }");
  assertExecutor(options.executor);
  const session = new Session(options);
  try {
    await session.main();
    if (session.run) await session.fire("run.finished", { status: session.run.status });
    return session.result();
  } finally {
    session.lock?.release();
  }
}
