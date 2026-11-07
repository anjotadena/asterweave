// C1: the usage ledger event, per-node budgets, budget checkpoint + resume, and the pure aggregation.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { applyLoopEvent, foldEvents, runLoop } from "../src/runtime/loop.mjs";
import { resolveBudgets, resolveNodeBudgets, validatePolicy } from "../src/runtime/policy.mjs";
import { aggregateUsage, budgetLine, buildUsageEvent, eventTotal, normalizeUsageReport, remaining, validateUsageEvent } from "../src/runtime/usage.mjs";
import { cleanupTemp } from "./repo-fixture.mjs";
import { baseOptions, deliveryGraph, makeBox, readEvents, startRun, tool, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const graph = deliveryGraph;
const waits = (count) => ({ v: 1, steps: Array.from({ length: count }, () => ({ node: "intake", action: wait(0) })) });
const withUsage = (executor, usage) => ({ ...executor, usage });
/** The failure signature the loop completed the blocked node with (it travels in the reducer input of the group). */
const signatureOf = (dir) => readEvents(dir).findLast((event) => event.tx?.input?.type === "complete" && event.tx.input.outcome === "blocked")?.tx.input.signature;

// --- report validation ----------------------------------------------------------------------------------------------

test("usage reports: unknown stays null, bad values reject the whole report, nothing is echoed", () => {
  const ok = normalizeUsageReport({ inputTokens: 10, outputTokens: null, model: "claude-sonnet-5-5" });
  assert.equal(ok.ok, true);
  assert.deepEqual([ok.report.inputTokens, ok.report.outputTokens, ok.report.cacheReadTokens, ok.report.contextTokens], [10, null, null, null]);

  assert.equal(buildUsageEvent({ node: "intake", attempt: 1, report: normalizeUsageReport({ tokens: null }).report }), null, "nothing measured, nothing recorded");
  assert.equal(buildUsageEvent({ node: "intake", attempt: 1, report: normalizeUsageReport({}).report }), null);

  for (const bad of [{ tokens: -1 }, { inputTokens: 1.5 }, { inputTokens: "7" }, { outputTokens: Number.NaN }, { inputTokens: 1e13 }, { extra: 1 }, { model: "Bad Model!" }, { model: 3 }, "text", [1], 5]) {
    const verdict = normalizeUsageReport(bad);
    assert.equal(verdict.ok, false, JSON.stringify(bad));
    assert.ok(verdict.errors.every((message) => !message.includes("Bad Model")), "values are not echoed");
  }
  const secret = normalizeUsageReport({ ["ghp" + "_" + "a".repeat(36)]: 1 });
  assert.equal(secret.ok, false);
  assert.ok(!secret.errors.join(" ").includes("a".repeat(30)), "an odd field name is not echoed");
});

test("event totals: a reported total wins, else the measured input/output, else unknown", () => {
  assert.equal(eventTotal({ tokens: 7, inputTokens: 1, outputTokens: 2 }), 7);
  assert.equal(eventTotal({ inputTokens: 1, outputTokens: 2 }), 3);
  assert.equal(eventTotal({ inputTokens: 4, outputTokens: null }), 4);
  assert.equal(eventTotal({ inputTokens: null, outputTokens: null, cacheReadTokens: 99, contextTokens: 5 }), null, "cache and context do not count toward the budget total");
  assert.equal(eventTotal({ tokens: null }), null);
  assert.deepEqual([remaining(100, 30), remaining(100, 130), remaining(0, 5), remaining(null, 5), remaining(100, null)], [70, 0, null, null, null]);
  assert.deepEqual(budgetLine(null, 100), { used: null, limit: 100, remaining: null });
});

test("aggregation keeps unknown out of the sums and context apart from the cumulative totals", () => {
  const ev = (extra) => ({ type: "usage", node: "intake", attempt: 1, source: "executor", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, contextTokens: null, tokens: null, model: null, at: "t", ...extra });
  const events = [
    ev({ inputTokens: 100, outputTokens: 20, contextTokens: 120, model: "claude-opus-5-5", at: "t1" }),
    ev({ node: "plan", inputTokens: 50, cacheReadTokens: 400, model: "claude-opus-5-5", at: "t2" }),
    ev({ node: "plan", tokens: 30, contextTokens: 90, at: "t3" }),
    ev({ node: "bad node!" }), // malformed: skipped
    { type: "usage", node: "intake", source: "executor", inputTokens: -3 }, // malformed: skipped
    { type: "action.started", node: "intake" },
  ];
  const agg = aggregateUsage(events);
  assert.equal(agg.skipped, 2);
  assert.deepEqual([agg.totals.inputTokens, agg.totals.outputTokens, agg.totals.cacheReadTokens, agg.totals.cacheCreationTokens, agg.totals.tokens], [150, 20, 400, null, 100 + 20 + 50 + 30]);
  assert.deepEqual([agg.byNode.intake.tokens, agg.byNode.plan.tokens, agg.byNode.plan.outputTokens], [120, 80, null], "an unmeasured counter stays null per node");
  assert.deepEqual(Object.keys(agg.byModel).sort(), ["claude-opus-5-5", "unknown"]);
  assert.equal(agg.byModel["claude-opus-5-5"].inputTokens, 150);
  assert.deepEqual(agg.context, { tokens: 90, node: "plan", model: null, at: "t3" }, "the context is the latest measured value, not a sum");
  assert.equal(aggregateUsage([]).totals.tokens, null);
  assert.equal(aggregateUsage([]).context, null);
});

test("a usage event validates its envelope and rejects unknown fields", () => {
  const good = buildUsageEvent({ node: "intake", attempt: 2, report: normalizeUsageReport({ inputTokens: 1 }).report });
  assert.deepEqual(validateUsageEvent(good), []);
  assert.notDeepEqual(validateUsageEvent({ ...good, surprise: 1 }), []);
  assert.notDeepEqual(validateUsageEvent({ ...good, source: "network" }), []);
  assert.notDeepEqual(validateUsageEvent({ ...good, node: "../x" }), []);
});

// --- policy ---------------------------------------------------------------------------------------------------------

test("policy: perNode budgets are validated and kept apart from the run budgets", () => {
  const base = { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["r"], tools: ["read"], operations: [] } };
  const withBudgets = (budgets) => ({ ...base, autonomous: { ...base.autonomous, budgets } });
  assert.deepEqual(validatePolicy(withBudgets({ tokens: 5, perNode: { tokens: 100, toolCalls: 3, iterations: 4 } })), []);
  assert.ok(validatePolicy(withBudgets({ perNode: { wallMs: 5 } })).some((issue) => issue.includes("perNode.wallMs")));
  assert.ok(validatePolicy(withBudgets({ perNode: { tokens: -1 } })).some((issue) => issue.includes("perNode.tokens")));
  assert.ok(validatePolicy(withBudgets({ perNode: { tokens: 1.5 } })).length > 0);
  assert.ok(validatePolicy(withBudgets({ perNode: [] })).length > 0);

  const policy = withBudgets({ tokens: 5, perNode: { tokens: 100 } });
  assert.equal("perNode" in resolveBudgets(policy), false);
  assert.equal(resolveBudgets(policy).tokens, 5);
  assert.deepEqual(resolveNodeBudgets(policy), { tokens: 100 });
  assert.deepEqual(resolveNodeBudgets({ v: 1, mode: "supervised" }), {});
  assert.equal(resolveBudgets({ v: 1, mode: "supervised" }).tokens, null, "supervised: tokens unlimited");
});

