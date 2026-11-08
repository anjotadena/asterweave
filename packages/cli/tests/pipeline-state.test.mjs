// Pure pipeline reducer: dedupe, ordering, reruns, skipped/neutral policy, detection window, closable verdict.

import assert from "node:assert/strict";
import test from "node:test";
import { applyObservations, applyPull, planPoll, evaluate, initialState, normalizeCheck, normalizePolicy, normalizePull, normalizeRun, unionRequired } from "../src/runtime/pipeline/state.mjs";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const T0 = Date.parse("2026-01-01T00:00:00Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const policy = (extra = {}) => normalizePolicy({ required: ["ci.yml"], ...extra }).policy;

const run = (over = {}) => normalizeRun({ id: 100, run_attempt: 1, name: "CI", path: ".github/workflows/ci.yml", workflow_id: 7, status: "completed", conclusion: "success", event: "push", head_sha: MERGE, created_at: at(10), run_started_at: at(10), updated_at: at(60), html_url: "https://github.com/o/r/actions/runs/100", ...over });
const pull = (over = {}) => normalizePull({ number: 5, state: "closed", merged: true, merged_at: at(5), merge_commit_sha: MERGE, base: { ref: "main" }, head: { ref: "feat", sha: HEAD }, ...over });

function merged() {
  const s = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), pull(), at(6));
  return { ...s, listing: { [HEAD]: { complete: true, dropped: 0 }, [MERGE]: { complete: true, dropped: 0 } } }; // as left by a complete poll of both commits: a missing listing is incomplete
}
const verdict = (state, pol = policy(), seconds = 120) => evaluate(state, pol, T0 + seconds * 1000);
const fold = (state, ...observations) => applyObservations(state, observations, { now: at(200) });

test("PR state: open, merged (sticky), closed-unmerged; target is the merge commit", () => {
  const open = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), pull({ state: "open", merged: false, merged_at: null, merge_commit_sha: null }), at(1));
  assert.equal(open.pr.state, "open");
  assert.equal(open.target.sha, null);
  const state = merged();
  assert.equal(state.pr.state, "merged");
  assert.deepEqual(state.target, { sha: MERGE, branch: "main" });
  const reopened = applyPull(state, pull({ state: "open", merged: false, merged_at: null, merge_commit_sha: null }), at(9));
  assert.equal(reopened.pr.state, "merged", "merged is sticky");
  assert.equal(reopened.target.sha, MERGE);
  const closed = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), pull({ merged: false, merged_at: null, merge_commit_sha: null }), at(1));
  assert.equal(closed.pr.state, "closed-unmerged");
  assert.equal(verdict(closed).verdict, "closed-unmerged");
});

test("closable only when merged and every required key passed on the target commit", () => {
  const open = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), pull({ state: "open", merged: false, merged_at: null, merge_commit_sha: null }), at(1));
  assert.equal(verdict(fold(open, run({ head_sha: HEAD })).state).closable, false, "an open PR is never closable");
  const { state } = fold(merged(), run());
  const result = verdict(state);
  assert.equal(result.closable, true);
  assert.equal(result.verdict, "closable");
  assert.deepEqual(result.blockers, []);
  assert.equal(result.keys[0].state, "passed");
});

test("pre-merge runs on the PR head do not count for post-merge verification", () => {
  const { state } = fold(merged(), run({ head_sha: HEAD, id: 1 }));
  const result = verdict(state);
  assert.equal(result.closable, false);
  assert.equal(result.preMerge[0].state, "passed", "tracked as its own stage");
  assert.equal(result.keys[0].state, "waiting");
});

test("duplicate events are counted and change nothing", () => {
  const first = fold(merged(), run());
  const again = applyObservations(first.state, [run()], { now: at(300) });
  assert.deepEqual(again.outcomes, ["duplicate"]);
  assert.equal(again.state.counters.duplicates, 1);
  assert.deepEqual(again.state.slots, first.state.slots);
});

