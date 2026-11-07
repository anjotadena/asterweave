// Shared helpers for the loop tests (not a test file: the runner only picks *.test.mjs).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { grantApproval } from "../src/runtime/approvals.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { deliveryGraph } from "../src/runtime/graphs/delivery.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { commitRecords, createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { acquireRunLock } from "../src/runtime/lock.mjs";
import { tempDir } from "./repo-fixture.mjs";

export { deliveryGraph };

export function makeBox() {
  const userDir = tempDir("aw-loop-");
  const workspace = tempDir("aw-ws-");
  mkdirSync(join(workspace, ".git"), { recursive: true }); // git and gh forms are understood only in a workspace root that has a .git entry (round 6)
  let tick = Date.UTC(2026, 0, 1);
  return {
    userDir,
    workspace,
    env: { ASTERWEAVE_CONFIG_DIR: userDir },
    repo: { key: process.platform === "win32" ? "c:\\work\\loop\\.git" : "/work/loop/.git", realpath: workspace },
    now: () => new Date((tick += 10)).toISOString(),
  };
}

export function startRun(box, { graph = deliveryGraph, runId = "run-1", goal = "ship the feature", policyHash = null } = {}) {
  return createRunForGraph({ graph, goal, repo: box.repo, runId, policyHash, now: box.now, env: box.env });
}

// --- actions and scripts ---------------------------------------------------------------------

export const ev = (kind, result = "pass", extra = {}) => ({ v: 1, type: "evidence", evidence: { kind, summary: `${kind} ${result}`, result, ...extra } });
export const done = (outcome = "pass", signature) => ({ v: 1, type: "complete", outcome, ...(signature ? { signature } : {}) });
export const tool = (name, input) => ({ v: 1, type: "tool", tool: { name, input } });
export const wait = (ms = 0) => ({ v: 1, type: "wait", ms });
export const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Steps for one attempt of a node: optional extra actions, evidence for every required kind, then the outcome. */
export function attempt(graph, node, { before = [], results = {}, outcome = "pass", signature, revision = 1 } = {}) {
  const def = graph.nodes[node];
  const steps = before.map((action) => ({ node, action }));
  for (const kind of def.evidence) {
    const extra = def.produces === kind ? { sha256: sha(`${node}-v${revision}`) } : {};
    steps.push({ node, action: ev(kind, results[kind] ?? "pass", extra) });
  }
  steps.push({ node, action: done(outcome, signature) });
  return steps;
}

/**
 * A script that passes every non-approval node once, with `plan` overriding nodes (an array of step arrays, one per
 * attempt, or a single array).
 */
export function script(graph, plan = {}) {
  const steps = [];
  for (const [node, def] of Object.entries(graph.nodes)) {
    if (def.kind === "approval") continue;
    const given = plan[node];
    const attempts = given === undefined ? [attempt(graph, node)] : Array.isArray(given[0]) ? given : [given];
    for (const list of attempts) steps.push(...list);
  }
  return { v: 1, steps };
}

// --- driving -------------------------------------------------------------------------------------

export function baseOptions(box, dir, graph, extra = {}) {
  return { dir, graph, now: box.now, sleep: async () => {}, workspaceRoot: box.workspace, ...extra };
}

/** Grant every pending approval the way `run approve` will: take the lock, write the events, release. */
export function grantPending(box, dir, graph, { by = { source: "tty", name: "tester" } } = {}) {
  const lock = acquireRunLock(dir);
  try {
    let { run } = loadRun(dir);
    const granted = [];
    for (const approval of run.approvals.filter((entry) => entry.grantedAt === null && entry.invalidatedAt === null)) {
      const result = grantApproval(run, approval.id, { by, now: box.now(), env: {} });
      run = commitRecords({ dir, graph, lockToken: lock.token, now: box.now }, run, result.events).run;
      granted.push(approval.id);
    }
    return granted;
  } finally {
    lock.release();
  }
}

/**
 * Run the loop until it stops for something other than an approval, granting approvals in between.
 * @returns {Promise<{results: object[], final: object}>}
 */
export async function drive(box, dir, graph, scriptObject, { grant = true, maxRounds = 12, executor, ...extra } = {}) {
  const results = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const result = await runLoop(baseOptions(box, dir, graph, { executor: executor ?? createFakeExecutor(scriptObject), ...extra }));
    results.push(result);
    if (result.status !== "waiting-approval" || !grant) return { results, final: result };
    grantPending(box, dir, graph);
  }
  return { results, final: results.at(-1) };
}

export const readEvents = (dir) =>
  readFileSync(join(dir, "events.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

export const types = (dir) => readEvents(dir).map((event) => event.type);
