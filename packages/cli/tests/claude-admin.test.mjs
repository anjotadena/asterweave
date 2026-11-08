// Phase F2: the admin runner (allow-list, scope mapping, supervised spawn) and the diff helpers. Fake claude only; isolated dirs.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test, { after } from "node:test";
import { AdminError, buildMcpAddArgs, buildMcpRemoveArgs, buildPluginArgs, displayCommand, parseAdminArgs, runClaudeAdmin, toClaudeScope } from "../src/runtime/claude/admin.mjs";
import { diffUnits, parseUnits, serverEntryProblems } from "../src/runtime/claude/diff.mjs";
import { alive, cleanup, NO_SPAWN, readJsonFile, world } from "./admin-fixture.mjs";

after(cleanup);

const stdio = (extra = {}) => buildMcpAddArgs({ scope: "repo", name: "files", command: "node", args: ["server.js", "--flag"], env: ["API_KEY=${MY_KEY}"], ...extra });

test("toClaudeScope maps global to user and repo to project; local is impossible", () => {
  assert.equal(toClaudeScope("global", "mcp"), "user");
  assert.equal(toClaudeScope("repo", "plugin"), "project");
  for (const scope of ["local", "user", "project", undefined, "", "GLOBAL"]) assert.throws(() => toClaudeScope(scope, "mcp"), AdminError, String(scope));
  assert.throws(() => toClaudeScope("repo", "other"), AdminError);
});

test("builders produce the canonical argv and the validator accepts exactly those shapes", () => {
  assert.deepEqual(stdio(), ["mcp", "add", "files", "-s", "project", "-t", "stdio", "-e", "API_KEY=${MY_KEY}", "--", "node", "server.js", "--flag"]);
  assert.deepEqual(buildMcpAddArgs({ scope: "global", name: "r", transport: "http", url: "https://example.com/mcp", headers: ["Authorization: Bearer ${TOKEN}"] }), ["mcp", "add", "r", "https://example.com/mcp", "-s", "user", "-t", "http", "-H", "Authorization: Bearer ${TOKEN}"]);
  assert.deepEqual(buildMcpRemoveArgs({ scope: "repo", name: "files" }), ["mcp", "remove", "files", "-s", "project"]);
  assert.deepEqual(buildPluginArgs({ action: "uninstall", scope: "global", id: "p@m", keepData: true }), ["plugin", "uninstall", "p@m", "-s", "user", "--keep-data"]);
  assert.equal(parseAdminArgs(stdio(), "repo").claudeScope, "project");
  assert.equal(parseAdminArgs(buildPluginArgs({ action: "install", scope: "repo", id: "p@m", config: ["k=v"] }), "repo").kind, "plugin");
  for (const action of ["enable", "disable"]) assert.equal(parseAdminArgs(buildPluginArgs({ action, scope: "global", id: "p" }), "global").action, action);
  // server arguments after `--` may start with '-' or hold anything but a token-shaped secret
  assert.equal(parseAdminArgs(stdio({ args: ["-y", "--port", "80"] }), "repo").rest.length, 4);
});

