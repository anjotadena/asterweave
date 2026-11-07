// Differential test between the plugin's graph-state.mjs and the CLI's pure graph reducer. The plugin
// module is imported by THIS TEST ONLY (never at runtime), like redact-parity.test.mjs.
//
// Every scenario drives the plugin (through its exported functions, in a temp directory) and the reducer
// with the same sequence and compares {run status, currentNode, per-node status and attempts} after EVERY
// step. The divergence tests at the end pin each plugin defect the CLI deliberately does not copy.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import * as plugin from "../../../plugins/asterweave/scripts/graph-state.mjs";
import { GraphError, initialRun, transition } from "../src/runtime/graph.mjs";
import { bugfixGraph, deliveryGraph } from "../src/runtime/graphs/index.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const created = [];
after(() => {
  for (const directory of created) rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function pluginSnapshot(cwd, { ignoreAttempts = false } = {}) {
  const state = plugin.loadState(cwd);
  return snapshotOf(state.status, state.currentNode, state.nodes, ignoreAttempts);
}
function cliSnapshot(run, { ignoreAttempts = false } = {}) {
  return snapshotOf(run.status, run.currentNode, run.nodes, ignoreAttempts);
}
function snapshotOf(status, currentNode, nodes, ignoreAttempts) {
  return {
    status,
    currentNode,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, node]) => [id, ignoreAttempts ? { status: node.status } : { status: node.status, attempts: node.attempts }]),
    ),
  };
}

// Drives plugin and reducer in lock step.
function pair() {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-graph-parity-")));
  created.push(cwd);
  plugin.initialize({ goal: "parity", cwd });
  let run = initialRun(deliveryGraph, { runId: "parity-1", goal: "parity", repo: { key: "k", realpath: cwd }, now: new Date(T0).toISOString() });
  let clock = 0;
  const effects = [];
  const api = {
    cwd,
    get run() {
      return run;
    },
    effects,
    get state() {
      return plugin.loadState(cwd);
    },
    // Runs one step on both sides; thrown errors are captured. By default both must agree on whether it threw
    // and the snapshots must match afterwards.
    step(label, pluginCall, event, { compare = true, sameThrow = true, ignoreAttempts = false } = {}) {
      let pluginError = null;
      let cliError = null;
      try {
        pluginCall();
      } catch (error) {
        pluginError = error;
      }
      try {
        const result = transition(run, deliveryGraph, { now: new Date(T0 + ++clock * 1000).toISOString(), ...event });
        run = result.run;
        effects.push(...result.effects);
      } catch (error) {
        cliError = error;
      }
      if (sameThrow) assert.equal(Boolean(pluginError), Boolean(cliError), `${label}: plugin ${pluginError?.message ?? "ok"} / cli ${cliError?.message ?? "ok"}`);
      if (compare) assert.deepEqual(cliSnapshot(run, { ignoreAttempts }), pluginSnapshot(cwd, { ignoreAttempts }), label);
      return { pluginError, cliError };
    },
    enter: (options) => api.step(`enter ${run.currentNode}`, () => plugin.enterNode(run.currentNode, cwd), { type: "enter" }, options),
    evidence(kind, result = "pass", options) {
      const node = run.currentNode;
      return api.step(
        `evidence ${node}/${kind}=${result}`,
        () => plugin.addEvidence(node, { kind, summary: `${kind} ${result}`, result }, cwd),
        { type: "evidence", kind, summary: `${kind} ${result}`, result },
        options,
      );
    },
    complete(outcome, signature, options) {
      const node = run.currentNode;
      return api.step(
        `complete ${node} ${outcome}`,
        () => plugin.completeNode(node, outcome, signature ? { signature } : {}, cwd),
        { type: "complete", outcome, ...(signature ? { signature } : {}) },
        options,
      );
    },
    approve: (options) => api.step("approve", () => plugin.approve({ by: "tester", summary: "ok" }, cwd), { type: "approve", by: "tester", summary: "ok" }, options),
    resume: (options) => api.step("resume", () => plugin.resume(cwd), { type: "resume" }, options),
    pass(options) {
      const node = run.currentNode;
      if (deliveryGraph.nodes[node].kind === "approval") return api.approve(options);
      api.enter(options);
      for (const kind of deliveryGraph.nodes[node].evidence) api.evidence(kind, "pass", options);
      return api.complete("pass", undefined, options);
    },
    advanceTo(target) {
      while (run.currentNode !== target) api.pass();
      return api;
    },
  };
  return api;
}

