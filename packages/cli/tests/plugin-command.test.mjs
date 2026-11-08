// `asterweave plugin list|inspect|install|uninstall|enable|disable` through runCli: isolated HOME/USERPROFILE/APPDATA, a throwing spawn,
// and a fake mutation envelope (the real one is Track A's). Asserts what reaches the admin runner, what is refused before it, and
// the plugin-specific verification.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { loadMutation, parseConfigValues, restOfSettings, verifyPluginChange } from "../src/commands/plugin-admin.mjs";
import { cleanup, realWorld, world } from "./plugin-fixture.mjs";

after(cleanup);

const fakeToken = () => `ghp${"_"}${"Z".repeat(36)}`;
const settingsOf = (w, scope) => w.readJson(scope === "user" ? w.file("settings.json") : w.repoFile(".claude", "settings.json"), {});

test("list --json: per-scope rows, no merge, local labelled, filters, never spawns or loads the envelope", async () => {
  const w = world();
  w.writeJson(w.file("plugins", "installed_plugins.json"), { version: 2, plugins: { "a@market": [{ scope: "user", version: "1.0.0", installPath: "/secret/path" }, { scope: "project", projectPath: w.repo }] } });
  w.writeJson(w.file("settings.json"), { enabledPlugins: { "a@market": false } });
  w.writeJson(w.repoFile(".claude", "settings.json"), { enabledPlugins: { "a@market": true } });
  w.writeJson(w.repoFile(".claude", "settings.local.json"), { enabledPlugins: { "loc@market": true } });
  const all = await w.run(["list", "--json"], { inject: false });
  assert.equal(all.code, 0);
  const body = all.json();
  assert.equal(body.ok, true);
  assert.deepEqual(body.plugins.map((p) => `${p.id}:${p.scope}:${p.enabled}`).sort(), ["a@market:global:false", "a@market:repo:true", "loc@market:local:true"]);
  assert.ok(body.plugins.every((p) => !("installPath" in p)));
  assert.doesNotMatch(all.out, /secret\/path/);
  assert.match(body.plugins.find((p) => p.scope === "repo").conflict, /precedence is not verified/);
  assert.equal(body.plugins.find((p) => p.scope === "repo").trust, "untrusted");
  assert.equal(body.plugins.find((p) => p.scope === "local").managed, false);
  assert.deepEqual(body.marketplaces, ["market"]);
  assert.match(body.precedence, /not verified/);
  assert.deepEqual((await w.run(["list", "--scope", "global", "--json"], { inject: false })).json().plugins.map((p) => p.scope), ["global"]);
  assert.deepEqual((await w.run(["list", "--scope", "repo", "--json"], { inject: false })).json().plugins.map((p) => p.scope), ["repo"]);
  const text = await w.run(["list"], { inject: false });
  assert.match(text.out, /local, not managed by asterweave/);
  assert.match(text.out, /CONFLICT/);
  assert.match(text.out, /Precedence: not verified/);
});

test("list: an empty home is not an error; hostile files become issues; usage errors", async () => {
  const w = world({ marketplaces: null });
  const empty = await w.run(["list"], { inject: false });
  assert.equal(empty.code, 0);
  assert.match(empty.out, /No plugins/);
  mkdirSync(w.file(), { recursive: true });
  writeFileSync(w.file("settings.json"), "{nope");
  const bad = (await w.run(["list", "--json"], { inject: false })).json();
  assert.deepEqual(bad.issues, [{ file: "~/.claude/settings.json", state: "invalid" }]);
  assert.equal((await w.run(["list", "--scope", "weird"], { inject: false })).code, 2);
  assert.equal((await w.run(["list", "extra"], { inject: false })).code, 2);
  assert.equal((await w.run(["list", "--jsno"], { inject: false })).code, 2);
  assert.equal((await w.run(["list", "--config", "a=b"], { inject: false })).code, 2);
  assert.equal((await w.run(["bogus"], { inject: false })).code, 2);
  assert.equal((await w.run([], { inject: false })).code, 2);
});