test("the allow-list refuses everything else BEFORE a process exists", async () => {
  const refused = [
    [["mcp", "list"], "repo"], [["mcp", "get", "x"], "repo"], [["mcp", "serve"], "repo"], [["mcp", "add-json", "x", "{}", "-s", "project"], "repo"],
    [["mcp", "add-from-claude-desktop", "-s", "project"], "repo"], [["mcp", "reset-project-choices"], "repo"],
    [["plugin", "marketplace", "add", "x"], "repo"], [["plugin", "update", "p", "-s", "project"], "repo"], [["plugin", "prune"], "repo"], [["plugin", "list"], "repo"],
    [["config", "set", "x", "y"], "repo"], [["--help"], "repo"], [["mcp"], "repo"], [[], "repo"],
    [["mcp", "remove", "files", "-s", "local"], "repo"], [["mcp", "remove", "files", "--scope", "local"], "repo"], [["mcp", "remove", "files", "-s", "LOCAL"], "repo"],
    [["mcp", "remove", "files"], "repo"], // no scope: claude's default (local) is never used
    [["mcp", "remove", "files", "-s", "user"], "repo"], [["mcp", "remove", "files", "-s", "project"], "global"], // mismatch with the Asterweave scope
    [["mcp", "remove", "files", "-s", "project", "--debug"], "repo"], [["mcp", "remove", "files", "-s", "project", "-s", "project"], "repo"],
    [["mcp", "remove", "-x", "-s", "project"], "repo"], [["mcp", "remove", "--", "-s", "project"], "repo"], [["mcp", "remove", "files", "extra", "-s", "project"], "repo"],
    [["mcp", "remove", "../x", "-s", "project"], "repo"], [["mcp", "remove", "..", "-s", "project"], "repo"], [["mcp", "remove", "a b", "-s", "project"], "repo"],
    [["plugin", "enable", "p", "-s", "local"], "repo"], [["plugin", "install", "p@m", "-s", "project", "--config", "token=ghp_" + "A".repeat(36)], "repo"],
    [["plugin", "install", "p@m", "-s", "project", "--scope-less"], "repo"], [["plugin", "disable", "-p@m", "-s", "project"], "repo"],
    // literals and unsafe definitions
    [["mcp", "add", "x", "-s", "project", "-t", "stdio", "-e", "KEY=literal", "--", "node"], "repo"], [["mcp", "add", "x", "-s", "project", "-t", "stdio", "-e", "KEY=${lower}", "--", "node"], "repo"],
    [["mcp", "add", "x", "-s", "project", "-t", "stdio", "-e", "KEY=${A:-default}", "--", "node"], "repo"], [["mcp", "add", "x", "-s", "project", "-t", "stdio", "-e", "KEY=${A}x", "--", "node"], "repo"],
    [["mcp", "add", "x", "-s", "project", "-t", "stdio", "--", "node", "--token", "ghp_" + "B".repeat(36)], "repo"], [["mcp", "add", "x", "-s", "project", "-t", "stdio"], "repo"],
    [["mcp", "add", "x", "-s", "project", "-t", "stdio", "--", "--evil"], "repo"],
    [["mcp", "add", "x", "http://example.com/mcp", "-s", "project", "-t", "http"], "repo"], [["mcp", "add", "x", "https://u:p@example.com/mcp", "-s", "project", "-t", "http"], "repo"],
    [["mcp", "add", "x", "https://example.com/mcp", "-s", "project", "-t", "http", "-H", "Authorization: Bearer literal"], "repo"],
    [["mcp", "add", "x", "https://example.com/mcp", "-s", "project", "-t", "http", "--", "node"], "repo"], [["mcp", "add", "x", "-s", "project", "-t", "carrier-pigeon", "--", "node"], "repo"],
  ];
  for (const [args, scope] of refused) {
    assert.throws(() => parseAdminArgs(args, scope), AdminError, JSON.stringify(args));
    await assert.rejects(runClaudeAdmin({ args, scope, cwd: process.cwd(), spawn: NO_SPAWN, claudePath: process.execPath, claudeVersion: "2.1.5" }), AdminError, `no spawn: ${JSON.stringify(args)}`);
  }
  assert.equal(parseAdminArgs(buildMcpAddArgs({ scope: "repo", name: "r", transport: "http", url: "http://localhost:3000/mcp" }), "repo").values.transport, "http");
});

test("displayCommand shows the exact argv, quoted, redacted", () => {
  assert.equal(displayCommand(["mcp", "add", "x", "-e", "K=${V}", "--", "node", "a b"]), "claude mcp add x -e 'K=${V}' -- node 'a b'");
  assert.ok(!displayCommand(["x", "ghp_" + "C".repeat(36)]).includes("C".repeat(36)));
});

