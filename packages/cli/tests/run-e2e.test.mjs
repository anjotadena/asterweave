// End to end: the real bin (`node bin/asterweave.mjs`) against a real git repository, with the fake executor
// (ASTERWEAVE_DEV_EXECUTORS=1), a temp user directory and script files written by the test. Waiting is done on
// barriers (events.jsonl contents, process exit), never on sleeps. The destructive command string only exists in a
// fixture file that the test builds at run time.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { grantApproval } from "../src/runtime/approvals.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { attempt, deliveryGraph, grantPending, script, tool } from "./loop-fixture.mjs";
import { cleanupTemp, git, tempDir, waitFor } from "./repo-fixture.mjs";

const bin = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const graph = deliveryGraph;
const children = new Set();

after(() => {
  for (const child of children) child.kill("SIGKILL");
  cleanupTemp();
});

// --- harness -------------------------------------------------------------------------------------

function makeBox() {
  const root = tempDir("aw-e2e-");
  const userDir = join(root, "user");
  const home = join(root, "home");
  const repo = join(root, "repo");
  for (const dir of [userDir, home, repo, join(repo, "sub")]) mkdirSync(dir, { recursive: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir, ASTERWEAVE_DEV_EXECUTORS: "1", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "AppData") };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  let counter = 0;
  const scriptFile = (steps) => {
    const file = join(root, `script-${counter++}.json`);
    writeFileSync(file, JSON.stringify(steps));
    return file;
  };
  return { root, userDir, repo, env, scriptFile };
}

