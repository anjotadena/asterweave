// Phase F2: `asterweave mcp add|remove` and the mutation envelope (preview, confirmation, snapshot/diff, UNEXPECTED_CHANGE, trust-after-
// mutation). Fake claude + isolated HOME/USERPROFILE/APPDATA/config dirs in every world: nothing real is touched.

import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { cleanup, alive, readJsonFile, world } from "./admin-fixture.mjs";
import { definitionHashOf, loadMcpServers, readApproval, saveApproval, cwdLabel } from "../src/runtime/tools/mcp-config.mjs";
import { descriptorHash, descriptorOf } from "../src/runtime/tools/descriptor.mjs";
import { repositoryIdentity, safeTrustStatus, grantTrust } from "../src/trust.mjs";
import { mcpCommandMeta } from "../src/commands/mcp.mjs";
import { waitFor } from "./repo-fixture.mjs";

after(cleanup);

const add = (...flags) => ["add", "files", "--scope", "repo", "--env", "API_KEY=${MY_KEY}", ...flags, "--", "node", "server.js"];
const trustOpts = (w) => ({ env: w.env });
const trusted = (w) => safeTrustStatus(w.repo, trustOpts(w)).trusted;

test("add --scope repo: exact preview, one claude call, verified single entry, repository untrusted (exit 4) with a remediation", async () => {
  const w = world();
  const result = await w.run(add("--yes"));
  assert.equal(result.code, 4, result.err);
  assert.match(result.out, /command: claude mcp add files -s project -t stdio -e 'API_KEY=\$\{MY_KEY\}' -- node server\.js/);
  assert.match(result.out, /runs in: the repository root/);
  assert.match(result.out, /repository trust: untrusted/);
  assert.match(result.out, /asterweave trust grant --path/);
  assert.deepEqual(w.calls(), [["mcp", "add", "files", "-s", "project", "-t", "stdio", "-e", "API_KEY=${MY_KEY}", "--", "node", "server.js"]]);
  const entry = readJsonFile(w.mcpFile).mcpServers.files;
  assert.deepEqual([entry.command, entry.args, entry.env], ["node", ["server.js"], { API_KEY: "${MY_KEY}" }]);
  assert.equal(w.recorded().cwd, w.repo);
  assert.equal(trusted(w), false);
});

test("--json prints exactly one document for success and for failure", async () => {
  const w = world();
  const ok = await w.run(add("--yes", "--json"));
  assert.equal(ok.code, 4);
  const body = ok.json();
  assert.equal(body.ok, true);
  assert.equal(body.verified, true);
  assert.equal(body.trust.state, "untrusted");
  assert.equal(body.claudeScope, "project");
  assert.deepEqual(body.changedFiles, [".mcp.json"]);
  const missing = await w.run(["add", "fresh", "--scope", "repo", "--json", "--", "node"]);
  assert.equal(missing.code, 2);
  assert.equal(missing.json().ok, false);
  assert.equal(missing.json().error.code, "USAGE");
  w.scenario({ admin: { behavior: "extra-server" } });
  const bad = await w.run(["add", "other", "--scope", "repo", "--yes", "--json", "--", "node"]);
  assert.equal(bad.code, 1);
  assert.equal(bad.json().error.code, "UNEXPECTED_CHANGE");
});

test("confirmation: a terminal asks y/N (default no); a non-terminal and --json need --yes (exit 2) and never prompt", async () => {
  const w = world();
  const no = await w.tty(add(), ["n"]);
  assert.equal(no.code, 1);
  assert.match(no.out, /command: claude mcp add/);
  assert.deepEqual(w.calls(), []);
  assert.ok(!existsSync(w.mcpFile));
  const needsYes = await w.run(add());
  assert.equal(needsYes.code, 2);
  assert.match(needsYes.err, /needs --yes/);
  assert.equal((await w.run(add("--json"))).code, 2);
  assert.deepEqual(w.calls(), []);
  const yes = await w.tty(add(), ["y"]);
  assert.equal(yes.code, 4);
  assert.equal(w.calls().length, 1);
});

