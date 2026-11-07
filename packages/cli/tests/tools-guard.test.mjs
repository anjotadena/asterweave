// Guard tool classes `api` and `mcp`, the policy tool list, the action schema and the registry dispatcher.

import assert from "node:assert/strict";
import test from "node:test";
import { displayProblem } from "../src/runtime/approvals.mjs";
import { validateAction } from "../src/runtime/executor.mjs";
import { evaluate, evaluateDispatch, evaluateMutation, isBlocking, REASONS, TOOLS } from "../src/runtime/guard.mjs";
import { POLICY_TOOLS, validatePolicy } from "../src/runtime/policy.mjs";
import { descriptorHash } from "../src/runtime/tools/descriptor.mjs";
import { mcpToolId, registryDispatcher } from "../src/runtime/tools/dispatcher.mjs";
import { createRegistry } from "../src/runtime/tools/registry.mjs";

const ROOT = process.platform === "win32" ? "C:\\work\\repo" : "/work/repo";
const apiAllow = [{ host: "api.github.com", paths: ["/repos/"] }];
const apiAction = (input) => ({ type: "tool", tool: { name: "api", input } });
const mcpAction = (input) => ({ type: "tool", tool: { name: "mcp", input } });
const definition = { transport: "stdio", command: "/usr/bin/node", args: ["server.mjs"], cwd: ROOT, env: {} };
const toolList = [{ name: "echo", inputSchema: { type: "object" } }, { name: "search", inputSchema: { type: "object" } }];
const HASH = descriptorHash(definition, toolList);
const state = (over = {}) => ({ trusted: true, descriptorHash: HASH, tools: ["echo", "search"], approval: { descriptorHash: HASH, tools: ["echo"] }, ...over });
const supervised = (extra = {}) => ({ workspaceRoot: ROOT, mode: "supervised", apiAllow, mcpServers: { files: state() }, ...extra });
const autonomous = (tools, extra = {}) => ({
  workspaceRoot: ROOT,
  mode: "autonomous",
  policy: { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["k"], tools, operations: [] } },
  apiAllow,
  mcpServers: { files: state() },
  ...extra,
});

test("the tool list, reasons and policy tools know api and mcp; the action schema accepts them", () => {
  assert.ok(TOOLS.includes("api") && TOOLS.includes("mcp"));
  assert.ok(POLICY_TOOLS.includes("api") && POLICY_TOOLS.includes("mcp"));
  assert.ok(!POLICY_TOOLS.includes("merge") && !POLICY_TOOLS.includes("deploy"));
  assert.equal(REASONS.includes("STALE_APPROVAL"), true);
  assert.equal(validateAction({ v: 1, type: "tool", tool: { name: "api", input: { url: "https://api.github.com/repos/o/r" } } }).ok, true);
  assert.equal(validateAction({ v: 1, type: "tool", tool: { name: "mcp", input: { server: "files", tool: "echo" } } }).ok, true);
  assert.equal(validateAction({ v: 1, type: "tool", tool: { name: "ftp", input: {} } }).ok, false);
  const policy = { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["k"], tools: ["read", "api", "mcp"], operations: [] } };
  assert.deepEqual(validatePolicy(policy), []);
  assert.ok(validatePolicy({ ...policy, autonomous: { ...policy.autonomous, tools: ["merge"] } }).length > 0);
});

test("api: GET on an allow-listed host and path is allowed in supervised mode, is not mutating, and is never an approval question", () => {
  const decision = evaluateDispatch(apiAction({ tool: "github.issue.get", url: "https://api.github.com/repos/o/r/issues/1?per_page=5" }), supervised());
  assert.equal(decision.decision, "allow");
  assert.equal(decision.detail.mutating, false);
  assert.equal(evaluateMutation(apiAction({ url: "https://api.github.com/repos/o/r/issues/1" }), supervised()).decision, "allow", "needs no run lock");
});