/** Synchronous CLI call. */
function cli(box, args, { cwd = box.repo } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd, env: box.env, input: "", encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Asynchronous CLI child with an `exited` promise. */
function spawnCli(box, args) {
  const child = spawn(process.execPath, [bin, ...args], { cwd: box.repo, env: box.env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  return {
    child,
    exited,
    async kill() {
      child.kill("SIGKILL");
      return exited;
    },
  };
}

const findRunDir = (box, runId) => {
  const runs = join(box.userDir, "runs");
  if (!existsSync(runs)) return null;
  const hit = readdirSync(runs).find((name) => existsSync(join(runs, name, runId)));
  return hit ? join(runs, hit, runId) : null;
};

/** Complete events only (a line being appended right now is ignored). */
function eventsOf(box, runId) {
  const dir = findRunDir(box, runId);
  const file = dir && join(dir, "events.jsonl");
  if (!file || !existsSync(file)) return [];
  const lines = readFileSync(file, "utf8").split("\n").slice(0, -1);
  const events = [];
  for (const line of lines) {
    try {
      events.push(JSON.parse(line));
    } catch {
      break;
    }
  }
  return events;
}

const barrier = (box, runId, predicate, label) => waitFor(() => eventsOf(box, runId).some(predicate), { timeoutMs: 60_000, label });
const parse = (result) => JSON.parse(result.out);
const show = (box, runId, options) => parse(cli(box, ["run", "show", runId, "--json"], options)).run;
const common = (box, file) => ["--executor", "fake", "--script", file];
const start = (box, runId, file) => cli(box, ["run", "start", ...common(box, file), "--run-id", runId, "--json"]);
const resume = (box, runId, file) => cli(box, ["run", "resume", runId, ...common(box, file), "--json"]);

// A headless child prints no nonce, so approvals cannot come through the CLI flags here (the CLI paths are covered in
// run-command.test.mjs). The test plays the person at the terminal: the library with the tty source, under the run lock.
function approveAll(box, runId) {
  const pending = show(box, runId).approvals.filter((approval) => approval.state === "pending");
  assert.ok(pending.length > 0, "something is waiting for approval");
  const granted = grantPending({ now: () => new Date().toISOString() }, findRunDir(box, runId), graph);
  assert.deepEqual(granted, pending.map((approval) => approval.id));
  return pending;
}

/** Resume, approving whatever waits, until the run stops for something else. Returns the last resume result. */
function drive(box, runId, file, { rounds = 8 } = {}) {
  for (let round = 0; round < rounds; round += 1) {
    const result = resume(box, runId, file);
    if (result.code !== 6) return result;
    approveAll(box, runId);
  }
  assert.fail("the run kept asking for approvals");
}

const withDelay = (steps, node, delayMs) => {
  steps.steps.find((step) => step.node === node).delayMs = delayMs;
  return steps;
};
const slowAnalyze = () => withDelay(script(graph, { analyze: attempt(graph, "analyze", { before: [tool("write", { path: "notes.txt", content: "x" })] }) }), "analyze", 30_000);
const isStarted = (event) => event.type === "action.started";

// --- 1. kill mid-node, resume ------------------------------------------------------------------------

test("e2e 1: a run killed mid-node resumes, records node.recovered and never completes the same action twice", async () => {
  const box = makeBox();
  const file = box.scriptFile(slowAnalyze());
  const running = spawnCli(box, ["run", "start", ...common(box, file), "--run-id", "k1", "--json"]);
  await barrier(box, "k1", isStarted, "action.started");
  assert.equal(eventsOf(box, "k1").some((event) => event.type === "action.completed"), false, "still inside the delayed step");
  await running.kill();

  const key = eventsOf(box, "k1").find(isStarted).key;
  assert.equal(show(box, "k1").lock.state, "stale", "the dead owner's lock is reported as stale");
  const resumed = resume(box, "k1", file);
  assert.equal(resumed.code, 6, resumed.err + resumed.out);
  const events = eventsOf(box, "k1");
  const recovered = events.filter((event) => event.type === "node.recovered");
  assert.ok(recovered.some((event) => event.reason === "IDEMPOTENT_RERUN" && event.key === key), JSON.stringify(recovered));
  assert.equal(events.filter((event) => event.type === "action.completed" && event.key === key).length, 1);

  const done = drive(box, "k1", file);
  assert.equal(done.code, 0, done.err + done.out);
  assert.equal(show(box, "k1").status, "completed");
  assert.equal(show(box, "k1").nodes.find((node) => node.id === "analyze").attempts, 1, "the interrupted attempt was continued, not repeated");
  assert.equal(eventsOf(box, "k1").filter((event) => event.type === "action.completed" && event.key === key).length, 1);
  assert.equal(show(box, "k1").lock.state, "none");
});

// --- 2. RUN_LOCKED and stale takeover ----------------------------------------------------------------

test("e2e 2: a second resume against a live run is RUN_LOCKED; after the owner dies the lock is taken over", async () => {
  const box = makeBox();
  const file = box.scriptFile(slowAnalyze());
  const running = spawnCli(box, ["run", "start", ...common(box, file), "--run-id", "l1", "--json"]);
  await barrier(box, "l1", isStarted, "action.started");
  assert.equal(show(box, "l1").lock.state, "live");

  const locked = resume(box, "l1", file);
  assert.equal(locked.code, 1);
  assert.equal(parse(locked).error.code, "RUN_LOCKED");
  const approve = cli(box, ["run", "abort", "l1", "--yes", "--json"]);
  assert.equal(approve.code, 1, "other writers are locked out too");
  assert.equal(parse(approve).error.code, "RUN_LOCKED");

  await running.kill();
  const taken = resume(box, "l1", file);
  assert.equal(taken.code, 6, taken.err + taken.out);
  assert.equal(show(box, "l1").currentNode, "approve");
  assert.equal(show(box, "l1").lock.state, "none");
});

// --- 3. destructive action ----------------------------------------------------------------------------

test("e2e 3: a destructive shell action is policy-denied (exit 7, DESTRUCTIVE_COMMAND) and never dispatched", () => {
  const box = makeBox();
  const destructive = ["git", "reset", "--hard"].join(" ");
  const file = box.scriptFile({ v: 1, steps: [{ node: "intake", action: tool("shell", { command: destructive }) }] });
  const result = start(box, "d1", file);
  assert.equal(result.code, 7, result.err + result.out);
  assert.deepEqual([parse(result).status, parse(result).exitCode, parse(result).decision.reason], ["blocked", 7, "DESTRUCTIVE_COMMAND"]);

  const run = show(box, "d1");
  assert.equal(run.status, "blocked");
  assert.equal(run.attention.reason, "DESTRUCTIVE_COMMAND");
  assert.equal(run.nodes.find((node) => node.id === "intake").outcome, "policy-denied");
  const events = eventsOf(box, "d1");
  assert.ok(events.some((event) => event.type === "tool.decision" && event.decision === "deny" && event.reason === "DESTRUCTIVE_COMMAND"));
  assert.equal(events.some(isStarted), false);

  // `run show` without an id, from a subdirectory of the work tree, finds it: the key is the git common dir.
  const fromSub = parse(cli(box, ["run", "show", "--json"], { cwd: join(box.repo, "sub") }));
  assert.equal(fromSub.run.runId, "d1");
  assert.equal(cli(box, ["run", "show", "--json"], { cwd: box.root }).code, 1, "another directory is another repository");
});

// --- 4. headless merge --------------------------------------------------------------------------------

test("e2e 4: a headless merge waits (exit 6); a wrong subject grants nothing; the right one lets resume dispatch it once", () => {
  const box = makeBox();
  const merge = tool("merge", { branch: "feat/x", into: "main" });
  const file = box.scriptFile(script(graph, { implement: attempt(graph, "implement", { before: [merge] }) }));
  assert.equal(start(box, "m1", file).code, 6);
  approveAll(box, "m1"); // the plan
  const held = resume(box, "m1", file);
  assert.equal(held.code, 6, held.err + held.out);
  assert.equal(parse(held).decision.reason, "OUT_OF_POLICY_OPERATION");

  const run = show(box, "m1");
  assert.equal(run.currentNode, "implement");
  assert.equal(run.attention.reason, "OUT_OF_POLICY_OPERATION");
  const pending = run.approvals.filter((approval) => approval.state === "pending");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].scope.operation, "merge");
  assert.match(pending[0].subject, /^[0-9a-f]{12}$/);

  const forged = cli(box, ["run", "approve", "m1", "--approval", pending[0].id, "--subject", pending[0].subject, "--json"]);
  assert.equal(forged.code, 2, "flags without the nonce never grant");
  assert.equal(parse(forged).error.code, "APPROVAL_TERMINAL_REQUIRED");
  const guessed = cli(box, ["run", "approve", "m1", "--approval", pending[0].id, "--subject", pending[0].subject, "--nonce", "00000000-00000000-00000000-00000000", "--json"]);
  assert.equal(guessed.code, 2, "a headless supervisor stores no nonce hash, so a quoted nonce is still terminal-only (APPROVAL_TERMINAL_REQUIRED)");
  assert.equal(parse(guessed).error.code, "APPROVAL_TERMINAL_REQUIRED");
  assert.equal(show(box, "m1").approvals.find((approval) => approval.id === pending[0].id).state, "pending");
  assert.equal(resume(box, "m1", file).code, 6, "still waiting");

  assert.deepEqual(grantPending({ now: () => new Date().toISOString() }, findRunDir(box, "m1"), graph), [pending[0].id]);
  const done = drive(box, "m1", file);
  assert.equal(done.code, 0, done.err + done.out);
  const events = eventsOf(box, "m1");
  const proposals = events.filter((event) => event.type === "action.proposed" && event.action?.tool?.name === "merge");
  assert.equal(proposals.length, 1);
  assert.equal(events.filter((event) => event.type === "action.started" && event.key === proposals[0].key).length, 1);
  assert.equal(events.filter((event) => event.type === "action.completed" && event.key === proposals[0].key).length, 1, "dispatched exactly once");
});

// --- 5. plan artifact change ---------------------------------------------------------------------------

test("e2e 5: a new plan revision invalidates the approval and puts the run back at approve", () => {
  const box = makeBox();
  const file = box.scriptFile(
    script(graph, {
      plan: [attempt(graph, "plan", { revision: 1 }), attempt(graph, "plan", { revision: 2 })],
      implement: [attempt(graph, "implement"), attempt(graph, "implement")],
      test: [attempt(graph, "test", { outcome: "fail-replan", signature: "plan-wrong" }), attempt(graph, "test")],
    }),
  );
  assert.equal(start(box, "p1", file).code, 6);
  approveAll(box, "p1");
  const again = resume(box, "p1", file);
  assert.equal(again.code, 6, again.err + again.out);

  const run = show(box, "p1");
  assert.equal(run.currentNode, "approve");
  assert.deepEqual(run.approvals.map((approval) => approval.state), ["invalidated", "pending"]);
  assert.ok(eventsOf(box, "p1").some((event) => event.type === "approval.invalidated" && event.approvalId === run.approvals[0].id));
  assert.notEqual(run.approvals[0].subject, run.approvals[1].subject);
  // The old approval cannot be granted any more.
  assert.throws(() => grantApproval(loadRun(findRunDir(box, "p1")).run, run.approvals[0].id, { by: { source: "tty", name: "tester" }, now: new Date().toISOString(), env: {} }), (error) => error.code === "APPROVAL_INVALIDATED");

  const done = drive(box, "p1", file);
  assert.equal(done.code, 0, done.err + done.out);
});

// --- 6. repair loop ------------------------------------------------------------------------------------

test("e2e 6: test fails -> implement again -> test passes on fresh evidence; the same signature twice blocks", () => {
  const box = makeBox();
  const red = () => attempt(graph, "test", { results: { "unit-test": "fail" }, outcome: "fail-retryable", signature: "unit-test:red" });
  const repaired = box.scriptFile(script(graph, { implement: [attempt(graph, "implement"), attempt(graph, "implement")], test: [red(), attempt(graph, "test")] }));
  assert.equal(start(box, "r1", repaired).code, 6);
  const done = drive(box, "r1", repaired);
  assert.equal(done.code, 0, done.err + done.out);
  const run = show(box, "r1");
  assert.equal(run.status, "completed");
  assert.deepEqual([run.nodes.find((n) => n.id === "implement").attempts, run.nodes.find((n) => n.id === "test").attempts], [2, 2]);

  const stuck = box.scriptFile(script(graph, { implement: [attempt(graph, "implement"), attempt(graph, "implement")], test: [red(), red()] }));
  assert.equal(start(box, "r2", stuck).code, 6);
  const blocked = drive(box, "r2", stuck);
  assert.equal(blocked.code, 1, blocked.err + blocked.out);
  assert.equal(show(box, "r2").status, "blocked");
  assert.ok(eventsOf(box, "r2").some((event) => event.type === "node.completed" && event.stableFailure === true));
});

// --- 7. interruption -------------------------------------------------------------------------------------

test("e2e 7: an aborted signal pauses the run (130), releases the lock, and resume completes it", async () => {
  const box = makeBox();
  const file = box.scriptFile(script(graph));
  const inProcess = async (args, extra = {}) => {
    const out = [];
    const err = [];
    const code = await runCli(args, { stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, stdin: { write() {} }, env: box.env, cwd: box.repo, ...extra });
    return { code, out: out.join(""), err: err.join("") };
  };
  const paused = await inProcess(["run", "start", ...common(box, file), "--run-id", "i1", "--json"], { signal: AbortSignal.abort() });
  assert.equal(paused.code, 130, paused.err + paused.out);
  assert.equal(JSON.parse(paused.out).status, "paused");
  assert.equal(show(box, "i1").status, "paused");
  assert.equal(show(box, "i1").lock.state, "none");

  const resumed = await inProcess(["run", "resume", "i1", ...common(box, file), "--json"]);
  assert.equal(resumed.code, 6, resumed.err + resumed.out);
  approveAll(box, "i1");
  const done = await inProcess(["run", "resume", "i1", ...common(box, file), "--json"]);
  assert.equal(done.code, 0, done.err + done.out);
  assert.equal(show(box, "i1").status, "completed");
  assert.ok(eventsOf(box, "i1").some((event) => event.type === "run.paused"));
  assert.ok(eventsOf(box, "i1").some((event) => event.type === "run.resumed"));
});
