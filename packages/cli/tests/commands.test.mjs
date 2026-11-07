// In-process tests for the auth, config, trust, help and launch-dispatch commands (through runCli).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { readCredentials, saveReference } from "../src/auth/index.mjs";
import { registerAllCommands } from "../src/commands/index.mjs";
import { runCli } from "../src/cli.mjs";
import { readExecutableRepoConfig } from "../src/config.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { NATIVE, TOKEN_SHAPED, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox } from "./auth-helpers.mjs";
import { cleanupTemp, fakeTerminal, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const exists = installed(NATIVE("gh"), NATIVE("claude"));
const isLogin = (args) => args.includes("login");

function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
}

/** Run the real default registry in-process with piped (non-TTY) streams. */
async function run(argv, sandbox, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { stdout, stderr, stdin: extra.stdin ?? sink(), env: sandbox.env, cwd: sandbox.root, homedir: () => sandbox.root, ...extra });
  return { code, out: stdout.text(), err: stderr.text() };
}

const ghOk = ghHosts({ "github.com": [ghEntry()] });
function statusSpawn({ gh = ghOk, claude = claudeStatus() } = {}) {
  return fakeSpawn((cmd) => (/gh(\.exe)?$/i.test(cmd) ? { stdout: gh } : { stdout: claude }));
}

function makeRepo({ gates = true, settings = false } = {}) {
  const dir = tempDir("aw-cmd-repo-");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  if (gates) {
    writeFileSync(join(dir, ".claude", "asterweave.json"), JSON.stringify({ version: 1, provider: { workItems: "github" }, qualityGates: { required: [{ id: "unit", command: "SECRET_CMD_MARKER --run", source: "test" }] } }));
  }
  if (settings) writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  return dir;
}

// --- auth status ----------------------------------------------------------------------------

test("auth status (text) prints the three masked planes and exits 0 when GitHub is ok", async () => {
  const sandbox = makeSandbox();
  const spawn = statusSpawn();
  const { code, out, err } = await run(["auth", "status"], sandbox, { spawn, exists });
  assert.equal(code, 0);
  assert.equal(err, "");
  assert.match(out, /^GitHub: signed in as octo-dev \(github\.com\) scopes ok$/m);
  assert.match(out, /^Model provider \(Claude Code\): signed in as an\*\*\*@e\*\*\*\.com \(claude\.ai\)$/m);
  assert.match(out, /^Asterweave account: unavailable \(no hosted backend configured\)$/m);
  assert.ok(!out.includes("anjo@example.com"));
  assert.ok(!out.includes("\x1b"));
  for (const call of spawn.calls) {
    assert.equal(call.options.cwd, sandbox.userDir, "probes run in the user directory");
    assert.ok(!call.args.includes("--show-token") && !call.args.includes("-t"));
  }
});

test("auth status --json is one JSON object with the planes and an empty stderr", async () => {
  const sandbox = makeSandbox();
  const { code, out, err } = await run(["auth", "status", "--json"], sandbox, { spawn: statusSpawn(), exists });
  assert.equal(code, 0);
  assert.equal(err, "");
  const body = JSON.parse(out);
  assert.equal(body.ok, true);
  assert.deepEqual(Object.keys(body.planes).sort(), ["asterweave", "github", "model"]);
  assert.equal(body.planes.github.account, "octo-dev");
  assert.equal(body.planes.asterweave.status, "unavailable");
  assert.ok(!TOKEN_SHAPED.test(out));
});

const STATUS_MATRIX = [
  { name: "missing scopes", gh: ghHosts({ "github.com": [ghEntry({ scopes: "gist" })] }), code: 3, match: /lacks required scope/, plane: "GH_SCOPE_MISSING" },
  { name: "expired token", gh: ghHosts({ "github.com": [ghEntry({ state: "error" })] }), code: 3, match: /not valid/, plane: "GH_AUTH_INVALID" },
  { name: "not signed in", gh: ghHosts({}), code: 3, match: /Not signed in/, plane: "GH_NOT_AUTHENTICATED" },
  { name: "unknown scopes (env token)", gh: ghHosts({ "github.com": [ghEntry({ scopes: "", tokenSource: "GH_TOKEN" })] }), code: 0, match: /scopes unknown/, plane: "GH_SCOPES_UNKNOWN" },
];
for (const row of STATUS_MATRIX) {
  test(`auth status matrix: GitHub ${row.name} -> exit ${row.code} with a remediation line`, async () => {
    const sandbox = makeSandbox();
    const { code, out, err } = await run(["auth", "status"], sandbox, { spawn: statusSpawn({ gh: row.gh }), exists });
    assert.equal(code, row.code);
    assert.match(out, row.match);
    if (row.code === 0) assert.match(out, /-> .*gh auth login/);
    else assert.match(out, /-> Run: gh auth (login|refresh)/);
    assert.equal(err, "");
    const json = await run(["auth", "status", "--json"], sandbox, { spawn: statusSpawn({ gh: row.gh }), exists });
    assert.equal(json.code, row.code);
    assert.equal(JSON.parse(json.out).planes.github.code, row.plane);
    assert.equal(json.err, "");
  });
}

