#!/usr/bin/env node

// State/control-plane for `/asterweave:complete-project`: repository-wide, multi-module
// completion runs executed as dependency-ordered waves of isolated parallel workers.
// Mirrors graph-state.mjs conventions (atomic writes, an append-only event ledger, a small CLI)
// but models a run/module/dependency-graph/wave/worker/lock shape instead of a single linear
// graph, because a completion run coordinates several concurrent writers instead of one.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { findOverlap } from "./lib/glob-match.mjs";

export const PHASE_ORDER = [
  "discovery",
  "gap-analysis",
  "dependency-analysis",
  "wave-planning",
  "awaiting-approval",
  "implementation",
  "module-verification",
  "integration-verification",
  "report",
  "done",
];

export const MODULE_STATUSES = new Set(["COMPLETE", "PARTIAL", "BROKEN", "MISSING", "UNKNOWN"]);
export const GAP_PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
export const WORKER_STATUSES = ["pending", "implementing", "verifying", "code-review", "blocked", "complete", "failed"];
const ACTIVE_WORKER_STATUSES = new Set(["pending", "implementing", "verifying", "code-review"]);

export const WORKER_OUTCOMES = new Set([
  "pass",
  "implementation-failure",
  "test-failure",
  "dependency-discovered",
  "ownership-conflict",
  "shared-code-required",
  "environment-failure",
  "needs-human",
]);

export const LOCK_DECISIONS = new Set([
  "approve-exclusive-lock",
  "create-shared-workstream",
  "defer-until-next-wave",
  "replan-dependencies",
]);

const DEFAULT_MAX_WORKERS = 3;

function now() {
  return new Date().toISOString();
}

function runsRoot(cwd) {
  return resolve(cwd, ".claude", "asterweave", "completion");
}

function runDirectory(runId, cwd) {
  return resolve(runsRoot(cwd), runId);
}

function runPaths(runId, cwd) {
  const directory = runDirectory(runId, cwd);
  return {
    directory,
    state: resolve(directory, "state.json"),
    events: resolve(directory, "events.jsonl"),
    modules: resolve(directory, "modules.json"),
    graph: resolve(directory, "dependency-graph.json"),
    waves: resolve(directory, "waves.json"),
    workersDirectory: resolve(directory, "workers"),
    locks: resolve(directory, "locks.json"),
    integration: resolve(directory, "integration.json"),
    finalAudit: resolve(directory, "final-audit.json"),
  };
}

function atomicWrite(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    renameSync(temporary, file);
  } catch (error) {
    if (existsSync(file)) {
      unlinkSync(file);
      renameSync(temporary, file);
    } else {
      throw error;
    }
  }
}

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8"));
}

function appendEvent(runId, cwd, event) {
  const paths = runPaths(runId, cwd);
  mkdirSync(dirname(paths.events), { recursive: true });
  appendFileSync(paths.events, `${JSON.stringify({ at: now(), runId, ...event })}\n`, { mode: 0o600 });
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { positional, options };
}

function slugify(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "run";
}

// ---------------------------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------------------------

export function loadRun(runId, cwd = process.cwd()) {
  const paths = runPaths(runId, cwd);
  if (!existsSync(paths.state)) throw new Error(`No completion run '${runId}'. Run 'init' first.`);
  return JSON.parse(readFileSync(paths.state, "utf8"));
}

function saveRun(state, cwd, event) {
  state.updatedAt = now();
  const paths = runPaths(state.runId, cwd);
  atomicWrite(paths.state, state);
  if (event) appendEvent(state.runId, cwd, event);
  return state;
}

export function listRuns(cwd = process.cwd()) {
  const root = runsRoot(cwd);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((runId) => existsSync(runPaths(runId, cwd).state))
    .map((runId) => loadRun(runId, cwd))
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
}

/** Detects an existing run this command should resume instead of duplicating, per
 * the mission's resumability requirement: prefer the most recently updated run that is not
 * finished. */
