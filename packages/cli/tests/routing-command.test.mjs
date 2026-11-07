// `asterweave model show|explain` (handler called directly: the lead registers it) and the pin written by `run start`.

import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { loadRun, runDir } from "../src/runtime/ledger.mjs";
import { modelCommand, modelCommandMeta } from "../src/commands/model.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { createRunForGraph } from "../src/runtime/loop.mjs";
import { pinRouting } from "../src/runtime/routing.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";
import { deliveryGraph } from "./loop-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

let repo;
function repoDir() {
  if (repo) return repo;
  repo = tempDir("aw-mc-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

function setup(user) {
  const userDir = tempDir("aw-mc-user-");
  if (user) writeFileSync(join(userDir, "config.json"), JSON.stringify(user));
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { userDir, env };
}

async function call(env, positionals = [], options = {}) {
  const stdout = sink();
  const code = await modelCommand({ stdout, stderr: sink(), stdin: sink(), env, cwd: repoDir(), positionals, options });
  return { code, out: stdout.text() };
}

async function startPinned(env, config, runId = "run-m") {
  const identity = await resolveRepo({ cwd: repoDir(), env });
  createRunForGraph({ graph: deliveryGraph, goal: "g", repo: { key: identity.key, realpath: identity.workspace }, runId, routing: pinRouting(config), env });
}

test("model show with nothing configured: every stage uses the runner default, and the text says nothing was verified", async () => {
  const { env } = setup();
  assert.deepEqual(modelCommandMeta.options, ["json"]);
  const text = await call(env);
  assert.equal(text.code, EXIT.OK);
  assert.match(text.out, /current configuration \(no run has pinned one\)/);
  assert.match(text.out, /unverified/);
  assert.match(text.out, /Auth: not checked/);
  assert.match(text.out, /submit-pr\s+\(runner default\)\s+runner-default/);
  const body = JSON.parse((await call(env, ["show"], { json: true })).out);
  assert.equal(body.ok, true);
  assert.equal(body.active, "current");
  assert.equal(body.routes.length, 13);
  assert.equal(body.auth, "not checked");
  assert.equal(body.pinned, null);
  assert.ok(body.catalog.every((entry) => entry.source === "static-catalog" && entry.availability === "unverified"));
});

test("model explain: why a stage got its model, catalog features, unknown models flagged, bad node is exit 2", async () => {
  const { env } = setup({ model: { default: "claude-sonnet-5-5", effort: "high", fallback: ["my-custom-model"], stages: { plan: "claude-opus-5-5", review: "mystery-model" } } });
  const plan = JSON.parse((await call(env, ["explain", "plan"], { json: true })).out);
  assert.deepEqual([plan.route.model, plan.route.source, plan.catalog.id, plan.catalog.features.tools], ["claude-opus-5-5", "stage", "claude-opus-5-5", true]);
  assert.match(plan.route.reason, /model\.stages\.plan/);
  const review = JSON.parse((await call(env, ["explain", "review"], { json: true })).out);
  assert.equal(review.route.availability, "unknown-model");
  assert.equal(review.catalog, null);
  const text = (await call(env, ["explain", "test"])).out;
  assert.match(text, /Model\s+claude-sonnet-5-5 \(default\)/);
  assert.match(text, /Fallback\s+my-custom-model/);
  assert.match(text, /Auth\s+not checked/);
  for (const bad of [["explain"], ["explain", "nope"], ["explain", "plan", "x"], ["bogus"], ["show", "x"]]) {
    await assert.rejects(call(env, bad), (error) => error.exitCode === EXIT.USAGE, bad.join(" "));
  }
});

test("model show uses the route a run pinned, and flags drift when the config changed afterwards", async () => {
  const { env, userDir } = setup({ model: { default: "claude-sonnet-5-5", stages: { plan: "claude-opus-5-5" } } });
  await startPinned(env, { default: "claude-sonnet-5-5", effort: null, fallback: [], stages: { plan: "claude-opus-5-5" } });
  const same = JSON.parse((await call(env, [], { json: true })).out);
  assert.equal(same.active, "pinned");
  assert.equal(same.runId, "run-m");
  assert.equal(same.drift.drifted, false);
  assert.equal(same.routes.find((r) => r.node === "plan").model, "claude-opus-5-5");

  writeFileSync(join(userDir, "config.json"), JSON.stringify({ model: { default: "claude-haiku-5-5", effort: "low" } }));
  const drifted = JSON.parse((await call(env, [], { json: true })).out);
  assert.equal(drifted.drift.drifted, true);
  assert.deepEqual(drifted.drift.changes.map((c) => c.key).sort(), ["default", "effort", "stages.plan"]);
  assert.equal(drifted.routes.find((r) => r.node === "intake").model, "claude-sonnet-5-5", "the pinned route is unchanged");
  assert.equal(drifted.current.default, "claude-haiku-5-5");
  const text = (await call(env)).out;
  assert.match(text, /DRIFT/);
  assert.match(text, /default: pinned claude-sonnet-5-5, now claude-haiku-5-5/);
  const explain = (await call(env, ["explain", "plan"])).out;
  assert.match(explain, /pinned by run run-m; the configuration has DRIFTED/);
});

// --- run start pins the route, validating only the model.* keys ----------------------------------------------------

async function startViaCli(env, userDir, runId) {
  const file = join(userDir, "script.json");
  writeFileSync(file, JSON.stringify({ v: 1, steps: [] }));
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(["run", "start", "--executor", "fake", "--script", file, "--run-id", runId, "--json"], { stdout, stderr, stdin: sink(), env: { ...env, ASTERWEAVE_DEV_EXECUTORS: "1" }, cwd: repoDir() });
  return { code, out: stdout.text(), err: stderr.text() };
}

test("run start pins the model route; an unrelated bad config key does not fail it, a bad model key does (exit 5)", async () => {
  const { env, userDir } = setup({ model: { default: "claude-opus-5-5", effort: "high" }, ui: { color: "sparkly" } });
  const started = await startViaCli(env, userDir, "pin-1");
  assert.notEqual(started.code, EXIT.CONFIG, started.err + started.out);
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const pinned = loadRun(runDir(identity.key, "pin-1", { env })).run.routing;
  assert.deepEqual([pinned.promptVersion, pinned.default, pinned.effort], [1, "claude-opus-5-5", "high"]);
  assert.match(pinned.configHash, /^[0-9a-f]{64}$/);

  writeFileSync(join(userDir, "config.json"), JSON.stringify({ model: { default: "Not A Model" } }));
  const bad = await startViaCli(env, userDir, "pin-2");
  assert.equal(bad.code, EXIT.CONFIG);
  assert.match(bad.err + bad.out, /model.default/);
  assert.ok(!(bad.err + bad.out).includes("Not A Model"), "the bad value is not echoed");
  assert.match(bad.err + bad.out, /Fix model.default/);
  assert.equal(existsSync(runDir(identity.key, "pin-2", { env })), false, "no run directory for a refused start");

  writeFileSync(join(userDir, "config.json"), JSON.stringify({}));
  const badEnv = await startViaCli({ ...env, ASTERWEAVE_MODEL_EFFORT: "extreme" }, userDir, "pin-3");
  assert.equal(badEnv.code, EXIT.CONFIG);
  assert.match(badEnv.err + badEnv.out, /ASTERWEAVE_MODEL_EFFORT/);
});
