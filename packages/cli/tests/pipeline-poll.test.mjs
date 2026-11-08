// Poller, token reader and required-check loader against the fake GitHub, a fake clock and a fake spawn. No network, no sleeping.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_DELAY_MS, MIN_DELAY_MS, backoffMs, classifyError, nextDelay, pollOnce, watchPipeline } from "../src/runtime/pipeline/poll.mjs";
import { loadRequiredChecks, pipelineConfigPath, readAdapterChecks } from "../src/runtime/pipeline/required.mjs";
import { evaluate, normalizePolicy } from "../src/runtime/pipeline/state.mjs";
import { loadPipeline, openPipelineSession, pipelineDir } from "../src/runtime/pipeline/store.mjs";
import { createTokenReader } from "../src/runtime/pipeline/token.mjs";
import { grantTrust } from "../src/trust.mjs";
import { NATIVE, fakeSpawn, installed } from "./auth-helpers.mjs";
import { createFakeGithub } from "./fixtures/fake-github.mjs";
import { createGithubTools } from "../src/runtime/tools/github-api.mjs";

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const T0 = Date.parse("2026-01-01T00:00:00Z");
const BIN = process.platform === "win32" ? "C:\\aw-bin" : "/aw-bin";
const REPO = { owner: "o", name: "r", full: "o/r" };

function harness(t, { policy = {}, pageSize } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-poll-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = { ms: T0 };
  const nowMs = () => clock.ms;
  const fake = createFakeGithub({ pageSize, now: nowMs });
  fake.setRate({ resetAtSec: Math.floor(T0 / 1000) + 3600 });
  const tools = createGithubTools({ getToken: () => "tok" + "x".repeat(20), fetch: fake.fetch, now: nowMs });
  const sleeps = [];
  const hooks = [];
  const sleep = async (ms, signal) => {
    sleeps.push(ms);
    clock.ms += ms;
    for (const hook of hooks) hook(clock.ms, sleeps.length);
    if (signal?.aborted) return;
  };
  const dir = pipelineDir("github.com", "o/r", 5, { env: { ASTERWEAVE_CONFIG_DIR: root } });
  const sessions = [];
  const open = () => {
    const session = openPipelineSession(dir, { repo: "o/r", host: "github.com", prNumber: 5 }, { now: () => new Date(nowMs()).toISOString() });
    sessions.push(session);
    return session;
  };
  t.after(() => sessions.forEach((session) => session.close()));
  const pol = normalizePolicy({ required: ["ci.yml"], ...policy }).policy;
  const args = (session, extra = {}) => ({ session, client: tools.client, repo: REPO, prNumber: 5, policy: pol, nowMs, sleep, random: () => 0.5, ...extra });
  const merge = () => fake.setPull(5, { state: "closed", merged: true, headSha: HEAD, mergeCommitSha: MERGE, mergedAt: new Date(nowMs()).toISOString() });
  return { root, clock, nowMs, fake, tools, sleeps, hooks, dir, open, pol, args, merge };
}

test("backoffMs stays within [5 s, 120 s], starts at the minimum, grows, and honours the jitter", () => {
  assert.equal(backoffMs(0, { random: () => 0 }), MIN_DELAY_MS);
  assert.equal(backoffMs(0, { random: () => 1 }), MIN_DELAY_MS);
  assert.equal(backoffMs(2, { random: () => 1 }), 20_000);
  assert.equal(backoffMs(2, { random: () => 0 }), 10_000);
  assert.equal(backoffMs(30, { random: () => 1 }), MAX_DELAY_MS);
  assert.equal(backoffMs(30, { random: () => 0 }), MAX_DELAY_MS / 2);
  for (let attempt = 0; attempt < 40; attempt += 1) for (const random of [0, 0.3, 1, 7, -3]) {
    const value = backoffMs(attempt, { random: () => random });
    assert.ok(value >= MIN_DELAY_MS && value <= MAX_DELAY_MS, `${attempt}/${random}: ${value}`);
  }
});

