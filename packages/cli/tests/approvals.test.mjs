// Approvals: who may grant, when an approval counts, and what invalidates it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import {
  applyApprovalEvent,
  approvalSubject,
  artifactSubject,
  dependentArtifacts,
  findApproval,
  grantApproval,
  invalidateApproval,
  invalidateDependents,
  isValid,
  matchesSubject,
  pendingApprovals,
  requestApproval,
  scopeHash,
  validScopedApprovals,
} from "../src/runtime/approvals.mjs";

const NOW = "2026-01-01T00:00:00.000Z";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const POLICY = sha("policy-1");

function baseRun(extra = {}) {
  return {
    runId: "r1",
    policyHash: POLICY,
    artifacts: { plan: { hash: sha("plan-1"), revision: 1, dependsOn: [] } },
    approvals: [],
    ...extra,
  };
}

const planRequest = (run) => requestApproval(run, { kind: "plan", scope: { operation: "plan", target: "approve" }, artifact: "plan", now: NOW });
const opRequest = (run, target = "{}") => requestApproval(run, { kind: "operation", scope: { operation: "merge", target }, now: NOW });
const tty = { source: "tty", name: "Anjo" };

test("a plan request binds the artifact hash and revision; an operation request binds the scope hash", () => {
  const plan = planRequest(baseRun());
  assert.equal(plan.created, true);
  assert.equal(plan.approval.id, "ap-1");
  assert.equal(plan.approval.subjectHash, sha("plan-1"));
  assert.equal(plan.approval.revision, 1);
  assert.equal(plan.approval.policyHash, POLICY);
  assert.deepEqual([plan.approval.by, plan.approval.grantedAt, plan.approval.invalidatedAt], [null, null, null]);
  assert.deepEqual(plan.events.map((event) => event.type), ["approval.requested"]);
  assert.equal(plan.run.approvals.length, 1);

  const op = opRequest(baseRun(), '{"branch":"x"}');
  // The expected value is computed independently of scopeHash: sha256 of the canonical JSON (sorted keys) of the scope.
  assert.equal(op.approval.subjectHash, sha('{"operation":"merge","target":"{\\"branch\\":\\"x\\"}"}'));
  assert.equal(scopeHash({ operation: "merge", target: '{"branch":"x"}' }), op.approval.subjectHash);
  assert.equal(op.approval.artifact, null);
  assert.equal(approvalSubject(op.approval), op.approval.subjectHash);
});

test("requests are idempotent while open and do not touch the input run", () => {
  const run = baseRun();
  const first = opRequest(run);
  assert.deepEqual(run.approvals, [], "pure: the input run is unchanged");
  const second = opRequest(first.run);
  assert.equal(second.created, false);
  assert.deepEqual(second.events, []);
  assert.equal(second.approval.id, first.approval.id);
  assert.equal(opRequest(first.run, '{"other":1}').created, true, "a different scope is a different request");
});

test("a plan approval needs the artifact to exist; bad requests are usage errors", () => {
  assert.throws(() => planRequest(baseRun({ artifacts: {} })), (error) => error.code === "APPROVAL_NO_SUBJECT");
  assert.throws(() => requestApproval(baseRun(), { kind: "other", scope: { operation: "x", target: "y" }, now: NOW }), (error) => error.code === "APPROVAL_KIND_INVALID" && error.exitCode === EXIT.USAGE);
  assert.throws(() => requestApproval(baseRun(), { kind: "operation", scope: { operation: "", target: "y" }, now: NOW }), (error) => error.code === "APPROVAL_SCOPE_INVALID");
  assert.throws(() => requestApproval(baseRun(), { kind: "operation", scope: { operation: "x", target: "y" } }), (error) => error.code === "APPROVAL_TIME_REQUIRED");
});

test("only a terminal prompt or an explicit flag can be the source of a grant", () => {
  const { run } = opRequest(baseRun());
  const subject = run.approvals[0].subjectHash.slice(0, 8);
  for (const source of ["model", "repo", "mcp", "image", "env", "", undefined, null]) {
    assert.throws(() => grantApproval(run, "ap-1", { by: { source, name: "x" }, now: NOW, env: {}, subject }), (error) => error.code === "APPROVAL_SOURCE_INVALID" && error.exitCode === EXIT.USAGE, String(source));
  }
  assert.throws(() => grantApproval(run, "ap-1", { by: "tty", now: NOW, env: {} }), (error) => error.code === "APPROVAL_SOURCE_INVALID");
  assert.throws(() => grantApproval(run, "ap-1", { by: { source: "tty", name: "  " }, now: NOW, env: {} }), (error) => error.code === "APPROVAL_NAME_REQUIRED");

  const viaTty = grantApproval(run, "ap-1", { by: tty, now: NOW, env: {} });
  assert.deepEqual(viaTty.approval.by, tty);
  assert.equal(viaTty.approval.grantedAt, NOW);
  assert.deepEqual(viaTty.events.map((event) => event.type), ["approval.granted"]);
  assert.equal(run.approvals[0].grantedAt, null, "pure");

  const viaFlag = grantApproval(run, "ap-1", { by: { source: "flag", name: "ci-owner" }, now: NOW, env: {}, subject });
  assert.equal(viaFlag.approval.by.source, "flag");
});

