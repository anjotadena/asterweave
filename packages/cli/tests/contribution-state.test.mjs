// Per-run contribution state: recorded scope, findings, the remote-write journal and the task claim.

import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import {
  addFinding, authorizes, beginRemoteWrite, claimTask, describeContribution, initContribution, loadContribution, markRemoteUncertain,
  reconcileRemoteWrite, recordRemoteWrite, releaseTask, selectTask, setFindingStatus, validateFinding,
} from "../src/runtime/contribution.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const newRun = (extra = {}) => {
  const dir = tempDir("aw-contrib-run-");
  initContribution(dir, { skill: "contribute", workflow: "contribute", objective: "fix the thing", level: "implement", ...extra });
  return dir;
};
const finding = (extra = {}) => ({ title: "Search resets", category: "functionality", location: "src/nav.mjs:17", expected: "search kept", observed: "search cleared", impact: "users lose their query", severity: "medium", severityRationale: "no data loss, repeated annoyance", confidence: "high", ownership: "repository-code", ...extra });

test("the scope is recorded once; a second init (resume) never widens it", () => {
  const dir = newRun();
  const again = initContribution(dir, { skill: "contribute", workflow: "contribute", objective: "something else", level: "publish", grants: [{ operation: "open-pr", target: "acme/widgets" }] });
  assert.equal(again.scope.level, "implement");
  assert.equal(loadContribution(dir).scope.grants.length, 0);
  assert.throws(() => initContribution(tempDir("aw-c-"), { skill: "x", workflow: "x", objective: "x", level: "root" }), /Unknown scope/);
  assert.throws(() => initContribution(tempDir("aw-c-"), { skill: "x", workflow: "x", objective: "x", level: "implement", grants: [{ operation: "open-pr", target: "a/b" }] }), /publish scope/);
  assert.throws(() => initContribution(tempDir("aw-c-"), { skill: "x", workflow: "x", objective: "x", level: "publish", grants: [{ operation: "merge", target: "a/b" }] }), /known operation/);
});

test("authorization: only publish with an exact operation and target allows a remote write; merge and deploy never", () => {
  const state = (level, grants = []) => ({ scope: { level, grants } });
  assert.equal(authorizes(state("discovery"), "open-pr", "a/b").allowed, false);
  assert.equal(authorizes(state("implement"), "push-branch", "a/b").allowed, false);
  const publish = state("publish", [{ operation: "open-pr", target: "a/b" }]);
  assert.equal(authorizes(publish, "open-pr", "a/b").allowed, true);
  assert.equal(authorizes(publish, "open-pr", "a/other").allowed, false, "another target");
  assert.equal(authorizes(publish, "push-branch", "a/b").allowed, false, "another operation");
  for (const operation of ["merge", "deploy", "force-push", "delete-branch"]) assert.equal(authorizes(publish, operation, "a/b").allowed, false);
});

test("remote writes: refused without a grant; recorded id prevents a duplicate; an uncertain write must be reconciled", () => {
  const denied = newRun();
  assert.throws(() => beginRemoteWrite(denied, { runId: "r1", operation: "open-pr", target: "acme/widgets" }), (error) => error.code === "REMOTE_NOT_AUTHORIZED");

  const dir = newRun({ level: "publish", grants: [{ operation: "open-pr", target: "acme/widgets" }] });
  const call = { runId: "r1", operation: "open-pr", target: "acme/widgets" };
  const first = beginRemoteWrite(dir, call);
  assert.equal(first.action, "proceed");

  // the process dies / the response is lost: nothing may be written again until the remote is checked
  assert.equal(beginRemoteWrite(dir, call).action, "reconcile");
  markRemoteUncertain(dir, first.key);
  assert.equal(beginRemoteWrite(dir, call).action, "reconcile");

  // the lookup finds the PR the lost response had created: it is recorded, never created twice
  reconcileRemoteWrite(dir, first.key, "PR#17");
  const after = beginRemoteWrite(dir, call);
  assert.deepEqual([after.action, after.id], ["duplicate", "PR#17"]);

  // a different target has its own key
  assert.throws(() => beginRemoteWrite(dir, { ...call, target: "acme/other" }), (error) => error.code === "REMOTE_NOT_AUTHORIZED");
});

test("remote writes: a lookup that finds nothing releases the key for exactly one retry; the id is stored the moment it exists", () => {
  const dir = newRun({ level: "publish", grants: [{ operation: "create-issue", target: "acme/widgets" }] });
  const call = { runId: "r2", operation: "create-issue", target: "acme/widgets" };
  const first = beginRemoteWrite(dir, call);
  markRemoteUncertain(dir, first.key);
  reconcileRemoteWrite(dir, first.key, null);
  const retry = beginRemoteWrite(dir, call);
  assert.equal(retry.action, "proceed");
  assert.equal(loadContribution(dir).remote[retry.key].attempts, 2);
  recordRemoteWrite(dir, retry.key, "issue#9");
  assert.equal(loadContribution(dir).remote[retry.key].id, "issue#9");
  assert.equal(beginRemoteWrite(dir, call).action, "duplicate");
});

