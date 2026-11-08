// runClaudeTurn against the scriptable fake claude (a REAL child process on Windows and POSIX). No network, no model.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runClaudeTurn } from "../src/runtime/claude/run.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const temps = [];
const tempDir = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-claude-run-"))); temps.push(dir); return dir; };
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* a just-killed child can hold its cwd on Windows */ } } });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function waitDead(pid, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await sleep(50); }
  return !alive(pid);
}
async function waitFor(file, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (existsSync(file)) { const text = readFileSync(file, "utf8"); if (text.length > 0) return text; } await sleep(25); }
  throw new Error(`timed out waiting for ${file}`);
}
const hostEnv = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", GITHUB_TOKEN: ["ghp", "notreal"].join("_"), NPM_TOKEN: ["npm", "notreal"].join("_"), SSH_AUTH_SOCK: "/s", ASTERWEAVE_RUN_ID: "forged", ANTHROPIC_API_KEY: "key-placeholder" };

/** Run one turn against the fake. Returns {result, dir, record()}. */
async function turn(scenario = {}, options = {}) {
  const dir = tempDir();
  const scenarioFile = join(dir, "scenario.json");
  const recordFile = join(dir, "record.json");
  writeFileSync(scenarioFile, JSON.stringify({ record: recordFile, ...scenario }));
  const result = await runClaudeTurn({
    prompt: "do the thing", cwd: dir, deadlineMs: 20_000, maxOutputBytes: 8 * 1024 * 1024, env: hostEnv,
    claudePath: process.execPath, claudeArgs: [FAKE, "--fake-scenario", scenarioFile], ...options,
  });
  return { result, dir, recordFile, record: () => JSON.parse(readFileSync(recordFile, "utf8")) };
}

test("success: parsed session, model, usage, cost, tool events, exit code", async () => {
  const events = [];
  const { result } = await turn({ toolUses: [{ id: "tu_1", name: "Bash", input: { command: "git status" } }], resultText: "finished" }, { onEvent: (event) => events.push(event.kind) });
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.killed, false);
  assert.equal(result.providerSessionId, SID);
  assert.equal(result.model, "claude-sonnet-5-5");
  assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20, cacheReadTokens: 3, cacheCreationTokens: 4 });
  assert.equal(result.costUsd, 0.0123);
  assert.equal(result.resultText, "finished");
  assert.equal(result.toolEvents.length, 1);
  assert.equal(result.toolEvents[0].name, "Bash");
  assert.equal(result.toolEvents[0].inputSummary, "command=git status");
  assert.equal(result.malformedLines, 0);
  assert.deepEqual(events, ["init", "text", "tool_use", "tool_result", "result"]);
  assert.ok(!JSON.stringify(result).includes("SECRET-OUTPUT"));
});

test("a result without usage keeps every counter unknown (null)", async () => {
  const { result } = await turn({ usage: {} });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });
});

test("stdin: a large multi-byte prompt arrives intact and is never in argv", async () => {
  const prompt = `${"héllo wörld ✓ 😀 ".repeat(150_000)}END`; // about 3 MB
  const { result, record } = await turn({}, { prompt });
  assert.equal(result.ok, true);
  const seen = record();
  assert.equal(seen.stdinBytes, Buffer.byteLength(prompt));
  assert.equal(seen.stdinSha256, createHash("sha256").update(prompt).digest("hex"));
  assert.ok(!seen.argv.some((arg) => arg.includes("héllo")));
});

test("env: secrets never reach the child; correlation variables do", async () => {
  const { result, record } = await turn({}, { extraEnv: { ASTERWEAVE_RUN_ID: "run-9", ASTERWEAVE_SESSION_ID: "sess-9", ASTERWEAVE_CONFIG_DIR: "/cfg" } });
  assert.equal(result.ok, true);
  const { env, envKeys } = record();
  assert.equal(env.ASTERWEAVE_RUN_ID, "run-9");
  assert.equal(env.ASTERWEAVE_SESSION_ID, "sess-9");
  assert.equal(env.ASTERWEAVE_CONFIG_DIR, "/cfg");
  assert.equal(env.ANTHROPIC_API_KEY, "key-placeholder");
  for (const secret of ["GITHUB_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK"]) assert.ok(!envKeys.includes(secret), secret);
});

