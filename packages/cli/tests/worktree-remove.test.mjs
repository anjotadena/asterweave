// Worktree module: inspect, remove and dry-run on REAL git repositories (temp dirs, no network).

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createWorktree, inspectWorktree, listWorktrees, planWorktree, previewRemoval, removeWorktree } from "../src/runtime/worktree.mjs";
import { cleanupTemp, git, makeClone, snapshot, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

async function setup(name = "alpha") {
  const root = makeClone();
  const opts = { userDir: tempDir("aw-user-") };
  const made = await createWorktree(await planWorktree({ root, name, ...opts }), opts);
  return { root, opts, made, path: made.path };
}

const problemCodes = (error) => error.problems ?? [];

async function refused(promise, ...codes) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "WORKTREE_REMOVE_REFUSED", error.message);
    for (const code of codes) assert.ok(problemCodes(error).includes(code), `${code} in ${problemCodes(error)}`);
    return true;
  });
}

function spy() {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push([...args]);
    return nodeSpawn(cmd, args, options);
  };
  spawn.calls = calls;
  return spawn;
}

const posix = (file) => file.replaceAll("\\", "/");

test("inspect: clean worktree", async () => {
  const { root, opts, path } = await setup();
  const state = await inspectWorktree(path, { ...opts, root });
  assert.equal(state.exists, true);
  assert.equal(state.registered, true);
  assert.equal(state.asterweave, true);
  assert.equal(state.main, false);
  assert.equal(state.branch, "asterweave/alpha");
  assert.equal(state.head, git(root, "rev-parse", "HEAD").trim());
  assert.equal(state.dirty, false);
  assert.equal(state.ahead, 0);
  assert.equal(state.against, "base");
  assert.equal(state.locked, false);
  // root is optional: the worktree is enough to find the repository
  assert.equal((await inspectWorktree(path, opts)).dirty, false);
});

test("inspect: tracked change and untracked file are dirty", async () => {
  const { opts, path } = await setup();
  writeFileSync(join(path, "README.md"), "changed\n");
  assert.equal((await inspectWorktree(path, opts)).dirty, true);
  git(path, "checkout", "--", "README.md");
  assert.equal((await inspectWorktree(path, opts)).dirty, false);
  writeFileSync(join(path, "new.txt"), "x");
  assert.equal((await inspectWorktree(path, opts)).dirty, true);
});

test("inspect: missing and unregistered paths", async () => {
  const { root, opts, path } = await setup();
  const nowhere = join(tempDir("aw-nowhere-"), "nope");
  const gone = await inspectWorktree(nowhere, opts);
  assert.equal(gone.exists, false);
  assert.equal(gone.registered, false);
  const plain = await inspectWorktree(tempDir("aw-plain-"), { ...opts, root });
  assert.equal(plain.registered, false);
  assert.equal(plain.exists, true, "a real directory that is not a worktree: exists, unregistered");
  assert.equal((await inspectWorktree(root, opts)).main, true);
  assert.equal((await inspectWorktree(path, opts)).registered, true);
});

test("inspect: ahead/behind against an upstream", async () => {
  const { root, opts, path } = await setup();
  git(path, "branch", "--set-upstream-to=origin/main");
  writeFileSync(join(path, "a.txt"), "a");
  git(path, "add", "a.txt");
  git(path, "commit", "-m", "a");
  git(root, "update-ref", "refs/remotes/origin/main", git(root, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "upstream").trim());
  const state = await inspectWorktree(path, opts);
  assert.equal(state.against, "upstream");
  assert.equal(state.ahead, 1);
  assert.equal(state.behind, 1);
});

test("inspect: a repository filter driver makes dirty 'unknown' and never runs the driver", async () => {
  const { root, opts, path } = await setup();
  const dir = tempDir("aw-filter-");
  const marker = join(dir, "ran.txt");
  const script = join(dir, "filter.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`);
  git(root, "config", "filter.x.clean", `"${posix(process.execPath)}" "${posix(script)}"`);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=x\n");
  const when = new Date(Date.now() - 3_600_000);
  utimesSync(join(path, "README.md"), when, when); // stale stat: a plain `git status` would re-hash and run the filter
  const state = await inspectWorktree(path, opts);
  assert.equal(state.dirty, "unknown");
  assert.match(state.dirtyReason, /filter driver/);
  assert.equal(existsSync(marker), false, "the clean filter must not have run");
  await refused(removeWorktree(path, opts), "DIRTY_UNKNOWN");
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(path), true);
});