test("agent-context markers refuse with exit 7 even with --yes; nothing runs", async () => {
  const w = world();
  for (const env of [{ ASTERWEAVE_RUN_ID: "r1" }, { ASTERWEAVE_SESSION_ID: "s1" }, { CLAUDECODE: "1" }, { CLAUDE_CODE_ENTRYPOINT: "cli" }]) {
    const result = await w.run(add("--yes"), { env });
    assert.equal(result.code, 7, JSON.stringify(env));
    assert.equal((await w.run(["remove", "files", "--scope", "repo", "--yes"], { env })).code, 7);
  }
  assert.deepEqual(w.calls(), []);
});

test("literal env/header values are refused (exit 2) without being echoed; references are accepted", async () => {
  const w = world();
  const secret = "s3cr3t-value-123";
  for (const argv of [
    ["add", "x", "--scope", "repo", "--yes", "--env", `API_KEY=${secret}`, "--", "node"],
    ["add", "x", "--scope", "repo", "--yes", "--env", "API_KEY=${lowercase}", "--", "node"],
    ["add", "x", "--scope", "repo", "--yes", "--env", "API_KEY=${A:-default}", "--", "node"],
    ["add", "x", "https://example.com/mcp", "--scope", "repo", "--yes", "--header", `Authorization: Bearer ${secret}`],
  ]) {
    const result = await w.run(argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.ok(!(result.out + result.err).includes(secret));
    assert.match(result.err, /not a reference|needs/);
  }
  assert.deepEqual(w.calls(), []);
  const cred = await w.run(["add", "c", "--scope", "repo", "--yes", "--env", "K=${cred:MY_CRED}", "--", "node", "s.js"]);
  assert.equal(cred.code, 4);
  assert.match(cred.out, /does not expand it/, "a ${cred:NAME} reference warns that Claude Code does not expand it");
});

test("repeated --env and --header both reach claude (the shared parser keeps only the last)", async () => {
  const w = world();
  assert.equal((await w.run(["add", "m", "--scope", "repo", "--yes", "--env", "A=${AA}", "--env=B=${BB}", "--", "node", "--env", "x"])).code, 4);
  assert.deepEqual(readJsonFile(w.mcpFile).mcpServers.m.env, { A: "${AA}", B: "${BB}" });
  assert.deepEqual(readJsonFile(w.mcpFile).mcpServers.m.args, ["--env", "x"], "options after -- belong to the server");
  assert.equal((await w.run(["add", "r", "https://example.com/mcp", "--scope", "repo", "--yes", "--header", "X-A: ${AA}", "--header", "Authorization: Bearer ${TT}"])).code, 4);
  assert.deepEqual(readJsonFile(w.mcpFile).mcpServers.r.headers, { "X-A": "${AA}", Authorization: "Bearer ${TT}" });
});

test("usage errors: urls, transports, local scope, unknown options, enable/disable, wrong subcommand options", async () => {
  const w = world();
  const cases = [
    [["add", "x", "http://example.com/mcp", "--scope", "repo", "--yes"], /https/],
    [["add", "x", "https://u:p@example.com/mcp", "--scope", "repo", "--yes"], /credentials/],
    [["add", "x", "--scope", "local", "--yes", "--", "node"], /local scope is never used/],
    [["add", "x", "--yes", "--", "node"], /--scope/],
    [["add", "x", "--scope", "everywhere", "--yes", "--", "node"], /global or repo/],
    [["add", "x", "--scope", "repo", "--yes"], /command after/],
    [["add", "x", "https://example.com/mcp", "--scope", "repo", "--transport", "http", "--env", "A=${B}", "--yes"], /--header/],
    [["add", "x", "--scope", "repo", "--bogus", "1", "--yes", "--", "node"], /Unknown option/],
    [["enable", "x"], /no CLI to enable or disable/],
    [["disable", "x"], /no CLI to enable or disable/],
    [["list", "--scope", "repo"], /does not apply/],
    [["test", "x", "--yes"], /does not apply/],
    [["remove", "x", "--scope", "repo", "--approve", "abcdef123456"], /does not apply/],
    [["add", "bad name!", "--scope", "repo", "--yes", "--", "node"], /not a valid server name/],
  ];
  for (const [argv, pattern] of cases) {
    const result = await w.run(argv);
    assert.equal(result.code, 2, argv.join(" "));
    assert.match(result.err, pattern, argv.join(" "));
  }
  assert.deepEqual(w.calls(), []);
});

test("the linter's warnings are shown in the preview (unpinned npx) and an existing name is refused", async () => {
  const w = world();
  const result = await w.run(["add", "n", "--scope", "repo", "--yes", "--", "npx", "-y", "some-pkg"]);
  assert.equal(result.code, 4);
  assert.match(result.out, /WARNING: the package is not pinned/);
  const again = await w.run(["add", "n", "--scope", "repo", "--yes", "--", "node"]);
  assert.equal(again.code, 1);
  assert.match(again.err, /already exists/);
  assert.equal(w.calls().length, 1);
});

test("UNEXPECTED_CHANGE: an extra server, a different entry, an edited settings file or adapter => exit 1, no trust, nothing reverted", async () => {
  for (const behavior of ["extra-server", "alter-entry", "edit-settings", "edit-asterweave"]) {
    const w = world({ behavior });
    grantTrust(w.repo, trustOpts(w));
    const result = await w.run(["add", "files", "--scope", "repo", "--yes", "--trust", "--", "node", "s.js"]);
    assert.equal(result.code, 1, behavior);
    assert.match(result.err, /UNEXPECTED_CHANGE/);
    assert.match(result.err, /git diff/);
    assert.equal(trusted(w), false, `${behavior}: trust was not re-granted`);
    assert.ok(existsSync(w.mcpFile), `${behavior}: the written .mcp.json is left as it is`);
    if (behavior === "edit-settings") assert.ok(readJsonFile(w.settingsFile).hooks, "the edited settings file is left as it is");
    if (behavior === "edit-asterweave") assert.ok(existsSync(join(w.repo, ".claude", "asterweave.json")), "the adapter claude wrote is left as it is");
  }
  const w = world({ behavior: "extra-server" });
  await w.run(["add", "files", "--scope", "repo", "--yes", "--", "node"]);
  assert.ok(readJsonFile(w.mcpFile).mcpServers.extra, "the extra entry is NOT reverted");
});

test("claude failing: exit 1 with its (redacted) stderr, trust never granted; a failure after writing reports the files that changed", async () => {
  const w = world({ behavior: "fail", extraScenario: { stderr: `nope token=ghp_${"E".repeat(36)}\n` } });
  const failed = await w.run(["add", "x", "--scope", "repo", "--yes", "--", "node"]);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /claude exited with 1/);
  assert.ok(!failed.err.includes("E".repeat(36)));
  assert.match(failed.err, /Nothing was changed/);
  w.scenario({ admin: { behavior: "fail-after-write" } });
  grantTrust(w.repo, trustOpts(w));
  const half = await w.run(["add", "y", "--scope", "repo", "--yes", "--trust", "--", "node"]);
  assert.equal(half.code, 1);
  assert.match(half.err, /Files changed: \.mcp\.json/);
  assert.equal(trusted(w), false);
});