test("global scope runs in a fresh private temp dir (not the repository) that is removed afterwards; env is the allow-list", async () => {
  const w = world();
  const result = await runClaudeAdmin({
    args: buildMcpAddArgs({ scope: "global", name: "g", command: "node", args: ["s.js"] }), scope: "global", cwd: w.repo,
    env: { ...w.env, GITHUB_TOKEN: "x".repeat(20), NPM_TOKEN: "y".repeat(20), ASTERWEAVE_CONFIG_DIR: w.userDir, ANTHROPIC_API_KEY: "z" }, ...w.claude,
  });
  assert.equal(result.ok, true);
  assert.equal(result.cwd, "neutral");
  const record = w.recorded();
  assert.notEqual(record.cwd, w.repo);
  assert.ok(!record.cwd.startsWith(w.repo));
  assert.ok(!existsSync(record.cwd), "the neutral directory is removed");
  assert.ok(!record.envKeys.some((key) => /GITHUB_TOKEN|NPM_TOKEN/i.test(key)));
  assert.deepEqual(readJsonFile(w.userFile).mcpServers.g.args, ["s.js"]);
  assert.ok(!existsSync(w.mcpFile), "the repository was not touched");
  assert.deepEqual(record.argv, ["mcp", "add", "g", "-s", "user", "-t", "stdio", "--", "node", "s.js"]);
});

test("repo scope runs in the repository root and needs an absolute cwd", async () => {
  const w = world();
  const args = buildMcpAddArgs({ scope: "repo", name: "p", command: "node" });
  const ok = await runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: w.env, ...w.claude });
  assert.equal(ok.ok, true);
  assert.equal(w.recorded().cwd, w.repo);
  assert.deepEqual(readJsonFile(w.mcpFile).mcpServers.p.command, "node");
  await assert.rejects(runClaudeAdmin({ args, scope: "repo", cwd: "relative", env: w.env, ...w.claude }), AdminError);
  await assert.rejects(runClaudeAdmin({ args, scope: "repo", env: w.env, ...w.claude }), AdminError);
});

test("a non-zero exit and output redaction", async () => {
  const w = world({ behavior: "fail", extraScenario: { stderr: `boom token=ghp_${"D".repeat(36)}\n` } });
  const failed = await runClaudeAdmin({ args: buildMcpRemoveArgs({ scope: "repo", name: "x" }), scope: "repo", cwd: w.repo, env: w.env, ...w.claude });
  assert.equal(failed.ok, false);
  assert.equal(failed.exitCode, 1);
  assert.ok(!failed.stderr.includes("D".repeat(36)));
  w.scenario({ admin: { behavior: "leak-token" } });
  const leaked = await runClaudeAdmin({ args: buildMcpAddArgs({ scope: "repo", name: "q", command: "node" }), scope: "repo", cwd: w.repo, env: w.env, ...w.claude });
  assert.ok(leaked.stdout.includes("Added") && !leaked.stdout.includes("A".repeat(36)));
});

test("claude not installed or too old gives a clear typed error and changes nothing", async () => {
  const args = buildMcpRemoveArgs({ scope: "repo", name: "x" });
  const w = world();
  await assert.rejects(runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: { PATH: w.repo }, exists: () => false }), (error) => error.code === "CLAUDE_UNAVAILABLE" && error.exitCode === 1);
  w.scenario({ version: "1.0.0 (Claude Code)" });
  await assert.rejects(runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: w.env, ...w.claude }), (error) => error.code === "CLAUDE_UNAVAILABLE" && /too old/.test(error.message));
  assert.deepEqual(w.calls(), []);
});

