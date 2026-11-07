import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { CliError, EXIT } from "../src/exit-codes.mjs";
import { probeAccount } from "../src/auth/account.mjs";
import { probeClaude } from "../src/auth/claude.mjs";
import { probeGithub } from "../src/auth/github.mjs";
import { authStatus, dropReference, logoutPlan, probeAll, readCredentials, requireGithub, saveReference } from "../src/auth/index.mjs";
import {
  FAKE_ANTHROPIC_KEY, FAKE_GH_TOKEN, NATIVE, TOKEN_SHAPED, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox,
} from "./auth-helpers.mjs";

const exists = installed(NATIVE("gh"), NATIVE("claude"));

function ghSpawn(stdout, extra = {}) {
  return fakeSpawn(() => ({ stdout, ...extra }));
}

function probeGh(sandbox, spawn, extra = {}) {
  return probeGithub({ env: sandbox.env, spawn, exists, ...extra });
}

function probeCl(sandbox, spawn, extra = {}) {
  return probeClaude({ env: sandbox.env, spawn, exists, ...extra });
}

const claudeSpawn = (outcome) => fakeSpawn(() => outcome);

// --- GitHub plane ---------------------------------------------------------------------------

test("github ok: normalized shape, scopes parsed from 'a, b, c', exact argv", async () => {
  const sandbox = makeSandbox();
  const spawn = ghSpawn(ghHosts({ "github.com": [ghEntry()] }));
  const probe = await probeGh(sandbox, spawn);
  assert.deepEqual(probe, {
    plane: "github", status: "ok", code: "OK", reason: "Signed in to github.com as octo-dev.", remediation: null,
    host: "github.com", account: "octo-dev", scopes: ["gist", "read:org", "repo"], scopesKnown: true, tokenSource: "keyring",
  });
  assert.deepEqual(spawn.calls[0].args, ["auth", "status", "--json", "hosts"]);
  assert.equal(spawn.calls[0].options.shell, false);
});

test("github: probes run with cwd = the user dir so repo settings are never loaded", async () => {
  const sandbox = makeSandbox();
  const spawn = ghSpawn(ghHosts({ "github.com": [ghEntry()] }));
  await probeGh(sandbox, spawn);
  assert.equal(spawn.calls[0].options.cwd, sandbox.userDir);
});

test("github prefers the active entry for the host", async () => {
  const sandbox = makeSandbox();
  const entries = [ghEntry({ active: false, login: "old", state: "error" }), ghEntry({ active: true, login: "current" })];
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": entries })));
  assert.equal(probe.status, "ok");
  assert.equal(probe.account, "current");
});

test("github uses the requested host and ignores others", async () => {
  const sandbox = makeSandbox();
  const hosts = { "github.com": [ghEntry()], "ghe.example.com": [ghEntry({ host: "ghe.example.com", login: "corp" })] };
  const probe = await probeGh(sandbox, ghSpawn(ghHosts(hosts)), { host: "ghe.example.com" });
  assert.equal(probe.host, "ghe.example.com");
  assert.equal(probe.account, "corp");
  const other = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry()] })), { host: "ghe.example.com" });
  assert.equal(other.code, "GH_NOT_AUTHENTICATED");
  assert.match(other.remediation, /gh auth login --web -h ghe\.example\.com/);
});

test("github denied scopes (gist only) -> GH_SCOPE_MISSING with refresh remediation", async () => {
  const sandbox = makeSandbox();
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "gist" })] })));
  assert.equal(probe.status, "fail");
  assert.equal(probe.code, "GH_SCOPE_MISSING");
  assert.match(probe.reason, /repo, read:org/);
  assert.equal(probe.remediation, "Run: gh auth refresh -h github.com -s repo,read:org");
  assert.deepEqual(probe.scopes, ["gist"]);
});

test("github: only read:org missing is reported precisely; admin:org satisfies read:org", async () => {
  const sandbox = makeSandbox();
  const missing = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "repo" })] })));
  assert.equal(missing.code, "GH_SCOPE_MISSING");
  assert.match(missing.reason, /: read:org\./);
  const implied = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "repo, admin:org" })] })));
  assert.equal(implied.status, "ok");
});

test("github expired/revoked (state:error) -> GH_AUTH_INVALID", async () => {
  const sandbox = makeSandbox();
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ state: "error", scopes: "" })] })));
  assert.equal(probe.status, "fail");
  assert.equal(probe.code, "GH_AUTH_INVALID");
  assert.equal(probe.remediation, "Run: gh auth refresh -h github.com");
  assert.equal(probe.account, "octo-dev");
});

