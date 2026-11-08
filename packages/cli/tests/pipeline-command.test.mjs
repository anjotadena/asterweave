// `asterweave pipeline status|watch|diagnose`: handler called directly with injected fetch / clock / sleep (the lead registers it).
// Real git repo and real stores in temp dirs; the GitHub side is the fake. Includes the zero-model-call checks.

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveRepo } from "../src/commands/run.mjs";
import { pipelineCommand, pipelineCommandMeta, pipelineHelpText } from "../src/commands/pipeline.mjs";
import { runCli } from "../src/cli.mjs";
import { loadRun, runDir } from "../src/runtime/ledger.mjs";
import { createRunForGraph } from "../src/runtime/loop.mjs";
import { pipelineConfigPath } from "../src/runtime/pipeline/required.mjs";
import { loadPipeline, pipelineDir } from "../src/runtime/pipeline/store.mjs";
import { createFakeGithub } from "./fixtures/fake-github.mjs";
import { deliveryGraph } from "./loop-fixture.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const HEAD = "a".repeat(40);
const MERGE = "b".repeat(40);
const T0 = Date.parse("2026-01-01T00:00:00Z");
const TOKEN = "gho" + "_" + "C".repeat(36);
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};
const envFor = (userDir) => {
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

function world({ required = ["ci.yml"], policy = {}, origin = "https://github.com/o/r.git" } = {}) {
  const userDir = tempDir("aw-pc-user-");
  const repo = tempDir("aw-pc-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  if (origin) git(repo, "remote", "add", "origin", origin);
  const env = envFor(userDir);
  if (required) writeFileSync(pipelineConfigPath({ env }), JSON.stringify({ repos: { "o/r": { required, ...policy } } }));
  const clock = { ms: T0 };
  const nowMs = () => clock.ms;
  const fake = createFakeGithub({ now: nowMs });
  fake.setRate({ resetAtSec: Math.floor(T0 / 1000) + 3600 });
  const sleeps = [];
  const spawned = [];
  const spawn = (cmd, args, options) => {
    spawned.push({ cmd: String(cmd), args });
    return nodeSpawn(cmd, args, options);
  };
  const hooks = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
    clock.ms += ms;
    for (const hook of hooks) hook(clock.ms, sleeps.length);
  };
  const call = async (args, { options = {}, extra = {}, seams = {} } = {}) => {
    const out = sink();
    const err = sink();
    const ctx = { stdout: out, stderr: err, stdin: sink(), env, cwd: repo, spawn, positionals: args, options, pipelineSeams: { fetch: fake.fetch, getToken: () => TOKEN, sleep, nowMs, random: () => 0.5, ...seams }, ...extra };
    let code;
    let error = null;
    try {
      code = await pipelineCommand(ctx);
    } catch (e) {
      error = e;
      code = e.exitCode ?? 1;
    }
    return { code, error, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  const merge = () => fake.setPull(5, { state: "closed", merged: true, headSha: HEAD, mergeCommitSha: MERGE, mergedAt: new Date(nowMs()).toISOString() });
  return { userDir, repo, env, clock, nowMs, fake, sleeps, spawned, hooks, call, merge, dir: () => pipelineDir("github.com", "o/r", 5, { env }) };
}

test("meta: the options list is closed; help documents the subcommands, exit codes and the no-model guarantee", () => {
  assert.deepEqual([...pipelineCommandMeta.options].sort(), ["check", "interval", "json", "refresh", "repo", "run", "timeout"]);
  assert.deepEqual(pipelineCommandMeta.boolean, ["json", "refresh"]);
  for (const word of ["status", "watch", "diagnose", "Exit codes", "no model calls", "closable", "rate-limited", "unverified"]) assert.ok(pipelineHelpText.includes(word), word);
});

test("an unknown flag is exit 2 through the real parser, a JSON error envelope on --json", async () => {
  const commands = new Map([["pipeline", { handler: pipelineCommand, summary: pipelineCommandMeta.summary, boolean: [...pipelineCommandMeta.boolean], options: [...pipelineCommandMeta.options], hidden: false }]]);
  const out = sink();
  const err = sink();
  const code = await runCli(["pipeline", "status", "5", "--jsno"], { stdout: out, stderr: err, env: { ASTERWEAVE_CONFIG_DIR: tempDir() } }, { commands });
  assert.equal(code, 2);
  const outJson = sink();
  assert.equal(await runCli(["pipeline", "bogus", "--json"], { stdout: outJson, stderr: sink(), env: { ASTERWEAVE_CONFIG_DIR: tempDir() } }, { commands }), 2);
  assert.equal(JSON.parse(outJson.text()).ok, false);
});

test("usage errors: pr number, --repo shape, options that do not belong to the subcommand, durations", async () => {
  const w = world();
  for (const [args, options] of [[["status"], {}], [["status", "0"], {}], [["status", "abc"], {}], [["status", "5", "extra"], {}], [["status", "5"], { repo: "nope" }], [["status", "5"], { repo: "../x/y" }], [["status", "5"], { timeout: "5m" }], [["watch", "5"], { check: "x" }], [["diagnose", "5"], { run: "r" }], [["watch", "5"], { timeout: "soon" }], [["watch", "5"], { interval: "1s" }], [["watch", "5"], { interval: "10m" }], [["bogus"], {}], [[], {}]]) {
    const result = await w.call(args, { options });
    assert.equal(result.code, 2, JSON.stringify([args, options]));
  }
  assert.equal(w.fake.calls.length, 0, "nothing was requested");
});

test("the repository defaults to the git origin; without one --repo is required", async () => {
  const w = world({ origin: null });
  const missing = await w.call(["status", "5"]);
  assert.equal(missing.code, 2);
  assert.match(missing.error.message, /--repo/);
  const ok = world();
  ok.fake.setPull(5, { headSha: HEAD });
  ok.fake.setRun({ id: 1, headSha: HEAD, event: "pull_request" });
  const refreshed = await ok.call(["status", "5"], { options: { refresh: true, json: true } });
  assert.equal(refreshed.code, 0, refreshed.error?.message);
  assert.equal(refreshed.json().repo, "o/r");
});

test("status with nothing recorded is PIPELINE_NOT_FOUND with the exact next command and no request", async () => {
  const w = world();
  const result = await w.call(["status", "5"]);
  assert.equal(result.code, 1);
  assert.equal(result.error.code, "PIPELINE_NOT_FOUND");
  assert.match(result.error.remediation, /--refresh/);
  assert.equal(w.fake.calls.length, 0);
});

test("watch: merged PR with a passing required check is closable (exit 0); status then reads it offline", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, status: "queued", conclusion: null });
  w.hooks.push((ms, n) => {
    if (n === 1) w.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null, updatedAt: ms });
    if (n === 2) w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "success", updatedAt: ms });
  });
  const result = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(result.code, 0, result.error?.message);
  const payload = result.json();
  assert.deepEqual([payload.ok, payload.status, payload.verdict, payload.closable], [true, "terminal", "closable", true]);
  assert.equal(payload.keys[0].state, "passed");
  assert.deepEqual(payload.blockers, []);
  assert.ok(!result.out.includes(TOKEN) && !w.fake.calls.some((call) => call.url.includes(TOKEN)));
  const calls = w.fake.calls.length;
  const status = await w.call(["status", "5"], { options: { json: true } });
  assert.equal(status.code, 0);
  assert.equal(status.json().verdict, "closable");
  assert.equal(w.fake.calls.length, calls, "status does not touch the network without --refresh");
  assert.equal(loadPipeline(w.dir()).state.policy.required[0], "ci.yml");
});