test("a deadline and an abort kill the whole child: no orphan", async () => {
  const w = world({ behavior: "hang" });
  const args = buildMcpAddArgs({ scope: "repo", name: "h", command: "node" });
  const timed = await runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: w.env, timeoutMs: 700, ...w.claude });
  assert.equal(timed.ok, false);
  assert.equal(timed.timedOut, true);
  const pid = w.recorded().pid;
  assert.ok(pid > 0);
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false, "the timed-out child is gone");
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 700);
  const aborted = await runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: w.env, signal: controller.signal, ...w.claude });
  assert.equal(aborted.killed, true);
  assert.equal(aborted.ok, false);
  const second = w.recorded().pid;
  for (let i = 0; i < 40 && alive(second); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(second), false, "the aborted child is gone");
  const early = new AbortController();
  early.abort();
  assert.equal((await runClaudeAdmin({ args, scope: "repo", cwd: w.repo, env: w.env, signal: early.signal, spawn: NO_SPAWN, ...w.claude })).killed, true);
});

test("diff units: collections are split per entry, other keys are one unit, invalid JSON is opaque, __proto__ is harmless", () => {
  const a = parseUnits(JSON.stringify({ mcpServers: { a: { command: "x" }, b: { command: "y" } }, hooks: { x: 1 } }), { collections: ["mcpServers"] });
  const b = parseUnits(JSON.stringify({ mcpServers: { a: { command: "x" }, c: { command: "z" }, b: { command: "changed" } }, hooks: { x: 1 }, env: { K: "v" } }), { collections: ["mcpServers"] });
  assert.deepEqual(diffUnits(a, b), [{ unit: "env", op: "added" }, { unit: "mcpServers.b", op: "changed" }, { unit: "mcpServers.c", op: "added" }]);
  assert.deepEqual(diffUnits(b, a).map((c) => c.op), ["removed", "changed", "removed"]);
  assert.deepEqual(diffUnits(parseUnits(null), parseUnits("{}")), [], "a missing file and an empty object have the same units");
  const only = parseUnits(JSON.stringify({ mcpServers: { a: {} }, numStartups: 3 }), { collections: ["mcpServers"], only: ["mcpServers"] });
  assert.deepEqual([...only.units.keys()], ["mcpServers.a"]);
  assert.equal(parseUnits("{ not json", {}).state, "invalid");
  assert.equal(diffUnits(parseUnits("{ not json"), parseUnits("{ not json 2")).length, 1);
  const hostile = parseUnits('{"__proto__":{"polluted":true},"mcpServers":{"__proto__":{"command":"x"}}}', { collections: ["mcpServers"] });
  assert.equal(({}).polluted, undefined);
  assert.ok(hostile.units.size >= 1);
});

test("serverEntryProblems: the written entry must match the request; extra keys and differences are named, never valued", () => {
  const want = { transport: "stdio", command: "node", args: ["a"], env: { K: "${V}" } };
  assert.deepEqual(serverEntryProblems({ type: "stdio", command: "node", args: ["a"], env: { K: "${V}" } }, want), []);
  assert.deepEqual(serverEntryProblems({ command: "node", args: ["a"], env: { K: "${V}" } }, want), [], "type may be absent");
  assert.ok(serverEntryProblems({ command: "evil", args: ["a"], env: { K: "${V}" } }, want).some((p) => /command differs/.test(p)));
  assert.ok(serverEntryProblems({ command: "node", args: ["a"], env: { K: "literal-secret" } }, want).every((p) => !p.includes("literal-secret")));
  assert.ok(serverEntryProblems({ command: "node", args: ["a"], env: { K: "${V}" }, hooks: [] }, want).some((p) => /unexpected key/.test(p)));
  const remote = { transport: "http", url: "https://example.com/mcp", headers: { A: "Bearer ${T}" } };
  assert.deepEqual(serverEntryProblems({ type: "http", url: "https://example.com/mcp", headers: { A: "Bearer ${T}" } }, remote), []);
  assert.ok(serverEntryProblems({ type: "http", url: "https://evil.example/mcp" }, remote).length > 0);
  assert.ok(serverEntryProblems("nope", remote).length > 0);
});

