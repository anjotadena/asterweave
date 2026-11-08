// Security round 2 regressions: check-suite identity, unknown suites, incomplete listings, checkpoint size, poll.failed resilience, PR binding.

import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pollOnce } from "../src/runtime/pipeline/poll.mjs";
import { boundPullRequest, evidenceResult, pullReferences, targetProblem } from "../src/runtime/pipeline/run-link.mjs";
import { applyPull, evaluate, foldEvents, initialState, normalizeCheck, normalizePolicy, normalizePull, normalizeRun, planPoll } from "../src/runtime/pipeline/state.mjs";
import { CHECKPOINT_CAP_BYTES, EVENTS_FILE, ROTATED_FILE, loadPipeline, openPipelineSession, pipelineDir } from "../src/runtime/pipeline/store.mjs";
import { createGithubTools } from "../src/runtime/tools/github-api.mjs";
import { createFakeGithub } from "./fixtures/fake-github.mjs";

const HEAD = "a".repeat(40);
const M = "b".repeat(40);
const now = "2026-01-01T00:05:00Z";
const nowMs = Date.parse(now);
const pull = normalizePull({ number: 7, state: "closed", merged: true, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: M, base: { ref: "main" }, head: { ref: "f", sha: HEAD } });
const chk = (id, name, conclusion, start, app, suite) => normalizeCheck({ id, name, head_sha: M, status: "completed", conclusion, started_at: start, completed_at: start, app: app ? { id: app } : undefined, check_suite: suite ? { id: suite } : undefined });
const run = (id, p, event, conclusion, start, suite, attempt = 1) => normalizeRun({ id, run_attempt: attempt, name: "CI", path: p, workflow_id: p.length, status: "completed", conclusion, event, head_sha: M, run_started_at: start, updated_at: start, check_suite_id: suite });

function evaluatePolls(polls, policy, extra = {}) {
  let state = initialState({ repo: "o/r", prNumber: 7, now });
  const p = normalizePolicy(policy).policy;
  for (const poll of polls) state = planPoll(state, { pull, listing: bothComplete, ...poll }, { now, policy: p }).state;
  return evaluate(state, { ...p, ...extra }, nowMs);
}
const CI = ".github/workflows/ci.yml";
const X = ".github/workflows/x.yml";

test("P1: same Actions app, different check suites: a later impostor job cannot supersede the real failure; a rerun in the same suite can", () => {
  const polls = [{ observations: [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), run(101, X, "push", "success", "2026-01-01T00:00:12Z", 502), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 502)] }];
  const result = evaluatePolls(polls, { required: ["build"] });
  assert.equal(result.verdict, "failed");
  assert.equal(result.closable, false);
  const rerun = evaluatePolls([{ observations: [run(100, CI, "push", "success", "2026-01-01T00:00:10Z", 501), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(12, "build", "success", "2026-01-01T00:03:00Z", 15368, 501)] }], { required: ["build"] });
  assert.equal(rerun.closable, true, "same app, same suite, later check run supersedes");
});

test("a higher run_attempt of the SAME workflow run supersedes older attempts' checks, even in a new suite; never another workflow", () => {
  const sameRun = evaluatePolls([{ observations: [run(100, CI, "push", "success", "2026-01-01T00:04:00Z", 501, 1), run(100, CI, "push", "success", "2026-01-01T00:05:00Z", 503, 2), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(13, "build", "success", "2026-01-01T00:04:30Z", 15368, 503)] }], { required: ["build"] });
  assert.equal(sameRun.verdict, "closable");
  const otherWorkflow = evaluatePolls([{ observations: [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), run(101, X, "push", "success", "2026-01-01T00:04:00Z", 503, 2), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(13, "build", "success", "2026-01-01T00:04:30Z", 15368, 503)] }], { required: ["build"] });
  assert.equal(otherWorkflow.verdict, "failed", "a higher attempt of ANOTHER workflow supersedes nothing");
});

