import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { runCli } from "../src/cli.mjs";
import { doctorCommand, doctorCommandMeta, formatDoctorReport } from "../src/commands/doctor.mjs";
import { CHECK_IDS, runDoctor } from "../src/doctor.mjs";
import { EXIT, UsageError } from "../src/exit-codes.mjs";
import { grantTrust } from "../src/trust.mjs";
import { claudeStatus, FAKE_GH_TOKEN, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox, NATIVE } from "./auth-helpers.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function sandbox() {
  const box = makeSandbox();
  roots.push(box.root);
  return box;
}

/** `exists` for natively installed binaries (`x.exe` on win32, bare `x` elsewhere). */
const present = (...names) => installed(...names.map((name) => NATIVE(name)));
const isGh =(cmd) => /(^|[\\/])gh(\.exe|\.com)?$/i.test(cmd);
const notConnected = async () => ({ ok: true, connected: false });

/** spawn that answers `gh auth status` and `claude auth status`; either reply can be overridden. */
function providers({ gh = { stdout: ghHosts([ghEntry()]) }, claude = { stdout: claudeStatus() } } = {}) {
  return fakeSpawn((cmd) => (isGh(cmd) ? gh : claude));
}

function options(box, extra = {}) {
  return { env: box.env, cwd: box.root, spawn: providers(), exists: present("gh", "claude"), repoStatus: notConnected, nodeVersion: "22.4.0", ...extra };
}

const byId = (report, id) => report.checks.find((item) => item.id === id);
const statuses = (report) => Object.fromEntries(report.checks.map((item) => [item.id, item.status]));

function makeRepoDir(root, name = "repo") {
  const dir = join(root, name);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  return dir;
}

const GATE_COMMAND = "echo SENTINEL_GATE_COMMAND_TEXT";
function writeGovernedRepo(dir) {
  writeFileSync(join(dir, ".claude", "asterweave.json"), JSON.stringify({ version: 1, qualityGates: { required: [{ id: "t", command: GATE_COMMAND, source: "test" }] } }));
  writeFileSync(join(dir, ".claude", "settings.json"), "{}");
  writeFileSync(join(dir, ".mcp.json"), "{}");
}

describe("runDoctor: all green", () => {
  test("every check passes, in the stable order, and ok is true", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    grantTrust(repo, { env: box.env });
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    assert.equal(report.ok, true);
    assert.deepEqual(report.checks.map((item) => item.id), [...CHECK_IDS]);
    assert.deepEqual([...new Set(report.checks.map((item) => item.status))], ["PASS"], JSON.stringify(report.checks, null, 1));
    for (const item of report.checks) {
      assert.deepEqual(Object.keys(item), ["id", "status", "reason", "remediation"]);
      assert.equal(typeof item.reason, "string");
    }
    assert.match(byId(report, "github.auth").reason, /octo-dev/);
    assert.equal(byId(report, "account.asterweave").reason, "unavailable: no hosted backend configured (local sessions unaffected)");
  });

  test("the temporary write probe is removed from the user directory", async () => {
    const box = sandbox();
    await runDoctor(options(box));
    assert.deepEqual(readdirSync(box.userDir).filter((name) => name.includes("doctor-probe")), []);
  });
});

describe("runDoctor: node version", () => {
  test("older than 22 fails with install guidance", async () => {
    const report = await runDoctor(options(sandbox(), { nodeVersion: "20.11.0" }));
    const item = byId(report, "node.version");
    assert.equal(item.status, "FAIL");
    assert.match(item.reason, /20\.11\.0/);
    assert.match(item.remediation, /Install Node\.js 22/);
    assert.equal(report.ok, false);
  });

  test("22 and later pass, with or without a leading v", async () => {
    for (const nodeVersion of ["22.0.0", "v24.1.0"]) {
      assert.equal(byId(await runDoctor(options(sandbox(), { nodeVersion })), "node.version").status, "PASS");
    }
  });

  test("an unparseable version fails", async () => {
    assert.equal(byId(await runDoctor(options(sandbox(), { nodeVersion: "banana" })), "node.version").status, "FAIL");
  });
});

