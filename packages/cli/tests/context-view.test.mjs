// The pure accounting view (runtime/usage-view.mjs): three separate numbers, unknown is never 0.

import assert from "node:assert/strict";
import test from "node:test";
import { buildUsageReport } from "../src/commands/usage.mjs";
import { CATALOG } from "../src/runtime/routing.mjs";
import { buildAccountingView, contextWindowOf, formatAccounting, formatAccountingCompact, formatAttachmentLines } from "../src/runtime/usage-view.mjs";

const limits = (tokens = null) => ({ run: { tokens, toolCalls: 0, iterations: 20, wallMs: 0 }, node: {} });
const usageEvent = (extra) => ({ type: "usage", node: "implement", attempt: 1, source: "executor", inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, contextTokens: null, tokens: null, model: null, ...extra });
const report = (events, tokenLimit) => buildUsageReport({ run: { nodes: { implement: {}, test: {} }, budgets: { used: { tokens: 0, toolCalls: 0, iterations: 1, wallMs: 5 } } }, events, limits: limits(tokenLimit) });
const sha = (char) => char.repeat(64);

test("three separate numbers: context size is the latest gauge, cumulative is the sum, budget is limit - used", () => {
  const usageReport = report([
    usageEvent({ inputTokens: 1000, outputTokens: 200, contextTokens: 9000, model: "claude-sonnet-5-5" }),
    usageEvent({ node: "test", inputTokens: 500, outputTokens: 100, contextTokens: 12000, model: "claude-sonnet-5-5" }),
  ], 5000);
  const view = buildAccountingView({ run: { runId: "run-1", status: "active" }, usageReport });
  assert.equal(view.contextTokens.tokens, 12000, "latest measured, not 21000");
  assert.equal(view.cumulative.inputTokens, 1500);
  assert.equal(view.cumulative.outputTokens, 300);
  assert.equal(view.cumulative.tokens, 1800);
  assert.deepEqual(view.budget.tokens, { used: 1800, limit: 5000, remaining: 3200 });
  assert.notEqual(view.contextTokens.tokens, view.cumulative.tokens);
  const lines = formatAccounting(view);
  const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
  assert.ok(at("1. Context size") < at("2. Cumulative usage") && at("2. Cumulative usage") < at("3. Budget remaining"));
  assert.match(lines.join("\n"), /12000 tokens at test \(claude-sonnet-5-5\) \(measured\)/);
  assert.match(lines.join("\n"), /input tokens\s+1500 \(measured\)/);
  assert.match(lines.join("\n"), /tokens\s+1800 \/ 5000, 3200 remaining/);
});

test("unknown is never 0: no usage at all", () => {
  const view = buildAccountingView({});
  assert.equal(view.source, "none");
  assert.equal(view.contextTokens.tokens, null);
  assert.deepEqual([view.cumulative.inputTokens, view.cumulative.outputTokens, view.cumulative.cacheReadTokens, view.cumulative.cacheCreationTokens, view.cumulative.tokens], [null, null, null, null, null]);
  assert.deepEqual(view.budget.tokens, { used: null, limit: null, remaining: null });
  assert.equal(view.window.tokens, null);
  assert.equal(view.percentUsed, null);
  assert.deepEqual(Object.values(view.counters), ["unknown", "unknown", "unknown", "unknown", "unknown"]);
  const out = formatAccounting(view).join("\n");
  assert.match(out, /no run yet/);
  assert.match(out, /input tokens\s+unknown/);
  assert.doesNotMatch(out, /input tokens\s+0/);
  assert.match(out, /1\. Context size[^\n]*\n  unknown/);
});

test("partly measured: only the measured counters are numbers, the others stay unknown and are not added", () => {
  const usageReport = report([usageEvent({ inputTokens: 40 }), usageEvent({ inputTokens: 2, cacheReadTokens: 7 })], null);
  const view = buildAccountingView({ run: { runId: "r" }, usageReport });
  assert.equal(view.cumulative.inputTokens, 42);
  assert.equal(view.cumulative.outputTokens, null);
  assert.equal(view.cumulative.cacheReadTokens, 7);
  assert.equal(view.cumulative.cacheCreationTokens, null);
  assert.equal(view.counters.outputTokens, "unknown");
  assert.equal(view.counters.inputTokens, "measured");
  assert.equal(view.budget.tokens.limit, null);
  assert.equal(view.budget.tokens.remaining, null, "no limit: no remaining");
});