test("P2: a check on a suite no listed run owns counts only when the run listing was complete; incomplete listings are never closable", () => {
  const lone = [{ observations: [chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 999)], listing: [{ sha: M, complete: true }] }];
  assert.equal(evaluatePolls(lone, { required: ["build"] }).closable, true, "a complete listing proves it is not an Actions workflow job");
  const cut = [{ observations: [chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 999)], listing: [{ sha: M, complete: false }] }];
  const result = evaluatePolls(cut, { required: ["build"] });
  assert.equal(result.closable, false);
  assert.equal(result.keys[0].state, "waiting");
  assert.equal(result.keys[0].reason, "suite-event-unknown");
  assert.ok(result.blockers.some((b) => b.reason === "suite-event-unknown"));
  assert.ok(result.blockers.some((b) => b.reason === "required-checks-unavailable"), "an incomplete listing is also reported on its own");
  const impostor = evaluatePolls([{ observations: [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 999)], listing: [{ sha: M, complete: true }] }], { required: ["build"] });
  assert.equal(impostor.verdict, "failed");
  const everythingPasses = evaluatePolls([{ observations: [run(100, CI, "push", "success", "2026-01-01T00:00:10Z", 501), chk(10, "build", "success", "2026-01-01T00:01:00Z", 15368, 501)], listing: [{ sha: M, complete: false }] }], { required: ["build"] });
  assert.equal(everythingPasses.closable, false, "never closable while the listing is incomplete");
});

test("P2b/P2c: a check observed before its run is listed is invalidated by the later poll (evaluation uses the current suite map)", () => {
  const first = { observations: [chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 999)], listing: [{ sha: M, complete: true }] };
  const second = { observations: [run(102, ".github/workflows/bot.yml", "issue_comment", "success", "2026-01-01T00:01:50Z", 999)], listing: [{ sha: M, complete: true }] };
  assert.equal(evaluatePolls([first], { required: ["build"] }).closable, true, "before the run is known there is nothing to invalidate it");
  const after = evaluatePolls([first, second], { required: ["build"] });
  assert.equal(after.closable, false);
  assert.notEqual(after.keys[0].state, "passed");
  const withReal = evaluatePolls([{ observations: [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501), chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 999)] }, second], { required: ["build"] });
  assert.equal(withReal.verdict, "failed");
});

test("P8: a checkpoint of 500 maxed multibyte slots is written (exempt from the per-event cap, below the read cap) and reloads", (t) => {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-cp-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = pipelineDir("github.com", "o/r", 7, { env: { ASTERWEAVE_CONFIG_DIR: root } });
  const session = openPipelineSession(dir, { repo: "o/r", host: "github.com", prNumber: 7 });
  const big = (n, c) => c.repeat(n);
  const observations = Array.from({ length: 500 }, (_, i) => normalizeCheck({ id: 1000 + i, name: `${big(190, "é")}${i}`, head_sha: M, status: "completed", conclusion: "success", started_at: now, completed_at: now, app: { id: 1 + i }, html_url: `https://github.com/${big(280, "é")}` }));
  session.append(planPoll(session.state, { pull, observations }, { now }).event);
  assert.equal(Object.keys(session.state.slots).length, 500);
  for (let i = 0; i < 5; i += 1) session.append({ type: "link", sessionId: `s${i}`, pad: "x".repeat(900_000) });
  session.append({ type: "link", sessionId: "after-rotation" });
  const checkpointBytes = Buffer.byteLength(JSON.stringify({ type: "checkpoint", state: session.state }));
  assert.ok(checkpointBytes > 1024 * 1024 && checkpointBytes < CHECKPOINT_CAP_BYTES, `checkpoint ${checkpointBytes}`);
  session.close();
  assert.ok(statSync(path.join(dir, ROTATED_FILE)).size > 0);
  assert.ok(statSync(path.join(dir, EVENTS_FILE)).size < 8 * 1024 * 1024);
  const loaded = loadPipeline(dir);
  assert.equal(loaded.events[0].type, "checkpoint");
  assert.equal(Object.keys(loaded.state.slots).length, 500);
  assert.equal(loaded.state.links.sessionId, "after-rotation");
});

test("a poll.failed that cannot be recorded does not abort the watch: the failure is still returned", async () => {
  const fake = createFakeGithub();
  const tools = createGithubTools({ getToken: () => "t".repeat(20), fetch: fake.fetch });
  fake.setPull(7, { headSha: HEAD });
  fake.fault(/pulls\/7/, () => new Response("x", { status: 503 }));
  const session = { state: initialState({ repo: "o/r", prNumber: 7, now }), append() { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } };
  const result = await pollOnce({ session, client: tools.client, repo: { owner: "o", name: "r" }, prNumber: 7, policy: normalizePolicy({ required: ["ci.yml"] }).policy, nowMs: () => nowMs });
  assert.equal(result.outcome, "failed");
});