test("watch: a failing check is exit 1 with a machine-readable verdict; after a rerun the next watch is exit 0; the lock is released", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  const failed = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(failed.code, 1);
  assert.deepEqual([failed.json().ok, failed.json().verdict, failed.json().status], [false, "failed", "terminal"]);
  assert.equal(failed.json().blockers[0].key, "ci.yml");
  assert.ok(!existsSync(join(w.dir(), "run.lock")));
  w.fake.setRun({ id: 2, headSha: MERGE, attempt: 2, conclusion: "success", updatedAt: w.nowMs() + 5000 });
  const again = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(again.code, 0);
  assert.equal(again.json().keys[0].attempt, 2);
  assert.equal(again.json().counters.superseded, 1);
});

test("watch text output is sanitized and ends with the verdict and blockers", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  const result = await w.call(["watch", "5"]);
  assert.equal(result.code, 1);
  assert.match(result.out, /Verdict: failed \(NOT closable\)/);
  assert.match(result.out, /ci\.yml: failed/);
  assert.ok(!/\u001b/.test(result.out));
});

test("watch: missing configuration is exit 1, never closable, with a remediation", async () => {
  const w = world({ required: null });
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  const result = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(result.code, 1);
  assert.equal(result.json().verdict, "missing-configuration");
  assert.match(result.json().blockers[0].remediation, /completion\.requiredChecks/);
});