test("the window comes only from a catalog entry that documents one; percent only when both are known", () => {
  const usageReport = report([usageEvent({ contextTokens: 50000, model: "claude-opus-5-5" })], null);
  assert.equal(contextWindowOf("claude-opus-5-5"), null, "the shipped catalog documents no window");
  const shipped = buildAccountingView({ run: { runId: "r" }, usageReport });
  assert.equal(shipped.window.tokens, null);
  assert.equal(shipped.percentUsed, null);
  assert.match(formatAccounting(shipped).join("\n"), /window\s+unknown \(the static catalog documents none for claude-opus-5-5\)/);
  const catalog = { ...CATALOG, "claude-opus-5-5": { ...CATALOG["claude-opus-5-5"], contextWindow: 200000 } };
  const documented = buildAccountingView({ run: { runId: "r" }, usageReport, catalog });
  assert.equal(documented.window.tokens, 200000);
  assert.equal(documented.window.source, "static-catalog");
  assert.equal(documented.percentUsed, 25);
  const noMeasure = buildAccountingView({ run: { runId: "r" }, usageReport: report([], null), route: { model: "claude-opus-5-5" }, catalog });
  assert.equal(noMeasure.window.tokens, 200000);
  assert.equal(noMeasure.percentUsed, null, "window known, context size unknown");
  assert.equal(contextWindowOf("claude-opus-5-5", { "claude-opus-5-5": { contextWindow: -5 } }), null);
  assert.equal(contextWindowOf("__proto__"), null);
});

test("an exhausted budget reads 0 remaining; a limit with unknown usage reads remaining unknown", () => {
  const exhausted = buildAccountingView({ run: { runId: "r" }, usageReport: report([usageEvent({ inputTokens: 900, outputTokens: 300 })], 1000) });
  assert.deepEqual(exhausted.budget.tokens, { used: 1200, limit: 1000, remaining: 0 });
  assert.match(formatAccounting(exhausted).join("\n"), /1200 \/ 1000, 0 remaining \(EXHAUSTED\)/);
  const unknown = buildAccountingView({ run: { runId: "r" }, usageReport: report([], 1000) });
  assert.deepEqual(unknown.budget.tokens, { used: null, limit: 1000, remaining: null });
  assert.match(formatAccounting(unknown).join("\n"), /unknown \/ 1000, remaining unknown/);
});

test("attachments: count and bytes, hashes only, sent once on the first turn; unknown size stays unknown", () => {
  const items = [
    { id: "img_aaaaaaaaaaaa", name: "a.png", format: "png", bytes: 1500, width: 10, height: 20, sha256: sha("a"), dataBase64: "SECRET-BYTES" },
    { id: "img_bbbbbbbbbbbb", name: "b.jpg", format: "jpeg", bytes: 500, width: 3, height: 4, sha256: sha("b") },
  ];
  const view = buildAccountingView({ run: { runId: "r" }, attachments: items });
  assert.equal(view.attachments.count, 2);
  assert.equal(view.attachments.bytes, 2000);
  assert.equal(view.attachments.sentOn, "first-turn");
  assert.ok(!JSON.stringify(view).includes("SECRET-BYTES"), "no image data is ever copied");
  const lines = formatAccounting(view).join("\n");
  assert.match(lines, /Attachments: 2 staged \(2\.0 KiB\), 0 sent/);
  assert.match(lines, /run start --session <id>/);
  assert.match(lines, new RegExp(`sha256 ${"a".repeat(12)}\\b`));
  assert.equal(lines.includes(sha("a")), false, "text shows a prefix only");
  const odd = buildAccountingView({ attachments: [{ id: "img_c", name: "c", format: "png", bytes: "many", sha256: "nothex" }] });
  assert.equal(odd.attachments.bytes, null);
  assert.equal(odd.attachments.items[0].sha256, null);
  assert.deepEqual(formatAttachmentLines({ items: [] }), ["  none staged"]);
  assert.equal(buildAccountingView({}).attachments.count, 0);
});

