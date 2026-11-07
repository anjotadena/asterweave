// End to end through the real bin: a session with a real git worktree, resume, fork, archive, clean.
// Everything lives under an isolated ASTERWEAVE_CONFIG_DIR.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-sess-e2e-")));
after(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
const repo = join(root, "repo");
mkdirSync(repo);
git(repo, "init", "-q");
writeFileSync(join(repo, "a.txt"), "x\n");
git(repo, "add", "a.txt");
git(repo, "commit", "-qm", "init");
const configDir = join(root, "cfg");
mkdirSync(configDir);

const aw = (...args) => {
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, ASTERWEAVE_CONFIG_DIR: configDir, NO_COLOR: "1" } });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

test("session start --worktree creates a real worktree under the user dir and the repo stays clean", () => {
  const r = aw("session", "start", "--title", "e2e", "--worktree", "w1", "--json");
  assert.equal(r.code, 0, r.err + r.out);
  const doc = JSON.parse(r.out);
  assert.equal(doc.ok, true);
  assert.ok(doc.session.worktree.path.startsWith(configDir), "worktree lives under the isolated user dir");
  assert.ok(existsSync(doc.session.worktree.path));
  assert.match(doc.session.worktree.base ?? "", /^[0-9a-f]{40}$/, "the base commit is recorded");
  assert.equal(git(repo, "status", "--porcelain").toString(), "", "the repository itself is untouched");
});

test("list, resume, fork (and resume the fork), archive and clean round trip; clean removes only the archived record and keeps the worktree", () => {
  const started = JSON.parse(aw("session", "start", "--title", "round trip", "--worktree", "w2", "--json").out);
  const id = started.session.id;
  const wt = started.session.worktree.path;
  assert.ok(JSON.parse(aw("session", "list", "--json").out).sessions.some((s) => s.id === id));
  const resumed = aw("session", "resume", id, "--json");
  assert.equal(resumed.code, 0, resumed.err + resumed.out);
  assert.equal(JSON.parse(resumed.out).plan.cwd, wt);
  const forked = JSON.parse(aw("session", "fork", id, "--title", "child", "--json").out);
  assert.equal(forked.session.parentSessionId, id);
  assert.equal(forked.session.branch, null, "a worktree branch is not inherited");
  const resumedFork = aw("session", "resume", forked.session.id, "--json");
  assert.equal(resumedFork.code, 0, "a fork of a worktree session can be resumed: " + resumedFork.out);
  assert.equal(aw("session", "archive", id, "--json").code, 0);
  const dry = aw("session", "clean", "--json");
  assert.equal(dry.code, 2, "preview only without --yes");
  assert.equal(aw("session", "show", id, "--json").code, 0, "the preview deleted nothing");
  const done = aw("session", "clean", "--yes", "--json");
  assert.equal(done.code, 0, done.err + done.out);
  assert.deepEqual(JSON.parse(done.out).removed.map((r) => r.id), [id], "the archived session was actually removed");
  assert.equal(aw("session", "show", id, "--json").code, 1, "and is gone");
  assert.equal(aw("session", "show", forked.session.id, "--json").code, 0, "the active fork is kept");
  assert.ok(existsSync(wt), "cleaning a session never removes its worktree");
});