test("inspect: worktree-specific config (config.worktree) with a filter driver is also detected", async () => {
  const { root, opts, path } = await setup();
  git(root, "config", "extensions.worktreeConfig", "true");
  git(path, "config", "--worktree", "filter.y.clean", "cat");
  assert.equal((await inspectWorktree(path, opts)).dirty, "unknown");
});

test("remove: success deletes only the worktree directory; the branch is kept; the repo is clean", async () => {
  const { root, opts, path } = await setup();
  const sibling = makeClone({ origin: "https://github.com/acme/other.git" });
  const siblingBefore = snapshot(sibling);
  const spawn = spy();
  const result = await removeWorktree(path, { ...opts, spawn });
  assert.equal(result.removed, true);
  assert.equal(result.branchKept, true);
  assert.equal(existsSync(path), false);
  assert.match(git(root, "branch", "--list", "asterweave/alpha"), /asterweave\/alpha/);
  assert.equal(git(root, "worktree", "list", "--porcelain").includes("alpha"), false);
  assert.equal(git(root, "status", "--porcelain").trim(), "");
  assert.deepEqual(snapshot(sibling), siblingBefore);
  const flat = spawn.calls.flat();
  assert.ok(flat.includes("remove"));
  assert.ok(!flat.includes("--force") && !flat.includes("-f"), "never forced");
  assert.ok(!spawn.calls.some((args) => args.includes("branch") || args.includes("prune") || args.includes("clean")), "no branch deletion, prune or clean");
  assert.equal((await listWorktrees(root, opts)).length, 1);
});

test("remove: refuses a dirty worktree and keeps the edits", async () => {
  const { opts, path } = await setup();
  writeFileSync(join(path, "README.md"), "precious\n");
  writeFileSync(join(path, "untracked.txt"), "also precious\n");
  await refused(removeWorktree(path, opts), "DIRTY");
  assert.equal(existsSync(join(path, "untracked.txt")), true);
  assert.match(git(path, "diff", "--stat"), /README/);
});

test("remove: refuses a locked worktree", async () => {
  const { root, opts, path } = await setup();
  git(root, "worktree", "lock", "--reason", "in use", path);
  assert.equal((await inspectWorktree(path, opts)).locked, "in use");
  await refused(removeWorktree(path, opts), "LOCKED");
  assert.equal(existsSync(path), true);
  git(root, "worktree", "unlock", path);
  assert.equal((await removeWorktree(path, opts)).removed, true);
});

test("remove: refuses the main work tree, foreign worktrees and unregistered paths", async () => {
  const { root, opts } = await setup();
  await refused(removeWorktree(root, opts), "MAIN_WORKTREE");
  assert.equal(existsSync(join(root, "README.md")), true);
  const foreign = join(tempDir("aw-foreign-"), "f");
  git(root, "worktree", "add", "-b", "foreign", foreign);
  await refused(removeWorktree(foreign, { ...opts, root }), "NOT_ASTERWEAVE");
  assert.equal(existsSync(foreign), true);
  const stray = tempDir("aw-stray-");
  await refused(removeWorktree(stray, { ...opts, root }), "NOT_REGISTERED");
  assert.equal(existsSync(stray), true);
});

test("remove: refuses unpushed commits unless keepBranch acknowledges that they stay on the branch", async () => {
  const { root, opts, path } = await setup();
  writeFileSync(join(path, "a.txt"), "a");
  git(path, "add", "a.txt");
  git(path, "commit", "-m", "work");
  await refused(removeWorktree(path, opts), "UNPUSHED");
  assert.equal(existsSync(path), true);
  const result = await removeWorktree(path, { ...opts, keepBranch: true });
  assert.equal(result.removed, true);
  assert.match(git(root, "log", "--oneline", "asterweave/alpha"), /work/);
});