test("route: model, effort, pinned and drift", () => {
  const drift = { pinned: true, drifted: true, changes: [{ key: "default", pinned: "claude-opus-5-5", current: "claude-sonnet-5-5" }] };
  const view = buildAccountingView({ run: { runId: "r" }, route: { model: "claude-opus-5-5", effort: "high", source: "default", drift } });
  assert.deepEqual([view.route.model, view.route.effort, view.route.pinned, view.route.drifted], ["claude-opus-5-5", "high", true, true]);
  const out = formatAccounting(view).join("\n");
  assert.match(out, /Route: claude-opus-5-5, effort high \(default\), pinned by the run/);
  assert.match(out, /DRIFT/);
  assert.match(out, /default: pinned claude-opus-5-5, now claude-sonnet-5-5/);
  assert.match(formatAccounting(buildAccountingView({})).join("\n"), /Route: \(runner default\), current configuration/);
});

test("hostile titles, models and names are sanitised in the view", () => {
  const esc = String.fromCharCode(27);
  const hostile = `${esc}[31mred${esc}]0;title\u0007‮`;
  const view = buildAccountingView({
    run: { runId: "r", status: "active" },
    session: { id: "s1", title: hostile },
    route: { model: hostile, effort: hostile },
    attachments: [{ id: "img_x", name: hostile, format: "png", bytes: 1, sha256: sha("c") }],
  });
  const all = `${JSON.stringify(view)}${formatAccounting(view).join("\n")}`;
  assert.equal(all.includes(esc), false);
  assert.equal(all.includes("\u0007"), false);
  assert.equal(all.includes("‮"), false);
});

test("malformed input does not throw", () => {
  assert.doesNotThrow(() => buildAccountingView({ run: "x", session: 5, usageReport: [], route: "m", attachments: "nope", policy: 3 }));
  assert.doesNotThrow(() => formatAccounting(buildAccountingView({ usageReport: { totals: { inputTokens: -1, tokens: "7" }, byNode: { n: null }, byModel: { m: 4 }, context: { tokens: 1.5 }, budgets: { run: { tokens: { used: -2, limit: "x" } } } } })));
});

test("attachments: staged and sent are counted apart; sent items carry the run that sent them", () => {
  const items = [
    { id: "img_aaaaaaaaaaaa", name: "a.png", format: "png", bytes: 1000, width: 1, height: 1, sha256: sha("a"), sentRunId: null },
    { id: "img_bbbbbbbbbbbb", name: "b.png", format: "png", bytes: 500, width: 1, height: 1, sha256: sha("b"), sentRunId: "run-sent" },
    { id: "img_cccccccccccc", name: "old.png", format: "png", bytes: 100, width: 1, height: 1, sha256: sha("c") },
  ];
  const { attachments } = buildAccountingView({ run: { runId: "r" }, attachments: items });
  assert.deepEqual([attachments.count, attachments.staged, attachments.sent, attachments.bytes, attachments.stagedBytes], [3, 2, 1, 1600, 1100]);
  assert.deepEqual(attachments.items.map((item) => item.sentRunId), [null, "run-sent", null], "a record without the field counts as staged");
  const full = formatAccounting(buildAccountingView({ run: { runId: "r" }, attachments: items })).join("\n");
  assert.match(full, /Attachments: 2 staged \(1\.1 KiB\), 1 sent/);
  assert.match(full, /img_bbbbbbbbbbbb  sent by run-sent/);
  assert.match(full, /img_aaaaaaaaaaaa  staged/);
  assert.match(full, /images already sent are not sent again/);
  const compact = formatAccountingCompact(buildAccountingView({ run: { runId: "r" }, attachments: items })).join("\n");
  assert.match(compact, /Attachments: 2 staged \(1\.1 KiB\), 1 sent; staged images go out with: asterweave run start --session <id>/);
  const allSent = formatAccountingCompact(buildAccountingView({ run: { runId: "r" }, attachments: [items[1]] })).join("\n");
  assert.match(allSent, /Attachments: 0 staged, 1 sent$/m, "nothing staged: no 'will be sent' hint");
  assert.deepEqual([buildAccountingView({ attachments: null }).attachments.staged, buildAccountingView({ attachments: null }).attachments.sent], [null, null]);
});