test("auth status: gh not installed -> exit 3; model sign-in missing is a warning only", async () => {
  const sandbox = makeSandbox();
  const missing = await run(["auth", "status"], sandbox, { spawn: statusSpawn(), exists: () => false });
  assert.equal(missing.code, 3);
  assert.match(missing.out, /GitHub CLI \(gh\) was not found/);

  const noModel = await run(["auth", "status"], sandbox, { spawn: statusSpawn({ claude: JSON.stringify({ loggedIn: false }) }), exists });
  assert.equal(noModel.code, 0);
  assert.match(noModel.out, /Model provider \(Claude Code\): Claude Code is not signed in\./);
  assert.match(noModel.out, /claude auth login/);
});

test("auth status honours --host and ASTERWEAVE_GITHUB_HOST", async () => {
  const sandbox = makeSandbox();
  const hosts = ghHosts({ "ghe.example.com": [ghEntry({ host: "ghe.example.com", login: "corp" })] });
  const viaFlag = await run(["auth", "status", "--host", "ghe.example.com"], sandbox, { spawn: statusSpawn({ gh: hosts }), exists });
  assert.match(viaFlag.out, /signed in as corp \(ghe\.example\.com\)/);
  const viaEnv = await run(["auth", "status"], { ...sandbox, env: { ...sandbox.env, ASTERWEAVE_GITHUB_HOST: "ghe.example.com" } }, { spawn: statusSpawn({ gh: hosts }), exists });
  assert.match(viaEnv.out, /signed in as corp \(ghe\.example\.com\)/);
});

// --- auth login -----------------------------------------------------------------------------

test("auth login without a plane in a non-TTY is a usage error (exit 2) and spawns nothing", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => assert.fail("must not spawn"));
  const { code, err } = await run(["auth", "login"], sandbox, { spawn, exists });
  assert.equal(code, 2);
  assert.match(err, /needs a plane \(github or model\)/);
  assert.equal(spawn.calls.length, 0);
  assert.equal((await run(["auth", "login", "nope"], sandbox, { spawn, exists })).code, 2);
  assert.equal((await run(["auth", "login", "model", "--host", "x.com"], sandbox, { spawn, exists })).code, 2);
  assert.equal((await run(["auth", "login", "github", "--json"], sandbox, { spawn, exists })).code, 2);
});

test("auth login github <plane> hands off to gh and prints the success summary", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn((cmd, args) => (isLogin(args) ? { code: 0 } : { stdout: ghOk }));
  const { code, out } = await run(["auth", "login", "github"], sandbox, { spawn, exists });
  assert.equal(code, 0);
  assert.match(out, /Signed in: GitHub \(octo-dev\) on github\.com/);
  assert.match(out, /reference only/);
  const loginCall = spawn.calls.find((call) => isLogin(call.args));
  assert.equal(loginCall.options.stdio, "inherit");
  assert.equal(readCredentials({ env: sandbox.env }).github.account, "octo-dev");
});

async function pickerRun(sandbox, keys, spawn) {
  const term = fakeTerminal();
  const pending = runCli(["auth", "login"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: sandbox.root, spawn, exists, homedir: () => sandbox.root, proc: new (await import("node:events")).EventEmitter() });
  await waitFor(() => term.text().includes("GitHub (recommended)"), { label: "picker" });
  let finished = false;
  pending.then(() => { finished = true; }, () => { finished = true; });
  for (const key of keys) {
    const before = term.text().length;
    term.stdin.write(key);
    // Wait for the reaction (a redraw, output, or the command ending) instead of sleeping.
    await waitFor(() => finished || term.text().length > before, { label: `a reaction to ${JSON.stringify(key)}` });
  }
  return { code: await pending, term };
}

