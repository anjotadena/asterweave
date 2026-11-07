// The run loop: delivery pass path, repair loop, stable failure, malformed output, budgets, guard decisions,
// approvals, hooks, interruption and redaction.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { simulatedDispatcher } from "../src/runtime/executor.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { bugfixGraph } from "../src/runtime/graphs/bugfix.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { initialRun } from "../src/runtime/graph.mjs";
import { exitCodeFor, foldEvents, reconcileArtifacts, runLoop } from "../src/runtime/loop.mjs";
import { inspectRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp } from "./repo-fixture.mjs";
import { attempt, baseOptions, deliveryGraph, done, drive, ev, grantPending, makeBox, readEvents, script, sha, startRun, tool, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const graph = deliveryGraph;
const nodesOf = (run) => Object.fromEntries(Object.entries(run.nodes).map(([id, rec]) => [id, rec.status]));

test("EXIT carries the two new codes and stays frozen", () => {
  assert.equal(EXIT.APPROVAL_REQUIRED, 6);
  assert.equal(EXIT.POLICY_DENIED, 7);
  assert.ok(Object.isFrozen(EXIT));
});

test("delivery@1 passes end to end with the fake executor, stopping once for the plan approval", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const markers = [];
  const dispatcher = simulatedDispatcher({ effects: { write: (input) => void markers.push(input.path) } });
  const steps = script(graph, { implement: attempt(graph, "implement", { before: [tool("write", { path: "notes.txt", content: "hello" })] }) });

  const first = await drive(box, dir, graph, steps, { grant: false, dispatcher });
  assert.equal(first.final.status, "waiting-approval");
  assert.equal(first.final.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(first.final.run.currentNode, "approve");
  assert.equal(first.final.pendingApprovals.length, 1);
  assert.equal(first.final.pendingApprovals[0].kind, "plan");
  assert.equal(first.final.run.nodes.plan.status, "passed");
  assert.equal(first.final.run.artifacts.plan.revision, 1);

  const second = await drive(box, dir, graph, steps, { dispatcher });
  assert.equal(second.final.status, "completed");
  assert.equal(second.final.exitCode, EXIT.OK);
  assert.ok(Object.values(nodesOf(second.final.run)).every((status) => status === "passed"));
  assert.deepEqual(markers, ["notes.txt"]);
  assert.deepEqual(dispatcher.calls.map((call) => call.tool), ["write"]);

  const events = readEvents(dir);
  assert.deepEqual(events.map((event) => event.seq), events.map((_, index) => index + 1));
  const started = events.filter((event) => event.type === "action.started");
  const completed = events.filter((event) => event.type === "action.completed");
  assert.equal(started.length, 1);
  assert.equal(completed.length, 1);
  assert.equal(started[0].key, completed[0].key);
  assert.ok(events.some((event) => event.type === "approval.requested"));
  assert.ok(events.some((event) => event.type === "approval.granted"));
  assert.equal(events.at(-1).type, "run.completed");
  const loaded = loadRun(dir);
  assert.equal(loaded.behind, 0);
  assert.equal(loaded.run.lastSeq, events.length);
  assert.equal(second.final.usage.tokens, null, "the script reports no usage, which is not the same as zero");
});

test("bugfix@1 runs through the same loop", async () => {
  const box = makeBox();
  const { dir } = startRun(box, { graph: bugfixGraph, runId: "bug-1" });
  const plan = {
    analyze: attempt(bugfixGraph, "analyze"),
  };
  const { final } = await drive(box, dir, bugfixGraph, script(bugfixGraph, plan));
  assert.equal(final.status, "completed");
  assert.equal(final.run.nodes.analyze.attemptLog[0].evidence.some((item) => item.kind === "reproduction"), true);
});

test("repair loop: test fails, implement runs again, test passes on FRESH evidence", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph, {
    implement: [attempt(graph, "implement"), attempt(graph, "implement")],
    test: [attempt(graph, "test", { results: { "unit-test": "fail" }, outcome: "fail-retryable", signature: "unit-test:red" }), attempt(graph, "test")],
  });
  const { final } = await drive(box, dir, graph, steps);
  assert.equal(final.status, "completed");
  assert.equal(final.run.nodes.implement.attempts, 2);
  assert.equal(final.run.nodes.test.attempts, 2);
  const [first, second] = final.run.nodes.test.attemptLog;
  assert.equal(first.outcome, "fail-retryable");
  assert.equal(first.evidence.find((item) => item.kind === "unit-test").result, "fail");
  assert.equal(second.outcome, "pass");
  assert.equal(second.evidence.find((item) => item.kind === "unit-test").attempt, second.n, "evidence belongs to the new attempt");

  // Passing again without fresh evidence is refused (the old evidence does not count) and counts as a bad answer.
  const stale = makeBox();
  const run2 = startRun(stale, { runId: "stale-1" });
  const bad = script(graph, {
    implement: [attempt(graph, "implement"), attempt(graph, "implement")],
    test: [
      attempt(graph, "test", { results: { "unit-test": "fail" }, outcome: "fail-retryable", signature: "red" }),
      [{ node: "test", action: done("pass") }, { node: "test", action: done("pass") }, { node: "test", action: done("pass") }],
    ],
  });
  const result = await drive(stale, run2.dir, graph, bad);
  assert.notEqual(result.final.status, "completed");
  assert.ok(readEvents(run2.dir).some((event) => event.type === "action.rejected" && /EVIDENCE_MISSING/.test(event.errors.join(" "))));
});