describe("runDoctor: GitHub", () => {
  test("gh not installed: install FAIL, derived checks skipped", async () => {
    const report = await runDoctor(options(sandbox(), { exists: present("claude") }));
    assert.equal(byId(report, "github.install").status, "FAIL");
    assert.match(byId(report, "github.install").remediation, /cli\.github\.com/);
    assert.equal(byId(report, "github.auth").status, "WARN");
    assert.match(byId(report, "github.auth").reason, /^Skipped/);
    assert.equal(byId(report, "github.scopes").status, "WARN");
    assert.equal(report.ok, false);
  });

  test("not signed in (no hosts): auth FAIL with the login command", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: providers({ gh: { stdout: ghHosts([]) } }) }));
    assert.equal(byId(report, "github.install").status, "PASS");
    assert.equal(byId(report, "github.auth").status, "FAIL");
    assert.match(byId(report, "github.auth").remediation, /gh auth login --web -h github\.com/);
    assert.equal(report.ok, false);
  });

  test("expired or revoked sign-in (state != success): auth FAIL with refresh", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: providers({ gh: { stdout: ghHosts([ghEntry({ state: "error" })]) } }) }));
    assert.equal(byId(report, "github.auth").status, "FAIL");
    assert.match(byId(report, "github.auth").remediation, /gh auth refresh -h github\.com/);
    assert.equal(report.ok, false);
  });

  test("missing scope: auth PASS, scopes FAIL", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: providers({ gh: { stdout: ghHosts([ghEntry({ scopes: "gist" })]) } }) }));
    assert.equal(byId(report, "github.auth").status, "PASS");
    assert.equal(byId(report, "github.scopes").status, "FAIL");
    assert.match(byId(report, "github.scopes").remediation, /repo,read:org/);
    assert.equal(report.ok, false);
  });

  test("unknown scopes (environment token): scopes WARN and ok stays true", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: providers({ gh: { stdout: ghHosts([ghEntry({ scopes: "", tokenSource: "GH_TOKEN" })]) } }) }));
    assert.equal(byId(report, "github.auth").status, "PASS");
    assert.equal(byId(report, "github.scopes").status, "WARN");
    assert.equal(report.ok, true);
  });

  test("unparseable gh output: WARN, not FAIL", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: providers({ gh: { stdout: "not json at all" } }) }));
    assert.equal(byId(report, "github.auth").status, "WARN");
    assert.equal(byId(report, "github.scopes").status, "WARN");
    assert.equal(report.ok, true);
  });

  test("the configured github.host is probed", async () => {
    const box = sandbox();
    writeFileSync(join(box.userDir, "config.json"), JSON.stringify({ github: { host: "ghe.example.com" } }));
    const spawn = providers({ gh: { stdout: ghHosts([ghEntry({ host: "ghe.example.com" })]) } });
    const report = await runDoctor(options(box, { spawn }));
    assert.equal(byId(report, "github.auth").status, "PASS");
    assert.match(byId(report, "github.auth").reason, /ghe\.example\.com/);
  });
});

describe("runDoctor: model provider is never a blocker", () => {
  const cases = [
    ["claude not installed", { exists: present("gh") }, /not found/i, /Install the native Claude Code/],
    ["claude not signed in (loggedIn:false)", { spawn: providers({ claude: { stdout: JSON.stringify({ loggedIn: false }) } }) }, /not signed in/i, /claude auth login/],
    ["claude exits non-zero", { spawn: providers({ claude: { code: 1, stdout: "garbage" } }) }, /exited with code 1/, /claude auth login/],
    ["claude output unparseable", { spawn: providers({ claude: { stdout: "garbage" } }) }, /Could not read/, /Upgrade Claude Code/],
  ];
  for (const [name, extra, reason, remediation] of cases) {
    test(`${name}: WARN, ok stays true`, async () => {
      const report = await runDoctor(options(sandbox(), extra));
      const item = byId(report, "model.claude");
      assert.equal(item.status, "WARN");
      assert.match(item.reason, reason);
      assert.match(item.remediation, remediation);
      assert.equal(report.ok, true);
    });
  }

  test("claude only installed as a .cmd shim: WARN (win32)", { skip: process.platform !== "win32" }, async () => {
    const report = await runDoctor(options(sandbox(), { exists: installed(NATIVE("gh"), "claude.cmd") }));
    assert.equal(byId(report, "model.claude").status, "WARN");
    assert.match(byId(report, "model.claude").reason, /\.cmd shim/);
    assert.equal(report.ok, true);
  });
});