test("watch: run-not-detected after the window; timeout is verdict waiting; skipped is not-passed unless allowed", async () => {
  const w = world({ policy: { detectionWindowMs: 60_000 } });
  w.merge();
  const none = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(none.code, 1);
  assert.equal(none.json().verdict, "run-not-detected");

  const slow = world();
  slow.merge();
  slow.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const timeout = await slow.call(["watch", "5"], { options: { json: true, timeout: "2m" } });
  assert.equal(timeout.code, 1);
  assert.deepEqual([timeout.json().status, timeout.json().verdict], ["timeout", "waiting"]);
  assert.ok(slow.sleeps.reduce((a, b) => a + b, 0) <= 120_000);

  const skipped = world();
  skipped.merge();
  skipped.fake.setRun({ id: 2, headSha: MERGE, conclusion: "skipped" });
  assert.equal((await skipped.call(["watch", "5"], { options: { json: true } })).json().verdict, "not-passed");
  const allowed = world({ policy: { allowSkipped: ["ci.yml"] } });
  allowed.merge();
  allowed.fake.setRun({ id: 2, headSha: MERGE, conclusion: "skipped" });
  assert.equal((await allowed.call(["watch", "5"], { options: { json: true } })).code, 0);
});

test("watch: rate limiting is state rate-limited with resumeAt (exit 1, verdict waiting), not a failure", async () => {
  const w = world();
  w.merge();
  w.fake.setRate({ remaining: 0, resetAtSec: Math.floor(T0 / 1000) + 1800 });
  const result = await w.call(["watch", "5"], { options: { json: true, timeout: "1m" } });
  assert.equal(result.code, 1);
  const payload = result.json();
  assert.deepEqual([payload.status, payload.verdict, payload.poll.status], ["rate-limited", "waiting", "rate-limited"]);
  assert.equal(payload.resumeAt, new Date(T0 + 1_800_000).toISOString());
  const status = await w.call(["status", "5"], { options: { json: true } });
  assert.equal(status.json().poll.status, "rate-limited");
  assert.equal(status.json().poll.resumeAt, payload.resumeAt);
});

test("watch: Ctrl-C (abort) exits 130, leaves the state resumable and the lock released", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const controller = new AbortController();
  w.hooks.push(() => controller.abort());
  const interrupted = await w.call(["watch", "5"], { options: { json: true }, extra: { signal: controller.signal } });
  assert.equal(interrupted.code, 130);
  assert.equal(interrupted.json().status, "aborted");
  assert.ok(!existsSync(join(w.dir(), "run.lock")));
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "success", updatedAt: w.nowMs() + 1000 });
  w.hooks.length = 0;
  const resumed = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(resumed.code, 0);
  assert.ok(loadPipeline(w.dir()).state.poll.count >= 2);
});

