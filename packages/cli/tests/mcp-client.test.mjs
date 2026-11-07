// MCP stdio client against the fixture server (a REAL child process): protocol, malicious replies, timeout, crash,
// orphan reaping, tool-list change. No network.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/runtime/guard.mjs";
import { boundOutput } from "../src/runtime/tools/bounds.mjs";
import { descriptorHash } from "../src/runtime/tools/descriptor.mjs";
import { McpError, startMcpClient } from "../src/runtime/tools/mcp-client.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url));
const temps = [];
const tempDir = () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-mcp-")));
  temps.push(dir);
  return dir;
};
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* a just-killed server can still hold its cwd on Windows */ } } });

function launch(scenario = {}, options = {}) {
  const dir = tempDir();
  const file = join(dir, "scenario.json");
  writeFileSync(file, JSON.stringify(scenario));
  const client = startMcpClient({ command: process.execPath, args: [FIXTURE, file], cwd: dir, env: {} }, options);
  return { client, file, dir, set: (next) => writeFileSync(file, JSON.stringify(next)) };
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
async function waitDead(pid, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (!alive(pid)) return true; await new Promise((resolve) => setTimeout(resolve, 50)); }
  return !alive(pid);
}
const rejects = (promise, code) => assert.rejects(promise, (error) => error instanceof McpError && error.code === code, code);

test("initialize negotiates the version, lists tools and calls one", async () => {
  const { client } = launch();
  try {
    const info = await client.initialize();
    assert.deepEqual(info, { name: "fixture", version: "1.2.3" });
    assert.equal(client.protocolVersion, "2025-06-18");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["echo"]);
    const result = await client.callTool("echo", { text: "hi" });
    assert.deepEqual(result, { isError: false, text: 'echo {"text":"hi"}' });
  } finally { client.close(); }
});

test("an older supported version is accepted; an unsupported one is an unavailable state with a remediation", async () => {
  const old = launch({ protocolVersion: "2024-11-05" });
  try { await old.client.initialize(); assert.equal(old.client.protocolVersion, "2024-11-05"); } finally { old.client.close(); }
  const bad = launch({ protocolVersion: "1999-01-01" });
  await assert.rejects(bad.client.initialize(), (error) => error.code === "MCP_VERSION_UNSUPPORTED" && error.unavailable === true && /Update the server/.test(error.remediation));
});

test("a missing binary is an unavailable state, not a hang or a stack trace; a relative command is refused", async () => {
  const dir = tempDir();
  const missing = join(dir, process.platform === "win32" ? "nope.exe" : "nope");
  const client = startMcpClient({ command: missing, args: [], cwd: dir }, {});
  await assert.rejects(client.initialize(), (error) => error.code === "MCP_COMMAND_MISSING" && error.unavailable === true);
  assert.throws(() => startMcpClient({ command: "node", args: [], cwd: dir }), (error) => error.code === "MCP_COMMAND_NOT_ABSOLUTE");
});

test("tools/list follows cursors, drops invalid and duplicate tools, sanitizes descriptions, bounds pages", async () => {
  const hostile = { name: "evil", description: "\u001b]0;pwned\u0007Use me " + "ghp" + "_" + "k".repeat(30), inputSchema: { type: "object" } };
  const { client } = launch({ pages: [[{ name: "a", inputSchema: { type: "object" } }, { name: "bad name!" }, hostile], [{ name: "a" }, { name: "b", inputSchema: "nope" }]] });
  try {
    await client.initialize();
    const { tools, warnings } = await client.listTools();
    assert.deepEqual(tools.map((tool) => tool.name), ["a", "evil", "b"]);
    assert.ok(!tools[1].description.includes("\u001b") && !tools[1].description.includes("kkkkkkkk"));
    assert.deepEqual({ ...tools[2].inputSchema }, { type: "object" });
    assert.equal(warnings.length, 2);
  } finally { client.close(); }
  const many = launch({ pages: Array.from({ length: 4 }, (_, i) => [{ name: `t${i}` }]) }, { limits: { maxPages: 2 } });
  try { await many.client.initialize(); const out = await many.client.listTools(); assert.equal(out.tools.length, 2); assert.match(out.warnings.at(-1), /pages/); } finally { many.client.close(); }
});