test("out-of-order: an older update, a lower attempt and a non-terminal report after a terminal one are ignored", () => {
  const { state } = fold(merged(), run({ status: "completed", conclusion: "failure", run_attempt: 2, updated_at: at(90) }));
  const stale = applyObservations(state, [run({ run_attempt: 1, status: "completed", conclusion: "success", updated_at: at(95) }), run({ run_attempt: 2, status: "in_progress", conclusion: null, updated_at: at(99) }), run({ run_attempt: 2, status: "completed", conclusion: "success", updated_at: at(80) })], { now: at(300) });
  assert.deepEqual(stale.outcomes, ["out-of-order", "out-of-order", "out-of-order"]);
  assert.equal(stale.state.counters.outOfOrder, 3);
  assert.equal(verdict(stale.state).keys[0].state, "failed", "terminal conclusions are sticky");
});

test("a rerun (higher run_attempt) supersedes the failed attempt and is remembered in the history", () => {
  const failed = fold(merged(), run({ conclusion: "failure" })).state;
  assert.equal(verdict(failed).verdict, "failed");
  const rerun = applyObservations(failed, [run({ run_attempt: 2, status: "in_progress", conclusion: null, updated_at: at(130) })], { now: at(300) });
  assert.deepEqual(rerun.outcomes, ["applied"]);
  assert.equal(verdict(rerun.state, policy(), 140).keys[0].state, "running");
  const done = applyObservations(rerun.state, [run({ run_attempt: 2, conclusion: "success", updated_at: at(180) })], { now: at(400) }).state;
  const result = verdict(done, policy(), 200);
  assert.equal(result.closable, true);
  assert.equal(result.keys[0].attempt, 2);
  assert.equal(done.counters.superseded, 1);
  const slot = Object.values(done.slots)[0];
  assert.deepEqual(slot.superseded.map((item) => `${item.attempt}:${item.conclusion}`), ["1:failure"]);
});

test("a newer run of the same workflow replaces an older run; an older run does not", () => {
  const state = fold(merged(), run({ id: 100, run_started_at: at(10) })).state;
  const older = applyObservations(state, [run({ id: 50, run_started_at: at(1), conclusion: "failure" })], { now: at(300) });
  assert.deepEqual(older.outcomes, ["out-of-order"]);
  const newer = applyObservations(state, [run({ id: 101, run_started_at: at(50), conclusion: "failure", updated_at: at(70) })], { now: at(300) });
  assert.deepEqual(newer.outcomes, ["applied"]);
  assert.equal(verdict(newer.state).verdict, "failed");
});

test("a run that disappears from later listings is not forgotten", () => {
  const first = fold(merged(), run({ conclusion: "failure" })).state;
  const next = planPoll(first, { pull: pull(), observations: [] }, { now: at(500) }).state;
  assert.equal(verdict(next).verdict, "failed");
  assert.equal(next.poll.count, 1);
});

test("skipped and neutral are not success unless the policy allows them", () => {
  for (const conclusion of ["skipped", "neutral"]) {
    const { state } = fold(merged(), run({ conclusion }));
    const strict = verdict(state);
    assert.equal(strict.closable, false, conclusion);
    assert.equal(strict.verdict, "not-passed");
    assert.equal(strict.keys[0].state, conclusion);
    const allowed = verdict(state, policy({ allowSkipped: ["ci.yml"] }));
    assert.equal(allowed.closable, true, `${conclusion} allowed`);
    assert.equal(allowed.keys[0].state, conclusion, "still shown as it is");
  }
});

test("cancelled, timed_out, action_required and unknown conclusions are never success", () => {
  for (const [conclusion, expected] of [["cancelled", "cancelled"], ["timed_out", "failed"], ["action_required", "failed"], ["mystery", "failed"]]) {
    const result = verdict(fold(merged(), run({ conclusion })).state);
    assert.equal(result.verdict, expected, conclusion);
    assert.equal(result.closable, false);
  }
});

test("run-not-detected only after the detection window; before it the key is waiting", () => {
  const state = merged();
  const early = verdict(state, policy({ detectionWindowMs: 60_000 }), 30);
  assert.equal(early.keys[0].state, "waiting");
  assert.equal(early.verdict, "waiting");
  const late = verdict(state, policy({ detectionWindowMs: 60_000 }), 200);
  assert.equal(late.keys[0].state, "run-not-detected");
  assert.equal(late.verdict, "run-not-detected");
  assert.equal(late.closable, false);
  assert.equal(late.blockers[0].key, "ci.yml");
});

