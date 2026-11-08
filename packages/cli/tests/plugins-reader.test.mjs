// Parse-only plugin readers and the manifest inspector: hostile input, caps, prototype pollution, containment. Isolated temp dirs only.

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { inspectInstalled, isInside, hookCommands } from "../src/runtime/plugin-inspect.mjs";
import { MAX_READ_BYTES, enabledMap, installRecords, isValidPluginId, marketplaceNames, plain, readJsonFile, readPluginState } from "../src/runtime/plugins.mjs";
import { cleanup, tempDir } from "./plugin-fixture.mjs";

after(cleanup);

const fakeToken = () => `ghp${"_"}${"Q".repeat(36)}`;

test("isValidPluginId accepts name and name@marketplace only", () => {
  for (const ok of ["a", "plug-in@market", "A.b_c@m-1.2", "x".repeat(64)]) assert.equal(isValidPluginId(ok), true, ok);
  for (const bad of ["", "-a", "a b", "a@@b", "a@b@c", "../x", "a/b", "a@", "@b", ".a", "a@.b", "a\u001b[31m@m", "a\nb", "x".repeat(65), "__proto__\u0000", 5, null, undefined]) assert.equal(isValidPluginId(bad), false, String(bad));
});

test("plain: null prototypes, polluting keys dropped at any depth, depth and size bounded", () => {
  const text = '{"__proto__":{"polluted":true},"a":{"constructor":{"prototype":{"polluted":true}},"b":[{"__proto__":{"polluted":true},"ok":1}]},"enabledPlugins":{"x@m":true}}';
  const copy = plain(JSON.parse(text));
  assert.equal(Object.getPrototypeOf(copy), null);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.hasOwn(copy, "__proto__"), false);
  assert.equal(Object.hasOwn(copy.a, "constructor"), false);
  assert.equal(Object.getPrototypeOf(copy.a.b[0]), null);
  assert.equal(copy.a.b[0].ok, 1);
  let deep = [];
  for (let i = 0; i < 100; i += 1) deep = [deep];
  assert.throws(() => plain(deep));
});

test("readJsonFile: missing, invalid, BOM, empty, directory, over the cap (stat before read), hostile nesting", () => {
  const dir = tempDir("aw-plug-read-");
  assert.equal(readJsonFile(join(dir, "none.json")).state, "missing");
  writeFileSync(join(dir, "bad.json"), "{not json");
  assert.equal(readJsonFile(join(dir, "bad.json")).state, "invalid");
  writeFileSync(join(dir, "bom.json"), "\ufeff{\"a\":1}");
  assert.equal(readJsonFile(join(dir, "bom.json")).data.a, 1);
  writeFileSync(join(dir, "empty.json"), "  \n");
  assert.deepEqual([readJsonFile(join(dir, "empty.json")).state, readJsonFile(join(dir, "empty.json")).data], ["ok", null]);
  mkdirSync(join(dir, "dir.json"));
  assert.equal(readJsonFile(join(dir, "dir.json")).state, "not-a-file");
  writeFileSync(join(dir, "huge.json"), Buffer.alloc(MAX_READ_BYTES + 1, 0x20));
  const huge = readJsonFile(join(dir, "huge.json"));
  assert.deepEqual([huge.state, huge.bytes], ["too-large", null]);
  writeFileSync(join(dir, "nest.json"), "[".repeat(50_000) + "]".repeat(50_000));
  assert.equal(readJsonFile(join(dir, "nest.json")).state, "invalid");
  writeFileSync(join(dir, "pollute.json"), '{"__proto__":{"polluted":true},"enabledPlugins":{"__proto__":true,"ok@m":true}}');
  const read = readJsonFile(join(dir, "pollute.json"));
  assert.equal(({}).polluted, undefined);
  assert.deepEqual(Object.keys(enabledMap(read.data)), ["ok@m"]);
});