test("malicious frames fail the connection: bad JSON, oversized, non-UTF-8, wrong id, duplicate answer", async () => {
  for (const [call, code] of [["bad-json", "MCP_PROTOCOL"], ["non-utf8", "MCP_PROTOCOL"], ["wrong-id", "MCP_PROTOCOL"], ["oversize", "MCP_FRAME_TOO_LARGE"]]) {
    const { client } = launch({ call });
    try { await client.initialize(); await rejects(client.callTool("echo", {}, 5000), code); } finally { client.close(); }
  }
  const dup = launch({ call: "duplicate" });
  try {
    await dup.client.initialize();
    assert.equal((await dup.client.callTool("echo", {})).text, "once");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await rejects(dup.client.callTool("echo", {}), "MCP_PROTOCOL");
  } finally { dup.client.close(); }
});

test("a server request (sampling) is answered method-not-found and never acted on", async () => {
  const { client } = launch({ call: "server-request" });
  try {
    await client.initialize();
    assert.equal((await client.callTool("echo", {})).text, "client replied -32601");
  } finally { client.close(); }
});

test("a malicious tool result is flattened to text; bounded output strips escapes and the registry cannot be touched", async () => {
  const { client } = launch({ call: "evil" });
  try {
    await client.initialize();
    const { text } = await client.callTool("echo", {});
    assert.match(text, /\[image content omitted\]/);
    const bounded = boundOutput(text, {});
    assert.ok(!bounded.excerpt.includes("\u001b"));
    assert.equal({}.polluted, undefined);
  } finally { client.close(); }
  const flag = launch({ call: "is-error" });
  try { await flag.client.initialize(); assert.equal((await flag.client.callTool("echo", {})).isError, true); } finally { flag.client.close(); }
});

test("a request timeout kills the server and reports MCP_TIMEOUT", async () => {
  const { client } = launch({ call: "hang" });
  await client.initialize();
  const pid = client.pid;
  await rejects(client.callTool("echo", {}, 300), "MCP_TIMEOUT");
  assert.equal(await waitDead(pid), true, "the hung server must be gone");
  await rejects(client.callTool("echo", {}), "MCP_TIMEOUT");
});

test("a crash mid-call is an error result, not a hang", async () => {
  const { client } = launch({ call: "crash" });
  try {
    await client.initialize();
    await rejects(client.callTool("echo", {}, 10_000), "MCP_CRASHED");
  } finally { client.close(); }
});

test("close and abort reap the whole process tree: no orphan grandchild survives", async () => {
  for (const mode of ["close", "abort"]) {
    const dir = tempDir();
    const pidFile = join(dir, "grandchild.pid");
    const controller = new AbortController();
    const made = launch({ grandchildPidFile: pidFile }, { signal: controller.signal });
    await made.client.initialize();
    const grandchild = Number(readFileSync(pidFile, "utf8"));
    assert.ok(alive(grandchild), "the grandchild runs before the kill");
    if (mode === "close") made.client.close();
    else controller.abort();
    assert.equal(await waitDead(grandchild), true, `${mode}: grandchild ${grandchild} must be gone`);
    assert.equal(await waitDead(made.client.pid), true);
  }
});

test("the overall deadline stops a session whose server never answers initialize", async () => {
  const { client } = launch({ initCall: "hang" }, { deadlineMs: 250 });
  const pid = client.pid;
  await rejects(client.initialize(), "MCP_DEADLINE");
  assert.equal(await waitDead(pid), true);
});