test("auth login picker: GitHub (recommended) is first, shows the browser note, signs in to GitHub", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn((cmd, args) => (isLogin(args) ? { code: 0 } : { stdout: ghOk }));
  const { code, term } = await pickerRun(sandbox, ["\r"], spawn);
  assert.equal(code, 0);
  const screen = term.text();
  assert.match(screen, /> .*GitHub \(recommended\)/);
  assert.match(screen, /Browser sign-in/);
  assert.match(screen, /A browser will open to authorize Asterweave\. After approval, return here to continue\./);
  assert.match(screen, /\x1b\[\?1049l/, "alternate screen left before the hand-off");
  assert.ok(spawn.calls.find((call) => isLogin(call.args)).args.includes("-h"));
  assert.ok(existsSync(sandbox.credentialsFile));
  assert.equal(term.stdin.rawCalls.at(-1), false);
});

test("auth login picker: Down + Enter chooses Browser sign-in (Claude Code)", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn((cmd, args) => (isLogin(args) ? { code: 0 } : { stdout: claudeStatus() }));
  const { code, term } = await pickerRun(sandbox, ["\x1b[B", "\r"], spawn);
  assert.equal(code, 0);
  assert.match(term.text(), /Signed in: Claude Code/);
  const loginCall = spawn.calls.find((call) => isLogin(call.args));
  assert.deepEqual(loginCall.args, ["auth", "login"]);
  assert.equal(readCredentials({ env: sandbox.env }).model.provider, "model");
});

test("auth login picker: Ctrl+C -> exit 130, nothing spawned or written, terminal restored", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => assert.fail("must not spawn"));
  const { code, term } = await pickerRun(sandbox, ["\x03"], spawn);
  assert.equal(code, EXIT.INTERRUPTED);
  assert.equal(spawn.calls.length, 0);
  assert.equal(existsSync(sandbox.credentialsFile), false);
  assert.match(term.text(), /\x1b\[\?25h/);
  assert.deepEqual(term.stdin.rawCalls, [true, false]);
});

test("auth login picker: Esc cancels with exit 1 and writes nothing", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => assert.fail("must not spawn"));
  const { code, term } = await pickerRun(sandbox, ["\x1b"], spawn);
  assert.equal(code, 1);
  assert.match(term.errText(), /cancelled; nothing was saved/);
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("auth login picker: closed input stream is an interruption (130)", async () => {
  const sandbox = makeSandbox();
  const spawn = fakeSpawn(() => assert.fail("must not spawn"));
  const term = fakeTerminal();
  const pending = runCli(["auth", "login"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: sandbox.root, spawn, exists, homedir: () => sandbox.root });
  await waitFor(() => term.text().includes("GitHub (recommended)"), { label: "picker" });
  term.stdin.end();
  assert.equal(await pending, 130);
  assert.equal(existsSync(sandbox.credentialsFile), false);
});

test("auth login: a login that does not finish -> 130 and no reference is written", async () => {
  const sandbox = makeSandbox();
  for (const plane of ["github", "model"]) {
    const spawn = fakeSpawn((cmd, args) => (isLogin(args) ? { code: 1 } : { stdout: ghOk }));
    const { code, err } = await run(["auth", "login", plane], sandbox, { spawn, exists });
    assert.equal(code, 130);
    assert.match(err, /interrupted; nothing was saved/);
    assert.equal(existsSync(sandbox.credentialsFile), false);
  }
});

test("auth login: SIGINT during the hand-off kills the child, -> 130, nothing written, listener removed", async () => {
  const { EventEmitter } = await import("node:events");
  for (const plane of ["github", "model"]) {
    const sandbox = makeSandbox();
    const proc = new EventEmitter();
    const spawn = fakeSpawn((cmd, args) => (isLogin(args) ? { hang: true } : { stdout: ghOk }));
    const pending = run(["auth", "login", plane], sandbox, { spawn, exists, proc });
    await waitFor(() => spawn.calls.some((call) => isLogin(call.args)), { label: "login hand-off" });
    assert.equal(proc.listenerCount("SIGINT"), 1);
    proc.emit("SIGINT");
    const { code, err } = await pending;
    assert.equal(code, EXIT.INTERRUPTED);
    assert.match(err, /interrupted; nothing was saved/);
    assert.equal(existsSync(sandbox.credentialsFile), false);
    assert.equal(proc.listenerCount("SIGINT"), 0);
  }
});