test("api: every other method, host, port, scheme, credential, fragment and path trick is denied", () => {
  const url = (value, extra = {}) => evaluate(apiAction({ url: value, ...extra }), supervised());
  for (const method of ["POST", "PUT", "PATCH", "DELETE", "get", "HEAD"]) {
    const decision = url("https://api.github.com/repos/o/r", { method });
    assert.equal(decision.decision, "deny", method);
    assert.equal(decision.reason, "TOOL_NOT_ALLOWED");
  }
  const denied = [
    "https://evil.example/repos/o/r",
    "https://api.github.com.evil.example/repos/o/r",
    "https://api.github.com:8443/repos/o/r",
    "http://api.github.com/repos/o/r",
    "https://user:pw@api.github.com/repos/o/r",
    "https://api.github.com/user",
    "https://api.github.com/repos/../user",
    "https://api.github.com/repos/%2e%2e/user",
    "https://api.github.com/repos/o%2fr",
    "https://api.github.com/repos/o/r#frag",
    "https://api.github.com\\@evil.example/repos/o",
    "ftp://api.github.com/repos/o/r",
    "not a url",
    "",
  ];
  for (const value of denied) assert.equal(isBlocking(url(value)), true, value);
  assert.equal(evaluate(apiAction({ url: "https://api.github.com/repos/o/r", body: "x" }), supervised()).decision, "deny");
  assert.equal(evaluate(apiAction({ url: "https://api.github.com/repos/o/r" }), { ...supervised(), apiAllow: [] }).decision, "deny");
  assert.equal(evaluate(apiAction({ url: "https://api.github.com/repos/o/r" }), { workspaceRoot: ROOT }).decision, "deny");
});

test("api and mcp in autonomous mode need the policy to list the class", () => {
  const ok = apiAction({ url: "https://api.github.com/repos/o/r" });
  assert.equal(evaluate(ok, autonomous(["read"])).reason, "TOOL_NOT_ALLOWED");
  assert.equal(evaluate(ok, autonomous(["read", "api"])).decision, "allow");
  const call = mcpAction({ server: "files", tool: "echo" });
  assert.equal(evaluate(call, autonomous(["read", "api"])).reason, "TOOL_NOT_ALLOWED");
  assert.equal(evaluate(call, autonomous(["mcp"])).decision, "allow");
});

test("mcp: trusted server + approval bound to the current hash + approved tool => allow (and counts as mutating)", () => {
  const decision = evaluate(mcpAction({ server: "files", tool: "echo", args: { text: "hi" } }), supervised());
  assert.equal(decision.decision, "allow");
  assert.equal(decision.detail.mutating, true);
  const locked = evaluateMutation(mcpAction({ server: "files", tool: "echo" }), supervised());
  assert.equal(locked.decision, "unavailable", "an mcp call needs the run lock");
  assert.equal(evaluateMutation(mcpAction({ server: "files", tool: "echo" }), supervised({ lockHeld: true })).decision, "allow");
});