test("argv reaches the child: new session, resume, fork", async () => {
  const fresh = await turn({}, { sessionId: SID, model: "claude-sonnet-5-5", effort: "high" });
  const argv = fresh.record().argv;
  assert.deepEqual(argv.slice(argv.indexOf("-p")).slice(0, 12), ["-p", "--output-format", "stream-json", "--verbose", "--session-id", SID, "--model", "claude-sonnet-5-5", "--effort", "high", "--permission-mode", "default"]);
  const resumed = await turn({}, { resume: "abcd1234-ef", fork: true });
  const resumedArgv = resumed.record().argv;
  assert.ok(resumedArgv.join(" ").includes("--resume abcd1234-ef --fork-session"));
});

test("invalid options are refused without spawning", async () => {
  let spawned = 0;
  const spawn = () => { spawned += 1; throw new Error("must not spawn"); };
  const cwd = tempDir();
  for (const options of [{ model: "-x" }, { effort: "turbo" }, { permissionMode: "bypassPermissions" }, { prompt: "" }, { cwd: "relative" }, { deadlineMs: 0 }, { maxOutputBytes: 10 }, { extraEnv: { GITHUB_TOKEN: "x" } }, { claudePath: "claude" }]) {
    const result = await runClaudeTurn({ prompt: "p", cwd, claudePath: process.execPath, claudeVersion: "2.1.5", spawn, env: hostEnv, ...options });
    assert.equal(result.ok, false);
    assert.equal(result.error.class, "invalid-request", JSON.stringify(options));
    assert.equal(result.error.retryable, false);
  }
  assert.equal(spawned, 0);
});

test("failure classes from a real exiting child", async () => {
  const cases = [
    [{ mode: "fail", stderr: "API Error: 429 rate limit exceeded\n" }, "rate-limit", true],
    [{ mode: "fail", stderr: "529 overloaded_error\n" }, "overloaded", true],
    [{ mode: "fail", stderr: "API Error: 503 Service Unavailable\n" }, "5xx", true],
    [{ mode: "fail", stderr: "Invalid API key - Please run /login\n" }, "auth", false],
    [{ mode: "fail", stderr: "getaddrinfo ENOTFOUND api.anthropic.com\n" }, "offline", true],
    [{ mode: "fail", stderr: "error: unknown option '--effort'\n" }, "invalid-request", false],
    [{ mode: "fail", stderr: "mystery\n", exitCode: 3 }, "unknown", false],
    [{ mode: "fail", stderr: "", exitCode: 139 }, "crashed", false],
    [{ mode: "error-result", resultText: "API Error: 529 overloaded", exitCode: 0 }, "overloaded", true],
    [{ mode: "no-result" }, "unknown", false],
  ];
  for (const [scenario, expected, retryable] of cases) {
    const { result } = await turn(scenario);
    assert.equal(result.ok, false, JSON.stringify(scenario));
    assert.equal(result.error.class, expected, JSON.stringify(scenario));
    assert.equal(result.error.retryable, retryable);
    assert.ok(result.error.message.length > 0 && result.error.remediation.length > 0);
    assert.equal(result.killed, false);
  }
});

test("stderr tail is bounded, redacted and sanitized", async () => {
  const token = ["gh", "p_", "b".repeat(36)].join("");
  const { result } = await turn({ mode: "fail", stderr: `${"noise ".repeat(5000)}\u001b[2J leaked ${token}\n` });
  assert.ok(result.stderrTail.length <= 8 * 1024);
  assert.ok(!result.stderrTail.includes(token) && !result.stderrTail.includes("\u001b"));
  assert.ok(!JSON.stringify(result.error).includes(token));
});

test("malformed lines are counted and do not fail a turn that has a result; no pollution", async () => {
  const { result } = await turn({ mode: "malformed" });
  assert.equal(result.ok, true);
  assert.equal(result.malformedLines, 5);
  assert.equal({}.polluted, undefined);
});

