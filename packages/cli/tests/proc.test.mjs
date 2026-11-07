import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { resolveBinary, run, runBinary, runInherited } from "../src/proc.mjs";
import { waitFor } from "./repo-fixture.mjs";

const made = [];
const tempRoot = (prefix) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  made.push(dir);
  return dir;
};
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

// --- fake spawn -----------------------------------------------------------------------------

function fakeChild({ pid = 123 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdinData = [];
  child.stdin = Object.assign(new EventEmitter(), { end: (data) => child.stdinData.push(data) });
  child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); return true; };
  return child;
}

function fakeSpawn(script) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    const child = fakeChild();
    calls.push({ cmd, args, options, child });
    queueMicrotask(() => script(child, { cmd, args, options }));
    return spawn.child = child;
  };
  spawn.calls = calls;
  return spawn;
}

test("run uses no shell, passes the argument array, and ignores stdin by default", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", Buffer.from("out"));
    child.stderr.emit("data", "err");
    child.emit("close", 0, null);
  });
  const result = await run("gh", ["auth", "status", "--json", "hosts"], { cwd: "/work", env: { A: "1" }, spawn });
  assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr, error: result.error }, { code: 0, stdout: "out", stderr: "err", error: null });
  const { cmd, args, options } = spawn.calls[0];
  assert.equal(cmd, "gh");
  assert.deepEqual(args, ["auth", "status", "--json", "hosts"]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(options.cwd, "/work");
  assert.deepEqual(options.env, { A: "1" });
});

test("run writes input to stdin and swallows EPIPE", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
    child.emit("close", 3, null);
  });
  const result = await run("x", [], { input: "payload", spawn });
  assert.deepEqual(spawn.child.stdinData, ["payload"]);
  assert.equal(spawn.calls[0].options.stdio[0], "pipe");
  assert.equal(result.code, 3);
});

test("run decodes multi-byte characters split across chunks", async () => {
  const bytes = Buffer.from("héllo €");
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", bytes.subarray(0, 2));
    child.stdout.emit("data", bytes.subarray(2, 9));
    child.stdout.emit("data", bytes.subarray(9));
    child.emit("close", 0, null);
  });
  assert.equal((await run("x", [], { spawn })).stdout, "héllo €");
});

test("run reports spawn errors without throwing, settling once", async () => {
  const enoent = Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" });
  const spawn = fakeSpawn((child) => {
    child.pid = undefined;
    child.emit("error", enoent);
    child.emit("close", -2, null); // Node may emit both; the second must be ignored
  });
  const result = await run("gh", [], { spawn });
  assert.equal(result.error, enoent);
  assert.equal(result.code, null);

  const throwing = () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); };
  const thrown = await run("gh", [], { spawn: throwing });
  assert.equal(thrown.error.code, "EACCES");
});

test("run kills on timeout and escalates to SIGKILL when SIGTERM is ignored; it resolves without any close event", async () => {
  // The fake child never emits "close": only the grace timer can finish the run.
  const spawn = fakeSpawn(() => {});
  const keepAlive = setInterval(() => {}, 1000); // run's timers are unref'd; keep the loop alive while they fire
  const result = await run("stubborn", [], { timeoutMs: 10, killGraceMs: 10, spawn }).finally(() => clearInterval(keepAlive));
  assert.deepEqual(spawn.child.killed, ["SIGTERM", "SIGKILL"]);
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.code, null);
});

