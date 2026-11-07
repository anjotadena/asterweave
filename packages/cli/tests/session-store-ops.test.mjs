// Session store: resume plan, clean plan and clean apply (real files in temp dirs, injected seams, no git, no network).

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { cleanApply, cleanPlan, resumeSession } from "../src/runtime/session-maint.mjs";
import { archiveSession, createSession, forkSession, listSessions, loadSession, repoSessionsDir, sessionDir } from "../src/runtime/sessions.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const REPO = "repo-ops";

function fixture() {
  const userDir = tempDir("aw-so-");
  const workspace = tempDir("aw-so-ws-");
  return { userDir, workspace, opts: { userDir } };
}
const make = (f, extra = {}) => createSession({ repoKey: REPO, workspace: f.workspace, branch: "main", title: "T", ...extra }, f.opts).session;
const day = 86_400_000;
const at = (offsetDays) => () => new Date(Date.UTC(2026, 5, 1) + offsetDays * day).toISOString();

const okSeams = (f) => ({ ...f.opts, identify: async () => REPO, currentBranch: async () => "main", runStatus: async () => ({ status: "completed", behind: 0, torn: false }) });

test("resume plan: ready session, nothing started, checks reported", async () => {
  const f = fixture();
  const s = make(f, { runId: "r1", node: "build" });
  const plan = await resumeSession(REPO, s.id, okSeams(f));
  assert.deepEqual([plan.ok, plan.problems, plan.sessionId, plan.runId, plan.node, plan.needsReconcile], [true, [], s.id, "r1", "build", false]);
  assert.deepEqual([plan.checks.workspace, plan.checks.repository, plan.checks.branch, plan.checks.run], ["ok", "ok", "ok", "finished"]);
});

test("resume plan: absent seams are 'not checked', never ok", async () => {
  const f = fixture();
  const s = make(f, { runId: "r1" });
  const plan = await resumeSession(REPO, s.id, f.opts);
  assert.equal(plan.ok, true);
  assert.deepEqual([plan.checks.repository, plan.checks.branch, plan.checks.run], ["not checked", "not checked", "not checked"]);
});

test("resume plan: problems are listed with remediation (missing workspace, other repo, wrong branch, archived, missing run)", async () => {
  const f = fixture();
  const s = make(f, { runId: "r1" });
  const gone = createSession({ repoKey: REPO, workspace: join(f.workspace, "nope"), title: "gone" }, f.opts).session;
  assert.deepEqual((await resumeSession(REPO, gone.id, f.opts)).problems.map((p) => p.code), ["WORKSPACE_MISSING"]);
  const codes = async (extra) => (await resumeSession(REPO, s.id, { ...okSeams(f), ...extra })).problems.map((p) => p.code);
  assert.deepEqual(await codes({ identify: async () => "other-repo" }), ["REPO_MISMATCH"]);
  assert.deepEqual(await codes({ identify: async () => { throw new Error("x"); } }), ["REPO_MISMATCH"]);
  assert.deepEqual(await codes({ currentBranch: async () => "dev" }), ["BRANCH_MISMATCH"]);
  assert.deepEqual(await codes({ runStatus: async () => null }), ["RUN_MISSING"]);
  archiveSession(REPO, s.id, f.opts);
  const plan = await resumeSession(REPO, s.id, okSeams(f));
  assert.deepEqual(plan.problems.map((p) => p.code), ["SESSION_ARCHIVED"]);
  assert.ok(plan.problems.every((p) => p.remediation && p.message));
  assert.equal(plan.ok, false);
});

test("resume plan: worktree must exist and be on its branch; the workspace branch is not what counts", async () => {
  const f = fixture();
  const wt = tempDir("aw-so-wt-");
  const s = make(f, { branch: "asterweave/x", worktree: { path: wt, branch: "asterweave/x", base: "main", created: true } });
  const fine = await resumeSession(REPO, s.id, { ...okSeams(f), currentBranch: async () => "unrelated", inspectWorktree: async () => ({ exists: true, branch: "asterweave/x" }) });
  assert.equal(fine.ok, true);
  assert.equal(fine.checks.worktree, "present");
  const wrong = await resumeSession(REPO, s.id, { ...okSeams(f), inspectWorktree: async () => ({ exists: true, branch: "main" }) });
  assert.deepEqual(wrong.problems.map((p) => p.code), ["WORKTREE_BRANCH_MISMATCH"]);
  const missing = createSession({ repoKey: REPO, workspace: f.workspace, worktree: { path: join(wt, "gone"), branch: "b", created: true } }, f.opts).session;
  assert.deepEqual((await resumeSession(REPO, missing.id, okSeams(f))).problems.map((p) => p.code), ["WORKTREE_MISSING"]);
});