test("github unknown state value is invalid, not ok", async () => {
  const sandbox = makeSandbox();
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ state: "quantum" })] })));
  assert.equal(probe.code, "GH_AUTH_INVALID");
  assert.match(probe.reason, /quantum/);
});

test("github empty scopes with GH_TOKEN source -> warn GH_SCOPES_UNKNOWN (not fail)", async () => {
  const sandbox = makeSandbox();
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "", tokenSource: "GH_TOKEN" })] })));
  assert.equal(probe.status, "warn");
  assert.equal(probe.code, "GH_SCOPES_UNKNOWN");
  assert.equal(probe.scopesKnown, false);
  assert.equal(probe.tokenSource, "GH_TOKEN");
  assert.equal(probe.account, "octo-dev");
  const required = await requireGithub({ env: sandbox.env, spawn: ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "" })] })), exists });
  assert.equal(required.status, "warn", "warn does not throw");
});

test("github env-sourced token with too few scopes gets env-specific remediation", async () => {
  const sandbox = makeSandbox();
  const probe = await probeGh(sandbox, ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "gist", tokenSource: "GH_TOKEN" })] })));
  assert.equal(probe.code, "GH_SCOPE_MISSING");
  assert.match(probe.remediation, /GH_TOKEN/);
});

test("github no hosts / no matching entry -> GH_NOT_AUTHENTICATED (gh exits 0)", async () => {
  const sandbox = makeSandbox();
  for (const stdout of [ghHosts({}), ghHosts({ "github.com": [] }), ghHosts({ "github.com": [ghEntry({ active: false })] })]) {
    const probe = await probeGh(sandbox, ghSpawn(stdout, { code: 0 }));
    assert.equal(probe.status, "fail");
    assert.equal(probe.code, "GH_NOT_AUTHENTICATED");
    assert.equal(probe.remediation, "Run: gh auth login --web -h github.com -s repo,read:org");
  }
});

test("github not installed: not on PATH, and spawn ENOENT", async () => {
  const sandbox = makeSandbox();
  const spawn = ghSpawn("");
  const missing = await probeGithub({ env: sandbox.env, spawn, exists: () => false });
  assert.equal(missing.code, "GH_NOT_INSTALLED");
  assert.equal(spawn.calls.length, 0, "nothing is spawned when gh cannot be resolved");

  const enoent = fakeSpawn(() => ({ error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }));
  assert.equal((await probeGh(sandbox, enoent)).code, "GH_NOT_INSTALLED");
});

test("github unparseable output -> GH_STATUS_UNPARSEABLE; old gh 'not logged in' stderr -> NOT_AUTHENTICATED", async () => {
  const sandbox = makeSandbox();
  assert.equal((await probeGh(sandbox, ghSpawn("not json"))).code, "GH_STATUS_UNPARSEABLE");
  assert.equal((await probeGh(sandbox, ghSpawn("{}"))).code, "GH_STATUS_UNPARSEABLE");
  assert.equal((await probeGh(sandbox, ghSpawn("", { code: 1, stderr: "unknown flag: --json" }))).code, "GH_STATUS_UNPARSEABLE");
  assert.equal((await probeGh(sandbox, ghSpawn("", { code: 1, stderr: "something unexpected" }))).code, "GH_STATUS_UNPARSEABLE");
  assert.equal((await probeGh(sandbox, ghSpawn("", { code: 1, stderr: "You are not logged into any GitHub hosts" }))).code, "GH_NOT_AUTHENTICATED");
  assert.equal((await probeGh(sandbox, ghSpawn("", { code: 1, stderr: "You are not logged in to github.com" }))).code, "GH_NOT_AUTHENTICATED");
});

test("github host cannot masquerade as a flag", async () => {
  const sandbox = makeSandbox();
  await assert.rejects(probeGh(sandbox, ghSpawn(""), { host: "--hostname" }), (error) => error.exitCode === EXIT.USAGE);
});

test("requireGithub throws CliError(code=reason, exit 3, remediation) on fail", async () => {
  const sandbox = makeSandbox();
  const spawn = ghSpawn(ghHosts({ "github.com": [ghEntry({ scopes: "gist" })] }));
  await assert.rejects(requireGithub({ env: sandbox.env, spawn, exists }), (error) => {
    assert.ok(error instanceof CliError);
    assert.equal(error.code, "GH_SCOPE_MISSING");
    assert.equal(error.exitCode, EXIT.AUTH);
    assert.match(error.remediation, /gh auth refresh -h github\.com -s repo,read:org/);
    return true;
  });
});