test("auth login with gh missing -> exit 3 with the install remediation", async () => {
  const sandbox = makeSandbox();
  const { code, err } = await run(["auth", "login", "github"], sandbox, { spawn: fakeSpawn(() => ({})), exists: () => false });
  assert.equal(code, 3);
  assert.match(err, /gh was not found/);
  assert.match(err, /cli\.github\.com/);
});

// --- auth logout ----------------------------------------------------------------------------

function seedReferences(sandbox) {
  const paths = { env: sandbox.env };
  saveReference("github", { provider: "github", source: "gh-cli", host: "ghe.example.com", account: "corp", verifiedAt: "2026-01-01T00:00:00.000Z" }, paths);
  saveReference("model", { provider: "model", source: "claude-cli", account: "an***@e***.com", authMethod: "claude.ai" }, paths);
}

test("auth logout drops only the reference, never spawns, and prints the provider command", async () => {
  const sandbox = makeSandbox();
  seedReferences(sandbox);
  const spawn = fakeSpawn(() => assert.fail("logout must never spawn a provider command"));
  const github = await run(["auth", "logout", "github"], sandbox, { spawn, exists });
  assert.equal(github.code, 0);
  assert.equal(github.out, "Removed Asterweave's stored reference (no provider sign-out performed).\nTo sign out of GitHub run: gh auth logout -h ghe.example.com\n");
  const model = await run(["auth", "logout", "model"], sandbox, { spawn, exists });
  assert.match(model.out, /^Removed Asterweave's stored reference \(no provider sign-out performed\)\.\nTo sign out of Claude Code run: claude auth logout\n$/);
  assert.equal(spawn.calls.length, 0);
  const left = readCredentials({ env: sandbox.env });
  assert.equal(left.github, undefined);
  assert.equal(left.model, undefined);
});

test("auth logout --json and --host; repeated logout reports nothing was stored", async () => {
  const sandbox = makeSandbox();
  seedReferences(sandbox);
  const first = await run(["auth", "logout", "github", "--host", "github.com", "--json"], sandbox);
  assert.deepEqual(JSON.parse(first.out), { ok: true, plane: "github", droppedReference: true, providerCommand: "gh auth logout -h github.com" });
  assert.equal(first.err, "");
  const again = await run(["auth", "logout", "github"], sandbox);
  assert.match(again.out, /^No Asterweave reference was stored \(no provider sign-out performed\)\./);
  assert.deepEqual(JSON.parse((await run(["auth", "logout", "model", "--json"], sandbox)).out), { ok: true, plane: "model", droppedReference: true, providerCommand: "claude auth logout" });
});

test("auth logout/unknown subcommands are usage errors (exit 2)", async () => {
  const sandbox = makeSandbox();
  for (const argv of [["auth", "logout"], ["auth", "logout", "asterweave"], ["auth"], ["auth", "frob"], ["auth", "logout", "github", "extra"], ["auth", "logout", "model", "--host", "x.com"], ["auth", "status", "extra"]]) {
    assert.equal((await run(argv, sandbox)).code, 2, argv.join(" "));
  }
  const json = await run(["auth", "logout", "--json"], sandbox);
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.out).error.code, "USAGE");
});

// --- config show ----------------------------------------------------------------------------

test("config show --json lists every key with its origin (default, user, env, flag)", async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.userDir, "config.json"), JSON.stringify({ ui: { color: "never" }, github: { host: "ghe.example.com" } }));
  const cwd = tempDir("aw-cmd-cwd-");
  const env = { ...sandbox.env, ASTERWEAVE_GITHUB_HOST: "env.example.com" };
  const { code, out, err } = await run(["config", "show", "--json", "--ui-color", "always"], { ...sandbox, env, root: cwd });
  assert.equal(code, 0);
  assert.equal(err, "");
  const body = JSON.parse(out);
  assert.equal(body.ok, true);
  assert.deepEqual(body.precedence, ["default", "user", "repo", "env", "flag"]);
  assert.deepEqual(body.entries.runner, { value: "local", origin: "default" });
  assert.deepEqual(body.entries["github.host"], { value: "env.example.com", origin: "env:ASTERWEAVE_GITHUB_HOST" });
  assert.deepEqual(body.entries["ui.color"], { value: "always", origin: "flag" });
  const userOnly = JSON.parse((await run(["config", "show", "--json"], { ...sandbox, root: cwd })).out);
  assert.equal(userOnly.entries["github.host"].origin, `user:${join(sandbox.userDir, "config.json")}`);
  assert.equal(userOnly.entries["ui.color"].value, "never");
});