test("a flood of malformed lines stops the child (crashed)", async () => {
  const { result } = await turn({ mode: "malformed" }, { maxMalformedLines: 2 });
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
  assert.equal(result.error.class, "crashed");
});

test("an over-long line is dropped and counted; the result after it is still read", async () => {
  const { result } = await turn({ mode: "huge-line" });
  assert.equal(result.ok, true);
  assert.equal(result.malformedLines, 1);
});

test("output cap kills the child (output-limit) and does not hang", async () => {
  const { result } = await turn({ mode: "huge-output" }, { maxOutputBytes: 64 * 1024 });
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
  assert.equal(result.error.class, "output-limit");
  assert.equal(result.error.retryable, false);
});

test("deadline kills a hanging child (timeout, retryable)", async () => {
  const started = Date.now();
  const { result } = await turn({ mode: "hang" }, { deadlineMs: 700 });
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
  assert.equal(result.error.class, "timeout");
  assert.equal(result.error.retryable, true);
  assert.ok(Date.now() - started < 15_000);
});

test("deadline kills a child that ignores SIGTERM", async () => {
  const { result } = await turn({ mode: "ignore-sigterm" }, { deadlineMs: 700 });
  assert.equal(result.error.class, "timeout");
  assert.equal(result.killed, true);
});

test("a child that never reads stdin cannot stall the turn (large prompt, EPIPE tolerated)", async () => {
  const { result } = await turn({ mode: "no-stdin-read" }, { prompt: "p".repeat(3 * 1024 * 1024) });
  assert.equal(result.ok, true);
  const hang = await turn({ mode: "hang" }, { prompt: "p".repeat(3 * 1024 * 1024), deadlineMs: 700 });
  assert.equal(hang.result.error.class, "timeout");
});

test("deadline kills the whole process tree: the grandchild is gone", async () => {
  const dir = tempDir();
  const pidFile = join(dir, "grandchild.pid");
  const { result } = await turn({ mode: "grandchild", pidFile }, { deadlineMs: 1500 });
  assert.equal(result.error.class, "timeout");
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(Number.isInteger(pid) && pid > 0);
  assert.ok(await waitDead(pid), "grandchild must not survive");
});

test("abort kills the whole process tree and reports killed (no orphan)", async () => {
  const dir = tempDir();
  const pidFile = join(dir, "grandchild.pid");
  const controller = new AbortController();
  const pending = turn({ mode: "grandchild", pidFile }, { signal: controller.signal });
  const pid = Number(await waitFor(pidFile));
  await sleep(300); // the child has a chance to be fully up
  const started = Date.now();
  controller.abort();
  const { result } = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.killed, true);
  assert.equal(result.error.class, "killed");
  assert.equal(result.error.retryable, false);
  assert.ok(Date.now() - started < 15_000);
  assert.ok(await waitDead(pid), "grandchild must not survive an abort");
});

test("an already aborted signal never spawns", async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = 0;
  const result = await runClaudeTurn({ prompt: "p", cwd: tempDir(), claudePath: process.execPath, claudeVersion: "2.1.5", signal: controller.signal, spawn: () => { spawned += 1; }, env: hostEnv });
  assert.equal(result.error.class, "killed");
  assert.equal(spawned, 0);
});

test("POSIX: a grandchild left behind by a child that exits by itself is reaped", { skip: process.platform === "win32" && "taskkill cannot find the tree of an exited parent (documented limit)" }, async () => {
  const dir = tempDir();
  const pidFile = join(dir, "grandchild.pid");
  const { result } = await turn({ mode: "grandchild", pidFile, exitAfterSpawn: true });
  assert.equal(result.killed, false);
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.ok(await waitDead(pid), "grandchild must be reaped");
});

test("not installed: PATH has no claude, nothing is spawned", async () => {
  let spawned = 0;
  const result = await runClaudeTurn({ prompt: "p", cwd: tempDir(), env: { PATH: tempDir() }, spawn: () => { spawned += 1; } });
  assert.equal(result.ok, false);
  assert.equal(result.error.class, "not-installed");
  assert.equal(result.error.retryable, false);
  assert.equal(spawned, 0);
});

