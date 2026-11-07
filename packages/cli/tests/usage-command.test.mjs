// `asterweave usage` (handler called directly: the lead registers it), against a real ledger in a temp user directory.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildUsageReport, usageCommand, usageCommandMeta } from "../src/commands/usage.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { CliError, EXIT } from "../src/exit-codes.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";
import { deliveryGraph, tool, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

let repo;
function repoDir() {
  if (repo) return repo;
  repo = tempDir("aw-uc-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

const envFor = (userDir) => {
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

async function run(userDir, { usage, steps, runId = "run-u", nodeBudgets, budgets, policy }) {
  const env = envFor(userDir);
  if (policy) writeFileSync(join(userDir, "policy.json"), JSON.stringify(policy));
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: { key: identity.key, realpath: identity.workspace }, runId, env });
  const executor = { ...createFakeExecutor({ v: 1, steps }), ...(usage ? { usage } : {}) };
  await runLoop({ dir, graph: deliveryGraph, executor, sleep: async () => {}, workspaceRoot: identity.workspace, nodeBudgets, budgets, guardOptions: { env, userDir } });
  return { env, dir };
}

async function call(env, positionals = [], options = {}) {
  const stdout = sink();
  const ctx = { stdout, stderr: sink(), stdin: sink(), env, cwd: repoDir(), positionals, options };
  const code = await usageCommand(ctx);
  return { code, out: stdout.text() };
}

const waits = (count) => Array.from({ length: count }, () => ({ node: "intake", action: wait(0) }));

test("usage meta: json only, unknown flags are the registry's job", () => {
  assert.deepEqual(usageCommandMeta.options, ["json"]);
});

test("usage --json: totals, by node, by model, context and budgets are separate; unknown is null", async () => {
  const userDir = tempDir("aw-uc-user-");
  const reports = [
    { inputTokens: 100, outputTokens: 20, contextTokens: 500, model: "claude-sonnet-5-5" },
    { inputTokens: 50, outputTokens: null, contextTokens: 640 },
  ];
  const { env } = await run(userDir, { steps: waits(2), usage: (ctx) => reports[ctx.step] });
  const result = await call(env, [], { json: true });
  assert.equal(result.code, EXIT.OK);
  const body = JSON.parse(result.out);
  assert.equal(body.ok, true);
  assert.equal(body.runId, "run-u");
  const { usage } = body;
  assert.deepEqual([usage.totals.inputTokens, usage.totals.outputTokens, usage.totals.cacheReadTokens, usage.totals.cacheCreationTokens, usage.totals.tokens], [150, 20, null, null, 170]);
  assert.deepEqual([usage.byNode.intake.inputTokens, usage.byNode.intake.toolCalls], [150, 0]);
  assert.deepEqual(Object.keys(usage.byModel).sort(), ["claude-sonnet-5-5", "unknown"]);
  assert.equal(usage.context.tokens, 640, "the context is the latest measured value, not 1140");
  assert.deepEqual(usage.budgets.run.tokens, { used: 170, limit: null, remaining: null }, "no limit: remaining is null");
  assert.deepEqual(usage.budgets.run.toolCalls.limit, 200);
  assert.equal(usage.budgets.run.toolCalls.remaining, 200);
});

test("usage text: measured vs unknown labels, remaining against a policy limit, sanitised output", async () => {
  const userDir = tempDir("aw-uc-user-");
  const policy = { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["x"], tools: ["read"], operations: [], budgets: { tokens: 1000, perNode: { tokens: 400 } } } };
  const { env } = await run(userDir, { steps: waits(2), usage: () => ({ inputTokens: 100, outputTokens: 50 }), policy });
  const { out } = await call(env);
  assert.match(out, /input tokens\s+300 \(measured\)/);
  assert.match(out, /cache read tokens\s+unknown/);
  assert.match(out, /tokens\s+450 \/ 1000, 550 remaining/s);
  assert.match(out, /per node limits: tokens 400/);
  assert.match(out, /intake\s+tokens 450 \/ 400, 0 remaining/);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(out));
});

test("usage: a run that reported nothing shows unknown, never 0; tool calls are still counted per node", async () => {
  const userDir = tempDir("aw-uc-user-");
  const { env } = await run(userDir, { steps: [{ node: "intake", action: tool("read", { path: "a.txt" }) }, ...waits(1)] });
  const body = JSON.parse((await call(env, [], { json: true })).out);
  assert.equal(body.usage.totals.tokens, null);
  assert.equal(body.usage.context.tokens, null);
  assert.deepEqual(body.usage.byModel, {});
  assert.equal(body.usage.budgets.run.tokens.used, null);
  assert.equal(body.usage.budgets.perNode.nodes.intake.toolCalls.used, 1);
  const text = (await call(env)).out;
  assert.match(text, /total \(budget counter\)\s+unknown/);
  assert.match(text, /no usage recorded/);
});

test("usage: runId argument, missing run, no runs, extra argument", async () => {
  const userDir = tempDir("aw-uc-user-");
  const empty = envFor(tempDir("aw-uc-empty-"));
  await assert.rejects(call(empty), (error) => error instanceof CliError && error.code === "RUN_NOT_FOUND" && error.exitCode === EXIT.ERROR && Boolean(error.remediation));
  const { env } = await run(userDir, { steps: waits(1), usage: () => ({ tokens: 9 }), runId: "run-named" });
  assert.equal(JSON.parse((await call(env, ["run-named"], { json: true })).out).runId, "run-named");
  await assert.rejects(call(env, ["nope"]), (error) => error.code === "RUN_NOT_FOUND" && error.exitCode === EXIT.ERROR);
  await assert.rejects(call(env, ["run-named", "extra"]), (error) => error.exitCode === EXIT.USAGE);
  mkdirSync(join(userDir, "x"), { recursive: true });
});

test("buildUsageReport tolerates a pre-ledger run (snapshot tokens, no usage events) and malformed usage events", () => {
  const run = { nodes: { intake: {} }, budgets: { used: { tokens: 321, toolCalls: 1, iterations: 2, wallMs: 5 } } };
  const limits = { run: { tokens: 1000, toolCalls: 0, iterations: 20, wallMs: 100 }, node: {} };
  const legacy = buildUsageReport({ run, events: [], limits });
  assert.deepEqual(legacy.budgets.run.tokens, { used: 321, limit: 1000, remaining: 679 });
  assert.equal(legacy.budgets.run.toolCalls.limit, null, "0 = unlimited");
  const mixed = buildUsageReport({ run, events: [{ type: "usage", node: "intake", source: "executor", inputTokens: 100, outputTokens: 0, attempt: 1 }], limits });
  assert.equal(mixed.totals.tokens, 321, "the larger known number: never under-report a mixed run");
  const small = buildUsageReport({ run: { ...run, budgets: { used: { ...run.budgets.used, tokens: 50 } } }, events: [{ type: "usage", node: "intake", source: "executor", inputTokens: 100, outputTokens: 0, attempt: 1 }], limits });
  assert.equal(small.totals.tokens, 100);
  const bad = buildUsageReport({ run, events: [{ type: "usage", node: "intake", source: "executor", inputTokens: -1 }], limits });
  assert.equal(bad.totals.skipped, 1);
  assert.equal(bad.totals.tokens, 321);
});