test("a second watcher of the same PR is refused while the first holds the lock", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  let inner = null;
  w.hooks.push(async () => {});
  const second = async () => w.call(["watch", "5"], { options: { json: true }, seams: { sleep: async () => {} } });
  const outer = await w.call(["watch", "5"], {
    options: { json: true, timeout: "1m" },
    seams: {
      sleep: async (ms) => {
        inner ??= await second();
        w.clock.ms += ms;
      },
    },
  });
  assert.equal(inner.code, 1);
  assert.equal(inner.error.code, "PIPELINE_LOCKED");
  assert.equal(outer.json().status, "timeout");
});

test("status --refresh does exactly one poll; auth failure is exit 3 and a missing PR is exit 1", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  const status = await w.call(["status", "5"], { options: { refresh: true, json: true } });
  assert.equal(status.json().verdict, "closable");
  assert.equal(status.json().poll.count, 1);
  assert.equal(w.sleeps.length, 0);

  const unauth = world();
  unauth.fake.fault(/pulls\/5/, () => new Response("{}", { status: 401 }));
  assert.equal((await unauth.call(["status", "5"], { options: { refresh: true } })).code, 3);
  const gone = world();
  assert.equal((await gone.call(["status", "5"], { options: { refresh: true } })).error.code, "PIPELINE_PR_NOT_FOUND");
});

test("the token is never printed: a failing run's output and the request log never leak it into stdout/stderr", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  const result = await w.call(["watch", "5"]);
  assert.ok(!result.out.includes(TOKEN) && !result.err.includes(TOKEN));
  assert.ok(w.fake.calls.every((call) => !call.url.includes(TOKEN) && call.method === "GET"));
});

// diagnose --------------------------------------------------------------------------------------

test("diagnose: a bounded, sanitized packet for failing checks; read-only; nothing written or sent", async () => {
  const w = world();
  w.merge();
  w.fake.setPull(5, { state: "closed", merged: true, headSha: HEAD, mergeCommitSha: MERGE, mergedAt: new Date(T0).toISOString() });
  w.fake.world.pulls.get(5).body = "Intro\n\n## Acceptance criteria\n- login works\n- \u001b[31mred\u001b[0m token=ghp_" + "q".repeat(40) + "\n\n## Notes\nignore me";
  w.fake.world.pulls.get(5).title = "Fix \u001b[2Jlogin";
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  w.fake.setRun({ id: 3, name: "Lint", path: ".github/workflows/lint.yml", workflowId: 9, headSha: MERGE, conclusion: "success" });
  w.fake.setJobs(2, [{ name: "unit", conclusion: "failure", steps: [{ name: "npm test", number: 3, status: "completed", conclusion: "failure" }, { name: "setup", number: 1, status: "completed", conclusion: "success" }] }, { name: "lint", conclusion: "success" }]);
  w.fake.setCheck({ id: 50, name: "e2e", headSha: MERGE, conclusion: "failure", title: "3 failed", summary: "x".repeat(5000) });
  w.fake.world.files = Array.from({ length: 140 }, (_, i) => `src/f${i}.js`);
  const callsBefore = w.fake.calls.length;
  const result = await w.call(["diagnose", "5"], { options: { json: true } });
  assert.equal(result.code, 0, result.error?.message);
  const packet = result.json();
  assert.equal(packet.sentAnywhere, false);
  assert.deepEqual(packet.failing.map((f) => f.key).sort(), [".github/workflows/ci.yml", "e2e"]);
  const run = packet.failing.find((f) => f.source === "run");
  assert.deepEqual(run.jobs, [{ name: "unit", conclusion: "failure", failedSteps: ["npm test"] }]);
  assert.ok(packet.failing.find((f) => f.key === "e2e").output.summary.length <= 2048);
  assert.equal(packet.changedFiles.length, 100);
  assert.match(packet.acceptanceCriteria, /login works/);
  assert.ok(!packet.acceptanceCriteria.includes("ignore me"));
  assert.ok(!result.out.includes("\\u001b") && !/ghp_q{40}/.test(result.out));
  assert.ok(packet.pr.title.startsWith("Fix") && !packet.pr.title.includes("\u001b"));
  assert.match(packet.handoff.command, /run start --workflow bugfix/);
  assert.ok(w.fake.calls.slice(callsBefore).every((call) => call.method === "GET"));
  assert.ok(!existsSync(w.dir()), "diagnose writes no state");
  const only = await w.call(["diagnose", "5"], { options: { json: true, check: "e2e" } });
  assert.deepEqual(only.json().failing.map((f) => f.key), ["e2e"]);
  const text = await w.call(["diagnose", "5"]);
  assert.match(text.out, /To start a run yourself: asterweave run start --workflow bugfix/);
  assert.ok(!/\u001b/.test(text.out));
});

