// H-1: an untrusted clone must never get to run its configured filter drivers, and git must never see
// the parent's secrets. Uses REAL temp git repositories; nothing touches the network.

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runDoctor } from "../src/doctor.mjs";
import { isExecutableFile } from "../src/proc.mjs";
import { connectRepository, gitEnv, listBranches, readOrigin, repoStatus } from "../src/repo.mjs";
import { cleanupTemp, git, makeClone, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const SENTINEL = "sentinel-secret-value";
const posix = (file) => file.replaceAll("\\", "/");

/** Plant a clean-filter driver (via .git/config + .git/info/attributes) that writes a marker file. */
function plantFilter(clone) {
  const dir = tempDir("aw-filter-");
  const marker = join(dir, "ran.txt");
  const script = join(dir, "filter.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); process.stdin.pipe(process.stdout);\n`);
  git(clone, "config", "filter.x.clean", `"${posix(process.execPath)}" "${posix(script)}"`);
  writeFileSync(join(clone, ".git", "info", "attributes"), "* filter=x\n");
  return marker;
}

let tick = 1;
/** Make the tracked file's stat differ from the index so any content-hashing command must re-read it. */
function makeStale(clone) {
  const when = new Date(Date.now() - 3_600_000 - 1000 * tick++);
  utimesSync(join(clone, "README.md"), when, when);
}

function spy() {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args: [...args], env: options.env });
    return nodeSpawn(cmd, args, options);
  };
  spawn.calls = calls;
  return spawn;
}

const hostileEnv = (configDir) => ({
  ...process.env,
  ASTERWEAVE_CONFIG_DIR: configDir,
  GH_TOKEN: SENTINEL,
  GITHUB_TOKEN: SENTINEL,
  ANTHROPIC_API_KEY: SENTINEL,
  MY_SERVICE_SECRET: SENTINEL,
  GIT_SSH_COMMAND: `echo ${SENTINEL}`,
  GIT_EXTERNAL_DIFF: "evil",
  GIT_DIR: join(configDir, "nonexistent"),
});

test("control: plain `git status` DOES run the planted filter on a stale file (the scenario is real)", () => {
  const clone = makeClone();
  const marker = plantFilter(clone);
  makeStale(clone);
  git(clone, "status", "--porcelain");
  assert.equal(existsSync(marker), true, "git status executes filter.<x>.clean for a stale tracked file");
});

test("H-1: connect, repoStatus and doctor never run a clone's filter drivers and report dirty: null", async () => {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone();
  const marker = plantFilter(clone);
  const spawn = spy();
  const env = hostileEnv(configDir);
  const noProviders = (file) => (/(^|[\\/])(gh|claude)(\.exe|\.com|\.cmd|\.bat)?$/i.test(file) ? false : isExecutableFile(file));

  makeStale(clone);
  const connected = await connectRepository({ repository: "acme/widgets", branch: "main", path: clone, env, spawn });
  assert.equal(connected.ok, true);
  assert.equal(connected.dirty, null);
  assert.equal(existsSync(marker), false, "connectRepository ran the filter driver");

  makeStale(clone);
  const status = await repoStatus({ env, spawn });
  assert.equal(status.ok, true);
  assert.equal(status.dirty, null);
  assert.equal(existsSync(marker), false, "repoStatus ran the filter driver");

  makeStale(clone);
  const report = await runDoctor({ env, spawn, exists: noProviders, cwd: clone });
  assert.equal(report.checks.find((check) => check.id === "repo.connection").status, "PASS");
  assert.equal(existsSync(marker), false, "doctor ran the filter driver");

  assert.ok(spawn.calls.length > 0);
  const forbidden = new Set(["status", "diff", "update-index", "add", "ls-files", "stash", "checkout", "reset", "clean"]);
  for (const call of spawn.calls) {
    assert.ok(call.args.includes("--no-pager"), `--no-pager: ${call.args.join(" ")}`);
    assert.ok(!call.args.some((arg) => forbidden.has(arg)), `no content-hashing/mutating git command: ${call.args.join(" ")}`);
  }
  rmSync(marker, { force: true });
});

test("H-1: git children get a minimal environment: no tokens, keys, secrets or inherited GIT_* variables", async () => {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone();
  const spawn = spy();
  const env = hostileEnv(configDir);
  await connectRepository({ repository: "acme/widgets", branch: "main", path: clone, env, spawn });
  await repoStatus({ env, spawn });
  await listBranches(clone, { env, spawn });
  await readOrigin(clone, { env, spawn });
  assert.ok(spawn.calls.length >= 4);
  for (const { env: childEnv } of spawn.calls) {
    for (const [key, value] of Object.entries(childEnv)) {
      assert.ok(!/token|key|secret|^anthropic|^gh_/i.test(key), `unexpected variable ${key}`);
      assert.ok(!String(value).includes(SENTINEL), `${key} leaked the sentinel`);
      if (/^git_/i.test(key)) assert.ok(["GIT_TERMINAL_PROMPT", "GIT_OPTIONAL_LOCKS"].includes(key), `inherited ${key}`);
    }
    assert.equal(childEnv.GIT_TERMINAL_PROMPT, "0");
    assert.equal(childEnv.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(childEnv.LC_ALL, "C");
    assert.ok(Object.keys(childEnv).some((key) => key.toLowerCase() === "path"), "PATH is kept so git can run");
  }
});

test("gitEnv is an allow-list (case-insensitive on Windows-style keys)", () => {
  const out = gitEnv({ Path: "/bin", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\u", TEMP: "t", GH_TOKEN: "x", GIT_DIR: "y", Anything: "z", AWS_SECRET_ACCESS_KEY: "k" });
  assert.deepEqual(Object.keys(out).sort(), ["GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "LC_ALL", "Path", "SystemRoot", "TEMP", "USERPROFILE"]);
});