test("nextDelay: success grows while nothing changes; failure backs off; Retry-After and the reset time win when longer; both bounded", () => {
  const base = { nowMs: T0, random: () => 1 };
  assert.equal(nextDelay({ ...base, outcome: "ok", unchanged: 0, intervalMs: 10_000 }).delayMs, 10_000);
  assert.equal(nextDelay({ ...base, outcome: "ok", unchanged: 2, intervalMs: 10_000 }).delayMs, 40_000);
  assert.equal(nextDelay({ ...base, outcome: "ok", intervalMs: 1 }).delayMs, MIN_DELAY_MS, "the interval is floored at 5 s");
  assert.equal(nextDelay({ ...base, outcome: "failed", failures: 3 }).delayMs, 20_000);
  assert.deepEqual(nextDelay({ ...base, outcome: "rate-limited", failures: 1, retryAfterMs: 45_000 }), { delayMs: 45_000, serverRequested: true });
  assert.equal(nextDelay({ ...base, outcome: "ok", resetAtMs: T0 + 90_000 }).delayMs, 90_000);
  assert.equal(nextDelay({ ...base, outcome: "rate-limited", failures: 1, retryAfterMs: 1_000 }).delayMs, MIN_DELAY_MS, "never faster than the minimum");
  assert.equal(nextDelay({ ...base, outcome: "rate-limited", failures: 1, retryAfterMs: 10 * 3_600_000 }).delayMs, 3_600_000, "a server wait is capped at an hour");
});

test("classifyError separates rate limits, fatal problems, aborts and transient failures", () => {
  const e = (code, extra = {}) => Object.assign(new Error("x"), { code, ...extra });
  assert.equal(classifyError(e("GITHUB_RATE_LIMITED", { status: 403, rate: { resetAtMs: T0 + 5000 } }), T0).waitMs, 5000);
  assert.equal(classifyError(e("GITHUB_HTTP_429", { status: 429, retryAfterMs: 7000 }), T0).rateLimited, true);
  assert.equal(classifyError(e("GITHUB_HTTP_403", { status: 403 }), T0).fatal, true);
  assert.equal(classifyError(e("GITHUB_HTTP_403", { status: 403, retryAfterMs: 1000 }), T0).fatal, false);
  assert.equal(classifyError(e("GITHUB_HTTP_404", { status: 404 }), T0).fatal, true);
  assert.equal(classifyError(e("GITHUB_AUTH_MISSING"), T0).fatal, true);
  assert.equal(classifyError(e("TOOL_ABORTED"), T0).aborted, true);
  const transient = classifyError(e("GITHUB_HTTP_502", { status: 502 }), T0);
  assert.deepEqual([transient.fatal, transient.rateLimited, transient.aborted], [false, false, false]);
});

test("pollOnce reads pull, runs and checks; pre-merge on the head, post-merge on the merge commit; the event is recorded", async (t) => {
  const h = harness(t);
  const session = h.open();
  h.fake.setPull(5, { headSha: HEAD });
  h.fake.setRun({ id: 1, headSha: HEAD, conclusion: "success", event: "pull_request" });
  let result = await pollOnce(h.args(session));
  assert.equal(result.outcome, "ok");
  let verdict = evaluate(session.state, h.pol, h.nowMs());
  assert.equal(verdict.verdict, "waiting");
  assert.equal(verdict.preMerge[0].state, "passed");
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, conclusion: "success", event: "push" });
  result = await pollOnce(h.args(session));
  verdict = evaluate(session.state, h.pol, h.nowMs());
  assert.equal(verdict.closable, true);
  assert.equal(session.state.poll.count, 2);
  assert.ok(h.fake.calls.every((call) => call.headers.Authorization.startsWith("Bearer ")));
  const loaded = loadPipeline(h.dir);
  assert.deepEqual(loaded.events.map((event) => event.type), ["init", "poll", "poll"]);
  assert.equal(loaded.state.pr.mergeCommitSha, MERGE);
});