test("the same failure signature twice blocks the run", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const red = () => attempt(graph, "test", { results: { "unit-test": "fail" }, outcome: "fail-retryable", signature: "unit-test:red" });
  const steps = script(graph, { implement: [attempt(graph, "implement"), attempt(graph, "implement")], test: [red(), red()] });
  const { final } = await drive(box, dir, graph, steps);
  assert.equal(final.status, "blocked");
  assert.equal(final.exitCode, EXIT.ERROR);
  assert.equal(final.run.nodes.test.attempts, 2);
  assert.ok(readEvents(dir).some((event) => event.type === "node.completed" && event.stableFailure === true));
});

test("malformed executor output: two re-asks are allowed, the third failure ends the attempt as fail-retryable", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const secret = "ghp" + "_abcdefghijklmnopqrstuvwxyz0123456789";
  const bad = JSON.stringify({ v: 1, type: "tool", tool: { name: "shell", input: { command: "ls" } }, leaked: secret });
  const steps = script(graph, { intake: [] });
  steps.steps.unshift({ node: "intake", malformed: "not json" }, { node: "intake", malformed: bad }, { node: "intake", malformed: "{}" }, ...attempt(graph, "intake"));
  const { final } = await drive(box, dir, graph, steps);
  assert.equal(final.status, "completed");
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "action.rejected").length, 3);
  const failed = events.find((event) => event.type === "node.completed" && event.node === "intake" && event.outcome === "fail-retryable");
  assert.equal(failed.signature, "executor:malformed-output");
  assert.equal(final.run.nodes.intake.attempts, 2);
  assert.equal(JSON.stringify(events).includes(secret), false, "raw executor output is never echoed into the ledger");
});

test("two malformed answers followed by a good one cost no attempt", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  steps.steps.unshift({ node: "intake", malformed: "oops" }, { node: "intake", malformed: "{}" });
  const { final } = await drive(box, dir, graph, steps);
  assert.equal(final.status, "completed");
  assert.equal(final.run.nodes.intake.attempts, 1);
});

test("a hung executor is cut off by the step deadline", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const hung = { id: "hung", observe: async () => ({}), decide: () => new Promise(() => {}) };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: hung, stepMs: 15, budgets: { iterations: 4 } }));
  const events = readEvents(dir);
  const rejected = events.filter((event) => event.type === "action.rejected");
  assert.ok(rejected.length >= 1, "the hung step was cut off and recorded (a vacuous .every would pass with none)");
  assert.ok(rejected.every((event) => /deadline/.test(event.errors.join(" "))));
  assert.notEqual(result.status, "completed");
});