export function findActiveRun(cwd = process.cwd()) {
  const runs = listRuns(cwd).filter((run) => run.status === "active" || run.status === "blocked");
  return runs.length ? runs[runs.length - 1] : null;
}

export function initRun({ goal = null, maxWorkers = DEFAULT_MAX_WORKERS, cwd = process.cwd(), force = false } = {}) {
  const existing = findActiveRun(cwd);
  if (existing && !force) {
    throw new Error(
      `Completion run ${existing.runId} is still ${existing.status} at phase '${existing.phase}'. Resume it, abort it, or pass --force.`,
    );
  }
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) throw new Error("--max-workers must be a positive integer.");
  const timestamp = now();
  const runId = `project-completion-${timestamp.replace(/[:.]/g, "").replace("Z", "Z")}`;
  const state = {
    schemaVersion: 1,
    runId,
    goal: goal ? String(goal).trim() : null,
    status: "active",
    phase: "discovery",
    maxWorkers,
    currentWave: 0,
    approvals: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const paths = runPaths(runId, cwd);
  mkdirSync(paths.workersDirectory, { recursive: true });
  writeFileSync(paths.events, "", { mode: 0o600 });
  atomicWrite(paths.modules, []);
  atomicWrite(paths.graph, { nodes: [], edges: [] });
  atomicWrite(paths.waves, []);
  atomicWrite(paths.locks, []);
  return saveRun(state, cwd, { type: "run.initialized", goal: state.goal, maxWorkers });
}

function assertActive(state) {
  if (state.status !== "active") throw new Error(`Run ${state.runId} is ${state.status}, not active.`);
}

export function setPhase(runId, phase, cwd = process.cwd()) {
  if (!PHASE_ORDER.includes(phase)) throw new Error(`Unknown phase: ${phase}`);
  const state = loadRun(runId, cwd);
  assertActive(state);
  const previous = state.phase;
  state.phase = phase;
  if (phase === "done") state.status = "completed";
  return saveRun(state, cwd, { type: "phase.changed", from: previous, to: phase });
}

export function approveWavePlan({ runId, by, summary, cwd = process.cwd() }) {
  if (!by?.trim() || !summary?.trim()) throw new Error("Approval requires --by and --summary.");
  const state = loadRun(runId, cwd);
  assertActive(state);
  state.approvals.push({ by: by.trim(), summary: summary.trim(), approvedAt: now() });
  saveRun(state, cwd, { type: "approval.recorded", by: by.trim(), summary: summary.trim() });
  return setPhase(runId, "implementation", cwd);
}

export function pauseRun(runId, reason, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  assertActive(state);
  state.status = "blocked";
  return saveRun(state, cwd, { type: "run.paused", reason: reason || "Paused by user" });
}

export function resumeRun(runId, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  if (state.status !== "blocked") throw new Error(`Run ${state.runId} is ${state.status}; only a blocked run can resume.`);
  state.status = "active";
  return saveRun(state, cwd, { type: "run.resumed", phase: state.phase });
}

export function abortRun(runId, reason, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  state.status = "aborted";
  return saveRun(state, cwd, { type: "run.aborted", reason: reason || "Aborted by user" });
}

export function completeRun(runId, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  state.status = "completed";
  state.phase = "done";
  return saveRun(state, cwd, { type: "run.completed" });
}

// ---------------------------------------------------------------------------------------------
// Modules (gap inventory) and the dependency graph
// ---------------------------------------------------------------------------------------------

