// Loop behaviors the first loop tests left open: accepting a policy change, autonomous mode, token budgets,
// a lost run lock, and timed waits.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { simulatedDispatcher } from "../src/runtime/executor.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { runLoop } from "../src/runtime/loop.mjs";
import { inspectRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp } from "./repo-fixture.mjs";
import { baseOptions, deliveryGraph, drive, grantPending, makeBox, readEvents, script, startRun, tool, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const graph = deliveryGraph;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

// --- policy drift: accepting it ------------------------------------------------------------------------------------

test("policy drift, accepted: the resume approval is requested, then granted; policy.bound is recorded and approvals of the old policy are retired", async () => {
  const box = makeBox();
  const { dir } = startRun(box, { policyHash: HASH_A });
  const steps = script(graph);

  const first = await drive(box, dir, graph, steps, { policyHash: HASH_A, grant: false });
  assert.equal(first.final.status, "waiting-approval");
  const [planRequest] = first.final.pendingApprovals;
  assert.equal(planRequest.kind, "plan");
  grantPending(box, dir, graph); // the plan, under policy A

  // The user policy changed: the run must ask before it goes on.
  const drifted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: HASH_B }));
  assert.equal(drifted.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(drifted.reason, "STALE_APPROVAL");
  const [resumeRequest] = drifted.pendingApprovals;
  assert.equal(resumeRequest.scope.operation, "resume");
  assert.equal(resumeRequest.scope.target, `${HASH_A}->${HASH_B}`);
  assert.equal(readEvents(dir).some((event) => event.type === "policy.bound" && event.to === HASH_B), false, "nothing is bound before the person agrees");
  assert.equal(loadRun(dir).run.policyHash, HASH_A);

  // Still ungranted: it asks again without writing anything new.
  const seq = loadRun(dir).run.lastSeq;
  const idle = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: HASH_B }));
  assert.equal(idle.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(loadRun(dir).run.lastSeq, seq);

  // Accept: grant the resume request.
  assert.deepEqual(grantPending(box, dir, graph), [resumeRequest.id]);
  const accepted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: HASH_B }));
  const events = readEvents(dir);
  const bound = events.filter((event) => event.type === "policy.bound");
  assert.deepEqual(bound.map((event) => [event.from, event.to]), [[HASH_A, HASH_B]]);
  assert.equal(accepted.run.policyHash, HASH_B);
  const old = accepted.run.approvals.find((approval) => approval.id === planRequest.id);
  assert.notEqual(old.invalidatedAt, null, "the plan approval granted under the old policy is no longer valid");
  const invalidated = events.filter((event) => event.type === "approval.invalidated").map((event) => event.id ?? event.approvalId);
  assert.ok(invalidated.includes(planRequest.id), JSON.stringify(invalidated));
  assert.ok(events.findIndex((event) => event.type === "policy.bound") < events.findIndex((event) => event.type === "approval.invalidated"), "bound first, then the old approvals are retired");

  // The plan has to be approved again under the new policy; after that the run completes.
  assert.equal(accepted.status, "waiting-approval");
  const [newPlan] = accepted.pendingApprovals;
  assert.equal(newPlan.kind, "plan");
  assert.notEqual(newPlan.id, planRequest.id);
  grantPending(box, dir, graph);
  const finished = await drive(box, dir, graph, steps, { policyHash: HASH_B });
  assert.equal(finished.final.status, "completed");
  assert.equal(readEvents(dir).filter((event) => event.type === "policy.bound").length, 1, "a later run under the same policy binds nothing again");
});

// --- autonomous mode through runLoop -------------------------------------------------------------------------------

function autonomousPolicy(over = {}) {
  return {
    v: 1,
    mode: "autonomous",
    autonomous: {
      workflows: ["delivery@1"],
      repos: ["placeholder"],
      branches: ["feat/*"],
      tools: ["shell", "git", "read"],
      operations: ["commit", "push-branch"],
      ...over,
    },
  };
}

