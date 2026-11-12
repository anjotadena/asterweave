// M2 idle / cold resume: gap classification across restarts and skew, bounded workspace validation against a real git fixture,
// invalidated completion claims, new topics, restart + model switch.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { latestValidCheckpoint } from "../src/runtime/memory/checkpoints.mjs";
import { proposeItem, confirmItem } from "../src/runtime/memory/items.mjs";
import { createMemoryPipeline } from "../src/runtime/memory/pipeline.mjs";
import { classifyGap, isNewTopic, validateCheckpoint } from "../src/runtime/memory/resume.mjs";
import { probeWorkspace } from "../src/runtime/memory/workspace.mjs";
import { cleanupAll, git, tempDir, world } from "./memory-fixture.mjs";

after(cleanupAll);

const SETTINGS = { historyRetentionDays: 30, summaryRetentionDays: 30, idleRefreshMinutes: 15, coldResumeMinutes: 60 };
const MIN = 60_000;

function repo() {
  const dir = tempDir("aw-mres-repo-");
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
  return dir;
}

const run = (status = "paused", node = "implement") => ({
  runId: "r1", goal: "Add caching to the registry lookup", status, currentNode: node, approvals: [],
  nodes: { intake: { status: "passed", attemptLog: [{ evidence: [{ kind: "task", result: "pass" }] }], failureSignatures: [] }, implement: { status: "pending", attemptLog: [], failureSignatures: [] } },
});

const open = (w, dir, extra = {}) => createMemoryPipeline({
  settings: SETTINGS, storeOptions: { userDir: w.userDir, now: w.now }, repo: { cloneKey: "/clone/widgets", remote: "https://github.com/acme/widgets.git" },
  runId: extra.runId ?? "r1", goal: extra.goal ?? "Add caching to the registry lookup", run: extra.run ?? run(), workspace: dir, owner: w.owner,
  externalSessionId: extra.externalSessionId ?? "file-session-1", model: extra.model ?? "claude-sonnet-5-5", providerContextLost: extra.providerContextLost ?? false,
});

test("gap classification: continue / refresh / cold, UTC across restarts, future timestamps treated as cold", () => {
  const base = { idleRefreshMinutes: 15, coldResumeMinutes: 60 };
  const at = (minutes) => new Date(Date.parse("2026-11-11T10:00:00Z") + minutes * MIN).toISOString();
  assert.equal(classifyGap({ ...base, lastActivityAt: null, now: at(0) }).mode, "new");
  assert.equal(classifyGap({ ...base, lastActivityAt: at(0), now: at(5) }).mode, "continue");
  assert.equal(classifyGap({ ...base, lastActivityAt: at(0), now: at(20) }).mode, "refresh");
  assert.equal(classifyGap({ ...base, lastActivityAt: at(0), now: at(61) }).mode, "cold");
  assert.equal(classifyGap({ ...base, lastActivityAt: "2026-11-11T18:00:00+08:00", now: "2026-11-11T10:05:00Z" }).mode, "continue", "offsets compare as UTC instants");
  const skew = classifyGap({ ...base, lastActivityAt: at(30), now: at(0) });
  assert.equal(skew.mode, "cold");
  assert.match(skew.reasons.join(), /future/);
  assert.equal(classifyGap({ ...base, lastActivityAt: at(0), now: at(1), modelChanged: true }).mode, "cold");
  assert.equal(classifyGap({ ...base, lastActivityAt: at(0), now: at(1), providerContextLost: true }).mode, "cold");
});

test("61-minute gap, unchanged workspace: rebuild, validate and continue from the next action with an evidence-backed note", async () => {
  const w = world();
  const dir = repo();
  const first = await open(w, dir);
  first.onCommitted(run(), [{ type: "node.completed", node: "intake" }]);
  await first.finish({ run: run() });
  first.close();
  w.now.advance(61 * MIN);
  const second = await open(w, dir, { runId: "r2", goal: "Continue adding caching to the registry lookup" });
  const resume = second.resume;
  assert.equal(resume.mode, "cold");
  assert.equal(resume.invalidated, false);
  const head = (await probeWorkspace(dir)).head;
  assert.equal(resume.note, `intake (evidence: task pass) is complete. Next: Resume the run at implement.; checked branch main at HEAD ${head.slice(0, 7)}.`);
  const section = second.context({ node: "intake", attempt: 1 }, { objective: "Understand the goal" }, { freshProviderSession: true });
  assert.match(section, /Resume note: intake/);
  assert.match(section, /checkpoint, as recorded/);
  second.close();
});

