// Regression tests for the security and staff review of the Phase B runtime (loop, approvals, ledger groups).
// Each test fails against the code as it was before the review fixes.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { DISPLAY_LIMIT, displayProblem, displayTarget, grantApproval, requestApproval, scopeHash } from "../src/runtime/approvals.mjs";
import { defaultIdempotent, simulatedDispatcher } from "../src/runtime/executor.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { makeDecision } from "../src/runtime/guard.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { commitRecords, runLoop, signatureCounts } from "../src/runtime/loop.mjs";
import { acquireRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp } from "./repo-fixture.mjs";
import { attempt, baseOptions, deliveryGraph, drive, grantPending, makeBox, readEvents, script, startRun, tool } from "./loop-fixture.mjs";

after(cleanupTemp);

const graph = deliveryGraph;
const crash = () => Object.assign(new Error("simulated crash"), { code: "EIO" });
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const tty = { source: "tty", name: "tester" };

// A hook runner double for hooks.runHooks (the process runner and the binary resolver are injected).
const hookEntry = (over) => ({ id: "h1", event: "tool.before", argv: ["checker"], kind: "validate", timeoutMs: 1000, onFailure: "block", source: "user", ...over });
const hookOptions = (stdout) => ({ run: async () => ({ code: 0, signal: null, stdout, stderr: "", timedOut: false, error: null, truncated: false }), resolve: () => ({ path: "/usr/bin/checker" }) });

/** An fs that fails ONCE on the append of an event line containing `onLine`. */
function failOnLine(onLine) {
  let armed = true;
  return {
    ...nodeFs,
    writeSync(fd, buffer, ...rest) {
      if (armed && Buffer.isBuffer(buffer) && buffer.toString("utf8").includes(onLine)) {
        armed = false;
        throw crash();
      }
      return nodeFs.writeSync(fd, buffer, ...rest);
    },
  };
}

// --- M2: the executor may only downgrade idempotency --------------------------------------------------------------

test("M2: defaultIdempotent is read and write only (edit is not provably repeatable)", () => {
  const of = (name) => defaultIdempotent({ type: "tool", tool: { name, input: {} } });
  assert.deepEqual(["read", "write"].map(of), [true, true]);
  assert.deepEqual(["edit", "shell", "git", "merge", "deploy"].map(of), [false, false, false, false, false]);
});

async function interruptedThenResumed(action, hint) {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action, ...hint }] };
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher, fs: failOnLine('"type":"action.completed"') })), (error) => error.code === "EIO");
  const resumed = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
  return { dispatcher, resumed, proposed: readEvents(dir).find((event) => event.type === "action.proposed") };
}

test("M2: an executor that declares a shell action idempotent does not get it re-run after a crash (needs-human, one dispatch)", async () => {
  const { dispatcher, resumed, proposed } = await interruptedThenResumed(tool("shell", { command: "echo side-effect" }), { idempotent: true });
  assert.equal(dispatcher.calls.length, 1, "dispatched once, not again");
  assert.equal(proposed.idempotent, false);
  assert.equal(resumed.status, "blocked");
  assert.equal(resumed.reason, "SIDE_EFFECT_UNKNOWN");
  assert.equal(resumed.exitCode, EXIT.APPROVAL_REQUIRED);
});

test("M2: edit is not repeated after a crash, a write is, and the executor can only downgrade a write", async () => {
  const edit = await interruptedThenResumed(tool("edit", { path: "a.txt", old: "x", new: "y" }), {});
  assert.equal(edit.dispatcher.calls.length, 1);
  assert.equal(edit.resumed.reason, "SIDE_EFFECT_UNKNOWN");
  const write = await interruptedThenResumed(tool("write", { path: "a.txt", content: "x" }), {});
  assert.equal(write.dispatcher.calls.length, 2, "a plain write is repeatable");
  const downgraded = await interruptedThenResumed(tool("write", { path: "a.txt", content: "x" }), { idempotent: false });
  assert.equal(downgraded.dispatcher.calls.length, 1);
});

// --- M3: what is approved is what is shown ------------------------------------------------------------------------