test("L-new-2: a run binds to a pull request only when its evidence names exactly one; several distinct references bind nothing", () => {
  assert.deepEqual(pullReferences("Fixes #3 see https://github.com/o/r/pull/9", "o/r"), [9], "exactly one own-repository URL wins; bare #N is not consulted");
  assert.deepEqual(pullReferences("https://github.com/o/r/pull/9 and https://github.com/o/r/pull/10", "o/r").sort((a, b) => a - b), [9, 10]);
  assert.deepEqual(pullReferences("Fixes #3 and #4", "o/r").sort(), [3, 4]);
  assert.deepEqual(pullReferences("Opened https://github.com/o/r/pull/9 (#9)", "o/r"), [9]);
  assert.deepEqual(pullReferences("https://github.com/o/r/pull/9", "o/r"), [9]);
  assert.deepEqual(pullReferences("https://github.com/other/repo/pull/4 and #5", "o/r"), [5], "other repositories' URLs are ignored");
  assert.deepEqual(pullReferences("see https://github.com/o/r/issues/12", "o/r"), []);
  const loaded = (summary, events = []) => ({ run: { nodes: { "submit-pr": { attemptLog: [{ evidence: [{ kind: "pull-request", summary }] }] } } }, events });
  assert.deepEqual(boundPullRequest(loaded("Fixes #3 ... https://github.com/o/r/pull/9"), "o/r"), { prNumber: 9, source: "submit-pr evidence" });
  assert.equal(boundPullRequest(loaded("Fixes #3 and #4"), "o/r"), null);
  assert.equal(boundPullRequest(loaded("https://github.com/o/r/pull/9 https://github.com/o/r/pull/10"), "o/r"), null);
  assert.deepEqual(boundPullRequest(loaded("Opened https://github.com/o/r/pull/9"), "o/r"), { prNumber: 9, source: "submit-pr evidence" });
  assert.equal(targetProblem(loaded("Opened https://github.com/o/r/pull/9"), { repo: "o/r", prNumber: 3 }) !== null, true);
  assert.equal(targetProblem(loaded("Fixes #3 ... https://github.com/o/r/pull/9"), { repo: "o/r", prNumber: 3 }) !== null, true);
  assert.equal(targetProblem(loaded("Fixes #3 and #4"), { repo: "o/r", prNumber: 3 }), null, "ambiguous evidence: the explicit pull request is accepted (and then recorded as the target)");
  const targeted = loaded("none", [{ type: "pipeline.target", repo: "o/r", prNumber: 4 }]);
  assert.equal(targetProblem(targeted, { repo: "o/r", prNumber: 5 }) !== null, true);
  assert.equal(targetProblem(targeted, { repo: "o/r", prNumber: 4 }), null);
  assert.equal(evidenceResult("waiting"), null);
  assert.equal(evidenceResult("closable"), "pass");
  assert.equal(evidenceResult("ambiguous-key"), "fail");
});

test("applyPull is unchanged by the suite map (pure)", () => {
  const state = applyPull(initialState({ repo: "o/r", prNumber: 7, now }), pull, now);
  assert.deepEqual(state.suites, {});
  assert.deepEqual(state.listing, {});
});

// Round 3: dropped observations fail closed -----------------------------------------------------------------------

const bothComplete = [{ sha: HEAD, complete: true }, { sha: M, complete: true }];
const buildPolicy = normalizePolicy({ required: ["build"] }).policy;

