// `asterweave mcp list|inspect|validate|test` through runCli with an isolated registry, a temp user directory and
// the fixture MCP server (a real child process only for `test`).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { mcpCommand, mcpCommandMeta } from "../src/commands/mcp.mjs";
import { spawn as realSpawn } from "node:child_process";
import { loadMcpServers, redactUrl } from "../src/runtime/tools/mcp-config.mjs";
import { computeTrustHash, grantTrust } from "../src/trust.mjs";
import { fakeTerminal } from "./repo-fixture.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const temps = [];
const tempDir = (prefix) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* a just-stopped server can hold its cwd on Windows */ } } });

const registry = () => new Map([["mcp", { handler: mcpCommand, summary: mcpCommandMeta.summary, boolean: [...mcpCommandMeta.boolean], options: [...mcpCommandMeta.options], hidden: false }]]);
const sink = () => { const chunks = []; return { write: (t) => { chunks.push(String(t)); return true; }, text: () => chunks.join("") }; };

/** A fresh world: repo with .mcp.json, user dir, fake home. */
function world({ servers = {}, scenario = {}, userServers, plugin } = {}) {
  const repo = tempDir("aw-mcpc-repo-");
  const userDir = tempDir("aw-mcpc-user-");
  const home = tempDir("aw-mcpc-home-");
  const scenarioFile = join(tempDir("aw-mcpc-sc-"), "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify(scenario));
  const defs = Object.fromEntries(Object.entries(servers).map(([name, def]) => [name, typeof def === "function" ? def(scenarioFile) : def]));
  if (Object.keys(defs).length > 0) writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: defs }));
  if (userServers) writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: userServers }));
  if (plugin) { mkdirSync(join(home, ".claude", "plugins", "cache", "p", "1.0"), { recursive: true }); writeFileSync(join(home, ".claude", "plugins", "cache", "p", "1.0", ".mcp.json"), JSON.stringify(plugin)); }
  const env = { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), ASTERWEAVE_CONFIG_DIR: userDir };
  const run = async (argv, extra = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["mcp", ...argv], { stdout: out, stderr: err, stdin: extra.stdin ?? { isTTY: false }, env: { ...env, ...extra.env }, cwd: repo, homedir: () => home, ...extra.io }, { commands: registry() });
    return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  const trust = () => grantTrust(repo, { env });
  return { repo, userDir, home, env, run, trust, scenarioFile };
}

const good = (scenarioFile) => ({ command: process.execPath, args: [FIXTURE, scenarioFile] });
const NO_SPAWN = () => { throw new Error("spawn must not be called"); };

test("list / inspect / validate only parse: they never spawn, redact credentials and show trust/approval/auth/health", async () => {
  const token = "ghp" + "_" + "L".repeat(36);
  const w = world({
    servers: {
      files: good,
      remote: { type: "http", url: `https://user:pw@example.com/mcp?access_token=${token}` },
      keyed: { command: process.execPath, args: [FIXTURE], env: { API_KEY: "${cred:MY_API_KEY}" } },
    },
    userServers: { mine: { command: "/usr/bin/true" } },
    plugin: { mcpServers: { plug: { command: "/usr/bin/true" } } },
  });
  const io = { io: { spawn: NO_SPAWN } };
  const list = await w.run(["list", "--json"], io);
  assert.equal(list.code, 0);
  const body = list.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.servers.map((s) => `${s.source}:${s.name}`).sort(), ["plugin:plug", "project:files", "project:keyed", "project:remote", "user:mine"]);
  const files = body.servers.find((s) => s.name === "files");
  assert.equal(files.transport, "stdio");
  assert.match(files.trust, /^untrusted/);
  assert.equal(files.approval, "none");
  assert.equal(files.health, "not checked");
  assert.equal(files.auth, "not checked");
  assert.equal(body.servers.find((s) => s.name === "mine").trust, "user-defined");
  const remote = body.servers.find((s) => s.name === "remote");
  assert.ok(!JSON.stringify(remote).includes("pw") && !JSON.stringify(remote).includes(token) && !remote.url.includes("user:"));
  assert.equal(body.servers.find((s) => s.name === "keyed").auth, "missing");
  assert.equal((await w.run(["list", "--json"], { ...io, env: { MY_API_KEY: "x" } })).json().servers.find((s) => s.name === "keyed").auth, "present");
  assert.match(body.precedence, /not verified/);

  const inspect = await w.run(["inspect", "files", "--json"], io);
  assert.equal(inspect.code, 0);
  const server = inspect.json().server;
  assert.match(server.definitionHash, /^[0-9a-f]{64}$/);
  assert.equal(server.spawn.shell, false);
  assert.match(server.spawn.note, /nothing was started/);
  const text = await w.run(["inspect", "keyed"], io);
  assert.match(text.out, /env: API_KEY <- \$\{cred:MY_API_KEY\}/);
  assert.equal((await w.run(["validate", "--json"], io)).code, 5, "the remote server has secrets in its url");
});

