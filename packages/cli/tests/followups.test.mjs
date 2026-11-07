// Follow-up hardening: config show --strict (exit 4), one JSON writer, sanitizer string sequences,
// trust preview/lock, gh environment, Ctrl+D, Node guard, remediation quoting.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { stringifyJson } from "../src/json.mjs";
import { ghEnv, listRepositories } from "../src/repo.mjs";
import { quoteArg, sanitizeForTerminal, sanitizeLines, suggestCommand } from "../src/redact.mjs";
import { assertTrusted, classifyExecutableConfig, classifyExecutableFromStatus, grantTrust, revokeTrust, TrustError, trustStatus } from "../src/trust.mjs";
import { createInput } from "../src/tui/input.mjs";
import { askYesNo, createSession, pickOne, withTerminal } from "../src/tui/session.mjs";
import { createTerminal } from "../src/tui/terminal.mjs";
import { checkNodeVersion } from "../scripts/node-guard.mjs";
import { cleanupTemp, fakeSpawn, fakeTerminal, ghReply, git, makeClone, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const binPath = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const childPath = fileURLToPath(new URL("./trust-lock-child.mjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-followups-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let nextId = 0;

const ch = (codePoint) => String.fromCodePoint(codePoint);
const hex = (codePoint) => `${"\\"}u${codePoint.toString(16).padStart(4, "0")}`;
const RAW_UNSAFE = (codePoint) =>
  (codePoint >= 0x7f && codePoint <= 0x9f) || codePoint === 0x61c || codePoint === 0x200e || codePoint === 0x200f || codePoint === 0x2028 || codePoint === 0x2029 ||
  (codePoint >= 0x202a && codePoint <= 0x202e) || (codePoint >= 0x2066 && codePoint <= 0x2069);
const hasRawUnsafe = (text) => [...text].some((char) => RAW_UNSAFE(char.codePointAt(0)));

function box() {
  const dir = join(root, `case-${nextId++}`);
  const paths = { dir, userDir: join(dir, "user"), home: join(dir, "home") };
  for (const path of [paths.userDir, paths.home]) mkdirSync(path, { recursive: true });
  return paths;
}

function bin(args, sandbox, cwd = sandbox.dir) {
  const env = { ...process.env, ASTERWEAVE_CONFIG_DIR: sandbox.userDir, HOME: sandbox.home, USERPROFILE: sandbox.home };
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, env, input: "", encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

function gateRepo(sandbox, { name = "my repo", gate = true } = {}) {
  const repo = join(sandbox.dir, name);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const adapter = gate ? { version: 1, qualityGates: { required: [{ id: "g", command: "SECRET_CMD_MARKER --x", source: "test" }] } } : { version: 1 };
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify(adapter));
  return repo;
}

// --- 1. config show --strict -------------------------------------------------------------------------

test("config show --strict: untrusted executable config exits 4 (text and JSON), trust grant makes it 0, a byte change makes it 4 again", () => {
  const sandbox = box();
  const repo = gateRepo(sandbox);

  const plain = bin(["config", "show", "--path", repo], sandbox);
  assert.equal(plain.code, 0, "default config show is unchanged");
  assert.match(plain.out, /skipped because the repository is not trusted/);

  const strict = bin(["config", "show", "--strict", "--path", repo], sandbox);
  assert.equal(strict.code, 4);
  assert.equal(strict.out, "");
  assert.match(strict.err, /untrusted/);
  assert.match(strict.err, /asterweave trust grant --path (?:'[^\n]*my repo'|"[^\n]*my repo")/, "quoted because of the space: single quotes on POSIX, double quotes on Windows");
  assert.equal((strict.out + strict.err).includes("SECRET_CMD_MARKER"), false);

  const json = bin(["config", "show", "--strict", "--json", "--path", repo], sandbox);
  assert.equal(json.code, 4);
  const envelope = JSON.parse(json.out);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error.code, "TRUST_REQUIRED");
  assert.match(envelope.error.remediation, /trust grant --path/);
  assert.equal(json.out.includes("SECRET_CMD_MARKER"), false);
  assert.equal(json.err, "");

  assert.equal(bin(["trust", "grant", "--path", repo], sandbox).code, 0);
  const trusted = bin(["config", "show", "--strict", "--path", repo], sandbox);
  assert.equal(trusted.code, 0, trusted.err);

  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, qualityGates: { required: [{ id: "g", command: "SECRET_CMD_MARKER --y", source: "test" }] } }));
  assert.equal(bin(["config", "show", "--strict", "--path", repo], sandbox).code, 4, "a byte change makes the repository untrusted again");
});