test("watch: polls with growing bounded delays until closable; duplicates and delayed events do not break it", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, status: "queued", conclusion: null, startedAt: T0 });
  h.hooks.push((ms, n) => {
    if (n === 2) h.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null, startedAt: T0, updatedAt: ms });
    if (n === 4) h.fake.setRun({ id: 2, headSha: MERGE, status: "completed", conclusion: "success", startedAt: T0, updatedAt: ms });
  });
  const seen = [];
  const result = await watchPipeline(h.args(h.open(), { onPoll: (info) => seen.push(info.verdict.verdict) }));
  assert.equal(result.status, "terminal");
  assert.equal(result.verdict.closable, true);
  assert.deepEqual(seen.at(-1), "closable");
  assert.ok(h.sleeps.length >= 4);
  assert.ok(h.sleeps.every((ms) => ms >= MIN_DELAY_MS && ms <= MAX_DELAY_MS));
  assert.ok(result.state.counters.duplicates >= 1, "identical re-reads are counted, not re-applied");
});

test("failure is terminal; a later watch after a rerun reconciles from scratch and flips to closable", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure", updatedAt: T0 + 1000 });
  const first = h.open();
  const failed = await watchPipeline(h.args(first));
  assert.equal(failed.status, "terminal");
  assert.equal(failed.verdict.verdict, "failed");
  first.close();
  h.clock.ms += 3_600_000; // a long gap
  h.fake.setRun({ id: 2, headSha: MERGE, attempt: 2, conclusion: "success", updatedAt: h.nowMs() });
  const second = h.open();
  assert.equal(evaluate(second.state, h.pol, h.nowMs()).verdict, "failed", "the stored state is not assumed to be current...");
  const resumed = await watchPipeline(h.args(second));
  assert.equal(resumed.verdict.closable, true, "...the first poll reads the full state");
  const polls = loadPipeline(h.dir).events.filter((event) => event.type === "poll");
  assert.deepEqual(polls.map((event) => event.reconciled), [true, true]);
  assert.ok(second.state.poll.reconciledAt);
  assert.equal(second.state.counters.superseded, 1);
});

test("a 429 with Retry-After is a rate-limited state with resumeAt, not a failure; the watch waits at least that long", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE });
  h.fake.fault(/pulls\/5/, () => new Response("{}", { status: 429, headers: { "retry-after": "40" } }));
  const session = h.open();
  const first = await pollOnce(h.args(session));
  assert.equal(first.outcome, "rate-limited");
  assert.equal(session.state.poll.status, "rate-limited");
  assert.equal(session.state.poll.resumeAt, new Date(T0 + 40_000).toISOString());
  assert.equal(evaluate(session.state, h.pol, h.nowMs()).verdict, "waiting", "never a failure verdict");
  h.fake.fault(/pulls\/5/, () => new Response("{}", { status: 429, headers: { "retry-after": "40" } }));
  const result = await watchPipeline(h.args(session));
  assert.equal(result.verdict.closable, true);
  assert.ok(h.sleeps[0] >= 40_000, `slept ${h.sleeps[0]}`);
  assert.equal(session.state.poll.status, "ok");
});