test("remove: refuses a detached HEAD at a commit nothing else contains", async () => {
  const { opts, path } = await setup();
  writeFileSync(join(path, "a.txt"), "a");
  git(path, "add", "a.txt");
  git(path, "commit", "-m", "orphan");
  git(path, "checkout", "--detach");
  git(path, "branch", "-D", "asterweave/alpha");
  await refused(removeWorktree(path, { ...opts, keepBranch: true }), "DETACHED_COMMITS");
});

test("remove: a forged or foreign-repo marker does not make a worktree removable", async () => {
  const { root, opts } = await setup();
  const foreign = join(tempDir("aw-foreign-"), "f");
  git(root, "worktree", "add", "-b", "foreign", foreign);
  const admin = git(foreign, "rev-parse", "--absolute-git-dir").trim();
  writeFileSync(join(admin, "asterweave-worktree.json"), JSON.stringify({ schemaVersion: 1, createdBy: "asterweave", name: "f", branch: "foreign", base: { commit: "0".repeat(40) }, path: foreign, repoKey: "somebody-else" }));
  await refused(removeWorktree(foreign, { ...opts, root }), "NOT_ASTERWEAVE");
});

test("remove: a missing directory is reported, not pruned", async () => {
  const { root, opts, path } = await setup();
  const { rmSync } = await import("node:fs");
  rmSync(path, { recursive: true, force: true });
  await refused(removeWorktree(path, { ...opts, root }), "MISSING");
  assert.match(git(root, "worktree", "list", "--porcelain"), /prunable|alpha/);
});

test("dry run: previews without changing anything and lists the reasons", async () => {
  const { root, opts, path } = await setup();
  const before = snapshot(root);
  const clean = await removeWorktree(path, { ...opts, dryRun: true });
  assert.equal(clean.dryRun, true);
  assert.equal(clean.removed, false);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.wouldRun.slice(0, 3), ["git", "worktree", "remove"]);
  assert.equal(existsSync(path), true);
  writeFileSync(join(path, "x.txt"), "x");
  const dirty = await previewRemoval(path, opts);
  assert.equal(dirty.ok, false);
  assert.deepEqual(dirty.problems.map((problem) => problem.code), ["DIRTY"]);
  assert.equal(dirty.wouldRun, null);
  assert.deepEqual(snapshot(root), before);
  assert.equal((await removeWorktree(root, { ...opts, dryRun: true })).problems[0].code, "MAIN_WORKTREE");
});

test("abort before removal keeps everything", async () => {
  const { opts, path } = await setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(removeWorktree(path, { ...opts, signal: controller.signal }), (error) => error.exitCode === 130);
  assert.equal(existsSync(path), true);
  assert.equal((await inspectWorktree(path, opts)).registered, true);
});

test("concurrent removal: one succeeds, the other fails cleanly, the repository stays consistent", async () => {
  const { root, opts, path } = await setup();
  const results = await Promise.allSettled([removeWorktree(path, opts), removeWorktree(path, opts)]);
  assert.equal(results.filter((item) => item.status === "fulfilled").length, 1, JSON.stringify(results.map((item) => item.reason?.message)));
  const failure = results.find((item) => item.status === "rejected");
  assert.match(failure.reason.code, /^WORKTREE_REMOVE_(REFUSED|FAILED)$/);
  assert.equal(existsSync(path), false);
  assert.equal(git(root, "status", "--porcelain").trim(), "");
  assert.equal((await listWorktrees(root, opts)).length, 1);
});

test("remove then create the same name again works (no stale marker or directory)", async () => {
  const { root, opts, path } = await setup();
  await removeWorktree(path, { ...opts, keepBranch: true });
  const again = await createWorktree(await planWorktree({ root, name: "alpha", branch: "asterweave/alpha-2", ...opts }), opts);
  assert.equal(again.path, path);
  assert.equal((await inspectWorktree(path, opts)).asterweave, true);
  unlinkSync(join(path, "README.md"));
  assert.equal((await inspectWorktree(path, opts)).dirty, true);
});
