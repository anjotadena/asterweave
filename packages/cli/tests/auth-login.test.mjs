import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { loginClaude } from "../src/auth/claude.mjs";
import { loginGithub } from "../src/auth/github.mjs";
import { readCredentials } from "../src/auth/index.mjs";
import { waitFor } from "./repo-fixture.mjs";
import { NATIVE, TOKEN_SHAPED, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox } from "./auth-helpers.mjs";

const exists = installed(NATIVE("gh"), NATIVE("claude"));
const isLogin = (args) => args.includes("login");
const NOW = () => new Date("2026-02-03T04:05:06.000Z");

function loginSpawn({ login, status }) {
  return fakeSpawn((cmd, args) => (isLogin(args) ? login : status));
}

const ghOk = { stdout: ghHosts({ "github.com": [ghEntry()] }) };

test("github login success: inherited stdio hand-off, re-probe, writes only the reference", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { code: 0 }, status: ghOk });
  const { probe, reference } = await loginGithub({ env: sandbox.env, spawn, exists, now: NOW });

  const loginCall = spawn.calls.find((call) => isLogin(call.args));
  assert.deepEqual(loginCall.args, ["auth", "login", "--web", "-h", "github.com", "-s", "repo,read:org"]);
  assert.equal(loginCall.options.stdio, "inherit");
  assert.equal(loginCall.options.shell, false);
  assert.equal(loginCall.options.cwd, sandbox.userDir);
  assert.equal(probe.status, "ok");
  assert.deepEqual(reference, { provider: "github", source: "gh-cli", host: "github.com", account: "octo-dev", verifiedAt: "2026-02-03T04:05:06.000Z" });

  const onDisk = readFileSync(sandbox.credentialsFile, "utf8");
  assert.deepEqual(readCredentials({ env: sandbox.env }), { github: reference });
  assert.ok(!TOKEN_SHAPED.test(onDisk));
  for (const call of spawn.calls) assert.ok(!call.args.includes("--show-token") && !call.args.includes("-t"));
});

test("github login honours --host and validates it before spawning", async () => {
  const sandbox = makeSandbox();
  const hosts = ghHosts({ "ghe.example.com": [ghEntry({ host: "ghe.example.com", login: "corp" })] });
  const spawn = loginSpawn({ login: { code: 0 }, status: { stdout: hosts } });
  const { reference } = await loginGithub({ env: sandbox.env, spawn, exists, host: "ghe.example.com", now: NOW });
  assert.equal(reference.host, "ghe.example.com");
  assert.ok(spawn.calls.find((call) => isLogin(call.args)).args.includes("ghe.example.com"));

  const guard = fakeSpawn(() => assert.fail("must not spawn"));
  await assert.rejects(loginGithub({ env: sandbox.env, spawn: guard, exists, host: "--web" }), (error) => error.exitCode === EXIT.USAGE);
  assert.equal(guard.calls.length, 0);
});

for (const [name, login] of [
  ["non-zero child exit", { code: 1 }],
  ["child killed by a signal", { code: null, signal: "SIGINT" }],
  ["Ctrl+C exit code 130 from the child", { code: 130 }],
]) {
  test(`github login interrupted (${name}) -> exit 130 and no credentials.json`, async () => {
    const sandbox = makeSandbox();
    const spawn = loginSpawn({ login, status: ghOk });
    await assert.rejects(loginGithub({ env: sandbox.env, spawn, exists }), (error) => {
      assert.equal(error.exitCode, EXIT.INTERRUPTED);
      assert.equal(error.code, "LOGIN_INTERRUPTED");
      return true;
    });
    assert.equal(existsSync(sandbox.credentialsFile), false);
    assert.equal(spawn.calls.filter((call) => !isLogin(call.args)).length, 0, "no re-probe after an interrupted login");
  });
}