test("an out-of-steps script asks for a human", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor({ v: 1, steps: [] }) }));
  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(result.run.nodes.intake.outcome, "needs-human");
  assert.equal(result.run.nodes.intake.attempts, 0, "the attempt is refunded");
});

test("iteration budget: the 4th iteration of an attempt is blocked, not run", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = { v: 1, steps: Array.from({ length: 8 }, () => ({ node: "intake", action: wait(0) })) };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), budgets: { iterations: 3 } }));
  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, EXIT.ERROR);
  assert.equal(result.reason, "BUDGET_EXHAUSTED");
  const events = readEvents(dir);
  const exhausted = events.find((event) => event.type === "budget.exhausted" && event.scope === "run");
  assert.deepEqual([exhausted.budget, exhausted.value, exhausted.limit], ["iterations", 3, 3]);
  assert.equal(events.filter((event) => event.type === "action.proposed").length, 3);
  assert.equal(result.run.nodes.intake.attempts, 0);
});

test("tool-call budget: the call over the limit is refused with BUDGET_EXHAUSTED and the run blocks", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const reads = Array.from({ length: 4 }, (_, index) => ({ node: "intake", action: tool("read", { path: `f${index}.txt` }) }));
  const dispatcher = simulatedDispatcher();
  const options = baseOptions(box, dir, graph, { executor: createFakeExecutor({ v: 1, steps: reads }), dispatcher, budgets: { toolCalls: 2 } });
  const result = await runLoop(options);
  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "BUDGET_EXHAUSTED");
  assert.equal(dispatcher.calls.length, 2);
  assert.equal(result.run.budgets.used.toolCalls, 2);

  // Resuming with the same budget is refused by the guard; raising it lets the run go on.
  const again = await runLoop({ ...options, executor: createFakeExecutor({ v: 1, steps: reads }) });
  assert.equal(again.status, "blocked");
  assert.equal(again.reason, "BUDGET_EXHAUSTED");
  const raised = await runLoop({ ...options, executor: createFakeExecutor({ v: 1, steps: reads }), budgets: { toolCalls: 50 } });
  assert.notEqual(raised.reason, "BUDGET_EXHAUSTED");
  assert.equal(raised.run.budgets.used.toolCalls > 2, true);
});

test("wall-clock budget blocks the run", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = { v: 1, steps: Array.from({ length: 30 }, () => ({ node: "intake", action: wait(0) })) };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), budgets: { wallMs: 150 } }));
  assert.equal(result.status, "blocked");
  assert.equal(readEvents(dir).find((event) => event.type === "budget.exhausted" && event.scope === "run").budget, "wallMs");
});

// --- guard -------------------------------------------------------------------------------------------

test("a destructive command is denied: policy-denied, exit 7, DESTRUCTIVE_COMMAND recorded, nothing dispatched", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action: tool("shell", { command: "git reset --hard HEAD~3" }) }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
  assert.equal(result.status, "blocked");
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.run.nodes.intake.outcome, "policy-denied");
  assert.equal(result.decision.reason, "DESTRUCTIVE_COMMAND");
  assert.equal(dispatcher.calls.length, 0);
  const events = readEvents(dir);
  const decision = events.find((event) => event.type === "tool.decision" && event.point === "dispatch");
  assert.deepEqual([decision.decision, decision.reason], ["deny", "DESTRUCTIVE_COMMAND"]);
  assert.equal(events.some((event) => event.type === "action.started"), false);
  assert.equal(exitCodeFor(result.run), EXIT.POLICY_DENIED);
});

