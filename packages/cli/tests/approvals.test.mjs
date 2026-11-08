// Approvals: who may grant, when an approval counts, and what invalidates it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import {
  LOCK_MS,
  MAX_FAILED_ATTEMPTS,
  NONCE_TTL_MS,
  agentContextMarker,
  applyApprovalEvent,
  failedAttemptEvent,
  generateNonce,
  nonceHashOf,
  normalizeNonce,
  reissueNonce,
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
const opRequest = (run, target = "{}", extra = {}) => requestApproval(run, { kind: "operation", scope: { operation: "merge", target }, now: NOW, rng: rngOf(0xab), ...extra });
const tty = { source: "tty", name: "Anjo" };
// A deterministic nonce source: the nonce a request gets is known to the test (and only to it).
const rngOf = (byte) => () => Buffer.alloc(16, byte);
const NONCE = generateNonce(rngOf(0xab));
const nonceRun = (extra) => opRequest(baseRun(), "{}", extra);

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

  const viaFlag = grantApproval(run, "ap-1", { by: { source: "flag", name: "ci-owner" }, now: NOW, env: {}, subject, nonce: NONCE });
  assert.equal(viaFlag.approval.by.source, "flag");
});

test("a grant is refused inside a run (ASTERWEAVE_RUN_ID), whatever the source", () => {
  const { run } = opRequest(baseRun());
  for (const by of [tty, { source: "flag", name: "x" }]) {
    assert.throws(() => grantApproval(run, "ap-1", { by, now: NOW, env: { ASTERWEAVE_RUN_ID: "r1" }, subject: run.approvals[0].subjectHash }), (error) => error.code === "APPROVAL_FORBIDDEN_CONTEXT" && error.exitCode === EXIT.POLICY_DENIED);
  }
  assert.ok(grantApproval(run, "ap-1", { by: tty, now: NOW, env: { ASTERWEAVE_RUN_ID: "" } }), "an empty value is not 'inside a run'");
});

test("a flag grant must quote the subject hash shown by run show", () => {
  const { run } = opRequest(baseRun());
  const subject = run.approvals[0].subjectHash;
  const flag = { source: "flag", name: "me" };
  for (const bad of [undefined, "", "abc", subject.slice(0, 5), "zzzzzzzz", `${subject.slice(0, 7)}0`.replace(/.$/, subject[7] === "0" ? "1" : "0"), sha("other").slice(0, 12)]) {
    assert.throws(() => grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: bad, nonce: NONCE }), (error) => error.code === "APPROVAL_SUBJECT_MISMATCH", String(bad));
  }
  assert.ok(grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: subject.slice(0, 6), nonce: NONCE }));
  assert.ok(grantApproval(run, "ap-1", { by: flag, now: NOW, env: {}, subject: subject.slice(0, 20).toUpperCase(), nonce: NONCE }), "case does not matter");
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

// --- terminal-only approvals: the nonce model ------------------------------------------------------------

const flag = { source: "flag", name: "me" };
const viaFlag = (run, extra = {}, id = "ap-1") => grantApproval(run, id, { by: flag, now: NOW, env: {}, subject: run.approvals.find((a) => a.id === id).subjectHash, ...extra });
const code = (expected, exitCode) => (error) => error.code === expected && (exitCode === undefined || error.exitCode === exitCode);

test("a request stores only the hash of the nonce and returns the plaintext in memory once", () => {
  const made = nonceRun();
  assert.equal(made.nonce, NONCE);
  assert.match(NONCE, /^([0-9a-f]{8}-){3}[0-9a-f]{8}$/);
  assert.equal(made.approval.nonceHash, nonceHashOf(NONCE));
  assert.equal(made.approval.nonceHash, sha(NONCE.replaceAll("-", "")), "sha256 of the 32 hex characters");
  assert.equal(made.approval.nonceExpiresAt, new Date(Date.parse(NOW) + NONCE_TTL_MS).toISOString());
  assert.deepEqual([made.approval.failedAttempts, made.approval.lastFailedAt], [0, null]);
  const everything = JSON.stringify([made.run, made.events, made.approval]);
  assert.ok(!everything.includes(NONCE) && !everything.includes(NONCE.replaceAll("-", "")), "the plaintext is in no record");
  const again = opRequest(made.run);
  assert.equal(again.created, false);
  assert.equal(again.nonce, null, "an existing request does not reveal or re-issue anything");
  assert.notEqual(generateNonce(), generateNonce(), "the default source is random");
  assert.throws(() => generateNonce(() => Buffer.alloc(8)), TypeError);
});

test("nonce normalisation: dashes, spaces and case do not matter; garbage has no hash", () => {
  assert.equal(nonceHashOf(NONCE.toUpperCase()), nonceHashOf(NONCE));
  assert.equal(nonceHashOf(NONCE.replaceAll("-", " ")), nonceHashOf(NONCE));
  for (const bad of [undefined, null, 5, "", "abc", "g".repeat(32), NONCE + "0", "a".repeat(65)]) {
    assert.equal(normalizeNonce(bad), null, String(bad));
    assert.equal(nonceHashOf(bad), null);
  }
});