test("inspect: manifest summary from the cache dir, hooks flagged and redacted, nothing executed; refusals", async () => {
  const w = world();
  const dir = w.file("plugins", "cache", "market", "a", "1.0.0");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "skills", "s1"), { recursive: true });
  mkdirSync(join(dir, "hooks"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "a", version: "1.0.0", description: "demo \u001b[31mred" }));
  const token = fakeToken();
  writeFileSync(join(dir, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: `run --key ${token}` }] }] } }));
  w.writeJson(w.file("plugins", "installed_plugins.json"), { version: 2, plugins: { "a@market": [{ scope: "user", version: "1.0.0", installPath: dir }] } });
  w.writeJson(w.file("settings.json"), { enabledPlugins: { "a@market": true } });
  const json = await w.run(["inspect", "a@market", "--json"], { inject: false });
  assert.equal(json.code, 0);
  const view = json.json().plugin;
  assert.equal(view.inspection.components.skills.count, 1);
  assert.equal(view.inspection.hooks[0].runsCode, true);
  assert.ok(!json.out.includes(token));
  assert.equal(view.inspection.manifest.description, "demo red");
  assert.doesNotMatch(json.out, /\\u001b/);
  const text = await w.run(["inspect", "a"], { inject: false });
  assert.match(text.out, /HOOKS RUN CODE/);
  assert.match(text.out, /Nothing was executed/);
  assert.doesNotMatch(text.out, /\u001b/);
  assert.equal((await w.run(["inspect", "nope@market"], { inject: false })).code, 1);
  assert.equal((await w.run(["inspect"], { inject: false })).code, 2);
  assert.equal((await w.run(["inspect", "../etc"], { inject: false })).code, 2);
  assert.equal((await w.run(["inspect", "a", "b"], { inject: false })).code, 2);
  // a name that matches two ids is ambiguous
  w.writeJson(w.file("settings.json"), { enabledPlugins: { "a@market": true, "a@other": true } });
  const ambiguous = await w.run(["inspect", "a"], { inject: false });
  assert.equal(ambiguous.code, 2);
  assert.equal((await w.run(["inspect", "a@other", "--json"], { inject: false })).json().plugin.inspection.reason.length > 0, true);
});

test("refusals happen before the envelope: ids, scope, marketplace, flags, agent markers", async () => {
  const w = world();
  const cases = [
    [["install", "p", "--scope", "global"], 2],                       // install needs name@marketplace
    [["install", "p@market"], 2],                                     // --scope is required
    [["install", "p@market", "--scope", "local"], 2],                 // local is never managed
    [["install", "p@market", "--scope", "both"], 2],
    [["install", "p@market", "--scope", "global", "--keep-data"], 2], // flag of another subcommand
    [["enable", "p@market", "--scope", "global", "--config", "a=b"], 2],
    [["install", "-bad@market", "--scope", "global"], 2],
    [["install", "p@ma rket", "--scope", "global"], 2],
    [["install", "p@market@x", "--scope", "global"], 2],
    [["install", "p@market\u001b[0m", "--scope", "global"], 2],
    [["install", "p@market", "extra", "--scope", "global"], 2],
    [["install", "p@unknown", "--scope", "global"], 2],              // marketplace not known: never added
    [["uninstall", "ghost@market", "--scope", "global"], 1],         // not installed or declared
    [["disable", "ghost@market", "--scope", "repo"], 1],
  ];
  for (const [argv, code] of cases) assert.equal((await w.run(argv)).code, code, argv.join(" "));
  const unknownMarket = await w.run(["install", "p@unknown", "--scope", "global", "--json"]);
  assert.equal(unknownMarket.json().error.code, "PLUGIN_MARKETPLACE_UNKNOWN");
  assert.match(unknownMarket.json().error.message, /never adds a marketplace/);
  for (const marker of ["ASTERWEAVE_RUN_ID", "ASTERWEAVE_SESSION_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"]) {
    const r = await w.run(["install", "p@market", "--scope", "global", "--yes"], { env: { [marker]: "1" } });
    assert.equal(r.code, 7, marker);
  }
  assert.deepEqual(w.mutation.runs, []);
  assert.deepEqual(w.mutation.applied, []);
});

test("a missing or unreadable known_marketplaces.json cannot satisfy the marketplace check", async () => {
  const w = world({ marketplaces: null });
  assert.equal((await w.run(["install", "p@market", "--scope", "global", "--yes"])).code, 2);
  mkdirSync(w.file("plugins"), { recursive: true });
  writeFileSync(w.file("plugins", "known_marketplaces.json"), "{broken");
  const r = await w.run(["install", "p@market", "--scope", "global", "--yes", "--json"]);
  assert.equal(r.code, 1);
  assert.equal(r.json().error.code, "PLUGIN_MARKETPLACE_UNVERIFIABLE");
  assert.deepEqual(w.mutation.runs, []);
});