// --- the loop -------------------------------------------------------------------------------------------------------

test("loop: a detailed report becomes a usage event, the token counter follows it, and the snapshot agrees", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const executor = withUsage(createFakeExecutor(waits(2)), (ctx) => ({ inputTokens: 100 * (ctx.step + 1), outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: null, contextTokens: 1000 + ctx.step, model: "claude-sonnet-5-5" }));
  const result = await runLoop(baseOptions(box, dir, graph, { executor, budgets: { iterations: 2 } }));
  const usage = readEvents(dir).filter((event) => event.type === "usage");
  assert.equal(usage.length, 2);
  assert.deepEqual(
    [usage[0].node, usage[0].attempt, usage[0].source, usage[0].inputTokens, usage[0].outputTokens, usage[0].cacheReadTokens, usage[0].cacheCreationTokens, usage[0].contextTokens, usage[0].model],
    ["intake", 1, "executor", 100, 10, 5, null, 1000, "claude-sonnet-5-5"],
  );
  assert.equal(typeof usage[0].at, "string");
  assert.equal(result.usage.tokens, 110 + 210);
  assert.equal(loadRun(dir).run.budgets.used.tokens, 320);
  assert.equal(aggregateUsage(readEvents(dir)).context.tokens, 1001);
});

test("loop: the legacy {tokens} shape still works, null is never 0, a rejected report is paths-only", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const reports = [{ tokens: 40 }, { tokens: null }, { inputTokens: "lots", sneaky: 1 }];
  const executor = withUsage(createFakeExecutor(waits(3)), (ctx) => reports[ctx.step]);
  const result = await runLoop(baseOptions(box, dir, graph, { executor, budgets: { iterations: 3 } }));
  assert.equal(result.run.budgets.used.tokens, 40);
  const events = readEvents(dir);
  assert.equal(events.filter((event) => event.type === "usage").length, 1, "the all-null report records nothing");
  const rejected = events.filter((event) => event.type === "usage.rejected");
  assert.equal(rejected.length, 1);
  assert.ok(!JSON.stringify(rejected[0]).includes("lots"));

  const quiet = startRun(makeBox(), { runId: "run-q" });
  const none = await runLoop(baseOptions(makeBox(), quiet.dir, graph, { executor: createFakeExecutor(waits(2)), budgets: { iterations: 2 } }));
  assert.equal(none.run.budgets.used.tokens, null);
  assert.equal(readEvents(quiet.dir).some((event) => event.type === "usage"), false);
});