export function setModules(runId, modules, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  assertActive(state);
  if (!Array.isArray(modules) || modules.length === 0) throw new Error("modules must be a non-empty array.");
  const seen = new Set();
  for (const module of modules) {
    if (!module.id?.trim() || !module.name?.trim()) throw new Error("Every module requires id and name.");
    if (seen.has(module.id)) throw new Error(`Duplicate module id: ${module.id}`);
    seen.add(module.id);
    if (!MODULE_STATUSES.has(module.status)) {
      throw new Error(`Module ${module.id}: status must be one of ${[...MODULE_STATUSES].join(", ")}.`);
    }
    if (module.completionEstimate != null) {
      const estimate = Number(module.completionEstimate);
      if (!Number.isFinite(estimate) || estimate < 0 || estimate > 100) {
        throw new Error(`Module ${module.id}: completionEstimate must be 0-100.`);
      }
    }
    for (const gap of module.gaps || []) {
      if (!gap.id?.trim() || !gap.description?.trim()) throw new Error(`Module ${module.id}: every gap requires id and description.`);
      if (!GAP_PRIORITIES.has(gap.priority)) throw new Error(`Module ${module.id}: gap ${gap.id} priority must be P0-P3.`);
    }
  }
  atomicWrite(runPaths(runId, cwd).modules, modules);
  saveRun(state, cwd, { type: "modules.recorded", count: modules.length });
  return modules;
}

export function getModules(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).modules, []);
}

/** Rejects a dependency graph containing a cycle among blocking edges, which would make wave
 * planning impossible (no ordering could satisfy every blocking dependency). */
function assertAcyclicBlocking(nodes, edges) {
  const adjacency = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    if (edge.type !== "blocking") continue;
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
  }
  const state = new Map(); // 0 = unvisited, 1 = visiting, 2 = done
  const path = [];
  function visit(id) {
    const mark = state.get(id) ?? 0;
    if (mark === 2) return null;
    if (mark === 1) return [...path.slice(path.indexOf(id)), id];
    state.set(id, 1);
    path.push(id);
    for (const next of adjacency.get(id) || []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }
    path.pop();
    state.set(id, 2);
    return null;
  }
  for (const node of nodes) {
    const cycle = visit(node.id);
    if (cycle) throw new Error(`Dependency graph has a blocking cycle: ${cycle.join(" -> ")}`);
  }
}

export function setDependencyGraph(runId, graph, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  assertActive(state);
  const nodes = graph?.nodes || [];
  const edges = graph?.edges || [];
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error("graph requires nodes[] and edges[].");
  const ids = new Set(nodes.map((node) => node.id));
  for (const node of nodes) if (!node.id?.trim()) throw new Error("Every graph node requires an id.");
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) {
      throw new Error(`Edge ${edge.from} -> ${edge.to} references an unknown node.`);
    }
    if (!["blocking", "non-blocking"].includes(edge.type)) {
      throw new Error(`Edge ${edge.from} -> ${edge.to}: type must be 'blocking' or 'non-blocking'.`);
    }
  }
  assertAcyclicBlocking(nodes, edges);
  atomicWrite(runPaths(runId, cwd).graph, { nodes, edges });
  saveRun(state, cwd, { type: "dependency-graph.recorded", nodes: nodes.length, edges: edges.length });
  return { nodes, edges };
}

export function getDependencyGraph(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).graph, { nodes: [], edges: [] });
}

// ---------------------------------------------------------------------------------------------
// Waves
// ---------------------------------------------------------------------------------------------

/** Confirms every blocking dependency between workstreams is satisfied by wave ordering:
 * a workstream depending on another must be scheduled in a strictly later wave. This is the
 * mandatory dependency-aware parallel-safety check the mission requires before any wave is
 * approved for execution. */