test("config show --strict: a repository without executable config, or settings-only untrusted, behaves as documented", () => {
  const sandbox = box();
  const clean = gateRepo(sandbox, { name: "clean", gate: false });
  assert.equal(bin(["config", "show", "--strict", "--path", clean], sandbox).code, 0);
  const empty = join(sandbox.dir, "empty");
  mkdirSync(empty);
  assert.equal(bin(["config", "show", "--strict", "--path", empty], sandbox).code, 0);
  writeFileSync(join(clean, ".mcp.json"), "{}");
  assert.equal(bin(["config", "show", "--strict", "--path", clean], sandbox).code, 4, "an untrusted MCP file is executable config too");
});

// --- 2. one JSON writer ----------------------------------------------------------------------------------

test("stringifyJson escapes C1, bidi and line separators in values and keys, and round-trips", () => {
  const nasty = [0x7f, 0x85, 0x9b, 0x9f, 0x61c, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0x2028, 0x2029].map(ch).join("");
  const value = { [`k${nasty}`]: [`v${nasty}`], plain: "ok é" };
  const text = stringifyJson(value);
  assert.equal(hasRawUnsafe(text), false);
  assert.ok(text.includes(hex(0x9b)) && text.includes(hex(0x202e)) && text.includes(hex(0x2028)));
  assert.deepEqual(JSON.parse(text), value);
  assert.equal(stringifyJson(undefined), undefined);
});

test("no source file writes to a stream with a bare JSON.stringify (only the shared writer, stored files and text display remain)", () => {
  const allowed = { "json.mjs": 1, "store.mjs": 1, "config.mjs": 1, "commands/config.mjs": 1, "trust.mjs": 1 }; // stringifyJson itself, files on disk (store, lock body), text display
  const counts = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".mjs")) {
        const code = readFileSync(full, "utf8").split(/\r?\n/).filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
        const found = code.split("JSON.stringify(").length - 1;
        if (found > 0) counts[relative(srcDir, full).replaceAll("\\", "/")] = found;
      }
    }
  };
  walk(srcDir);
  assert.deepEqual(counts, allowed);
});

test("repo connect / repo status --json and the error envelope carry hostile ref names only as escapes", async () => {
  const clone = makeClone();
  const cfg = tempDir("aw-cfg-");
  const env = { ...process.env, ASTERWEAVE_CONFIG_DIR: cfg };
  const hostileBranch = `x${ch(0x9b)}${ch(0x202e)}y`;
  git(clone, "update-ref", `refs/heads/${hostileBranch}`, "HEAD");
  const lineSep = `a${ch(0x2028)}b`;
  git(clone, "update-ref", `refs/heads/${lineSep}`, "HEAD");

  const run = async (args) => {
    const term = fakeTerminal({ tty: false });
    const code = await runCli(args, { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd: clone });
    return { code, out: term.text(), err: term.errText() };
  };

  const connect = await run(["repo", "connect", "--json", "--repo", "acme/widgets", "--branch", hostileBranch, "--path", clone]);
  assert.equal(connect.code, 0, connect.out + connect.err);
  assert.equal(hasRawUnsafe(connect.out), false);
  assert.ok(connect.out.includes(hex(0x9b)) && connect.out.includes(hex(0x202e)));
  assert.equal(JSON.parse(connect.out).branch, hostileBranch);

  git(clone, "symbolic-ref", "HEAD", `refs/heads/${lineSep}`);
  const status = await run(["repo", "status", "--json"]);
  assert.equal(status.code, 0, status.out + status.err);
  assert.equal(hasRawUnsafe(status.out), false);
  assert.ok(status.out.includes(hex(0x2028)), "currentBranch is escaped");
  assert.equal(JSON.parse(status.out).currentBranch, lineSep);

  const missing = await run(["repo", "connect", "--json", "--repo", "acme/widgets", "--branch", `nope${ch(0x202e)}${ch(0x9b)}`, "--path", clone]);
  assert.equal(missing.code, 1);
  assert.equal(hasRawUnsafe(missing.out), false, "the error envelope is escaped too");
  assert.equal(JSON.parse(missing.out).error.code, "REPO_BRANCH_NOT_FOUND");
});