test("the run loop reads a command in every shell dialect: a cmd-only or PowerShell-only reading denies it on any platform", async () => {
  // Quoted in POSIX, but cmd has no single quotes: only the cmd reading sees the second command. env: is a PowerShell provider, not a file.
  const cases = [
    ["echo 'x & rd /s /q . & '", "DESTRUCTIVE_COMMAND"],
    ["Get-Content env:GITHUB_TOKEN", "PATH_OUTSIDE_WORKSPACE"],
  ];
  for (const [command, reason] of cases) {
    const box = makeBox();
    const { dir } = startRun(box);
    const dispatcher = simulatedDispatcher();
    const steps = { v: 1, steps: [{ node: "intake", action: tool("shell", { command }) }] };
    const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
    assert.equal(result.exitCode, EXIT.POLICY_DENIED, command);
    assert.equal(result.decision.reason, reason, command);
    assert.equal(dispatcher.calls.length, 0, command);
  }
});

test("a guard that cannot evaluate fails closed", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const boom = () => {
    throw new Error("no home");
  };
  const steps = { v: 1, steps: [{ node: "intake", action: tool("shell", { command: "ls" }) }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, guardOptions: { homedir: boom } }));
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.decision.reason, "GUARD_UNAVAILABLE");
  assert.equal(dispatcher.calls.length, 0);
});

test("a path outside the workspace is denied", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const outside = process.platform === "win32" ? "C:\\Windows\\System32\\drivers\\etc\\hosts" : "/etc/hosts";
  const steps = { v: 1, steps: [{ node: "intake", action: tool("write", { path: outside, content: "x" }) }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps) }));
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.decision.reason, "PATH_OUTSIDE_WORKSPACE");
});

test("headless merge: waiting-approval (6); once granted, resume dispatches it exactly once and continues", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const merge = tool("merge", { branch: "feat/x", into: "main" });
  const steps = script(graph, { implement: attempt(graph, "implement", { before: [merge] }) });
  const planStop = await drive(box, dir, graph, steps, { dispatcher, grant: false });
  assert.equal(planStop.final.pendingApprovals[0].kind, "plan");
  grantPending(box, dir, graph); // the plan; the merge asks next
  const first = await drive(box, dir, graph, steps, { dispatcher, grant: false });
  assert.equal(first.final.status, "waiting-approval");
  assert.equal(first.final.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(first.final.run.currentNode, "implement");
  assert.equal(dispatcher.calls.length, 0);
  const [pending] = first.final.pendingApprovals;
  assert.equal(pending.kind, "operation");
  assert.equal(pending.scope.operation, "merge");
  assert.equal(first.final.decision.reason, "OUT_OF_POLICY_OPERATION");

  // Still ungranted: another run stays put and writes nothing.
  const lastSeq = loadRun(dir).run.lastSeq;
  const idle = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
  assert.equal(idle.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(loadRun(dir).run.lastSeq, lastSeq);

  const second = await drive(box, dir, graph, steps, { dispatcher });
  assert.equal(second.final.status, "completed");
  assert.deepEqual(dispatcher.calls.map((call) => call.tool), ["merge"]);
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "action.proposed" && event.node === "implement").length, 3, "merge, evidence and complete are each proposed once: the held merge is not asked for again");
  assert.equal(events.filter((event) => event.type === "action.completed" && event.node === "implement").length, 1);
});

test("a granted approval does not cover a different merge", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = script(graph, { implement: attempt(graph, "implement", { before: [tool("merge", { branch: "a" }), tool("merge", { branch: "b" })] }) });
  const result = await drive(box, dir, graph, steps, { dispatcher, maxRounds: 4 });
  assert.equal(result.final.status, "completed");
  assert.deepEqual(dispatcher.calls.map((call) => call.input.branch), ["a", "b"]);
  assert.equal(result.results.filter((entry) => entry.status === "waiting-approval").length, 3, "plan, merge a, merge b");
});

