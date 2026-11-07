// Worktree module: planning, creating and listing on REAL git repositories (temp dirs, no network).

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { resolveRepo } from "../src/commands/run.mjs";
import { repoDirName } from "../src/runtime/ledger.mjs";
import { createWorktree, listWorktrees, planWorktree, resolveWorktreeContext, WORKTREE_MARKER_FILE } from "../src/runtime/worktree.mjs";
import { cleanupTemp, git, makeClone, snapshot, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const setup = () => {
  const root = makeClone();
  const userDir = tempDir("aw-user-");
  return { root, userDir, opts: { userDir } };
};

async function rejects(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("name validation: only [a-z0-9][a-z0-9._-]{0,63}, no reserved or traversal names", async () => {
  const { root, opts } = setup();
  for (const name of ["", "A", "-x", ".x", "a b", "a/b", "a\\b", "x..y", "x.", "x.lock", "con", "nul.txt", "a".repeat(65), "ok\u0000", undefined, 7]) {
    await rejects(planWorktree({ root, name, ...opts }), "WORKTREE_NAME_INVALID");
  }
  const plan = await planWorktree({ root, name: "a".repeat(64), ...opts });
  assert.equal(plan.ok, true);
});

test("invalid names never echo raw control sequences", async () => {
  const { root, opts } = setup();
  await assert.rejects(planWorktree({ root, name: "\u001b]0;pwn\u0007", ...opts }), (error) => !/\u001b|\u0007/.test(error.message));
});

test("branch and base validation", async () => {
  const { root, opts } = setup();
  for (const branch of ["-x", "a b", "a..b", "x.lock", "HEAD", "a~1", "", "bad:name"]) {
    await rejects(planWorktree({ root, name: "w1", branch, ...opts }), "WORKTREE_BRANCH_INVALID");
  }
  await rejects(planWorktree({ root, name: "w1", branch: "dev", ...opts }), "WORKTREE_BRANCH_EXISTS");
  for (const base of ["nope", "--upload-pack=x", "-h", "a b"]) {
    await rejects(planWorktree({ root, name: "w1", base, ...opts }), "WORKTREE_BASE_INVALID");
  }
  const plan = await planWorktree({ root, name: "w1", base: "dev", ...opts });
  assert.equal(plan.branch, "asterweave/w1");
  assert.equal(plan.base.commit, git(root, "rev-parse", "dev").trim());
});

test("default location is outside the repository: <userDir>/worktrees/<repoDirName>/<name>", async () => {
  const { root, userDir, opts } = setup();
  const plan = await planWorktree({ root, name: "alpha", ...opts });
  const ctx = await resolveWorktreeContext(root, opts);
  assert.equal(plan.path, join(userDir, "worktrees", repoDirName(ctx.key), "alpha"));
  assert.equal(plan.location, "user-dir");
  assert.equal(plan.repoKey, ctx.key);
});

test("repoKey is identical to the one commands/run.mjs resolveRepo uses", async () => {
  const { root, opts } = setup();
  const ctx = await resolveWorktreeContext(root, opts);
  const repo = await resolveRepo({ cwd: root });
  assert.equal(ctx.key, repo.key);
});

test("create: new branch from the pinned base, repository stays clean, nothing else changes", async () => {
  const { root, userDir, opts } = setup();
  const before = snapshot(root);
  const plan = await planWorktree({ root, name: "alpha", base: "dev", ...opts });
  const made = await createWorktree(plan, opts);
  assert.equal(made.created, true);
  assert.equal(made.branch, "asterweave/alpha");
  assert.ok(made.path.startsWith(userDir));
  assert.ok(existsSync(join(made.path, "README.md")));
  assert.equal(git(made.path, "rev-parse", "--abbrev-ref", "HEAD").trim(), "asterweave/alpha");
  assert.equal(git(made.path, "rev-parse", "HEAD").trim(), git(root, "rev-parse", "dev").trim());

  const after = snapshot(root);
  assert.equal(after.status, "", "repository must not show as dirty");
  assert.equal(after.status, before.status);
  assert.equal(after.head, before.head);
  assert.equal(after.branch, before.branch);
  assert.match(after.branches, /asterweave\/alpha/);
  assert.equal(git(root, "config", "--local", "--list"), before.config);
  assert.equal(git(root, "status", "--porcelain", "--ignored").trim(), "", "no .gitignore edit or untracked output");
  assert.equal(existsSync(join(root, ".claude")), false);
});

test("create writes the marker inside git's admin directory, never in the work tree", async () => {
  const { root, opts } = setup();
  const made = await createWorktree(await planWorktree({ root, name: "alpha", ...opts }), opts);
  assert.equal(existsSync(join(made.path, WORKTREE_MARKER_FILE)), false);
  const admin = git(made.path, "rev-parse", "--absolute-git-dir").trim();
  const marker = JSON.parse(readFileSync(join(admin, WORKTREE_MARKER_FILE), "utf8"));
  assert.equal(marker.createdBy, "asterweave");
  assert.equal(marker.name, "alpha");
  assert.equal(marker.branch, "asterweave/alpha");
  assert.equal(marker.base.commit, git(root, "rev-parse", "HEAD").trim());
});

test("list: main first, created worktree flagged asterweave, foreign worktree not flagged", async () => {
  const { root, opts } = setup();
  const foreign = join(tempDir("aw-foreign-"), "f");
  git(root, "worktree", "add", "-b", "foreign", foreign);
  const made = await createWorktree(await planWorktree({ root, name: "alpha", ...opts }), opts);
  const list = await listWorktrees(root, opts);
  assert.equal(list.length, 3);
  assert.equal(list[0].main, true);
  assert.equal(list[0].asterweave, false);
  assert.equal(list[0].branch, "main");
  const ours = list.find((item) => item.path === made.path);
  assert.equal(ours.asterweave, true);
  assert.equal(ours.name, "alpha");
  assert.equal(ours.branch, "asterweave/alpha");
  assert.equal(ours.locked, false);
  const other = list.find((item) => item.branch === "foreign");
  assert.equal(other.asterweave, false);
  // listing from inside a linked worktree sees the same set
  assert.equal((await listWorktrees(made.path, opts)).length, 3);
});

test("a forged marker for another path or repository is not trusted", async () => {
  const { root, opts } = setup();
  const foreign = join(tempDir("aw-foreign-"), "f");
  git(root, "worktree", "add", "-b", "foreign", foreign);
  const admin = git(foreign, "rev-parse", "--absolute-git-dir").trim();
  writeFileSync(join(admin, WORKTREE_MARKER_FILE), JSON.stringify({ schemaVersion: 1, createdBy: "asterweave", name: "f", branch: "foreign", base: { commit: "0".repeat(40) }, path: "/elsewhere", repoKey: "other" }));
  const item = (await listWorktrees(root, opts)).find((entry) => entry.branch === "foreign");
  assert.equal(item.asterweave, false);
});

test("path containment: custom paths inside the repo, .git or another worktree are refused", async () => {
  const { root, opts } = setup();
  const made = await createWorktree(await planWorktree({ root, name: "alpha", ...opts }), opts);
  for (const inner of [join(root, "sub"), join(root, ".git", "wt"), join(root, ".claude", "worktrees", "x"), join(made.path, "nested")]) {
    await rejects(planWorktree({ root, name: "w2", path: inner, ...opts }), "WORKTREE_PATH_UNSAFE");
  }
  // relative and `..` paths
  await rejects(planWorktree({ root, name: "w2", path: "relative/dir", ...opts }), "WORKTREE_PATH_UNSAFE");
  await rejects(planWorktree({ root, name: "w2", path: `${tempDir("aw-out-")}/../x`, ...opts }), "WORKTREE_PATH_UNSAFE");
  // an existing path is never reused, even an empty directory
  const taken = join(tempDir("aw-out-"), "taken");
  mkdirSync(taken);
  await rejects(planWorktree({ root, name: "w2", path: taken, ...opts }), "WORKTREE_PATH_EXISTS");
});

test("path containment: a junction/symlink that leads into the repository is refused", async (t) => {
  const { root, opts } = setup();
  const out = tempDir("aw-out-");
  const link = join(out, "link");
  try {
    symlinkSync(root, link, "junction");
  } catch {
    return t.skip("links are not permitted on this host");
  }
  assert.ok(lstatSync(link).isSymbolicLink());
  await rejects(planWorktree({ root, name: "w2", path: join(link, "wt"), ...opts }), "WORKTREE_PATH_UNSAFE");
  // a planted link where the default worktree directory would be
  const { userDir } = opts;
  const ctx = await resolveWorktreeContext(root, opts);
  mkdirSync(join(userDir, "worktrees"), { recursive: true });
  try {
    symlinkSync(root, join(userDir, "worktrees", repoDirName(ctx.key)), "junction");
  } catch {
    return t.skip("links are not permitted on this host");
  }
  await rejects(planWorktree({ root, name: "w3", ...opts }), "WORKTREE_PATH_UNSAFE");
  assert.equal(git(root, "status", "--porcelain").trim(), "");
});

test("a pre-existing symlink at the target path is refused, not followed", async (t) => {
  const { root, opts } = setup();
  const ctx = await resolveWorktreeContext(root, opts);
  const dir = join(opts.userDir, "worktrees", repoDirName(ctx.key));
  mkdirSync(dir, { recursive: true });
  try {
    symlinkSync(tempDir("aw-out-"), join(dir, "alpha"), "junction");
  } catch {
    return t.skip("links are not permitted on this host");
  }
  await rejects(planWorktree({ root, name: "alpha", ...opts }), "WORKTREE_PATH_EXISTS");
});

test("create refuses an existing branch and an existing directory, and leaves nothing behind", async () => {
  const { root, opts } = setup();
  const plan = await planWorktree({ root, name: "alpha", ...opts });
  git(root, "branch", "asterweave/alpha"); // appears between plan and create
  await rejects(createWorktree(plan, opts), "WORKTREE_BRANCH_EXISTS");
  assert.equal(existsSync(plan.path), false);
  await rejects(createWorktree({ ok: true }, opts), "WORKTREE_PLAN_INVALID");
});

test("create refuses when the repository configures a filter driver (checkout would run it)", async () => {
  const { root, opts } = setup();
  const marker = join(tempDir("aw-filter-"), "ran.txt");
  const script = join(tempDir("aw-filter-"), "f.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`);
  git(root, "config", "filter.x.smudge", `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=x\n");
  const plan = await planWorktree({ root, name: "alpha", ...opts });
  await rejects(createWorktree(plan, opts), "WORKTREE_UNSAFE_CONFIG");
  assert.equal(existsSync(marker), false, "the filter must not have run");
  assert.equal(existsSync(plan.path), false);
});

test("create does not run repository hooks", async () => {
  const { root, opts } = setup();
  const marker = join(tempDir("aw-hook-"), "ran.txt");
  const hook = join(root, ".git", "hooks", "post-checkout");
  mkdirSync(join(root, ".git", "hooks"), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
  git(root, "config", "core.hooksPath", join(root, ".git", "hooks"));
  await createWorktree(await planWorktree({ root, name: "alpha", ...opts }), opts);
  assert.equal(existsSync(marker), false);
});

test("concurrent create of the same name: exactly one wins, the repository stays consistent", async () => {
  for (const sameBranch of [true, false]) {
    const { root, opts } = setup();
    const planA = await planWorktree({ root, name: "race", branch: "race-a", ...opts });
    const planB = await planWorktree({ root, name: "race", branch: sameBranch ? "race-a" : "race-b", ...opts });
    const results = await Promise.allSettled([createWorktree(planA, opts), createWorktree(planB, opts)]);
    const won = results.filter((item) => item.status === "fulfilled");
    const lost = results.filter((item) => item.status === "rejected");
    assert.equal(won.length, 1, JSON.stringify(results.map((item) => item.reason?.message)));
    assert.equal(lost.length, 1);
    assert.match(lost[0].reason.code, /^WORKTREE_(PATH_EXISTS|BRANCH_EXISTS|CREATE_FAILED)$/);
    const list = await listWorktrees(root, opts);
    assert.equal(list.filter((item) => item.asterweave).length, 1);
    assert.equal(list.length, 2);
    assert.equal(git(root, "status", "--porcelain").trim(), "");
    git(root, "worktree", "list");
  }
});

test("sibling repositories are untouched", async () => {
  const { root, opts } = setup();
  const sibling = makeClone({ origin: "https://github.com/acme/other.git" });
  const before = snapshot(sibling);
  const siblingWorktrees = git(sibling, "worktree", "list");
  await createWorktree(await planWorktree({ root, name: "alpha", ...opts }), opts);
  assert.deepEqual(snapshot(sibling), before);
  assert.equal(git(sibling, "worktree", "list"), siblingWorktrees);
});

test("an aborted signal creates nothing", async () => {
  const { root, opts } = setup();
  const plan = await planWorktree({ root, name: "alpha", ...opts });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createWorktree(plan, { ...opts, signal: controller.signal }), (error) => error.exitCode === 130);
  assert.equal(existsSync(plan.path), false);
  assert.equal(git(root, "branch", "--list", "asterweave/alpha").trim(), "");
});

test("not a git repository: clear error", async () => {
  const dir = tempDir("aw-nogit-");
  await rejects(planWorktree({ root: dir, name: "alpha", userDir: tempDir("aw-user-") }), "REPO_NOT_GIT");
  await rejects(listWorktrees(dir, {}), "REPO_NOT_GIT");
});

for (const [label, condition] of [["onbranch", "includeIf.onbranch:asterweave/**.path"], ["gitdir", "includeIf.gitdir:**/worktrees/**.path"], ["plain include", "include.path"]]) {
  test(`conditional include (${label}) that defines a smudge filter is refused before anything runs`, async () => {
    const { root, opts } = setup();
    const dir = tempDir("aw-filter-");
    const marker = join(dir, "ran.txt");
    const script = join(dir, "f.cjs");
    writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`);
    const included = join(dir, "evil.cfg");
    git(root, "config", "-f", included, "filter.evil.smudge", `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`);
    git(root, "config", condition, included.replaceAll("\\", "/"));
    writeFileSync(join(root, ".git", "info", "attributes"), "* filter=evil\n");
    const plan = await planWorktree({ root, name: "alpha", ...opts });
    const listBefore = git(root, "worktree", "list");
    await rejects(createWorktree(plan, opts), "WORKTREE_UNSAFE_CONFIG");
    assert.equal(existsSync(marker), false, "the smudge filter must not have run");
    assert.equal(existsSync(plan.path), false, "target directory absent");
    assert.equal(git(root, "worktree", "list"), listBefore, "no new worktree entry");
    assert.equal(git(root, "branch", "--list", "asterweave/alpha").trim(), "");
  });
}

test("a filter that only becomes visible inside the new worktree is caught there and rolled back completely", async () => {
  const { root, opts } = setup();
  git(root, "config", "extensions.worktreeConfig", "true");
  const dir = tempDir("aw-filter-");
  const marker = join(dir, "ran.txt");
  const script = join(dir, "f.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`);
  writeFileSync(join(root, ".git", "info", "attributes"), "* filter=late\n");
  const plan = await planWorktree({ root, name: "alpha", ...opts });
  const listBefore = git(root, "worktree", "list");
  let planted = false;
  let added = false;
  // Right after `worktree add --no-checkout`, the worktree gets a worktree-scope filter (stands in for any config that
  // is only active inside the new work tree).
  const spawn = (cmd, args, options) => {
    if (args.includes("--no-checkout")) added = true;
    if (added && !planted && args.includes("list") && args.includes("--porcelain")) {
      planted = true;
      git(plan.path, "config", "--worktree", "filter.late.smudge", `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`);
    }
    return nodeSpawn(cmd, args, options);
  };
  await assert.rejects(createWorktree(plan, { ...opts, spawn }), (error) => {
    assert.equal(error.code, "WORKTREE_UNSAFE_CONFIG");
    assert.match(error.message, /removed/);
    return true;
  });
  assert.equal(planted, true);
  assert.equal(existsSync(marker), false);
  assert.equal(existsSync(plan.path), false);
  assert.equal(git(root, "worktree", "list"), listBefore);
  assert.equal(git(root, "branch", "--list", "asterweave/alpha").trim(), "");
  assert.equal(git(root, "status", "--porcelain").trim(), "");
});

test("any directory inside the work tree works as root (subdirectory), and still resolves the same repository", async () => {
  const { root, opts } = setup();
  const sub = join(root, "pkg", "deep");
  mkdirSync(sub, { recursive: true });
  const top = await resolveWorktreeContext(root, opts);
  const inner = await resolveWorktreeContext(sub, opts);
  assert.equal(inner.key, top.key);
  assert.equal(inner.workspace, top.workspace);
  const plan = await planWorktree({ root: sub, name: "alpha", ...opts });
  const made = await createWorktree(plan, opts);
  const list = await listWorktrees(sub, opts);
  assert.equal(list.length, 2);
  assert.ok(list.some((item) => item.path === made.path && item.asterweave));
  // from a subdirectory of the LINKED worktree too
  mkdirSync(join(made.path, "x"), { recursive: true });
  assert.equal((await listWorktrees(join(made.path, "x"), opts)).length, 2);
});

test("a subdirectory of a non-repository directory reports REPO_NOT_GIT", async () => {
  const { opts } = setup();
  const plain = join(tempDir("aw-nogit-"), "child");
  mkdirSync(plain);
  await rejects(resolveWorktreeContext(plain, opts), "REPO_NOT_GIT");
});
