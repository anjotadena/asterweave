import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evaluateCommand, evaluatePush, runHook } from "../scripts/hook-guard.mjs";
import { evaluateStop } from "../scripts/hook-stop-gate.mjs";
import { initialize } from "../scripts/graph-state.mjs";
import { initRun } from "../scripts/completion-state.mjs";

test("destructive guard blocks high-impact commands and permits safe checks", async () => {
  assert.equal(evaluateCommand("git reset --hard HEAD~1").blocked, true);
  assert.equal(evaluateCommand("rm -rf /").blocked, true);
  assert.equal(evaluateCommand("dotnet test App.sln").blocked, false);
  const output = await runHook(JSON.stringify({ tool_input: { command: "git clean -fdx" } }));
  const parsed = JSON.parse(output.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny");
});

test("pushes that land on a default branch ask instead of running silently", async () => {
  const onFeature = { branchOf: () => "feat/pos" };
  const onMain = { branchOf: () => "main" };
  assert.equal(evaluatePush("git push -u origin feat/pos", onFeature).ask, false);
  assert.equal(evaluatePush("git push", onFeature).ask, false);
  assert.equal(evaluatePush("git push --tags", onMain).ask, false);
  assert.equal(evaluatePush("git push origin --delete old-branch", onFeature).ask, false);
  assert.equal(evaluatePush("git status && git log", onMain).ask, false);

  assert.match(evaluatePush("git push origin master", onFeature).reason, /directly to 'master'/);
  assert.equal(evaluatePush("git push origin HEAD:main", onFeature).ask, true);
  assert.equal(evaluatePush("git push origin +refs/heads/release:refs/heads/main", onFeature).ask, true);
  assert.equal(evaluatePush("git push", onMain).ask, true);
  assert.equal(evaluatePush("dotnet test && git -C ../repo push origin", onMain).ask, true);
  assert.equal(evaluatePush("git push --all origin", onFeature).ask, true);

  const output = await runHook(JSON.stringify({ tool_input: { command: "git push origin main" } }));
  const parsed = JSON.parse(output.stdout);
  assert.equal(parsed.hookSpecificOutput.permissionDecision, "ask");
  assert.match(parsed.hookSpecificOutput.permissionDecisionReason, /submit-pr/);
});

function stopWorkspace() {
  const cwd = mkdtempSync(join(tmpdir(), "asterweave-stop-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "asterweave-stop-counters-"));
  return { cwd, options: { env: {}, stateDirectory } };
}

function stopTranscript(cwd, { startedAt = new Date(Date.now() - 60_000).toISOString(), lastText = "Wave 1 merged; starting wave 2." } = {}) {
  const path = join(cwd, "transcript.jsonl");
  const entries = [
    { type: "user", timestamp: startedAt, message: { content: "/asterweave:deliver issue" } },
    { type: "assistant", timestamp: startedAt, message: { content: [{ type: "text", text: lastText }] } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

function touchLedger(path) {
  const state = JSON.parse(readFileSync(path, "utf8"));
  state.touched = (state.touched ?? 0) + 1;
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

test("stop gate continues active graphs but allows approval and recursive stop handling", () => {
  const { cwd, options } = stopWorkspace();
  initialize({ goal: "Deliver issue", cwd });
  const transcript_path = stopTranscript(cwd);
  const output = evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, options);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /auto-continue \(1\/25\)/);
  assert.match(output.reason, /at node 'intake'/);

  // stop_hook_active no longer short-circuits: the per-session counter bounds the loop instead.
  const statePath = join(cwd, ".claude", "asterweave", "state.json");
  touchLedger(statePath);
  const again = evaluateStop({ cwd, transcript_path, session_id: "s1", stop_hook_active: true }, cwd, options);
  assert.match(again.reason, /auto-continue \(2\/25\)/);

  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.currentNode = "approve";
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, options), null);

  state.currentNode = "implement";
  state.status = "blocked";
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, options), null, "blocked runs need a human");
});

test("stop gate continues active completion runs but not at the approval checkpoint", () => {
  const { cwd, options } = stopWorkspace();
  const run = initRun({ goal: "Finish modules", cwd });
  const transcript_path = stopTranscript(cwd);
  const output = evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, options);
  assert.match(output.reason, new RegExp(`completion run ${run.runId} is in phase 'discovery'`));

  const statePath = join(cwd, ".claude", "asterweave", "completion", run.runId, "state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.phase = "awaiting-approval";
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, options), null);
});

test("stop gate ignores ledgers from earlier sessions and lets questions through", () => {
  const { cwd, options } = stopWorkspace();
  initialize({ goal: "Deliver issue", cwd });
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(evaluateStop({ cwd, transcript_path: stopTranscript(cwd, { startedAt: future }), session_id: "s1" }, cwd, options), null);
  assert.equal(evaluateStop({ cwd, session_id: "s1" }, cwd, options), null, "no transcript, no session scope");

  const asking = stopTranscript(cwd, { lastText: "Should the refund flow reuse the folio ledger or get its own?" });
  assert.equal(evaluateStop({ cwd, transcript_path: asking, session_id: "s2" }, cwd, options), null);
});

test("stop gate stops nudging on stalls, at the cap, and when disabled", () => {
  const { cwd, options } = stopWorkspace();
  initialize({ goal: "Deliver issue", cwd });
  const transcript_path = stopTranscript(cwd);
  const payload = { cwd, transcript_path, session_id: "stall" };
  assert.ok(evaluateStop(payload, cwd, options), "first nudge");
  assert.ok(evaluateStop(payload, cwd, options), "one unchanged stop is tolerated");
  assert.equal(evaluateStop(payload, cwd, options), null, "two unchanged stops mean it is stuck");

  mkdirSync(join(cwd, ".claude"), { recursive: true });
  writeFileSync(join(cwd, ".claude", "asterweave.json"), JSON.stringify({ version: 1, autoContinue: { maxNudges: 2 } }));
  const capped = { cwd, transcript_path, session_id: "cap" };
  const statePath = join(cwd, ".claude", "asterweave", "state.json");
  assert.ok(evaluateStop(capped, cwd, options));
  touchLedger(statePath);
  assert.ok(evaluateStop(capped, cwd, options));
  touchLedger(statePath);
  assert.equal(evaluateStop(capped, cwd, options), null, "cap reached");

  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "env" }, cwd, { ...options, env: { ASTERWEAVE_NO_AUTOCONTINUE: "1" } }), null);
  writeFileSync(join(cwd, ".claude", "asterweave.json"), JSON.stringify({ version: 1, autoContinue: { enabled: false } }));
  touchLedger(statePath);
  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "config" }, cwd, options), null);
});

test("stop gate yields to the handoff reminder once the context budget is reached", () => {
  const { cwd, options } = stopWorkspace();
  initialize({ goal: "Deliver issue", cwd });
  const transcript_path = stopTranscript(cwd);
  const usage = { type: "assistant", message: { content: [{ type: "text", text: "Still implementing." }], usage: { input_tokens: 10, cache_read_input_tokens: 200_000, output_tokens: 10 } } };
  writeFileSync(transcript_path, `${readFileSync(transcript_path, "utf8")}${JSON.stringify(usage)}\n`);
  const env = { ASTERWEAVE_HANDOFF_WARN_TOKENS: "150000" };
  assert.equal(evaluateStop({ cwd, transcript_path, session_id: "s1" }, cwd, { ...options, env }), null);
});