test("the plugin-specific verification turns any other change into UNEXPECTED_CHANGE (exit 1)", async () => {
  for (const [mode, pattern] of [["extra-settings", /settings outside this plugin/], ["add-marketplace", /known_marketplaces\.json changed/], ["other-plugin", /(other plugins|plugins in another)|settings outside/], ["noop", /not installed after the change/]]) {
    const w = world({ mode });
    const r = await w.run(["install", "p@market", "--scope", "global", "--yes", "--json"]);
    assert.equal(r.code, 1, mode);
    assert.equal(r.json().error.code, "UNEXPECTED_CHANGE");
    assert.match(r.json().error.message, pattern, mode);
  }
  const w = world({ mode: "untrusted-extra-mcp" });
  const repoRun = await w.run(["install", "p@market", "--scope", "repo", "--yes", "--json"]);
  assert.equal(repoRun.code, 1);
  assert.match(repoRun.json().error.message, /projectMcp changed/);
});

test("verifyPluginChange: each action demands exactly its change", () => {
  const base = { installed: ["a@m"], enabled: true, rest: "{}", others: "[]", digests: { marketplaces: "x" } };
  assert.equal(verifyPluginChange(base, { ...base, installed: ["a@m", "b@m"], enabled: true }, { action: "install", id: "b@m" }).ok, true);
  assert.equal(verifyPluginChange(base, { ...base, installed: ["a@m", "b@m", "c@m"] }, { action: "install", id: "b@m" }).ok, false);
  assert.equal(verifyPluginChange(base, { ...base, installed: [] }, { action: "uninstall", id: "a@m" }).ok, true);
  assert.equal(verifyPluginChange(base, base, { action: "uninstall", id: "a@m" }).ok, false);
  assert.equal(verifyPluginChange(base, { ...base, enabled: false }, { action: "disable", id: "a@m" }).ok, true);
  assert.equal(verifyPluginChange(base, base, { action: "disable", id: "a@m" }).ok, false);
  assert.equal(verifyPluginChange({ ...base, enabled: false }, base, { action: "enable", id: "a@m" }).ok, true);
  assert.equal(verifyPluginChange(base, { ...base, others: "[1]" }, { action: "enable", id: "a@m" }).ok, false);
  assert.equal(verifyPluginChange(base, { ...base, digests: { marketplaces: "y" } }, { action: "enable", id: "a@m" }).ok, false);
});

test("without an injected envelope the admin runner is loaded lazily and fails closed when this build lacks it", async () => {
  const src = fileURLToPath(new URL("../src/runtime/claude/", import.meta.url));
  if (existsSync(join(src, "mutate.mjs")) && existsSync(join(src, "admin.mjs"))) {
    const loaded = await loadMutation();
    assert.equal(typeof loaded.applyMutation, "function");
    assert.equal(typeof loaded.toClaudeScope, "function");
    return;
  }
  await assert.rejects(loadMutation(), (error) => error.code === "PLUGIN_ADMIN_UNAVAILABLE" && error.exitCode === 1);
  const w = world();
  const r = await w.run(["install", "p@market", "--scope", "global", "--yes", "--json"], { inject: false });
  assert.equal(r.code, 1);
  assert.equal(r.json().error.code, "PLUGIN_ADMIN_UNAVAILABLE");
});


// --- the REAL admin runner and envelope against the fake claude (what a fake envelope used to hide) -----------------------

test("install global through the real envelope: -s user, --config reaches claude, changedFiles lists the user files, repo untouched", async () => {
  const w = realWorld();
  const r = await w.run(["install", "p@market", "--scope", "global", "--config", "mode=fast", "--config", "tok=${PLUGIN_TOKEN}", "--yes", "--json"]);
  assert.equal(r.code, 0, r.err + r.out);
  assert.deepEqual(w.calls(), [["plugin", "install", "p@market", "-s", "user", "--config", "mode=fast", "--config", "tok=${PLUGIN_TOKEN}"]]);
  const body = r.json();
  assert.deepEqual([body.ok, body.action, body.id, body.scope, body.claudeScope, body.verified, body.trust.state], [true, "install", "p@market", "global", "user", true, "not applicable"]);
  assert.deepEqual([...body.changedFiles].sort(), ["~/.claude/plugins/installed_plugins.json", "~/.claude/settings.json"]);
  assert.match(body.warnings.join(" "), /run code/);
  assert.equal(w.readJson(w.file("settings.json")).enabledPlugins["p@market"], true);
  assert.equal(w.readJson(w.repoFile(".claude", "settings.json")).enabledPlugins, undefined);
  const text = await w.run(["disable", "p@market", "--scope", "global", "--yes"]);
  assert.equal(text.code, 0);
  assert.match(text.out, /changed: ~\/\.claude\/settings\.json/);
});

