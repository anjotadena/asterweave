import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { ConfigError, configView, ENV_NAMES, KNOWN_KEYS, PRECEDENCE, readExecutableRepoConfig, resolveConfig } from "../src/config.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { grantTrust } from "../src/trust.mjs";

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aw-config-")));
  madeDirs.push(root);
  const userDir = join(root, "user");
  mkdirSync(userDir, { recursive: true });
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  return {
    root,
    repo,
    userFile: join(userDir, "config.json"),
    env: { ASTERWEAVE_CONFIG_DIR: userDir },
    user: (value) => writeFileSync(join(userDir, "config.json"), typeof value === "string" ? value : JSON.stringify(value)),
    adapter: (value) => writeFileSync(join(repo, ".claude", "asterweave.json"), typeof value === "string" ? value : JSON.stringify(value)),
  };
}

const GATES = [{ id: "unit", command: "npm test", source: "package.json" }];

test("known keys are small, documented, and have defaults", () => {
  assert.deepEqual(PRECEDENCE, ["default", "user", "repo", "env", "flag"]);
  for (const [key, def] of Object.entries(KNOWN_KEYS)) {
    assert.ok(def.description.length > 10, key);
    assert.ok("default" in def, key);
  }
  assert.equal(KNOWN_KEYS.runner.default, "local");
  assert.equal(KNOWN_KEYS["github.host"].default, "github.com");
  assert.equal(KNOWN_KEYS["qualityGates.required"].executable, true);
  assert.equal(ENV_NAMES["github.host"], "ASTERWEAVE_GITHUB_HOST");
  assert.ok(!Object.values(ENV_NAMES).includes("ASTERWEAVE_CONFIG_DIR"), "the config dir override is not a config key");
});

test("with no files, env or flags every key reports its default origin", () => {
  const { env } = setup();
  const resolved = resolveConfig({ env });
  assert.equal(resolved.repo, null);
  assert.deepEqual(resolved.unknown, []);
  for (const [key, def] of Object.entries(KNOWN_KEYS)) assert.deepEqual(resolved.entries[key], { value: def.default, origin: "default" }, key);
  // Defaults are copies, not shared references.
  resolved.entries["qualityGates.required"].value.push("x");
  assert.deepEqual(KNOWN_KEYS["qualityGates.required"].default, []);
});

test("each layer wins over the one below it and carries its own origin", () => {
  const s = setup();
  s.user({ "provider.workItems": "github", github: { host: "ghe.user.example" }, ui: { color: "never" } });
  s.adapter({ version: 1, provider: { workItems: "azure-devops" }, qualityGates: { required: GATES } });
  grantTrust(s.repo, { env: s.env });
  const adapterFile = join(s.repo, ".claude", "asterweave.json");

  // default + user (nested and dotted spellings both work) + repo
  let resolved = resolveConfig({ env: s.env, repoPath: s.repo });
  assert.deepEqual(resolved.entries.runner, { value: "local", origin: "default" });
  assert.deepEqual(resolved.entries["github.host"], { value: "ghe.user.example", origin: `user:${s.userFile}` });
  assert.deepEqual(resolved.entries["ui.color"], { value: "never", origin: `user:${s.userFile}` });
  assert.deepEqual(resolved.entries["provider.workItems"], { value: "azure-devops", origin: `repo:${adapterFile}` });
  assert.deepEqual(resolved.entries["qualityGates.required"], { value: GATES, origin: `repo:${adapterFile}` });

  // env beats repo and user
  const env = { ...s.env, ASTERWEAVE_PROVIDER_WORKITEMS: "none", ASTERWEAVE_GITHUB_HOST: "ghe.env.example" };
  resolved = resolveConfig({ env, repoPath: s.repo });
  assert.deepEqual(resolved.entries["provider.workItems"], { value: "none", origin: "env:ASTERWEAVE_PROVIDER_WORKITEMS" });
  assert.deepEqual(resolved.entries["github.host"], { value: "ghe.env.example", origin: "env:ASTERWEAVE_GITHUB_HOST" });

  // flags beat env
  resolved = resolveConfig({ env, repoPath: s.repo, flags: { "github.host": "flag.example", "provider.workItems": "github" } });
  assert.deepEqual(resolved.entries["github.host"], { value: "flag.example", origin: "flag" });
  assert.deepEqual(resolved.entries["provider.workItems"], { value: "github", origin: "flag" });
  assert.deepEqual(resolved.entries["ui.color"], { value: "never", origin: `user:${s.userFile}` }, "untouched keys keep their origin");
  assert.deepEqual(resolved.precedence, PRECEDENCE);

  // undefined / null flags are ignored
  resolved = resolveConfig({ env, flags: { "github.host": undefined, runner: null } });
  assert.equal(resolved.entries["github.host"].origin, "env:ASTERWEAVE_GITHUB_HOST");
});