// --- 3. sanitiser string sequences ----------------------------------------------------------------------------

test("sanitizeForTerminal: 8-bit ST ends a string sequence, a newline never is consumed", () => {
  assert.equal(sanitizeForTerminal("a\x1b]52;c;x\x9cVISIBLE"), "aVISIBLE");
  assert.equal(sanitizeForTerminal("a\x9d52;c;x\x9cVISIBLE"), "aVISIBLE");
  const block = "Trust /repo? \x1b]52;c;QUJD\n[y/N] \nFindings:\n  1 quality-gate command(s)\n";
  const clean = sanitizeForTerminal(block);
  assert.ok(clean.includes("\n[y/N] \nFindings:\n  1 quality-gate command(s)\n"), JSON.stringify(clean));
  assert.ok(clean.startsWith("Trust /repo? ?"), "a visible marker where the unterminated sequence was removed");
  assert.equal(sanitizeForTerminal("a\x1b\nb"), "a\nb", "a lone ESC never swallows the newline");
  assert.equal(sanitizeForTerminal("a\x1bPq;data\nVISIBLE"), "a?\nVISIBLE", "DCS");
  assert.equal(sanitizeForTerminal("a\x1b_apc\nVISIBLE"), "a?\nVISIBLE", "APC");
  assert.equal(sanitizeForTerminal("x\x1b]0;t"), "x", "at the very end of the input there is nothing left to hide, so no marker");
  assert.equal(sanitizeLines(["x\x1b]0;t", "[y/N]"]), "x?\n[y/N]", "per-line sanitising keeps the visible marker for an unterminated sequence at the end of a line");
  assert.equal(sanitizeLines("a\x1bPq;data\nb\x9d52;c;x"), "a?\nb?", "DCS and 8-bit OSC, as a block");
  assert.equal(sanitizeLines(["ok\x1b]0;t\x07done"]), "okdone", "a terminated sequence leaves no marker");
});

test("trust grant preview keeps every line when a path contains an unterminated OSC", { skip: process.platform === "win32" && "ESC cannot appear in a Windows file name" }, async () => {
  const sandbox = box();
  const repo = gateRepo(sandbox, { name: "r\x1b]52;c;QUJD" });
  const term = fakeTerminal({ tty: false });
  const code = await runCli(["trust", "grant", "--path", repo], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: { ...process.env, ASTERWEAVE_CONFIG_DIR: sandbox.userDir }, cwd: sandbox.dir });
  assert.equal(code, 0, term.errText());
  const out = term.text();
  assert.match(out, /Executable repository config found:/);
  assert.match(out, /Any change to those files makes the repository untrusted again\./);
  assert.match(out, /Trusted /);
});

// --- 4. trust preview from hashed bytes; store lock ----------------------------------------------------------

test("trust status findings come from the bytes that were hashed, not from a second read", async () => {
  const sandbox = box();
  const repo = gateRepo(sandbox);
  const two = { version: 1, qualityGates: { required: [{ id: "a", command: "one", source: "t" }, { id: "b", command: "two", source: "t" }] } };
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify(two));
  let reads = 0;
  const fs = {
    ...nodeFs,
    readFileSync(file, ...rest) {
      if (String(file).replaceAll("\\", "/").endsWith(".claude/asterweave.json")) {
        reads += 1;
        if (reads > 1) return Buffer.from(JSON.stringify({ version: 1 }));
      }
      return nodeFs.readFileSync(file, ...rest);
    },
  };
  const term = fakeTerminal({ tty: false });
  const code = await runCli(["trust", "status", "--json", "--path", repo], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: { ...process.env, ASTERWEAVE_CONFIG_DIR: sandbox.userDir }, cwd: sandbox.dir, fs });
  assert.equal(code, 0, term.errText());
  assert.equal(JSON.parse(term.text()).executable.filter((item) => item.kind === "command").length, 2);
});

function plainRepo(name = "repo") {
  const repo = join(tempDir("aw-lock-"), name);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1 }));
  return repo;
}