test("N1(a): pre-merge slots on the head cannot starve the merge commit; a full merge-commit slot table fails closed", () => {
  let state = initialState({ repo: "o/r", prNumber: 7, now });
  const pre = Array.from({ length: 499 }, (_, i) => normalizeCheck({ id: 1000 + i, name: "m" + i, head_sha: HEAD, status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-01T00:00:00Z", app: { id: 15368 }, check_suite: { id: 9000 } }));
  state = planPoll(state, { pull: normalizePull({ number: 7, state: "open", merged: false, base: { ref: "main" }, head: { ref: "f", sha: HEAD } }), observations: pre, listing: [{ sha: HEAD, complete: true }] }, { now, policy: buildPolicy }).state;
  assert.equal(Object.keys(state.slots).length, 250, "the head is capped at half");
  state = planPoll(state, { pull, observations: [chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 502), chk(10, "build", "failure", "2026-01-01T00:03:00Z", 15368, 501)], listing: bothComplete }, { now, policy: buildPolicy }).state;
  const result = evaluate(state, buildPolicy, nowMs);
  assert.equal(result.verdict, "failed", "the real failure was recorded");
  assert.equal(state.listing[M].complete, true);

  // a merge-commit table that is full: the failure arrives last and is dropped => never closable, whatever else passes
  let full = initialState({ repo: "o/r", prNumber: 7, now });
  const fillers = Array.from({ length: 499 }, (_, i) => normalizeCheck({ id: 2000 + i, name: "f" + i, head_sha: M, status: "completed", conclusion: "success", started_at: now, completed_at: now, app: { id: 15368 }, check_suite: { id: 7000 } }));
  full = planPoll(full, { pull, observations: [...fillers, chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 502)], listing: bothComplete }, { now, policy: buildPolicy }).state;
  const dropped = planPoll(full, { pull, observations: [chk(10, "build", "failure", "2026-01-01T00:03:00Z", 15368, 501)], listing: bothComplete }, { now, policy: buildPolicy });
  assert.equal(dropped.event.ignored.dropped, 1);
  assert.deepEqual(dropped.event.listing.find((item) => item.sha === M), { sha: M, complete: false, dropped: 1 });
  const closed = evaluate(dropped.state, buildPolicy, nowMs);
  assert.equal(closed.closable, false);
  assert.equal(closed.verdict, "waiting");
  assert.ok(closed.blockers.some((b) => b.reason === "required-checks-unavailable" && /observations-dropped/.test(b.remediation)));
});

test("N1(b): a trimmed poll never records its listing complete; the replayed event and a store round trip agree; a later complete poll clears the gap and shows the failure", (t) => {
  const state0 = initialState({ repo: "o/r", prNumber: 7, now });
  const observations = [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501)];
  for (let i = 0; i < 6; i += 1) observations.push(chk(200 + i, "filler" + i, "success", "2026-01-01T00:01:00Z", 15368, 600 + i));
  observations.push(run(101, X, "push", "success", "2026-01-01T00:00:11Z", 502), chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 502));
  const plan = planPoll(state0, { pull, observations, listing: bothComplete }, { now, policy: buildPolicy, maxEventBytes: 3000 });
  assert.equal(plan.event.trimmed, true);
  const listing = plan.event.listing.find((item) => item.sha === M);
  assert.equal(listing.complete, false);
  assert.ok(listing.dropped > 0);
  const live = evaluate(plan.state, buildPolicy, nowMs);
  assert.equal(live.closable, false, "the real failure was trimmed away, the impostor kept");
  assert.equal(live.verdict, "waiting");
  assert.ok(live.blockers.some((b) => b.reason === "required-checks-unavailable"));
  const replay = foldEvents(state0, [plan.event]);
  assert.deepEqual(replay.listing, plan.state.listing);
  assert.equal(evaluate(replay, buildPolicy, nowMs).closable, false);

  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-n1-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = pipelineDir("github.com", "o/r", 7, { env: { ASTERWEAVE_CONFIG_DIR: root } });
  const session = openPipelineSession(dir, { repo: "o/r", host: "github.com", prNumber: 7 });
  session.append(plan.event);
  session.close();
  assert.equal(evaluate(loadPipeline(dir).state, buildPolicy, nowMs).closable, false, "survives a reload");

  const healed = planPoll(plan.state, { pull, observations, listing: bothComplete }, { now, policy: buildPolicy });
  assert.deepEqual(healed.state.listing[M], { complete: true, dropped: 0 });
  const after = evaluate(healed.state, buildPolicy, nowMs);
  assert.equal(after.verdict, "failed", "a complete, untrimmed poll that records the failure gives failed");
});