test("a grant is refused inside a run (ASTERWEAVE_RUN_ID), whatever the source", () => {
  const { run } = opRequest(baseRun());
  for (const by of [tty, { source: "flag", name: "x" }]) {
    assert.throws(() => grantApproval(run, "ap-1", { by, now: NOW, env: { ASTERWEAVE_RUN_ID: "r1" }, subject: run.approvals[0].subjectHash }), (error) => error.code === "APPROVAL_FORBIDDEN_CONTEXT");
  }
  assert.ok(grantApproval(run, "ap-1", { by: tty, now: NOW, env: { ASTERWEAVE_RUN_ID: "" } }), "an empty value is not 'inside a run'");
});

test("a flag grant must quote the subject hash shown by run show", () => {
  const { run } = opRequest(baseRun());
  const subject = run.approvals[0].subjectHash;
  const flag = { source: "flag", name: "me" };
  for (const bad of [undefined, "", "abc", subject.slice(0, 5), "zzzzzzzz", `${subject.slice(0, 7)}0`.replace(/.$/, subject[7] === "0" ? "1" : "0"), sha("other").slice(0, 12)]) {
    assert.throws(() => grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: bad }), (error) => error.code === "APPROVAL_SUBJECT_MISMATCH", String(bad));
  }
  assert.ok(grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: subject.slice(0, 6) }));
  assert.ok(grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: subject.slice(0, 20).toUpperCase() }), "case does not matter");
  assert.equal(matchesSubject(run.approvals[0], subject.slice(0, 5)), false, "at least 6 characters");
  assert.equal(matchesSubject(run.approvals[0], subject), true);
  assert.equal(matchesSubject(run.approvals[0], 42), false);
});

test("grants of unknown, already granted, invalidated, or stale approvals are refused", () => {
  const { run } = planRequest(baseRun());
  assert.throws(() => grantApproval(run, "ap-9", { by: tty, now: NOW, env: {} }), (error) => error.code === "APPROVAL_NOT_FOUND");
  const granted = grantApproval(run, "ap-1", { by: tty, now: NOW, env: {} }).run;
  assert.throws(() => grantApproval(granted, "ap-1", { by: tty, now: NOW, env: {} }), (error) => error.code === "APPROVAL_ALREADY_GRANTED");

  const moved = { ...run, artifacts: { plan: { hash: sha("plan-2"), revision: 2, dependsOn: [] } } };
  assert.throws(() => grantApproval(moved, "ap-1", { by: tty, now: NOW, env: {} }), (error) => error.code === "APPROVAL_STALE");
  const invalidated = invalidateDependents(moved, "plan", { now: NOW }).run;
  assert.throws(() => grantApproval(invalidated, "ap-1", { by: tty, now: NOW, env: {} }), (error) => error.code === "APPROVAL_INVALIDATED");
  assert.throws(() => grantApproval(run, "ap-1", { by: tty, now: NOW, env: {}, policyHash: sha("policy-2") }), (error) => error.code === "APPROVAL_STALE");
});

test("validity: granted, not invalidated, same policy, same artifact hash and revision", () => {
  const requested = planRequest(baseRun()).run;
  const approval = () => findApproval(grantedRun, "ap-1");
  assert.equal(isValid(requested, requested.approvals[0], POLICY), false, "not granted yet");
  assert.equal(isValid(requested, null, POLICY), false);
  const grantedRun = grantApproval(requested, "ap-1", { by: tty, now: NOW, env: {} }).run;
  assert.equal(isValid(grantedRun, approval(), POLICY), true);
  assert.equal(isValid(grantedRun, approval()), true, "the policy check is skipped when no hash is given");
  assert.equal(isValid(grantedRun, approval(), sha("policy-2")), false, "policy drift");

  const newRevision = { ...grantedRun, artifacts: { plan: { ...grantedRun.artifacts.plan, revision: 2 } } };
  assert.equal(isValid(newRevision, approval(), POLICY), false, "same hash, new revision");
  const newHash = { ...grantedRun, artifacts: { plan: { ...grantedRun.artifacts.plan, hash: sha("changed") } } };
  assert.equal(isValid(newHash, approval(), POLICY), false, "same revision, new hash");
  assert.equal(isValid({ ...grantedRun, artifacts: {} }, approval(), POLICY), false, "artifact gone");
  const invalidated = invalidateApproval(grantedRun, "ap-1", { now: NOW, cause: "test" });
  assert.equal(isValid(invalidated.run, findApproval(invalidated.run, "ap-1"), POLICY), false);
  assert.equal(invalidateApproval(invalidated.run, "ap-1", { now: NOW }).events.length, 0, "already invalidated");
});