test("github login aborted before start (AbortSignal) -> 130, nothing spawned or written", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { code: 0 }, status: ghOk });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loginGithub({ env: sandbox.env, spawn, exists, signal: controller.signal }), (error) => error.exitCode === EXIT.INTERRUPTED);
  assert.equal(spawn.calls.length, 0);
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("github login aborted mid-flight kills the child, -> 130, nothing written", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { hang: true }, status: ghOk });
  const controller = new AbortController();
  const pending = loginGithub({ env: sandbox.env, spawn, exists, signal: controller.signal });
  await waitFor(() => spawn.calls.some((call) => isLogin(call.args)), { label: "the login child to start" });
  controller.abort();
  await assert.rejects(pending, (error) => error.exitCode === EXIT.INTERRUPTED);
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("github login that exits 0 but still lacks scopes fails with exit 3 and writes nothing", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { code: 0 }, status: { stdout: ghHosts({ "github.com": [ghEntry({ scopes: "gist" })] }) } });
  await assert.rejects(loginGithub({ env: sandbox.env, spawn, exists }), (error) => error.exitCode === EXIT.AUTH && error.code === "GH_SCOPE_MISSING");
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("github login with gh missing -> GH_NOT_INSTALLED exit 3, nothing spawned", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => ({}));
  await assert.rejects(loginGithub({ env: sandbox.env, spawn, exists: () => false }), (error) => error.exitCode === EXIT.AUTH && error.code === "GH_NOT_INSTALLED");
  assert.equal(spawn.calls.length, 0);
});

test("github login whose child cannot start reports GH_LOGIN_FAILED (exit 1), not an interruption", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => ({ error: Object.assign(new Error("spawn EACCES"), { code: "EACCES" }) }));
  await assert.rejects(loginGithub({ env: sandbox.env, spawn, exists }), (error) => error.code === "GH_LOGIN_FAILED" && error.exitCode === EXIT.ERROR);
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("claude login success: hand-off + re-probe; reference holds only the masked account and method", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { code: 0 }, status: { stdout: claudeStatus() } });
  const { reference } = await loginClaude({ env: sandbox.env, spawn, exists });
  const loginCall = spawn.calls.find((call) => isLogin(call.args));
  assert.deepEqual(loginCall.args, ["auth", "login"]);
  assert.equal(loginCall.options.stdio, "inherit");
  assert.deepEqual(reference, { provider: "model", source: "claude-cli", account: "an***@e***.com", authMethod: "claude.ai" });
  assert.ok(!readFileSync(sandbox.credentialsFile, "utf8").includes("anjo@example.com"));
});

for (const [name, login] of [
  ["non-zero child exit", { code: 2 }],
  ["signal", { code: null, signal: "SIGTERM" }],
]) {
  test(`claude login interrupted (${name}) -> exit 130 and no credentials.json`, async () => {
    const sandbox = makeSandbox();
    const spawn = loginSpawn({ login, status: { stdout: claudeStatus() } });
    await assert.rejects(loginClaude({ env: sandbox.env, spawn, exists }), (error) => error.exitCode === EXIT.INTERRUPTED);
    assert.equal(existsSync(sandbox.credentialsFile), false);
  });
}

test("claude login still not authenticated afterwards -> exit 3, nothing written", async () => {
  const sandbox = makeSandbox();
  const spawn = loginSpawn({ login: { code: 0 }, status: { stdout: JSON.stringify({ loggedIn: false }) } });
  await assert.rejects(loginClaude({ env: sandbox.env, spawn, exists }), (error) => error.exitCode === EXIT.AUTH && error.code === "CLAUDE_NOT_AUTHENTICATED");
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("claude login with only a .cmd shim -> CLAUDE_SHELL_SHIM_ONLY exit 3", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => ({}));
  await assert.rejects(
    loginClaude({ env: sandbox.env, spawn, platform: "win32", cwd: sandbox.userDir, exists: installed("claude.cmd") }),
    (error) => error.exitCode === EXIT.AUTH && error.code === "CLAUDE_SHELL_SHIM_ONLY",
  );
  assert.equal(spawn.calls.length, 0);
});