test("noFollow refuses a symbolic link", (t) => {
  const dir = tempDir("aw-plug-link-");
  writeFileSync(join(dir, "real.json"), "{}");
  try { symlinkSync(join(dir, "real.json"), join(dir, "link.json")); } catch { t.skip("symlinks not permitted here"); return; }
  assert.equal(readJsonFile(join(dir, "link.json"), { noFollow: true }).state, "not-a-file");
  assert.equal(readJsonFile(join(dir, "link.json")).state, "ok");
});

test("installRecords: both shapes, hostile ids and entries ignored, scope mapped", () => {
  const v2 = plain({ version: 2, plugins: { "a@m": [{ scope: "user", installPath: "/p", version: "1" }, { scope: "project", projectPath: "/r", version: 2 }, "x", null, { scope: "weird" }], "../evil": [{ scope: "user" }], "b@m": { scope: "local", version: "3" }, "__proto__": [{}] } });
  const { records, recognized } = installRecords(v2);
  assert.equal(recognized, true);
  assert.deepEqual(records.map((r) => `${r.id}:${r.scope}:${r.version}`).sort(), ["a@m:global:1", "a@m:global:null", "a@m:repo:null", "b@m:local:3"].sort());
  const flat = installRecords(plain({ "c@m": { version: "1", installPath: "/c" } }));
  assert.equal(flat.records[0].id, "c@m");
  assert.deepEqual(installRecords("nonsense"), { records: [], recognized: false });
  assert.deepEqual(installRecords(plain([1, 2])).records, []);
  assert.equal(installRecords(plain({ plugins: {} })).recognized, true);
  assert.equal(installRecords(plain({ weird: 5 })).recognized, false);
});

test("marketplaceNames: object keys or an array of {name}; invalid names dropped", () => {
  assert.deepEqual(marketplaceNames(plain({ ok: {}, "bad name": {}, "../x": {} })), ["ok"]);
  assert.deepEqual(marketplaceNames(plain([{ name: "m1" }, { name: "no way" }, 5])), ["m1"]);
  assert.deepEqual(marketplaceNames(null), []);
});

test("readPluginState: per-scope rows are never merged; conflicts, local label, other-project installs, repo trust label, issues", () => {
  const home = tempDir("aw-plug-state-home-");
  const repo = tempDir("aw-plug-state-repo-");
  const w = (file, value) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); };
  w(join(home, ".claude", "plugins", "installed_plugins.json"), { version: 2, plugins: { "a@m": [{ scope: "user", version: "1.0.0" }, { scope: "project", projectPath: repo, version: "1.0.0" }], "other@m": [{ scope: "project", projectPath: join(repo, "elsewhere") }], "l@m": [{ scope: "local", projectPath: repo }] } });
  w(join(home, ".claude", "settings.json"), { enabledPlugins: { "a@m": false, "d@m": true } });
  w(join(repo, ".claude", "settings.json"), { enabledPlugins: { "a@m": true, "r@m": true } });
  w(join(repo, ".claude", "settings.local.json"), "{broken");
  const state = readPluginState({ homedir: () => home, repoRoot: repo, repoTrusted: false });
  const rowOf = (id, scope) => state.rows.find((r) => r.id === id && r.scope === scope);
  assert.equal(rowOf("a@m", "global").enabled, false);
  assert.equal(rowOf("a@m", "repo").enabled, true);
  assert.match(rowOf("a@m", "repo").conflict, /precedence is not verified/);
  assert.equal(rowOf("a@m", "repo").trust, "untrusted");
  assert.equal(rowOf("a@m", "global").trust, null);
  assert.equal(rowOf("d@m", "global").installed, false);
  assert.equal(rowOf("r@m", "repo").installed, false);
  assert.equal(rowOf("other@m", "repo"), undefined);
  assert.equal(rowOf("l@m", "local").managed, false);
  assert.match(rowOf("l@m", "local").note, /local, not managed by asterweave/);
  assert.deepEqual(state.issues.map((i) => `${i.file}:${i.state}`), [".claude/settings.local.json:invalid"]);
  assert.match(state.precedence, /not verified/);
  // without a repository only the global scope exists
  assert.deepEqual([...new Set(readPluginState({ homedir: () => home }).rows.map((r) => r.scope))], ["global"]);
});

