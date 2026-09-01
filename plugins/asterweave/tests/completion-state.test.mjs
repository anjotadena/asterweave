import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  abortRun,
  approveWavePlan,
  completeRun,
  completeWorker,
  decideLock,
  findActiveRun,
  getWorker,
  initRun,
  initWorker,
  listWorkers,
  requestLock,
  setDependencyGraph,
  setModules,
  setWaves,
  startWorker,
  statusRun,
  workerManifest,
} from "../scripts/completion-state.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "asterweave-completion-"));
}

function financeModules() {
  return [
    {
      id: "finance",
      name: "Finance",
      status: "PARTIAL",
      completionEstimate: 68,
      implemented: ["customer payments", "basic refunds"],
      gaps: [{ id: "FIN-001", priority: "P0", description: "Concurrent refund protection" }],
      dependencies: ["auth"],
    },
    {
      id: "inventory",
      name: "Inventory",
      status: "PARTIAL",
      completionEstimate: 72,
      implemented: ["stock counts"],
      gaps: [{ id: "INV-001", priority: "P1", description: "Reorder threshold alerts" }],
      dependencies: ["auth"],
    },
    {
      id: "auth",
      name: "Authentication",
      status: "PARTIAL",
      completionEstimate: 80,
      implemented: ["login"],
      gaps: [{ id: "AUTH-001", priority: "P0", description: "Session fixation hardening" }],
      dependencies: [],
    },
  ];
}

function blockingGraph() {
  return {
    nodes: [{ id: "auth", type: "module" }, { id: "finance", type: "module" }, { id: "inventory", type: "module" }],
    edges: [
      { from: "auth", to: "finance", type: "blocking" },
      { from: "auth", to: "inventory", type: "blocking" },
    ],
  };
}

test("initializes a run and refuses a second init without --force while active", () => {
  const cwd = workspace();
  const state = initRun({ goal: "Complete the project", cwd });
  assert.equal(state.status, "active");
  assert.equal(state.phase, "discovery");
  assert.equal(state.maxWorkers, 3);
  assert.throws(() => initRun({ cwd }), /still active/);
  const forced = initRun({ cwd, force: true });
  assert.notEqual(forced.runId, state.runId);
});

test("find-active resumes instead of duplicating, and ignores completed runs", () => {
  const cwd = workspace();
  const state = initRun({ goal: "Complete the project", cwd });
  assert.equal(findActiveRun(cwd).runId, state.runId);
  completeRun(state.runId, cwd);
  assert.equal(findActiveRun(cwd), null);
});

test("modules set validates status/priority enums and duplicate ids", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  setModules(state.runId, financeModules(), cwd);
  assert.throws(() => setModules(state.runId, [{ id: "finance", name: "Finance", status: "NOT-A-STATUS" }], cwd), /status must be one of/);
  assert.throws(
    () => setModules(state.runId, [...financeModules(), { ...financeModules()[0] }], cwd),
    /Duplicate module id/,
  );
});

test("dependency graph rejects a blocking cycle", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  assert.throws(
    () =>
      setDependencyGraph(
        state.runId,
        {
          nodes: [{ id: "a" }, { id: "b" }],
          edges: [
            { from: "a", to: "b", type: "blocking" },
            { from: "b", to: "a", type: "blocking" },
          ],
        },
        cwd,
      ),
    /blocking cycle/,
  );
});

test("waves set rejects a plan that violates dependency order and accepts one that respects it", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  setDependencyGraph(state.runId, blockingGraph(), cwd);

  const unsafe = [
    {
      wave: 1,
      workstreams: [
        { id: "WS-AUTH", modules: ["auth"], dependsOn: [] },
        { id: "WS-FINANCE", modules: ["finance"], dependsOn: [] },
      ],
    },
  ];
  assert.throws(() => setWaves(state.runId, unsafe, cwd), /blocks on|reorder the waves/);

  const safe = [
    { wave: 1, workstreams: [{ id: "WS-AUTH", modules: ["auth"], dependsOn: [] }] },
    {
      wave: 2,
      workstreams: [
        { id: "WS-FINANCE", modules: ["finance"], dependsOn: ["WS-AUTH"] },
        { id: "WS-INVENTORY", modules: ["inventory"], dependsOn: ["WS-AUTH"] },
      ],
    },
  ];
  const waves = setWaves(state.runId, safe, cwd);
  assert.equal(waves.length, 2);
});

test("approving the wave plan advances the run to implementation", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  const advanced = approveWavePlan({ runId: state.runId, by: "Anjo", summary: "Wave plan approved", cwd });
  assert.equal(advanced.phase, "implementation");
  assert.equal(advanced.approvals.length, 1);
});

test("worker init enforces the concurrency limit", () => {
  const cwd = workspace();
  const state = initRun({ maxWorkers: 1, cwd });
  initWorker(state.runId, { id: "WS-FINANCE", module: "Finance", wave: 1, ownership: { write: ["src/Finance/**"] }, cwd });
  assert.throws(
    () => initWorker(state.runId, { id: "WS-INVENTORY", module: "Inventory", wave: 1, ownership: { write: ["src/Inventory/**"] }, cwd }),
    /Concurrency limit reached/,
  );
});

