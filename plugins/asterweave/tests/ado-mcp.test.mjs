import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { resolveOrganization, respond } from "../scripts/ado-mcp.mjs";

const launcher = resolve(import.meta.dirname, "..", "scripts", "ado-mcp.mjs");

test("an unset or placeholder organization is treated as unconfigured", () => {
  assert.deepEqual(resolveOrganization(""), { configured: false });
  assert.deepEqual(resolveOrganization(undefined), { configured: false });
  assert.deepEqual(resolveOrganization("${user_config.ado_organization}"), { configured: false });
  assert.deepEqual(resolveOrganization(" contoso "), { configured: true, organization: "contoso" });
  assert.equal(resolveOrganization("contoso & calc").configured, false, "shell syntax never reaches npx");
  assert.equal(resolveOrganization("contoso & calc").invalid, "contoso & calc");
});

test("the unconfigured server answers the handshake with no tools", () => {
  const init = respond({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.match(init.result.instructions, /ado_organization/);
  assert.deepEqual(respond({ jsonrpc: "2.0", id: 2, method: "tools/list" }).result, { tools: [] });
  assert.deepEqual(respond({ jsonrpc: "2.0", id: 3, method: "ping" }).result, {});
  assert.equal(respond({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "x" } }).error.code, -32601);
  assert.equal(respond({ jsonrpc: "2.0", method: "notifications/initialized" }), null, "notifications get no reply");
});

test("the launcher speaks newline-delimited JSON-RPC over stdio when unconfigured", async () => {
  const child = spawn(process.execPath, [launcher, ""], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  child.stdin.end();
  await new Promise((done) => child.on("close", done));
  const replies = output.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((reply) => reply.id), [1, 2]);
  assert.deepEqual(replies[1].result.tools, []);
});