test("an artifact without a content hash is identified by name and revision", () => {
  const run = baseRun({ artifacts: { plan: { hash: null, revision: 3, dependsOn: [] } } });
  const { approval } = planRequest(run);
  assert.equal(approval.subjectHash, sha("plan@3"));
  assert.equal(artifactSubject("plan", run.artifacts.plan), sha("plan@3"));
});

test("operation approvals are scoped: validScopedApprovals lists only valid operation approvals", () => {
  let run = baseRun();
  run = opRequest(run, "A").run;
  run = opRequest(run, "B").run;
  run = planRequest(run).run;
  run = grantApproval(run, "ap-1", { by: tty, now: NOW, env: {} }).run;
  run = grantApproval(run, "ap-3", { by: tty, now: NOW, env: {} }).run;
  assert.deepEqual(validScopedApprovals(run, POLICY).map((entry) => entry.scope.target), ["A"]);
  assert.deepEqual(validScopedApprovals(run, sha("other")), []);
  assert.deepEqual(pendingApprovals(run).map((approval) => approval.id), ["ap-2"]);
});

test("invalidation is transitive through artifact dependencies and leaves unrelated approvals alone", () => {
  let run = baseRun({
    artifacts: {
      plan: { hash: sha("p"), revision: 2, dependsOn: [] },
      design: { hash: sha("d"), revision: 1, dependsOn: ["plan"] },
      tests: { hash: sha("t"), revision: 1, dependsOn: ["design"] },
      docs: { hash: sha("x"), revision: 1, dependsOn: [] },
    },
  });
  const ask = (artifact) => {
    const result = requestApproval(run, { kind: "plan", scope: { operation: "plan", target: artifact }, artifact, now: NOW });
    run = grantApproval(result.run, result.approval.id, { by: tty, now: NOW, env: {} }).run;
    return result.approval.id;
  };
  const [planId, designId, testsId, docsId] = ["plan", "design", "tests", "docs"].map(ask);
  run = requestApproval(run, { kind: "operation", scope: { operation: "merge", target: "m" }, now: NOW }).run;

  assert.deepEqual([...dependentArtifacts(run, "plan")].sort(), ["design", "plan", "tests"]);
  const result = invalidateDependents(run, "plan", { now: "2026-02-02T00:00:00.000Z" });
  assert.deepEqual(result.events.map((event) => event.approvalId), [planId, designId, testsId]);
  assert.ok(result.events.every((event) => event.type === "approval.invalidated" && event.invalidatedAt === "2026-02-02T00:00:00.000Z" && event.cause.includes("plan")));
  for (const id of [planId, designId, testsId]) assert.equal(findApproval(result.run, id).invalidatedAt, "2026-02-02T00:00:00.000Z");
  assert.equal(findApproval(result.run, docsId).invalidatedAt, null);
  assert.equal(findApproval(result.run, "ap-5").invalidatedAt, null, "operation approvals have no artifact");
  assert.equal(invalidateDependents(result.run, "plan", { now: NOW }).events.length, 0, "idempotent");
  assert.equal(invalidateDependents(run, "tests", { now: NOW }).events.length, 1, "only its own approval: nothing depends on tests");
  assert.throws(() => invalidateDependents(run, "plan", {}), (error) => error.code === "APPROVAL_TIME_REQUIRED");
});

test("applying the recorded events reproduces the result (this is what crash recovery relies on)", () => {
  const requested = opRequest(baseRun());
  let rebuilt = applyApprovalEvent(baseRun(), requested.events[0]);
  assert.deepEqual(rebuilt.approvals, requested.run.approvals);
  const granted = grantApproval(requested.run, "ap-1", { by: tty, now: NOW, env: {} });
  rebuilt = applyApprovalEvent(rebuilt, granted.events[0]);
  assert.deepEqual(rebuilt.approvals, granted.run.approvals);
  const invalidated = invalidateApproval(granted.run, "ap-1", { now: NOW, cause: "x" });
  rebuilt = applyApprovalEvent(rebuilt, invalidated.events[0]);
  assert.deepEqual(rebuilt.approvals, invalidated.run.approvals);
  assert.equal(applyApprovalEvent(rebuilt, requested.events[0]).approvals.length, 1, "replaying a request twice adds nothing");
  assert.equal(applyApprovalEvent(rebuilt, { type: "approval.granted", approvalId: "ap-1", by: { source: "tty", name: "later" }, grantedAt: "later" }).approvals[0].by.name, "Anjo", "a grant is final");
});

test("the granting name is redacted and terminal-safe", () => {
  const { run } = opRequest(baseRun());
  const result = grantApproval(run, "ap-1", { by: { source: "tty", name: "Anjo \u001b[31mghp" + "_0123456789abcdefghijklmnopqrstuvwxyzAB" }, now: NOW, env: {} });
  assert.equal(result.approval.by.name.includes("ghp_0123456789"), false);
  assert.equal(result.approval.by.name.includes("\u001b"), false);
});