// --- Claude plane ---------------------------------------------------------------------------

test("claude ok: masked email, no raw address anywhere, argv is exactly `auth status`", async () => {
  const sandbox = makeSandbox();
  const spawn = claudeSpawn({ stdout: claudeStatus() });
  const probe = await probeCl(sandbox, spawn);
  assert.deepEqual(probe, {
    plane: "model", status: "ok", code: "OK", reason: "Claude Code is signed in as an***@e***.com.", remediation: null,
    account: "an***@e***.com", authMethod: "claude.ai", apiProvider: "firstParty", orgName: "Example Org", subscriptionType: "max",
  });
  assert.ok(!JSON.stringify(probe).includes("anjo@example.com"));
  assert.deepEqual(spawn.calls[0].args, ["auth", "status"]);
  assert.equal(spawn.calls[0].options.cwd, sandbox.userDir);
  assert.equal(spawn.calls[0].options.shell, false);
});

test("claude tolerates a leading non-JSON line", async () => {
  const sandbox = makeSandbox();
  const probe = await probeCl(sandbox, claudeSpawn({ stdout: `Checking authentication...\n${claudeStatus()}\n` }));
  assert.equal(probe.status, "ok");
});

test("claude loggedIn:false -> CLAUDE_NOT_AUTHENTICATED (even with exit 0)", async () => {
  const sandbox = makeSandbox();
  const probe = await probeCl(sandbox, claudeSpawn({ stdout: JSON.stringify({ loggedIn: false }) }));
  assert.equal(probe.status, "fail");
  assert.equal(probe.code, "CLAUDE_NOT_AUTHENTICATED");
  assert.equal(probe.remediation, "Run: claude auth login");
  assert.equal(probe.account, null);
});

test("claude non-zero exit with garbage output -> CLAUDE_NOT_AUTHENTICATED", async () => {
  const sandbox = makeSandbox();
  const probe = await probeCl(sandbox, claudeSpawn({ code: 1, stdout: "garbage", stderr: "Not logged in" }));
  assert.equal(probe.code, "CLAUDE_NOT_AUTHENTICATED");
});

test("claude non-zero exit with JSON lacking loggedIn is still not authenticated", async () => {
  const sandbox = makeSandbox();
  assert.equal((await probeCl(sandbox, claudeSpawn({ code: 1, stdout: "{}" }))).code, "CLAUDE_NOT_AUTHENTICATED");
});

test("claude exit 0 with garbage -> CLAUDE_STATUS_UNPARSEABLE", async () => {
  const sandbox = makeSandbox();
  assert.equal((await probeCl(sandbox, claudeSpawn({ stdout: "hello there" }))).code, "CLAUDE_STATUS_UNPARSEABLE");
  assert.equal((await probeCl(sandbox, claudeSpawn({ stdout: "{}" }))).code, "CLAUDE_STATUS_UNPARSEABLE");
});

test("claude not installed -> CLAUDE_NOT_INSTALLED, nothing spawned", async () => {
  const sandbox = makeSandbox();
  const spawn = claudeSpawn({});
  const probe = await probeClaude({ env: sandbox.env, spawn, exists: () => false });
  assert.equal(probe.code, "CLAUDE_NOT_INSTALLED");
  assert.equal(spawn.calls.length, 0);
});

test("claude installed only as claude.cmd -> CLAUDE_SHELL_SHIM_ONLY, nothing spawned", async () => {
  const sandbox = makeSandbox();
  const spawn = claudeSpawn({});
  const probe = await probeClaude({ env: sandbox.env, spawn, platform: "win32", cwd: sandbox.userDir, exists: installed("claude.cmd") });
  assert.equal(probe.code, "CLAUDE_SHELL_SHIM_ONLY");
  assert.equal(spawn.calls.length, 0);
});

test("claude timeout is reported as unparseable status, not a crash", async () => {
  const sandbox = makeSandbox();
  const keepAlive = setInterval(() => {}, 50); // the probe's own timers are unref'd
  const probe = await probeCl(sandbox, claudeSpawn({ hang: true }), { timeoutMs: 20 }).finally(() => clearInterval(keepAlive));
  assert.equal(probe.code, "CLAUDE_STATUS_UNPARSEABLE");
  assert.match(probe.reason, /timed out/);
});

// --- Account plane and aggregate ------------------------------------------------------------