test("--trust re-grants only when the repository was trusted before, the diff is exact and a person confirmed (or --yes)", async () => {
  // trusted before + exact diff + --yes: trusted afterwards, exit 0
  const a = world();
  grantTrust(a.repo, trustOpts(a));
  const granted = await a.run(add("--yes", "--trust"));
  assert.equal(granted.code, 0, granted.err);
  assert.match(granted.out, /repository trust: trusted/);
  assert.equal(trusted(a), true);
  // trusted before + terminal: a second prompt is asked and "n" leaves it untrusted
  const b = world();
  grantTrust(b.repo, trustOpts(b));
  const declined = await b.tty(add("--trust"), ["y", "n"]);
  assert.equal(declined.code, 4);
  assert.equal(declined.prompts, 2);
  assert.equal(trusted(b), false);
  const c = world();
  grantTrust(c.repo, trustOpts(c));
  const accepted = await c.tty(add("--trust"), ["y", "y"]);
  assert.equal(accepted.code, 0, accepted.err);
  assert.equal(accepted.prompts, 2, "the change prompt and the trust prompt");
  assert.equal(trusted(c), true);
  // NOT trusted before: --trust is not applied (it would bless unreviewed config)
  const d = world();
  const refused = await d.run(add("--yes", "--trust"));
  assert.equal(refused.code, 4);
  assert.match(refused.out, /was not trusted before/);
  assert.equal(trusted(d), false);
  // without --trust the repository is untrusted afterwards even if it was trusted
  const e = world();
  grantTrust(e.repo, trustOpts(e));
  assert.equal((await e.run(add("--yes"))).code, 4);
  assert.equal(trusted(e), false);
  // --trust is meaningless for global scope
  assert.equal((await world().run(["add", "g", "--scope", "global", "--trust", "--yes", "--", "node"])).code, 2);
});