test("changing the plan artifact invalidates its approval and puts the run back at approve", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph, {
    plan: [attempt(graph, "plan", { revision: 1 }), attempt(graph, "plan", { revision: 2 })],
    implement: [attempt(graph, "implement"), attempt(graph, "implement")],
    test: [attempt(graph, "test", { outcome: "fail-replan", signature: "plan-wrong" }), attempt(graph, "test")],
  });
  const stopped = await drive(box, dir, graph, steps, { maxRounds: 2 });
  // Round 1 stops at approve, round 2 ran through implement and test (fail-replan), re-planned, and stopped at approve again.
  assert.equal(stopped.final.status, "waiting-approval");
  assert.equal(stopped.final.run.currentNode, "approve");
  assert.equal(stopped.final.run.artifacts.plan.revision, 2);
  assert.equal(stopped.final.run.nodes.approve.attempts, 0, "a new plan revision resets the approve budget");
  const [old, fresh] = stopped.final.run.approvals;
  assert.notEqual(old.invalidatedAt, null);
  assert.equal(fresh.invalidatedAt, null);
  assert.equal(fresh.grantedAt, null);
  assert.equal(fresh.revision, 2);
  const events = readEvents(dir);
  assert.ok(events.some((event) => event.type === "approval.invalidated" && event.approvalId === old.id));

  const finished = await drive(box, dir, graph, steps);
  assert.equal(finished.final.status, "completed");
});

test("without a valid approval the plan is never approved by the loop", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  const first = await drive(box, dir, graph, steps, { grant: false });
  assert.equal(first.final.run.nodes.approve.status, "pending");
  // A flag-less, unknown approval id can not be conjured by the executor.
  const again = await drive(box, dir, graph, steps, { grant: false });
  assert.equal(again.final.status, "waiting-approval");
  assert.equal(again.final.run.nodes.approve.attempts, 0);
  assert.equal(again.final.run.approvals.length, 1);
});

test("a changed policy makes the run ask before it resumes", async () => {
  const box = makeBox();
  const { dir } = startRun(box, { policyHash: "a".repeat(64) });
  const steps = script(graph);
  const options = { policyHash: "a".repeat(64) };
  const first = await drive(box, dir, graph, steps, { ...options, grant: false });
  assert.equal(first.final.status, "waiting-approval");
  grantPending(box, dir, graph);
  const drifted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: "b".repeat(64) }));
  assert.equal(drifted.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(drifted.reason, "STALE_APPROVAL");
  const request = drifted.pendingApprovals.find((approval) => approval.scope.operation === "resume");
  assert.ok(request);
  assert.equal(request.scope.target, `${"a".repeat(64)}->${"b".repeat(64)}`);
});

// --- hooks ---------------------------------------------------------------------------------------------

const hookEntry = (over) => ({ id: "h1", event: "tool.before", argv: ["checker"], kind: "validate", timeoutMs: 1000, onFailure: "block", source: "user", ...over });
const hookRun = (reply) => async () => ({ code: 0, signal: null, stdout: "", stderr: "", timedOut: false, error: null, truncated: false, ...reply });
const hookOptions = (reply) => ({ run: hookRun(reply), resolve: () => ({ path: "/usr/bin/checker" }) });

test("a validate hook can tighten a decision and cannot loosen one", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action: tool("read", { path: "README.md" }) }] };
  const deny = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, hooks: [hookEntry()], hookOptions: hookOptions({ stdout: '{"decision":"deny","reason":"not today"}' }) }));
  assert.equal(deny.exitCode, EXIT.POLICY_DENIED);
  assert.equal(deny.decision.reason, "HOOK_BLOCKED");
  assert.equal(dispatcher.calls.length, 0);

  const box2 = makeBox();
  const run2 = startRun(box2);
  const destructive = { v: 1, steps: [{ node: "intake", action: tool("shell", { command: "git reset --hard" }) }] };
  const stillDenied = await runLoop(baseOptions(box2, run2.dir, graph, { executor: createFakeExecutor(destructive), dispatcher, hooks: [hookEntry()], hookOptions: hookOptions({ stdout: '{"decision":"allow"}' }) }));
  assert.equal(stillDenied.decision.reason, "DESTRUCTIVE_COMMAND");
  assert.equal(stillDenied.exitCode, EXIT.POLICY_DENIED);
  assert.equal(dispatcher.calls.length, 0);
});

