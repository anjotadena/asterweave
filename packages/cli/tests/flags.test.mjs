// S3 (unknown flags exit 2), S2 (github.host fail-fast for launch / repo connect), D2 (host validated
// before any probe) and ui.color wiring.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { NATIVE, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox } from "./auth-helpers.mjs";
import { cleanupTemp, fakeTerminal, makeClone } from "./repo-fixture.mjs";

after(cleanupTemp);

const exists = installed(NATIVE("gh"), NATIVE("claude"));
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};
const okSpawn = () => fakeSpawn((cmd) => (/gh(\.exe)?$/i.test(cmd) ? { stdout: ghHosts({ "github.com": [ghEntry()] }) } : { stdout: claudeStatus() }));

async function run(argv, sandbox, extra = {}) {
  const stdout = sink();
  const stderr = sink();
  const spawn = extra.spawn ?? okSpawn();
  const code = await runCli(argv, { stdout, stderr, stdin: sink(), env: sandbox.env, cwd: sandbox.root, homedir: () => sandbox.root, spawn, exists, ...extra });
  return { code, out: stdout.text(), err: stderr.text(), spawn };
}

// --- S3: unknown flags --------------------------------------------------------------------------

const UNKNOWN = [
  ["doctor", "--jsno"],
  ["config", "show", "--bogus", "x"],
  ["repo", "status", "--path", "X"],
  ["repo", "connect", "--bogus"],
  ["auth", "status", "--bogus"],
  ["auth", "logout", "github", "--bogus"],
  ["trust", "status", "--bogus"],
  ["trust", "grant", "--bogus"],
  ["help", "--bogus"],
  ["launch", "--bogus"],
];

test("every command rejects an unknown flag with exit 2, names it, and runs no side effects", async () => {
  for (const argv of UNKNOWN) {
    const sandbox = makeSandbox();
    const { code, err, out, spawn } = await run(argv, sandbox);
    assert.equal(code, EXIT.USAGE, argv.join(" "));
    assert.equal(spawn.calls.length, 0, `${argv.join(" ")} spawned something`);
    assert.equal(out, "", argv.join(" "));
    if (argv[0] !== "repo" || argv[1] !== "status") {
      assert.match(err, new RegExp(`Unknown option '--${argv.find((a) => a.startsWith("--") && !["--path"].includes(a)).slice(2)}'`), argv.join(" "));
    }
    assert.match(err, /asterweave help|only applies to repo connect/, argv.join(" "));
  }
});

test("a mistyped boolean flag is not silently ignored: `doctor --jsno` exits 2 instead of running", async () => {
  const { code, err, spawn } = await run(["doctor", "--jsno"], makeSandbox());
  assert.equal(code, 2);
  assert.match(err, /Unknown option '--jsno' for 'asterweave doctor'/);
  assert.equal(spawn.calls.length, 0);
});

test("unknown flag in --json mode yields the JSON envelope on stdout", async () => {
  const { code, out, err } = await run(["doctor", "--json", "--jsno"], makeSandbox());
  assert.equal(code, 2);
  assert.equal(err, "");
  const body = JSON.parse(out);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "USAGE");
  assert.match(body.error.message, /--jsno/);
  assert.match(body.error.remediation, /asterweave help doctor/);
});

test("control characters in an unknown flag name are stripped from the message", async () => {
  const { code, err } = await run(["doctor", "--x\x1b[31my"], makeSandbox());
  assert.equal(code, 2);
  assert.equal(err.includes("\x1b"), false);
});

test("every documented flag is still accepted (no 'Unknown option')", async () => {
  const sandbox = makeSandbox();
  const clone = makeClone();
  const cases = [
    ["doctor", "--json"],
    ["config", "show", "--json", "--runner", "local", "--github-host", "github.com", "--ui-color", "never", "--path", clone],
    ["auth", "status", "--json", "--host", "github.com"],
    ["auth", "logout", "github", "--json", "--host", "github.com"],
    ["trust", "status", "--json", "--path", clone],
    ["repo", "status", "--json"],
    ["repo", "connect", "--json", "--repo", "acme/widgets", "--branch", "main", "--path", clone],
    ["help", "doctor"],
    ["doctor", "--help"],
    ["--version"],
  ];
  for (const argv of cases) {
    const { code, out, err } = await run(argv, sandbox);
    assert.ok(!/Unknown option/.test(out + err), `${argv.join(" ")} -> ${out}${err}`);
    assert.notEqual(code, EXIT.USAGE, `${argv.join(" ")} -> ${err}`);
  }
});

test("config show --path layers that repository in with the same trust rules", async () => {
  const sandbox = makeSandbox();
  const repo = makeClone();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, qualityGates: { required: [{ id: "unit", command: "echo hi", source: "t" }] } }));
  const { code, out } = await run(["config", "show", "--json", "--path", repo], sandbox);
  assert.equal(code, 0);
  const view = JSON.parse(out);
  assert.equal(view.repo.path, repo);
  assert.equal(view.repo.trusted, false);
  assert.deepEqual(view.repo.skipped, ["qualityGates.required"]);
});

// --- D2: validate before probing -----------------------------------------------------------------

test("auth status --host 'bad host!' exits 2 before any probe is spawned", async () => {
  const { code, spawn, err } = await run(["auth", "status", "--host", "bad host!"], makeSandbox());
  assert.equal(code, 2);
  assert.equal(spawn.calls.length, 0);
  assert.match(err, /Invalid GitHub host/);
});