test("global scope: the user file changes (mcpServers only), claude runs in a neutral dir, the repository and its trust are untouched", async () => {
  const w = world({ behavior: "other-keys" });
  writeFileSync(w.userFile, JSON.stringify({ numStartups: 7, mcpServers: {} }));
  grantTrust(w.repo, trustOpts(w));
  const result = await w.run(["add", "g", "--scope", "global", "--yes", "--", "node", "s.js"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /runs in: a new empty temporary directory/);
  assert.match(result.out, /repository trust: not applicable/);
  assert.deepEqual(w.calls()[0].slice(0, 5), ["mcp", "add", "g", "-s", "user"]);
  assert.notEqual(w.recorded().cwd, w.repo);
  assert.equal(readJsonFile(w.userFile).mcpServers.g.command, "node");
  assert.equal(readJsonFile(w.userFile).numStartups, 8, "Claude's own bookkeeping keys are ignored by the verification");
  assert.ok(!existsSync(w.mcpFile));
  assert.equal(trusted(w), true, "global changes never touch repository trust");
  const servers = loadMcpServers({ repoRoot: w.repo, homedir: () => w.home }).servers;
  assert.deepEqual(servers.map((s) => `${s.source}:${s.name}`), ["user:g"]);
});

test("remove: preview, verified single removal, the stored approval record is deleted (project and user), a missing server is refused", async () => {
  const defs = { files: { command: "node", args: ["s.js"], env: {} }, keep: { command: "node", args: ["k.js"], env: {} } };
  const w = world({ mcpServers: defs });
  const identity = repositoryIdentity(w.repo, trustOpts(w));
  const record = (server) => ({ definitionHash: definitionHashOf(server, cwdLabel(server, w.repo)), descriptorHash: descriptorHash({}, []), tools: ["t"], approvedAt: "2026-01-01T00:00:00Z" });
  const sample = { transport: "stdio", command: "node", args: [], env: {}, url: null, source: "project" };
  saveApproval(identity.key, "project", "files", record(sample), trustOpts(w));
  saveApproval(identity.key, "project", "keep", record(sample), trustOpts(w));
  assert.ok(readApproval(identity.key, "project", "files", trustOpts(w)));
  const result = await w.run(["remove", "files", "--scope", "repo", "--yes"]);
  assert.equal(result.code, 4, result.err);
  assert.match(result.out, /command: claude mcp remove files -s project/);
  assert.match(result.out, /removed 1 stored approval record/);
  assert.deepEqual(Object.keys(readJsonFile(w.mcpFile).mcpServers), ["keep"]);
  assert.equal(readApproval(identity.key, "project", "files", trustOpts(w)), null);
  assert.ok(readApproval(identity.key, "project", "keep", trustOpts(w)), "other servers keep their approval");
  const missing = await w.run(["remove", "files", "--scope", "repo", "--yes"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /No MCP server named/);
  // a user server's approval is shared by every repository: removed under every repo key
  writeFileSync(w.userFile, JSON.stringify({ mcpServers: { u: { command: "node" } } }));
  saveApproval(identity.key, "user", "u", record({ ...sample, source: "user" }), trustOpts(w));
  saveApproval("other-repo-key", "user", "u", record({ ...sample, source: "user" }), trustOpts(w));
  assert.equal((await w.run(["remove", "u", "--scope", "global", "--yes"])).code, 0);
  assert.equal(readApproval(identity.key, "user", "u", trustOpts(w)), null);
  assert.equal(readApproval("other-repo-key", "user", "u", trustOpts(w)), null);
  assert.deepEqual(readJsonFile(w.userFile).mcpServers, {});
});

test("the descriptor hash binds the reference NAMES; ${NAME} and ${cred:NAME} validate, defaults and literals do not", () => {
  const hash = (env) => descriptorHash({ transport: "stdio", command: "node", args: [], cwd: "c", env, url: null }, null);
  assert.notEqual(hash({ K: "${A}" }), hash({ K: "${B}" }));
  assert.notEqual(hash({ K: "${A}" }), hash({ K: "${cred:A}" }), "the two reference forms stay distinguishable");
  assert.equal(hash({ K: "${A}" }), hash({ K: "${A}" }));
  assert.deepEqual(descriptorOf({ env: { K: "${cred:A}", L: "${B}", M: "lit" } }).envRefs, { K: "A", L: "env:B", M: "[literal]" }, "cred refs hash exactly as before (existing approvals stay valid)");
});

test("abort during the claude call: exit 130 and no orphan process", async () => {
  const w = world({ behavior: "hang" });
  const controller = new AbortController();
  const done = w.run(["add", "h", "--scope", "repo", "--yes", "--", "node"], { io: { signal: controller.signal } });
  await waitFor(() => w.recorded() !== null, { label: "the child to start" });
  const pid = w.recorded().pid;
  controller.abort();
  const result = await done;
  assert.equal(result.code, 130);
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false);
  assert.equal(trusted(w), false);
});

test("help and options: add/remove are listed and accepted, the file stays within its size budget", () => {
  for (const option of ["scope", "transport", "env", "header", "yes", "trust"]) assert.ok(mcpCommandMeta.options.includes(option), option);
  assert.ok(mcpCommandMeta.boolean.includes("yes") && mcpCommandMeta.boolean.includes("trust"));
  const lines = readFileSync(new URL("../src/commands/mcp.mjs", import.meta.url), "utf8").split("\n").length;
  assert.ok(lines <= 700, `mcp.mjs has ${lines} lines`);
});

// --- review fixes -----------------------------------------------------------------------------------------------------------------

test("TOCTOU: a governing file written between the trust check and the before-snapshot is never blessed by --trust; claude is not run", async () => {
  const { applyMutation } = await import("../src/runtime/claude/mutate.mjs");
  const { buildMcpAddArgs } = await import("../src/runtime/claude/admin.mjs");
  const { TRUST_FILES } = await import("../src/trust.mjs");
  const w = world({ mcpServers: { keep: { command: "node", args: ["k.js"] } }, settings: { permissions: { allow: [] } } });
  grantTrust(w.repo, trustOpts(w));
  assert.equal(trusted(w), true);
  let calls = 0;
  const read = () => Object.fromEntries(TRUST_FILES.map((relative) => { try { return [relative, readFileSync(join(w.repo, ...relative.split("/")), "utf8")]; } catch { return [relative, null]; } }));
  const snapshot = () => {
    calls += 1;
    if (calls === 1) writeFileSync(w.settingsFile, JSON.stringify({ permissions: { allow: [] }, hooks: { SessionStart: [{ hooks: [{ type: "command", command: "evil.exe" }] }] } }));
    return read();
  };
  const out = { write: () => true };
  await assert.rejects(
    applyMutation({ ctx: { env: w.env, stdin: { isTTY: false }, stdout: out, homedir: () => w.home, claude: w.claude }, kind: "mcp", action: "add", scope: "repo", id: "x", repoRoot: w.repo, args: buildMcpAddArgs({ scope: "repo", name: "x", command: "node", args: ["s.js"] }), snapshot, verify: () => ({ ok: true, problems: [] }), yes: true, trust: true, json: true }),
    (error) => error.code === "UNEXPECTED_CHANGE" && /while the change was being prepared/.test(error.message),
  );
  assert.deepEqual(w.calls(), [], "claude was not run");
  assert.equal(trusted(w), false, "the repository is untrusted: the hook was never blessed");
  assert.ok(readFileSync(w.settingsFile, "utf8").includes("evil.exe"), "nothing was reverted");
});

test("a changed file outside the expected target is UNEXPECTED_CHANGE even when the caller's verify says ok", async () => {
  const { applyMutation } = await import("../src/runtime/claude/mutate.mjs");
  const { buildMcpAddArgs } = await import("../src/runtime/claude/admin.mjs");
  const w = world({ behavior: "edit-settings" });
  grantTrust(w.repo, trustOpts(w));
  const out = { write: () => true };
  await assert.rejects(
    applyMutation({ ctx: { env: w.env, stdin: { isTTY: false }, stdout: out, homedir: () => w.home, claude: w.claude }, kind: "mcp", action: "add", scope: "repo", id: "x", repoRoot: w.repo, args: buildMcpAddArgs({ scope: "repo", name: "x", command: "node" }), snapshot: () => ({}), verify: () => ({ ok: true, problems: [] }), yes: true, trust: true, json: true }),
    (error) => error.code === "UNEXPECTED_CHANGE" && /outside the expected target.*\.claude\/settings\.json/.test(error.message),
  );
  assert.equal(trusted(w), false);
});

test("global changes name the files that changed (never 'nothing changed' after a write) and give no git diff advice", async () => {
  const w = world({ behavior: "fail-after-write" });
  const failed = await w.run(["add", "g", "--scope", "global", "--yes", "--", "node"]);
  assert.equal(failed.code, 1);
  assert.match(failed.err, /Files changed: ~\/\.claude\.json/);
  assert.ok(!/git diff/.test(failed.err));
  assert.ok(!/Nothing was changed/.test(failed.err));
  const ok = world();
  const done = await ok.run(["add", "g", "--scope", "global", "--yes", "--json", "--", "node"]);
  assert.equal(done.code, 0);
  assert.deepEqual(done.json().changedFiles, ["~/.claude.json"]);
  const unexpected = world({ behavior: "extra-server" });
  const bad = await unexpected.run(["add", "g", "--scope", "global", "--yes", "--", "node"]);
  assert.equal(bad.code, 1);
  assert.ok(!/git diff/.test(bad.err));
  assert.match(bad.err, /~\/\.claude\.json/);
});

test("CLAUDE_CONFIG_DIR: any change is refused with a clear message (not passed on silently), for both scopes and when empty", async () => {
  const w = world();
  for (const name of ["CLAUDE_CONFIG_DIR"]) {
    const refused = await w.run(["add", "g", "--scope", "global", "--yes", "--", "node"], { env: { [name]: w.home } });
    assert.equal(refused.code, 2);
    assert.match(refused.err, /CLAUDE_CONFIG_DIR is set/);
  }
  assert.deepEqual(w.calls(), []);
  assert.ok(!existsSync(w.userFile));
  for (const value of [w.home, ""]) {
    const repo = await w.run(["add", "r", "--scope", "repo", "--yes", "--", "node"], { env: { CLAUDE_CONFIG_DIR: value } });
    assert.equal(repo.code, 2, `repo scope, value '${value}'`);
    assert.match(repo.err, /CLAUDE_CONFIG_DIR is set/);
    assert.equal((await w.run(["add", "g", "--scope", "global", "--yes", "--", "node"], { env: { CLAUDE_CONFIG_DIR: value } })).code, 2);
  }
  assert.deepEqual(w.calls(), []);
  assert.ok(!existsSync(w.mcpFile));
});

test("remove deletes the approval whenever the entry is gone, also after a failing claude; a failed deletion is reported", async () => {
  const defs = { files: { command: "node", args: ["s.js"], env: {} } };
  const w = world({ mcpServers: defs, behavior: "fail-after-write" });
  const identity = repositoryIdentity(w.repo, trustOpts(w));
  const sample = { transport: "stdio", command: "node", args: [], env: {}, url: null, source: "project" };
  const record = { definitionHash: definitionHashOf(sample, cwdLabel(sample, w.repo)), descriptorHash: descriptorHash({}, []), tools: ["t"], approvedAt: "2026-01-01T00:00:00Z" };
  saveApproval(identity.key, "project", "files", record, trustOpts(w));
  const failed = await w.run(["remove", "files", "--scope", "repo", "--yes"]);
  assert.equal(failed.code, 1, "claude exited non-zero");
  assert.deepEqual(readJsonFile(w.mcpFile).mcpServers, {}, "the entry is gone");
  assert.equal(readApproval(identity.key, "project", "files", trustOpts(w)), null, "its approval is gone with it");
  // an approval store that cannot be updated is reported, not swallowed
  const v = world({ mcpServers: defs });
  mkdirSync(join(v.userDir, "mcp-approvals.json"), { recursive: true });
  const warned = await v.run(["remove", "files", "--scope", "repo", "--yes"]);
  assert.equal(warned.code, 4);
  assert.match(warned.out, /Warning: The stored approval record of 'files' could not be deleted/);
});

test("Ctrl-C (abort) during a global change: exit 130, the claude tree is killed, the neutral directory is removed, the message names the files", async () => {
  const w = world({ behavior: "hang" });
  const controller = new AbortController();
  const done = w.run(["add", "h", "--scope", "global", "--yes", "--", "node"], { io: { signal: controller.signal } });
  await waitFor(() => w.recorded() !== null, { label: "the child to start" });
  const { pid, cwd } = w.recorded();
  controller.abort();
  const result = await done;
  assert.equal(result.code, 130);
  assert.match(result.err, /Interrupted/);
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(pid), false);
  assert.ok(!existsSync(cwd), "the neutral temp directory is gone");
  const r = world({ behavior: "hang" });
  const again = new AbortController();
  const doneRepo = r.run(["add", "h", "--scope", "repo", "--yes", "--", "node"], { io: { signal: again.signal } });
  await waitFor(() => r.recorded() !== null, { label: "the child to start" });
  again.abort();
  const repoResult = await doneRepo;
  assert.equal(repoResult.code, 130);
  assert.match(repoResult.err, /No file changed|Files changed/);
});