test("a validate hook asking for approval holds the tool until a scoped approval exists", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action: tool("read", { path: "a.txt" }) }, { node: "intake", action: done("needs-human") }] };
  const options = { dispatcher, hooks: [hookEntry()], hookOptions: hookOptions({ stdout: '{"decision":"require-approval","reason":"look first"}' }) };
  const first = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), ...options }));
  assert.equal(first.status, "waiting-approval");
  assert.equal(first.pendingApprovals[0].scope.operation, "hook:h1");
  assert.equal(dispatcher.calls.length, 0);
});

test("a failing log hook is recorded and never blocks", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const hooks = [hookEntry({ id: "after", event: "tool.after", kind: "log", onFailure: "ignore" }), hookEntry({ id: "done", event: "node.completed", kind: "log", onFailure: "ignore" })];
  const steps = script(graph, { intake: attempt(graph, "intake", { before: [tool("read", { path: "a.txt" })] }) });
  const { final } = await drive(box, dir, graph, steps, { hooks, hookOptions: hookOptions({ code: 1, stderr: "boom" }) });
  assert.equal(final.status, "completed");
  const results = readEvents(dir).filter((event) => event.type === "hook.result");
  assert.ok(results.length >= 2);
  assert.ok(results.every((event) => event.hooks.every((hook) => hook.effect === "ignored" && hook.status === "failed")));
});

test("a hook runner that throws fails closed for tool.before and is ignored for log events", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action: tool("read", { path: "a.txt" }) }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, hooks: [hookEntry()], runHooks: async (event, _payload, options) => { if (event === "tool.before") throw new Error("kaput"); return { results: [], decision: options.decision }; } }));
  assert.equal(result.exitCode, EXIT.POLICY_DENIED);
  assert.equal(result.decision.reason, "HOOK_FAILED");
  assert.equal(dispatcher.calls.length, 0);
});

// --- interruption, redaction, misuse ---------------------------------------------------------------------------

test("an abort signal pauses the run (130), releases the lock and resumes the SAME attempt", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const controller = new AbortController();
  const steps = script(graph);
  const inner = createFakeExecutor(steps);
  const executor = { ...inner, observe: async (ctx) => { if (ctx.node === "analyze") controller.abort(); return inner.observe(ctx); } };
  const interrupted = await runLoop(baseOptions(box, dir, graph, { executor, signal: controller.signal }));
  assert.equal(interrupted.status, "paused");
  assert.equal(interrupted.exitCode, EXIT.INTERRUPTED);
  assert.equal(inspectRunLock(dir).state, "none");
  const stored = loadRun(dir).run;
  assert.equal(stored.status, "paused");
  assert.equal(stored.currentNode, "analyze");
  assert.equal(stored.nodes.analyze.status, "running");
  assert.equal(stored.nodes.analyze.attempts, 1);

  const resumed = await drive(box, dir, graph, steps);
  assert.equal(resumed.final.status, "completed");
  assert.equal(resumed.final.run.nodes.analyze.attempts, 1, "no new attempt was consumed");
  const events = readEvents(dir);
  assert.ok(events.some((event) => event.type === "node.recovered" && event.node === "analyze" && event.continued === true));
  assert.ok(events.some((event) => event.type === "run.resumed"));
});

test("an already aborted signal pauses without running anything", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(script(graph)), signal: AbortSignal.abort(), dispatcher }));
  assert.equal(result.exitCode, EXIT.INTERRUPTED);
  assert.equal(inspectRunLock(dir).state, "none");
  assert.equal(readEvents(dir).some((event) => event.type === "action.proposed"), false);
});

test("every ledger event and the snapshot are redacted", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const token = "ghp" + "_0123456789abcdefghijklmnopqrstuvwxyzAB";
  const steps = script(graph, {
    intake: [
      [
        { node: "intake", action: { v: 1, type: "evidence", reason: `using ${token}`, evidence: { kind: "task", summary: `token ${token} found`, result: "pass" } } },
        { node: "intake", action: { v: 1, type: "tool", tool: { name: "read", input: { path: `secret-${token}.txt` } } } },
        { node: "intake", action: done("pass") },
      ],
    ],
  });
  await drive(box, dir, graph, steps);
  assert.equal(readFileSync(join(dir, "events.jsonl"), "utf8").includes(token), false);
  assert.equal(readFileSync(join(dir, "run.json"), "utf8").includes(token), false);
});