/** One tool action on the intake node of a fresh run, with the policy and branch given. */
async function proposeOnce(action, { policy, branch = "feat/x", repoKey } = {}) {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const effective = policy ?? autonomousPolicy({ repos: [repoKey ?? box.repo.key] });
  const executor = createFakeExecutor({ v: 1, steps: [{ node: "intake", action }] });
  const result = await runLoop(baseOptions(box, dir, graph, { executor, dispatcher, policy: effective, branch, guardOptions: { remotesOf: () => ["origin"] } }));
  return { result, dispatcher, dir, box };
}

test("autonomous: a tool the policy does not list is denied (TOOL_NOT_ALLOWED, exit 7) and nothing runs", async () => {
  const { result, dispatcher, dir } = await proposeOnce(tool("write", { path: "notes.txt", content: "x" }));
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.decision.reason, "TOOL_NOT_ALLOWED");
  assert.equal(dispatcher.calls.length, 0);
  assert.equal(readEvents(dir).some((event) => event.type === "action.started"), false);
});

test("autonomous: a listed operation (commit) is allowed and dispatched", async () => {
  const { result, dispatcher } = await proposeOnce(tool("shell", { command: 'git commit -m "wip"' }));
  assert.equal(dispatcher.calls.length, 1, `${result.reason} ${result.decision?.reason}`);
  assert.equal(result.decision.decision, "allow");
});

test("autonomous: an operation the policy leaves out (open-pr) needs an approval", async () => {
  const { result, dispatcher } = await proposeOnce(tool("shell", { command: "gh pr create --fill" }));
  assert.equal(result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(result.decision.reason, "OUT_OF_POLICY_OPERATION");
  assert.equal(result.pendingApprovals[0].scope.operation, "open-pr");
  assert.equal(dispatcher.calls.length, 0);
});

test("autonomous: push-branch is allowed only for a branch matching the policy's globs", async () => {
  const inside = await proposeOnce(tool("shell", { command: "git push origin feat/login" }));
  assert.equal(inside.dispatcher.calls.length, 1, `${inside.result.reason}`);
  assert.equal(inside.result.decision.decision, "allow");

  const outside = await proposeOnce(tool("shell", { command: "git push origin release/1.0" }));
  assert.equal(outside.dispatcher.calls.length, 0);
  assert.equal(outside.result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(outside.result.decision.reason, "OUT_OF_POLICY_OPERATION");
  assert.equal(outside.result.decision.ruleId, "operation-push-branch-scope");
});

test("autonomous: a default-branch push, merge and deploy always need an approval, whatever the policy lists", async () => {
  const greedy = autonomousPolicy({ operations: ["commit", "push-branch", "open-pr"], tools: ["shell", "git", "read", "write", "edit"] });
  const main = await proposeOnce(tool("shell", { command: "git push origin main" }), { policy: greedy, branch: "feat/x" });
  assert.equal(main.result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(main.result.decision.reason, "DEFAULT_BRANCH_PUSH");
  assert.equal(main.dispatcher.calls.length, 0);

  for (const name of ["merge", "deploy"]) {
    const { result, dispatcher } = await proposeOnce(tool(name, { target: "prod" }), { policy: greedy });
    assert.equal(result.exitCode, EXIT.APPROVAL_REQUIRED, name);
    assert.equal(result.decision.reason, "OUT_OF_POLICY_OPERATION", name);
    assert.equal(result.pendingApprovals[0].scope.operation, name);
    assert.equal(dispatcher.calls.length, 0, name);
  }
});

test("autonomous: commands the guard cannot follow are denied outright, where supervised mode would ask", async () => {
  const command = 'bash -c "echo hi"';
  const autonomous = await proposeOnce(tool("shell", { command }));
  assert.equal(autonomous.result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(autonomous.result.decision.reason, "UNPARSEABLE_COMMAND");

  const supervised = await proposeOnce(tool("shell", { command }), { policy: { v: 1, mode: "supervised" } });
  assert.equal(supervised.result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(supervised.result.decision.reason, "UNPARSEABLE_COMMAND");
});

test("autonomous scope: a repository, workflow or branch outside the policy runs supervised (the autonomous tool list does not apply)", async () => {
  const otherRepo = await proposeOnce(tool("write", { path: "notes.txt", content: "x" }), { repoKey: "somewhere-else" });
  assert.equal(otherRepo.dispatcher.calls.length, 1, "supervised mode does not use the autonomous tool list");
  const otherBranch = await proposeOnce(tool("write", { path: "notes.txt", content: "x" }), { branch: "main" });
  assert.equal(otherBranch.dispatcher.calls.length, 1);
  const noBranch = await proposeOnce(tool("write", { path: "notes.txt", content: "x" }), { branch: null });
  assert.equal(noBranch.dispatcher.calls.length, 1, "an unknown branch is not inside a branch-scoped policy");
});

// --- tokens budget -------------------------------------------------------------------------------------------------

test("tokens budget: reported usage adds up and exhausting it blocks the run", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = { v: 1, steps: Array.from({ length: 10 }, () => ({ node: "intake", action: wait(0) })) };
  const executor = { ...createFakeExecutor(steps), usage: () => ({ tokens: 600 }) };
  const result = await runLoop(baseOptions(box, dir, graph, { executor, budgets: { tokens: 1000 } }));
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "BUDGET_EXHAUSTED");
  assert.equal(result.exitCode, EXIT.ERROR);
  assert.equal(result.usage.tokens, 1200);
  const exhausted = readEvents(dir).find((event) => event.type === "budget.exhausted" && event.scope === "run");
  assert.deepEqual([exhausted.budget, exhausted.value, exhausted.limit], ["tokens", 1200, 1000]);
  assert.equal(readEvents(dir).filter((event) => event.type === "action.proposed").length, 2, "the third iteration is not run");
  assert.equal(loadRun(dir).run.budgets.used.tokens, 1200);

  // A bad usage report (negative, NaN, a string) is ignored rather than counted.
  const box2 = makeBox();
  const second = startRun(box2);
  const sloppy = { ...createFakeExecutor({ v: 1, steps: [{ node: "intake", action: wait(0) }, { node: "intake", action: wait(0) }] }), usage: () => ({ tokens: -5 }) };
  const ignored = await runLoop(baseOptions(box2, second.dir, graph, { executor: sloppy, budgets: { tokens: 10 } }));
  assert.equal(ignored.run.budgets.used.tokens, null);
  assert.notEqual(ignored.reason, "BUDGET_EXHAUSTED");
});

test("tokens budget: when the executor does not report usage it stays null, never 0, and never exhausts", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = { v: 1, steps: Array.from({ length: 4 }, () => ({ node: "intake", action: wait(0) })) };
  const first = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), budgets: { tokens: 1 } }));
  assert.notEqual(first.reason, "BUDGET_EXHAUSTED");
  assert.equal(first.usage.tokens, null);
  assert.equal(first.run.budgets.used.tokens, null);
  assert.equal(loadRun(dir).run.budgets.used.tokens, null);
  const seen = readEvents(dir).filter((event) => event.used).map((event) => event.used.tokens);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((value) => value === null), `used.tokens in the log: ${JSON.stringify([...new Set(seen)])}`);
  assert.equal(readEvents(dir).some((event) => event.type === "budget.exhausted"), false);
});