test("resume plan: needsReconcile for an interrupted run, events behind or a torn log; not for finished or waiting runs", async () => {
  const f = fixture();
  const s = make(f, { runId: "r1" });
  const needs = async (info) => (await resumeSession(REPO, s.id, { ...okSeams(f), runStatus: async () => info })).needsReconcile;
  assert.equal(await needs({ status: "active", behind: 0, torn: false }), true);
  assert.equal(await needs({ status: "waiting-approval", behind: 2, torn: false }), true);
  assert.equal(await needs({ status: "paused", behind: 0, torn: true }), true);
  assert.equal(await needs({ status: "paused", behind: 0, torn: false }), false);
  assert.equal(await needs({ status: "completed", behind: 0, torn: false }), false);
});

function archived(f, extra, when) {
  const s = make(f, extra);
  archiveSession(REPO, s.id, { ...f.opts, now: at(when) });
  return s;
}

test("clean plan: archived only, age filter, sizes; archivedOnly:false lists active ones as not eligible", () => {
  const f = fixture();
  const oldOne = archived(f, { title: "old" }, 0);
  const newOne = archived(f, { title: "new" }, 50);
  const active = make(f, { title: "active" });
  const now = at(60);
  const all = cleanPlan(REPO, { ...f.opts, now });
  assert.deepEqual(all.items.map((i) => i.id).sort(), [oldOne.id, newOne.id].sort());
  assert.ok(all.items.every((i) => i.bytes > 0 && i.eligible));
  assert.equal(all.totalBytes, all.items.reduce((sum, i) => sum + i.bytes, 0));
  assert.deepEqual(cleanPlan(REPO, { ...f.opts, now, olderThanDays: 30 }).items.map((i) => i.id), [oldOne.id]);
  assert.throws(() => cleanPlan(REPO, { ...f.opts, olderThanDays: -1 }), (e) => e.exitCode === 2);
  const wide = cleanPlan(REPO, { ...f.opts, now, archivedOnly: false });
  const row = wide.items.find((i) => i.id === active.id);
  assert.deepEqual([row.eligible, row.reason], [false, "not archived"]);
  assert.equal(wide.totalBytes, all.totalBytes, "non-eligible items are not counted as freed space");
  assert.equal(existsSync(oldOne ? sessionDir(REPO, oldOne.id, f.opts) : ""), true, "a plan deletes nothing");
});

test("clean apply: deletes only the planned archived session directories, nothing else", async () => {
  const f = fixture();
  const keep = archived(f, { title: "keep" }, 0);
  const drop = archived(f, { title: "drop" }, 0);
  const active = make(f, { title: "active" });
  const runsDir = join(f.userDir, "runs", "x", "run-1");
  mkdirSync(runsDir, { recursive: true });
  writeFileSync(join(runsDir, "run.json"), "{}");
  writeFileSync(join(f.workspace, "work.txt"), "edit");
  const plan = cleanPlan(REPO, f.opts);
  plan.items = plan.items.filter((i) => i.id === drop.id);
  const result = await cleanApply(plan, f.opts);
  assert.deepEqual(result.removed.map((r) => r.id), [drop.id]);
  assert.equal(existsSync(sessionDir(REPO, drop.id, f.opts)), false);
  for (const id of [keep.id, active.id]) assert.equal(existsSync(sessionDir(REPO, id, f.opts)), true);
  assert.equal(existsSync(join(runsDir, "run.json")), true, "runs untouched");
  assert.equal(readFileSync(join(f.workspace, "work.txt"), "utf8"), "edit", "workspace untouched");
  assert.equal(JSON.parse(readFileSync(join(repoSessionsDir(REPO, f.opts), "cleaned.jsonl"), "utf8").trim()).sessionId, drop.id);
  assert.equal(listSessions(REPO, f.opts).sessions.length, 2, "cleaned.jsonl is not a session");
});

