// Repository identity for memory: canonical remotes, clones and worktrees, changed remotes.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { resolveRepo } from "../src/commands/run.mjs";
import { canonicalRemote, describeRepo, listAmbiguities, resolveAmbiguity, resolveRepoIdentity } from "../src/runtime/memory/identity.mjs";
import { openSession } from "../src/runtime/memory/sessions.mjs";
import { cleanupAll, git, rawBytes, tempDir, world } from "./memory-fixture.mjs";

after(cleanupAll);

test("canonical remotes: scp and https forms agree; credentials, port, .git, case and query are normalised away", () => {
  const same = ["https://github.com/Acme/Widgets.git", "git@github.com:acme/widgets", "ssh://git@github.com:22/acme/widgets.git", "https://user:tok3n@GITHUB.com:443/acme/widgets/?x=1#frag", "http://github.com/acme/widgets/"];
  for (const url of same) assert.equal(canonicalRemote(url), "github.com/acme/widgets", url);
  assert.equal(canonicalRemote("https://git.example.com/Team/Repo.git"), "git.example.com/Team/Repo", "path case is kept on hosts not known to ignore it");
  for (const url of ["", "   ", null, undefined, "not a url", "<unrecognized remote>", "https://github.com/", "https://x.com/../etc"]) assert.equal(canonicalRemote(url), null, String(url));
  assert.ok(!canonicalRemote("https://bob:secret@example.com/o/n.git").includes("secret"));
});

test("same folder name, different repositories: never merged; forks are different repositories", () => {
  const w = world({ remote: "https://github.com/acme/app.git", cloneKey: "/work/one/app" });
  const other = resolveRepoIdentity(w.mem, { cloneKey: "/work/two/app", remote: "https://github.com/someone-else/app.git" });
  const fork = resolveRepoIdentity(w.mem, { cloneKey: "/work/three/app-fork", remote: "https://github.com/me/app.git" });
  assert.equal(new Set([w.repoId, other.repoId, fork.repoId]).size, 3);
  const clone = resolveRepoIdentity(w.mem, { cloneKey: "/elsewhere/renamed", remote: "git@github.com:acme/app" });
  assert.equal(clone.repoId, w.repoId, "a second clone of the same remote is the same repository, whatever its folder is called");
  assert.equal(describeRepo(w.mem, w.repoId).clones, 2);
});

test("credentials in a remote are stripped before anything is stored", () => {
  const w = world({ remote: "https://bob:hunter2token@github.com/acme/secretrepo.git", cloneKey: "/c/s" });
  assert.equal(describeRepo(w.mem, w.repoId).remote, "github.com/acme/secretrepo");
  assert.ok(!rawBytes(w.mem).includes("hunter2token"));
});

test("a repository with no remote gets a random persisted id bound to its clone", () => {
  const w = world({ remote: null, cloneKey: "/c/local-a" });
  assert.match(w.repoId, /^r_[0-9a-f]{24}$/);
  assert.equal(describeRepo(w.mem, w.repoId).kind, "local");
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/c/local-a", remote: null }).repoId, w.repoId, "stable across calls");
  const second = resolveRepoIdentity(w.mem, { cloneKey: "/c/local-b", remote: null });
  assert.notEqual(second.repoId, w.repoId, "another folder without a remote is another repository");
  const reopened = w.open();
  assert.equal(resolveRepoIdentity(reopened, { cloneKey: "/c/local-a", remote: null }).repoId, w.repoId, "persisted across opens");
  assert.equal(resolveRepoIdentity(reopened, { cloneKey: "/c/never-seen", remote: null }, { create: false }).status, "unmapped", "a read never creates an identity");
});