// run link -------------------------------------------------------------------------------------

test("--run appends pipeline events to the run ledger; evidence only when the current node is monitor-pipeline", async () => {
  const w = world();
  const identity = await resolveRepo({ cwd: w.repo, env: w.env });
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "ship", repo: { key: identity.key, realpath: identity.workspace }, runId: "run-p1", env: w.env });
  assert.equal(dir, runDir(identity.key, "run-p1", { env: w.env }));
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  const linked = await w.call(["watch", "5"], { options: { json: true, run: "run-p1" } });
  assert.equal(linked.code, 0, linked.error?.message);
  assert.equal(linked.json().runLink.runId, "run-p1");
  let loaded = loadRun(dir);
  const types = loaded.events.map((event) => event.type);
  assert.ok(types.includes("pipeline.observed") && types.includes("pipeline.verdict"), types.join());
  assert.equal(loaded.events.findLast((event) => event.type === "pipeline.verdict").verdict, "closable");
  assert.equal(loaded.run.nodes.intake.attemptLog.length, 0, "graph untouched");
  assert.equal(loadPipeline(w.dir()).state.links.runId, "run-p1");

  // put the run at monitor-pipeline, running: evidence is recorded (pass when closable)
  const file = join(dir, "run.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  snapshot.currentNode = "monitor-pipeline";
  snapshot.nodes["monitor-pipeline"] = { ...snapshot.nodes["monitor-pipeline"], status: "running", attempts: 1, attemptLog: [{ n: 1, startedAt: snapshot.createdAt, endedAt: null, outcome: null, evidence: [], refunded: false }] };
  writeFileSync(file, JSON.stringify(snapshot));
  const again = await w.call(["watch", "5"], { options: { json: true, run: "run-p1" } });
  assert.equal(again.code, 0, again.error?.message);
  loaded = loadRun(dir);
  const evidence = loaded.run.nodes["monitor-pipeline"].attemptLog[0].evidence;
  assert.equal(evidence.at(-1).kind, "pipeline");
  assert.equal(evidence.at(-1).result, "pass");
  assert.equal(loaded.run.nodes["monitor-pipeline"].status, "running", "the monitor never completes a node");

  w.fake.setRun({ id: 2, headSha: MERGE, attempt: 2, conclusion: "failure", updatedAt: w.nowMs() + 9000 });
  await w.call(["watch", "5"], { options: { json: true, run: "run-p1" } });
  assert.equal(loadRun(dir).run.nodes["monitor-pipeline"].attemptLog[0].evidence.at(-1).result, "fail");
});

test("--run with an unknown run id fails before any request", async () => {
  const w = world();
  const result = await w.call(["watch", "5"], { options: { json: true, run: "nope-1" } });
  assert.equal(result.code, 1);
  assert.equal(result.error.code, "RUN_NOT_FOUND");
  assert.equal(w.fake.calls.length, 0);
});

// zero model calls -----------------------------------------------------------------------------

const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src");

function importGraph(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["'](\.[^"']+)["']|(?:^|\n)\s*import\s+["'](\.[^"']+)["']|import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
      const spec = match[1] ?? match[2] ?? match[3];
      const target = resolve(dirname(file), spec);
      if (existsSync(target)) queue.push(target);
    }
  }
  return [...seen];
}