test("M3: displayTarget escapes backslash, newline and tab so two different targets never look alike", () => {
  assert.equal(displayTarget("a\nb"), "a\\nb");
  assert.equal(displayTarget("a\\nb"), "a\\\\nb");
  assert.notEqual(displayTarget("a\nb"), displayTarget("a\\nb"));
  assert.equal(displayTarget("x\ty"), "x\\ty");
});

test("M3: displayProblem refuses long, control, invisible, direction-changing and redaction-altered scopes", () => {
  const ok = { operation: "shell", target: `echo hi${" ".repeat(50)}there\nnext\tline \\ back` };
  assert.equal(displayProblem(ok), null);
  assert.equal(displayProblem({ operation: "x", target: "y".repeat(DISPLAY_LIMIT) }), null);
  const bad = {
    long: "y".repeat(DISPLAY_LIMIT + 1),
    escape: "a\u001b[2Jb",
    c1: "a\u009bb",
    nul: "a\0b",
    cr: "a\rb",
    bidi: "a‮b",
    nbsp: "a b",
    zeroWidth: "a​b",
    separator: "a b",
    token: `echo ghp_${"A".repeat(36)}`,
    password: "run --password=hunter22",
    email: "send to someone@example.com",
  };
  for (const [name, target] of Object.entries(bad)) assert.notEqual(displayProblem({ operation: "shell", target }), null, name);
  assert.notEqual(displayProblem({ operation: "sh\u0007ell", target: "x" }), null, "the operation is checked too");
  assert.notEqual(displayProblem({ operation: "shell", target: 5 }), null);
});

async function requestFromExecutor(approval) {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const steps = { v: 1, steps: [{ node: "intake", action: { v: 1, type: "request-approval", approval } }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), dispatcher }));
  return { result, dir, dispatcher };
}

test("M3: the loop refuses to create an approval request for a target that would not display faithfully (UNDISPLAYABLE_TARGET, exit 7)", async () => {
  const cases = {
    long: "x".repeat(DISPLAY_LIMIT + 1),
    escape: "echo \u001b]0;pwned\u0007",
    bidi: "echo a‮b",
    zeroWidth: "echo a​b",
    token: `echo ghp_${"A".repeat(36)}`,
    email: "mail someone@example.com",
  };
  for (const [name, target] of Object.entries(cases)) {
    const { result, dir } = await requestFromExecutor({ operation: "shell", target });
    assert.equal(result.exitCode, EXIT.POLICY_DENIED, name);
    assert.equal(result.reason, "UNDISPLAYABLE_TARGET", name);
    assert.equal(result.run.approvals.length, 0, `${name}: no request exists`);
    assert.equal(result.run.nodes.intake.outcome, "policy-denied", name);
    const decision = readEvents(dir).find((event) => event.type === "tool.decision" && event.reason === "UNDISPLAYABLE_TARGET");
    assert.deepEqual([decision.decision, decision.ruleId], ["deny", "approval-display"], name);
    assert.ok(!JSON.stringify(readEvents(dir)).includes("pwned\u0007"), "the hostile text is not echoed raw");
  }
  const operation = await requestFromExecutor({ operation: "deploy\u001b[2J", target: "x" });
  assert.equal(operation.result.reason, "UNDISPLAYABLE_TARGET");
});

test("M3: whitespace padding is not collapsed or clipped away: the whole target is requested and shown, with who asked", async () => {
  const target = `echo harmless${" ".repeat(400)}&& DANGEROUS-TAIL\nsecond\tline\\x`;
  const { result } = await requestFromExecutor({ operation: "shell", target });
  assert.equal(result.status, "waiting-approval");
  assert.equal(result.exitCode, EXIT.APPROVAL_REQUIRED);
  const [approval] = result.pendingApprovals;
  assert.equal(approval.scope.target, target, "stored whole");
  assert.equal(approval.requestedBy, "executor");
  assert.equal(approval.subjectHash, scopeHash({ operation: "shell", target }));
});