test("review fixes: plugin ids match plugins.mjs (no '/' or '..'), config keys are strict, no positional may follow a variadic option, CLAUDE_CONFIG_DIR", async () => {
  const { isValidPluginId } = await import("../src/runtime/plugins.mjs");
  const { assertSupportedEnvironment } = await import("../src/runtime/claude/admin.mjs");
  for (const id of ["a/b@m", "../x", "p@m/..", "a..b@m/x", "@m", "p@", "p@m@n", "-p@m", "a b"]) {
    assert.throws(() => parseAdminArgs(["plugin", "enable", id, "-s", "user"], "global"), AdminError, id);
    assert.equal(isValidPluginId(id), false, `plugins.mjs agrees on ${id}`);
  }
  for (const id of ["p", "p@m", "a.b-c_d@market-1"]) {
    assert.equal(parseAdminArgs(["plugin", "enable", id, "-s", "user"], "global").positionals[0], id);
    assert.equal(isValidPluginId(id), true);
  }
  for (const entry of ["-x=1", "1key=v", "=v", "k"]) assert.throws(() => parseAdminArgs(["plugin", "install", "p@m", "-s", "user", "--config", entry], "global"), AdminError, entry);
  // a whole ${NAME} reference is accepted even for a secret-looking key; a literal secret is not
  assert.deepEqual(parseAdminArgs(["plugin", "install", "p@m", "-s", "user", "--config", "token=${PLUGIN_TOKEN}"], "global").values.config, ["token=${PLUGIN_TOKEN}"]);
  assert.throws(() => parseAdminArgs(["plugin", "install", "p@m", "-s", "user", "--config", "token=hunter2hunter2"], "global"), AdminError);
  assert.throws(() => parseAdminArgs(["plugin", "install", "p@m", "-s", "user", "--config", `k=ghp_${"F".repeat(36)}`], "global"), AdminError);
  // variadic: -e / -H / --config followed by a positional
  const R = "${X}";
  assert.throws(() => parseAdminArgs(["mcp", "add", "-s", "user", "-e", `A=${R}`, "nm", "--", "node"], "global"), /may not follow/);
  assert.throws(() => parseAdminArgs(["mcp", "add", "n", "-s", "user", "-t", "http", "-H", `A: ${R}`, "https://example.com/mcp"], "global"), /may not follow/);
  assert.throws(() => parseAdminArgs(["plugin", "install", "-s", "user", "--config", "k=v", "p@m"], "global"), /may not follow/);
  assert.equal(parseAdminArgs(["plugin", "install", "p@m", "-s", "user", "--config", "k=v"], "global").positionals[0], "p@m");
  // CLAUDE_CONFIG_DIR
  assert.throws(() => assertSupportedEnvironment("global", { CLAUDE_CONFIG_DIR: "/x" }, "linux"), /CLAUDE_CONFIG_DIR is set/);
  assert.throws(() => assertSupportedEnvironment("global", { claude_config_dir: "C:/x" }, "win32"), /CLAUDE_CONFIG_DIR is set/);
  // both scopes (a repo-scope plugin install also writes the user-level installed_plugins.json), and an empty value counts as present
  assert.throws(() => assertSupportedEnvironment("repo", { CLAUDE_CONFIG_DIR: "/x" }, "linux"), /CLAUDE_CONFIG_DIR is set/);
  assert.throws(() => assertSupportedEnvironment("global", { CLAUDE_CONFIG_DIR: "" }, "linux"), /CLAUDE_CONFIG_DIR is set/);
  assert.throws(() => assertSupportedEnvironment("repo", { Claude_Config_Dir: "" }, "win32"), /CLAUDE_CONFIG_DIR is set/);
  assert.doesNotThrow(() => assertSupportedEnvironment("repo", { CLAUDE_CONFIG: "x", PATH: "/bin" }, "linux"));
  assert.doesNotThrow(() => assertSupportedEnvironment("global", {}, "linux"));
  const w = world();
  await assert.rejects(runClaudeAdmin({ args: buildMcpRemoveArgs({ scope: "global", name: "x" }), scope: "global", env: { ...w.env, CLAUDE_CONFIG_DIR: w.home }, spawn: NO_SPAWN, ...w.claude }), /CLAUDE_CONFIG_DIR is set/);
});
