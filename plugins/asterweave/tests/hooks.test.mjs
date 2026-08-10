import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateCommand, runHook } from "../scripts/hook-guard.mjs";
import { evaluateStop } from "../scripts/hook-stop-gate.mjs";
import { initialize } from "../scripts/graph-state.mjs";

test("destructive guard blocks high-impact commands and permits safe checks", async () => {
  assert.equal(evaluateCommand("git reset --hard HEAD~1").blocked, true);
  assert.equal(evaluateCommand("rm -rf /").blocked, true);
  assert.equal(evaluateCommand("dotnet test App.sln").blocked, false);
  const output = await runHook(JSON.stringify({ tool_input: { command: "git clean -fdx" } }));
  const parsed = JSON.parse(output.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("stop gate continues active graphs but allows approval and recursive stop handling", () => {
  const cwd = mkdtempSync(join(tmpdir(), "asterweave-stop-"));
  initialize({ goal: "Deliver issue", cwd });
  const output = evaluateStop({ stop_hook_active: false }, cwd);
  assert.equal(output.hookSpecificOutput.hookEventName, "Stop");
  assert.match(output.hookSpecificOutput.additionalContext, /still active/);
  assert.equal(evaluateStop({ stop_hook_active: true }, cwd), null);

  const statePath = join(cwd, ".claude", "asterweave", "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.currentNode = "approve";
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.equal(evaluateStop({ stop_hook_active: false }, cwd), null);
});