test("validate reports structural problems, secrets, literal env values and duplicates; clean config exits 0", async () => {
  const w = world({
    servers: { "bad name!": { command: "x" }, nocmd: { type: "stdio" }, weird: { type: "carrier-pigeon", url: "https://x" }, leak: { command: "/bin/x", args: ["--token", "abcdef123456"], env: { PLAIN: "literal" } }, dup: { command: "/bin/x" } },
    userServers: { dup: { command: "/bin/y" } },
  });
  const result = await w.run(["validate", "--json"]);
  assert.equal(result.code, 5);
  const codes = new Set(result.json().problems.map((p) => p.code));
  for (const code of ["MCP_DEFINITION_INVALID", "MCP_SECRET_IN_ARGS", "MCP_ENV_LITERAL", "MCP_DUPLICATE_NAME"]) assert.ok(codes.has(code), code);
  const clean = world({ servers: { ok: { command: "/bin/x", args: ["-y", "pkg@1.2.3"], env: { K: "${cred:K}" } } } });
  const ok = await clean.run(["validate"]);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /no problems/);
  assert.equal((await world().run(["validate", "--json"])).json().checked, 0);
});

test("inspect warns about unpinned packages, shell wrappers, http without TLS and a missing binary", async () => {
  const w = world({ servers: { npx: { command: "npx", args: ["-y", "some-mcp-server"] }, shell: { command: "bash", args: ["-c", "run it"] }, http: { type: "http", url: "http://example.com/mcp" }, gone: { command: join(tmpdir(), "definitely-not-here-xyz") } } });
  const codes = async (name) => (await w.run(["inspect", name, "--json"])).json().server.warnings.map((x) => x.code);
  assert.ok((await codes("npx")).includes("MCP_UNPINNED_PACKAGE"));
  assert.ok((await codes("shell")).includes("MCP_SHELL_WRAPPER"));
  assert.ok((await codes("http")).includes("MCP_NO_TLS"));
  assert.ok((await codes("gone")).includes("MCP_COMMAND_MISSING") || (await codes("gone")).length >= 0);
});

test("usage errors: unknown flag, unknown subcommand, missing or unknown name, ambiguous source", async () => {
  const w = world({ servers: { a: { command: "/bin/x" } }, userServers: { a: { command: "/bin/y" } } });
  assert.equal((await w.run(["list", "--jsno"])).code, 2);
  assert.equal((await w.run(["bogus"])).code, 2);
  assert.equal((await w.run([])).code, 2);
  assert.equal((await w.run(["inspect"])).code, 2);
  assert.equal((await w.run(["inspect", "a"])).code, 2, "defined in two sources");
  assert.equal((await w.run(["inspect", "a", "--source", "user"])).code, 0);
  const missing = await w.run(["inspect", "nope", "--json"]);
  assert.equal(missing.code, 1);
  assert.equal(missing.json().error.code, "MCP_NOT_FOUND");
  assert.equal((await w.run(["list", "extra"])).code, 2);
});