// ---------------------------------------------------------------------------------------------
// Node contracts
// ---------------------------------------------------------------------------------------------

test("delivery@1 nodes match the plugin's NODE_ORDER and NODE_CONTRACTS exactly", () => {
  assert.deepEqual(Object.keys(deliveryGraph.nodes), plugin.NODE_ORDER, "key order drives range invalidation");
  assert.equal(deliveryGraph.start, plugin.NODE_ORDER[0]);
  for (const id of plugin.NODE_ORDER) {
    assert.equal(deliveryGraph.nodes[id].maxAttempts, plugin.NODE_CONTRACTS[id].maxAttempts, `${id} maxAttempts`);
    assert.deepEqual([...deliveryGraph.nodes[id].evidence], plugin.NODE_CONTRACTS[id].evidence, `${id} evidence`);
  }
  const passChain = plugin.NODE_ORDER.map((id, index) => [id, plugin.NODE_ORDER[index + 1] ?? "done"]);
  for (const [id, next] of passChain) {
    assert.equal(deliveryGraph.edges.find((edge) => edge.from === id && edge.on === "pass").to, next, `${id} passes to ${next}`);
  }
  assert.equal(deliveryGraph.terminals.done, "completed");
});

test("bugfix@1 equals the plugin contracts minus challenge, plus reproduction on analyze", () => {
  assert.deepEqual(Object.keys(bugfixGraph.nodes), plugin.NODE_ORDER.filter((id) => id !== "challenge"));
  for (const id of Object.keys(bugfixGraph.nodes)) {
    const contract = plugin.NODE_CONTRACTS[id];
    assert.equal(bugfixGraph.nodes[id].maxAttempts, contract.maxAttempts, id);
    assert.deepEqual([...bugfixGraph.nodes[id].evidence], id === "analyze" ? [...contract.evidence, "reproduction"] : contract.evidence, id);
  }
});

test("the routing table matches the plugin's routeFailure for every node", () => {
  for (const id of plugin.NODE_ORDER) {
    const retry = deliveryGraph.edges.find((edge) => edge.from === id && edge.on === "fail-retryable");
    const routed = ["test", "verify", "review", "monitor-pipeline", "resolve-review-comments"].includes(id);
    assert.equal(retry.to, routed ? "implement" : id, `${id} fail-retryable`);
    const replan = deliveryGraph.edges.find((edge) => edge.from === id && edge.on === "fail-replan");
    // Documented fix (bug 3): before `plan` the CLI retries locally; the plugin routes everything to `plan`.
    assert.equal(replan.to, ["intake", "analyze", "challenge", "plan"].includes(id) ? id : "plan", `${id} fail-replan`);
  }
});

// ---------------------------------------------------------------------------------------------
// Behaviors the CLI keeps: identical sequences, identical outcomes after every step
// ---------------------------------------------------------------------------------------------

test("parity: the full pass path", () => {
  const p = pair();
  p.advanceTo("done");
  assert.equal(p.state.status, "completed");
  assert.equal(p.run.status, "completed");
  assert.equal(p.state.currentNode, "done");
  assert.equal(p.run.currentNode, "done");
});