test("config show (text) prints rows with origins, the precedence line, and no ANSI", async () => {
  const sandbox = makeSandbox();
  const { code, out } = await run(["config", "show", "--runner", "local", "--github-host", "flag.example.com"], { ...sandbox, root: tempDir("aw-cmd-cwd-") });
  assert.equal(code, 0);
  assert.match(out, /^runner\s+local\s+\(flag\)$/m);
  assert.match(out, /^github\.host\s+flag\.example\.com\s+\(flag\)$/m);
  assert.match(out, /^ui\.color\s+auto\s+\(default\)$/m);
  assert.match(out, /Precedence \(lowest to highest\): default < user < repo < env < flag/);
  assert.ok(!out.includes("\x1b"));
});

test("config show uses the connected repository and skips executable fields while untrusted", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  writeFileSync(join(sandbox.userDir, "repo.json"), JSON.stringify({ repository: "acme/widgets", branch: "main", path: repo, runner: "local" }));
  const elsewhere = tempDir("aw-cmd-cwd-");

  const untrusted = JSON.parse((await run(["config", "show", "--json"], { ...sandbox, root: elsewhere })).out);
  assert.equal(untrusted.repo.path, repo);
  assert.equal(untrusted.repo.trusted, false);
  assert.deepEqual(untrusted.repo.skipped, ["qualityGates.required"]);
  assert.deepEqual(untrusted.entries["qualityGates.required"], { value: [], origin: "default" });
  assert.equal(untrusted.entries["provider.workItems"].value, "github");
  assert.equal(untrusted.entries["provider.workItems"].origin, `repo:${join(repo, ".claude", "asterweave.json")}`);
  assert.ok(!JSON.stringify(untrusted).includes("SECRET_CMD_MARKER"));

  const text = (await run(["config", "show"], { ...sandbox, root: elsewhere })).out;
  assert.match(text, /skipped because the repository is not trusted/);
  assert.match(text, /asterweave trust grant --path/);
  assert.ok(!text.includes("SECRET_CMD_MARKER"));

  assert.equal((await run(["trust", "grant", "--path", repo], sandbox)).code, 0);
  const trusted = JSON.parse((await run(["config", "show", "--json"], { ...sandbox, root: elsewhere })).out);
  assert.equal(trusted.repo.trusted, true);
  assert.deepEqual(trusted.repo.skipped, []);
  assert.equal(trusted.entries["qualityGates.required"].value[0].id, "unit");
  assert.match((await run(["config", "show"], { ...sandbox, root: elsewhere })).out, /qualityGates\.required\s+\[1 gate\(s\): unit\]/);
});

test("config show falls back to cwd when the connected path is gone", async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.userDir, "repo.json"), JSON.stringify({ repository: "acme/widgets", branch: "main", path: join(sandbox.root, "vanished"), runner: "local" }));
  const cwd = makeRepo({ gates: false });
  const body = JSON.parse((await run(["config", "show", "--json"], { ...sandbox, root: cwd })).out);
  assert.equal(body.repo.path, cwd);
});

test("config show errors: invalid user config and flags -> exit 5; usage problems -> exit 2", async () => {
  const sandbox = makeSandbox();
  const cwd = tempDir("aw-cmd-cwd-");
  assert.equal((await run(["config", "show", "--runner", "cloud"], { ...sandbox, root: cwd })).code, 5);
  assert.equal((await run(["config", "show", "--runner"], { ...sandbox, root: cwd })).code, 2);
  assert.equal((await run(["config"], sandbox)).code, 2);
  assert.equal((await run(["config", "set"], sandbox)).code, 2);

  writeFileSync(join(sandbox.userDir, "config.json"), "{ not json");
  const text = await run(["config", "show"], { ...sandbox, root: cwd });
  assert.equal(text.code, 5);
  assert.equal(text.out, "");
  assert.match(text.err, /^Asterweave config error:/);
  const json = await run(["config", "show", "--json"], { ...sandbox, root: cwd });
  assert.equal(json.code, 5);
  assert.equal(json.err, "");
  assert.equal(JSON.parse(json.out).error.code, "CONFIG_INVALID");

  writeFileSync(join(sandbox.userDir, "config.json"), JSON.stringify({ ui: { color: "neon" } }));
  assert.equal((await run(["config", "show"], { ...sandbox, root: cwd })).code, 5);
});