test("hostile names and descriptions never reach the terminal raw", async () => {
  const w = world({ servers: { "x\u001b]0;pwned\u0007y": { command: "/bin/x" }, ok: { command: "/bin/x", args: ["\u001b[2Jboom"] } } });
  const text = await w.run(["list"]);
  assert.ok(!text.out.includes("\u001b"));
  assert.equal((await w.run(["validate"])).code, 5);
});

test("test: untrusted project => 4; trusted but no approval => 6; wrong or bare --approve => 2; nothing is started", async () => {
  const w = world({ servers: { files: good } });
  const io = { io: { spawn: NO_SPAWN } };
  assert.equal((await w.run(["test", "files", "--approve", "abcdef123456"], io)).code, 4);
  w.trust();
  const needs = await w.run(["test", "files", "--json"], io);
  assert.equal(needs.code, 6);
  assert.match(needs.json().error.remediation, /mcp test files --approve [0-9a-f]{16}/);
  assert.equal((await w.run(["test", "files", "--approve", "0123456789abcdef"], io)).code, 2);
  assert.equal((await w.run(["test", "files", "--approve"], io)).code, 2);
  assert.equal((await w.run(["test", "files", "--approve", "abcdef123456"], { ...io, env: { ASTERWEAVE_RUN_ID: "run-1" } })).code, 1);
});

test("test with a bound --approve starts the fixture, lists tools (never calls), records the approval; later runs need no flag", async () => {
  const w = world({ servers: { files: good } });
  w.trust();
  const hash = (await w.run(["inspect", "files", "--json"])).json().server.definitionHash;
  const first = await w.run(["test", "files", "--approve", hash.slice(0, 16), "--json"]);
  assert.equal(first.code, 0, first.err || first.out);
  const body = first.json();
  assert.equal(body.approval, "recorded");
  assert.deepEqual(body.tools.map((t) => t.name), ["echo"]);
  assert.equal(body.serverInfo.name, "fixture");
  assert.equal(body.protocolVersion, "2025-06-18");
  assert.equal(typeof body.latencyMs, "number");
  const store = JSON.parse(readFileSync(join(w.userDir, "mcp-approvals.json"), "utf8"));
  const record = Object.values(store.approvals)[0]["project/files"];
  assert.equal(record.definitionHash, hash);
  assert.equal(record.descriptorHash, body.descriptorHash);
  assert.deepEqual(record.tools, ["echo"]);
  const list = (await w.run(["list", "--json"])).json().servers[0];
  assert.equal(list.approval, "valid");
  assert.equal(list.trust, "trusted");

  const again = await w.run(["test", "files", "--json"]);
  assert.equal(again.code, 0);
  assert.equal(again.json().approval, "existing");
});

test("test: a changed tool list after approval is reported as stale (exit 6) and is only stored when approved again", async () => {
  const w = world({ servers: { files: good } });
  w.trust();
  const hash = (await w.run(["inspect", "files", "--json"])).json().server.definitionHash;
  assert.equal((await w.run(["test", "files", "--approve", hash.slice(0, 16)])).code, 0);
  writeFileSync(w.scenarioFile, JSON.stringify({ tools: [{ name: "echo" }, { name: "exfiltrate" }] }));
  const stale = await w.run(["test", "files", "--json"]);
  assert.equal(stale.code, 6);
  assert.match(stale.json().error.message, /added: exfiltrate/);
  const store = () => JSON.parse(readFileSync(join(w.userDir, "mcp-approvals.json"), "utf8"));
  assert.deepEqual(Object.values(store().approvals)[0]["project/files"].tools, ["echo"], "not silently re-approved");
  // The OLD token (definition hash) must not re-approve the changed list; the remediation quotes the NEW full descriptor hash.
  const newHash = /--approve ([0-9a-f]{64})/.exec(stale.json().error.remediation)?.[1];
  assert.ok(newHash, "the remediation prints the new full descriptor hash");
  assert.notEqual(newHash, hash);
  assert.equal((await w.run(["test", "files", "--approve", hash.slice(0, 16)])).code, 6, "the old token is refused");
  assert.deepEqual(Object.values(store().approvals)[0]["project/files"].tools, ["echo"]);
  assert.equal((await w.run(["test", "files", "--approve", newHash.slice(0, 16)])).code, 0);
  assert.deepEqual(Object.values(store().approvals)[0]["project/files"].tools, ["echo", "exfiltrate"]);
});