test("findings: scanner output starts suspected; reproduced needs steps; verified needs evidence; no silent downgrade; ids are stable", () => {
  const dir = newRun();
  const first = addFinding(dir, finding({ status: "verified", source: "scanner" }));
  assert.equal(first.id, "F-1");
  assert.equal(first.status, "suspected", "a caller cannot record a finding as verified");
  assert.match(String(validateFinding(finding({ status: "reproduced" }))), /reproduction steps/);
  assert.throws(() => addFinding(dir, { title: "no evidence" }), /Invalid finding/);
  assert.throws(() => addFinding(dir, finding({ severity: "catastrophic" })), /severity/);

  setFindingStatus(dir, "F-1", "reproduced", { reproduction: ["open a project", "go back"] });
  assert.throws(() => setFindingStatus(dir, "F-1", "verified"), /evidence/);
  setFindingStatus(dir, "F-1", "fixed-locally");
  setFindingStatus(dir, "F-1", "verified", { evidence: ["test/search-restore.test.mjs passed"] });
  assert.throws(() => setFindingStatus(dir, "F-1", "suspected"), /cannot go back/);
  assert.equal(setFindingStatus(dir, "F-1", "blocked").status, "blocked");
  assert.equal(addFinding(dir, finding({ title: "second" })).id, "F-2");
});

test("a task needs acceptance criteria before implementation", () => {
  const dir = newRun();
  assert.throws(() => selectTask(dir, { title: "x", acceptance: [] }), /acceptance criteria/);
  assert.equal(selectTask(dir, { title: "Keep search on back", acceptance: ["search kept"], reproduction: ["open", "back"] }).title, "Keep search on back");
});

test("task claim: one run per task; the same run resumes its claim; release frees it", () => {
  const options = { env: { ASTERWEAVE_CONFIG_DIR: tempDir("aw-claims-") } };
  const key = process.platform === "win32" ? "c:\\work\\repo\\.git" : "/work/repo/.git";
  const a = claimTask(key, "issue-42", "run-a", options);
  assert.equal(a.claimed, true);
  assert.deepEqual([claimTask(key, "issue-42", "run-b", options).claimed, claimTask(key, "issue-42", "run-b", options).holder], [false, "run-a"]);
  assert.equal(claimTask(key, "issue-42", "run-a", options).resumed, true);
  assert.equal(claimTask(key, "issue-43", "run-b", options).claimed, true, "another task is independent");
  assert.equal(releaseTask(a.file, "run-b"), false, "only the holder releases");
  assert.equal(releaseTask(a.file, "run-a"), true);
  assert.equal(claimTask(key, "issue-42", "run-b", options).claimed, true);
});

test("the monitor view is derived from the graph state and the recorded facts, with next action and blockers", () => {
  const dir = newRun();
  addFinding(dir, finding());
  const state = loadContribution(dir);
  const nodes = { discover: { status: "passed" }, audit: { status: "passed" }, triage: { status: "active" } };
  const active = describeContribution(state, { status: "active", currentNode: "triage", nodes, runId: "r" });
  assert.deepEqual([active.stage, active.stagesPassed, active.findings.total, active.findings.suspected, active.blocked], ["triage", "2/3", 1, 1, false]);
  assert.equal(active.task, null);
  const blocked = describeContribution(state, { status: "blocked", currentNode: "test-verify", nodes: { "test-verify": { status: "blocked" } }, runId: "r" });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.next, /resolve the blocker at test-verify/);
  assert.deepEqual(blocked.verification, [{ stage: "test-verify", status: "blocked" }]);
  const done = describeContribution(initContribution(tempDir("aw-c-"), { skill: "repo-audit", workflow: "audit", objective: "o", level: "discovery" }), { status: "completed", currentNode: null, nodes: {}, runId: "r" });
  assert.match(done.next, /decide which work to authorize/);
});

test("a corrupt contribution record is an error, not an empty state", () => {
  const dir = tempDir("aw-c-");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "contribution.json"), JSON.stringify({ v: 1, scope: { level: "root" } }));
  assert.throws(() => loadContribution(dir), (error) => error.code === "CONTRIBUTION_CORRUPT");
  assert.equal(loadContribution(tempDir("aw-c-")), null);
  assert.ok(readFileSync(join(dir, "contribution.json"), "utf8").includes("root"), "the corrupt file is left for the user to inspect");
});