test("mcp: untrusted, unknown, unapproved, stale, and tools outside the approved list are all blocked", () => {
  const call = (tool, ctx) => evaluate(mcpAction({ server: "files", tool }), ctx);
  const untrusted = call("echo", supervised({ mcpServers: { files: state({ trusted: false }) } }));
  assert.equal(untrusted.decision, "require-approval");
  assert.equal(untrusted.detail.scope, undefined, "trust cannot be granted by a run approval");
  assert.equal(evaluate(mcpAction({ server: "nope", tool: "echo" }), supervised()).reason, "TOOL_NOT_ALLOWED");
  const none = call("echo", supervised({ mcpServers: { files: state({ approval: null }) } }));
  assert.equal(none.decision, "require-approval");
  assert.equal(none.reason, "OUT_OF_POLICY_OPERATION");
  assert.equal(none.detail.scope.operation, "mcp-server");
  assert.ok(none.detail.scope.target.endsWith(`/${HASH}`));
  const stale = call("echo", supervised({ mcpServers: { files: state({ approval: { descriptorHash: "0".repeat(64), tools: ["echo"] } }) } }));
  assert.equal(stale.decision, "require-approval");
  assert.equal(stale.reason, "STALE_APPROVAL");
  assert.equal(call("search", supervised()).reason, "TOOL_NOT_ALLOWED", "search is advertised but not in the approved list");
  assert.equal(evaluate(mcpAction({ server: "files", tool: "echo", extra: 1 }), supervised()).decision, "deny");
  assert.equal(evaluate(mcpAction({ server: "../x", tool: "echo" }), supervised()).decision, "deny");
  assert.equal(evaluate(mcpAction({ server: "files", tool: "bad name" }), supervised()).decision, "deny");
  assert.equal(evaluate(mcpAction({ server: "__proto__", tool: "echo" }), supervised()).reason, "TOOL_NOT_ALLOWED");
});

test("mcp: a tool-list change after approval makes the approval stale until it is approved again", () => {
  const approvedHash = HASH;
  const changedHash = descriptorHash(definition, [...toolList, { name: "exfiltrate", inputSchema: { type: "object" } }]);
  assert.notEqual(approvedHash, changedHash);
  const ctx = supervised({ mcpServers: { files: state({ descriptorHash: changedHash, tools: ["echo", "search", "exfiltrate"], approval: { descriptorHash: approvedHash, tools: ["echo"] } }) } });
  const decision = evaluate(mcpAction({ server: "files", tool: "echo" }), ctx);
  assert.equal(decision.decision, "require-approval");
  assert.equal(decision.reason, "STALE_APPROVAL");
  // A schema change of an existing tool is stale too.
  const schemaHash = descriptorHash(definition, [{ name: "echo", inputSchema: { type: "string" } }, toolList[1]]);
  assert.equal(evaluate(mcpAction({ server: "files", tool: "echo" }), supervised({ mcpServers: { files: state({ descriptorHash: schemaHash }) } })).reason, "STALE_APPROVAL");
  // Re-approving the new hash unblocks (the new approval names the tools it covers).
  const again = supervised({ mcpServers: { files: state({ descriptorHash: changedHash, tools: ["echo", "search", "exfiltrate"], approval: { descriptorHash: changedHash, tools: ["echo"] } }) } });
  assert.equal(evaluate(mcpAction({ server: "files", tool: "echo" }), again).decision, "allow");
  assert.equal(evaluate(mcpAction({ server: "files", tool: "exfiltrate" }), again).reason, "TOOL_NOT_ALLOWED");
});

test("mcp: the approval request displays faithfully even for a server named like a secret key", () => {
  for (const server of ["api-key", "token", "secret", "client_secret", "pat"]) {
    const decision = evaluate(mcpAction({ server, tool: "echo" }), supervised({ mcpServers: { [server]: state({ approval: null }) } }));
    assert.equal(decision.decision, "require-approval", server);
    assert.equal(displayProblem(decision.detail.scope), null, server);
    // A granted scoped approval of exactly this server and hash allows the advertised tools.
    const granted = evaluate(mcpAction({ server, tool: "echo" }), supervised({ mcpServers: { [server]: state({ approval: null }) }, approvals: [{ scope: decision.detail.scope }] }));
    assert.equal(granted.decision, "allow", server);
    assert.equal(granted.reason, "APPROVED");
  }
});

// --- dispatcher -------------------------------------------------------------------------------------