test("no pipeline code can reach the Claude runner: the static import graph of the command and runtime/pipeline excludes runtime/claude and run-runner", () => {
  const entries = [join(SOURCE_ROOT, "commands", "pipeline.mjs"), ...["state", "store", "poll", "required", "token", "run-link"].map((name) => join(SOURCE_ROOT, "runtime", "pipeline", `${name}.mjs`))];
  for (const entry of entries) {
    const files = importGraph(entry).map((file) => file.replaceAll("\\", "/"));
    const bad = files.filter((file) => /\/runtime\/claude\/|\/run-runner\.mjs$|\/commands\/run\.mjs$/.test(file));
    assert.deepEqual(bad, [], entry);
  }
  for (const name of ["state", "store", "poll", "required", "token", "run-link"]) {
    const text = readFileSync(join(SOURCE_ROOT, "runtime", "pipeline", `${name}.mjs`), "utf8");
    assert.ok(!/runClaudeTurn|createClaudeExecutor|checkClaude/.test(text), name);
  }
  assert.ok(!/runClaudeTurn|createClaudeExecutor|checkClaude/.test(readFileSync(join(SOURCE_ROOT, "commands", "pipeline.mjs"), "utf8").replace(/^\/\/.*$/gm, "")));
});

test("watch, status --refresh and diagnose spawn no claude (a spawn spy sees only git)", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  await w.call(["watch", "5"], { options: { json: true } });
  await w.call(["status", "5"], { options: { refresh: true } });
  await w.call(["diagnose", "5"], { options: { json: true } });
  assert.ok(w.spawned.length > 0, "the spy is wired (git ran)");
  for (const { cmd, args } of w.spawned) {
    assert.ok(!/claude/i.test(cmd), cmd);
    assert.ok(!args.some((arg) => /claude/i.test(String(arg))), String(args));
    assert.match(cmd, /git(\.exe)?$/i);
  }
});

// Review findings: required-check sources must fail closed ------------------------------------------

const protectionFault = (w, response) => w.fake.fault(/protection/, response);

test("HIGH: a 502 on branch protection can never make the PR closable: waiting with required-checks-unavailable, nothing smaller recorded as complete", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  protectionFault(w, () => new Response("x", { status: 502 }));
  const result = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(result.code, 1);
  const payload = result.json();
  assert.deepEqual([payload.verdict, payload.closable, payload.status], ["waiting", false, "unavailable"]);
  assert.equal(payload.blockers.at(-1).reason, "required-checks-unavailable");
  const status = await w.call(["status", "5"], { options: { json: true } });
  assert.equal(status.json().closable, false, "plain status agrees");
  assert.equal(status.json().blockers.at(-1).reason, "required-checks-unavailable");
  // protection readable again: the set is complete and closable
  const again = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(again.code, 0);
});