test("a run belonging to another graph is refused, and a finished run is left alone", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  await assert.rejects(runLoop(baseOptions(box, dir, bugfixGraph, { executor: createFakeExecutor({ v: 1, steps: [] }) })), (error) => error.code === "GRAPH_MISMATCH" && error.exitCode === EXIT.CONFIG);
  const finished = await drive(box, dir, graph, script(graph));
  assert.equal(finished.final.status, "completed");
  const seq = loadRun(dir).run.lastSeq;
  const again = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(script(graph)) }));
  assert.equal(again.status, "completed");
  assert.equal(again.exitCode, EXIT.OK);
  assert.equal(loadRun(dir).run.lastSeq, seq, "a completed run is not touched");
});

test("the executor contract is enforced", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: { id: "x" } })), (error) => error.code === "EXECUTOR_INVALID");
  await assert.rejects(runLoop({ dir }), TypeError);
});

test("the dispatcher is the loop's only way to act: a tool call is recorded before and after it runs", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const seen = [];
  const dispatcher = {
    id: "spy",
    async dispatch(action, ctx) {
      seen.push(readEvents(dir).filter((event) => event.type.startsWith("action.")).map((event) => event.type));
      return { ok: true, output: `ran ${action.tool.name} as ${ctx.key.slice(0, 8)}` };
    },
  };
  const steps = script(graph, { intake: attempt(graph, "intake", { before: [tool("read", { path: "a.txt" })] }) });
  await drive(box, dir, graph, steps, { dispatcher });
  assert.deepEqual(seen, [["action.proposed", "action.started"]], "action.started is on disk before the dispatcher runs");
});

// --- pure helpers -------------------------------------------------------------------------------------------

test("foldEvents rebuilds the snapshot from the log after a crash between event and snapshot", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(script(graph)) }));
  const full = loadRun(dir);
  // Rewind the snapshot to "just after run.created" and fold everything else back in.
  const created = full.events[0];
  const initial = structuredClone(full.run);
  assert.ok(created);
  const fresh = initialRun(graph, { runId: "run-1", goal: "ship the feature", repo: box.repo, now: full.run.createdAt });
  const folded = foldEvents(fresh, graph, full.events.slice(1));
  assert.equal(folded.run.currentNode, initial.currentNode);
  assert.equal(folded.run.status, initial.status);
  for (const id of Object.keys(initial.nodes)) {
    assert.equal(folded.run.nodes[id].status, initial.nodes[id].status, id);
    assert.equal(folded.run.nodes[id].attempts, initial.nodes[id].attempts, id);
  }
  assert.deepEqual(folded.run.artifacts, initial.artifacts);
  assert.deepEqual(folded.run.approvals.map((a) => a.id), initial.approvals.map((a) => a.id));
  assert.deepEqual(folded.run.budgets.used.toolCalls, initial.budgets.used.toolCalls);
});