test("N1: a 600-observation poll of maxed multibyte names is trimmed head-first and is not closable", () => {
  const e = "é";
  const observations = [];
  for (const sha of [HEAD, M]) {
    for (let i = 0; i < 150; i += 1) observations.push(normalizeRun({ id: (sha === HEAD ? 1 : 2) * 10000 + i, name: e.repeat(196) + i, path: `.github/workflows/${e.repeat(270)}${i}.yml`, workflow_id: i + 1, status: "completed", conclusion: "success", event: "push", head_sha: sha, head_branch: e.repeat(120), html_url: `https://github.com/o/r/actions/runs/${e.repeat(250)}`, run_started_at: now, updated_at: now, check_suite_id: i + 1 }, "github.com"));
    for (let i = 0; i < 150; i += 1) observations.push(normalizeCheck({ id: (sha === HEAD ? 3 : 4) * 10000 + i, name: e.repeat(196) + i, head_sha: sha, status: "completed", conclusion: "success", started_at: now, completed_at: now, app: { id: 15368 }, check_suite: { id: 5000 + i }, html_url: `https://github.com/o/r/runs/${e.repeat(260)}` }, "github.com"));
  }
  const required = normalizePolicy({ required: [e.repeat(196) + "0"] }).policy;
  const plan = planPoll(initialState({ repo: "o/r", prNumber: 7, now }), { pull, observations, listing: bothComplete }, { now, policy: required });
  assert.equal(plan.event.trimmed, true);
  assert.ok(Buffer.byteLength(JSON.stringify(plan.event)) <= 800_000);
  assert.ok(plan.event.observations.some((obs) => obs.headSha === M), "the merge commit is trimmed last");
  const head = plan.event.listing.find((item) => item.sha === HEAD);
  assert.equal(head.complete, false);
  const result = evaluate(plan.state, required, nowMs);
  assert.equal(result.closable, false);
});

// Round 4 ----------------------------------------------------------------------------------------------------------

const prFor = (merged, mergeSha = M) => normalizePull({ number: 7, state: merged ? "closed" : "open", merged, merged_at: merged ? "2026-01-01T00:00:00Z" : null, merge_commit_sha: mergeSha, base: { ref: "main" }, head: { ref: "f", sha: HEAD } });
const pathPolicy = normalizePolicy({ required: [CI] }).policy;

test("R3: when the merge commit IS the PR head, pre-merge pull_request runs and unattributed checks never satisfy a key", () => {
  const prRun = run(200, CI, "pull_request", "success", "2026-01-01T00:00:01Z", 701);
  prRun.headSha = HEAD;
  let state = initialState({ repo: "o/r", prNumber: 7, now });
  const listing = [{ sha: HEAD, complete: true }];
  state = planPoll(state, { pull: prFor(false, HEAD), observations: [prRun], listing }, { now, policy: pathPolicy }).state;
  state = planPoll(state, { pull: prFor(true, HEAD), observations: [prRun], listing }, { now, policy: pathPolicy }).state;
  const a = evaluate(state, pathPolicy, nowMs);
  assert.equal(a.closable, false, "4a: a pull_request run is not a push run");
  assert.equal(a.keys[0].state, "waiting");

  const preCheck = chk(20, "build", "success", "2026-01-01T00:00:02Z", 15368, 701);
  preCheck.headSha = HEAD;
  let b = planPoll(initialState({ repo: "o/r", prNumber: 7, now }), { pull: prFor(false, HEAD), observations: [preCheck], listing }, { now, policy: buildPolicy }).state;
  b = planPoll(b, { pull: prFor(true, HEAD), observations: [preCheck], listing }, { now, policy: buildPolicy }).state;
  const rb = evaluate(b, buildPolicy, nowMs);
  assert.equal(rb.closable, false, "4b: a check whose suite run is unknown is unknown, not satisfied");
  assert.equal(rb.keys[0].reason, "suite-event-unknown");

  // the real thing on the same sha: a push run and a check of that run's suite
  const pushRun = run(300, CI, "push", "success", "2026-01-01T00:03:00Z", 801);
  pushRun.headSha = HEAD;
  const pushCheck = chk(21, "build", "success", "2026-01-01T00:03:10Z", 15368, 801);
  pushCheck.headSha = HEAD;
  const real = planPoll(b, { pull: prFor(true, HEAD), observations: [pushRun, pushCheck], listing }, { now, policy: buildPolicy }).state;
  assert.equal(evaluate(real, buildPolicy, nowMs).closable, true);
  assert.equal(evaluate(real, pathPolicy, nowMs).closable, true);
});