test("not installed: a shell shim alone is never run; relative PATH entries are ignored", async () => {
  const shim = await runClaudeTurn({ prompt: "p", cwd: "C:\\work", platform: "win32", env: { PATH: "C:\\bin", PATHEXT: ".EXE;.CMD" }, exists: (file) => file.endsWith("claude.cmd"), spawn: () => { throw new Error("must not spawn"); } });
  assert.equal(shim.error.class, "not-installed");
  assert.match(shim.error.message, /shell shim/);
  const relative = await runClaudeTurn({ prompt: "p", cwd: "/work", platform: "linux", env: { PATH: ".:bin:" }, exists: () => true, spawn: () => { throw new Error("must not spawn"); } });
  assert.equal(relative.error.class, "not-installed");
});

test("not installed: an absolute claudePath that does not exist", async () => {
  const result = await runClaudeTurn({ prompt: "p", cwd: tempDir(), claudePath: join(tempDir(), process.platform === "win32" ? "claude.exe" : "claude"), env: hostEnv });
  assert.equal(result.error.class, "not-installed");
});

test("version-unsupported: older than the minimum, or unreadable; the turn is not run", async () => {
  for (const version of ["2.0.9 (Claude Code)", "1.0.0", "no version here"]) {
    const { result, recordFile } = await turn({ version });
    assert.equal(result.ok, false, version);
    assert.equal(result.error.class, "version-unsupported", version);
    assert.equal(result.error.retryable, false);
    assert.ok(!existsSync(recordFile), "the turn must not run");
  }
  const ok = await turn({ version: "2.1.0" });
  assert.equal(ok.result.ok, true);
  const trusted = await turn({ version: "0.0.1" }, { claudeVersion: "9.9.9" });
  assert.equal(trusted.result.ok, true);
});

test("spawn contract: no shell, hidden window, allow-listed env, prompt only on stdin, resolves once", async () => {
  const calls = [];
  const killed = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(chunk));
    calls.push({ command, args, options, stdin: () => Buffer.concat(chunks).toString("utf8") });
    child.stdin.on("end", () => {
      child.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", result: "ok", session_id: SID })}\n`);
      child.stdout.end();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
      child.emit("close", 0, null); // a duplicate close must be harmless
    });
    return child;
  };
  const result = await runClaudeTurn({ prompt: "TOP-SECRET-PROMPT", cwd: "/work", platform: "linux", claudePath: "/usr/bin/claude", claudeVersion: "2.1.5", spawn, killTree: (child) => killed.push(child.pid), env: hostEnv });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.command, "/usr/bin/claude");
  assert.equal(call.options.shell, false);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.detached, true);
  assert.deepEqual(call.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.ok(!call.args.join(" ").includes("TOP-SECRET-PROMPT"));
  assert.equal(call.stdin(), "TOP-SECRET-PROMPT");
  assert.ok(!("GITHUB_TOKEN" in call.options.env) && !("ASTERWEAVE_RUN_ID" in call.options.env));
  assert.deepEqual(killed, [4242]); // POSIX: the process group is reaped after a normal exit
});

test("a child that never closes cannot hang the turn (bounded wait after the kill)", async () => {
  const killed = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.pid = 77;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    return child;
  };
  const started = Date.now();
  const result = await runClaudeTurn({ prompt: "p", cwd: "/work", platform: "linux", claudePath: "/usr/bin/claude", claudeVersion: "2.1.5", spawn, killTree: (child) => killed.push(child.pid), deadlineMs: 50, killGraceMs: 80, env: hostEnv });
  assert.equal(result.error.class, "timeout");
  assert.equal(result.killed, true);
  assert.deepEqual(killed, [77]);
  assert.ok(Date.now() - started < 3000);
});

test("a spawn that throws is reported, not thrown", async () => {
  const result = await runClaudeTurn({ prompt: "p", cwd: "/work", platform: "linux", claudePath: "/usr/bin/claude", claudeVersion: "2.1.5", spawn: () => { throw Object.assign(new Error("nope"), { code: "ENOENT" }); }, env: hostEnv });
  assert.equal(result.ok, false);
  assert.equal(result.error.class, "not-installed");
});
