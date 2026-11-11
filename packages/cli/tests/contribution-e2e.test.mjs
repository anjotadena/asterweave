// End to end through the real bin: the contribution workflows against the bug fixture. Scripted (fake) executor, real checks run by
// the harness (tests/contribution-fixture.mjs). No model, no network, no remote write. Temp user directory only.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.mjs";
import { createRunCommand, resolveRepo, runCommandMeta } from "../src/commands/run.mjs";
import { runDir } from "../src/runtime/ledger.mjs";
import { grantTrust } from "../src/trust.mjs";
import { BIN, SYMPTOM, cli, contributeScript, contributionSummary, doFixWork, makeBox, recordStructured, runDirOf, runUnavailableCheck } from "./contribution-fixture.mjs";
import { cleanupTemp, git, waitFor } from "./repo-fixture.mjs";

const children = new Set();
after(() => {
  for (const child of children) child.kill("SIGKILL");
  cleanupTemp();
});

const parse = (result) => JSON.parse(result.out);
const fakeArgs = (file, runId, graph, goal) => ["run", "start", "--executor", "fake", "--script", file, "--graph", graph, "--goal", goal, "--run-id", runId, "--json"];
const show = (box, runId) => parse(cli(box, ["run", "show", runId, "--json"])).run;
const readEvents = (box, runId) => readFileSync(join(runDirOf(box, runId), "events.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
const contributionOf = (box, runId) => JSON.parse(readFileSync(join(runDirOf(box, runId), "contribution.json"), "utf8"));

test("fixture bug: routed to bug-fix, reproduced, fixed, regression-checked, diff-reviewed and packaged - no remote action", () => {
  const box = makeBox();
  const routed = parse(cli(box, ["skill", "route", SYMPTOM, "--json"])).route;
  assert.deepEqual([routed.skill, routed.workflow, routed.scope], ["bug-fix", "bugfix", "implement"]);

  const work = doFixWork(box.repo);
  assert.equal(work.baseline.ok, true, "the existing suite passes before the change");
  assert.equal(work.beforeFix.ok, false, "the regression test FAILS on the unfixed code: the bug is real");
  assert.equal(work.beforeFix.fail, 2, "both new regression tests catch it");
  assert.equal(work.afterFix.ok, true, "and passes after the fix");
  assert.equal(work.rootCause.file, "src/nav.mjs");
  assert.deepEqual(work.changedFiles, ["src/nav.mjs", "test/search-restore.test.mjs"]);
  assert.equal(work.diffClean, true);
  assert.match(contributionSummary(work), /Remote actions: none/);

  const result = cli(box, fakeArgs(box.scriptFile(contributeScript(work)), "c1", "contribute@1", SYMPTOM));
  assert.equal(result.code, 0, result.err + result.out);
  assert.equal(parse(result).status, "completed");

  recordStructured(box, "c1", work);
  const run = show(box, "c1");
  assert.deepEqual(run.contribution.findings, { total: 1, suspected: 0, reproduced: 0, "fixed-locally": 0, verified: 1, blocked: 0, ledgerEvidence: 1 });
  assert.equal(run.contribution.task, "Keep the search text when navigating back");
  assert.deepEqual(run.nodes.map((node) => node.status), Array(8).fill("passed"));
  assert.equal(run.contribution.skill, "contribute");
  assert.equal(run.contribution.stagesPassed, "8/8");
  assert.deepEqual(run.contribution.verification, [{ stage: "test-verify", status: "passed" }, { stage: "pr-review", status: "passed" }]);
  assert.deepEqual(run.contribution.remote, []);

  // the reproduction is recorded as evidence before the change, with the real failure counts
  const events = readEvents(box, "c1");
  const evidence = events.filter((event) => event.type === "evidence.recorded" || event.evidence).map((event) => event.evidence ?? event);
  const kinds = evidence.map((item) => item.kind);
  assert.ok(kinds.indexOf("reproduction") < kinds.indexOf("change") && kinds.indexOf("change") < kinds.indexOf("regression-test") && kinds.indexOf("regression-test") < kinds.indexOf("code-review") && kinds.indexOf("code-review") < kinds.indexOf("contribution-package"));
  assert.match(evidence.find((item) => item.kind === "reproduction").summary, /2 failed/);

  const text = cli(box, ["run", "show", "c1"]).out;
  assert.match(text, /Contribution/);
  assert.match(text, /skill\s+contribute via contribute, scope implement/);
  assert.match(text, /test-verify passed, pr-review passed/);
  assert.match(text, /not recorded by the ledger: active agent, current tool, changed files/);
});

test("discovery run: audit@1 ends after triage with reviewed findings and leaves the repository untouched", () => {
  const box = makeBox();
  const before = git(box.repo, "status", "--porcelain");
  const work = { baseline: { ok: true, pass: 2, fail: 0 }, beforeFix: { ok: false, pass: 1, fail: 1 }, afterFix: { ok: true, pass: 3, fail: 0 }, rootCause: { file: "src/nav.mjs", line: 17 }, changedFiles: [], diffClean: true };
  const full = contributeScript(work).steps.filter((step) => ["discover", "audit", "triage"].includes(step.node));
  const result = cli(box, fakeArgs(box.scriptFile({ v: 1, steps: full }), "a1", "audit@1", "Audit this repository"));
  assert.equal(result.code, 0, result.err + result.out);
  const run = show(box, "a1");
  assert.deepEqual(run.nodes.map((node) => node.id), ["discover", "audit", "triage"], "no node can implement");
  assert.equal(run.status, "completed");
  assert.equal(run.contribution.scope, "discovery");
  assert.match(run.contribution.next, /decide which work to authorize/);
  assert.equal(git(box.repo, "status", "--porcelain"), before, "nothing in the repository changed");
});

test("a required check that cannot run stays visibly blocked, is never reported as passed, and abort ends the run cleanly", () => {
  const box = makeBox();
  const work = doFixWork(box.repo);
  const unavailable = runUnavailableCheck(box.repo);
  assert.equal(unavailable.ran, false, "the lint check really is unavailable here");
  const result = cli(box, fakeArgs(box.scriptFile(contributeScript(work, { unavailable })), "b1", "contribute@1", SYMPTOM));
  assert.equal(result.code, 1, "blocked is a non-zero exit");
  const run = show(box, "b1");
  assert.equal(run.status, "blocked");
  assert.equal(run.currentNode, "test-verify");
  assert.deepEqual(run.nodes.filter((node) => node.status === "passed").map((node) => node.id), ["discover", "audit", "triage", "select", "implement"]);
  assert.equal(run.nodes.find((node) => node.id === "pr-review").status, "pending", "later stages never ran");
  assert.equal(run.contribution.blocked, true);
  assert.match(run.contribution.next, /resolve the blocker at test-verify/);
  assert.match(cli(box, ["run", "show", "b1"]).out, /blocked\s+yes/);

  const abort = cli(box, ["run", "abort", "b1", "--yes"]);
  assert.equal(abort.code, 0, abort.err + abort.out);
  const aborted = show(box, "b1");
  assert.equal(aborted.status, "aborted");
  assert.equal(aborted.lock.state, "none", "no lock is left behind");
  assert.equal(cli(box, ["run", "resume", "b1", "--executor", "fake", "--script", box.scriptFile({ v: 1, steps: [] }), "--json"]).code, 1, "an aborted run does not restart");
});

test("a run killed mid-implement resumes with the same recorded scope and task, and completes without repeating finished stages", async () => {
  const box = makeBox();
  const work = doFixWork(box.repo);
  const slow = box.scriptFile(contributeScript(work, { slowImplement: true }));
  const child = spawn(process.execPath, [BIN, ...fakeArgs(slow, "k1", "contribute@1", SYMPTOM)], { cwd: box.repo, env: box.env, stdio: ["ignore", "pipe", "pipe"] });
  children.add(child);
  child.stdout.resume();
  child.stderr.resume();
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(() => existsSync(join(runDirOf(box, "k1") ?? box.root, "events.jsonl")) && readEvents(box, "k1").some((event) => event.type === "action.started"), { timeoutMs: 60_000, label: "implement started" });
  const recorded = contributionOf(box, "k1");
  child.kill("SIGKILL");
  await exited;

  const resumed = cli(box, ["run", "resume", "k1", "--executor", "fake", "--script", slow, "--json"]);
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  const run = show(box, "k1");
  assert.equal(run.status, "completed");
  assert.deepEqual(contributionOf(box, "k1").scope, recorded.scope, "resume does not re-record or widen the scope");
  assert.equal(readEvents(box, "k1").filter((event) => event.type === "node.recovered").length >= 1, true, "the interruption is recorded");
  assert.equal(run.nodes.find((node) => node.id === "discover").attempts, 1, "finished stages are not repeated");
});

// --- automatic routing through the real run command (fake claude process) -----------------------------

const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

async function autoRun(argv) {
  const box = makeBox("aw-auto-");
  const scenario = join(box.root, "scenario.json");
  writeFileSync(scenario, JSON.stringify({ record: join(box.root, "record.json"), sessionId: SID, protocol: true }));
  grantTrust(box.repo, { env: box.env });
  const identity = await resolveRepo({ cwd: box.repo, env: box.env });
  const parsed = parseArgs(argv, { boolean: [...runCommandMeta.boolean, "help", "version"] });
  const handler = createRunCommand({ claude: { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE, "--fake-scenario", scenario] }, loopOptions: { sleep: async () => {} } });
  const stdout = sink();
  let outcome;
  try {
    outcome = { code: await handler({ stdin: sink(), stdout, stderr: sink(), env: box.env, cwd: box.repo, name: "run", argv, ...parsed }) };
  } catch (error) {
    outcome = { error, code: error.exitCode };
  }
  return { ...outcome, box, out: stdout.text(), dir: (id) => runDir(identity.key, id, { env: box.env }) };
}

test("run start --workflow auto: the symptom selects bug-fix and records the skill and scope; the default workflow is unchanged", async () => {
  const fx = await autoRun(["start", SYMPTOM, "--workflow", "auto", "--run-id", "auto1", "--json"]);
  const state = JSON.parse(readFileSync(join(fx.dir("auto1"), "contribution.json"), "utf8"));
  assert.deepEqual([state.skill, state.workflow, state.scope.level], ["bug-fix", "bugfix", "implement"]);
  const run = JSON.parse(readFileSync(join(fx.dir("auto1"), "run.json"), "utf8"));
  assert.equal(run.graph.id, "bugfix");

  const plain = await autoRun(["start", SYMPTOM, "--run-id", "plain1", "--json"]);
  assert.equal(JSON.parse(readFileSync(join(plain.dir("plain1"), "run.json"), "utf8")).graph.id, "delivery");
  assert.equal(existsSync(join(plain.dir("plain1"), "contribution.json")), false, "ordinary delivery runs are untouched");
});

test("run start --workflow auto: an audit request records the discovery scope and runs the audit graph, which cannot implement", async () => {
  const fx = await autoRun(["start", "Audit this repository and find something I can contribute", "--workflow", "auto", "--run-id", "auto2", "--json"]);
  const state = JSON.parse(readFileSync(join(fx.dir("auto2"), "contribution.json"), "utf8"));
  assert.deepEqual([state.skill, state.workflow, state.scope.level], ["contribute", "audit", "discovery"]);
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(fx.dir("auto2"), "run.json"), "utf8")).nodes), ["discover", "audit", "triage"]);
});

test("run start --workflow auto: an unroutable goal or an in-session skill is a usage error, before any run exists", async () => {
  const none = await autoRun(["start", "what is the weather", "--workflow", "auto", "--run-id", "x1"]);
  assert.equal(none.code, 2);
  const session = await autoRun(["start", "Review this PR", "--workflow", "auto", "--run-id", "x2"]);
  assert.equal(session.code, 2);
  assert.match(session.error.message, /pr-review/);
  assert.equal(existsSync(none.dir("x1")), false);
});