test("asterweave account is always unavailable and informational", () => {
  assert.deepEqual(probeAccount(), { plane: "asterweave", status: "unavailable", code: "ACCOUNT_UNAVAILABLE", reason: "no hosted backend configured", remediation: null });
});

function bothSpawn({ gh, claude }) {
  return fakeSpawn((cmd) => (/[\\/]gh(\.exe)?$/i.test(cmd) ? gh : claude));
}

test("authStatus: ok follows GitHub only; model/account never flip it", async () => {
  const sandbox = makeSandbox();
  const healthyGh = { stdout: ghHosts({ "github.com": [ghEntry()] }) };
  const loggedOut = await authStatus({ env: sandbox.env, exists, spawn: bothSpawn({ gh: healthyGh, claude: { stdout: JSON.stringify({ loggedIn: false }) } }) });
  assert.equal(loggedOut.ok, true);
  assert.equal(loggedOut.planes.model.code, "CLAUDE_NOT_AUTHENTICATED");
  assert.equal(loggedOut.planes.asterweave.status, "unavailable");
  const ghDown = await authStatus({ env: sandbox.env, exists, spawn: bothSpawn({ gh: { stdout: ghHosts({}) }, claude: { stdout: claudeStatus() } }) });
  assert.equal(ghDown.ok, false);
  assert.equal(ghDown.planes.model.status, "ok");
});

test("authStatus is masked: emails masked and token-shaped provider strings redacted", async () => {
  const sandbox = makeSandbox();
  const gh = { stdout: ghHosts({ "github.com": [ghEntry({ login: "octo-dev" })] }) };
  const claude = { stdout: claudeStatus({ orgName: `Org ${FAKE_ANTHROPIC_KEY}` }) };
  const view = await authStatus({ env: sandbox.env, exists, spawn: bothSpawn({ gh, claude }) });
  const text = JSON.stringify(view);
  assert.ok(!text.includes("anjo@example.com"));
  assert.ok(text.includes("an***@e***.com"));
  assert.ok(!text.includes(FAKE_ANTHROPIC_KEY));
  assert.ok(!TOKEN_SHAPED.test(text));
});

test("probeAll returns the three planes and never spawns doctor, -p, or token flags", async () => {
  const sandbox = makeSandbox();
  const spawn = bothSpawn({ gh: { stdout: ghHosts({ "github.com": [ghEntry()] }) }, claude: { stdout: claudeStatus() } });
  const planes = await probeAll({ env: sandbox.env, exists, spawn });
  assert.deepEqual(Object.keys(planes).sort(), ["asterweave", "github", "model"]);
  assert.equal(spawn.calls.length, 2);
  for (const { args, options } of spawn.calls) {
    const argv = args.join(" ");
    for (const forbidden of ["--show-token", "doctor", "-p", "--print"]) assert.ok(!args.includes(forbidden), `${forbidden} in ${argv}`);
    assert.ok(!args.includes("-t"));
    assert.ok(!TOKEN_SHAPED.test(argv));
    assert.equal(options.cwd, sandbox.userDir);
    assert.ok(!Object.values(options.env).some((value) => TOKEN_SHAPED.test(String(value))));
  }
});

// --- Credential reference store -------------------------------------------------------------

const GITHUB_REF = { provider: "github", source: "gh-cli", host: "github.com", account: "octo-dev", verifiedAt: "2026-01-01T00:00:00.000Z" };
const MODEL_REF = { provider: "model", source: "claude-cli", account: "an***@e***.com", authMethod: "claude.ai" };

test("credential references round-trip and contain only the allowed fields", () => {
  const { env, credentialsFile } = makeSandbox();
  assert.deepEqual(readCredentials({ env }), {});
  saveReference("github", GITHUB_REF, { env });
  saveReference("model", MODEL_REF, { env });
  saveReference("asterweave", { provider: "asterweave", state: "unavailable" }, { env });
  assert.deepEqual(readCredentials({ env }), { github: GITHUB_REF, model: MODEL_REF, asterweave: { provider: "asterweave", state: "unavailable" } });
  const raw = JSON.parse(readFileSync(credentialsFile, "utf8"));
  assert.deepEqual(Object.keys(raw.references.github).sort(), ["account", "host", "provider", "source", "verifiedAt"]);
  assert.ok(!TOKEN_SHAPED.test(JSON.stringify(raw)));
});