test("rate-limit exhaustion: waits for x-ratelimit-reset; when the reset is beyond the wall-time cap the watch returns rate-limited with resumeAt", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  h.fake.setRate({ remaining: 0, resetAtSec: Math.floor(T0 / 1000) + 90 });
  h.hooks.push((ms) => {
    if (ms / 1000 >= h.fake.world.rate.resetAtSec) h.fake.setRate({ remaining: 5000 });
  });
  const session = h.open();
  const result = await watchPipeline(h.args(session, { timeoutMs: 600_000, maxAttempts: 3 }));
  assert.ok(h.sleeps[0] >= 85_000 && h.sleeps[0] <= 3_600_000, `slept ${h.sleeps[0]}`);
  assert.notEqual(result.status, "rate-limited");

  const late = harness(t);
  late.merge();
  late.fake.setRate({ remaining: 0, resetAtSec: Math.floor(T0 / 1000) + 1800 });
  const s2 = late.open();
  const cut = await watchPipeline(late.args(s2, { timeoutMs: 60_000 }));
  assert.equal(cut.status, "rate-limited");
  assert.equal(cut.resumeAt, new Date(T0 + 1_800_000).toISOString());
  assert.equal(s2.state.poll.status, "rate-limited");
  assert.equal(cut.verdict.verdict, "waiting");
  assert.deepEqual(late.sleeps, [], "no pointless sleep");
});

test("abort: a signal aborted during the wait or during a request ends the watch cleanly and records no failure", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const controller = new AbortController();
  h.hooks.push(() => controller.abort());
  const session = h.open();
  const result = await watchPipeline(h.args(session, { signal: controller.signal }));
  assert.equal(result.status, "aborted");
  assert.equal(result.attempts, 1);
  assert.equal(session.state.poll.consecutiveErrors, 0);
  assert.deepEqual(h.sleeps.length, 1);

  const already = new AbortController();
  already.abort();
  const calls = h.fake.calls.length;
  assert.equal((await watchPipeline(h.args(session, { signal: already.signal }))).status, "aborted");
  assert.equal(h.fake.calls.length, calls, "no request after an abort");
  assert.equal((await pollOnce(h.args(session, { signal: already.signal }))).outcome, "aborted");
  assert.ok(!loadPipeline(h.dir).events.some((event) => event.type === "poll.failed"));
});

test("run-not-detected: no run for the merge commit after the detection window ends the watch with that verdict", async (t) => {
  const h = harness(t, { policy: { detectionWindowMs: 60_000 } });
  h.merge();
  const result = await watchPipeline(h.args(h.open()));
  assert.equal(result.status, "terminal");
  assert.equal(result.verdict.verdict, "run-not-detected");
  assert.equal(result.verdict.closable, false);
  assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= 60_000 + MAX_DELAY_MS, "bounded by the window plus one interval");
});

test("bounds: the wall-time cap and the attempt cap stop a watch that never settles; delays never overshoot the cap", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const capped = await watchPipeline(h.args(h.open(), { timeoutMs: 10 * 60_000 }));
  assert.equal(capped.status, "timeout");
  assert.equal(capped.verdict.verdict, "waiting");
  assert.ok(h.sleeps.reduce((a, b) => a + b, 0) <= 10 * 60_000);
  assert.ok(capped.attempts < 30, `attempts ${capped.attempts}`);

  const h2 = harness(t);
  h2.merge();
  h2.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const few = await watchPipeline(h2.args(h2.open(), { maxAttempts: 3 }));
  assert.equal(few.status, "attempts");
  assert.equal(few.attempts, 3);
});

test("transient failures back off and are recorded; 401 and 404 are fatal with exit codes 3 and 1", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, headSha: MERGE });
  for (let i = 0; i < 3; i += 1) h.fake.fault(/pulls\/5/, () => new Response("x", { status: 503 }));
  const session = h.open();
  const result = await watchPipeline(h.args(session));
  assert.equal(result.verdict.closable, true);
  assert.deepEqual(h.sleeps.slice(0, 3), [5000, 7500, 15000]);
  assert.equal(session.state.poll.consecutiveErrors, 0, "reset by the success");
  assert.equal(loadPipeline(h.dir).events.filter((event) => event.type === "poll.failed").length, 3);

  const auth = harness(t);
  auth.fake.setPull(5, { headSha: HEAD });
  auth.fake.fault(/pulls\/5/, () => new Response("{}", { status: 401 }));
  await assert.rejects(() => pollOnce(auth.args(auth.open())), (error) => error.code === "PIPELINE_AUTH" && error.exitCode === 3);
  const missing = harness(t);
  await assert.rejects(() => pollOnce(missing.args(missing.open())), (error) => error.code === "PIPELINE_PR_NOT_FOUND" && error.exitCode === 1);
});

