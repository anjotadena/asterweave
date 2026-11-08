// Pure modules of the claude runner: argv builder, env allow-list, per-run settings file.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { buildClaudeArgv, ClaudeArgError, MIN_CLAUDE_VERSION, parseVersion, versionAtLeast } from "../src/runtime/claude/argv.mjs";
import { buildClaudeEnv } from "../src/runtime/claude/env.mjs";
import { buildSettings, hookCommand, quoteHookPath, SettingsError, writeRunSettings } from "../src/runtime/claude/settings.mjs";

const UUID = "123e4567-e89b-42d3-a456-426614174000";
const POSIX = { platform: "linux" };
const WIN = { platform: "win32" };
const temps = [];
after(() => { for (const dir of temps) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-claude-"))); temps.push(dir); return dir; };
const bad = (options, platform = POSIX) => assert.throws(() => buildClaudeArgv(options, platform), ClaudeArgError);

test("argv: new session, defaults, and the prompt is never part of it", () => {
  const argv = buildClaudeArgv({ prompt: "SECRET PROMPT", sessionId: UUID }, POSIX);
  assert.deepEqual(argv, ["-p", "--output-format", "stream-json", "--verbose", "--session-id", UUID, "--permission-mode", "default"]);
  assert.ok(!argv.join(" ").includes("SECRET"));
});

test("argv: resume and fork", () => {
  const resumed = buildClaudeArgv({ resume: "abcd1234-ef" }, POSIX);
  assert.deepEqual(resumed.slice(4), ["--resume", "abcd1234-ef", "--permission-mode", "default"]);
  const forked = buildClaudeArgv({ resume: "abcd1234-ef", fork: true, sessionId: UUID }, POSIX);
  assert.deepEqual(forked.slice(4), ["--session-id", UUID, "--resume", "abcd1234-ef", "--fork-session", "--permission-mode", "default"]);
  bad({ fork: true });
  bad({ resume: "abcd1234-ef", sessionId: UUID });
});

test("argv: every option, in order", () => {
  const argv = buildClaudeArgv({
    model: "claude-sonnet-5-5", effort: "high", permissionMode: "plan", allowedTools: ["Read", "Bash(git status:*)", "mcp__srv__tool"],
    settingsPath: "/tmp/run/settings.json", mcpConfigPath: "/tmp/run/mcp.json", strictMcp: true, appendSystemPrompt: "Be brief.",
  }, POSIX);
  assert.deepEqual(argv.slice(4), ["--model", "claude-sonnet-5-5", "--effort", "high", "--permission-mode", "plan", "--allowedTools", "Read,Bash(git status:*),mcp__srv__tool", "--settings", "/tmp/run/settings.json", "--mcp-config", "/tmp/run/mcp.json", "--strict-mcp-config", "--append-system-prompt", "Be brief."]);
});

test("argv: validation rejects bad and flag-like values", () => {
  bad({ sessionId: "not-a-uuid" });
  bad({ resume: "-evil-session" });
  bad({ resume: "short" });
  bad({ model: "-m" });
  bad({ model: "Has Space" });
  bad({ model: "A".repeat(10) });
  bad({ effort: "turbo" });
  bad({ permissionMode: "bypassPermissions" });
  bad({ permissionMode: "--dangerously-skip-permissions" });
  bad({ allowedTools: ["-Read"] });
  bad({ allowedTools: ["Read;rm"] });
  bad({ allowedTools: [" Read"] });
  bad({ allowedTools: "Read" });
  bad({ allowedTools: Array.from({ length: 51 }, () => "Read") });
  bad({ settingsPath: "relative/settings.json" });
  bad({ settingsPath: "-/abs" });
  bad({ mcpConfigPath: "/ok\u0000/x" });
  bad({ strictMcp: true });
  bad({ appendSystemPrompt: "--flag" });
  bad({ appendSystemPrompt: "x".repeat(4001) });
  bad({ appendSystemPrompt: "bell\u0007" });
  bad({ settingsPath: "/tmp/x" }, WIN);
  assert.doesNotThrow(() => buildClaudeArgv({ settingsPath: "C:\\Temp\\s.json" }, WIN));
});

test("argv: version parsing and the documented minimum", () => {
  assert.equal(MIN_CLAUDE_VERSION, "2.1.0");
  assert.deepEqual(parseVersion("2.1.5 (Claude Code)"), [2, 1, 5]);
  assert.equal(parseVersion("garbage"), null);
  assert.ok(versionAtLeast([2, 1, 0]));
  assert.ok(versionAtLeast([2, 10, 0]));
  assert.ok(versionAtLeast([3, 0, 0]));
  assert.ok(!versionAtLeast([2, 0, 99]));
  assert.ok(!versionAtLeast([1, 99, 99]));
  assert.ok(!versionAtLeast(null));
});

test("env: secrets are dropped, the allow-list and provider families pass", () => {
  const host = {
    PATH: "/usr/bin", HOME: "/home/u", LANG: "en_US.UTF-8", LC_ALL: "C", TERM: "xterm", NO_COLOR: "1", TMPDIR: "/tmp", http_proxy: "http://p", HTTPS_PROXY: "http://p", no_proxy: "x",
    ANTHROPIC_API_KEY: ["sk", "ant", "x"].join("-"), CLAUDE_CODE_FOO: "1", CLAUDECODE: "1",
    GITHUB_TOKEN: "t", GH_TOKEN: "t", NPM_TOKEN: "t", SSH_AUTH_SOCK: "/s", ASTERWEAVE_TOKEN: "t", ASTERWEAVE_RUN_ID: "forged", AWS_SECRET_ACCESS_KEY: "aws", GOOGLE_APPLICATION_CREDENTIALS: "g", RANDOM_VAR: "r",
  };
  const env = buildClaudeEnv(host, { platform: "linux" });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CLAUDE_CODE_FOO", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "NO_COLOR", "PATH", "TERM", "TMPDIR", "http_proxy", "no_proxy"].sort());
  const bedrock = buildClaudeEnv({ ...host, CLAUDE_CODE_USE_BEDROCK: "1" }, { platform: "linux" });
  assert.equal(bedrock.AWS_SECRET_ACCESS_KEY, "aws");
  assert.ok(!("GOOGLE_APPLICATION_CREDENTIALS" in bedrock));
  const vertex = buildClaudeEnv({ ...host, CLAUDE_CODE_USE_VERTEX: "true" }, { platform: "linux" });
  assert.equal(vertex.GOOGLE_APPLICATION_CREDENTIALS, "g");
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in vertex));
  const off = buildClaudeEnv({ ...host, CLAUDE_CODE_USE_BEDROCK: "0" }, { platform: "linux" });
  assert.ok(!("AWS_SECRET_ACCESS_KEY" in off));
});