test("R3: a run of another event recorded before the merge commit was known never counts for it", () => {
  let state = initialState({ repo: "o/r", prNumber: 7, now });
  const early = run(400, CI, "workflow_dispatch", "success", "2026-01-01T00:01:00Z", 901);
  early.headSha = M;
  state = planPoll(state, { pull: prFor(false), observations: [early], listing: [{ sha: M, complete: true }] }, { now, policy: pathPolicy }).state;
  state = planPoll(state, { pull: prFor(true), observations: [], listing: bothComplete }, { now, policy: pathPolicy }).state;
  assert.equal(evaluate(state, pathPolicy, nowMs).closable, false);
});

test("H1: a missing listing record for the merge commit is incomplete (fail closed); extra shas in a listing do not hide the merge commit's row", () => {
  const { state } = planPoll(initialState({ repo: "o/r", prNumber: 7, now }), { pull, observations: [chk(10, "build", "success", "2026-01-01T00:01:00Z", 15368, 501)] }, { now, policy: buildPolicy });
  assert.equal(state.listing[M], undefined);
  const result = evaluate(state, buildPolicy, nowMs);
  assert.equal(result.closable, false);
  assert.ok(result.blockers.some((b) => b.reason === "required-checks-unavailable" && /listing-unknown/.test(b.remediation)));
  const crowded = planPoll(initialState({ repo: "o/r", prNumber: 7, now }), { pull, observations: [chk(10, "build", "success", "2026-01-01T00:01:00Z", 15368, 501)], listing: [{ sha: "c".repeat(40), complete: true }, { sha: HEAD, complete: true }, { sha: M, complete: false }] }, { now, policy: buildPolicy });
  assert.equal(crowded.state.listing[M].complete, false);
  assert.equal(evaluate(crowded.state, buildPolicy, nowMs).closable, false);
});

test("R2: identities lost to a trim stay blocking until a later poll records them - absence never heals", (t) => {
  const real = [run(100, CI, "push", "failure", "2026-01-01T00:00:10Z", 501), chk(10, "build", "failure", "2026-01-01T00:01:00Z", 15368, 501)];
  const impostor = [run(101, X, "push", "success", "2026-01-01T00:00:11Z", 502), chk(11, "build", "success", "2026-01-01T00:02:00Z", 15368, 502)];
  const first = planPoll(initialState({ repo: "o/r", prNumber: 7, now }), { pull, observations: [...real, ...impostor], listing: bothComplete }, { now, policy: buildPolicy, maxEventBytes: 1400 });
  assert.equal(first.event.trimmed, true);
  assert.ok(first.event.lost.length > 0);
  assert.equal(evaluate(first.state, buildPolicy, nowMs).closable, false);
  // a complete, untrimmed poll in which GitHub no longer returns the failure (a deleted run): still blocked
  const second = planPoll(first.state, { pull, observations: impostor, listing: bothComplete }, { now, policy: buildPolicy });
  assert.deepEqual(second.state.listing[M], { complete: true, dropped: 0 });
  const stuck = evaluate(second.state, buildPolicy, nowMs);
  assert.equal(stuck.closable, false);
  assert.ok(stuck.blockers.some((b) => /observations-dropped/.test(b.remediation ?? "")));
  // replay and a store round trip keep it
  assert.equal(evaluate(foldEvents(initialState({ repo: "o/r", prNumber: 7, now }), [first.event, second.event]), buildPolicy, nowMs).closable, false);
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-r2-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = pipelineDir("github.com", "o/r", 7, { env: { ASTERWEAVE_CONFIG_DIR: root } });
  const session = openPipelineSession(dir, { repo: "o/r", host: "github.com", prNumber: 7 });
  session.append(first.event);
  session.append(second.event);
  session.close();
  assert.equal(evaluate(loadPipeline(dir).state, buildPolicy, nowMs).closable, false);
  // the failure is recorded again: that heals the identity and the verdict is failed
  const third = planPoll(second.state, { pull, observations: [...real, ...impostor], listing: bothComplete }, { now, policy: buildPolicy });
  assert.deepEqual(third.state.lost, {});
  assert.equal(evaluate(third.state, buildPolicy, nowMs).verdict, "failed");
});