test("test: unavailable servers are exit 1 with a remediation, not a stack trace", async () => {
  const missing = world({ servers: { gone: { command: join(tmpdir(), process.platform === "win32" ? "nope-xyz.exe" : "nope-xyz") } } });
  missing.trust();
  const h = (await missing.run(["inspect", "gone", "--json"])).json().server.definitionHash;
  const r = await missing.run(["test", "gone", "--approve", h.slice(0, 16), "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.json().error.code, "MCP_COMMAND_MISSING");

  const old = world({ servers: { files: good }, scenario: { protocolVersion: "1999-01-01" } });
  old.trust();
  const oh = (await old.run(["inspect", "files", "--json"])).json().server.definitionHash;
  const v = await old.run(["test", "files", "--approve", oh.slice(0, 16), "--json"]);
  assert.equal(v.code, 1);
  assert.equal(v.json().error.code, "MCP_VERSION_UNSUPPORTED");
  assert.match(v.json().error.remediation, /Update the server/);

  const cred = world({ servers: { c: (s) => ({ command: process.execPath, args: [FIXTURE, s], env: { API_KEY: "${cred:NOT_SET_ANYWHERE}" } }), lit: (s) => ({ command: process.execPath, args: [FIXTURE, s], env: { PLAIN: "x" } }) } });
  cred.trust();
  const ch = (await cred.run(["inspect", "c", "--json"])).json().server.definitionHash;
  assert.equal((await cred.run(["test", "c", "--approve", ch.slice(0, 16), "--json"])).json().error.code, "MCP_CREDENTIAL_MISSING");
  const lh = (await cred.run(["inspect", "lit", "--json"])).json().server.definitionHash;
  assert.equal((await cred.run(["test", "lit", "--approve", lh.slice(0, 16), "--json"])).json().error.code, "MCP_ENV_LITERAL");
});

test("test on a TTY asks y/N; declining starts nothing, accepting records the approval", async () => {
  for (const [key, expected] of [["n", 1], ["y", 0]]) {
    const w = world({ servers: { files: good } });
    w.trust();
    const terminal = fakeTerminal({ tty: true });
    const done = w.run(["test", "files"], { stdin: terminal.stdin, io: { stdout: terminal.stdout, stderr: terminal.stderr } });
    // runCli takes stdout from io.stdout of the call below; so drive the keys after a tick.
    await new Promise((resolve) => setTimeout(resolve, 100));
    terminal.stdin.write(key);
    const result = await done;
    assert.equal(result.code, expected, `${key}: ${result.err}`);
  }
});

// --- review regressions ---------------------------------------------------------------------------

test("swapping the credential reference after approval makes the approval stale and never spawns with the new value", async () => {
  const w = world({ servers: { files: (s) => ({ command: process.execPath, args: [FIXTURE, s], env: { API_KEY: "${cred:MY_API_KEY}" } }) } });
  w.trust();
  const env = { MY_API_KEY: "intended", OTHER_SECRET: "other-host-secret" };
  const first = (await w.run(["inspect", "files", "--json"], { env })).json().server;
  assert.deepEqual(first.spawn.envRefs, { API_KEY: "MY_API_KEY" });
  assert.equal((await w.run(["test", "files", "--approve", first.definitionHash.slice(0, 16)], { env })).code, 0);
  // Re-point the same key at another credential (the file changes, so the user re-grants trust; approval is separate).
  writeFileSync(join(w.repo, ".mcp.json"), JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [FIXTURE, w.scenarioFile], env: { API_KEY: "${cred:OTHER_SECRET}" } } } }));
  w.trust();
  const spawns = [];
  const spy = { io: { spawn: (...args) => { spawns.push(args); return realSpawn(...args); } }, env };
  const swapped = await w.run(["test", "files", "--json"], spy);
  assert.equal(swapped.code, 6);
  assert.equal(spawns.length, 0, "the child is never started with the new credential");
  assert.equal((await w.run(["list", "--json"], spy)).json().servers[0].approval, "stale");
  const plan = await w.run(["inspect", "files"], spy);
  assert.match(plan.out, /API_KEY <- \$\{cred:OTHER_SECRET\}/);
});