test("repo scope through the real envelope: -s project, exit 4 and untrusted, then enable / disable / uninstall flags", async () => {
  const w = realWorld();
  assert.equal((await w.run(["install", "p@market", "--scope", "repo", "--yes"])).code, 4);
  assert.equal(w.trusted(), false);
  assert.equal((await w.run(["disable", "p@market", "--scope", "repo", "--yes"])).code, 4);
  assert.equal(w.readJson(w.repoFile(".claude", "settings.json")).enabledPlugins["p@market"], false);
  assert.equal((await w.run(["enable", "p@market", "--scope", "repo", "--yes"])).code, 4);
  const un = await w.run(["uninstall", "p@market", "--scope", "repo", "--keep-data", "--yes", "--json"]);
  assert.equal(un.code, 4);
  assert.equal(un.json().claudeScope, "project");
  assert.deepEqual(w.calls().map((a) => a.join(" ")), [
    "plugin install p@market -s project",
    "plugin disable p@market -s project",
    "plugin enable p@market -s project",
    "plugin uninstall p@market -s project --keep-data",
  ]);
  assert.equal("p@market" in (w.readJson(w.repoFile(".claude", "settings.json")).enabledPlugins ?? {}), false);
  // --keep-data is a boolean: it does not swallow the id
  const g = realWorld();
  assert.equal((await g.run(["install", "q@market", "--scope", "global", "--yes"])).code, 0);
  assert.equal((await g.run(["uninstall", "--keep-data", "q@market", "--scope", "global", "--yes"])).code, 0);
  assert.equal(g.calls().at(-1).join(" "), "plugin uninstall q@market -s user --keep-data");
});

test("--config: secret-looking values and literal values for secret keys are refused and never echoed; a whole reference passes for any key", async () => {
  const w = realWorld();
  const token = fakeToken();
  const r = await w.run(["install", "p@market", "--scope", "global", "--config", `endpoint=${token}`, "--yes"]);
  assert.equal(r.code, 2);
  assert.ok(!r.err.includes(token) && !r.out.includes(token));
  for (const bad of ["api_key=hunter2hunter2", "password=hunter2hunter2", "secret_key=abc"]) {
    const refused = await w.run(["install", "p@market", "--scope", "global", "--config", bad, "--yes"]);
    assert.equal(refused.code, 2, bad);
    assert.ok(!refused.err.includes("hunter2"));
  }
  assert.deepEqual(w.calls(), []);
  assert.deepEqual(parseConfigValues(["tok=${A_B}", "token=${A_B}", "api_key=${A_B}", "mode=fast"], "u"), ["tok=${A_B}", "token=${A_B}", "api_key=${A_B}", "mode=fast"]);
  for (const bad of ["novalue", "=x", "k=", "bad key=x", "-k=x", "k=a\u0000b", "k=pre${X}", `k=${"x".repeat(501)}`, "k=\u001b[0m", "token=plainliteral"]) assert.throws(() => parseConfigValues([bad], "u"), /--config/, bad);
  assert.throws(() => parseConfigValues(["a=1", "a=2"], "u"), /twice/);
  assert.throws(() => parseConfigValues(Array.from({ length: 21 }, (_, i) => `k${i}=v`), "u"), /At most/);
  assert.throws(() => parseConfigValues([true], "u"), /key=value/);
});