test("run kills on timeout and resolves with the child's close after SIGTERM", async () => {
  let child;
  const spawn = fakeSpawn((created) => { child = created; });
  const started = Date.now();
  const pending = run("slow", [], { timeoutMs: 20, spawn });
  await waitFor(() => child?.killed.length > 0, { label: "SIGTERM" });
  assert.deepEqual(child.killed, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  const result = await pending;
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGTERM");
  assert.ok(Date.now() - started < 1500);
});

test("run caps captured output but keeps draining", async () => {
  const spawn = fakeSpawn((child) => {
    child.stdout.emit("data", "a".repeat(10));
    child.stdout.emit("data", "b".repeat(10));
    child.stderr.emit("data", "e");
    child.emit("close", 0, null);
  });
  const result = await run("x", [], { maxOutputBytes: 12, spawn });
  assert.equal(result.stdout, `${"a".repeat(10)}bb`);
  assert.equal(result.stderr, "e");
  assert.equal(result.truncated, true);
});

// --- real processes -------------------------------------------------------------------------

const node = process.execPath;

test("real spawn: stdout and stderr stay separate and the exit code is reported", async () => {
  const result = await run(node, ["-e", "process.stdout.write('OUT'); process.stderr.write('ERR'); process.exit(3)"]);
  assert.equal(result.code, 3);
  assert.equal(result.stdout, "OUT");
  assert.equal(result.stderr, "ERR");
  assert.equal(result.error, null);
  assert.equal(result.timedOut, false);
});

test("real spawn: arguments are never interpreted by a shell", async () => {
  const hostile = "a b; echo pwned && whoami | cat > nul $(x) `y` %PATH%";
  const result = await run(node, ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", hostile, "--flag=\"q\""]);
  assert.deepEqual(JSON.parse(result.stdout), [hostile, "--flag=\"q\""]);
});