test("a token-shaped value is rejected and nothing is written", () => {
  const { env, credentialsFile } = makeSandbox();
  for (const [plane, ref, field] of [
    ["github", { ...GITHUB_REF, account: FAKE_GH_TOKEN }, "account"],
    ["github", { ...GITHUB_REF, host: `Bearer ${FAKE_GH_TOKEN}` }, "host"],
    ["model", { ...MODEL_REF, authMethod: FAKE_ANTHROPIC_KEY }, "authMethod"],
    ["model", { ...MODEL_REF, account: "anjo@example.com" }, "account"],
  ]) {
    assert.throws(() => saveReference(plane, ref, { env }), (error) => error.code === "CREDENTIAL_REFERENCE_SECRET" && error.message.includes(field) && !error.message.includes(FAKE_GH_TOKEN), `${plane}.${field}`);
  }
  assert.equal(existsSync(credentialsFile), false);
});

test("references reject unknown keys (e.g. token), wrong provider/source, and non-strings", () => {
  const { env, credentialsFile } = makeSandbox();
  assert.throws(() => saveReference("github", { ...GITHUB_REF, token: "x" }, { env }), /may not contain 'token'/);
  assert.throws(() => saveReference("github", { ...GITHUB_REF, source: "env" }, { env }), /source/);
  assert.throws(() => saveReference("github", { ...GITHUB_REF, provider: "model" }, { env }), /provider/);
  assert.throws(() => saveReference("github", { ...GITHUB_REF, host: 5 }, { env }), /string/);
  assert.throws(() => saveReference("github", { ...GITHUB_REF, host: undefined }, { env }), /requires 'host'/);
  assert.throws(() => saveReference("asterweave", { provider: "asterweave", state: "ready" }, { env }), /unavailable/);
  assert.throws(() => saveReference("bogus", {}, { env }), /Unknown credential plane/);
  assert.equal(existsSync(credentialsFile), false);
});

test("a hand-edited credentials.json cannot surface a secret through readCredentials", () => {
  const { env, credentialsFile } = makeSandbox();
  saveReference("github", GITHUB_REF, { env });
  const raw = JSON.parse(readFileSync(credentialsFile, "utf8"));
  raw.references.github.account = FAKE_GH_TOKEN;
  raw.references.model = { ...MODEL_REF, token: FAKE_GH_TOKEN };
  writeFileSync(credentialsFile, JSON.stringify(raw));
  assert.deepEqual(readCredentials({ env }), {});
});

test("dropReference removes one plane, reports absence, and writes nothing when absent", () => {
  const { env, credentialsFile } = makeSandbox();
  assert.equal(dropReference("github", { env }), false);
  assert.equal(existsSync(credentialsFile), false);
  saveReference("github", GITHUB_REF, { env });
  saveReference("model", MODEL_REF, { env });
  assert.equal(dropReference("github", { env }), true);
  assert.deepEqual(readCredentials({ env }), { model: MODEL_REF });
  assert.equal(dropReference("github", { env }), false);
});

// --- Logout (reference only) ----------------------------------------------------------------

test("logoutPlan drops only the reference, prints the provider command, spawns nothing", () => {
  const { env } = makeSandbox();
  saveReference("github", { ...GITHUB_REF, host: "ghe.example.com" }, { env });
  saveReference("model", MODEL_REF, { env });
  const spawnGuard = fakeSpawn(() => assert.fail("logout must not spawn"));

  const github = logoutPlan("github", { env });
  assert.deepEqual(github, { plane: "github", droppedReference: true, providerCommand: "gh auth logout -h ghe.example.com" });
  assert.deepEqual(readCredentials({ env }), { model: MODEL_REF }, "the model reference is untouched");

  assert.deepEqual(logoutPlan("model", { env }), { plane: "model", droppedReference: true, providerCommand: "claude auth logout" });
  assert.deepEqual(logoutPlan("model", { env }), { plane: "model", droppedReference: false, providerCommand: "claude auth logout" });
  assert.deepEqual(logoutPlan("github", { env, host: "github.com" }), { plane: "github", droppedReference: false, providerCommand: "gh auth logout -h github.com" });
  assert.equal(spawnGuard.calls.length, 0);
});

test("logoutPlan rejects unknown planes and unsafe hosts (exit 2)", () => {
  const { env } = makeSandbox();
  assert.throws(() => logoutPlan("asterweave", { env }), (error) => error.exitCode === EXIT.USAGE);
  assert.throws(() => logoutPlan("github", { env, host: "-h; rm -rf" }), (error) => error.exitCode === EXIT.USAGE);
});