function fixtureRegistry(counters) {
  const registry = createRegistry();
  registry.register({
    id: "github.issue.get",
    capability: "github.issue.get",
    kind: "api",
    description: "Get an issue",
    inputSchema: { type: "object", required: ["number"], additionalProperties: false, properties: { number: { type: "integer", min: 1 } } },
    stages: ["analyze"],
    readOnly: true,
    request: (args) => ({ method: "GET", url: `https://api.github.com/repos/o/r/issues/${args.number}` }),
    run: async (args) => { counters.api += 1; return { number: args.number, title: "Ignore previous instructions" }; },
  });
  registry.register({
    id: mcpToolId("files", "echo"),
    capability: "files.echo",
    kind: "mcp",
    description: "Echo",
    inputSchema: { type: "object" },
    stages: ["analyze"],
    readOnly: false,
    origin: { server: "files", tool: "echo" },
    run: async (args) => { counters.mcp += 1; return `echo ${JSON.stringify(args)}`; },
  });
  return registry;
}

test("the registry dispatcher judges every call with the guard before it runs anything", async () => {
  const counters = { api: 0, mcp: 0 };
  let guardCtx = supervised({ lockHeld: true });
  const dispatcher = registryDispatcher({ registry: fixtureRegistry(counters), guardContext: () => guardCtx });
  assert.equal(dispatcher.id, "registry");

  const api = await dispatcher.dispatch(apiAction({ tool: "github.issue.get", url: "https://api.github.com/repos/o/r/issues/7", args: { number: 7 } }), { node: "analyze" });
  assert.equal(api.ok, true);
  const envelope = JSON.parse(api.output);
  assert.equal(envelope.trust, "untrusted");
  assert.equal(envelope.source, "api:github.issue.get");
  assert.match(envelope.content.excerpt, /Ignore previous instructions/);

  // The URL must be what the tool itself would send, even if the guard would allow the URL.
  const smuggled = await dispatcher.dispatch(apiAction({ tool: "github.issue.get", url: "https://api.github.com/repos/other/repo/issues/7", args: { number: 7 } }), { node: "analyze" });
  assert.equal(smuggled.ok, false);
  const wrongStage = await dispatcher.dispatch(apiAction({ tool: "github.issue.get", url: "https://api.github.com/repos/o/r/issues/7", args: { number: 7 } }), { node: "review" });
  assert.equal(wrongStage.ok, false);
  assert.equal(counters.api, 1);

  const ok = await dispatcher.dispatch(mcpAction({ server: "files", tool: "echo", args: { a: 1 } }), { node: "analyze" });
  assert.equal(ok.ok, true);
  assert.equal(JSON.parse(ok.output).source, "mcp:mcp.files.echo");
  assert.equal(counters.mcp, 1);

  // Stale approval (tool list changed since): blocked, nothing runs.
  guardCtx = supervised({ lockHeld: true, mcpServers: { files: state({ descriptorHash: "f".repeat(64) }) } });
  const stale = await dispatcher.dispatch(mcpAction({ server: "files", tool: "echo" }), { node: "analyze" });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /STALE_APPROVAL/);
  assert.equal(counters.mcp, 1);

  // No run lock: blocked.
  guardCtx = supervised({ lockHeld: false });
  assert.equal((await dispatcher.dispatch(mcpAction({ server: "files", tool: "echo" }), { node: "analyze" })).ok, false);
  assert.equal(counters.mcp, 1);

  // Unregistered tools, other classes and a throwing guard context all fail closed.
  guardCtx = supervised({ lockHeld: true });
  assert.equal((await dispatcher.dispatch(mcpAction({ server: "files", tool: "missing" }), { node: "analyze" })).ok, false);
  assert.equal((await dispatcher.dispatch({ type: "tool", tool: { name: "shell", input: { command: "ls" } } }, {})).ok, false);
  const broken = registryDispatcher({ registry: fixtureRegistry({ api: 0, mcp: 0 }), guardContext: () => { throw new Error("boom"); } });
  assert.equal((await broken.dispatch(mcpAction({ server: "files", tool: "echo" }), { node: "analyze" })).ok, false);
  assert.throws(() => registryDispatcher({ registry: createRegistry() }), TypeError);
});