test("real spawn: timeout kills a hung child quickly", async () => {
  const started = Date.now();
  const result = await run(node, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.equal(result.error.code, "ETIMEDOUT");
  assert.ok(Date.now() - started < 5000);
});

test("real spawn: stdin input, cwd, env replacement, and a closed stdin by default", async () => {
  const cwd = realpathSync(tempRoot("aw-proc-"));
  const echo = await run(node, ["-e", "process.stdin.pipe(process.stdout)"], { input: "hello" });
  assert.equal(echo.stdout, "hello");
  process.env.AW_HOST_ONLY = "leak";
  let info;
  try {
    info = await run(node, ["-e", "console.log(JSON.stringify([process.cwd(), process.env.AW_PROBE, process.env.AW_HOST_ONLY ?? null]))"], {
      cwd,
      env: { AW_PROBE: "yes", SystemRoot: process.env.SystemRoot },
    });
  } finally {
    delete process.env.AW_HOST_ONLY;
  }
  const [seenCwd, probe, hostOnly] = JSON.parse(info.stdout);
  assert.equal(realpathSync(seenCwd), cwd);
  assert.equal(probe, "yes");
  assert.equal(hostOnly, null, "an explicit env replaces the parent environment");
  // stdin is closed, so reading to EOF finishes immediately instead of hanging.
  const closed = await run(node, ["-e", "process.stdin.on('data', () => {}).on('end', () => console.log('eof'))"], { timeoutMs: 5000 });
  assert.equal(closed.stdout.trim(), "eof");
});

test("real spawn: output over the cap is truncated and the child still exits", async () => {
  const result = await run(node, ["-e", "process.stdout.write('x'.repeat(200000))"], { maxOutputBytes: 1000 });
  assert.equal(result.stdout.length, 1000);
  assert.equal(result.truncated, true);
  assert.equal(result.code, 0);
});

test("real spawn: a missing executable yields ENOENT, not an exception", async () => {
  const result = await run(join(tmpdir(), "definitely-not-a-binary-xyz"), []);
  assert.equal(result.error.code, "ENOENT");
  assert.equal(result.code, null);
});

// --- inherited stdio ------------------------------------------------------------------------

test("runInherited uses inherited stdio and no shell, and reports the exit", async () => {
  const spawn = fakeSpawn((child) => child.emit("close", 0, null));
  const result = await runInherited("gh", ["auth", "login", "--web", "-h", "github.com"], { spawn });
  assert.deepEqual(result, { code: 0, signal: null, error: null, aborted: false });
  const { options } = spawn.calls[0];
  assert.equal(options.stdio, "inherit");
  assert.equal(options.shell, false);
});

test("runInherited reports non-zero exits, signals, spawn errors and aborts", async () => {
  const failed = await runInherited("gh", [], { spawn: fakeSpawn((child) => child.emit("close", 1, null)) });
  assert.equal(failed.code, 1);

  const signalled = await runInherited("gh", [], { spawn: fakeSpawn((child) => child.emit("close", null, "SIGINT")) });
  assert.equal(signalled.signal, "SIGINT");

  const missing = await runInherited("gh", [], {
    spawn: fakeSpawn((child) => { child.pid = undefined; child.emit("error", Object.assign(new Error("x"), { code: "ENOENT" })); }),
  });
  assert.equal(missing.error.code, "ENOENT");

  const controller = new AbortController();
  let child;
  const spawn = fakeSpawn((created) => { child = created; });
  const pending = runInherited("gh", [], { spawn, signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(child.killed, ["SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  const aborted = await pending;
  assert.equal(aborted.aborted, true);

  const already = new AbortController();
  already.abort();
  const never = fakeSpawn(() => {});
  assert.equal((await runInherited("gh", [], { spawn: never, signal: already.signal })).aborted, true);
  assert.equal(never.calls.length, 0, "nothing is spawned when already aborted");
});

// --- resolveBinary --------------------------------------------------------------------------

const virtual = (...files) => {
  const present = new Set(files.map((file) => file.toLowerCase()));
  return (file) => present.has(file.toLowerCase());
};

test("win32 (real files): prefers .exe over an earlier .cmd shim and lists every candidate", { skip: process.platform !== "win32" && "needs win32 path and filesystem semantics" }, () => {
  const root = tempRoot("aw-resolve-");
  const make = (name, files) => {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    for (const file of files) writeFileSync(join(directory, file), "");
    return directory;
  };
  const npmBin = make("npm", ["claude.cmd", "claude"]);
  const native = make("native", ["claude.exe"]);
  const result = resolveBinary("claude", { platform: "win32", env: { Path: npmBin + ";" + native, PATHEXT: ".COM;.EXE;.BAT;.CMD" } });
  assert.equal(result.path, join(native, "claude.exe"));
  assert.deepEqual(result.candidates, [join(npmBin, "claude.cmd"), join(native, "claude.exe")]);
  assert.equal(result.reason, undefined);
  const shimOnly = resolveBinary("claude", { platform: "win32", env: { PATH: npmBin } });
  assert.equal(shimOnly.reason, "SHELL_SHIM_ONLY");
});

const BS = String.fromCharCode(92);
const w = (text) => text.replaceAll("/", BS); // "C:/bin/x.exe" -> a Windows path, without literal backslashes

test("win32: prefers .exe over an earlier .cmd shim and lists every candidate", () => {
  const exists = virtual(w("C:/npm/claude.cmd"), w("C:/npm/claude"), w("C:/native/claude.exe"));
  const result = resolveBinary("claude", { platform: "win32", env: { Path: w("C:/npm;C:/native"), PATHEXT: ".COM;.EXE;.BAT;.CMD" }, exists });
  assert.equal(result.path, w("C:/native/claude.exe"));
  assert.deepEqual(result.candidates, [w("C:/npm/claude.cmd"), w("C:/native/claude.exe")]);
  assert.equal(result.reason, undefined);
});

test("win32: shim-only installs are reported with a reason code, not run", () => {
  const exists = virtual(w("C:/bin/claude.cmd"), w("C:/bin/gh.bat"));
  const env = { PATH: w("C:/bin") };
  const result = resolveBinary("claude", { platform: "win32", env, exists });
  assert.equal(result.reason, "SHELL_SHIM_ONLY");
  assert.equal(result.path, undefined);
  assert.deepEqual(result.candidates, [w("C:/bin/claude.cmd")]);
  assert.equal(resolveBinary("gh", { platform: "win32", env, exists }).reason, "SHELL_SHIM_ONLY");
  // Extensionless files (npm's sh shim) are not candidates on Windows.
  assert.equal(resolveBinary("claude", { platform: "win32", env, exists: virtual(w("C:/bin/claude")) }).reason, "NOT_FOUND");
});

test("win32: NOT_FOUND, case-insensitive PATH key, default PATHEXT, quoted entries, explicit extension", () => {
  const exists = virtual(w("C:/bin/tool.exe"));
  const env = { PATH: w("C:/bin") };
  assert.equal(resolveBinary("missing", { platform: "win32", env, exists }).reason, "NOT_FOUND");
  assert.deepEqual(resolveBinary("missing", { platform: "win32", env: {}, exists }), { reason: "NOT_FOUND", candidates: [] });
  assert.equal(resolveBinary("tool", { platform: "win32", env: { pAtH: '"' + w("C:/bin") + '"' }, exists }).path, w("C:/bin/tool.exe"));
  assert.equal(resolveBinary("tool.exe", { platform: "win32", env, exists }).path, w("C:/bin/tool.exe"));
  assert.equal(resolveBinary("tool.cmd", { platform: "win32", env, exists: virtual(w("C:/bin/tool.cmd")) }).reason, "SHELL_SHIM_ONLY");
});

test("win32: .exe wins over .com in the same directory and over a .cmd that comes first in PATHEXT", () => {
  const exists = virtual(w("C:/bin/t.com"), w("C:/bin/t.exe"), w("C:/bin/t.cmd"));
  assert.equal(resolveBinary("t", { platform: "win32", env: { PATH: w("C:/bin"), PATHEXT: ".CMD;.COM;.EXE" }, exists }).path, w("C:/bin/t.exe"));
});

test("posix: first executable on PATH wins; injected exists() controls the filesystem", () => {
  const present = new Set(["/usr/local/bin/gh", "/usr/bin/gh"]);
  const result = resolveBinary("gh", { platform: "linux", env: { PATH: "/opt/none:/usr/local/bin::/usr/bin" }, exists: (file) => present.has(file) });
  assert.equal(result.path, "/usr/local/bin/gh");
  assert.deepEqual(result.candidates, ["/usr/local/bin/gh", "/usr/bin/gh"]);
  assert.deepEqual(resolveBinary("gh", { platform: "linux", env: { PATH: "/x" }, exists: () => false }), { reason: "NOT_FOUND", candidates: [] });
  // A path with a separator bypasses PATH.
  assert.equal(resolveBinary("/opt/gh", { platform: "linux", env: {}, exists: (file) => file === "/opt/gh" }).path, "/opt/gh");
});

test("runBinary resolves first, never spawns unresolved binaries, and runs resolved ones", async () => {
  const spawn = fakeSpawn((child) => child.emit("close", 0, null));
  const none = await runBinary("claude", ["auth", "status"], { platform: "win32", env: { PATH: "" }, exists: () => false, spawn });
  assert.equal(none.error.code, "NOT_FOUND");
  assert.equal(spawn.calls.length, 0);

  const shim = await runBinary("claude", [], { platform: "win32", env: { PATH: "C:\\bin" }, exists: (file) => file.endsWith("claude.cmd"), spawn });
  assert.equal(shim.error.code, "SHELL_SHIM_ONLY");
  assert.equal(spawn.calls.length, 0);

  const ok = await runBinary("claude", ["auth", "status"], { platform: "win32", env: { PATH: "C:\\bin" }, exists: (file) => file.endsWith("claude.exe"), spawn });
  assert.equal(ok.code, 0);
  assert.equal(spawn.calls[0].cmd, "C:\\bin\\claude.exe");
  assert.deepEqual(spawn.calls[0].args, ["auth", "status"]);
  assert.equal(ok.resolution.path, "C:\\bin\\claude.exe");
});
