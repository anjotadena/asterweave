// Real-subprocess tests: `node bin/asterweave.mjs ...` with piped (non-TTY) stdio.
//
// Provider tools: on a PATH that holds NO gh/claude the "not installed" paths are exercised. For the
// signed-in paths a temp dir holds stand-ins (bin-stub.cjs): POSIX shell scripts, or on Windows
// copies of node.exe named gh.exe/claude.exe that load the stub through NODE_OPTIONS. Nothing in
// the production code knows about the stubs.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { readCredentials } from "../src/auth/index.mjs";
import { FAKE_ANTHROPIC_KEY, FAKE_GH_TOKEN, TOKEN_SHAPED, claudeStatus, ghEntry, ghHosts } from "./auth-helpers.mjs";

const binPath = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const stubPath = fileURLToPath(new URL("./bin-stub.cjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-bin-")));
const emptyPath = join(root, "empty-path");
const stubPathDir = join(root, "stub-path");
let nextId = 0;

before(() => {
  mkdirSync(emptyPath, { recursive: true });
  mkdirSync(stubPathDir, { recursive: true });
  for (const tool of ["gh", "claude"]) {
    if (process.platform === "win32") {
      copyFileSync(process.execPath, join(stubPathDir, `${tool}.exe`));
    } else {
      writeFileSync(join(stubPathDir, tool), `#!/bin/sh\nSTUB_TOOL=${tool} exec "${process.execPath}" "${stubPath}" "$@"\n`);
      chmodSync(join(stubPathDir, tool), 0o755);
    }
  }
});

// The Windows stand-ins are full copies of node.exe: always remove them.
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** A fresh sandbox: user dir, temp HOME, working directory. */
function sandbox() {
  const dir = join(root, `case-${nextId++}`);
  const userDir = join(dir, "user");
  const cwd = join(dir, "cwd");
  const home = join(dir, "home");
  for (const path of [userDir, cwd, home]) mkdirSync(path, { recursive: true });
  return { dir, userDir, cwd, home, log: join(dir, "stub.log") };
}