// --- trust ----------------------------------------------------------------------------------

test("trust status/grant/revoke round trip with --json", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo({ settings: true });
  const status = async () => JSON.parse((await run(["trust", "status", "--path", repo, "--json"], sandbox)).out);

  const before = await status();
  assert.equal(before.ok, true);
  assert.equal(before.trusted, false);
  assert.equal(before.reason, "NOT_GRANTED");
  assert.equal(before.path, repo);
  assert.deepEqual(before.executable.map((item) => item.kind), ["command", "settings"]);

  const granted = await run(["trust", "grant", "--path", repo, "--json"], sandbox, { now: () => "2026-03-04T05:06:07.000Z" });
  assert.equal(granted.code, 0);
  assert.equal(granted.err, "");
  const grantedBody = JSON.parse(granted.out);
  assert.equal(grantedBody.trusted, true);
  assert.equal(grantedBody.hash, before.hash);
  assert.equal(grantedBody.trustedAt, "2026-03-04T05:06:07.000Z");
  assert.equal((await status()).trusted, true);

  const revoked = JSON.parse((await run(["trust", "revoke", "--path", repo, "--json"], sandbox)).out);
  assert.deepEqual({ ok: revoked.ok, trusted: revoked.trusted, removed: revoked.removed }, { ok: true, trusted: false, removed: true });
  assert.equal((await status()).trusted, false);
  assert.equal(JSON.parse((await run(["trust", "revoke", "--path", repo, "--json"], sandbox)).out).removed, false);
});

test("a change to any governing file invalidates trust (reason CHANGED)", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  await run(["trust", "grant", "--path", repo], sandbox);
  const trustedBody = JSON.parse((await run(["trust", "status", "--path", repo, "--json"], sandbox)).out);
  assert.equal(trustedBody.trusted, true);
  writeFileSync(join(repo, ".mcp.json"), "{}");
  const changed = JSON.parse((await run(["trust", "status", "--path", repo, "--json"], sandbox)).out);
  assert.equal(changed.trusted, false);
  assert.equal(changed.reason, "CHANGED");
  const text = (await run(["trust", "status", "--path", repo], sandbox)).out;
  assert.match(text, /untrusted \(trust-governing files changed since trust was granted\)/);
  assert.match(text, /MCP server config\s+in \.mcp\.json/);
});

test("trust text mode lists counts and file names, never command text, and says what is trusted", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo({ settings: true });
  writeFileSync(join(repo, ".mcp.json"), "{}");
  const { code, out } = await run(["trust", "grant", "--path", repo], sandbox);
  assert.equal(code, 0);
  assert.match(out, /Executable repository config found:/);
  assert.match(out, /1\s+quality-gate command\(s\)\s+in \.claude\/asterweave\.json/);
  assert.match(out, /1\s+Claude Code settings file\(s\)\s+in \.claude\/settings\.json/);
  assert.match(out, /1\s+MCP server config\s+in \.mcp\.json/);
  assert.match(out, /Granting trust allows Asterweave to run the repository's quality-gate commands/);
  assert.match(out, /Trusted /);
  assert.ok(!out.includes("SECRET_CMD_MARKER"));
  assert.ok(!(await run(["trust", "status", "--path", repo], sandbox)).out.includes("SECRET_CMD_MARKER"));
  const empty = tempDir("aw-cmd-empty-");
  assert.match((await run(["trust", "status", "--path", empty], sandbox)).out, /No executable repository config found/);
});

test("trust grant in a non-TTY requires an explicit --path and writes nothing otherwise", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  const refused = await run(["trust", "grant"], { ...sandbox, root: repo });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /explicit --path/);
  assert.equal(existsSync(join(sandbox.userDir, "trust.json")), false);
  const json = await run(["trust", "grant", "--json"], { ...sandbox, root: repo });
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.out).error.code, "USAGE");
  // status and revoke are fine without --path (cwd), and neither grants anything.
  assert.equal((await run(["trust"], { ...sandbox, root: repo })).code, 0);
  assert.equal((await run(["trust", "revoke"], { ...sandbox, root: repo })).code, 0);
  assert.equal(existsSync(join(sandbox.userDir, "trust.json")), false);
});