test("parity: test failure routes to implement, invalidates implement..test, then re-runs on fresh evidence", () => {
  const p = pair();
  p.advanceTo("test");
  p.enter();
  p.evidence("unit-test", "pass");
  p.evidence("integration-test", "fail");
  p.complete("fail-retryable", "tests:integration:timeout");
  assert.equal(p.state.currentNode, "implement");
  assert.equal(p.run.currentNode, "implement");
  for (const id of ["implement", "test"]) {
    assert.equal(p.state.nodes[id].status, "pending");
    assert.equal(p.run.nodes[id].status, "pending");
  }
  assert.equal(p.state.nodes.plan.status, "passed");
  assert.equal(p.run.nodes.plan.status, "passed");
  p.pass(); // implement, attempt 2
  p.pass(); // test, attempt 2, with fresh evidence for both kinds
  assert.equal(p.run.nodes.test.attempts, 2);
  assert.equal(p.state.nodes.test.attempts, 2);
  p.advanceTo("done");
});

test("parity: other nodes route fail-retryable from verify, review, monitor-pipeline and resolve-review-comments to implement", () => {
  for (const id of ["verify", "review", "monitor-pipeline", "resolve-review-comments"]) {
    const p = pair();
    p.advanceTo(id);
    p.enter();
    p.complete("fail-retryable", `sig-${id}`);
    assert.equal(p.run.currentNode, "implement", id);
    assert.equal(p.state.currentNode, "implement", id);
  }
});

test("parity: fail-retryable retries the same node and blocks on the last attempt", () => {
  const p = pair();
  p.advanceTo("analyze");
  p.enter();
  p.evidence("repository");
  p.complete("fail-retryable", "first");
  assert.equal(p.run.currentNode, "analyze");
  assert.equal(p.run.nodes.analyze.status, "failed");
  p.enter();
  p.evidence("repository");
  p.evidence("baseline");
  p.complete("pass");
  assert.equal(p.run.currentNode, "challenge");

  const q = pair();
  q.enter();
  q.complete("fail-retryable", "one");
  q.enter();
  q.complete("fail-retryable", "two");
  assert.equal(q.run.status, "blocked");
  assert.equal(q.state.status, "blocked");
  assert.equal(q.run.currentNode, "intake");
});

test("parity: the same signature twice on one node is a stable failure; the same signature on two nodes is not", () => {
  const p = pair();
  p.advanceTo("implement");
  p.enter();
  p.complete("fail-retryable", "sig-X");
  p.enter();
  p.complete("fail-retryable", "sig-X");
  assert.equal(p.run.status, "blocked");
  assert.equal(p.state.status, "blocked");
  assert.equal(p.run.nodes.implement.attempts, 2, "blocked by the signature, not by the budget (3)");
  const logged = readFileSync(join(p.cwd, ".claude", "asterweave", "events.jsonl"), "utf8");
  assert.match(logged, /node\.stable-failure/);
  const stable = p.effects.at(-1);
  assert.equal(stable.type, "node.completed");
  assert.equal(stable.stableFailure, true);

  const q = pair();
  q.advanceTo("test");
  q.enter();
  q.complete("fail-retryable", "shared");
  q.pass(); // implement
  q.advanceTo("verify");
  q.enter();
  q.complete("fail-retryable", "shared");
  assert.equal(q.run.status, "active");
  assert.equal(q.state.status, "active");
});

test("parity: abort", () => {
  const p = pair();
  p.advanceTo("plan");
  p.enter();
  p.complete("abort");
  assert.equal(p.run.status, "aborted");
  assert.equal(p.state.status, "aborted");
  assert.equal(p.run.nodes.plan.status, "failed");
  assert.equal(p.run.currentNode, "plan");
  // After an abort nothing can proceed, on either side.
  p.enter();
});

test("parity: blocked and resume (attempt accounting differs on purpose, see the refund divergence test)", () => {
  const p = pair();
  p.advanceTo("verify");
  p.enter();
  p.evidence("acceptance");
  p.complete("blocked", undefined, { ignoreAttempts: true });
  assert.equal(p.run.status, "blocked");
  assert.equal(p.run.nodes.verify.status, "blocked");
  p.resume({ ignoreAttempts: true });
  assert.equal(p.run.status, "active");
  assert.equal(p.run.nodes.verify.status, "pending");
  p.enter({ ignoreAttempts: true });
  p.evidence("acceptance", "pass", { ignoreAttempts: true });
  p.complete("pass", undefined, { ignoreAttempts: true });
  assert.equal(p.run.currentNode, "review");
});