test("clean apply: a tampered plan cannot delete an active session, an invalid id or another repository", async () => {
  const f = fixture();
  const active = make(f, { title: "active" });
  const other = createSession({ repoKey: "another-repo", workspace: f.workspace, title: "other" }, f.opts);
  archiveSession("another-repo", other.session.id, f.opts);
  const result = await cleanApply(
    { repoKey: REPO, items: [{ id: active.id, eligible: true }, { id: "../..", eligible: true }, { id: other.session.id, eligible: true }, { id: "s_0000000000000000", eligible: false, reason: "not archived" }] },
    f.opts,
  );
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped.map((s) => s.reason), ["not archived", "invalid id", "already gone", "not archived"]);
  assert.equal(existsSync(sessionDir(REPO, active.id, f.opts)), true);
  assert.equal(existsSync(sessionDir("another-repo", other.session.id, f.opts)), true);
});

test("clean apply: a symlinked session directory is never followed", async (t) => {
  const f = fixture();
  const outside = tempDir("aw-so-outside-");
  writeFileSync(join(outside, "precious.txt"), "keep me");
  const link = join(repoSessionsDir(REPO, f.opts), "s_1111111111111111");
  mkdirSync(repoSessionsDir(REPO, f.opts), { recursive: true });
  try {
    symlinkSync(outside, link, "junction");
  } catch {
    t.skip("cannot create a link here");
    return;
  }
  const result = await cleanApply({ repoKey: REPO, items: [{ id: "s_1111111111111111", eligible: true }] }, f.opts);
  assert.deepEqual(result.removed, []);
  assert.equal(result.skipped[0].reason, "outside the sessions directory");
  assert.equal(readFileSync(join(outside, "precious.txt"), "utf8"), "keep me");
});

test("clean apply: a session with a worktree is removed only when the worktree is known clean or gone", async () => {
  const f = fixture();
  const worktree = (name) => ({ path: join(f.workspace, name), branch: `b-${name}`, created: true });
  const a = archived(f, { worktree: worktree("a") }, 0);
  const b = archived(f, { worktree: worktree("b") }, 0);
  const c = archived(f, { worktree: worktree("c") }, 0);
  const d = archived(f, { worktree: worktree("d") }, 0);
  const plan = cleanPlan(REPO, f.opts);
  const answers = { a: { dirty: true }, b: { dirty: false }, c: { dirty: "unknown" }, d: { exists: false } };
  const inspectWorktree = async (p) => answers[p.split(/[\\/]/).at(-1)];
  const first = await cleanApply(plan, { ...f.opts, inspectWorktree });
  assert.deepEqual(first.removed.map((r) => r.id).sort(), [b.id, d.id].sort());
  assert.deepEqual(Object.fromEntries(first.skipped.map((s) => [s.id, s.reason])), { [a.id]: "its worktree has uncommitted changes", [c.id]: "its worktree state is unknown" });
  // The default seam says "unknown": skipped with a reason.
  const second = await cleanApply({ ...plan, items: plan.items.filter((i) => i.id === a.id) }, f.opts);
  assert.deepEqual([second.removed.length, second.skipped[0].reason], [0, "its worktree state is unknown"]);
  const thrown = await cleanApply({ ...plan, items: plan.items.filter((i) => i.id === c.id) }, { ...f.opts, inspectWorktree: async () => { throw new Error("boom"); } });
  assert.equal(thrown.removed.length, 0, "a seam failure means unknown");
  assert.equal(loadSession(REPO, a.id, f.opts).session.worktree.path, join(f.workspace, "a"));
});

test("resume of a fork of a worktree session is ready (no branch expectation), and reports cwd", async () => {
  const f = fixture();
  const wt = tempDir("aw-so-wt-");
  const parent = make(f, { branch: "asterweave/x", worktree: { path: wt, branch: "asterweave/x", base: "main", created: true } });
  const inWorktree = await resumeSession(REPO, parent.id, { ...okSeams(f), inspectWorktree: async () => ({ exists: true, branch: "asterweave/x" }) });
  assert.equal(inWorktree.cwd, wt, "work happens in the worktree");
  const child = forkSession(REPO, parent.id, f.opts).session;
  const plan = await resumeSession(REPO, child.id, { ...okSeams(f), currentBranch: async () => "main" });
  assert.deepEqual([plan.ok, plan.problems, plan.checks.branch, plan.cwd], [true, [], "none recorded", f.workspace]);
});