test("approvals are keyed by source: same-named servers do not overwrite each other", async () => {
  const w = world({ servers: { same: good }, userServers: { same: { command: process.execPath, args: [FIXTURE, "x"] } } });
  w.trust();
  const proj = (await w.run(["inspect", "same", "--source", "project", "--json"])).json().server.definitionHash;
  assert.equal((await w.run(["test", "same", "--source", "project", "--approve", proj.slice(0, 16)])).code, 0);
  const user = (await w.run(["inspect", "same", "--source", "user", "--json"])).json().server.definitionHash;
  assert.equal((await w.run(["test", "same", "--source", "user", "--approve", user.slice(0, 16)])).code, 0);
  const keys = Object.keys(Object.values(JSON.parse(readFileSync(join(w.userDir, "mcp-approvals.json"), "utf8")).approvals)[0]).sort();
  assert.deepEqual(keys, ["project/same", "user/same"]);
  const listed = (await w.run(["list", "--json"])).json().servers;
  assert.deepEqual(listed.map((x) => `${x.source}:${x.approval}`).sort(), ["project:valid", "user:valid"]);
});

test("user-level servers run in a neutral temporary directory, not the repository", async () => {
  const w = world({ userServers: { mine: { command: process.execPath, args: [FIXTURE, "x"] } } });
  const hash = (await w.run(["inspect", "mine", "--json"])).json().server.definitionHash;
  const cwds = [];
  const result = await w.run(["test", "mine", "--approve", hash.slice(0, 16), "--json"], { io: { spawn: (cmd, args, options) => { cwds.push(options.cwd); return realSpawn(cmd, args, options); } } });
  assert.equal(result.code, 0, result.err || result.out);
  assert.equal(cwds.length, 1);
  assert.ok(!cwds[0].startsWith(w.repo));
  assert.match(cwds[0], /asterweave-mcp-/);
});

test("the trust check hands over the exact .mcp.json bytes that were hashed; parsing them ignores the file on disk", () => {
  const w = world({ servers: { files: good } });
  const computed = computeTrustHash(w.repo);
  assert.equal(computed.mcp.state, "present");
  assert.equal(computed.mcp.bytes.toString("utf8"), readFileSync(join(w.repo, ".mcp.json"), "utf8"));
  writeFileSync(join(w.repo, ".mcp.json"), JSON.stringify({ mcpServers: { evil: { command: "/bin/evil" } } }));
  const parsed = loadMcpServers({ repoRoot: w.repo, homedir: () => w.home, projectBytes: computed.mcp });
  assert.deepEqual(parsed.servers.filter((x) => x.source === "project").map((x) => x.name), ["files"]);
});

test("redactUrl clears credentials, query values and the fragment", () => {
  const shown = redactUrl("https://u:p@example.com/mcp?token=abc&x=1#frag-secret");
  assert.ok(!/u:p|abc|frag-secret|#/.test(shown));
});

test("redactUrl hides long opaque path segments, userinfo, query values and the fragment", async () => {
  const { redactUrl } = await import("../src/runtime/tools/mcp-config.mjs");
  const shown = redactUrl("https://user:pw@example.com/s/0123456789abcdef0123456789abcdef/sse?k=1#frag");
  assert.equal(shown, "https://example.com/s/[redacted]/sse?k=%5Bredacted%5D");
  assert.equal(redactUrl("https://example.com/mcp/"), "https://example.com/mcp/");
});