export function validateWaves(waves, graph) {
  const waveOf = new Map();
  const workstreamModules = new Map();
  for (const wave of waves) {
    for (const workstream of wave.workstreams || []) {
      if (waveOf.has(workstream.id)) throw new Error(`Duplicate workstream id across waves: ${workstream.id}`);
      waveOf.set(workstream.id, wave.wave);
      workstreamModules.set(workstream.id, new Set(workstream.modules || []));
    }
  }
  for (const wave of waves) {
    for (const workstream of wave.workstreams || []) {
      for (const dependsOn of workstream.dependsOn || []) {
        const dependencyWave = waveOf.get(dependsOn);
        if (dependencyWave == null) throw new Error(`Workstream ${workstream.id} depends on unknown workstream ${dependsOn}.`);
        if (dependencyWave >= wave.wave) {
          throw new Error(
            `Workstream ${workstream.id} (wave ${wave.wave}) depends on ${dependsOn} (wave ${dependencyWave}); the dependency must be in a strictly earlier wave.`,
          );
        }
      }
    }
  }
  // Cross-check module-level blocking edges against the workstream each module was assigned to.
  const moduleOwner = new Map();
  for (const [workstreamId, modules] of workstreamModules) {
    for (const moduleId of modules) moduleOwner.set(moduleId, workstreamId);
  }
  for (const edge of graph?.edges || []) {
    if (edge.type !== "blocking") continue;
    const fromWorkstream = moduleOwner.get(edge.from);
    const toWorkstream = moduleOwner.get(edge.to);
    if (!fromWorkstream || !toWorkstream || fromWorkstream === toWorkstream) continue;
    const fromWave = waveOf.get(fromWorkstream);
    const toWave = waveOf.get(toWorkstream);
    if (fromWave == null || toWave == null) continue;
    if (fromWave >= toWave) {
      throw new Error(
        `Module ${edge.to} (workstream ${toWorkstream}, wave ${toWave}) blocks on ${edge.from} (workstream ${fromWorkstream}, wave ${fromWave}); reorder the waves.`,
      );
    }
  }
  return true;
}

export function setWaves(runId, waves, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  assertActive(state);
  if (!Array.isArray(waves) || waves.length === 0) throw new Error("waves must be a non-empty array.");
  for (const wave of waves) {
    if (!Number.isInteger(wave.wave) || wave.wave < 1) throw new Error("Every wave requires a positive integer 'wave'.");
    if (!Array.isArray(wave.workstreams) || wave.workstreams.length === 0) {
      throw new Error(`Wave ${wave.wave} must list at least one workstream.`);
    }
  }
  const graph = getDependencyGraph(runId, cwd);
  validateWaves(waves, graph);
  atomicWrite(runPaths(runId, cwd).waves, waves);
  saveRun(state, cwd, { type: "waves.recorded", waves: waves.length });
  return waves;
}

export function getWaves(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).waves, []);
}

// ---------------------------------------------------------------------------------------------
// Workers
// ---------------------------------------------------------------------------------------------

function workerPath(runId, workerId, cwd) {
  return resolve(runPaths(runId, cwd).workersDirectory, `${slugify(workerId)}.json`);
}

