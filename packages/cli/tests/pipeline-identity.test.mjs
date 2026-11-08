// Identity of checks and runs, event filtering, key matching, unavailable sources (security review findings), against the pure reducer.

import assert from "node:assert/strict";
import test from "node:test";
import { applyObservations, applyPull, evaluate, initialState, normalizeCheck, normalizePolicy, normalizePull, normalizeRun, planPoll, validateRequiredChecks } from "../src/runtime/pipeline/state.mjs";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const T0 = Date.parse("2026-01-01T00:00:00Z");
const at = (seconds) => new Date(T0 + seconds * 1000).toISOString();
const policy = (extra = {}) => normalizePolicy({ required: ["ci.yml"], ...extra }).policy;
const WINDOW = 600;

const run = (over = {}) => normalizeRun({ id: 100, run_attempt: 1, name: "CI", path: ".github/workflows/ci.yml", workflow_id: 7, status: "completed", conclusion: "success", event: "push", head_sha: MERGE, created_at: at(10), run_started_at: at(10), updated_at: at(60), ...over });
const check = (over = {}) => normalizeCheck({ id: 10, name: "build", head_sha: MERGE, status: "completed", conclusion: "success", started_at: at(60), completed_at: at(70), app: { id: 15368 }, ...over });
const pull = (over = {}) => normalizePull({ number: 5, state: "closed", merged: true, merged_at: at(5), merge_commit_sha: MERGE, base: { ref: "main" }, head: { ref: "feat", sha: HEAD }, ...over });
const merged = () => {
  const s = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), pull(), at(6));
  return { ...s, listing: { [HEAD]: { complete: true, dropped: 0 }, [MERGE]: { complete: true, dropped: 0 } } }; // as left by a complete poll of both commits: a missing listing is incomplete
};
const fold = (state, ...observations) => applyObservations(state, observations, { now: at(200) });
const verdict = (state, pol = policy(), seconds = 120) => evaluate(state, pol, T0 + seconds * 1000);

test("H1: a check is identified by (producer, name): another app's later success cannot supersede a failure; a same-app rerun does", () => {
  const pol = policy({ required: ["build"] });
  const failed = check({ id: 10, conclusion: "failure", app: { id: 15368 } });
  const other = check({ id: 11, conclusion: "success", app: { id: 999 }, started_at: at(90), completed_at: at(91) });
  const mixed = fold(merged(), failed, other).state;
  assert.equal(verdict(mixed, pol).verdict, "failed");
  assert.equal(verdict(mixed, pol).closable, false);
  const rerun = check({ id: 12, conclusion: "success", app: { id: 15368 }, started_at: at(100), completed_at: at(110) });
  const superseded = fold(merged(), failed, rerun).state;
  assert.equal(verdict(superseded, pol).closable, true, "same app: the later check run supersedes");
  assert.equal(superseded.counters.superseded, 1);
  const unknown = fold(merged(), check({ id: 20, conclusion: "failure", app: null }), check({ id: 21, conclusion: "success", app: null, started_at: at(90), completed_at: at(91) })).state;
  assert.equal(verdict(unknown, pol).verdict, "failed", "without a producer nothing is superseded");
});

test("H1: a branch-protection app pin ignores check runs from any other app", () => {
  const pol = normalizePolicy({ required: ["build"], pins: [{ key: "build", appId: 15368 }] }).policy;
  const fake = fold(merged(), check({ id: 11, conclusion: "success", app: { id: 999 } })).state;
  const ignored = verdict(fake, pol);
  assert.equal(ignored.closable, false);
  assert.equal(ignored.keys[0].state, "waiting");
  assert.equal(verdict(fold(fake, check({ id: 12, app: { id: 15368 }, conclusion: "success" })).state, pol).closable, true);
  assert.equal(normalizePolicy({ pins: [{ key: "x", appId: 0 }] }).problems.length, 1);
});

test("H2: runs are identified by (workflow, event): a later run of another event cannot supersede; the default post-merge trigger is push", () => {
  const push = run({ id: 100, conclusion: "failure", event: "push" });
  for (const event of ["issue_comment", "schedule", "workflow_dispatch", "pull_request"]) {
    const result = fold(merged(), push, run({ id: 101, conclusion: "success", event, run_started_at: at(500), updated_at: at(510) }));
    assert.deepEqual(result.outcomes, ["applied", "foreign"], event);
    assert.equal(verdict(result.state).closable, false, event);
    assert.equal(verdict(result.state).verdict, "failed", event);
  }
  const alone = fold(merged(), run({ id: 101, conclusion: "success", event: "workflow_dispatch" })).state;
  assert.equal(verdict(alone).closable, false, "a non-push success alone is not enough either");
  const optIn = applyObservations(merged(), [run({ id: 102, event: "pull_request" })], { now: at(200), policy: normalizePolicy({ required: ["ci.yml"], trigger: "pull_request" }).policy });
  assert.deepEqual(optIn.outcomes, ["applied"]);
  assert.equal(normalizePolicy({ trigger: "issue_comment" }).problems.length, 1);
});