test("the environment is minimal: nothing is inherited except PATH and the declared entries", async () => {
  let seen;
  const fakeSpawn = (command, args, options) => {
    seen = options;
    const child = new EventEmitter();
    child.pid = undefined;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
    child.kill = () => {};
    return child;
  };
  const dir = tempDir();
  const client = startMcpClient({ command: "/usr/bin/node", args: ["x"], cwd: dir, env: { DECLARED: "1" } }, { spawn: fakeSpawn, hostEnv: { PATH: "/bin", SECRET_TOKEN: "s", GITHUB_TOKEN: "g" }, platform: "linux", killTree: () => {} });
  client.close();
  assert.equal(seen.shell, false);
  assert.equal(seen.cwd, dir);
  assert.deepEqual(seen.env, { PATH: "/bin", DECLARED: "1" });
});

test("a tool-list change after approval makes the stored approval stale in the guard", async () => {
  const first = launch({ tools: [{ name: "echo", inputSchema: { type: "object" } }] });
  const definition = { transport: "stdio", command: process.execPath, args: ["server.mjs"], cwd: first.dir, env: {} };
  let approvedHash;
  try {
    await first.client.initialize();
    approvedHash = descriptorHash(definition, (await first.client.listTools()).tools);
  } finally { first.client.close(); }
  const stateFor = (hash, tools) => ({ files: { trusted: true, descriptorHash: hash, tools, approval: { descriptorHash: approvedHash, tools: ["echo"] } } });
  const ctx = (hash, tools) => ({ workspaceRoot: first.dir, mode: "supervised", lockHeld: true, mcpServers: stateFor(hash, tools) });
  const action = { type: "tool", tool: { name: "mcp", input: { server: "files", tool: "echo" } } };
  assert.equal(evaluate(action, ctx(approvedHash, ["echo"])).decision, "allow");

  // Same definition, same argv; only the server's advertised tools change.
  first.set({ tools: [{ name: "echo", inputSchema: { type: "object" } }, { name: "exfiltrate", inputSchema: { type: "object" } }] });
  const second = startMcpClient({ command: process.execPath, args: [FIXTURE, first.file], cwd: first.dir, env: {} });
  try {
    await second.initialize();
    const { tools } = await second.listTools();
    const newHash = descriptorHash(definition, tools);
    assert.notEqual(newHash, approvedHash);
    const decision = evaluate(action, ctx(newHash, tools.map((tool) => tool.name)));
    assert.equal(decision.decision, "require-approval");
    assert.equal(decision.reason, "STALE_APPROVAL");
  } finally { second.close(); }
});

test("a tools/list_changed notification is noted", async () => {
  const { client } = launch({ listChanged: true });
  try {
    await client.initialize();
    await client.listTools();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.toolsChanged, true);
  } finally { client.close(); }
});

// --- review regressions ---------------------------------------------------------------------------

test("a flood of unsolicited server requests stops the session instead of queueing replies", async () => {
  const { client } = launch({ initCall: "flood" });
  const pid = client.pid;
  await client.initialize();
  await rejects(client.listTools(), "MCP_FLOOD");
  assert.equal(await waitDead(pid), true);
});

test("a server that never reads its input cannot make the client queue replies without bound", async () => {
  const stdin = Object.assign(new EventEmitter(), { writableLength: 0, write() { this.writableLength += 2 * 1024 * 1024; return false; }, end() {} });
  const stdout = new EventEmitter();
  const child = Object.assign(new EventEmitter(), { pid: undefined, stdin, stdout, stderr: new EventEmitter(), kill() {} });
  const client = startMcpClient({ command: "/usr/bin/node", args: [], cwd: "/", env: {} }, { spawn: () => child, platform: "linux", hostEnv: { PATH: "/bin" }, killTree: () => {} });
  const pending = client.initialize();
  pending.catch(() => {});
  await rejects(pending, "MCP_BACKPRESSURE");
});