test("two concurrent grants for different repositories both persist (sidecar lock), and the overlap really happened", async () => {
  const dir = tempDir("aw-store-");
  const trustFile = join(dir, "trust.json");
  const goFile = join(dir, "go");
  const repos = [plainRepo("one"), plainRepo("two")];
  const children = repos.map((repo) => {
    const child = spawn(process.execPath, [childPath, trustFile, repo, "600", goFile], { stdio: ["ignore", "pipe", "pipe"] });
    const state = { out: "", err: "" };
    const finished = new Promise((resolve) => child.on("close", (code) => resolve({ code, out: state.out, err: state.err })));
    child.stdout.on("data", (data) => { state.out += data; });
    child.stderr.on("data", (data) => { state.err += data; });
    return { state, finished };
  });
  // Barrier: both children are running and polling for the go file; one write releases them together.
  await waitFor(() => children.every(({ state }) => state.out.includes("ready")), { label: "both children started" });
  writeFileSync(goFile, "go");
  const results = await Promise.all(children.map(({ finished }) => finished));
  assert.deepEqual(results.map((item) => item.code), [0, 0], JSON.stringify(results));
  const waiters = results.filter((item) => item.out.includes("waited")).length;
  assert.ok(waiters >= 1, `the lock made one child back off (otherwise the grants never overlapped): ${JSON.stringify(results)}`);
  const store = JSON.parse(readFileSync(trustFile, "utf8"));
  assert.equal(Object.keys(store).length, 2, `both repositories are trusted: ${JSON.stringify(Object.keys(store))}`);
  assert.equal(nodeFs.existsSync(`${trustFile}.lock`), false, "lock released");
});

test("a held lock times out with TRUST_STORE_BUSY (exit 1) and is left alone; a stale lock is taken over", () => {
  const trustFile = join(tempDir("aw-store-"), "trust.json");
  const repo = plainRepo();
  const lock = `${trustFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now(), token: "someone-else" }));
  assert.throws(
    () => grantTrust(repo, { trustFile, lockTimeoutMs: 60 }),
    (error) => error.code === "TRUST_STORE_BUSY" && error.exitCode === 1 && /remove the stale lock file/.test(error.remediation),
  );
  assert.throws(() => revokeTrust(repo, { trustFile, lockTimeoutMs: 60 }), (error) => error.code === "TRUST_STORE_BUSY");
  assert.equal(nodeFs.existsSync(trustFile), false, "nothing was written");
  assert.match(readFileSync(lock, "utf8"), /someone-else/, "a foreign lock is never removed");

  writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 60_000, token: "dead" }));
  grantTrust(repo, { trustFile, lockTimeoutMs: 60 });
  assert.equal(Object.keys(JSON.parse(readFileSync(trustFile, "utf8"))).length, 1);
  assert.equal(nodeFs.existsSync(lock), false, "released after the takeover");
});

test("the lock is released when the update fails", () => {
  const dir = tempDir("aw-store-");
  const trustFile = join(dir, "trust.json");
  mkdirSync(trustFile); // a directory: reading the store fails (STORE_UNREADABLE)
  assert.throws(() => grantTrust(plainRepo(), { trustFile }), (error) => error.code === "STORE_UNREADABLE");
  assert.equal(nodeFs.existsSync(`${trustFile}.lock`), false);
});

const errno = (code) => Object.assign(new Error(code), { code });

test("a lock that cannot be created and reads as missing ends in TRUST_STORE_BUSY within the timeout (no spin)", { timeout: 15_000 }, () => {
  for (const onDisk of [false, true]) {
    const trustFile = join(tempDir("aw-store-"), "trust.json");
    const lock = `${trustFile}.lock`;
    if (onDisk) writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now(), token: "someone-else" }));
    const fs = {
      ...nodeFs,
      writeFileSync(file, ...rest) {
        if (String(file) === lock) throw errno("EEXIST");
        return nodeFs.writeFileSync(file, ...rest);
      },
      readFileSync(file, ...rest) {
        if (String(file) === lock) throw errno("ENOENT");
        return nodeFs.readFileSync(file, ...rest);
      },
    };
    const sleeps = [];
    assert.throws(
      () => grantTrust(plainRepo(), { trustFile, fs, lockTimeoutMs: 60, sleep: (ms) => sleeps.push(ms) }),
      (error) => error.code === "TRUST_STORE_BUSY" && /remove the stale lock file/.test(error.remediation),
      `lock on disk: ${onDisk}`,
    );
    assert.ok(sleeps.length > 0, "every retry sleeps");
    assert.equal(sleeps.reduce((sum, ms) => sum + ms, 0), 60, "the waits add up to the timeout, no more");
  }
});

test("an unreadable (non-ENOENT) lock is held, not stale; EPERM is contention only on win32", { timeout: 15_000 }, () => {
  const trustFile = join(tempDir("aw-store-"), "trust.json");
  const lock = `${trustFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 600_000, token: "old" }));
  const unreadable = { ...nodeFs, readFileSync: (file, ...rest) => (String(file) === lock ? (() => { throw errno("EACCES"); })() : nodeFs.readFileSync(file, ...rest)) };
  assert.throws(() => grantTrust(plainRepo(), { trustFile, fs: unreadable, lockTimeoutMs: 40, sleep() {} }), (error) => error.code === "TRUST_STORE_BUSY");
  assert.match(readFileSync(lock, "utf8"), /"old"/, "an old lock that cannot be read is left alone");
  rmSync(lock);

  const eperm = { ...nodeFs, writeFileSync: (file, ...rest) => (String(file) === lock ? (() => { throw errno("EPERM"); })() : nodeFs.writeFileSync(file, ...rest)) };
  const sleeps = [];
  assert.throws(
    () => grantTrust(plainRepo(), { trustFile, fs: eperm, platform: "linux", sleep: (ms) => sleeps.push(ms) }),
    (error) => error.code === "STORE_WRITE_FAILED" && error.reason === "WRITE_FAILED",
    "POSIX EPERM is a real permission error",
  );
  assert.deepEqual(sleeps, [], "no 2 s spin");
  assert.throws(() => grantTrust(plainRepo(), { trustFile, fs: eperm, platform: "win32", lockTimeoutMs: 40, sleep() {} }), (error) => error.code === "TRUST_STORE_BUSY");
});