describe("runDoctor: user directory and configuration", () => {
  test("a user directory that is really a file fails with an ASTERWEAVE_CONFIG_DIR hint", async () => {
    const box = sandbox();
    const filePath = join(box.root, "not-a-directory");
    writeFileSync(filePath, "x");
    const report = await runDoctor(options(box, { env: { ...box.env, ASTERWEAVE_CONFIG_DIR: filePath } }));
    const item = byId(report, "user-dir.writable");
    assert.equal(item.status, "FAIL");
    assert.match(item.remediation, /ASTERWEAVE_CONFIG_DIR/);
    assert.equal(report.ok, false);
  });

  test("an injected filesystem that refuses writes fails", async () => {
    const fs = { ...nodeFs, writeFileSync: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } };
    const report = await runDoctor(options(sandbox(), { fs }));
    assert.equal(byId(report, "user-dir.writable").status, "FAIL");
    assert.match(byId(report, "user-dir.writable").reason, /EACCES/);
  });

  test("a probe file that cannot be removed is a WARN", async () => {
    const fs = { ...nodeFs, unlinkSync: () => { throw Object.assign(new Error("busy"), { code: "EBUSY" }); } };
    const report = await runDoctor(options(sandbox(), { fs }));
    assert.equal(byId(report, "user-dir.writable").status, "WARN");
    assert.equal(report.ok, true);
  });

  test("an invalid value in config.json fails with key and origin", async () => {
    const box = sandbox();
    writeFileSync(join(box.userDir, "config.json"), JSON.stringify({ runner: "remote" }));
    const report = await runDoctor(options(box));
    const item = byId(report, "config.valid");
    assert.equal(item.status, "FAIL");
    assert.match(item.reason, /runner/);
    assert.match(item.reason, /config\.json/);
    assert.match(item.reason, /exit code 5/);
    assert.equal(report.ok, false);
  });

  test("an invalid value is never echoed back", async () => {
    const box = sandbox();
    writeFileSync(join(box.userDir, "config.json"), JSON.stringify({ github: { host: "bad host zzsecretvaluezz" } }));
    const report = await runDoctor(options(box));
    assert.equal(byId(report, "config.valid").status, "FAIL");
    assert.doesNotMatch(JSON.stringify(report), /zzsecretvaluezz/);
  });

  test("a config.json that is not JSON fails without quoting its content", async () => {
    const box = sandbox();
    writeFileSync(join(box.userDir, "config.json"), `{"apiKeyNote": zzquotedcontentzz`);
    const report = await runDoctor(options(box));
    const item = byId(report, "config.valid");
    assert.equal(item.status, "FAIL");
    assert.match(item.reason, /not valid JSON/);
    assert.doesNotMatch(JSON.stringify(report), /zzquotedcontentzz/);
  });

  test("an untrusted repository's executable config does not make config invalid", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeGovernedRepo(repo);
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    assert.equal(byId(report, "config.valid").status, "PASS");
  });

  test("an invalid repository adapter of the connected repo fails config.valid", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 2 }));
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    assert.equal(byId(report, "config.valid").status, "FAIL");
    assert.match(byId(report, "config.valid").reason, /repo:/);
  });
});

