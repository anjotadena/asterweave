// policy.json: the only source of autonomy. Missing => supervised, invalid => POLICY_INVALID (exit 5), hash stable.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { CliError } from "../src/exit-codes.mjs";
import { evaluate } from "./guard-fixture.mjs";
import {
  DEFAULT_BUDGETS,
  DEFAULT_POLICY,
  PolicyError,
  canonicalJson,
  effectiveMode,
  globMatch,
  loadPolicy,
  policyFilePath,
  policyHash,
  resolveBudgets,
  validatePolicy,
} from "../src/runtime/policy.mjs";

let base;
let seq = 0;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-policy-")));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

/** A fresh user dir (optionally with a policy.json body) and the env that points at it. */
function sandbox(body) {
  const dir = join(base, `u${seq++}`);
  mkdirSync(dir, { recursive: true });
  if (body !== undefined) writeFileSync(join(dir, "policy.json"), typeof body === "string" ? body : JSON.stringify(body));
  return { dir, env: { ASTERWEAVE_CONFIG_DIR: dir } };
}

const valid = (overrides = {}) => ({
  v: 1,
  mode: "autonomous",
  autonomous: { workflows: ["delivery@1"], repos: ["/work/repo"], branches: ["feat/*"], tools: ["shell", "read", "write", "edit", "git"], operations: ["commit", "push-branch", "open-pr"], ...overrides },
});

function assertInvalid(body, pattern) {
  const { env } = sandbox(body);
  assert.throws(
    () => loadPolicy({ env }),
    (error) => {
      assert.ok(error instanceof PolicyError);
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "POLICY_INVALID");
      assert.equal(error.exitCode, 5);
      if (pattern) assert.match(error.message, pattern);
      return true;
    },
  );
}

test("a missing policy.json means supervised defaults", () => {
  const { env, dir } = sandbox();
  const loaded = loadPolicy({ env });
  assert.equal(loaded.source, "default");
  assert.equal(loaded.mode, "supervised");
  assert.deepEqual(loaded.policy, DEFAULT_POLICY);
  assert.equal(loaded.policyHash, policyHash(DEFAULT_POLICY));
  assert.equal(loaded.file, join(dir, "policy.json"));
  assert.equal(policyFilePath({ env }), join(dir, "policy.json"));
});

test("a valid policy loads from the user directory with a stable hash", () => {
  const body = valid();
  const { env } = sandbox(body);
  const loaded = loadPolicy({ env });
  assert.equal(loaded.source, "file");
  assert.equal(loaded.mode, "autonomous");
  assert.deepEqual(loaded.policy, body);
  assert.match(loaded.policyHash, /^[0-9a-f]{64}$/);
  // Key order and whitespace do not change the hash; any value change does.
  const reordered = JSON.stringify({ autonomous: { operations: body.autonomous.operations, tools: body.autonomous.tools, branches: body.autonomous.branches, repos: body.autonomous.repos, workflows: body.autonomous.workflows }, mode: "autonomous", v: 1 }, null, 4);
  assert.equal(loadPolicy({ env: sandbox(reordered).env }).policyHash, loaded.policyHash);
  assert.notEqual(loadPolicy({ env: sandbox(valid({ operations: ["commit"] })).env }).policyHash, loaded.policyHash);
  assert.equal(policyHash(body), loaded.policyHash);
  // A UTF-8 BOM is tolerated.
  assert.equal(loadPolicy({ env: sandbox(`﻿${JSON.stringify(body)}`).env }).policyHash, loaded.policyHash);
});

test("canonicalJson sorts keys recursively and rejects values without a canonical form", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonicalJson({ a: Number.NaN }), TypeError);
  assert.throws(() => canonicalJson(() => 1), TypeError);
});

test("an invalid or unreadable policy fails closed with POLICY_INVALID (exit 5)", () => {
  assertInvalid("{not json", /not valid JSON/);
  assertInvalid("", /empty/);
  assertInvalid("null", /empty or null/);
  assertInvalid("[]", /JSON object/);
  assertInvalid({ v: 2, mode: "supervised" }, /v must be 1/);
  assertInvalid({ v: 1, mode: "yolo" }, /mode must be/);
  assertInvalid({ v: 1, mode: "supervised", extra: true }, /unknown property 'extra'/);
  assertInvalid({ v: 1, mode: "autonomous" }, /requires an autonomous block/);
  assertInvalid(valid({ workflows: [] }), /must not be empty/);
  assertInvalid(valid({ workflows: ["delivery"] }), /invalid format/);
  assertInvalid(valid({ repos: [] }), /repos/);
  assertInvalid(valid({ tools: ["shell", "teleport"] }), /tools\[1\]/);
  assertInvalid(valid({ operations: ["commit", "commit"] }), /duplicate/);
  assertInvalid(valid({ budgets: { iterations: -1 } }), /iterations/);
  assertInvalid(valid({ budgets: { dollars: 5 } }), /not a known budget/);
  assertInvalid(valid({ surprise: 1 }), /not a known property/);
  // A directory where the file should be is unreadable, which is also invalid (never "supervised by accident").
  const { dir, env } = sandbox();
  mkdirSync(join(dir, "policy.json"));
  assert.throws(() => loadPolicy({ env }), (error) => error instanceof PolicyError && error.exitCode === 5);
});