test("reconcileArtifacts invalidates dependents and rewinds a run that already moved past one", () => {
  const run = initialRun(graph, { runId: "r", goal: "g", repo: { key: "k", realpath: "/w" }, now: "2026-01-01T00:00:00.000Z" });
  run.artifacts = { plan: { hash: sha("p2"), revision: 2, dependsOn: [] }, tests: { hash: null, revision: 1, dependsOn: ["plan"] } };
  run.approvals = [
    { id: "ap-1", kind: "plan", scope: { operation: "plan", target: "approve" }, artifact: "plan", subjectHash: sha("p1"), policyHash: null, revision: 1, requestedAt: "t", by: { source: "tty", name: "a" }, grantedAt: "t", invalidatedAt: null },
    { id: "ap-2", kind: "plan", scope: { operation: "plan", target: "x" }, artifact: "tests", subjectHash: sha("t1"), policyHash: null, revision: 1, requestedAt: "t", by: { source: "tty", name: "a" }, grantedAt: "t", invalidatedAt: null },
    { id: "ap-3", kind: "operation", scope: { operation: "merge", target: "{}" }, artifact: null, subjectHash: sha("m"), policyHash: null, revision: null, requestedAt: "t", by: null, grantedAt: null, invalidatedAt: null },
  ];
  for (const id of ["intake", "analyze", "challenge", "plan", "approve"]) run.nodes[id].status = "passed";
  run.currentNode = "implement";
  const result = reconcileArtifacts(run, graph, { plan: { revision: 1 }, tests: { revision: 1 } }, { now: "2026-01-01T00:00:01.000Z" });
  assert.deepEqual(result.events.filter((e) => e.type === "approval.invalidated").map((e) => e.approvalId), ["ap-1", "ap-2"], "transitive through dependsOn; operation approvals untouched");
  const rewind = result.events.find((e) => e.type === "run.rewound");
  assert.equal(rewind.to, "approve");
  assert.equal(result.run.currentNode, "approve");
  assert.equal(result.run.nodes.approve.status, "pending");
  assert.equal(result.run.nodes.implement.status, "pending");
  assert.equal(result.run.nodes.plan.status, "passed");
});


test("exitCodeFor maps every status", () => {
  const run = (status, outcome) => ({ status, currentNode: "n", nodes: { n: { outcome } } });
  assert.equal(exitCodeFor(run("completed")), 0);
  assert.equal(exitCodeFor(run("waiting-approval")), 6);
  assert.equal(exitCodeFor(run("paused")), 130);
  assert.equal(exitCodeFor(run("aborted")), 1);
  assert.equal(exitCodeFor(run("blocked", "policy-denied")), 7);
  assert.equal(exitCodeFor(run("blocked", "needs-human")), 6);
  assert.equal(exitCodeFor(run("blocked", "security-escalation")), 6);
  assert.equal(exitCodeFor(run("blocked", "blocked")), 1);
  assert.equal(exitCodeFor(run("blocked", "fail-retryable")), 1);
  assert.equal(exitCodeFor(run("waiting-external")), 0);
});


test("an executor can ask for an approval; the run waits (6) and then continues past the request", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const ask = { v: 1, type: "request-approval", approval: { operation: "publish", target: "package@1.0.0" }, reason: "release" };
  const steps = script(graph, { intake: attempt(graph, "intake", { before: [ask] }) });
  const first = await drive(box, dir, graph, steps, { grant: false });
  assert.equal(first.final.exitCode, EXIT.APPROVAL_REQUIRED);
  assert.equal(first.final.pendingApprovals[0].scope.operation, "publish");
  assert.equal(first.final.run.currentNode, "intake");
  const second = await drive(box, dir, graph, steps);
  assert.equal(second.final.status, "completed");
  assert.equal(second.final.run.nodes.intake.attempts, 1);
});

test("verify() sees the tool result, can add fresh evidence, and its verdict is recorded", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph, { intake: [{ node: "intake", action: tool("read", { path: "a.txt" }) }, { node: "intake", action: ev("task") }, { node: "intake", action: done("pass") }] });
  const inner = createFakeExecutor(steps);
  const seen = [];
  const executor = {
    ...inner,
    async verify(_ctx, result) {
      seen.push(result.ok);
      return { ok: true, reason: "looks right", evidence: [{ kind: "task", summary: "verified", result: "info" }] };
    },
  };
  const { final } = await drive(box, dir, graph, steps, { executor });
  assert.equal(final.status, "completed");
  assert.deepEqual(seen, [true]);
  assert.ok(readEvents(dir).some((event) => event.type === "action.verified" && event.ok === true));
  assert.equal(final.run.nodes.intake.attemptLog[0].evidence.some((item) => item.summary === "verified"), true);
});
