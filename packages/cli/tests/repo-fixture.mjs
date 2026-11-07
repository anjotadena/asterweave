// Shared test helpers for the repo tests (not a test file: the runner only picks *.test.mjs).
// Builds REAL git repositories in temp directories; nothing touches the network.

import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { spawn as nodeSpawn } from "node:child_process";
import { isExecutableFile } from "../src/proc.mjs";

const temporary = [];

export function tempDir(prefix = "aw-repo-") {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temporary.push(dir);
  return dir;
}

export function cleanupTemp() {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

export function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=tester@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * A clone-like repository: branches main (default), dev, feature/x locally; origin/main,
 * origin/dev and origin/release as remote-tracking refs (no network); origin/HEAD -> origin/main.
 */
export function makeClone({ origin = "https://github.com/acme/widgets.git" } = {}) {
  const dir = tempDir();
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-m", "initial");
  git(dir, "branch", "dev");
  git(dir, "branch", "feature/x");
  if (origin) git(dir, "remote", "add", "origin", origin);
  for (const name of ["main", "dev", "release"]) git(dir, "update-ref", `refs/remotes/origin/${name}`, "HEAD");
  git(dir, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return dir;
}

/** Everything a read-only operation must leave untouched. */
export function snapshot(dir) {
  return {
    head: git(dir, "rev-parse", "HEAD").trim(),
    branch: git(dir, "rev-parse", "--abbrev-ref", "HEAD").trim(),
    status: git(dir, "status", "--porcelain"),
    branches: git(dir, "branch", "-a"),
    config: git(dir, "config", "--local", "--list"),
  };
}

// --- fake processes and terminals --------------------------------------------------------------

export function fakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), { end() {} });
  child.kill = () => true;
  return child;
}

/** spawn that answers every call from `script(child, {cmd, args, options})`. */
export function fakeSpawn(script) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    const child = fakeChild();
    calls.push({ cmd, args, options });
    queueMicrotask(() => script(child, { cmd, args, options }));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

export const ghReply = ({ stdout = "", stderr = "", code = 0 } = {}) => (child) => {
  if (stdout) child.stdout.emit("data", Buffer.from(stdout));
  if (stderr) child.stderr.emit("data", Buffer.from(stderr));
  child.emit("close", code, null);
};

/** spawn that fakes only `gh` and runs everything else (git) for real. */
export function ghOnlySpawn(reply) {
  const ghCalls = [];
  const spawn = (cmd, args, options) => {
    if (!/^gh(\.(exe|com))?$/i.test(basename(cmd))) return nodeSpawn(cmd, args, options);
    const child = fakeChild();
    ghCalls.push({ cmd, args, options });
    queueMicrotask(() => reply(child));
    return child;
  };
  spawn.ghCalls = ghCalls;
  return spawn;
}

/** `exists` that pretends gh is installed everywhere and checks real files for anything else. */
export const ghInstalled = (file) => (/(^|[\\/])gh(\.(exe|com))?$/i.test(file) ? true : isExecutableFile(file));

export function fakeTerminal({ tty = true, columns = 100, rows = 30 } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty, rawCalls: [], setRawMode(value) { this.rawCalls.push(value); } });
  const out = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: tty, columns, rows, write: (text) => { out.push(String(text)); return true; } });
  const err = [];
  const stderr = Object.assign(new EventEmitter(), { isTTY: tty, write: (text) => { err.push(String(text)); return true; } });
  return { stdin, stdout, stderr, text: () => out.join(""), errText: () => err.join("") };
}

export async function waitFor(predicate, { timeoutMs = 5000, label = "condition" } = {}) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