test("parity: needs-human, policy-denied and security-escalation pause in place (security-escalation: decision 1)", () => {
  for (const outcome of ["needs-human", "policy-denied", "security-escalation"]) {
    const p = pair();
    p.advanceTo("review");
    p.enter();
    p.complete(outcome, undefined, { ignoreAttempts: true });
    assert.equal(p.run.status, "blocked", outcome);
    assert.equal(p.run.currentNode, "review", `${outcome} pauses at review, in place`);
    assert.equal(p.state.currentNode, "review", outcome);
  }
  // The CLI pauses in place at whichever node raised the escalation (it never relocates the run).
  const raised = pair();
  raised.advanceTo("test");
  raised.enter();
  raised.complete("security-escalation", undefined, { ignoreAttempts: true });
  assert.equal(raised.run.currentNode, "test");
  assert.equal(raised.state.currentNode, "test");
});

test("parity: approve enters the approval node, records evidence and advances", () => {
  const p = pair();
  p.advanceTo("approve");
  p.approve();
  assert.equal(p.run.currentNode, "implement");
  assert.equal(p.run.nodes.approve.attempts, 1);
  // approving anywhere else is refused by both
  const q = pair();
  q.approve();
  assert.equal(q.run.currentNode, "intake");
});

test("parity: pass requires every required evidence kind and rejects any latest failing evidence", () => {
  const p = pair();
  p.advanceTo("analyze");
  p.enter();
  p.evidence("repository");
  p.complete("pass"); // baseline missing: both refuse
  p.evidence("baseline", "fail");
  p.complete("pass"); // latest baseline is failing: both refuse
  p.evidence("baseline", "info");
  p.evidence("scratch", "fail"); // a failing non-required kind also blocks
  p.complete("pass");
  p.evidence("scratch", "pass");
  p.complete("pass");
  assert.equal(p.run.currentNode, "challenge");
});

test("parity: fail-replan from implement routes to plan and invalidates plan..implement", () => {
  const p = pair();
  p.advanceTo("implement");
  p.enter();
  p.complete("fail-replan", "design-flaw");
  assert.equal(p.run.currentNode, "plan");
  assert.equal(p.state.currentNode, "plan");
  for (const id of ["plan", "approve", "implement"]) assert.equal(p.run.nodes[id].status, "pending");
});

// ---------------------------------------------------------------------------------------------
// Divergences: plugin defects the CLI deliberately does not reproduce
// ---------------------------------------------------------------------------------------------

test("divergence 1 (security-escalation): the contract text says pause at review; both implementations pause in place", () => {
  const p = pair();
  p.advanceTo("review");
  p.enter();
  p.complete("security-escalation", undefined, { ignoreAttempts: true });
  // The plugin's routeFailure maps security-escalation to `review`, but the branch is unreachable: the
  // outcome is handled earlier as a pause. The CLI makes the real behavior the contract: paused in place.
  assert.equal(p.state.status, "blocked");
  assert.equal(p.run.status, "blocked");
  assert.equal(p.run.currentNode, "review");
  assert.equal(p.run.nodes.review.outcome, "security-escalation");
  assert.equal(p.effects.at(-1).type, "run.paused");
});

test("divergence 2: a re-run passes on stale evidence in the plugin, never in the CLI", () => {
  const p = pair();
  p.advanceTo("test");
  p.enter();
  p.evidence("unit-test");
  p.evidence("integration-test");
  p.complete("fail-retryable", "flaky");
  p.pass(); // implement
  p.enter(); // test again, attempt 2, NO new evidence
  const { pluginError, cliError } = p.complete("pass", undefined, { compare: false, sameThrow: false });
  assert.equal(pluginError, null, "plugin accepts the pass on evidence from the invalidated attempt");
  assert.equal(p.state.nodes.test.status, "passed");
  assert.ok(cliError instanceof GraphError);
  assert.equal(cliError.code, "EVIDENCE_MISSING");
  assert.equal(p.run.nodes.test.status, "running");
});