describe("runDoctor: repository", () => {
  test("not connected: WARN with the connect command, ok stays true", async () => {
    const report = await runDoctor(options(sandbox()));
    const item = byId(report, "repo.connection");
    assert.equal(item.status, "WARN");
    assert.equal(item.remediation, "asterweave repo connect");
    assert.equal(byId(report, "repo.trust").status, "PASS");
    assert.equal(report.ok, true);
  });

  test("connected path vanished: FAIL", async () => {
    const box = sandbox();
    const gone = join(box.root, "gone");
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: false, connected: true, problem: "REPO_PATH_MISSING", repository: "acme/widgets", branch: "main", path: gone }) }));
    const item = byId(report, "repo.connection");
    assert.equal(item.status, "FAIL");
    assert.match(item.reason, /no longer exists/);
    assert.match(item.remediation, /asterweave repo connect/);
    assert.equal(report.ok, false);
  });

  test("no longer a git work tree: FAIL", async () => {
    const box = sandbox();
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: false, connected: true, problem: "REPO_NOT_GIT", repository: "acme/widgets", branch: "main", path: box.root }) }));
    assert.equal(byId(report, "repo.connection").status, "FAIL");
    assert.match(byId(report, "repo.connection").reason, /git work tree/);
  });

  test("repoStatus module missing: WARN 'repository status unavailable'", async () => {
    const missing = async () => { throw Object.assign(new Error("Cannot find module './repo.mjs'"), { code: "ERR_MODULE_NOT_FOUND" }); };
    const report = await runDoctor(options(sandbox(), { repoStatus: missing }));
    assert.equal(byId(report, "repo.connection").status, "WARN");
    assert.match(byId(report, "repo.connection").reason, /repository status unavailable/);
    assert.equal(report.ok, true);
  });

  test("repoStatus throwing: WARN with the (single-line) message", async () => {
    const report = await runDoctor(options(sandbox(), { repoStatus: async () => { throw new Error("repo.json is corrupt\nstack"); } }));
    assert.equal(byId(report, "repo.connection").status, "WARN");
    assert.match(byId(report, "repo.connection").reason, /repository status unavailable: repo\.json is corrupt$/);
  });

  test("the default repoStatus (repo.mjs) reports 'not connected' for an empty user directory", async () => {
    const { repoStatus: _omit, ...rest } = options(sandbox());
    const report = await runDoctor(rest);
    assert.equal(byId(report, "repo.connection").status, "WARN");
    assert.match(byId(report, "repo.connection").reason, /No repository is connected/);
    assert.equal(report.ok, true);
  });

  test("repoStatus receives env/spawn/exists but no secrets are required", async () => {
    let received;
    const box = sandbox();
    await runDoctor(options(box, { repoStatus: async (opts) => { received = opts; return { ok: true, connected: false }; } }));
    assert.equal(received.env, box.env);
    assert.equal(typeof received.spawn, "function");
    assert.equal(typeof received.exists, "function");
  });
});