/** Run `trust grant` (no --path) on a fake TTY and answer the prompt with `answer`. */
async function grantInTty(answer, { cwd, sandbox, argv = ["trust", "grant"] } = {}) {
  const term = fakeTerminal();
  const running = runCli(argv, { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd, homedir: () => sandbox.root });
  await waitFor(() => /\[y\/N\]/.test(term.text()), { label: "the confirmation prompt" });
  term.stdin.write(answer);
  return { code: await running, term };
}

test("trust grant in a TTY without --path asks y/N naming the path; only 'y' trusts; connected repo wins over cwd", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  const yes = await grantInTty("y", { cwd: repo, sandbox });
  assert.equal(yes.code, 0);
  assert.ok(yes.term.text().includes(`Trust ${repo}`), "the prompt names the path");
  assert.match(yes.term.text(), /1 quality-gate command\(s\)/);
  assert.equal(JSON.parse((await run(["trust", "status", "--json"], { ...sandbox, root: repo })).out).trusted, true);

  const connected = makeRepo({ gates: false });
  writeFileSync(join(sandbox.userDir, "repo.json"), JSON.stringify({ repository: "acme/widgets", branch: "main", path: connected, runner: "local" }));
  assert.equal(JSON.parse((await run(["trust", "status", "--json"], { ...sandbox, root: repo })).out).path, connected);
});

test("trust grant confirmation defaults to No (Enter, n, Esc) and Ctrl+C is 130; nothing is granted", async () => {
  for (const [answer, expected] of [["\r", 1], ["n", 1], ["\x1b", 1], ["\x03", 130]]) {
    const sandbox = makeSandbox();
    const repo = makeRepo();
    const { code, term } = await grantInTty(answer, { cwd: repo, sandbox });
    assert.equal(code, expected, JSON.stringify(answer));
    assert.deepEqual(term.stdin.rawCalls.at(-1), false, "raw mode restored");
    assert.equal(JSON.parse((await run(["trust", "status", "--json"], { ...sandbox, root: repo })).out).trusted, false);
  }
});

test("trust grant --json without --path needs an explicit --path even on a TTY", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  const term = fakeTerminal();
  const code = await runCli(["trust", "grant", "--json"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: repo, homedir: () => sandbox.root });
  assert.equal(code, 2);
  assert.equal(JSON.parse(term.text()).error.code, "USAGE");
});

test("trust errors: missing path -> exit 1, bad subcommand/flag -> exit 2", async () => {
  const sandbox = makeSandbox();
  assert.equal((await run(["trust", "status", "--path", join(sandbox.root, "nope")], sandbox)).code, 1);
  assert.equal((await run(["trust", "frob"], sandbox)).code, 2);
  assert.equal((await run(["trust", "status", "--path"], sandbox)).code, 2);
  assert.equal((await run(["trust", "status", "extra", "more"], sandbox)).code, 2);
});

test("exit 4: a command needing executable repo config on an untrusted repository", async () => {
  const sandbox = makeSandbox();
  const repo = makeRepo();
  const registry = registerAllCommands(new Map());
  registry.set("run-gates", {
    summary: "",
    boolean: ["json"],
    handler: (ctx) => {
      const { gates } = readExecutableRepoConfig(repo, "run quality gates", { env: ctx.env });
      ctx.stdout.write(`${gates.length}\n`);
    },
  });
  const run1 = sink();
  const err1 = sink();
  assert.equal(await runCli(["run-gates"], { stdout: run1, stderr: err1, env: sandbox.env }, { commands: registry }), 4);
  assert.match(err1.text(), /untrusted/);
  assert.match(err1.text(), /asterweave trust grant --path/);
  assert.equal(run1.text(), "");
  const json = sink();
  assert.equal(await runCli(["run-gates", "--json"], { stdout: json, stderr: sink(), env: sandbox.env }, { commands: registry }), 4);
  assert.equal(JSON.parse(json.text()).error.code, "TRUST_REQUIRED");

  await run(["trust", "grant", "--path", repo], sandbox);
  const ok = sink();
  assert.equal(await runCli(["run-gates"], { stdout: ok, stderr: sink(), env: sandbox.env }, { commands: registry }), 0);
  assert.equal(ok.text(), "1\n");
});

// --- help -----------------------------------------------------------------------------------