test("auth login --host 'bad host!' exits 2 before any picker or hand-off", async () => {
  const sandbox = makeSandbox();
  const term = fakeTerminal();
  const spawn = okSpawn();
  const code = await runCli(["auth", "login", "--host", "-x flag"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: sandbox.root, spawn, exists, homedir: () => sandbox.root });
  assert.equal(code, 2);
  assert.equal(spawn.calls.length, 0);
  assert.equal(term.stdin.rawCalls.length, 0, "no picker was opened");
});

// --- S2: github.host --------------------------------------------------------------------------------

function ghe(sandbox) {
  return { ...sandbox.env, TERM: "xterm", ASTERWEAVE_GITHUB_HOST: "ghe.example.com" };
}

test("launch fails fast on a non-github.com github.host: exit 5, nothing probed, no terminal entered", async () => {
  const sandbox = makeSandbox();
  const term = fakeTerminal();
  const spawn = okSpawn();
  const code = await runCli([], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: ghe(sandbox), cwd: sandbox.root, spawn, exists, homedir: () => sandbox.root });
  assert.equal(code, EXIT.CONFIG);
  assert.equal(spawn.calls.length, 0);
  assert.equal(term.stdin.rawCalls.length, 0);
  const text = term.errText();
  assert.match(text, /launch and repo connect support github\.com only in this build; github\.host is ghe\.example\.com \(origin: env:ASTERWEAVE_GITHUB_HOST\)/);
  assert.match(text, /Unset github\.host/);
});

test("repo connect fails fast on a non-github.com github.host, interactive or not, before any probe or picker", async () => {
  const sandbox = makeSandbox();
  const clone = makeClone();
  const spawn = okSpawn();
  const plain = await run(["repo", "connect", "--repo", "acme/widgets", "--branch", "main", "--path", clone, "--json"], { ...sandbox, env: ghe(sandbox) }, { env: ghe(sandbox), spawn });
  assert.equal(plain.code, EXIT.CONFIG);
  assert.equal(JSON.parse(plain.out).error.code, "GITHUB_HOST_UNSUPPORTED");

  const term = fakeTerminal();
  const code = await runCli(["repo", "connect", "--path", clone], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: ghe(sandbox), cwd: sandbox.root, spawn, exists, homedir: () => sandbox.root });
  assert.equal(code, EXIT.CONFIG);
  assert.equal(term.stdin.rawCalls.length, 0);
  assert.equal(spawn.calls.length, 0, "no gh or git process was started");
});

test("a github.host from the user config file is reported with its origin; github.com (any source) is allowed", async () => {
  const sandbox = makeSandbox();
  writeFileSync(join(sandbox.userDir, "config.json"), JSON.stringify({ github: { host: "git.corp.example" } }));
  const { code, out } = await run(["repo", "connect", "--repo", "acme/widgets", "--branch", "main", "--json"], sandbox);
  assert.equal(code, EXIT.CONFIG);
  assert.match(JSON.parse(out).error.message, /github\.host is git\.corp\.example \(origin: user:.*config\.json\)/);

  const allowed = makeSandbox();
  const result = await run(["repo", "connect", "--repo", "acme/widgets", "--branch", "main", "--json"], { ...allowed, env: { ...allowed.env, ASTERWEAVE_GITHUB_HOST: "github.com" } }, { env: { ...allowed.env, ASTERWEAVE_GITHUB_HOST: "github.com" } });
  assert.notEqual(JSON.parse(result.out).error?.code, "GITHUB_HOST_UNSUPPORTED");
});

// --- ui.color -----------------------------------------------------------------------------------------

async function doctorOnTty(sandbox, env) {
  const out = sink();
  const stdout = Object.assign(out, { isTTY: true });
  const code = await runCli(["doctor"], { stdout, stderr: sink(), stdin: sink(), env, cwd: sandbox.root, homedir: () => sandbox.root, spawn: okSpawn(), exists });
  return { code, text: out.text() };
}

test("ui.color=never removes color from doctor on a TTY; auto keeps it; NO_COLOR wins over always", async () => {
  const sandbox = makeSandbox();
  const auto = await doctorOnTty(sandbox, sandbox.env);
  assert.ok(auto.text.includes("\x1b["), "auto: colored on a TTY");

  writeFileSync(join(sandbox.userDir, "config.json"), JSON.stringify({ ui: { color: "never" } }));
  const never = await doctorOnTty(sandbox, sandbox.env);
  assert.equal(never.text.includes("\x1b"), false, "ui.color=never in config.json");

  rmConfig(sandbox);
  const viaEnv = await doctorOnTty(sandbox, { ...sandbox.env, ASTERWEAVE_UI_COLOR: "never" });
  assert.equal(viaEnv.text.includes("\x1b"), false, "ASTERWEAVE_UI_COLOR=never");

  const noColor = await doctorOnTty(sandbox, { ...sandbox.env, NO_COLOR: "1", ASTERWEAVE_UI_COLOR: "always" });
  assert.equal(noColor.text.includes("\x1b"), false, "NO_COLOR always wins");
});

function rmConfig(sandbox) {
  writeFileSync(join(sandbox.userDir, "config.json"), "{}");
}

test("ui.color=always colors doctor output even when stdout is not a TTY", async () => {
  const sandbox = makeSandbox();
  const { text } = await (async () => {
    const out = sink();
    const code = await runCli(["doctor"], { stdout: out, stderr: sink(), stdin: sink(), env: { ...sandbox.env, ASTERWEAVE_UI_COLOR: "always" }, cwd: sandbox.root, homedir: () => sandbox.root, spawn: okSpawn(), exists });
    return { code, text: out.text() };
  })();
  assert.ok(text.includes("\x1b["));
});