test("a lock path that is not a regular file is refused at once with TRUST_STORE_BUSY and left alone", () => {
  const dir = tempDir("aw-store-");
  const trustFile = join(dir, "trust.json");
  mkdirSync(`${trustFile}.lock`);
  const sleeps = [];
  assert.throws(
    () => grantTrust(plainRepo(), { trustFile, sleep: (ms) => sleeps.push(ms) }),
    (error) => error.code === "TRUST_STORE_BUSY" && /not a regular file/.test(error.message) && /remove/.test(error.remediation),
  );
  assert.deepEqual(sleeps, []);
  assert.ok(nodeFs.statSync(`${trustFile}.lock`).isDirectory());
});

test("two stale-lock takers: the second one never destroys the first one's LIVE lock", { timeout: 15_000 }, () => {
  const dir = tempDir("aw-store-");
  const trustFile = join(dir, "trust.json");
  const lock = `${trustFile}.lock`;
  writeFileSync(lock, JSON.stringify({ pid: 1, at: Date.now() - 60_000, token: "dead" }));
  const liveA = JSON.stringify({ pid: 2, at: Date.now(), token: "aaaa" });
  let interleaved = false;
  // B has already judged the lock stale. Just before B's rename, A removes the stale lock and creates its own.
  const fs = {
    ...nodeFs,
    renameSync(from, to) {
      if (!interleaved && String(from) === lock) {
        interleaved = true;
        nodeFs.unlinkSync(lock);
        nodeFs.writeFileSync(lock, liveA);
      }
      return nodeFs.renameSync(from, to);
    },
  };
  assert.throws(() => grantTrust(plainRepo(), { trustFile, fs, lockTimeoutMs: 40, sleep() {} }), (error) => error.code === "TRUST_STORE_BUSY");
  assert.equal(interleaved, true, "the interleaving happened");
  assert.equal(readFileSync(lock, "utf8"), liveA, "A's live lock is back in place");
  assert.equal(nodeFs.existsSync(trustFile), false, "B did not enter the critical section");
  assert.deepEqual(readdirSync(dir).filter((name) => name.includes(".stale-")), [], "no leftovers");
});

// --- 5. gh environment -----------------------------------------------------------------------------------------