function envFor(box, { stubs = false, extra = {} } = {}) {
  const env = {
    PATH: stubs ? stubPathDir : emptyPath,
    ASTERWEAVE_CONFIG_DIR: box.userDir,
    HOME: box.home,
    USERPROFILE: box.home,
    APPDATA: join(box.home, "AppData"),
    LOCALAPPDATA: join(box.home, "AppData"),
    TEMP: tmpdir(),
    TMP: tmpdir(),
    STUB_LOG: box.log,
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  if (stubs && process.platform === "win32") env.NODE_OPTIONS = `--require "${stubPath.replaceAll("\\", "/")}"`;
  return { ...env, ...extra };
}

function bin(args, box, options = {}) {
  const result = spawnSync(process.execPath, [binPath, ...args], {
    cwd: options.cwd ?? box.cwd,
    env: envFor(box, options),
    input: "",
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.error, undefined, `spawn failed: ${result.error}`);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const stubCalls = (box) => (existsSync(box.log) ? readFileSync(box.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const GH_OK = ghHosts({ "github.com": [ghEntry()] });

// --- exit 0 --------------------------------------------------------------------------------

test("--version and help exit 0 with clean stdout from any working directory", () => {
  const box = sandbox();
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  const v = bin(["--version"], box);
  assert.deepEqual(v, { code: 0, out: `${version}\n`, err: "" });

  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const result = bin(argv, box);
    assert.equal(result.code, 0);
    assert.equal(result.err, "");
    assert.ok(!result.out.includes("\x1b"), "no ESC bytes on piped stdout");
    assert.match(result.out, /^Usage: asterweave <command>/);
    assert.match(result.out, /Exit codes:/);
    assert.match(result.out, /130 {2}interrupted/);
  }
  assert.match(bin(["help", "auth"], box).out, /Usage: asterweave auth status/);
});

// --- exit 2 --------------------------------------------------------------------------------

test("unknown command, missing flags and a bare launch in a non-TTY exit 2 with errors on stderr only", () => {
  const box = sandbox();
  const unknown = bin(["frobnicate"], box);
  assert.equal(unknown.code, 2);
  assert.equal(unknown.out, "");
  assert.match(unknown.err, /unknown command 'frobnicate'/);

  const bare = bin([], box);
  assert.equal(bare.code, 2);
  assert.equal(bare.out, "");
  assert.match(bare.err, /^Asterweave launch error: interactive mode requires a TTY; use --json or a TTY terminal\n/);

  const bareJson = bin(["launch", "--json"], box);
  assert.equal(bareJson.code, 2);
  assert.equal(bareJson.err, "");
  assert.equal(JSON.parse(bareJson.out).error.code, "USAGE");

  const missing = bin(["repo", "connect"], box);
  assert.equal(missing.code, 2);
  assert.equal(missing.out, "");
  assert.match(missing.err, /^Asterweave repo error: repo connect needs --repo owner\/name and --branch <name>/);

  const json = bin(["repo", "connect", "--json"], box);
  assert.equal(json.code, 2);
  assert.equal(json.err, "", "--json errors go to stdout");
  assert.equal(JSON.parse(json.out).error.code, "USAGE");
  assert.equal(JSON.parse(json.out).ok, false);

  assert.equal(bin(["auth", "login"], box).code, 2);
  assert.equal(bin(["trust", "grant"], box).code, 2);
  assert.equal(bin(["config"], box).code, 2);
  assert.equal(bin(["--bogus-short", "-x"], box).code, 2);
});

// --- exit 3 --------------------------------------------------------------------------------

test("auth status without gh installed -> exit 3; JSON-only stdout, empty stderr", () => {
  const box = sandbox();
  const text = bin(["auth", "status"], box);
  assert.equal(text.code, 3);
  assert.equal(text.err, "");
  assert.ok(!text.out.includes("\x1b"));
  assert.match(text.out, /GitHub: The GitHub CLI \(gh\) was not found\./);
  assert.match(text.out, /Asterweave account: unavailable \(no hosted backend configured\)/);

  const json = bin(["auth", "status", "--json"], box);
  assert.equal(json.code, 3);
  assert.equal(json.err, "");
  const body = JSON.parse(json.out);
  assert.equal(body.ok, false);
  assert.equal(body.planes.github.code, "GH_NOT_INSTALLED");
  assert.equal(body.planes.model.code, "CLAUDE_NOT_INSTALLED");

  const login = bin(["auth", "login", "github"], box);
  assert.equal(login.code, 3);
  assert.match(login.err, /gh was not found on PATH/);
  assert.equal(existsSync(join(box.userDir, "credentials.json")), false);
});

// --- exit 5 --------------------------------------------------------------------------------

test("invalid user config.json -> exit 5 (stderr in text mode, JSON envelope on stdout with --json)", () => {
  const box = sandbox();
  writeFileSync(join(box.userDir, "config.json"), "{ not json");
  const text = bin(["config", "show"], box);
  assert.equal(text.code, 5);
  assert.equal(text.out, "");
  assert.match(text.err, /^Asterweave config error:/);
  const json = bin(["config", "show", "--json"], box);
  assert.equal(json.code, 5);
  assert.equal(json.err, "");
  assert.equal(JSON.parse(json.out).error.code, "CONFIG_INVALID");

  writeFileSync(join(box.userDir, "config.json"), JSON.stringify({ runner: "cloud" }));
  assert.equal(bin(["config", "show"], box).code, 5);
  assert.equal(bin(["config", "show", "--runner", "nope"], sandbox()).code, 5);
});

// --- exit 1 --------------------------------------------------------------------------------

test("doctor --json with FAILs exits 1 and prints a single JSON object", () => {
  const box = sandbox();
  const result = bin(["doctor", "--json"], box);
  assert.equal(result.code, 1);
  assert.equal(result.err, "");
  assert.ok(!result.out.includes("\x1b"));
  const body = JSON.parse(result.out);
  assert.equal(body.ok, false);
  const byId = Object.fromEntries(body.checks.map((check) => [check.id, check]));
  assert.equal(byId["github.install"].status, "FAIL");
  assert.ok(body.checks.every((check) => ["PASS", "WARN", "FAIL"].includes(check.status)));

  const text = bin(["doctor"], box);
  assert.equal(text.code, 1);
  assert.match(text.out, /FAIL {2}github\.install/);
});

// --- trust / exit 4 contract ------------------------------------------------------------------

test("config show on an untrusted repository succeeds and reports repo.skipped; trust grant then applies the gates", () => {
  const box = sandbox();
  const repo = join(box.dir, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, qualityGates: { required: [{ id: "unit", command: "SECRET_CMD_MARKER", source: "t" }] } }));

  const before = bin(["config", "show", "--json"], box, { cwd: repo });
  assert.equal(before.code, 0);
  assert.equal(before.err, "");
  const untrusted = JSON.parse(before.out);
  assert.equal(untrusted.repo.trusted, false);
  assert.deepEqual(untrusted.repo.skipped, ["qualityGates.required"]);
  assert.ok(!before.out.includes("SECRET_CMD_MARKER"));

  const status = JSON.parse(bin(["trust", "status", "--json"], box, { cwd: repo }).out);
  assert.equal(status.trusted, false);
  assert.deepEqual(status.executable, [{ field: "qualityGates.required[0].command", file: ".claude/asterweave.json", kind: "command" }]);

  const refused = bin(["trust", "grant"], box, { cwd: repo });
  assert.equal(refused.code, 2, "a script can never trust the current directory implicitly");
  assert.equal(JSON.parse(bin(["trust", "status", "--json"], box, { cwd: repo }).out).trusted, false);

  const granted = bin(["trust", "grant", "--path", repo], box);
  assert.equal(granted.code, 0);
  assert.ok(!granted.out.includes("SECRET_CMD_MARKER"));
  const after = JSON.parse(bin(["config", "show", "--json"], box, { cwd: repo }).out);
  assert.equal(after.repo.trusted, true);
  assert.deepEqual(after.repo.skipped, []);
  assert.equal(after.entries["qualityGates.required"].value[0].id, "unit");

  assert.equal(bin(["trust", "revoke", "--path", repo, "--json"], box).code, 0);
  assert.equal(JSON.parse(bin(["trust", "status", "--json"], box, { cwd: repo }).out).trusted, false);
});

// --- signed-in paths with stand-in gh/claude -----------------------------------------------

test("auth status and doctor with signed-in stand-ins exit 0; probes run in the user dir without token flags", () => {
  const box = sandbox();
  const extra = { STUB_GH_HOSTS: GH_OK, STUB_CLAUDE_STATUS: claudeStatus() };
  const status = bin(["auth", "status"], box, { stubs: true, extra });
  assert.equal(status.code, 0, status.err);
  assert.equal(status.err, "");
  assert.match(status.out, /GitHub: signed in as octo-dev \(github\.com\) scopes ok/);
  assert.match(status.out, /Model provider \(Claude Code\): signed in as an\*\*\*@e\*\*\*\.com/);

  const json = JSON.parse(bin(["auth", "status", "--json"], box, { stubs: true, extra }).out);
  assert.equal(json.ok, true);

  const doctor = bin(["doctor", "--json"], box, { stubs: true, extra });
  assert.equal(doctor.code, 0, doctor.out);
  assert.equal(doctor.err, "");

  const calls = stubCalls(box);
  assert.ok(calls.length >= 4);
  for (const call of calls) {
    assert.ok(!call.args.includes("--show-token") && !call.args.includes("-t"));
    assert.ok(!TOKEN_SHAPED.test(call.args.join(" ")), "no token-shaped argv");
    assert.equal(call.envHasTokenShaped, false, "no token-shaped environment values reached the child");
    assert.equal(realpathSync(call.cwd), realpathSync(box.userDir), "provider probes run in the user directory");
  }
});

test("auth login github through the stand-in writes a reference only; a failed login is 130 and writes nothing", () => {
  const box = sandbox();
  const extra = { STUB_GH_HOSTS: GH_OK, STUB_CLAUDE_STATUS: claudeStatus() };
  const ok = bin(["auth", "login", "github"], box, { stubs: true, extra });
  assert.equal(ok.code, 0, ok.err);
  assert.match(ok.out, /Signed in: GitHub \(octo-dev\) on github\.com/);
  const stored = readFileSync(join(box.userDir, "credentials.json"), "utf8");
  assert.equal(readCredentials({ env: { ASTERWEAVE_CONFIG_DIR: box.userDir } }).github.account, "octo-dev");
  assert.ok(!TOKEN_SHAPED.test(stored));
  const loginCall = stubCalls(box).find((call) => call.args[1] === "login");
  assert.deepEqual(loginCall.args, ["auth", "login", "--web", "-h", "github.com", "-s", "repo,read:org"]);

  const failing = sandbox();
  const failed = bin(["auth", "login", "github"], failing, { stubs: true, extra: { ...extra, STUB_LOGIN_CODE: "1" } });
  assert.equal(failed.code, 130);
  assert.match(failed.err, /interrupted; nothing was saved/);
  assert.equal(existsSync(join(failing.userDir, "credentials.json")), false);

  const logout = bin(["auth", "logout", "github"], box, { stubs: true, extra });
  assert.equal(logout.code, 0);
  assert.match(logout.out, /Removed Asterweave's stored reference \(no provider sign-out performed\)\./);
  assert.match(logout.out, /To sign out of GitHub run: gh auth logout -h github\.com/);
  assert.ok(!stubCalls(box).some((call) => call.args.includes("logout")), "logout never runs a provider command");
});

test("a token in the environment never reaches stdout or stderr of any command", () => {
  const box = sandbox();
  const extra = { GH_TOKEN: FAKE_GH_TOKEN, ANTHROPIC_API_KEY: FAKE_ANTHROPIC_KEY, ASTERWEAVE_GITHUB_HOST: "ghe.example.com", STUB_GH_HOSTS: ghHosts({ "ghe.example.com": [ghEntry({ host: "ghe.example.com", tokenSource: "GH_TOKEN" })] }), STUB_CLAUDE_STATUS: claudeStatus() };
  for (const argv of [["auth", "status"], ["auth", "status", "--json"], ["doctor"], ["doctor", "--json"], ["config", "show"], ["config", "show", "--json"], ["trust", "status"], ["help"]]) {
    const result = bin(argv, box, { stubs: true, extra });
    for (const stream of [result.out, result.err]) {
      assert.ok(!stream.includes(FAKE_GH_TOKEN) && !stream.includes(FAKE_ANTHROPIC_KEY), `${argv.join(" ")} leaked a token`);
      assert.ok(!TOKEN_SHAPED.test(stream));
    }
  }
});