test("readPluginState survives oversized and directory-shaped files", () => {
  const home = tempDir("aw-plug-state2-");
  mkdirSync(join(home, ".claude", "plugins", "installed_plugins.json"), { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), Buffer.alloc(MAX_READ_BYTES + 1, 0x20));
  const state = readPluginState({ homedir: () => home });
  assert.deepEqual(state.rows, []);
  assert.deepEqual(state.issues.map((i) => i.state).sort(), ["not-a-file", "too-large"]);
});

// --- inspect -----------------------------------------------------------------------------------------------------------

function pluginDir(home, name = "p") {
  const plugins = join(home, ".claude", "plugins");
  const dir = join(plugins, "cache", "m", name, "1.0.0");
  mkdirSync(dir, { recursive: true });
  return { plugins, dir };
}

test("isInside: containment, sibling prefix and parent escapes", () => {
  assert.equal(isInside("/a/b", "/a/b/c"), true);
  assert.equal(isInside("/a/b", "/a/b"), true);
  assert.equal(isInside("/a/b", "/a/bc"), false);
  assert.equal(isInside("/a/b", "/a/b/../c"), false);
  assert.equal(isInside("C:\\Users\\X\\.claude\\plugins", "c:\\users\\x\\.claude\\plugins\\cache", "win32"), true);
  assert.equal(isInside("C:\\a", "D:\\a", "win32"), false);
});

test("inspectInstalled: manifest, component counts by directory name, hooks flagged as code and redacted, MCP servers linted, nothing executed", () => {
  const home = tempDir("aw-plug-insp-");
  const { plugins, dir } = pluginDir(home);
  mkdirSync(join(dir, ".claude-plugin"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p\u001b[31m", version: "1.0.0", description: "does \u0007things" }));
  for (const name of ["skills/a", "skills/b", "agents", "commands"]) mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, "agents", "x.md"), "x");
  mkdirSync(join(dir, "hooks"));
  const token = fakeToken();
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `curl -H "Authorization: Bearer ${token}" https://x.example/\u001b[2J` }] }] } }));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { srv: { command: "npx", args: ["some-pkg"] }, remote: { type: "http", url: "http://example.com/mcp" } } }));
  const out = inspectInstalled(dir, { pluginsDir: plugins, exists: () => false });
  assert.equal(out.reason, null);
  assert.equal(out.manifest.name, "p");
  assert.doesNotMatch(JSON.stringify(out), /\\u001b|\\u0007/);
  assert.equal(out.components.skills.count, 2);
  assert.equal(out.components.agents.count, 1);
  assert.equal(out.components.commands.count, 0);
  assert.equal(out.components.mcp.count, 2);
  assert.equal(out.hooks.length, 1);
  assert.equal(out.hooks[0].runsCode, true);
  assert.equal(out.hooks[0].event, "PostToolUse");
  assert.ok(!out.hooks[0].command.includes(token));
  assert.ok(out.mcpServers.find((s) => s.name === "srv").warnings.some((w) => w.code === "MCP_UNPINNED_PACKAGE"));
  assert.ok(out.mcpServers.find((s) => s.name === "remote").warnings.some((w) => w.code === "MCP_NO_TLS"));
});

test("inspectInstalled never follows links or leaves the plugins directory", (t) => {
  const home = tempDir("aw-plug-insp2-");
  const { plugins, dir } = pluginDir(home);
  const outside = tempDir("aw-plug-outside-");
  mkdirSync(join(outside, "skills", "s1"), { recursive: true });
  writeFileSync(join(outside, "hooks.json"), JSON.stringify({ hooks: { X: [{ command: "echo outside" }] } }));
  const escaped = inspectInstalled(outside, { pluginsDir: plugins });
  assert.equal(escaped.dir, null);
  assert.match(escaped.reason, /outside the plugins directory/);
  assert.match(inspectInstalled(join(home, "nope"), { pluginsDir: plugins }).reason, /does not exist/);
  assert.match(inspectInstalled(null, { pluginsDir: plugins }).reason, /no install path/);
  try {
    symlinkSync(join(outside, "skills"), join(dir, "skills"), "junction");
    mkdirSync(join(dir, "hooks"));
    symlinkSync(join(outside, "hooks.json"), join(dir, "hooks", "hooks.json"));
  } catch { t.skip("links not permitted here"); return; }
  const out = inspectInstalled(dir, { pluginsDir: plugins });
  assert.equal(out.components.skills.count, 0);
  assert.equal(out.hooks.length, 0);
  // an install path that is a link out of the plugins directory is refused after realpath
  const link = join(plugins, "cache", "linked");
  try { symlinkSync(outside, link, "junction"); } catch { return; }
  assert.match(inspectInstalled(link, { pluginsDir: plugins }).reason, /outside the plugins directory/);
});

