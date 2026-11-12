// The `asterweave memory` commands resolve repository identity like `run` does: a git failure reading `origin` is never taken for
// "no remote" (no false changed-remote ambiguity is recorded and nothing is written), and a different-history ambiguity is worded as
// such. Real git in temp directories; the failure is simulated through the spawn seam for `git remote get-url` only.

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { openMemory } from "../src/runtime/memory/db.mjs";
import { cleanupAll, git, makeClock, sink, T0, tempDir, track } from "./memory-fixture.mjs";

after(cleanupAll);

function makeRepo({ remote = null } = {}) {
  const dir = join(tempDir("aw-mcmd-"), "widgets");
  mkdirSync(dir);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial", "--date=2025-01-01T00:00:00Z");
  if (remote) git(dir, "remote", "add", "origin", remote);
  return dir;
}

// Fails only `git ... remote get-url origin` (as an unreadable config or a crashing git would), everything else is real.
const failingOrigin = (cmd, args, opts) => (Array.isArray(args) && args.includes("get-url")
  ? nodeSpawn(process.execPath, ["-e", "process.stderr.write('fatal: simulated git failure'); process.exit(128)"], { ...opts, shell: false })
  : nodeSpawn(cmd, args, opts));

function world(repo) {
  const userDir = tempDir("aw-mcmd-user-");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  const now = makeClock(T0);
  const cli = async (argv, extra = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["memory", ...argv], { stdout: out, stderr: err, stdin: { isTTY: false }, env, cwd: repo, now, ...extra });
    return { code, out: out.text(), err: err.text() };
  };
  const ambiguities = () => {
    const mem = track(openMemory({ userDir, now }));
    try {
      return mem.db.prepare("SELECT COUNT(*) AS n FROM repo_ambiguities").get().n;
    } finally {
      mem.close();
    }
  };
  return { userDir, cli, ambiguities };
}

test("a git failure reading origin records no ambiguity: repo and import refuse, status and search warn, nothing is written", async () => {
  const repo = makeRepo({ remote: "https://github.com/acme/widgets.git" });
  const w = world(repo);
  const bound = await w.cli(["repo", "--json"]);
  assert.equal(bound.code, 0, bound.err);
  assert.equal(JSON.parse(bound.out).memory?.repo?.ambiguous ?? false, false);
  assert.equal(w.ambiguities(), 0);

  const repoCmd = await w.cli(["repo"], { spawn: failingOrigin });
  assert.notEqual(repoCmd.code, 0, "repo refuses instead of acting on an unreadable identity");
  assert.match(repoCmd.err + repoCmd.out, /identity could not be read/);
  const resolve = await w.cli(["repo", "resolve", "new", "--yes"], { spawn: failingOrigin });
  assert.notEqual(resolve.code, 0, "resolve refuses too: nothing to split");
  const status = await w.cli(["status"], { spawn: failingOrigin });
  assert.equal(status.code, 0, status.err);
  assert.match(status.out + status.err, /identity could not be read/);
  const search = await w.cli(["search", "anything", "--json"], { spawn: failingOrigin });
  assert.equal(search.code, 0, search.err);
  assert.doesNotMatch(search.out, /No memory is stored for this repository yet/, "an unreadable identity is not reported as an empty store");
  assert.match(search.out, /identity could not be read/);
  assert.equal(w.ambiguities(), 0, "no false changed-remote ambiguity was recorded");

  const healthy = await w.cli(["repo", "--json"]);
  assert.equal(healthy.code, 0, healthy.err);
  assert.match(healthy.out, /github\.com\/acme\/widgets/);
});

test("a different history at the same path is worded as a history change, not a remote change", async () => {
  const repo = makeRepo();
  const w = world(repo);
  assert.equal((await w.cli(["repo"])).code, 0);
  rmSync(join(repo, ".git"), { recursive: true, force: true });
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "OTHER.md"), "another project\n");
  git(repo, "add", "OTHER.md");
  git(repo, "commit", "-m", "unrelated");
  const status = await w.cli(["status"]);
  assert.equal(status.code, 0, status.err);
  assert.match(status.out + status.err, /different history/);
  assert.doesNotMatch(status.out + status.err, /The remote of this clone changed/);
});