test("an untrusted repository contributes only non-executable fields", () => {
  const s = setup();
  s.adapter({ version: 1, provider: { workItems: "github" }, qualityGates: { required: GATES } });
  const adapterFile = join(s.repo, ".claude", "asterweave.json");
  const resolved = resolveConfig({ env: s.env, repoPath: s.repo });
  assert.deepEqual(resolved.entries["provider.workItems"], { value: "github", origin: `repo:${adapterFile}` });
  assert.deepEqual(resolved.entries["qualityGates.required"], { value: [], origin: "default" }, "commands are not read");
  assert.equal(resolved.repo.trusted, false);
  assert.equal(resolved.repo.trustReason, "NOT_GRANTED");
  assert.deepEqual(resolved.repo.skipped, ["qualityGates.required"]);
  assert.equal(resolved.repo.hasAdapter, true);
  assert.equal(JSON.stringify(resolved).includes("npm test"), false, "no executable command text leaks into the result");

  // Trusting then changing the file untrusts again.
  grantTrust(s.repo, { env: s.env });
  assert.equal(resolveConfig({ env: s.env, repoPath: s.repo }).entries["qualityGates.required"].value.length, 1);
  s.adapter({ version: 1, qualityGates: { required: [{ ...GATES[0], command: "rm -rf /" }] } });
  const changed = resolveConfig({ env: s.env, repoPath: s.repo });
  assert.equal(changed.repo.trustReason, "CHANGED");
  assert.deepEqual(changed.entries["qualityGates.required"].value, []);
});

test("a repository without an adapter file is fine", () => {
  const s = setup();
  const resolved = resolveConfig({ env: s.env, repoPath: s.repo });
  assert.equal(resolved.repo.hasAdapter, false);
  assert.deepEqual(resolved.repo.skipped, []);
  assert.equal(resolved.entries["provider.workItems"].origin, "default");
});

test("readExecutableRepoConfig requires trust (exit 4) and returns commands only when trusted", () => {
  const s = setup();
  s.adapter({ version: 1, qualityGates: { required: GATES } });
  assert.throws(() => readExecutableRepoConfig(s.repo, "run quality gates", { env: s.env }), (error) => error.exitCode === EXIT.TRUST && error.code === "TRUST_REQUIRED");
  grantTrust(s.repo, { env: s.env });
  const { gates, file } = readExecutableRepoConfig(s.repo, "run quality gates", { env: s.env });
  assert.deepEqual(gates, GATES);
  assert.equal(file, join(s.repo, ".claude", "asterweave.json"));
});