test("mcp validate and mcp add agree on references: a lower-case ${var} is not a reference anywhere", async () => {
  const w = world({ mcpServers: { a: { command: "node", env: { K: "${lower}" } }, b: { command: "node", env: { K: "${UPPER}", L: "${cred:mixedCase}" } } } });
  const result = await w.run(["validate", "--json"]);
  assert.equal(result.code, 5);
  const problems = result.json().problems.filter((p) => p.code === "MCP_ENV_LITERAL");
  assert.deepEqual(problems.map((p) => p.server), ["a"]);
});

test("ABA: a governing file that reads differently ONCE (evil present for a single read, reverted before the next) is never blessed by --trust", async () => {
  const nodeFs = await import("node:fs");
  const { applyMutation } = await import("../src/runtime/claude/mutate.mjs");
  const { buildMcpAddArgs } = await import("../src/runtime/claude/admin.mjs");
  const { parseUnits, diffUnits } = await import("../src/runtime/claude/diff.mjs");
  const verify = (before, after) => {
    const changes = diffUnits(parseUnits(before[".mcp.json"], { collections: ["mcpServers"] }), parseUnits(after[".mcp.json"], { collections: ["mcpServers"] }));
    const ok = changes.length === 1 && changes[0].unit === "mcpServers.x" && changes[0].op === "added" && Object.keys(before).every((file) => file === ".mcp.json" || before[file] === after[file]);
    return { ok, problems: ok ? [] : changes.map((c) => `${c.unit} ${c.op}`) };
  };
  const attempt = async (glitchAt) => {
    const w = world({ mcpServers: { keep: { command: "node", args: ["k.js"] } }, settings: { permissions: { allow: [] } } });
    grantTrust(w.repo, trustOpts(w));
    const evil = Buffer.from(JSON.stringify({ mcpServers: { keep: { command: "node", args: ["k.js"] }, evil: { command: "evil.exe" } } }));
    let reads = 0;
    const fs = { ...nodeFs, readFileSync: (file, ...rest) => { if (String(file).endsWith(".mcp.json") && !rest.length) { reads += 1; if (reads === glitchAt) return evil; } return nodeFs.readFileSync(file, ...rest); } };
    const request = { ctx: { env: w.env, stdin: { isTTY: false }, stdout: { write: () => true }, homedir: () => w.home, fs, claude: w.claude }, kind: "mcp", action: "add", scope: "repo", id: "x", repoRoot: w.repo, args: buildMcpAddArgs({ scope: "repo", name: "x", command: "node", args: ["s.js"] }), snapshot: (governing) => ({ ...governing }), verify, yes: true, trust: true, json: true };
    let outcome = "ok";
    try { await applyMutation(request); } catch (error) { outcome = error.code ?? "error"; }
    return { outcome, reads, trusted: trusted(w), mcp: readFileSync(w.mcpFile, "utf8") };
  };
  const clean = await attempt(0);
  assert.equal(clean.outcome, "ok");
  assert.equal(clean.trusted, true, "without a glitch --trust re-grants (control)");
  assert.ok(clean.reads >= 8, `the envelope reads the file several times (${clean.reads})`);
  for (let k = 1; k <= clean.reads; k += 1) {
    const result = await attempt(k);
    assert.notEqual(result.outcome, "ok", `glitch at read ${k} must be refused`);
    // refused before claude ran: the files are untouched, so the earlier grant still stands; once claude ran the changed repository must be untrusted
    if (result.mcp.includes("\"x\"")) assert.equal(result.trusted, false, `glitch at read ${k}: a changed repository must not end up trusted`);
    assert.ok(!result.mcp.includes("evil.exe"), "the real file never held the evil entry");
  }
});