test("M3: a guard-asked approval whose scope is too long to show is refused; a normal one records requestedBy guard", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const dispatcher = simulatedDispatcher();
  const long = { v: 1, steps: [{ node: "intake", action: tool("merge", { branch: "b".repeat(DISPLAY_LIMIT + 100) }) }] };
  const refused = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(long), dispatcher }));
  assert.equal(refused.exitCode, EXIT.POLICY_DENIED);
  assert.equal(refused.reason, "UNDISPLAYABLE_TARGET");
  assert.equal(dispatcher.calls.length, 0);

  const other = makeBox();
  const run2 = startRun(other);
  const merge = { v: 1, steps: [{ node: "intake", action: tool("merge", { branch: "feat/x" }) }] };
  const asked = await runLoop(baseOptions(other, run2.dir, graph, { executor: createFakeExecutor(merge), dispatcher }));
  assert.equal(asked.status, "waiting-approval");
  assert.equal(asked.pendingApprovals[0].requestedBy, "guard");
});

test("M3: a validate hook's question is recorded as requested by the hook", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = { v: 1, steps: [{ node: "intake", action: tool("read", { path: "a.txt" }) }] };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), hooks: [hookEntry()], hookOptions: hookOptions('{"decision":"require-approval","reason":"look"}') }));
  assert.equal(result.pendingApprovals[0].requestedBy, "hook");
});

test("M3: requestApproval records and validates requestedBy; a grant is refused when the stored scope no longer matches the bound one", () => {
  const run = { runId: "r", policyHash: HASH_A, artifacts: {}, approvals: [] };
  const made = requestApproval(run, { kind: "operation", scope: { operation: "merge", target: "{}" }, now: "2026-01-01T00:00:00.000Z", requestedBy: "hook" });
  assert.equal(made.approval.requestedBy, "hook");
  assert.throws(() => requestApproval(run, { kind: "operation", scope: { operation: "merge", target: "{}" }, now: "t", requestedBy: "model" }), (error) => error.code === "APPROVAL_REQUESTER_INVALID");
  assert.ok(grantApproval(made.run, "ap-1", { by: tty, now: "t", env: {} }));
  const edited = structuredClone(made.run);
  edited.approvals[0].scope.target = "{\"rm\":true}";
  assert.throws(() => grantApproval(edited, "ap-1", { by: tty, now: "t", env: {} }), (error) => error.code === "APPROVAL_SCOPE_MISMATCH");
  const hostile = requestApproval(run, { kind: "operation", scope: { operation: "deploy", target: "a‮b" }, now: "t" });
  assert.throws(() => grantApproval(hostile.run, "ap-1", { by: tty, now: "t", env: {} }), (error) => error.code === "UNDISPLAYABLE_TARGET");
});

// --- L1: executor-controlled keys ---------------------------------------------------------------------------------

test("L1: signature counts live in a prototype-less map, so __proto__ and constructor are ordinary signatures", () => {
  const counts = signatureCounts(["__proto__", "constructor", "constructor", "toString", "__proto__"]);
  assert.equal(Object.getPrototypeOf(counts), null);
  assert.equal(counts.constructor, 2);
  assert.equal(counts.__proto__, 2);
  assert.equal(counts.toString, 1);
  assert.deepEqual(Object.keys(counts).sort(), ["__proto__", "constructor", "toString"]);
});

// --- S1: an interrupted event group is completed ------------------------------------------------------------------

test("S1: a torn second line of an event group is repaired and the missing event is written exactly once", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const destructive = ["git", "reset", "--hard"].join(" ");
  const steps = { v: 1, steps: [{ node: "intake", action: tool("shell", { command: destructive }) }] };
  let armed = true;
  const torn = {
    ...nodeFs,
    writeSync(fd, buffer, ...rest) {
      if (armed && Buffer.isBuffer(buffer) && /"runId":"[^"]*","type":"run.paused"/.test(buffer.toString("utf8"))) {
        armed = false;
        nodeFs.writeSync(fd, buffer.subarray(0, Math.floor(buffer.length / 2)));
        throw crash();
      }
      return nodeFs.writeSync(fd, buffer, ...rest);
    },
  };
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: torn })), (error) => error.code === "EIO");
  assert.equal(loadRun(dir).torn, true);
  const txId = loadRun(dir).events.find((event) => event.type === "node.completed").tx.id; // (the raw file ends in a torn line)

  for (let round = 0; round < 2; round += 1) {
    await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps) }));
    const events = readEvents(dir);
    const group = events.filter((event) => event.tx?.id === txId);
    assert.deepEqual(group.map((event) => [event.type, event.tx.i]), [["node.completed", 0], ["run.paused", 1]], `round ${round}: exactly once`);
    assert.ok(events.findIndex((event) => event.type === "ledger.repaired") < events.indexOf(group[1]), "written after the repair");
  }
});