test("gh repo list runs with GH_HOST pinned to github.com and without GH_REPO / enterprise tokens", async () => {
  const spawnSpy = fakeSpawn(ghReply({ stdout: "[]" }));
  const env = { PATH: tempDir("aw-path-"), PATHEXT: ".EXE;.CMD", HOME: "/h", GH_HOST: "ghe.example.com", GH_REPO: "x/y", GH_ENTERPRISE_TOKEN: "t1", GITHUB_ENTERPRISE_TOKEN: "t2", GH_TOKEN: "keep", GITHUB_TOKEN: "keep2", GH_CONFIG_DIR: "/cfg", HTTPS_PROXY: "http://p" };
  await listRepositories({ env, spawn: spawnSpy, exists: () => true, homedir: () => tempDir("aw-home-") });
  const sent = spawnSpy.calls[0].options.env;
  assert.equal(sent.GH_HOST, "github.com");
  for (const key of ["GH_REPO", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]) assert.equal(key in sent, false, key);
  for (const key of ["PATH", "HOME", "GH_TOKEN", "GITHUB_TOKEN", "GH_CONFIG_DIR", "HTTPS_PROXY"]) assert.ok(key in sent, key);
  assert.deepEqual(Object.keys(ghEnv({ gh_repo: "a/b", Gh_Host: "x" })).sort(), ["GH_HOST", "GH_NO_UPDATE_NOTIFIER", "GH_PROMPT_DISABLED", "NO_COLOR"]);
});

// --- 6. Ctrl+D ---------------------------------------------------------------------------------------------------------

function fakeInput() {
  const listeners = new Set();
  return { onKey: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, press: (name, extra) => { for (const l of [...listeners]) l({ name, ...extra }); } };
}

test("Ctrl+D cancels pickers and the y/N prompt like Esc; stream end still interrupts", async () => {
  const draws = [];
  const terminal = { columns: 80, rows: 24, draw: (frame) => draws.push(frame), onResize: () => () => {} };
  for (const [key, expected] of [["ctrl-d", { done: true, cancelled: true }], ["escape", { done: true, cancelled: true }], ["eof", { done: true, interrupted: true }], ["ctrl-c", { done: true, interrupted: true }]]) {
    const input = fakeInput();
    const picked = pickOne({ terminal, input, count: 2, render: () => "frame" });
    input.press(key);
    assert.deepEqual(await picked, expected, key);
  }
  for (const [key, expected] of [["ctrl-d", { yes: false }], ["eof", { interrupted: true }]]) {
    const input = fakeInput();
    const answer = askYesNo({ input });
    input.press(key);
    assert.deepEqual(await answer, expected, key);
  }
});

test("Ctrl+D in the composer exits 0 only with an empty buffer, otherwise does nothing", async () => {
  const term = fakeTerminal();
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const running = withTerminal({ terminal, stdin: term.stdin, proc: new PassThrough() }, ({ input }) => createSession({ terminal, input, repo: "acme/widgets", branch: "main" }).run());
  let settled = false;
  running.then(() => { settled = true; });
  await waitFor(() => term.text().length > 0, { label: "first frame" });
  term.stdin.write("ab");
  await waitFor(() => term.text().includes("> ab"), { label: "typed text" });
  term.stdin.write("\x04");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(settled, false, "Ctrl+D with text in the composer does not exit");
  term.stdin.write("c");
  await waitFor(() => term.text().includes("> abc"), { label: "the buffer was untouched by Ctrl+D" });
  term.stdin.write("\x7f\x7f\x7f");
  await new Promise((resolve) => setTimeout(resolve, 100));
  term.stdin.write("\x04");
  assert.equal(await running, 0);
});

test("createInput reports Ctrl+D as ctrl-d and stream end as eof", () => {
  const stdin = new PassThrough();
  const input = createInput({ stdin });
  const events = [];
  input.onKey((event) => events.push(event.name));
  stdin.write("\x04");
  stdin.end();
  return new Promise((resolve) => setImmediate(() => { assert.deepEqual(events, ["ctrl-d", "eof"]); input.close(); resolve(); }));
});

// --- 7. Node guard ---------------------------------------------------------------------------------------------------------

