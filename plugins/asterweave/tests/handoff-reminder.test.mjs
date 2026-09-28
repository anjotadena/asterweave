import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { evaluateReminder, latestContextTokens } from "../scripts/hook-handoff-reminder.mjs";

const pluginRoot = resolve(import.meta.dirname, "..");

function workspace(threshold = null) {
  const cwd = mkdtempSync(join(tmpdir(), "asterweave-reminder-"));
  if (threshold) {
    mkdirSync(join(cwd, ".claude"), { recursive: true });
    writeFileSync(join(cwd, ".claude", "asterweave.json"), JSON.stringify({ version: 1, handoff: { contextBudget: { warnAtTokens: threshold } } }));
  }
  return cwd;
}

function transcript(cwd, entries) {
  const path = join(cwd, "transcript.jsonl");
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return path;
}

function usageEntry(inputTokens, { sidechain = false } = {}) {
  return {
    type: "assistant",
    isSidechain: sidechain,
    message: { usage: { input_tokens: 10, cache_read_input_tokens: inputTokens, cache_creation_input_tokens: 0, output_tokens: 100 } },
  };
}

const noEnv = {};

test("the reminder is inert unless a threshold is configured", () => {
  const cwd = workspace();
  const path = transcript(cwd, [usageEntry(900_000)]);
  assert.equal(evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: noEnv }), null);
});

test("usage is read from the latest main-conversation entry and sidechains are ignored", () => {
  const cwd = workspace();
  const path = transcript(cwd, [usageEntry(50_000), { type: "user", message: { content: "hi" } }, usageEntry(900_000, { sidechain: true })]);
  assert.equal(latestContextTokens(path), 50_110);
  assert.equal(latestContextTokens(join(cwd, "missing.jsonl")), null);
  assert.equal(latestContextTokens(transcript(cwd, [{ type: "user" }])), null, "no usage means no claim about context size");
});

test("crossing the threshold asks once per band and respects stop_hook_active", () => {
  const cwd = workspace(100_000);
  let path = transcript(cwd, [usageEntry(80_000)]);
  assert.equal(evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: noEnv }), null, "below threshold");

  path = transcript(cwd, [usageEntry(110_000)]);
  const output = evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: noEnv });
  assert.equal(output.decision, "block");
  assert.match(output.reason, /\/asterweave:handoff/);
  assert.match(output.reason, /not an exact remaining-token count/);
  assert.equal(evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: noEnv }), null, "same band does not repeat");
  assert.equal(evaluateReminder({ cwd, transcript_path: path, session_id: "s1", stop_hook_active: true }, { env: noEnv }), null);

  path = transcript(cwd, [usageEntry(130_000)]);
  assert.ok(evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: noEnv }), "a higher band reminds again");
  assert.ok(evaluateReminder({ cwd, transcript_path: path, session_id: "s2" }, { env: noEnv }), "another session is independent");
});

test("the environment threshold overrides the adapter and the hook never writes a handoff", () => {
  const cwd = workspace(500_000);
  const path = transcript(cwd, [usageEntry(200_000)]);
  const output = evaluateReminder({ cwd, transcript_path: path, session_id: "s1" }, { env: { ASTERWEAVE_HANDOFF_WARN_TOKENS: "150000" } });
  assert.equal(output.decision, "block");
  const markers = JSON.parse(readFileSync(join(cwd, ".claude/asterweave/handoffs/.reminders.json"), "utf8"));
  assert.deepEqual(Object.keys(markers), ["s1"]);
});

test("the reminder is registered on Stop only, alongside the evidence gate", () => {
  const hooks = JSON.parse(readFileSync(join(pluginRoot, "hooks", "hooks.json"), "utf8")).hooks;
  const stopCommands = hooks.Stop.flatMap((group) => group.hooks.map((hook) => hook.command));
  assert.ok(stopCommands.some((command) => command.includes("hook-handoff-reminder.mjs")));
  assert.ok(stopCommands.some((command) => command.includes("hook-stop-gate.mjs")));
  const other = JSON.stringify(hooks.PreToolUse);
  assert.doesNotMatch(other, /handoff/, "no per-tool-call handoff hook");
});

test("the reminder resolves the repository root from a subdirectory and enforces sane bands", () => {
  const cwd = workspace(100_000);
  execFileSync("git", ["init", "-q"], { cwd });
  const sub = join(cwd, "src", "deep");
  mkdirSync(sub, { recursive: true });
  const path = transcript(cwd, [usageEntry(110_000)]);
  assert.ok(evaluateReminder({ cwd: sub, transcript_path: path, session_id: "s1" }, { env: noEnv }), "adapter found from a subdirectory");
  assert.equal(existsSync(join(sub, ".claude")), false, "no marker written in the subdirectory");
  assert.ok(existsSync(join(cwd, ".claude/asterweave/handoffs/.gitignore")), "marker directory is ignored");

  const tiny = workspace();
  const small = transcript(tiny, [usageEntry(5_000)]);
  assert.equal(evaluateReminder({ cwd: tiny, transcript_path: small, session_id: "s" }, { env: { ASTERWEAVE_HANDOFF_WARN_TOKENS: "10" } }), null, "thresholds below 1000 are ignored");
  const floor = workspace();
  let grown = transcript(floor, [usageEntry(2_000)]);
  assert.ok(evaluateReminder({ cwd: floor, transcript_path: grown, session_id: "s" }, { env: { ASTERWEAVE_HANDOFF_WARN_TOKENS: "1000" } }));
  grown = transcript(floor, [usageEntry(6_000)]);
  assert.equal(evaluateReminder({ cwd: floor, transcript_path: grown, session_id: "s" }, { env: { ASTERWEAVE_HANDOFF_WARN_TOKENS: "1000" } }), null, "bands are at least 10k tokens apart");
});

test("a zero-usage entry is skipped instead of hiding the real latest usage", () => {
  const cwd = workspace();
  const path = transcript(cwd, [usageEntry(70_000), { type: "assistant", message: { usage: { input_tokens: 0, output_tokens: 0 } } }]);
  assert.equal(latestContextTokens(path), 70_110);
});