// --- S2: artifact reconciliation travels with its transition ------------------------------------------------------

const planSteps = () =>
  script(graph, {
    plan: [attempt(graph, "plan", { revision: 1 }), attempt(graph, "plan", { revision: 2 })],
    implement: [attempt(graph, "implement"), attempt(graph, "implement")],
    test: [attempt(graph, "test", { outcome: "fail-replan", signature: "plan-wrong" }), attempt(graph, "test")],
  });

test("S2: the approval invalidation of a new plan revision survives a crash during the node.completed hooks", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = planSteps();
  await drive(box, dir, graph, steps, { maxRounds: 1 }); // up to the plan approval, which is then granted
  const state = { crash: false };
  const killer = {
    ...nodeFs,
    writeSync(fd, buffer, ...rest) {
      if (state.crash && Buffer.isBuffer(buffer) && buffer.toString("utf8").includes('"type":"hook.result"')) throw crash();
      return nodeFs.writeSync(fd, buffer, ...rest);
    },
  };
  const runHooks = async (event, payload, options) => {
    if (event === "node.completed" && payload.node === "plan") state.crash = true;
    return { results: event === "node.completed" ? [{ id: "h1", source: "user", kind: "log", status: "ok", effect: "none" }] : [], decision: options.decision };
  };
  const hooks = [hookEntry({ event: "node.completed", kind: "log", onFailure: "ignore" })];
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: killer, hooks, runHooks })), (error) => error.code === "EIO");

  const crashed = loadRun(dir);
  assert.equal(crashed.events.filter((event) => event.type === "approval.invalidated").length, 1, "durable although the hooks never finished");
  assert.notEqual(crashed.run.approvals[0].invalidatedAt, null);

  const finished = await drive(box, dir, graph, steps);
  assert.equal(finished.final.status, "completed");
  assert.equal(readEvents(dir).filter((event) => event.type === "approval.invalidated").length, 1, "not written twice");
});

test("S2: a crash right after the node.completed that changed the plan: the fold recomputes the invalidation and the group is completed", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = planSteps();
  await drive(box, dir, graph, steps, { maxRounds: 1 });
  let armed = true;
  const faulty = {
    ...nodeFs,
    renameSync(from, to) {
      if (armed && basename(String(to)) === "run.json") {
        const events = nodeFs.readFileSync(join(dir, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
        const plans = events.filter((event) => event.type === "node.completed" && event.node === "plan" && event.next === "approve");
        if (plans.length === 2 && events.at(-1) === plans[1]) {
          armed = false;
          throw crash();
        }
      }
      return nodeFs.renameSync(from, to);
    },
  };
  await assert.rejects(runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), fs: faulty })), (error) => error.code === "STORE_WRITE_FAILED");
  const crashed = loadRun(dir);
  assert.equal(crashed.behind, 1);
  assert.equal(crashed.run.approvals[0].invalidatedAt, null, "the snapshot is behind");

  const finished = await drive(box, dir, graph, steps);
  assert.equal(finished.final.status, "completed");
  const events = readEvents(dir);
  const planDone = events.filter((event) => event.type === "node.completed" && event.node === "plan" && event.next === "approve")[1];
  const invalidated = events.filter((event) => event.type === "approval.invalidated");
  assert.equal(invalidated.length, 1);
  assert.equal(invalidated[0].tx.id, planDone.tx.id, "in the same group as the transition");
  assert.equal(finished.final.run.approvals[0].invalidatedAt !== null, true);
  assert.equal(finished.final.run.approvals.at(-1).revision, 2, "the plan was approved again under revision 2");
});

// --- S3: node.before-enter hooks ----------------------------------------------------------------------------------