test("HIGH: a failed protection read keeps the last recorded union instead of a smaller one", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  w.fake.setCheck({ id: 60, name: "e2e", headSha: MERGE, conclusion: "failure" });
  w.fake.world.protection = { status: 200, contexts: ["e2e"] };
  const first = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(first.json().verdict, "failed");
  assert.deepEqual(loadPipeline(w.dir()).state.policy.required, ["ci.yml", "e2e"]);
  for (const response of [() => new Response("x", { status: 502 }), () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(T0 / 1000) + 600) } })]) {
    protectionFault(w, response);
    const second = await w.call(["watch", "5"], { options: { json: true } });
    assert.equal(second.code, 1);
    assert.equal(second.json().closable, false);
    assert.deepEqual(loadPipeline(w.dir()).state.policy.required, ["ci.yml", "e2e"], "the recorded union was not shrunk");
    assert.equal(second.json().keys.length, 2);
  }
  // a 404 / 403 after protection was part of the recorded set does not remove its checks either: only a SUCCESSFUL read can shrink it
  for (const status of [404, 403]) {
    protectionFault(w, () => new Response("{}", { status }));
    const lost = await w.call(["watch", "5"], { options: { json: true } });
    assert.equal(lost.code, 1, String(status));
    assert.equal(lost.json().closable, false);
    assert.equal(lost.json().verdict, "failed");
    assert.deepEqual(loadPipeline(w.dir()).state.policy.required, ["ci.yml", "e2e"], String(status));
    assert.equal(loadPipeline(w.dir()).state.policy.incomplete, "branch-protection-unreadable");
  }
  // e2e passes and protection is unreadable: still waiting with required-checks-unavailable, never closable
  w.fake.setCheck({ id: 60, name: "e2e", headSha: MERGE, conclusion: "success", completedAt: w.nowMs() + 9000, startedAt: w.nowMs() + 8000 });
  protectionFault(w, () => new Response("{}", { status: 403 }));
  const still = await w.call(["watch", "5"], { options: { json: true } });
  assert.deepEqual([still.json().closable, still.json().verdict], [false, "waiting"]);
  assert.equal(still.json().blockers.at(-1).reason, "required-checks-unavailable");
  // a successful read that no longer lists e2e shrinks the set
  w.fake.world.protection = { status: 200, contexts: [] };
  const healed = await w.call(["watch", "5"], { options: { json: true } });
  assert.deepEqual(loadPipeline(w.dir()).state.policy.required, ["ci.yml"]);
  assert.equal(healed.json().closable, true);
  // the user can edit pipeline.json at any time: that change applies even while protection is unreadable
  w.fake.world.protection = { status: 200, contexts: ["e2e"] };
  await w.call(["status", "5"], { options: { refresh: true, json: true } });
  writeFileSync(pipelineConfigPath({ env: w.env }), JSON.stringify({ repos: { "o/r": { required: ["ci.yml", "lint"] } } }));
  protectionFault(w, () => new Response("{}", { status: 404 }));
  await w.call(["status", "5"], { options: { refresh: true, json: true } });
  assert.deepEqual(loadPipeline(w.dir()).state.policy.required, ["ci.yml", "lint", "e2e"]);
});

test("HIGH: an abort on the protection call is exit 130 before anything is written", async () => {
  const w = world();
  w.merge();
  protectionFault(w, null);
  w.fake.world.faults.at(-1).throws = Object.assign(new Error("aborted"), { name: "AbortError" });
  const result = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(result.code, 130);
  assert.ok(!existsSync(w.dir()), "no state, no lock, no policy event");
});

test("HIGH: a transient pull failure while preparing means base-branch-unknown: never closable; an abort there is exit 130", async () => {
  const w = world();
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE });
  w.fake.fault(/pulls\/5/, () => new Response("x", { status: 503 }));
  const result = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(result.code, 1);
  assert.deepEqual([result.json().closable, result.json().verdict], [false, "waiting"]);
  assert.equal(result.json().blockers.at(-1).reason, "required-checks-unavailable");
  assert.equal(loadPipeline(w.dir()).state.policy.incomplete, "base-branch-unknown");
  const healed = await w.call(["watch", "5"], { options: { json: true } });
  assert.equal(healed.code, 0);
  assert.equal(loadPipeline(w.dir()).state.policy.incomplete, null);

  const aborted = world();
  aborted.fake.fault(/pulls\/5/, null, Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal((await aborted.call(["watch", "5"], { options: { json: true } })).code, 130);
  assert.ok(!existsSync(aborted.dir()));
});