test("H2: a check run in the check suite of a run with another event is refused too", () => {
  const comment = run({ id: 101, event: "issue_comment", check_suite_id: 777 });
  const job = check({ id: 30, name: "build", app: { id: 15368 }, check_suite: { id: 777 }, conclusion: "success" });
  const state = fold(merged(), comment, job).state;
  assert.equal(state.counters.foreign, 1, "the issue_comment run itself");
  assert.equal(verdict(state, policy({ required: ["build"] })).closable, false);
  const own = fold(merged(), run({ id: 102, event: "push", check_suite_id: 778 }), check({ id: 31, name: "build", check_suite: { id: 778 } })).state;
  assert.equal(verdict(own, policy({ required: ["build"] })).closable, true);
});

test("L1: the trigger filter also applies when the merge commit equals the PR head sha", () => {
  const same = applyPull(initialState({ repo: "o/r", prNumber: 5, now: at(0) }), normalizePull({ number: 5, state: "closed", merged: true, merged_at: at(5), merge_commit_sha: HEAD, base: { ref: "main" }, head: { ref: "f", sha: HEAD } }), at(6));
  const result = applyObservations(same, [run({ head_sha: HEAD, event: "pull_request" })], { now: at(200), policy: normalizePolicy({ required: ["ci.yml"], trigger: "push" }).policy });
  assert.deepEqual(result.outcomes, ["foreign"]);
  assert.equal(verdict(result.state).closable, false);
});

test("M1: path keys match only the exact workflow path; bare keys match check names, never a workflow name", () => {
  const evil = run({ id: 200, name: "CI", path: ".github/workflows/evil.yml", workflow_id: 9 });
  const bare = fold(merged(), evil).state;
  const early = verdict(bare, policy({ required: ["CI"] }), 30);
  assert.equal(early.closable, false);
  assert.equal(early.keys[0].state, "waiting");
  const late = verdict(bare, policy({ required: ["CI"] }), WINDOW + 60);
  assert.equal(late.closable, false);
  assert.equal(late.keys[0].state, "ambiguous-key");
  assert.equal(late.verdict, "ambiguous-key");
  assert.match(late.blockers[0].remediation, /workflow file/);
  assert.equal(verdict(bare, policy({ required: [".github/workflows/ci.yml"] }), WINDOW + 60).keys[0].state, "run-not-detected", "evil.yml is not ci.yml");
  assert.equal(verdict(bare, policy({ required: ["ci.yml"] }), WINDOW + 60).keys[0].state, "run-not-detected");
  const nested = fold(merged(), run({ id: 300, name: "Other", path: ".github/workflows/sub/ci.yml", workflow_id: 11 })).state;
  assert.equal(verdict(nested, policy({ required: ["ci.yml"] }), WINDOW + 60).closable, false, "no basename match");
  assert.equal(verdict(fold(merged(), run()).state, policy({ required: [".github/workflows/ci.yml"] })).closable, true);
  const both = fold(merged(), run({ id: 100, conclusion: "failure" }), evil).state;
  assert.equal(verdict(both, policy({ required: ["ci.yml"] })).verdict, "failed");
});

test("unavailable required-check sources: never closable, a failing verdict still shows", () => {
  const { state } = fold(merged(), run());
  assert.equal(evaluate(state, { ...policy(), unavailable: null }, T0 + 120_000).closable, true);
  const result = evaluate(state, { ...policy(), unavailable: "branch-protection-GITHUB_HTTP_502" }, T0 + 120_000);
  assert.equal(result.closable, false);
  assert.equal(result.verdict, "waiting");
  assert.equal(result.blockers.at(-1).reason, "required-checks-unavailable");
  assert.equal(evaluate(fold(merged(), run({ conclusion: "failure" })).state, { ...policy(), unavailable: "x" }, T0 + 120_000).verdict, "failed");
  assert.equal(evaluate(merged(), { ...policy({ required: [] }), unavailable: "x" }, T0).verdict, "waiting", "a possibly incomplete set is not reported as missing-configuration");
});

test("validateRequiredChecks rejects whitespace-only and oversized entries; links keep only the configured host; poll events are bounded", () => {
  assert.equal(validateRequiredChecks(["ci", " "]).length, 1);
  assert.equal(validateRequiredChecks("x").length, 1);
  assert.equal(validateRequiredChecks(["x".repeat(201)]).length, 1);
  assert.equal(normalizeRun({ id: 1, head_sha: MERGE, html_url: "https://evil.example/x" }, "github.com").htmlUrl, null);
  assert.equal(normalizeRun({ id: 1, head_sha: MERGE, html_url: "https://github.com/o/r/actions/runs/1" }, "github.com").htmlUrl, "https://github.com/o/r/actions/runs/1");
  assert.equal(normalizeRun({ id: 1, head_sha: MERGE, html_url: "http://github.com/x" }, "github.com").htmlUrl, null);
  const many = Array.from({ length: 200 }, (_, i) => run({ id: 1000 + i, workflow_id: i, path: `.github/workflows/w${i}.yml` }));
  const { event, state } = planPoll(merged(), { pull: pull(), observations: many }, { now: at(200), maxEventBytes: 20_000 });
  assert.ok(Buffer.byteLength(JSON.stringify(event)) <= 20_000);
  assert.equal(event.trimmed, true);
  assert.equal(event.observations.length + event.ignored.dropped, 200);
  assert.equal(Object.keys(state.slots).length, event.observations.length, "the state matches what was recorded");
});