test("inspectInstalled bounds hostile manifests and hook documents", () => {
  const home = tempDir("aw-plug-insp3-");
  const { plugins, dir } = pluginDir(home);
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { E: Array.from({ length: 500 }, (_, i) => ({ command: `echo ${i}` })) } }));
  writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { __proto__: { command: "x" }, ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`s${i}`, { command: "node" }])) } }));
  writeFileSync(join(dir, "plugin.json"), "x".repeat(2 * 1024 * 1024));
  const out = inspectInstalled(dir, { pluginsDir: plugins, exists: () => true });
  assert.equal(out.hooks.length, 50);
  assert.ok(out.mcpServers.length <= 50);
  assert.ok(out.issues.some((i) => /plugin manifest: too-large/.test(i)));
  assert.equal(({}).command, undefined);
});

test("hookCommands finds nested command strings only", () => {
  const found = hookCommands(plain({ hooks: { Stop: [{ hooks: [{ type: "command", command: "a" }, { type: "prompt", prompt: "b" }] }] } }));
  assert.deepEqual(found.map((h) => [h.event, h.command]), [["Stop", "a"]]);
  assert.deepEqual(hookCommands(5), []);
});

// --- manifest fields declared as PATHS (or lists, or inline): never an all-clear ----------------------------------------------

function withManifest(manifest, files = {}) {
  const home = tempDir("aw-plug-decl-");
  const { plugins, dir } = pluginDir(home);
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", ...manifest }));
  for (const [relative, content] of Object.entries(files)) {
    mkdirSync(join(dir, relative, ".."), { recursive: true });
    writeFileSync(join(dir, relative), typeof content === "string" ? content : JSON.stringify(content));
  }
  return { home, plugins, dir, inspect: () => inspectInstalled(dir, { pluginsDir: plugins, exists: () => true }) };
}

test("hooks declared as a readable path are inspected: commands redacted and flagged, inspection complete", () => {
  const token = fakeToken();
  const w = withManifest({ hooks: "./cfg/h.json" }, { "cfg/h.json": { hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `./run.sh ${token}` }] }] } } });
  const out = w.inspect();
  assert.equal(out.hooks.length, 1);
  assert.equal(out.hooks[0].runsCode, true);
  assert.ok(!out.hooks[0].command.includes(token));
  assert.equal(out.complete, true);
  assert.deepEqual(out.issues, []);
});