test("help lists commands and the stable exit-code table", async () => {
  const sandbox = makeSandbox();
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const { code, out } = await run(argv, sandbox);
    assert.equal(code, 0);
    assert.match(out, /^Usage: asterweave <command>/);
    for (const name of ["doctor", "repo", "auth", "config", "trust"]) assert.match(out, new RegExp(`^  ${name}\\s`, "m"));
    assert.match(out, /Run `asterweave` with no command/);
    assert.match(out, /Exit codes:/);
    for (const row of [/^ {2}0 {4}ok/m, /^ {2}1 {4}error, or any doctor check FAIL/m, /^ {2}2 {4}usage error/m, /^ {2}3 {4}authentication/m, /^ {2}4 {4}repository trust/m, /^ {2}5 {4}configuration invalid/m, /^ {2}130 {2}interrupted/m]) assert.match(out, row);
  }
});

test("help <command> and <command> --help print usage, JSON shape and exit codes", async () => {
  const sandbox = makeSandbox();
  for (const name of ["doctor", "repo", "auth", "config", "trust", "help"]) {
    const viaHelp = await run(["help", name], sandbox);
    const viaFlag = await run([name, "--help"], sandbox);
    assert.equal(viaHelp.code, 0);
    assert.equal(viaFlag.code, 0);
    assert.equal(viaHelp.out, viaFlag.out);
    assert.match(viaHelp.out, new RegExp(`Usage: asterweave ${name}`));
    assert.match(viaHelp.out, /Exit codes: /);
  }
  assert.match((await run(["help", "auth"], sandbox)).out, /gh auth logout -h <host>/);
  assert.match((await run(["help", "doctor"], sandbox)).out, /JSON: \{"ok"/);
  const unknown = await run(["help", "frobnicate"], sandbox);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /Unknown command 'frobnicate'/);
});

// --- launch dispatch ------------------------------------------------------------------------

test("bare asterweave in a non-TTY -> exit 2 'interactive mode requires a TTY' (JSON envelope with --json is not offered bare)", async () => {
  const sandbox = makeSandbox();
  const { code, out, err } = await run([], sandbox);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /interactive mode requires a TTY; use --json or a TTY terminal/);
});

test("bare asterweave in a TTY runs launchCommand(ctx) lazily and returns its exit code", async () => {
  const sandbox = makeSandbox();
  let seen;
  const registry = registerAllCommands(new Map(), { loadLaunch: async () => ({ launchCommand: async (ctx) => { seen = ctx; return 42; } }) });
  const term = fakeTerminal();
  const code = await runCli([], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: sandbox.root }, { commands: registry });
  assert.equal(code, 42);
  assert.equal(seen.name, "launch");
  assert.equal(seen.cwd, sandbox.root);
  assert.equal(seen.stdout, term.stdout);
  assert.equal(typeof seen.version, "string");
  assert.deepEqual(seen.positionals, []);
});

test("launch fallback: no launch module -> usage on stdout and exit 0 (TTY only)", async () => {
  const sandbox = makeSandbox();
  for (const loadLaunch of [async () => null, async () => ({})]) {
    const registry = registerAllCommands(new Map(), { loadLaunch });
    const term = fakeTerminal();
    const code = await runCli([], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: sandbox.root }, { commands: registry });
    assert.equal(code, 0);
    assert.match(term.text(), /^Usage: asterweave <command>/);
    assert.equal(term.errText(), "");
  }
  // The TTY guard comes first: the loader is never consulted without a terminal.
  const registry = registerAllCommands(new Map(), { loadLaunch: async () => assert.fail("must not load launch in a non-TTY") });
  const out = sink();
  const err = sink();
  assert.equal(await runCli([], { stdout: out, stderr: err, stdin: sink(), env: sandbox.env }, { commands: registry }), 2);
  assert.match(err.text(), /interactive mode requires a TTY/);
});

test("errors thrown by launchCommand map through runCli (exit 3 from the GitHub gate)", async () => {
  const sandbox = makeSandbox();
  const { CliError } = await import("../src/exit-codes.mjs");
  const registry = registerAllCommands(new Map(), { loadLaunch: async () => ({ launchCommand: async () => { throw new CliError("GitHub sign-in required", { code: "GH_NOT_AUTHENTICATED", exitCode: EXIT.AUTH, remediation: "Run: gh auth login --web -h github.com" }); } }) });
  const term = fakeTerminal();
  const code = await runCli([], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env }, { commands: registry });
  assert.equal(code, 3);
  assert.match(term.errText(), /GitHub sign-in required/);
});