test("the CLI test runner refuses Node older than 22 with a clear message", () => {
  assert.equal(checkNodeVersion("22.0.0").ok, true);
  assert.equal(checkNodeVersion("24.1.2").ok, true);
  for (const version of ["18.19.0", "20.11.1", "21.7.3", "nonsense"]) {
    const result = checkNodeVersion(version);
    assert.equal(result.ok, false, version);
    assert.match(result.message, /need Node\.js 22 or newer/);
  }
  const runner = readFileSync(fileURLToPath(new URL("../scripts/run-tests.mjs", import.meta.url)), "utf8");
  assert.match(runner, /checkNodeVersion\(\)/);
  assert.match(runner, /process\.exitCode = 1/);
});

// --- 8. remediation quoting ------------------------------------------------------------------------------------------------

test("quoteArg on POSIX single-quotes anything with shell-active characters and never uses double quotes", () => {
  const hostile = "/tmp/a b/$(touch x)/`id`/it's";
  assert.equal(quoteArg(hostile, "linux"), "'/tmp/a b/$(touch x)/`id`/it'\\''s'");
  assert.equal(quoteArg("/plain/path-1_2.x", "linux"), "/plain/path-1_2.x");
  assert.equal(quoteArg("-rf", "linux"), "'-rf'");
  assert.equal(quoteArg("", "linux"), "''");
});

test("quoteArg on win32: bare when path-safe, double quotes for cmd.exe and PowerShell, no inline form when a shell would still expand", () => {
  assert.equal(quoteArg("C:\\Users\\me\\repo", "win32"), "C:\\Users\\me\\repo");
  assert.equal(quoteArg("C:\\a b\\repo", "win32"), '"C:\\a b\\repo"');
  assert.equal(quoteArg("C:\\a&b\\^c (x);d", "win32"), '"C:\\a&b\\^c (x);d"');
  assert.equal(quoteArg("C:\\it's", "win32"), '"C:\\it\'s"');
  assert.equal(quoteArg("C:\\a,b", "win32"), '"C:\\a,b"', "a comma is not bare: PowerShell reads it as an array operator");
  assert.equal(quoteArg("-rf", "win32"), '"-rf"');
  for (const unsafe of ["C:\\%PATH%\\x", "C:\\!x!", "C:\\$(x)", "C:\\a`b", 'C:\\say "hi"', `C:\\${ch(0x201c)}x${ch(0x201d)}`, "C:\\a dir\\", "C:\\a\u0007b"]) {
    assert.equal(quoteArg(unsafe, "win32"), null, JSON.stringify(unsafe));
  }
  assert.equal(suggestCommand("run: x --path ", "C:\\a b", " now", "win32"), 'run: x --path "C:\\a b" now');
  assert.equal(suggestCommand("run: x --path ", "/a b", "", "linux"), "run: x --path '/a b'");
  const fallback = suggestCommand("run: x --path ", "C:\\%PATH%\\x", " now", "win32");
  assert.equal(fallback.split("\n")[0], "run: x --path <path> now", "the value is never embedded in the command line");
  assert.match(fallback, /quote this path for your shell/);
  assert.equal(fallback.split("\n").at(-1).trim(), "C:\\%PATH%\\x", "the path is on its own line");
});

