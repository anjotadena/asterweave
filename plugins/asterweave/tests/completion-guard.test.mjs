import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateWrite, runHook } from "../scripts/completion-guard.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "asterweave-guard-"));
}

function withManifest(cwd, manifest) {
  const directory = join(cwd, ".claude", "asterweave");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "completion-worker.json"), JSON.stringify(manifest));
}

function financeManifest() {
  return {
    workstreamId: "WS-FINANCE",
    module: "Finance",
    write: ["src/Finance/**", "tests/Finance/**"],
    read: ["src/**"],
    deny: ["src/Inventory/**", "src/HRIS/**"],
    shared: ["src/Shared/**", "src/Infrastructure/**"],
    approvedShared: [],
  };
}

test("allows edits with no active completion-worker manifest (every non-worker session)", () => {
  const cwd = workspace();
  const decision = evaluateWrite({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Anything.cs") } }, cwd);
  assert.equal(decision, null);
});

test("allows a write inside the worker's ownership boundary", () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  const decision = evaluateWrite({ tool_name: "Write", tool_input: { file_path: join(cwd, "src/Finance/RefundService.cs") } }, cwd);
  assert.equal(decision, null);
});

test("denies a write to another workstream's owned path", () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  const decision = evaluateWrite({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Inventory/StockService.cs") } }, cwd);
  assert.ok(decision);
  assert.equal(decision.hookSpecificOutput.permissionDecision, "deny");
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /owned by another workstream/);
});

test("denies a direct write to a shared path", () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  const decision = evaluateWrite({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Shared/Money.cs") } }, cwd);
  assert.ok(decision);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Shared Change Request/);
});

test("allows a shared path once orchestrator-approved", () => {
  const cwd = workspace();
  withManifest(cwd, { ...financeManifest(), approvedShared: ["src/Shared/Money.cs"] });
  const decision = evaluateWrite({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Shared/Money.cs") } }, cwd);
  assert.equal(decision, null);
});

test("denies a write outside every declared boundary by default", () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  const decision = evaluateWrite({ tool_name: "Write", tool_input: { file_path: join(cwd, "README.md") } }, cwd);
  assert.ok(decision);
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /outside this workstream/);
});

test("ignores non-write tools and respects the disable env var", () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  assert.equal(evaluateWrite({ tool_name: "Read", tool_input: { file_path: join(cwd, "src/Inventory/StockService.cs") } }, cwd), null);
  process.env.ASTERWEAVE_DISABLE_OWNERSHIP_GUARD = "1";
  try {
    assert.equal(evaluateWrite({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Inventory/StockService.cs") } }, cwd), null);
  } finally {
    delete process.env.ASTERWEAVE_DISABLE_OWNERSHIP_GUARD;
  }
});

test("runHook denies through stdin JSON exactly like evaluateWrite", async () => {
  const cwd = workspace();
  withManifest(cwd, financeManifest());
  const output = await runHook(JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(cwd, "src/Inventory/StockService.cs") } }), cwd);
  const parsed = JSON.parse(output.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});