test("merge, deploy, publish and default-branch pushes cannot be granted by a policy", () => {
  assertInvalid(valid({ operations: ["commit", "merge"] }), /operations\[1\]/);
  assertInvalid(valid({ operations: ["deploy"] }), /operations\[0\]/);
  assertInvalid(valid({ operations: ["default-branch-push"] }), /operations\[0\]/);
  assertInvalid(valid({ tools: ["merge"] }), /tools\[0\]/);
  assertInvalid(valid({ tools: ["deploy"] }), /tools\[0\]/);
  assert.deepEqual(validatePolicy(valid()), []);
});

test("repository files can never grant autonomy: only <userDir>/policy.json is read", () => {
  const { env } = sandbox(); // no policy.json in the user directory
  const repo = join(base, "repo-with-policy");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const grant = { version: 1, ...valid(), policy: valid(), autonomous: valid().autonomous, mode: "autonomous" };
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify(grant));
  writeFileSync(join(repo, "policy.json"), JSON.stringify(valid()));
  writeFileSync(join(repo, ".claude", "policy.json"), JSON.stringify(valid()));
  const loaded = loadPolicy({ env, cwd: repo, repoPath: repo });
  assert.equal(loaded.source, "default");
  assert.equal(loaded.mode, "supervised");
  assert.equal(effectiveMode(loaded.policy, { workflow: "delivery@1", repoKey: "/work/repo", branch: "feat/x" }).mode, "supervised");
  const decision = evaluate({ type: "tool", tool: { name: "shell", input: { command: "npm install" } } }, { workspaceRoot: repo, mode: effectiveMode(loaded.policy, { workflow: "delivery@1" }).mode, env });
  assert.equal(decision.decision, "require-approval");
});

test("effectiveMode: autonomous only inside the workflow, repository and branch scope", () => {
  const policy = valid();
  const scope = { workflow: "delivery@1", repoKey: "/work/repo", branch: "feat/x" };
  assert.deepEqual(effectiveMode(policy, scope), { mode: "autonomous", reason: "inside the autonomous policy scope" });
  assert.equal(effectiveMode(policy, { ...scope, workflow: "bugfix@1" }).mode, "supervised");
  assert.equal(effectiveMode(policy, { ...scope, repoKey: "/work/other" }).mode, "supervised");
  assert.equal(effectiveMode(policy, { ...scope, branch: "main" }).mode, "supervised");
  assert.equal(effectiveMode(policy, { ...scope, branch: "feat/a/b" }).mode, "supervised", "* does not cross a slash");
  assert.equal(effectiveMode(policy, { ...scope, branch: null }).mode, "supervised");
  assert.equal(effectiveMode(policy, {}).mode, "supervised");
  assert.equal(effectiveMode(valid({ branches: undefined }), { ...scope, branch: "anything" }).mode, "autonomous", "no branch list = any branch");
  assert.equal(effectiveMode({ v: 1, mode: "supervised", autonomous: policy.autonomous }, scope).mode, "supervised", "mode supervised wins");
  assert.equal(effectiveMode(null, scope).mode, "supervised");
});

test("policy tools, operations and branches drive the guard; budgets resolve over the defaults", () => {
  const policy = valid({ tools: ["shell"], operations: ["commit"], branches: ["feat/*"] });
  const ctx = { workspaceRoot: base, cwd: base, mode: "autonomous", policy, env: {}, homedir: () => base, userDir: join(base, "nouser"), branchOf: () => "feat/x", remotesOf: () => ["origin"] };
  const shell = (command) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
  assert.equal(shell('git commit -m "x"').decision, "allow");
  assert.equal(shell("git push origin feat/x").reason, "OUT_OF_POLICY_OPERATION", "push-branch is not listed");
  assert.equal(evaluate({ type: "tool", tool: { name: "write", input: { path: "a.txt" } } }, ctx).reason, "TOOL_NOT_ALLOWED");
  assert.deepEqual(resolveBudgets(DEFAULT_POLICY), { ...DEFAULT_BUDGETS });
  assert.equal(DEFAULT_BUDGETS.iterations, 20);
  assert.equal(DEFAULT_BUDGETS.toolCalls, 200);
  assert.equal(DEFAULT_BUDGETS.wallMs, 30 * 60 * 1000);
  assert.deepEqual(resolveBudgets(valid({ budgets: { iterations: 5, tokens: 1000 } })), { iterations: 5, toolCalls: 200, tokens: 1000, wallMs: 1_800_000 });
});

test("globMatch: * stays in a segment, ** crosses, ? is one character, other characters are literal", () => {
  assert.equal(globMatch("feat/*", "feat/x"), true);
  assert.equal(globMatch("feat/*", "feat/x/y"), false);
  assert.equal(globMatch("feat/**", "feat/x/y"), true);
  assert.equal(globMatch("fix-?", "fix-1"), true);
  assert.equal(globMatch("fix-?", "fix-12"), false);
  assert.equal(globMatch("release/1.0", "release/1x0"), false);
  assert.equal(globMatch("a+b", "a+b"), true);
});