test("a changed remote is NOT silently reassociated: it records an ambiguity and capture is refused until resolved", () => {
  const w = world({ remote: "https://github.com/acme/widgets.git", cloneKey: "/c/w" });
  const moved = resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/acme/widgets-renamed.git" });
  assert.deepEqual([moved.status, moved.ambiguous, moved.repoId], ["ambiguous", true, w.repoId], "the previous binding stays in force");
  assert.equal(listAmbiguities(w.mem, "/c/w").length, 1);
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/acme/widgets-renamed.git" }).ambiguity.id, moved.ambiguity.id, "not recorded twice");
  const refused = openSession(w.mem, { owner: w.owner, identity: moved }, w.settings);
  assert.deepEqual([refused.ok, refused.saved, refused.status], [false, false, "repo_ambiguous"]);
  const bare = world({ remote: "https://github.com/acme/x.git", cloneKey: "/c/bare" });
  assert.equal(resolveRepoIdentity(bare.mem, { cloneKey: "/c/bare", remote: null }).ambiguous, true, "a removed remote is a change too");
  const added = world({ remote: null, cloneKey: "/c/added" });
  assert.equal(resolveRepoIdentity(added.mem, { cloneKey: "/c/added", remote: "https://github.com/acme/x.git" }).ambiguous, true, "so is a remote added to a repository that had none");

  const same = resolveAmbiguity(w.mem, "/c/w", "same");
  assert.deepEqual([same.ok, same.repoId], [true, w.repoId]);
  const after = resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/acme/widgets-renamed.git" });
  assert.deepEqual([after.ambiguous, after.repoId], [false, w.repoId]);
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/acme/widgets.git" }).ambiguous, false, "the original still matches");
  assert.deepEqual(describeRepo(w.mem, w.repoId).aliases, ["github.com/acme/widgets-renamed"]);
  assert.equal(resolveAmbiguity(w.mem, "/c/w", "same").code, "REPO_NO_AMBIGUITY");
});

test("resolving as 'new' binds the clone to the new remote's repository and leaves the old history where it was", () => {
  const w = world({ remote: "https://github.com/acme/widgets.git", cloneKey: "/c/w" });
  const ambiguous = resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/other/thing.git" });
  const resolved = resolveAmbiguity(w.mem, "/c/w", "new");
  assert.equal(resolved.ok, true);
  assert.notEqual(resolved.repoId, w.repoId);
  assert.equal(resolved.repoId, resolveRepoIdentity(w.mem, { cloneKey: "/elsewhere", remote: "git@github.com:other/thing" }).repoId, "the id is the new remote's own");
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/other/thing.git" }).repoId, resolved.repoId);
  assert.ok(ambiguous.ambiguous);
  assert.equal(resolveAmbiguity(w.mem, "/c/w", "bogus").ok, false);
});

test("'same' is refused when the new remote already belongs to another repository (no merging)", () => {
  const w = world({ remote: "https://github.com/acme/widgets.git", cloneKey: "/c/w" });
  const theirs = resolveRepoIdentity(w.mem, { cloneKey: "/c/other", remote: "https://github.com/acme/other.git" });
  resolveRepoIdentity(w.mem, { cloneKey: "/c/w", remote: "https://github.com/acme/other.git" });
  const refused = resolveAmbiguity(w.mem, "/c/w", "same");
  assert.deepEqual([refused.ok, refused.code], [false, "REPO_ALIAS_CONFLICT"]);
  const asNew = resolveAmbiguity(w.mem, "/c/w", "new");
  assert.equal(asNew.repoId, theirs.repoId);
});

test("git worktrees of one clone share a repository id; a different clone with another remote does not", async () => {
  const w = world();
  const env = { PATH: process.env.PATH, Path: process.env.Path, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const main = tempDir("aw-mem-git-");
  git(main, "init", "-b", "main");
  writeFileSync(join(main, "a.txt"), "x\n");
  git(main, "add", "a.txt");
  git(main, "commit", "-m", "init");
  git(main, "remote", "add", "origin", "https://ci:tok@github.com/acme/app.git");
  const tree = join(tempDir("aw-mem-wt-"), "wt");
  git(main, "worktree", "add", "-b", "feature", tree);
  const keyOf = async (cwd) => (await resolveRepo({ cwd, env })).key;
  assert.equal(await keyOf(main), await keyOf(tree));
  const a = resolveRepoIdentity(w.mem, { cloneKey: await keyOf(main), remote: "https://github.com/acme/app.git" });
  const b = resolveRepoIdentity(w.mem, { cloneKey: await keyOf(tree), remote: "https://github.com/acme/app.git" });
  assert.equal(a.repoId, b.repoId);
  assert.equal(describeRepo(w.mem, a.repoId).clones, 1, "one clone key for all worktrees");
});