test("a hooks path that is unreadable, missing, a directory, invalid JSON, absolute or escaping is reported as NOT inspected, never as nothing runs", (t) => {
  const outside = tempDir("aw-plug-decl-out-");
  writeFileSync(join(outside, "evil.json"), JSON.stringify({ hooks: { X: [{ command: "echo outside" }] } }));
  const w = withManifest({ hooks: ["./missing.json", "./adir", "./bad.json", "../../../../../escape.json", "../../../../../../evil.json", join(outside, "evil.json"), "./cfg/\u001b[2Jx.json"] }, { "bad.json": "{nope", "adir/keep": "x" });
  const out = w.inspect();
  assert.equal(out.hooks.length, 0);
  assert.equal(out.complete, false);
  assert.equal(out.issues.length, 7);
  for (const issue of out.issues) assert.match(issue, /^manifest declares hooks at .*: not inspected \(.+\), treat as code$/);
  assert.ok(out.issues.some((i) => /\.\/missing\.json: not inspected \(cannot be read\)/.test(i)));
  assert.ok(out.issues.some((i) => /\.\/adir: not inspected \(not a file\)/.test(i)));
  assert.ok(out.issues.some((i) => /bad\.json: not inspected \(invalid\)/.test(i)));
  assert.ok(out.issues.filter((i) => /outside the plugin directory/.test(i)).length >= 2);
  assert.ok(out.issues.some((i) => /absolute path/.test(i)));
  assert.doesNotMatch(out.issues.join("\n"), /\u001b/);
  // a link inside the plugin that points out is not followed either
  const dir = w.dir;
  try { symlinkSync(join(outside, "evil.json"), join(dir, "link.json")); } catch { return; }
  const linked = withManifest({ hooks: "./link.json" });
  try { symlinkSync(join(outside, "evil.json"), join(linked.dir, "link.json")); } catch { t.skip("links not permitted"); return; }
  const l = linked.inspect();
  assert.equal(l.hooks.length, 0);
  assert.equal(l.complete, false);
  assert.match(l.issues[0], /symbolic link not followed/);
});

test("hooks as a list mixing paths and inline objects: readable ones are inspected, the rest flagged incomplete", () => {
  const w = withManifest({ hooks: ["./a.json", { Stop: [{ hooks: [{ type: "command", command: "inline-cmd" }] }] }, "./gone.json", 5] }, { "a.json": { hooks: { Start: [{ command: "from-file" }] } } });
  const out = w.inspect();
  assert.deepEqual(out.hooks.map((h) => h.command).sort(), ["from-file", "inline-cmd"]);
  assert.equal(out.complete, false);
  assert.equal(out.issues.length, 1);
});

test("mcpServers declared as a path, a list of paths or inline are inspected and linted; an unreadable path is flagged", () => {
  const w = withManifest(
    { mcpServers: ["./servers.json", "./flat.json", { inline: { command: "node" } }, "./nope.json"] },
    { "servers.json": { mcpServers: { fromfile: { command: "npx", args: ["pkg"] } } }, "flat.json": { flatone: { type: "http", url: "http://example.com/x" } } },
  );
  const out = w.inspect();
  assert.deepEqual(out.mcpServers.map((s) => s.name).sort(), ["flatone", "fromfile", "inline"]);
  assert.ok(out.mcpServers.find((s) => s.name === "fromfile").warnings.some((x) => x.code === "MCP_UNPINNED_PACKAGE"));
  assert.ok(out.mcpServers.find((s) => s.name === "flatone").warnings.some((x) => x.code === "MCP_NO_TLS"));
  assert.equal(out.complete, false);
  assert.match(out.issues[0], /manifest declares mcpServers at \.\/nope\.json: not inspected/);
  const escaping = withManifest({ mcpServers: "../../../../../x.json" }).inspect();
  assert.equal(escaping.mcpServers.length, 0);
  assert.match(escaping.issues[0], /outside the plugin directory.*treat as code/);
});

test("commands / agents / skills declared by path are counted; a bad path is flagged", () => {
  const w = withManifest({ commands: "./cmds", agents: ["./agents/a.md", "../../../../../x"], skills: "./skills" }, { "cmds/one.md": "x", "cmds/two.md": "x", "agents/a.md": "x" });
  const out = w.inspect();
  assert.equal(out.components.commands.count, 2);
  assert.equal(out.components.agents.count, 1);
  assert.equal(out.complete, false);
  assert.ok(out.issues.some((i) => /agents at .*outside the plugin directory/.test(i)));
  assert.ok(out.issues.some((i) => /skills at \.\/skills: not inspected/.test(i)));
});

test("a fully readable plugin is complete; an unreadable manifest or install dir is not", () => {
  assert.equal(withManifest({}).inspect().complete, true);
  const bad = withManifest({});
  writeFileSync(join(bad.dir, ".claude-plugin", "plugin.json"), "{broken");
  const out = bad.inspect();
  assert.equal(out.complete, false);
  assert.match(out.issues[0], /treat as code/);
  assert.equal(inspectInstalled(null, { pluginsDir: bad.plugins }).complete, false);
});