test("61-minute gap with a changed HEAD and changed files: completion claims are invalidated in the section and the checkpoint", async () => {
  const w = world();
  const dir = repo();
  const first = await open(w, dir);
  await first.finish({ run: run() });
  first.close();
  writeFileSync(join(dir, "README.md"), "changed\n");
  git(dir, "commit", "-am", "someone else moved HEAD");
  writeFileSync(join(dir, "new.txt"), "untracked\n");
  w.now.advance(61 * MIN);
  const second = await open(w, dir, { runId: "r2", goal: "Continue adding caching to the registry lookup" });
  assert.equal(second.resume.invalidated, true);
  assert.ok(second.resume.changes.some((change) => change.startsWith("HEAD")));
  assert.ok(second.resume.changes.includes("changed files differ"));
  const section = second.context({ node: "intake", attempt: 1 }, { objective: "x" }, { freshProviderSession: true });
  assert.match(section, /UNVERIFIED: the workspace changed/);
  assert.match(section, /must be re-verified|re-checked/);
  const prior = latestValidCheckpoint(w.mem, "ms_run_r1").checkpoint;
  assert.match(prior.completedWork, /^\[UNVERIFIED/);
  assert.equal(prior.generationMeta.invalidated, true);
  second.close();
});

test("validation is bounded and conservative: an unverifiable workspace invalidates; another worktree is a change", () => {
  const cp = { branch: "main", headCommit: "a".repeat(40), changedFilesFingerprint: "fp1:x", worktreeId: "wt_1", runningRefs: { status: "paused" } };
  assert.deepEqual(validateCheckpoint(cp, { verifiable: false }).unchanged, false);
  const moved = validateCheckpoint(cp, { verifiable: true, branch: "main", head: "a".repeat(40), fingerprint: "fp1:x", worktreeId: "wt_2" }, { runStatus: "completed" });
  assert.deepEqual(moved.changes, ["another worktree", "run status paused -> completed"]);
});

test("a changed topic is a new intent: the old task is not resumed, decisions still apply", async () => {
  const w = world();
  const dir = repo();
  const decision = proposeItem(w.mem, { owner: w.owner, repoId: w.repoId, scope: "repository", kind: "decision", origin: "user_decision", content: "Use structured logging for every service" }, SETTINGS).item;
  confirmItem(w.mem, decision.id, w.owner, { explicit: true });
  const first = await open(w, dir);
  await first.finish({ run: run() });
  first.close();
  w.now.advance(90 * MIN);
  assert.equal(isNewTopic("Write the release notes for the logging service", { goal: "Add caching to the registry lookup", nextAction: "Resume the run at implement." }), true);
  const second = await open(w, dir, { runId: "r2", goal: "Write the release notes for the structured logging service" });
  assert.equal(second.resume.newTopic, true);
  assert.equal(second.resume.note, null);
  const section = second.context({ node: "intake", attempt: 1 }, { objective: "Understand the goal" }, { freshProviderSession: true });
  assert.ok(!section.includes("registry lookup"), "the old task state is not forced on the new request");
  assert.match(section, /structured logging/);
  second.close();
});

test("restart plus a model switch: cold rebuild that still carries the authorised memory", async () => {
  const w = world();
  const dir = repo();
  const decision = proposeItem(w.mem, { owner: w.owner, repoId: w.repoId, scope: "repository", kind: "decision", origin: "user_decision", content: "Registry cache entries expire after five minutes" }, SETTINGS).item;
  confirmItem(w.mem, decision.id, w.owner, { explicit: true });
  const first = await open(w, dir, { model: "model-a" });
  await first.finish({ run: run() });
  first.close();
  w.now.advance(2 * MIN); // short gap, but the model changed
  const second = await open(w, dir, { runId: "r2", goal: "Continue adding the registry cache", model: "model-b" });
  assert.equal(second.resume.mode, "cold");
  assert.match(second.resume.reasons.join(), /model changed/);
  const section = second.context({ node: "intake", attempt: 1 }, { objective: "x" }, { freshProviderSession: true, model: "model-b" });
  assert.match(section, /five minutes/);
  assert.match(section, new RegExp(decision.id));
  second.close();
});