// --- lost run lock -------------------------------------------------------------------------------------------------

/** Lock options whose heartbeat timer is captured (so a test fires it by hand) instead of running on a clock. */
function manualHeartbeat() {
  const state = { fire: null };
  return {
    state,
    options: {
      setInterval: (fn) => {
        state.fire = fn;
        return { unref() {} };
      },
      clearInterval: () => {},
    },
  };
}

test("lock lost (the heartbeat can no longer refresh it): mutating actions are unavailable, nothing is dispatched, the run stays consistent", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const beat = manualHeartbeat();
  // The lock file still names us, but refreshing it fails with ENOENT: heartbeat() reports it as lost.
  const lockFs = {
    ...nodeFs,
    utimesSync: () => {
      throw Object.assign(new Error("gone"), { code: "ENOENT" });
    },
  };
  const inner = createFakeExecutor({
    v: 1,
    steps: [
      { node: "intake", action: tool("read", { path: "README.md" }) },
      { node: "intake", action: tool("write", { path: "notes.txt", content: "x" }) },
    ],
  });
  const executor = {
    ...inner,
    async decide(ctx, observation) {
      if (ctx.step === 1) beat.state.fire();
      return inner.decide(ctx, observation);
    },
  };
  const result = await runLoop(baseOptions(box, dir, graph, { executor, dispatcher, lockOptions: { ...beat.options, fs: lockFs } }));
  assert.deepEqual(dispatcher.calls.map((call) => call.tool), ["read"], "the read went through, the write did not");
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.decision.decision, "unavailable");
  assert.equal(result.decision.reason, "GUARD_UNAVAILABLE");
  assert.equal(result.decision.ruleId, "lock-not-held");
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "action.started").length, 1);
  assert.equal(events.some((event) => event.type === "action.started" && event.step === 1), false);
  const stored = loadRun(dir);
  assert.equal(stored.run.status, "blocked");
  assert.equal(stored.run.nodes.intake.outcome, "policy-denied");
  assert.equal(stored.run.lastSeq, events.at(-1).seq, "snapshot and log agree");
  assert.equal(inspectRunLock(dir).state, "none", "the lock is released at the end");
});