test("--path is refused for --scope global (exit 2); a global change from inside a repository passes that repository to the envelope", async () => {
  const w = world();
  const bad = await w.run(["install", "p@market", "--scope", "global", "--path", w.repo, "--yes"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--path applies to --scope repo only/);
  assert.deepEqual(w.mutation.applied, []);
  const ok = await w.run(["install", "p@market", "--scope", "global", "--yes", "--json"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(w.mutation.applied[0].repoRoot, w.repo);
  assert.equal(typeof w.mutation.applied[0].changedLabels, "function");
  assert.equal(w.mutation.applied[0].json, true);
  assert.deepEqual([w.mutation.applied[0].yes, w.mutation.applied[0].trust], [true, false]);
  assert.match(w.mutation.applied[0].summary.join("\n"), /scope: global \(Claude user\)/);
});

test("an id the admin runner would refuse (over 100 characters) is refused first", async () => {
  const w = realWorld("ok", { marketplaces: { [`m${"k".repeat(60)}`]: {} } });
  const long = `${"n".repeat(60)}@m${"k".repeat(60)}`;
  assert.equal((await w.run(["install", long, "--scope", "global", "--yes"])).code, 2);
  assert.deepEqual(w.calls(), []);
  assert.equal((await w.run(["install", `p@m${"k".repeat(60)}`, "--scope", "global", "--yes"])).code, 0);
});

test("Ctrl-C (an aborted signal) stops the claude call: kill, INTERRUPTED, exit 130", async () => {
  const w = realWorld("hang");
  const controller = new AbortController();
  const done = w.run(["install", "p@market", "--scope", "global", "--yes", "--json"], { io: { signal: controller.signal } });
  const started = Date.now();
  while (w.calls().length === 0 && Date.now() - started < 10000) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(w.calls().length, 1);
  controller.abort();
  const r = await done;
  assert.equal(r.code, 130, r.out + r.err);
});

test("inspect and the enable warning: a hooks path in the manifest is inspected, an unreadable one is never an all-clear", async () => {
  const w = realWorld();
  const dir = w.file("plugins", "cache", "market", "a", "1.0.0");
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "cfg"));
  writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "a", hooks: "./cfg/h.json", mcpServers: ["./cfg/missing.json", "../../../../outside.json"] }));
  writeFileSync(join(dir, "cfg", "h.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo from-path" }] }] } }));
  w.writeJson(w.file("plugins", "installed_plugins.json"), { version: 2, plugins: { "a@market": [{ scope: "user", version: "1.0.0", installPath: dir }] } });
  w.writeJson(w.file("settings.json"), { enabledPlugins: { "a@market": false } });
  const json = (await w.run(["inspect", "a@market", "--json"])).json().plugin.inspection;
  assert.equal(json.complete, false);
  assert.equal(json.hooks[0].command, "echo from-path");
  assert.equal(json.issues.length, 2);
  assert.ok(json.issues.every((i) => /^manifest declares mcpServers at .*: not inspected \(.+\), treat as code$/.test(i)));
  const text = await w.run(["inspect", "a@market"]);
  assert.match(text.out, /COULD NOT BE FULLY INSPECTED/);
  assert.match(text.out, /HOOKS RUN CODE/);
  const enable = await w.run(["enable", "a@market", "--scope", "global", "--yes", "--json"]);
  assert.equal(enable.code, 0, enable.err);
  assert.match(enable.json().warnings.join(" "), /declares 1 hook command\(s\) that RUN CODE/);
  assert.match(enable.json().warnings.join(" "), /INCOMPLETE and is not an all-clear/);
  // an install of a plugin that is not cached yet says it cannot be inspected before installing
  const fresh = await w.run(["install", "z@market", "--scope", "global", "--yes", "--json"]);
  assert.match(fresh.json().warnings.join(" "), /cannot be inspected before it is installed/);
});

test("a change under __proto__ / constructor keys (dropped by the sanitizing reader) is still an UNEXPECTED_CHANGE, in both scopes", async () => {
  for (const mode of ["proto-key", "constructor-key"]) {
    for (const scope of ["global", "repo"]) {
      const w = world({ mode });
      const r = await w.run(["install", "p@market", "--scope", scope, "--yes", "--trust", "--json"].filter((arg) => !(scope === "global" && arg === "--trust")));
      assert.equal(r.code, 1, `${mode} ${scope}: ${r.out}`);
      assert.equal(r.json().error.code, "UNEXPECTED_CHANGE");
      assert.match(r.json().error.message, /settings outside this plugin/);
    }
  }
  assert.equal(({}).hooks, undefined);
});

test("restOfSettings sees __proto__ keys, ignores only the plugin's own entry, and falls back to the bytes", () => {
  const read = (text) => ({ state: "ok", bytes: Buffer.from(text), data: null });
  const base = restOfSettings(read('{"enabledPlugins":{"a@m":true,"b@m":true},"x":1}'), "a@m");
  assert.equal(base, restOfSettings(read('{"x":1,"enabledPlugins":{"b@m":true}}'), "a@m"));
  assert.notEqual(base, restOfSettings(read('{"__proto__":{"z":1},"enabledPlugins":{"b@m":true},"x":1}'), "a@m"));
  assert.notEqual(base, restOfSettings(read('{"constructor":{"prototype":{}},"enabledPlugins":{"b@m":true},"x":1}'), "a@m"));
  assert.notEqual(restOfSettings(read("{broken"), "a@m"), restOfSettings(read("{broken2"), "a@m"));
  assert.equal(restOfSettings({ state: "missing", bytes: null }, "a@m"), restOfSettings(read("{\"enabledPlugins\":{\"a@m\":true}}"), "a@m"));
  assert.equal(restOfSettings({ state: "not-a-file", bytes: null }, "a@m"), "state:not-a-file");
});