test("hostile GitHub data cannot reach the state unsanitized", async (t) => {
  const h = harness(t);
  h.merge();
  h.fake.setRun({ id: 2, name: "\u001b[2Jevil token=ghp_" + "z".repeat(40), path: ".github/workflows/ci.yml", headSha: MERGE });
  const session = h.open();
  await pollOnce(h.args(session));
  const text = JSON.stringify(loadPipeline(h.dir));
  assert.ok(!text.includes("\u001b") && !text.includes("z".repeat(40)));
});

// Token reader ---------------------------------------------------------------------------------

test("token reader: gh auth token -h <host> through the injected spawn; cached; the token is never in argv or an error", async () => {
  const secret = "gho" + "_" + "Q".repeat(36);
  const spawn = fakeSpawn(() => ({ code: 0, stdout: `${secret}\n` }));
  const reader = createTokenReader({ host: "github.com", env: { PATH: BIN, GH_HOST: "evil.example" }, spawn, exists: installed(NATIVE("gh")), platform: process.platform });
  assert.equal(await reader.get(), secret);
  assert.equal(await reader.get(), secret);
  assert.equal(spawn.calls.length, 1, "cached in memory");
  assert.deepEqual(spawn.calls[0].args, ["auth", "token", "-h", "github.com"]);
  assert.ok(!JSON.stringify(spawn.calls[0].args).includes(secret));
  assert.equal(spawn.calls[0].options.env.GH_HOST, "github.com");
  assert.equal(spawn.calls[0].options.shell, false);
});

test("token reader: gh missing, not signed in or garbage output is exit 3 with a remediation and no token text", async () => {
  const missing = createTokenReader({ host: "github.com", env: { PATH: BIN }, spawn: fakeSpawn(() => ({ code: 0, stdout: "" })), exists: () => false });
  await assert.rejects(() => missing.get(), (error) => error.code === "GH_NOT_INSTALLED" && error.exitCode === 3 && /gh auth login/.test(error.remediation));
  const out = createTokenReader({ host: "ghe.example.com", env: { PATH: BIN }, spawn: fakeSpawn(() => ({ code: 1, stdout: "", stderr: "not logged in" })), exists: installed(NATIVE("gh")) });
  await assert.rejects(() => out.ensure(), (error) => error.code === "GH_NOT_AUTHENTICATED" && error.exitCode === 3 && /ghe\.example\.com/.test(error.remediation));
  const junk = createTokenReader({ host: "github.com", env: { PATH: BIN }, spawn: fakeSpawn(() => ({ code: 0, stdout: "two words\nand lines" })), exists: installed(NATIVE("gh")) });
  await assert.rejects(() => junk.get(), (error) => error.code === "GH_NOT_AUTHENTICATED" && !error.message.includes("two words"));
});

// Required checks ------------------------------------------------------------------------------

function sandbox(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-req-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userDir = path.join(root, "user");
  const repo = path.join(root, "repo");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(path.join(repo, ".claude"), { recursive: true });
  const options = { env: { ASTERWEAVE_CONFIG_DIR: userDir }, trust: { trustFile: path.join(userDir, "trust.json") } };
  const adapter = (value) => writeFileSync(path.join(repo, ".claude", "asterweave.json"), JSON.stringify(value));
  const policy = (value) => writeFileSync(pipelineConfigPath(options), JSON.stringify(value));
  return { root, repo, options, adapter, policy };
}