test("empty required set is missing-configuration with a remediation, never closable", () => {
  const { state } = fold(merged(), run());
  const result = verdict(state, policy({ required: [] }));
  assert.equal(result.verdict, "missing-configuration");
  assert.equal(result.closable, false);
  assert.equal(result.blockers[0].state, "missing-configuration");
  assert.match(result.blockers[0].remediation, /completion\.requiredChecks/);
});

test("deployment keys must pass too", () => {
  const pol = policy({ required: ["ci.yml"], deployment: ["deploy"] });
  const ci = fold(merged(), run()).state;
  const waiting = verdict(ci, pol);
  assert.equal(waiting.closable, false);
  assert.deepEqual(waiting.blockers.map((b) => b.key), ["deploy"]);
  const deploy = normalizeCheck({ id: 9, name: "deploy", status: "completed", conclusion: "success", head_sha: MERGE, started_at: at(70), completed_at: at(100) });
  assert.equal(verdict(fold(ci, deploy).state, pol).closable, true);
});

test("check runs are matched by name; foreign shas are counted and ignored", () => {
  const check = normalizeCheck({ id: 3, name: "build", status: "completed", conclusion: "success", head_sha: MERGE, started_at: at(1), completed_at: at(9) });
  const foreign = normalizeCheck({ id: 4, name: "build", status: "completed", conclusion: "failure", head_sha: "c".repeat(40), started_at: at(1), completed_at: at(9) });
  const result = applyObservations(merged(), [check, foreign], { now: at(200) });
  assert.deepEqual(result.outcomes, ["applied", "foreign"]);
  assert.equal(verdict(result.state, policy({ required: ["build"] })).closable, true);
});

test("the trigger policy narrows which events count for the merge commit", () => {
  const pol = policy({ trigger: "push" });
  const result = applyObservations(merged(), [run({ event: "pull_request" })], { now: at(200), policy: pol });
  assert.deepEqual(result.outcomes, ["foreign"]);
});

test("hostile payloads: bad ids/shas dropped, text sanitized, no prototype keys, bounded", () => {
  assert.equal(normalizeRun({ id: "1", head_sha: MERGE }), null);
  assert.equal(normalizeRun({ id: 1, head_sha: "../x" }), null);
  assert.equal(normalizeRun(null), null);
  const nasty = normalizeRun({ id: 1, head_sha: MERGE, name: "\u001b[31mred\u001b[0m token=ghp_" + "x".repeat(30) + "y".repeat(500), status: "completed", conclusion: "success", workflow_id: 1, path: "__proto__" });
  assert.ok(!nasty.name.includes("\u001b"));
  assert.ok(!nasty.name.includes("x".repeat(30)));
  assert.ok(nasty.name.length <= 200);
  const result = applyObservations(merged(), [nasty], { now: at(200) });
  assert.equal(Object.getPrototypeOf(result.state.slots), Object.prototype);
  assert.equal({}.polluted, undefined);
  for (const key of Object.keys(result.state.slots)) assert.ok(key.startsWith("s|"));
});

test("slot count is bounded", () => {
  const many = [];
  for (let i = 1; i <= 520; i += 1) many.push(run({ id: i, workflow_id: i, path: `.github/workflows/w${i}.yml` }));
  const result = applyObservations(merged(), many, { now: at(200) });
  assert.equal(Object.keys(result.state.slots).length, 500);
  assert.equal(result.state.counters.dropped, 20);
});

test("normalizePolicy validates and unionRequired dedupes in precedence order", () => {
  const bad = normalizePolicy({ required: "ci", detectionWindowMs: 5, trigger: "x", allowSkipped: [1] });
  assert.equal(bad.problems.length, 4);
  assert.deepEqual(unionRequired(["a", "b"], ["b", "c"], undefined), ["a", "b", "c"]);
  assert.equal(normalizePolicy({ required: new Array(51).fill("x").map((x, i) => x + i) }).problems.length, 1);
});

test("the reducer is pure: inputs are not mutated", () => {
  const state = merged();
  const frozen = JSON.stringify(state);
  applyObservations(state, [run()], { now: at(200) });
  planPoll(state, { pull: pull(), observations: [run()] }, { now: at(200) });
  assert.equal(JSON.stringify(state), frozen);
});