test("loop: a measured total of 0 stays 0 across a restart, an unmeasured run stays null", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const zero = withUsage(createFakeExecutor(waits(3)), () => ({ inputTokens: 0, outputTokens: 0 }));
  const first = await runLoop(baseOptions(box, dir, graph, { executor: zero, budgets: { iterations: 1 } }));
  assert.equal(first.run.budgets.used.tokens, 0);
  const second = await runLoop(baseOptions(box, dir, graph, { executor: zero, budgets: { iterations: 5 }, stepMs: 5000 }));
  assert.equal(second.run.budgets.used.tokens, 0, "a measured 0 is not turned back into unknown");
  assert.equal(readEvents(dir).filter((event) => event.type === "usage").every((event) => event.tokens === null), true);
});

test("crash recovery: a usage event past the snapshot is folded into the token counter", () => {
  const box = makeBox();
  const { run } = startRun(box);
  const event = { type: "usage", seq: 99, node: "intake", attempt: 1, source: "executor", inputTokens: 7, outputTokens: 3, used: { ...run.budgets.used, tokens: 5 } };
  const folded = foldEvents(run, graph, [event]).run;
  assert.equal(folded.budgets.used.tokens, 15, "restored to the value before the event, then the event applied");
  assert.equal(applyLoopEvent(run, { type: "usage", inputTokens: null, outputTokens: null }), run, "an unmeasured event changes nothing");
});

// --- budgets: run and node level, checkpoint and resume -------------------------------------------------------------

test("run token budget: exhaustion checkpoints a blocked run, the same budget refuses to resume, a raised one continues", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const make = () => withUsage(createFakeExecutor(waits(10)), () => ({ inputTokens: 500, outputTokens: 100 }));
  const options = (budgets) => baseOptions(box, dir, graph, { executor: make(), budgets });

  const first = await runLoop(options({ tokens: 1000 }));
  assert.equal(first.status, "blocked");
  assert.equal(first.reason, "BUDGET_EXHAUSTED");
  const exhausted = readEvents(dir).find((event) => event.type === "budget.exhausted");
  assert.deepEqual([exhausted.scope, exhausted.budget, exhausted.value, exhausted.limit, exhausted.node], ["run", "tokens", 1200, 1000, "intake"]);
  const checkpoint = loadRun(dir).run;
  assert.equal(checkpoint.status, "blocked");
  assert.equal(checkpoint.nodes.intake.outcome, "blocked");
  assert.equal(checkpoint.budgets.used.tokens, 1200);
  assert.equal(signatureOf(dir), "budget:tokens");

  const again = await runLoop(options({ tokens: 1000 }));
  assert.equal(again.exitCode, EXIT.ERROR);
  assert.equal(again.reason, "BUDGET_EXHAUSTED");
  assert.equal(loadRun(dir).run.budgets.used.tokens, 1200, "a refused resume spends nothing");

  const raised = await runLoop(options({ tokens: 100_000 }));
  assert.notEqual(raised.reason, "BUDGET_EXHAUSTED");
  assert.equal(raised.run.budgets.used.tokens > 1200, true);
});