test("diagnose maps GitHub failures like watch: 401 is exit 3, 404 PIPELINE_PR_NOT_FOUND, 502 a fixed PIPELINE_GITHUB_ERROR, abort 130", async () => {
  const unauth = world();
  unauth.fake.fault(/pulls\/5/, () => new Response("{}", { status: 401 }));
  const a = await unauth.call(["diagnose", "5"], { options: { json: true } });
  assert.deepEqual([a.code, a.error.code], [3, "PIPELINE_AUTH"]);
  const missing = await world().call(["diagnose", "5"], { options: { json: true } });
  assert.deepEqual([missing.code, missing.error.code], [1, "PIPELINE_PR_NOT_FOUND"]);
  const down = world();
  down.merge();
  down.fake.fault(/actions\/runs\?/, () => new Response("secret body " + TOKEN, { status: 502 }));
  const b = await down.call(["diagnose", "5"], { options: { json: true } });
  assert.deepEqual([b.code, b.error.code], [1, "PIPELINE_GITHUB_ERROR"]);
  assert.ok(!b.error.message.includes("secret body") && !b.error.message.includes(TOKEN));
  const stop = world();
  stop.fake.fault(/pulls\/5/, null, Object.assign(new Error("aborted"), { name: "AbortError" }));
  assert.equal((await stop.call(["diagnose", "5"], { options: { json: true } })).code, 130);
  const jobs = world();
  jobs.merge();
  jobs.fake.setRun({ id: 2, headSha: MERGE, conclusion: "failure" });
  jobs.fake.fault(/actions\/runs\/2\/jobs/, () => new Response("{}", { status: 401 }));
  assert.equal((await jobs.call(["diagnose", "5"], { options: { json: true } })).code, 3, "a sign-in problem on a later call still stops diagnose");
});

test("status --refresh with a failed or rate-limited poll is exit 1, ok false, with the poll state", async () => {
  const w = world();
  w.merge();
  w.fake.fault(/pulls\/5/, () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
  w.fake.fault(/pulls\/5/, () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }));
  const limited = await w.call(["status", "5"], { options: { refresh: true, json: true } });
  assert.equal(limited.code, 1);
  assert.equal(limited.json().ok, false);
  assert.equal(limited.json().refresh, "rate-limited");
  assert.equal(limited.json().poll.status, "rate-limited");
  const failing = world();
  failing.merge();
  failing.fake.fault(/pulls\/5/, () => new Response("x", { status: 503 }));
  failing.fake.fault(/pulls\/5/, () => new Response("x", { status: 503 }));
  const result = await failing.call(["status", "5"], { options: { refresh: true } });
  assert.equal(result.code, 1);
  assert.match(result.out, /Refresh did not complete: failed/);
});

test("--run: the repository must be the run's own, the pull request must match the run's binding, waiting never writes evidence", async () => {
  const w = world();
  const identity = await resolveRepo({ cwd: w.repo, env: w.env });
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "ship", repo: { key: identity.key, realpath: identity.workspace }, runId: "run-p2", env: w.env });
  w.merge();
  w.fake.setRun({ id: 2, headSha: MERGE, status: "in_progress", conclusion: null });
  const wrongRepo = await w.call(["watch", "5"], { options: { json: true, run: "run-p2", repo: "x/y" } });
  assert.equal(wrongRepo.code, 2);
  assert.match(wrongRepo.error.message, /does not belong to x\/y/);
  assert.equal(w.fake.calls.length, 0);

  const file = join(dir, "run.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  snapshot.currentNode = "monitor-pipeline";
  snapshot.nodes["monitor-pipeline"] = { ...snapshot.nodes["monitor-pipeline"], status: "running", attempts: 1, attemptLog: [{ n: 1, startedAt: snapshot.createdAt, endedAt: null, outcome: null, evidence: [{ kind: "pipeline", summary: "earlier failure", result: "fail", path: null, sha256: null, attempt: 1 }], refunded: false }] };
  writeFileSync(file, JSON.stringify(snapshot));
  const waiting = await w.call(["watch", "5"], { options: { json: true, run: "run-p2", timeout: "1m" } });
  assert.equal(waiting.json().verdict, "waiting");
  const evidence = loadRun(dir).run.nodes["monitor-pipeline"].attemptLog[0].evidence;
  assert.deepEqual(evidence.map((item) => item.result), ["fail"], "a waiting link does not add info evidence over the failure");
  const types = loadRun(dir).events.map((event) => event.type);
  assert.ok(types.includes("pipeline.target") && types.includes("pipeline.observed"));

  const other = await w.call(["watch", "6"], { options: { json: true, run: "run-p2" } });
  assert.equal(other.code, 2);
  assert.match(other.error.message, /bound to pull request #5/);
  assert.equal(loadRun(dir).events.filter((event) => event.type === "pipeline.target").length, 1);
});