test("invalid values are typed errors mapped to exit 5 and name the key and origin", () => {
  const s = setup();
  const expectConfigError = (action, key, originPattern) =>
    assert.throws(action, (error) => {
      assert.ok(error instanceof ConfigError, error.message);
      assert.equal(error.exitCode, EXIT.CONFIG);
      assert.equal(error.code, "CONFIG_INVALID");
      if (key) assert.equal(error.key, key);
      if (originPattern) assert.match(error.origin, originPattern);
      return true;
    });

  s.user({ runner: "cloud" });
  expectConfigError(() => resolveConfig({ env: s.env }), "runner", /^user:/);
  s.user({ github: { host: 42 } });
  expectConfigError(() => resolveConfig({ env: s.env }), "github.host", /^user:/);
  s.user({ github: { host: "bad host!" } });
  expectConfigError(() => resolveConfig({ env: s.env }), "github.host", /^user:/);
  s.user("{ not json");
  expectConfigError(() => resolveConfig({ env: s.env }), undefined, /^user:/);
  s.user("[1,2]");
  expectConfigError(() => resolveConfig({ env: s.env }), undefined, /^user:/);
  s.user({});

  expectConfigError(() => resolveConfig({ env: { ...s.env, ASTERWEAVE_RUNNER: "cloud" } }), "runner", /^env:ASTERWEAVE_RUNNER$/);
  expectConfigError(() => resolveConfig({ env: s.env, flags: { "ui.color": "rainbow" } }), "ui.color", /^flag$/);
  expectConfigError(() => resolveConfig({ env: s.env, flags: { "no.such": "x" } }), "no.such", /^flag$/);
  expectConfigError(() => resolveConfig({ env: s.env, flags: { "qualityGates.required": [] } }), "qualityGates.required", /^flag$/);

  s.adapter({ version: 2 });
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), "version", /^repo:/);
  s.adapter({ version: 1, surprise: true });
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), "surprise", /^repo:/);
  s.adapter({ version: 1, provider: { workItems: "jira" } });
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), "provider.workItems", /^repo:/);
  s.adapter({ version: 1, qualityGates: { required: [{ id: "x" }] } });
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), "qualityGates.required[0]", /^repo:/);
  s.adapter("{ nope");
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), undefined, /^repo:/);
  s.adapter([]);
  expectConfigError(() => resolveConfig({ env: s.env, repoPath: s.repo }), undefined, /^repo:/);
});

test("empty env values are ignored and unknown user keys are reported, not applied", () => {
  const s = setup();
  s.user({ "api.token": "abc", future: { thing: 1 }, qualityGates: { required: GATES } });
  const resolved = resolveConfig({ env: { ...s.env, ASTERWEAVE_RUNNER: "" } });
  assert.equal(resolved.entries.runner.origin, "default");
  assert.deepEqual(resolved.unknown.map((entry) => entry.key).sort(), ["api.token", "future.thing", "qualityGates.required"].sort());
  assert.deepEqual(resolved.entries["qualityGates.required"].value, [], "a user file cannot set executable repo-only keys");
});

test("the view redacts secret-like keys and token or email shapes, and does not mutate", () => {
  const s = setup();
  const token = `gh${"p"}_${"abcdefghij".repeat(4)}`;
  s.user({ "api.token": token, notes: { owner: "anjo@gmail.com", plain: "fine" }, password: "hunter2" });
  s.adapter({ version: 1, qualityGates: { required: [{ id: "deploy", command: `deploy --token=${token}`, source: "ci" }] } });
  grantTrust(s.repo, { env: s.env });
  const resolved = resolveConfig({ env: s.env, repoPath: s.repo });
  const view = configView(resolved);
  const text = JSON.stringify(view);
  assert.ok(!text.includes(token), "token never appears");
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("anjo@gmail.com"));
  const byKey = Object.fromEntries(view.unknown.map((entry) => [entry.key, entry.value]));
  assert.equal(byKey["api.token"], "[redacted]");
  assert.equal(byKey.password, "[redacted]");
  assert.equal(byKey["notes.owner"], "an***@g***.com");
  assert.equal(byKey["notes.plain"], "fine");
  assert.match(view.entries["qualityGates.required"].value[0].command, /^deploy --token=\[redacted\]$/);
  assert.equal(view.entries["qualityGates.required"].origin, resolved.entries["qualityGates.required"].origin);
  // Input is untouched.
  assert.ok(resolved.entries["qualityGates.required"].value[0].command.includes(token));
  assert.equal(resolved.unknown.find((entry) => entry.key === "api.token").value, token);
});