test("forged flags without a nonce, or with no nonce outstanding, fail with a terminal remediation (exit 2)", () => {
  const { run } = nonceRun();
  for (const missing of [undefined, null, ""]) {
    assert.throws(() => viaFlag(run, { nonce: missing }), (error) => code("APPROVAL_TERMINAL_REQUIRED", EXIT.USAGE)(error) && /terminal/.test(error.remediation));
  }
  // A request from before this model has no nonceHash: flags can never grant it, whatever they quote.
  const legacy = structuredClone(run);
  for (const key of ["nonceHash", "nonceExpiresAt", "failedAttempts", "lastFailedAt"]) delete legacy.approvals[0][key];
  assert.throws(() => viaFlag(legacy, { nonce: NONCE }), code("APPROVAL_TERMINAL_REQUIRED", EXIT.USAGE));
  assert.ok(grantApproval(legacy, "ap-1", { by: tty, now: NOW, env: {} }), "the terminal prompt still works for it");
  assert.equal(grantApproval(legacy, "ap-1", { by: tty, now: NOW, env: {} }).run.approvals[0].nonceHash, undefined);
});

test("a wrong nonce fails (exit 7) and is counted; five wrong tries lock the request for ten minutes", () => {
  let { run } = nonceRun();
  const wrong = generateNonce(rngOf(0x01));
  for (let i = 1; i <= MAX_FAILED_ATTEMPTS; i += 1) {
    assert.throws(() => viaFlag(run, { nonce: wrong }), code("APPROVAL_NONCE_INVALID", EXIT.POLICY_DENIED));
    run = applyApprovalEvent(run, failedAttemptEvent(run.approvals[0], NOW));
    assert.equal(run.approvals[0].failedAttempts, i);
  }
  // Locked: even the RIGHT nonce is refused, and the refusal is not itself a counted try.
  assert.throws(() => viaFlag(run, { nonce: NONCE }), code("APPROVAL_LOCKED", EXIT.POLICY_DENIED));
  const later = new Date(Date.parse(NOW) + LOCK_MS - 1000).toISOString();
  assert.throws(() => viaFlag(run, { nonce: NONCE, now: later }), code("APPROVAL_LOCKED"));
  const after = new Date(Date.parse(NOW) + LOCK_MS + 1000).toISOString();
  assert.ok(viaFlag(run, { nonce: NONCE, now: after }), "the lock ends after ten minutes");
  // The first wrong try after the lock expired starts counting again from one.
  assert.equal(applyApprovalEvent(run, failedAttemptEvent(run.approvals[0], after)).approvals[0].failedAttempts, 1);
  // The terminal prompt is never locked.
  assert.ok(grantApproval(run, "ap-1", { by: tty, now: NOW, env: {} }));
});

test("the wrong-try counter survives a re-issued nonce", () => {
  let { run } = nonceRun();
  run = applyApprovalEvent(run, failedAttemptEvent(run.approvals[0], NOW));
  const issued = reissueNonce(run, "ap-1", { now: NOW, rng: rngOf(0xcd) });
  assert.equal(issued.run.approvals[0].failedAttempts, 1);
  assert.equal(issued.events[0].type, "approval.nonce-issued");
  assert.ok(!JSON.stringify(issued.events).includes(issued.nonce));
  assert.throws(() => viaFlag(issued.run, { nonce: NONCE }), code("APPROVAL_NONCE_INVALID"), "the old nonce is dead");
  assert.ok(viaFlag(issued.run, { nonce: issued.nonce }));
});

test("a nonce is single use and expires", () => {
  const { run } = nonceRun();
  const granted = viaFlag(run, { nonce: NONCE });
  assert.equal(granted.approval.nonceHash, null, "consumed by the grant");
  assert.throws(() => viaFlag(granted.run, { nonce: NONCE }), code("APPROVAL_ALREADY_GRANTED"));
  // Folding the same grant record into a copy that never saw it also clears the hash (crash-recovery path).
  assert.equal(applyApprovalEvent(run, granted.events[0]).approvals[0].nonceHash, null);
  const stale = new Date(Date.parse(NOW) + NONCE_TTL_MS + 1).toISOString();
  assert.throws(() => viaFlag(run, { nonce: NONCE, now: stale }), code("APPROVAL_NONCE_EXPIRED"));
  assert.ok(grantApproval(run, "ap-1", { by: tty, now: stale, env: {} }), "an expired nonce does not stop the terminal prompt");
});

test("a failed attempt on one request does not touch another; unknown records change nothing", () => {
  let { run } = nonceRun();
  run = opRequest(run, '{"b":1}').run;
  const next = applyApprovalEvent(run, failedAttemptEvent(run.approvals[0], NOW));
  assert.deepEqual(next.approvals.map((a) => a.failedAttempts), [1, 0]);
  assert.deepEqual(applyApprovalEvent(run, { type: "approval.attempt-failed", approvalId: "ap-9", at: NOW }), run);
  assert.deepEqual(applyApprovalEvent(run, { type: "approval.nonce-issued", approvalId: "ap-1", nonceHash: "nothex" }), run, "a malformed hash is ignored");
});

test("agent markers refuse a grant of either source (exit 7), not only ASTERWEAVE_RUN_ID", () => {
  const { run } = nonceRun();
  const markers = [{ ASTERWEAVE_RUN_ID: "r" }, { ASTERWEAVE_SESSION_ID: "s" }, { CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }, { claude_code_x: "1" }];
  for (const env of markers) {
    assert.ok(agentContextMarker(env) !== null, JSON.stringify(env));
    assert.throws(() => grantApproval(run, "ap-1", { by: tty, now: NOW, env }), code("APPROVAL_FORBIDDEN_CONTEXT", EXIT.POLICY_DENIED));
    assert.throws(() => viaFlag(run, { env, nonce: NONCE }), code("APPROVAL_FORBIDDEN_CONTEXT", EXIT.POLICY_DENIED));
  }
  for (const env of [{}, { ASTERWEAVE_RUN_ID: "", CLAUDECODE: "" }, { CLAUDE_CONFIG_DIR: "x" }, { PATH: "x" }]) assert.equal(agentContextMarker(env), null, JSON.stringify(env));
});