test("divergence 3: fail-replan before plan jumps forward in the plugin, retries locally in the CLI", () => {
  const p = pair();
  p.enter();
  p.complete("fail-replan", "wrong-premise", { compare: false });
  assert.equal(p.state.currentNode, "plan", "plugin skips analyze and challenge");
  assert.equal(p.state.nodes.analyze.status, "pending");
  assert.equal(p.run.currentNode, "intake");
  assert.equal(p.run.nodes.intake.status, "failed");
  assert.equal(p.run.status, "active");
});

test("divergence 4: after a replan the plugin can never re-approve (budget 1/1); the CLI resets the approve budget", () => {
  const p = pair();
  p.advanceTo("implement");
  p.enter();
  p.complete("fail-replan", "design-flaw");
  p.pass({ ignoreAttempts: true }); // plan revision 2 (approve attempts differ from here on)
  assert.equal(p.run.currentNode, "approve");
  assert.equal(p.state.currentNode, "approve");
  const { pluginError } = p.approve({ compare: false, sameThrow: false });
  assert.match(pluginError.message, /exhausted its 1 attempts/);
  assert.equal(p.state.status, "blocked", "plugin: dead end");
  assert.equal(p.run.status, "active");
  assert.equal(p.run.currentNode, "implement", "CLI: approved and moved on");
  assert.equal(p.run.artifacts.plan.revision, 2);
});

test("divergence 5: blocked and needs-human consume a retry in the plugin; the CLI refunds the attempt", () => {
  const p = pair();
  p.enter();
  p.complete("needs-human", undefined, { ignoreAttempts: true });
  assert.equal(p.state.nodes.intake.attempts, 1);
  assert.equal(p.run.nodes.intake.attempts, 0);
  p.resume({ ignoreAttempts: true });
  p.enter({ ignoreAttempts: true });
  p.complete("blocked", undefined, { ignoreAttempts: true });
  p.resume({ ignoreAttempts: true });
  assert.equal(p.state.nodes.intake.attempts, 2, "plugin: the budget (2) is gone after two human pauses");
  assert.equal(p.run.nodes.intake.attempts, 0);
  const { pluginError, cliError } = p.enter({ compare: false, sameThrow: false });
  assert.match(pluginError.message, /exhausted/);
  assert.equal(cliError, null);
  assert.equal(p.run.nodes.intake.status, "running");
  assert.equal(p.run.nodes.intake.attemptLog.length, 3);
});

test("divergence 6: after a routed exhaustion the plugin resumes into the old node without reimplementation; the CLI resumes at implement", () => {
  const p = pair();
  p.advanceTo("test");
  p.enter();
  p.complete("fail-retryable", "t1");
  p.pass(); // implement attempt 2
  p.advanceTo("verify");
  p.enter();
  p.complete("fail-retryable", "v1");
  p.pass(); // implement attempt 3
  p.advanceTo("review");
  p.enter();
  p.complete("fail-retryable", "r1", { compare: false });
  assert.equal(p.state.status, "blocked");
  assert.equal(p.run.status, "blocked");
  assert.equal(p.state.currentNode, "review", "plugin: positioned at the failing node");
  assert.equal(p.run.currentNode, "implement", "CLI: positioned at the node that must re-run");
  p.step("resume", () => plugin.resume(p.cwd), { type: "resume" }, { compare: false });
  assert.doesNotThrow(() => plugin.enterNode("review", p.cwd), "plugin: review runs again on the unchanged implementation");
  const entered = p.step("enter implement (CLI side only)", () => {}, { type: "enter" }, { compare: false, sameThrow: false });
  assert.equal(entered.cliError, null);
  assert.equal(p.run.status, "blocked", "CLI: implement is out of attempts, so the run blocks instead of silently skipping reimplementation");
  assert.equal(p.run.nodes.review.status, "pending");
});