describe("runDoctor: repository trust", () => {
  test("untrusted connected repo: WARN with counts, grant command, and no command text", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeGovernedRepo(repo);
    const report = await runDoctor(options(box, { repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    const item = byId(report, "repo.trust");
    assert.equal(item.status, "WARN");
    assert.match(item.reason, /1 quality-gate command/);
    assert.match(item.reason, /1 Claude settings file/);
    assert.match(item.reason, /1 MCP server config/);
    assert.match(item.remediation, /^Review the repository config, then run: asterweave trust grant --path /);
    assert.doesNotMatch(JSON.stringify(report), /SENTINEL_GATE_COMMAND_TEXT/);
    assert.equal(report.ok, true);
  });

  test("granting trust turns it PASS; changing a governing file turns it WARN again (CHANGED)", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeGovernedRepo(repo);
    const run = () => runDoctor(options(box, { repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    grantTrust(repo, { env: box.env });
    assert.equal(byId(await run(), "repo.trust").status, "PASS");
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{}}');
    const changed = byId(await run(), "repo.trust");
    assert.equal(changed.status, "WARN");
    assert.match(changed.reason, /changed since trust was granted/);
  });

  test("not connected, but the current directory has governing files: trust is checked for cwd", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeGovernedRepo(repo);
    const report = await runDoctor(options(box, { cwd: repo }));
    assert.equal(byId(report, "repo.connection").status, "WARN");
    assert.equal(byId(report, "repo.trust").status, "WARN");
  });

  test("a trust-governing file inside a connected repo is never executed", async () => {
    const box = sandbox();
    const repo = makeRepoDir(box.root);
    writeGovernedRepo(repo);
    const spawn = providers();
    await runDoctor(options(box, { spawn, repoStatus: async () => ({ ok: true, connected: true, repository: "acme/widgets", branch: "main", path: repo }) }));
    assert.equal(spawn.calls.length, 2); // gh auth status + claude auth status, nothing else
    for (const call of spawn.calls) assert.doesNotMatch(JSON.stringify(call), /SENTINEL_GATE_COMMAND_TEXT/);
  });
});

describe("runDoctor: what doctor will and will not run", () => {
  test("only the two read-only status probes run, in the user directory", async () => {
    const box = sandbox();
    const spawn = providers();
    await runDoctor(options(box, { spawn }));
    const argvs = spawn.calls.map((call) => call.args);
    assert.deepEqual(argvs.map((args) => args.join(" ")).sort(), ["auth status", "auth status --json hosts"]);
    for (const args of argvs) {
      for (const forbidden of ["doctor", "-p", "--print", "--show-token", "-t"]) assert.ok(!args.includes(forbidden), `${forbidden} in ${args.join(" ")}`);
    }
    for (const call of spawn.calls) {
      assert.equal(call.options.cwd, box.userDir);
      assert.equal(call.options.shell, false);
    }
  });

  test("a missing gh is detected without spawning anything for it", async () => {
    const spawn = providers();
    await runDoctor(options(sandbox(), { spawn, exists: present("claude") }));
    assert.ok(spawn.calls.every((call) => !isGh(call.cmd)));
    assert.ok(spawn.calls.every((call) => call.cmd.endsWith(NATIVE("claude"))));
  });
});

describe("runDoctor: secrets never leave", () => {
  const leaky = () => { throw new Error(`spawn failed using Authorization: Bearer ${FAKE_GH_TOKEN} and ${FAKE_GH_TOKEN}`); };

  test("a token inside a probe error is redacted from the report", async () => {
    const report = await runDoctor(options(sandbox(), { spawn: leaky }));
    const text = JSON.stringify(report);
    assert.ok(!text.includes(FAKE_GH_TOKEN));
    assert.ok(!text.includes(FAKE_GH_TOKEN.slice(6)));
    assert.match(byId(report, "github.auth").reason, /Could not run gh/);
  });

  test("a token inside a repoStatus error and a personal email are redacted too", async () => {
    const report = await runDoctor(options(sandbox(), { repoStatus: async () => { throw new Error(`boom ${FAKE_GH_TOKEN} for anjo@example.com`); } }));
    const text = JSON.stringify(report);
    assert.ok(!text.includes(FAKE_GH_TOKEN.slice(6)));
    assert.ok(!text.includes("anjo@example.com"));
  });

  test("text and --json command output contain no token", async () => {
    for (const json of [false, true]) {
      const io = makeIo();
      const code = await doctorCommand(ctxFor(sandbox(), io, { options: { json }, spawn: leaky }));
      assert.equal(code, EXIT.OK);
      assert.ok(!io.out().includes(FAKE_GH_TOKEN.slice(6)));
      assert.ok(!io.err().includes(FAKE_GH_TOKEN.slice(6)));
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Command

function makeIo({ tty = false } = {}) {
  const out = [];
  const err = [];
  return {
    stdout: { isTTY: tty, write: (text) => { out.push(String(text)); return true; } },
    stderr: { isTTY: tty, write: (text) => { err.push(String(text)); return true; } },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function ctxFor(box, io, extra = {}) {
  return {
    name: "doctor", positionals: [], options: {}, rest: [], argv: [], stdin: process.stdin, stdout: io.stdout, stderr: io.stderr,
    env: box.env, cwd: box.root, spawn: providers(), version: "0.0.0-test",
    exists: present("gh", "claude"), repoStatus: notConnected, nodeVersion: "22.4.0", ...extra,
  };
}

describe("doctor command", () => {
  test("--json prints exactly one parseable object on stdout and nothing on stderr", async () => {
    const io = makeIo();
    const code = await doctorCommand(ctxFor(sandbox(), io, { options: { json: true } }));
    assert.equal(code, EXIT.OK);
    assert.equal(io.err(), "");
    const text = io.out();
    assert.ok(text.endsWith("\n") && text.indexOf("\n") === text.length - 1, "a single line");
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), ["ok", "checks"]);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.checks.map((item) => item.id), [...CHECK_IDS]);
  });

  test("--json with a FAIL exits 1, still one object, stderr empty", async () => {
    const io = makeIo();
    const code = await doctorCommand(ctxFor(sandbox(), io, { options: { json: true }, nodeVersion: "18.0.0" }));
    assert.equal(code, EXIT.ERROR);
    assert.equal(io.err(), "");
    const parsed = JSON.parse(io.out());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.checks.find((item) => item.id === "node.version").status, "FAIL");
  });

  test("text mode prints a PASS/WARN/FAIL table with remediation under non-PASS rows and no ANSI off-TTY", async () => {
    const io = makeIo();
    const box = sandbox();
    const code = await doctorCommand(ctxFor(box, io, { nodeVersion: "18.0.0", spawn: providers({ claude: { stdout: JSON.stringify({ loggedIn: false }) } }) }));
    assert.equal(code, EXIT.ERROR);
    const out = io.out();
    assert.doesNotMatch(out, /\x1b/);
    const lines = out.split("\n");
    assert.ok(lines.some((line) => /^PASS {2}github\.auth {2}/.test(line)), out);
    const fail = lines.findIndex((line) => /^FAIL {2}node\.version {2}/.test(line));
    assert.ok(fail >= 0);
    assert.match(lines[fail + 1], /^\s+-> Install Node\.js 22/);
    const warn = lines.findIndex((line) => /^WARN {2}model\.claude {2}/.test(line));
    assert.ok(warn >= 0);
    assert.match(lines[warn + 1], /^\s+-> Run: claude auth login/);
    const pass = lines.findIndex((line) => /^PASS {2}account\.asterweave/.test(line));
    assert.doesNotMatch(lines[pass + 1], /->/);
    assert.match(out, /Blocking problems found: \d+ PASS, \d+ WARN, 1 FAIL/);
    assert.equal(io.err(), "");
  });

  test("all green exits 0", async () => {
    const io = makeIo();
    assert.equal(await doctorCommand(ctxFor(sandbox(), io)), EXIT.OK);
    assert.match(io.out(), /No blocking problems/);
  });

  test("colors appear only on a TTY without NO_COLOR", async () => {
    const report = { ok: true, checks: [{ id: "x", status: "PASS", reason: "fine", remediation: null }] };
    const io = makeIo({ tty: true });
    const box = sandbox();
    await doctorCommand(ctxFor(box, io));
    assert.match(io.out(), /\x1b\[32mPASS/);
    const quiet = makeIo({ tty: true });
    await doctorCommand(ctxFor({ ...box, env: { ...box.env, NO_COLOR: "1" } }, quiet));
    assert.doesNotMatch(quiet.out(), /\x1b/);
    assert.doesNotMatch(formatDoctorReport(report), /\x1b/);
  });

  test("an extra positional is a usage error", async () => {
    await assert.rejects(doctorCommand(ctxFor(sandbox(), makeIo(), { positionals: ["nope"] })), UsageError);
  });

  test("meta declares --json as a boolean option", () => {
    assert.deepEqual([...doctorCommandMeta.boolean], ["json"]);
    assert.match(doctorCommandMeta.summary, /health/);
  });

  test("runCli parses `doctor --json` using the registered meta", async () => {
    const box = sandbox();
    const io = makeIo();
    const commands = new Map([["doctor", { handler: (ctx) => doctorCommand({ ...ctx, exists: present("gh", "claude"), repoStatus: notConnected, nodeVersion: "22.4.0" }), ...doctorCommandMeta }]]);
    const code = await runCli(["doctor", "--json"], { stdout: io.stdout, stderr: io.stderr, env: box.env, cwd: box.root, spawn: providers() }, { commands });
    assert.equal(code, EXIT.OK);
    assert.equal(JSON.parse(io.out()).ok, true);
    assert.equal(io.err(), "");
  });
});