test("required checks: the union of user policy, trusted adapter and branch protection, in that order, deduplicated", async (t) => {
  const box = sandbox(t);
  box.policy({ repos: { "O/R": { required: ["ci.yml"], allowSkipped: ["lint"], deployment: ["deploy"], detectionWindowMs: 120000, trigger: "push" } } });
  box.adapter({ version: 1, completion: { requiredChecks: ["ci.yml", "build"] } });
  grantTrust(box.repo, { ...box.options.trust, env: box.options.env });
  const fake = createFakeGithub();
  fake.world.protection = { status: 200, contexts: ["build", "e2e"] };
  const tools = createGithubTools({ getToken: () => "t".repeat(20), fetch: fake.fetch });
  const result = await loadRequiredChecks({ repo: REPO, baseBranch: "main", repoPath: box.repo, client: tools.client, ...box.options });
  assert.deepEqual(result.policy.required, ["ci.yml", "build", "e2e"]);
  assert.deepEqual([result.policy.allowSkipped, result.policy.deployment, result.policy.detectionWindowMs, result.policy.trigger], [["lint"], ["deploy"], 120000, "push"]);
  assert.deepEqual(result.sources.map((s) => [s.source, s.used]), [["user-policy", true], ["adapter", true], ["branch-protection", true]]);
});

test("required checks: an untrusted repository's adapter is NOT used; protection 403 is unavailable, not an error; nothing at all => empty", async (t) => {
  const box = sandbox(t);
  box.adapter({ version: 1, completion: { requiredChecks: ["ci.yml"] } });
  const fake = createFakeGithub();
  fake.world.protection = { status: 403, contexts: [] };
  const tools = createGithubTools({ getToken: () => "t".repeat(20), fetch: fake.fetch });
  const result = await loadRequiredChecks({ repo: REPO, baseBranch: "main", repoPath: box.repo, client: tools.client, ...box.options });
  assert.deepEqual(result.policy.required, []);
  const adapter = result.sources.find((s) => s.source === "adapter");
  assert.equal(adapter.used, false);
  assert.equal(adapter.note, "repository-not-trusted");
  assert.equal(result.sources.find((s) => s.source === "branch-protection").note, "unavailable-403");
  assert.equal(evaluate(Object.assign(structuredClone(harnessState()), {}), result.policy, T0).verdict, "missing-configuration");
  grantTrust(box.repo, { ...box.options.trust, env: box.options.env });
  assert.deepEqual((await loadRequiredChecks({ repo: REPO, repoPath: box.repo, ...box.options })).policy.required, ["ci.yml"]);
  box.adapter({ version: 1, completion: { requiredChecks: ["ci.yml"] }, extra: 1 });
  assert.equal(readAdapterChecks(box.repo, box.options).used, false, "changed after the grant: untrusted again");
});

test("required checks: invalid configuration is exit 5", async (t) => {
  const box = sandbox(t);
  box.policy({ repos: { "o/r": { required: "ci" } } });
  await assert.rejects(() => loadRequiredChecks({ repo: REPO, ...box.options }), (error) => error.code === "PIPELINE_CONFIG_INVALID" && error.exitCode === 5);
  box.policy({ repos: {} });
  box.adapter({ version: 1, completion: { requiredChecks: [1] } });
  grantTrust(box.repo, { ...box.options.trust, env: box.options.env });
  await assert.rejects(() => loadRequiredChecks({ repo: REPO, repoPath: box.repo, ...box.options }), (error) => error.code === "PIPELINE_CONFIG_INVALID");
  writeFileSync(pipelineConfigPath(box.options), "{not json");
  await assert.rejects(() => loadRequiredChecks({ repo: REPO, ...box.options }), (error) => error.exitCode === 5);
});

function harnessState() {
  return { pr: { state: "merged", headSha: HEAD, mergedAt: new Date(T0).toISOString(), mergeObservedAt: null, mergeCommitSha: MERGE, baseBranch: "main" }, target: { sha: MERGE, branch: "main" }, slots: {}, counters: {}, listing: { [MERGE]: { complete: true, dropped: 0 } } };
}