test("env: correlation variables come only from extraEnv, nothing else is accepted", () => {
  const env = buildClaudeEnv({ PATH: "p", ASTERWEAVE_RUN_ID: "forged" }, { platform: "linux", extraEnv: { ASTERWEAVE_RUN_ID: "run-1", ASTERWEAVE_SESSION_ID: "s-1", ASTERWEAVE_CONFIG_DIR: "/cfg" } });
  assert.equal(env.ASTERWEAVE_RUN_ID, "run-1");
  assert.equal(env.ASTERWEAVE_SESSION_ID, "s-1");
  assert.equal(env.ASTERWEAVE_CONFIG_DIR, "/cfg");
  assert.throws(() => buildClaudeEnv({}, { extraEnv: { GITHUB_TOKEN: "x" } }), TypeError);
  assert.throws(() => buildClaudeEnv({}, { extraEnv: { ASTERWEAVE_RUN_ID: "a\u0000b" } }), TypeError);
  assert.equal(Object.getPrototypeOf(buildClaudeEnv({ __proto__x: "1" })), Object.prototype);
});

test("env: Windows names are case-insensitive and SystemRoot survives", () => {
  const env = buildClaudeEnv({ Path: "C:\\x", SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", userprofile: "C:\\u", github_token: "t", Anthropic_Api_Key: "k", APPDATA: "a", Temp: "t" }, { platform: "win32" });
  assert.deepEqual(Object.keys(env).sort(), ["APPDATA", "Anthropic_Api_Key", "Path", "SystemRoot", "Temp", "WINDIR", "userprofile"].sort());
});

test("settings: JSON shape with absolute quoted node and bin paths", () => {
  const posix = buildSettings({ nodePath: "/usr/bin/node", binPath: "/opt/aw's/bin/asterweave.mjs", platform: "linux" });
  assert.equal(posix.hooks.PreToolUse.length, 1);
  assert.equal(posix.hooks.PreToolUse[0].matcher, "*");
  const hook = posix.hooks.PreToolUse[0].hooks[0];
  assert.equal(hook.type, "command");
  assert.equal(hook.timeout, 10);
  assert.equal(hook.command, "'/usr/bin/node' '/opt/aw'\\''s/bin/asterweave.mjs' hook pre-tool-use");
  assert.equal(hookCommand({ nodePath: "C:\\Program Files\\nodejs\\node.exe", binPath: "C:\\a b\\bin\\asterweave.mjs", platform: "win32" }), "\"C:/Program Files/nodejs/node.exe\" \"C:/a b/bin/asterweave.mjs\" hook pre-tool-use");
  assert.deepEqual(Object.keys(posix), ["hooks"]);
});

test("settings: unquotable and relative paths are refused", () => {
  assert.throws(() => quoteHookPath("node", "linux"), SettingsError);
  assert.throws(() => quoteHookPath("/a\nb", "linux"), SettingsError);
  assert.throws(() => quoteHookPath("C:\\a%PATH%\\n.exe", "win32"), SettingsError);
  assert.throws(() => quoteHookPath("C:\\a\"b\\n.exe", "win32"), SettingsError);
  assert.throws(() => quoteHookPath("C:\\a`b\\n.exe", "win32"), SettingsError);
  assert.throws(() => buildSettings({ nodePath: "/n", binPath: "/b", platform: "linux", timeoutSeconds: 0 }), SettingsError);
});

test("settings: written atomically into a private claude/ directory under the run directory", () => {
  const runDir = tempDir();
  const { path: file, settings } = writeRunSettings({ runDir, nodePath: process.execPath, binPath: join(runDir, "bin.mjs") });
  assert.equal(file, join(runDir, "claude", "settings.json"));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), settings);
  if (process.platform !== "win32") {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(runDir, "claude")).mode & 0o777, 0o700);
  }
  assert.throws(() => writeRunSettings({ runDir: "relative", platform: "linux" }), SettingsError);
});