test("worker init rejects overlapping write ownership with another active worker", () => {
  const cwd = workspace();
  const state = initRun({ maxWorkers: 5, cwd });
  initWorker(state.runId, { id: "WS-FINANCE", module: "Finance", wave: 1, ownership: { write: ["src/Finance/**"] }, cwd });
  assert.throws(
    () =>
      initWorker(state.runId, {
        id: "WS-FINANCE-DUP",
        module: "Finance",
        wave: 1,
        ownership: { write: ["src/Finance/Ledger.cs"] },
        cwd,
      }),
    /overlaps active worker/,
  );
  // A completed worker's ownership no longer blocks a new one from reusing that path.
  completeWorker(state.runId, "WS-FINANCE", "pass", {}, cwd);
  assert.doesNotThrow(() =>
    initWorker(state.runId, { id: "WS-FINANCE-2", module: "Finance", wave: 2, ownership: { write: ["src/Finance/**"] }, cwd }),
  );
});

test("worker lifecycle: start, manifest, complete pass", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  initWorker(state.runId, {
    id: "WS-FINANCE",
    module: "Finance",
    wave: 1,
    ownership: { write: ["src/Finance/**"], read: ["src/**"], deny: ["src/Inventory/**"], shared: ["src/Shared/**"] },
    tasks: ["FIN-001"],
    cwd,
  });
  const started = startWorker(state.runId, "WS-FINANCE", { branch: "asterweave/finance-completion", worktree: "../repo-finance", cwd });
  assert.equal(started.status, "implementing");
  assert.equal(started.attempts, 1);

  const manifest = workerManifest(getWorker(state.runId, "WS-FINANCE", cwd));
  assert.deepEqual(manifest.write, ["src/Finance/**"]);
  assert.deepEqual(manifest.deny, ["src/Inventory/**"]);
  assert.equal(manifest.workstreamId, "WS-FINANCE");

  const completed = completeWorker(state.runId, "WS-FINANCE", "pass", { completedTasks: ["FIN-001"] }, cwd);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.completedTasks, ["FIN-001"]);
});

test("a dependency-discovered outcome blocks the worker without touching others", () => {
  const cwd = workspace();
  const state = initRun({ maxWorkers: 5, cwd });
  initWorker(state.runId, { id: "WS-INVENTORY", module: "Inventory", wave: 1, ownership: { write: ["src/Inventory/**"] }, cwd });
  initWorker(state.runId, { id: "WS-FINANCE", module: "Finance", wave: 1, ownership: { write: ["src/Finance/**"] }, cwd });
  completeWorker(state.runId, "WS-INVENTORY", "dependency-discovered", {}, cwd);
  const inventory = getWorker(state.runId, "WS-INVENTORY", cwd);
  const finance = getWorker(state.runId, "WS-FINANCE", cwd);
  assert.equal(inventory.status, "blocked");
  assert.equal(finance.status, "pending");
});

test("shared-code lock protocol: request then approve grants approvedShared", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  initWorker(state.runId, { id: "WS-FINANCE", module: "Finance", wave: 1, ownership: { write: ["src/Finance/**"], shared: ["src/Shared/Money.cs"] }, cwd });
  const lock = requestLock(state.runId, { workerId: "WS-FINANCE", path: "src/Shared/Money.cs", reason: "Needs rounding fix", cwd });
  assert.equal(lock.status, "pending");
  const decided = decideLock(state.runId, lock.id, { decision: "approve-exclusive-lock", by: "Anjo", cwd });
  assert.equal(decided.decision, "approve-exclusive-lock");
  const worker = getWorker(state.runId, "WS-FINANCE", cwd);
  assert.deepEqual(worker.ownership.approvedShared, ["src/Shared/Money.cs"]);
});

test("a deferred lock decision does not widen worker ownership", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  initWorker(state.runId, { id: "WS-FINANCE", module: "Finance", wave: 1, ownership: { write: ["src/Finance/**"], shared: ["src/Shared/Money.cs"] }, cwd });
  const lock = requestLock(state.runId, { workerId: "WS-FINANCE", path: "src/Shared/Money.cs", cwd });
  decideLock(state.runId, lock.id, { decision: "defer-until-next-wave", by: "Anjo", cwd });
  const worker = getWorker(state.runId, "WS-FINANCE", cwd);
  assert.deepEqual(worker.ownership.approvedShared, []);
});

test("abort and complete-run are terminal and repeated init after abort starts a fresh run", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  const aborted = abortRun(state.runId, "Superseded by manual work", cwd);
  assert.equal(aborted.status, "aborted");
  const fresh = initRun({ cwd });
  assert.notEqual(fresh.runId, state.runId);
  assert.equal(findActiveRun(cwd).runId, fresh.runId);
});

test("statusRun aggregates modules, graph, waves, and workers for progress reporting", () => {
  const cwd = workspace();
  const state = initRun({ cwd });
  setModules(state.runId, financeModules(), cwd);
  setDependencyGraph(state.runId, blockingGraph(), cwd);
  initWorker(state.runId, { id: "WS-AUTH", module: "Authentication", wave: 1, ownership: { write: ["src/Auth/**"] }, cwd });
  const status = statusRun(state.runId, cwd);
  assert.equal(status.modules.length, 3);
  assert.equal(status.graph.edges.length, 2);
  assert.equal(status.workers.length, 1);
  assert.equal(listWorkers(state.runId, cwd).length, 1);
});
