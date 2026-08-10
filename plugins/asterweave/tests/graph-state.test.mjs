import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  NODE_CONTRACTS,
  NODE_ORDER,
  addEvidence,
  approve,
  completeNode,
  enterNode,
  initialize,
  loadState,
  resume,
  validateState,
} from "../scripts/graph-state.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "asterweave-state-"));
}

function passCurrent(cwd, node) {
  enterNode(node, cwd);
  for (const kind of NODE_CONTRACTS[node].evidence) {
    addEvidence(node, { kind, summary: `${kind} passed`, result: "pass" }, cwd);
  }
  completeNode(node, "pass", {}, cwd);
}

test("completes the full graph only with required evidence", () => {
  const cwd = workspace();
  initialize({ goal: "Ship feature", source: "org/repo#1", cwd });
  for (const node of NODE_ORDER) {
    if (node === "approve") {
      approve({ by: "Anjo", summary: "Approved test plan" }, cwd);
    } else {
      passCurrent(cwd, node);
    }
  }
  const state = loadState(cwd);
  assert.equal(state.status, "completed");
  assert.equal(state.currentNode, "done");
  assert.deepEqual(validateState(state), []);
  const ledger = readFileSync(join(cwd, ".claude", "asterweave", "events.jsonl"), "utf8").trim().split("\n");
  assert.ok(ledger.length >= NODE_ORDER.length * 3);
});

test("refuses to pass a node with missing evidence", () => {
  const cwd = workspace();
  initialize({ goal: "Analyze feature", cwd });
  enterNode("intake", cwd);
  assert.throws(() => completeNode("intake", "pass", {}, cwd), /missing evidence kinds: task/);
});

test("routes test failure back through implementation and invalidates downstream gates", () => {
  const cwd = workspace();
  initialize({ goal: "Fix bug", cwd });
  for (const node of ["intake", "analyze", "challenge", "plan"]) passCurrent(cwd, node);
  approve({ by: "Anjo", summary: "Approved" }, cwd);
  passCurrent(cwd, "implement");
  enterNode("test", cwd);
  addEvidence("test", { kind: "unit-test", summary: "One failure", result: "fail" }, cwd);
  completeNode("test", "fail-retryable", { signature: "unit:one" }, cwd);
  const state = loadState(cwd);
  assert.equal(state.currentNode, "implement");
  assert.equal(state.nodes.implement.status, "pending");
  assert.equal(state.nodes.test.status, "pending");
});

test("new passing evidence supersedes an earlier failure without deleting history", () => {
  const cwd = workspace();
  initialize({ goal: "Fix task intake", cwd });
  enterNode("intake", cwd);
  addEvidence("intake", { kind: "task", summary: "Malformed task", result: "fail" }, cwd);
  addEvidence("intake", { kind: "task", summary: "Normalized task", result: "pass" }, cwd);
  completeNode("intake", "pass", {}, cwd);
  const state = loadState(cwd);
  assert.equal(state.nodes.intake.evidence.length, 2);
  assert.equal(state.currentNode, "analyze");
});

test("stable repeated failure blocks the workflow", () => {
  const cwd = workspace();
  initialize({ goal: "Investigate", cwd });
  enterNode("intake", cwd);
  completeNode("intake", "fail-retryable", { signature: "github:timeout" }, cwd);
  enterNode("intake", cwd);
  completeNode("intake", "fail-retryable", { signature: "github:timeout" }, cwd);
  assert.equal(loadState(cwd).status, "blocked");
  resume(cwd);
  assert.equal(loadState(cwd).status, "active");
});