test("S3: a hook's require-approval on node.before-enter holds the node before it starts, and a grant lets it in", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const steps = script(graph);
  const options = { executor: createFakeExecutor(steps), hooks: [hookEntry({ event: "node.before-enter" })], hookOptions: hookOptions('{"decision":"require-approval","reason":"look first"}') };
  const first = await runLoop(baseOptions(box, dir, graph, options));
  assert.equal(first.status, "waiting-approval");
  assert.equal(first.exitCode, EXIT.APPROVAL_REQUIRED);
  const [request] = first.pendingApprovals;
  assert.equal(request.scope.operation, "hook:h1");
  assert.deepEqual(JSON.parse(request.scope.target), { attempt: 1, node: "intake", type: "enter" });
  assert.equal(request.requestedBy, "hook");
  assert.equal(first.run.nodes.intake.status, "pending", "not entered");
  assert.equal(first.run.nodes.intake.attempts, 0);

  grantPending(box, dir, graph);
  const second = await runLoop(baseOptions(box, dir, graph, { ...options, executor: createFakeExecutor(steps) }));
  assert.equal(second.run.nodes.intake.status, "passed", "the granted node ran");
  assert.equal(second.status, "waiting-approval", "the next node asks again");
  assert.equal(JSON.parse(second.pendingApprovals[0].scope.target).node, "analyze");
});

test("S3: node.before-enter hooks run for approval nodes too: a deny stops the node before any plan approval is requested", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const runHooks = async (event, payload, options) =>
    event === "node.before-enter" && payload.node === "approve"
      ? { results: [], decision: makeDecision("deny", "HOOK_BLOCKED", "hook:h1", { message: "no plan today" }) }
      : { results: [], decision: options.decision };
  const { final } = await drive(box, dir, graph, script(graph), { grant: false, hooks: [hookEntry({ event: "node.before-enter" })], runHooks });
  assert.equal(final.exitCode, EXIT.POLICY_DENIED);
  assert.equal(final.reason, "HOOK_BLOCKED");
  assert.equal(final.run.approvals.length, 0);
  assert.equal(final.run.nodes.approve.outcome, "policy-denied");
});

// --- S4: a stale policy ---------------------------------------------------------------------------------------------

function grantOne(box, dir, id, policyHash) {
  const lock = acquireRunLock(dir);
  try {
    const { run } = loadRun(dir);
    const result = grantApproval(run, id, { by: tty, now: box.now(), env: {}, policyHash });
    commitRecords({ dir, graph, lockToken: lock.token, now: box.now }, run, result.events);
  } finally {
    lock.release();
  }
}

test("S4: a policy change while a plan approval is pending: grants are stale, the run asks to accept the change and then asks again", async () => {
  const box = makeBox();
  const { dir } = startRun(box, { policyHash: HASH_A });
  const steps = script(graph);
  const first = await drive(box, dir, graph, steps, { policyHash: HASH_A, grant: false });
  const [plan] = first.final.pendingApprovals;
  assert.throws(() => grantApproval(loadRun(dir).run, plan.id, { by: tty, now: box.now(), env: {}, policyHash: HASH_B }), (error) => error.code === "APPROVAL_STALE");

  const drifted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: HASH_B }));
  assert.equal(drifted.reason, "STALE_APPROVAL", "not stuck on the stale pending plan request");
  assert.equal(drifted.exitCode, EXIT.APPROVAL_REQUIRED);
  const resume = drifted.pendingApprovals.find((approval) => approval.scope.operation === "resume");
  assert.ok(resume);
  grantOne(box, dir, resume.id, HASH_B); // the resume request is requested under A and accepts B

  const accepted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(steps), policyHash: HASH_B }));
  assert.equal(accepted.status, "waiting-approval");
  assert.equal(accepted.run.approvals.find((approval) => approval.id === plan.id).invalidatedAt !== null, true, "the stale pending request was retired");
  const [fresh] = accepted.pendingApprovals;
  assert.notEqual(fresh.id, plan.id);
  grantOne(box, dir, fresh.id, HASH_B);
  const finished = await drive(box, dir, graph, steps, { policyHash: HASH_B });
  assert.equal(finished.final.status, "completed");
});