test("quoteArg output reaches a real program as exactly one unchanged argument through cmd.exe and PowerShell", { skip: process.platform !== "win32" && "needs cmd.exe and PowerShell" }, () => {
  const script = join(root, "print-argv.mjs");
  writeFileSync(script, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  const values = ["C:\\a b\\repo", "C:\\a&b", "C:\\a^b", "C:\\a,b", "C:\\it's here", "C:\\(x) y;z", "C:\\100%", "C:\\%PATH%", "C:\\!x!", "C:\\$(calc)", "C:\\a`b", 'C:\\say "hi"', "C:\\plain\\dir", "-rf x", "C:\\a=b+c@d"];
  const inline = values.map((value) => ({ value, quoted: quoteArg(value, "win32") }));
  assert.ok(inline.filter((item) => item.quoted !== null).length >= 8, "most values can be quoted inline");
  assert.ok(inline.filter((item) => item.quoted === null).length >= 4, "the rest take the no-inline fallback");
  const node = process.execPath;
  for (const { value, quoted } of inline) {
    if (quoted === null) continue;
    const cmd = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${node}" "${script}" ${quoted}"`], { encoding: "utf8", windowsVerbatimArguments: true });
    assert.deepEqual(JSON.parse(cmd.stdout || "null"), [value], `cmd.exe: ${quoted} -> ${cmd.stdout}${cmd.stderr}`);
  }
  const lines = inline.filter((item) => item.quoted !== null).map(({ quoted }) => `& '${node}' '${script}' ${quoted}`).join("\n");
  const ps = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(lines, "utf16le").toString("base64")], { encoding: "utf8" });
  const printed = ps.stdout.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(printed, inline.filter((item) => item.quoted !== null).map(({ value }) => [value]), `PowerShell: ${ps.stdout}${ps.stderr}`);
});

test("assertTrusted remediation quotes a hostile repository path, or leaves it out of the command line when no quoting is safe", () => {
  const base = tempDir("aw-quote-");
  const repo = join(base, "a b $(touch x) `id` it's");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1 }));
  const trustFile = join(base, "trust.json");
  let remediation;
  try {
    assertTrusted(repo, "run quality gates", { trustFile });
  } catch (error) {
    assert.ok(error instanceof TrustError);
    remediation = error.remediation;
  }
  const real = realpathSync.native(repo);
  if (process.platform === "win32") {
    assert.equal(quoteArg(real), null, "`$` and a backtick are still expanded inside PowerShell double quotes");
    assert.match(remediation.split("\n")[0], /asterweave trust grant --path <path>$/);
    assert.equal(remediation.split("\n").at(-1).trim(), real);
    assert.match(remediation, /quote this path for your shell/);
  } else {
    assert.ok(remediation.endsWith(`asterweave trust grant --path ${quoteArg(real)}`), remediation);
    assert.ok(remediation.includes("'") && !remediation.includes('"'), remediation);
  }
});

test("trust status and config show print the grant command with the same quoting (and fallback) for a hostile path", () => {
  const sandbox = box();
  const repo = gateRepo(sandbox, { name: "a b $(touch x) `id` it's" });
  const real = realpathSync.native(repo);
  for (const args of [["trust", "status", "--path", repo], ["config", "show", "--path", repo]]) {
    const { code, out } = bin(args, sandbox);
    assert.equal(code, 0, out);
    const lines = out.split(/\r?\n/);
    const index = lines.findIndex((line) => line.includes("asterweave trust grant --path"));
    assert.ok(index >= 0, `${args[0]}: ${out}`);
    if (process.platform === "win32") {
      assert.match(lines[index], /--path <path>$/, args[0]);
      assert.equal(lines[index + 2].trim(), real, `${args[0]}: the path is on its own line`);
      assert.equal(lines[index].includes("$(touch x)"), false);
    } else {
      assert.ok(lines[index].endsWith(`--path ${quoteArg(real)}`), `${args[0]}: ${lines[index]}`);
    }
  }
});

// --- 9. classifier agreement -------------------------------------------------------------------------------------------------

test("classifyExecutableConfig and classifyExecutableFromStatus agree on unreadable settings and MCP files (fail-closed)", () => {
  const base = tempDir("aw-classify-");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".claude", "settings.json"), { recursive: true }); // a directory: reading it fails with EISDIR
  mkdirSync(join(repo, ".mcp.json"));
  const trustFile = join(base, "trust.json");
  const fromRepo = classifyExecutableConfig(repo);
  const fromStatus = classifyExecutableFromStatus(trustStatus(repo, { trustFile }));
  const byField = (list) => [...list].sort((a, b) => a.field.localeCompare(b.field));
  assert.deepEqual(byField(fromRepo), byField(fromStatus));
  assert.deepEqual(byField(fromRepo).map((item) => item.field), [".claude/settings.json", ".mcp.json"], "both count as findings");
});

test("an unreadable (mode 000) settings file is a finding in both classifiers", { skip: (process.platform === "win32" || process.getuid?.() === 0) && "needs POSIX permissions and a non-root user" }, () => {
  const base = tempDir("aw-classify-");
  const repo = join(base, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const settings = join(repo, ".claude", "settings.local.json");
  writeFileSync(settings, "{}");
  nodeFs.chmodSync(settings, 0);
  try {
    const fromRepo = classifyExecutableConfig(repo);
    const fromStatus = classifyExecutableFromStatus(trustStatus(repo, { trustFile: join(base, "trust.json") }));
    assert.deepEqual(fromRepo, fromStatus);
    assert.deepEqual(fromRepo.map((item) => item.field), [".claude/settings.local.json"]);
  } finally {
    nodeFs.chmodSync(settings, 0o600);
  }
});
