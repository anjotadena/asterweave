// ClaudeExecutor unit tests with an injected runTurn (no process): provider-session reuse per model, reply parsing.

import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeExecutor, finalBlocks } from "../src/runtime/claude/executor.mjs";
import { deliveryGraph } from "./loop-fixture.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

test.after(cleanupTemp);

const SID = "abcd1234-ef56-4789-8abc-def012345678";
const OK = (extra = {}) => ({ ok: true, providerSessionId: SID, model: "claude-sonnet-5-5", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null }, toolEvents: [], resultText: "```json\n{\"v\":1,\"type\":\"wait\",\"ms\":0}\n```", costUsd: null, error: null, exitCode: 0, killed: false, malformedLines: 0, ...extra });
const ctx = { runId: "r1", goal: "g", node: "intake", attempt: 1, step: 0, feedback: null, signal: undefined };

function executor(options = {}) {
  const calls = [];
  const exec = createClaudeExecutor({ graph: deliveryGraph, cwd: process.cwd(), runId: "r1", runDir: options.runDir, configDir: "/cfg", routing: { default: "claude-sonnet-5-5", effort: null, fallback: [], stages: {} }, runTurn: async (turn) => { calls.push(turn); return OK(); }, ...options });
  return { exec, calls };
}

test("a provider session is resumed only under the model it was created with; another model starts afresh", async () => {
  const same = executor({ providerSessionId: SID, providerSessionModel: "claude-sonnet-5-5", claude: { claudeVersion: "2.1.5" }, runDir: tempDir("aw-cx-run-") });
  await same.exec.decide(ctx, await same.exec.observe(ctx));
  assert.equal(same.calls[0].resume, SID);
  assert.equal(same.calls[0].sessionId, undefined);

  const different = executor({ providerSessionId: SID, providerSessionModel: "claude-haiku-5-5", claude: { claudeVersion: "2.1.5" }, runDir: tempDir("aw-cx-run-") });
  await different.exec.decide(ctx, await different.exec.observe(ctx));
  assert.equal(different.calls[0].resume, undefined, "no resume across models");
  assert.match(different.calls[0].sessionId, /^[0-9a-f-]{36}$/);
  const events = different.exec.drainEvents();
  assert.equal(events.find((event) => event.type === "provider.session").routeModel, "claude-sonnet-5-5");

  const unknown = executor({ providerSessionId: SID, claude: { claudeVersion: "2.1.5" }, runDir: tempDir("aw-cx-run-") });
  await unknown.exec.decide(ctx, await unknown.exec.observe(ctx));
  assert.equal(unknown.calls[0].resume, SID, "an old record without a model keeps resuming");
});

test("finalBlocks: only the trailing group of fenced blocks counts", () => {
  const fence = "```";
  const text = `Example: ${fence}json\n{"v":1,"type":"complete","outcome":"pass"}\n${fence}\nthen prose\n\n${fence}json\n{"a":1}\n${fence}\n\n${fence}json\n{"b":2}\n${fence}\n`;
  assert.deepEqual(finalBlocks(text), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(finalBlocks("no blocks"), []);
});