test("node token budget: the node is blocked (scope node), the run budget is untouched, resume needs a higher node limit", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const make = () => withUsage(createFakeExecutor(waits(10)), () => ({ inputTokens: 500, outputTokens: 100 }));
  const first = await runLoop(baseOptions(box, dir, graph, { executor: make(), nodeBudgets: { tokens: 1000 } }));
  assert.equal(first.status, "blocked");
  assert.equal(first.reason, "BUDGET_EXHAUSTED");
  assert.equal(first.exitCode, EXIT.ERROR);
  const exhausted = readEvents(dir).find((event) => event.type === "budget.exhausted");
  assert.deepEqual([exhausted.scope, exhausted.budget, exhausted.value, exhausted.limit, exhausted.node], ["node", "tokens", 1200, 1000, "intake"]);
  assert.equal(readEvents(dir).filter((event) => event.type === "action.proposed").length, 2, "the third iteration is not run");
  assert.equal(signatureOf(dir), "budget:node.tokens");

  const refused = await runLoop(baseOptions(box, dir, graph, { executor: make(), nodeBudgets: { tokens: 1000 } }));
  assert.equal(refused.exitCode, EXIT.ERROR);
  assert.equal(refused.reason, "BUDGET_EXHAUSTED");
  assert.equal(refused.status, "blocked");
  assert.equal(loadRun(dir).run.status, "blocked", "still checkpointed as blocked");
  assert.equal(loadRun(dir).run.budgets.used.tokens, 1200);
  const refusal = readEvents(dir).findLast((event) => event.type === "tool.decision" && event.point === "resume");
  assert.deepEqual([refusal.decision, refusal.reason], ["deny", "BUDGET_EXHAUSTED"], "the refusal is recorded as a resume decision");

  const raised = await runLoop(baseOptions(box, dir, graph, { executor: make(), nodeBudgets: { tokens: 100_000 } }));
  assert.notEqual(raised.reason, "BUDGET_EXHAUSTED");
  assert.equal(raised.run.budgets.used.tokens > 1200, true, "the run continued after the node budget was raised");
});

test("node budgets: the counts survive a restart, and tool calls and iterations are limited per node", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const reads = { v: 1, steps: Array.from({ length: 6 }, (_, index) => ({ node: "intake", action: tool("read", { path: `f${index}.txt` }) })) };
  const first = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(reads), nodeBudgets: { toolCalls: 2 } }));
  assert.equal(first.status, "blocked");
  const exhausted = readEvents(dir).find((event) => event.type === "budget.exhausted");
  assert.deepEqual([exhausted.scope, exhausted.budget, exhausted.value, exhausted.limit], ["node", "toolCalls", 2, 2]);
  assert.equal(first.run.budgets.used.toolCalls, 2);
  const restarted = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(reads), nodeBudgets: { toolCalls: 2 } }));
  assert.equal(restarted.reason, "BUDGET_EXHAUSTED", "the per-node count was rebuilt from the ledger");

  const box2 = makeBox();
  const second = startRun(box2);
  const iter = await runLoop(baseOptions(box2, second.dir, graph, { executor: createFakeExecutor(waits(8)), nodeBudgets: { iterations: 2 } }));
  const hit = readEvents(second.dir).find((event) => event.type === "budget.exhausted");
  assert.deepEqual([hit.scope, hit.budget, hit.value, hit.limit], ["node", "iterations", 2, 2]);
  assert.equal(iter.status, "blocked");
});

test("a node with no usage reported never exhausts a token budget (unknown is not 0)", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const result = await runLoop(baseOptions(box, dir, graph, { executor: createFakeExecutor(waits(4)), nodeBudgets: { tokens: 1 }, budgets: { iterations: 4 } }));
  assert.equal(result.reason === "BUDGET_EXHAUSTED" && result.run.budgets.used.iterations < 4, false);
  assert.equal(result.run.budgets.used.tokens, null);
  assert.equal(readEvents(dir).some((event) => event.type === "budget.exhausted" && event.budget === "tokens"), false);
});

test("usage from an executor that throws or is cut off is still recorded", async () => {
  const box = makeBox();
  const { dir } = startRun(box);
  const base = createFakeExecutor(waits(2));
  const flaky = { ...base, decide: async () => { throw new Error("model failed"); }, usage: () => ({ inputTokens: 70, outputTokens: 5 }) };
  const result = await runLoop(baseOptions(box, dir, graph, { executor: flaky, budgets: { iterations: 1 } }));
  assert.equal(result.run.budgets.used.tokens, 75);
  assert.equal(readEvents(dir).filter((event) => event.type === "usage").length, 1);
});