export function listWorkers(runId, cwd = process.cwd()) {
  const directory = runPaths(runId, cwd).workersDirectory;
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .map((name) => JSON.parse(readFileSync(resolve(directory, name), "utf8")))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function getWorker(runId, workerId, cwd = process.cwd()) {
  const path = workerPath(runId, workerId, cwd);
  if (!existsSync(path)) throw new Error(`No worker '${workerId}' in run ${runId}.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function saveWorker(worker, cwd) {
  worker.updatedAt = now();
  atomicWrite(workerPath(worker.runId, worker.id, cwd), worker);
  appendEvent(worker.runId, cwd, { type: "worker.updated", worker: worker.id, status: worker.status });
  return worker;
}

/** Initializes a pending worker record for one workstream. Enforces two safety properties before
 * any writer touches disk: the run's configured concurrency limit, and that this worker's write
 * ownership does not overlap another still-active worker's write ownership (an ownership
 * conflict caught at plan time is far cheaper than one discovered mid-implementation). */
export function initWorker(runId, {
  id,
  module,
  wave,
  ownership = {},
  tasks = [],
  cwd = process.cwd(),
} = {}) {
  const state = loadRun(runId, cwd);
  assertActive(state);
  if (!id?.trim() || !module?.trim()) throw new Error("worker init requires id and module.");
  if (existsSync(workerPath(runId, id, cwd))) throw new Error(`Worker '${id}' already exists in run ${runId}.`);

  const existingWorkers = listWorkers(runId, cwd);
  const activeCount = existingWorkers.filter((worker) => ACTIVE_WORKER_STATUSES.has(worker.status)).length;
  if (activeCount >= state.maxWorkers) {
    throw new Error(`Concurrency limit reached: ${activeCount}/${state.maxWorkers} workers already active in run ${runId}.`);
  }

  const write = ownership.write || [];
  for (const other of existingWorkers) {
    if (other.status === "complete" || other.status === "failed") continue;
    const overlap = findOverlap(write, other.ownership?.write || []);
    if (overlap) {
      throw new Error(
        `Worker '${id}' write ownership '${overlap.a}' overlaps active worker '${other.id}' ownership '${overlap.b}'. Narrow the ownership paths or serialize these workstreams.`,
      );
    }
  }

  const worker = {
    schemaVersion: 1,
    runId,
    id,
    module,
    wave: wave ?? null,
    status: "pending",
    attempts: 0,
    branch: null,
    worktree: null,
    ownership: {
      write: ownership.write || [],
      read: ownership.read || [],
      deny: ownership.deny || [],
      shared: ownership.shared || [],
      approvedShared: [],
    },
    tasks,
    completedTasks: [],
    deferredTasks: [],
    filesChanged: [],
    verification: null,
    reviews: null,
    outcome: null,
    knownRisks: [],
    integrationRequirements: [],
    createdAt: now(),
    updatedAt: now(),
  };
  atomicWrite(workerPath(runId, id, cwd), worker);
  appendEvent(runId, cwd, { type: "worker.initialized", worker: id, module, wave: worker.wave });
  return worker;
}

/** Returns the exact manifest a worker should write to
 * `.claude/asterweave/completion-worker.json` inside its own isolated worktree so the
 * ownership-enforcement hook (completion-guard.mjs) can bind writes to this workstream. */
export function workerManifest(worker) {
  return {
    workstreamId: worker.id,
    module: worker.module,
    write: worker.ownership.write,
    read: worker.ownership.read,
    deny: worker.ownership.deny,
    shared: worker.ownership.shared,
    approvedShared: worker.ownership.approvedShared,
  };
}

export function startWorker(runId, workerId, { branch = null, worktree = null, cwd = process.cwd() } = {}) {
  const worker = getWorker(runId, workerId, cwd);
  worker.status = "implementing";
  worker.attempts += 1;
  if (branch) worker.branch = branch;
  if (worktree) worker.worktree = worktree;
  return saveWorker(worker, cwd);
}

export function setWorkerStatus(runId, workerId, status, cwd = process.cwd()) {
  if (!WORKER_STATUSES.includes(status)) throw new Error(`Unknown worker status: ${status}`);
  const worker = getWorker(runId, workerId, cwd);
  worker.status = status;
  return saveWorker(worker, cwd);
}

export function completeWorker(runId, workerId, outcome, details = {}, cwd = process.cwd()) {
  if (!WORKER_OUTCOMES.has(outcome)) throw new Error(`Unknown worker outcome: ${outcome}`);
  const worker = getWorker(runId, workerId, cwd);
  worker.outcome = outcome;
  worker.status = outcome === "pass" ? "complete" : ["dependency-discovered", "ownership-conflict", "shared-code-required", "needs-human"].includes(outcome) ? "blocked" : "failed";
  worker.completedTasks = details.completedTasks || worker.completedTasks;
  worker.deferredTasks = details.deferredTasks || worker.deferredTasks;
  worker.filesChanged = details.filesChanged || worker.filesChanged;
  worker.verification = details.verification ?? worker.verification;
  worker.reviews = details.reviews ?? worker.reviews;
  worker.knownRisks = details.knownRisks || worker.knownRisks;
  worker.integrationRequirements = details.integrationRequirements || worker.integrationRequirements;
  saveWorker(worker, cwd);
  appendEvent(runId, cwd, { type: "worker.completed", worker: workerId, outcome });
  return worker;
}

// ---------------------------------------------------------------------------------------------
// Shared-code lock protocol (Phase 13): a worker never edits a shared path directly; it requests
// a decision from the parent orchestrator, which is the only actor allowed to widen a worker's
// approvedShared ownership.
// ---------------------------------------------------------------------------------------------

export function requestLock(runId, { workerId, path, reason, cwd = process.cwd() } = {}) {
  if (!workerId?.trim() || !path?.trim()) throw new Error("lock request requires --worker and --path.");
  const paths = runPaths(runId, cwd);
  const locks = readJson(paths.locks, []);
  const lock = {
    id: randomUUID(),
    workerId,
    path,
    reason: reason || null,
    status: "pending",
    decision: null,
    by: null,
    notes: null,
    requestedAt: now(),
    decidedAt: null,
  };
  locks.push(lock);
  atomicWrite(paths.locks, locks);
  appendEvent(runId, cwd, { type: "lock.requested", lock: lock.id, worker: workerId, path });
  return lock;
}

export function listLocks(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).locks, []);
}

export function decideLock(runId, lockId, { decision, by, notes, cwd = process.cwd() } = {}) {
  if (!LOCK_DECISIONS.has(decision)) throw new Error(`Unknown lock decision: ${decision}`);
  if (!by?.trim()) throw new Error("lock decide requires --by.");
  const paths = runPaths(runId, cwd);
  const locks = readJson(paths.locks, []);
  const lock = locks.find((entry) => entry.id === lockId);
  if (!lock) throw new Error(`No lock '${lockId}' in run ${runId}.`);
  lock.status = "decided";
  lock.decision = decision;
  lock.by = by.trim();
  lock.notes = notes || null;
  lock.decidedAt = now();
  atomicWrite(paths.locks, locks);
  appendEvent(runId, cwd, { type: "lock.decided", lock: lock.id, decision, by: lock.by });

  if (decision === "approve-exclusive-lock") {
    const worker = getWorker(runId, lock.workerId, cwd);
    if (!worker.ownership.approvedShared.includes(lock.path)) worker.ownership.approvedShared.push(lock.path);
    saveWorker(worker, cwd);
  }
  return lock;
}

// ---------------------------------------------------------------------------------------------
// Integration + final audit
// ---------------------------------------------------------------------------------------------

export function setIntegration(runId, data, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  atomicWrite(runPaths(runId, cwd).integration, data);
  saveRun(state, cwd, { type: "integration.recorded" });
  return data;
}

export function getIntegration(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).integration, null);
}

export function setFinalAudit(runId, data, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  atomicWrite(runPaths(runId, cwd).finalAudit, data);
  saveRun(state, cwd, { type: "final-audit.recorded" });
  return data;
}

export function getFinalAudit(runId, cwd = process.cwd()) {
  return readJson(runPaths(runId, cwd).finalAudit, null);
}

// ---------------------------------------------------------------------------------------------
// Aggregate status (for concise progress reporting; the caller formats a progress bar/table)
// ---------------------------------------------------------------------------------------------

export function statusRun(runId, cwd = process.cwd()) {
  const state = loadRun(runId, cwd);
  return {
    ...state,
    modules: getModules(runId, cwd),
    graph: getDependencyGraph(runId, cwd),
    waves: getWaves(runId, cwd),
    workers: listWorkers(runId, cwd),
    locks: listLocks(runId, cwd),
    integration: getIntegration(runId, cwd),
    finalAudit: getFinalAudit(runId, cwd),
  };
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function readFileOption(options) {
  if (!options.file) throw new Error("--file <path> is required.");
  return JSON.parse(readFileSync(resolve(options.file), "utf8"));
}

function usage() {
  console.error(`Usage:
  completion-state.mjs init [--goal <text>] [--max-workers <n>] [--force]
  completion-state.mjs find-active
  completion-state.mjs list
  completion-state.mjs status <runId> [--compact]
  completion-state.mjs phase <runId> <phase>
  completion-state.mjs approve <runId> --by <identity> --summary <text>
  completion-state.mjs pause <runId> [--reason <text>]
  completion-state.mjs resume <runId>
  completion-state.mjs abort <runId> [--reason <text>]
  completion-state.mjs complete-run <runId>
  completion-state.mjs modules set <runId> --file <path>
  completion-state.mjs graph set <runId> --file <path>
  completion-state.mjs waves set <runId> --file <path>
  completion-state.mjs worker init <runId> <workerId> --file <path>
  completion-state.mjs worker start <runId> <workerId> [--branch <b>] [--worktree <path>]
  completion-state.mjs worker set-status <runId> <workerId> <status>
  completion-state.mjs worker complete <runId> <workerId> <outcome> [--file <path>]
  completion-state.mjs worker manifest <runId> <workerId>
  completion-state.mjs worker list <runId>
  completion-state.mjs lock request <runId> --worker <id> --path <glob> [--reason <text>]
  completion-state.mjs lock decide <runId> <lockId> --decision <decision> --by <identity> [--notes <text>]
  completion-state.mjs lock list <runId>
  completion-state.mjs integration set <runId> --file <path>
  completion-state.mjs final-audit set <runId> --file <path>`);
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...rest] = argv;
  const { positional, options } = parseOptions(rest);
  let result;
  switch (command) {
    case "init":
      result = initRun({ goal: options.goal || null, maxWorkers: options["max-workers"] ? Number(options["max-workers"]) : DEFAULT_MAX_WORKERS, force: Boolean(options.force), cwd });
      break;
    case "find-active":
      result = findActiveRun(cwd);
      break;
    case "list":
      result = listRuns(cwd);
      break;
    case "status":
      result = statusRun(positional[0], cwd);
      break;
    case "phase":
      result = setPhase(positional[0], positional[1], cwd);
      break;
    case "approve":
      result = approveWavePlan({ runId: positional[0], by: options.by, summary: options.summary, cwd });
      break;
    case "pause":
      result = pauseRun(positional[0], options.reason, cwd);
      break;
    case "resume":
      result = resumeRun(positional[0], cwd);
      break;
    case "abort":
      result = abortRun(positional[0], options.reason, cwd);
      break;
    case "complete-run":
      result = completeRun(positional[0], cwd);
      break;
    default:
      result = runSubcommand(command, positional, options, cwd);
  }
  if (result === undefined) {
    usage();
    return 2;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// Grouped subcommands (`modules set`, `graph set`, `waves set`, `worker *`, `lock *`,
// `integration set`, `final-audit set`) share a "<noun> <verb> <runId> ..." shape.
function runSubcommand(command, positional, options, cwd) {
  const [noun, verb, ...args] = [command, ...positional];
  switch (`${noun} ${verb}`) {
    case "modules set":
      return setModules(args[0], readFileOption(options), cwd);
    case "graph set":
      return setDependencyGraph(args[0], readFileOption(options), cwd);
    case "waves set":
      return setWaves(args[0], readFileOption(options), cwd);
    case "worker init":
      return initWorker(args[0], { ...readFileOption(options), id: args[1], cwd });
    case "worker start":
      return startWorker(args[0], args[1], { branch: options.branch || null, worktree: options.worktree || null, cwd });
    case "worker set-status":
      return setWorkerStatus(args[0], args[1], args[2], cwd);
    case "worker complete":
      return completeWorker(args[0], args[1], args[2], options.file ? readFileOption(options) : {}, cwd);
    case "worker manifest":
      return workerManifest(getWorker(args[0], args[1], cwd));
    case "worker list":
      return listWorkers(args[0], cwd);
    case "lock request":
      return requestLock(args[0], { workerId: options.worker, path: options.path, reason: options.reason, cwd });
    case "lock decide":
      return decideLock(args[0], args[1], { decision: options.decision, by: options.by, notes: options.notes, cwd });
    case "lock list":
      return listLocks(args[0], cwd);
    case "integration set":
      return setIntegration(args[0], readFileOption(options), cwd);
    case "final-audit set":
      return setFinalAudit(args[0], readFileOption(options), cwd);
    default:
      return undefined;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`Asterweave completion-state error: ${error.message}`);
    process.exitCode = 1;
  }
}