test("divergence 7: initialize truncates the plugin's audit trail; the CLI reducer only ever produces effects to append", () => {
  const p = pair();
  p.advanceTo("plan");
  const eventsFile = join(p.cwd, ".claude", "asterweave", "events.jsonl");
  const before = readFileSync(eventsFile, "utf8").trim().split("\n").length;
  assert.ok(before > 10);
  plugin.initialize({ goal: "again", force: true, cwd: p.cwd });
  const after = readFileSync(eventsFile, "utf8").trim().split("\n").length;
  assert.equal(after, 1, "plugin: the previous history is gone");
  // CLI side (the ledger itself is covered by ledger.test.mjs): history in run state survives invalidation,
  // and the reducer emits an effect for every change instead of rewriting anything.
  const q = pair();
  q.advanceTo("test");
  q.enter();
  q.complete("fail-retryable", "x");
  assert.equal(q.run.nodes.test.attemptLog.length, 1);
  assert.equal(q.run.nodes.test.failureSignatures.length, 1);
  assert.ok(q.effects.length >= 20);
});

test("divergence 8: the plugin persists state before the event, so a failed audit write leaves state ahead of the trail", () => {
  const p = pair();
  const eventsPath = join(p.cwd, ".claude", "asterweave", "events.jsonl");
  const linesBefore = readFileSync(eventsPath, "utf8").trim().split("\n").length;
  rmSync(eventsPath);
  mkdirSync(eventsPath); // appending to it now fails
  assert.throws(() => plugin.enterNode("intake", p.cwd));
  assert.equal(p.state.nodes.intake.status, "running", "plugin: state.json already advanced");
  assert.equal(p.state.nodes.intake.attempts, 1);
  rmSync(eventsPath, { recursive: true, force: true });
  assert.ok(linesBefore >= 1);
  // CLI side: the reducer never persists anything. It hands back the effects that the ledger must append
  // FIRST, and it leaves the previous run untouched until the caller swaps in the new one.
  const before = structuredClone(p.run);
  const result = transition(p.run, deliveryGraph, { type: "enter", now: new Date(T0 + 99_000).toISOString() });
  assert.deepEqual(p.run, before);
  assert.deepEqual(result.effects.map((effect) => effect.type), ["node.entered"]);
  assert.equal(result.run.nodes.intake.status, "running");
});

test("divergence 10: caller-supplied at/seq never reach the effects (the ledger stamps them last)", () => {
  const p = pair();
  p.step("enter", () => plugin.enterNode("intake", p.cwd), { type: "enter", at: "1999-01-01T00:00:00.000Z", seq: 1 });
  assert.equal(p.effects.length, 1);
  assert.deepEqual(Object.keys(p.effects[0]).sort(), ["attempt", "attempts", "node", "type"]);
  assert.ok(!JSON.stringify(p.effects).includes("1999"));
});

test("divergence 11: the plugin records evidence and completes nodes in a non-active workflow; the CLI refuses", () => {
  const p = pair();
  p.enter();
  p.step("pause", () => plugin.pause("hold on", p.cwd), { type: "pause", reason: "hold on" }, { compare: false });
  assert.equal(p.state.status, "blocked");
  assert.equal(p.run.status, "paused");
  const evidence = p.evidence("task", "pass", { compare: false, sameThrow: false });
  assert.equal(evidence.pluginError, null, "plugin: evidence accepted while blocked");
  assert.equal(evidence.cliError.code, "RUN_NOT_ACTIVE");
  const completed = p.complete("pass", undefined, { compare: false, sameThrow: false });
  assert.equal(completed.pluginError, null, "plugin: a blocked workflow advances anyway");
  assert.equal(p.state.currentNode, "analyze");
  assert.equal(completed.cliError.code, "RUN_NOT_ACTIVE");
  assert.equal(p.run.currentNode, "intake");
  assert.equal(p.run.nodes.intake.attemptLog[0].evidence.length, 0);
});