test("lock taken over by someone else: the ledger refuses every further write, nothing is dispatched, and the run stays readable", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const beat = manualHeartbeat();
  const inner = createFakeExecutor({ v: 1, steps: [{ node: "intake", action: tool("write", { path: "notes.txt", content: "x" }) }] });
  let before = null;
  const executor = {
    ...inner,
    async decide(ctx, observation) {
      before = readEvents(dir).length;
      nodeFs.writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: process.pid, hostname: "other", token: "someone-else", acquiredAt: new Date().toISOString() }));
      beat.state.fire();
      return inner.decide(ctx, observation);
    },
  };
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor, dispatcher, lockOptions: beat.options })), { code: "RUN_LOCK_REQUIRED" });
  assert.equal(dispatcher.calls.length, 0);
  assert.equal(readEvents(dir).length, before, "no event was written after the lock was lost");
  const stored = loadRun(dir);
  assert.equal(stored.run.nodes.intake.status, "running");
  assert.equal(stored.run.lastSeq, readEvents(dir).at(-1).seq);
});

// --- wait with a duration ------------------------------------------------------------------------------------------

test("wait: the loop sleeps through the injected sleep for the requested time and records the wait", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const sleeps = [];
  const steps = {
    v: 1,
    steps: [
      { node: "intake", action: wait(250) },
      { node: "intake", delayMs: 75 }, // a scripted plain delay is a wait too
      { node: "intake", action: tool("read", { path: "README.md" }), delayMs: 400 }, // a slow tool call sleeps via the same seam
    ],
  };
  const dispatcher = simulatedDispatcher();
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, sleep: async (ms) => void sleeps.push(ms) }));
  assert.deepEqual(sleeps, [250, 75, 400]);
  const completed = readEvents(dir).filter((event) => event.type === "action.completed");
  assert.deepEqual(completed.slice(0, 2).map((event) => event.result), [{ ok: true, waitedMs: 250 }, { ok: true, waitedMs: 75 }]);
  assert.deepEqual(dispatcher.calls.map((call) => call.tool), ["read"], "a wait is not a tool call");
  assert.equal(result.run.budgets.used.toolCalls, 1);
  assert.equal(result.run.budgets.used.iterations >= 3, true, "a wait still counts as an iteration");
});

test("wait: an interrupt during the sleep pauses the run (130); resuming repeats the wait in the same attempt", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const controller = new AbortController();
  const steps = { v: 1, steps: [{ node: "intake", action: wait(5000) }] };
  const sleeping = (ms, signal) =>
    new Promise((resolve, reject) => {
      queueMicrotask(() => controller.abort());
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const paused = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), sleep: sleeping, signal: controller.signal }));
  assert.equal(paused.status, "paused");
  assert.equal(paused.exitCode, EXIT.INTERRUPTED);
  assert.equal(readEvents(dir).some((event) => event.type === "action.completed"), false, "the interrupted wait is not recorded as done");

  const sleeps = [];
  const resumed = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), sleep: async (ms) => void sleeps.push(ms) }));
  assert.deepEqual(sleeps, [5000]);
  assert.equal(readEvents(dir).filter((event) => event.type === "node.entered").length, 1, "the same attempt continues: no new one is entered");
  assert.equal(resumed.run.nodes.intake.attemptLog.length, 1);
  assert.equal(readEvents(dir).filter((event) => event.type === "action.completed").length, 1);
});
