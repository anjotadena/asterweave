// User and repository hooks: loading (trust gate, order, dedupe, validation) and execution (no shell,
// minimal env, redacted payload, timeouts, failure policy, validate-can-only-tighten).
// Hooks are real child processes: `process.execPath` running small scripts written to a temp directory.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { ConfigError, resolveConfig } from "../src/config.mjs";
import { makeDecision } from "../src/runtime/guard.mjs";
import {
  BLOCKING_EVENTS,
  HOOK_EVENTS,
  HooksError,
  hookPayload,
  loadHooks,
  minimalHookEnv,
  runHooks,
  userHooksFilePath,
  validateHookEntries,
} from "../src/runtime/hooks.mjs";
import { grantTrust } from "../src/trust.mjs";

let base;
let scripts;
let seq = 0;

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-hooks-")));
  scripts = join(base, "scripts");
  mkdirSync(scripts, { recursive: true });
  // record.mjs <out> <tag> [exitCode] [stdout]: appends what it saw to <out>, optionally prints and exits non-zero.
  writeFileSync(
    join(scripts, "record.mjs"),
    [
      'import { appendFileSync, readFileSync } from "node:fs";',
      "const [out, tag, code = '0', stdout = ''] = process.argv.slice(2);",
      "const input = readFileSync(0, 'utf8');",
      "appendFileSync(out, JSON.stringify({ tag, argv: process.argv.slice(2), input, env: Object.keys(process.env) }) + '\\n');",
      "if (stdout) process.stdout.write(stdout);",
      "process.exit(Number(code));",
      "",
    ].join("\n"),
  );
  writeFileSync(join(scripts, "sleep.mjs"), "setTimeout(() => {}, 30000);\n");
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

const recordScript = () => join(scripts, "record.mjs");
const newLog = () => join(base, `log${seq++}.jsonl`);
const readLog = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GH_TOKEN: "tok-1", GITHUB_TOKEN: "tok-2", MY_SECRET: "tok-3", Path: process.platform === "win32" ? process.env.Path : undefined };

/** A normalized hook running record.mjs. */
function hook(id, event, kind, { log, tag = id, code = 0, stdout = "", timeoutMs = 10_000, onFailure, source = "user", extra = [] } = {}) {
  return { id, event, kind, source, timeoutMs, onFailure: onFailure ?? (kind === "validate" ? "block" : "ignore"), argv: [process.execPath, recordScript(), log, tag, String(code), stdout, ...extra] };
}
const sleeper = (id, kind, options = {}) => ({ id, event: "tool.before", kind, source: "user", timeoutMs: options.timeoutMs ?? 300, onFailure: options.onFailure ?? "block", argv: [process.execPath, join(scripts, "sleep.mjs")] });
const run = (event, hooks, extra = {}) => runHooks(event, { tool: "shell" }, { hooks, env, runId: "run-1", seq: 7, cwd: base, killGraceMs: 200, ...extra });
const allow = () => makeDecision("allow", "ALLOWED", "allow", { message: "ok" });

// ---------------------------------------------------------------------------------------------
// Loading

function sandbox() {
  const userDir = join(base, `user${seq++}`);
  mkdirSync(userDir, { recursive: true });
  const trustFile = join(userDir, "trust.json");
  return { userDir, trustFile, env: { ASTERWEAVE_CONFIG_DIR: userDir }, trust: { trustFile } };
}
function repoWith(adapter) {
  const dir = join(base, `repo${seq++}`);
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "asterweave.json"), JSON.stringify(adapter));
  return realpathSync.native(dir);
}
const entry = (id, event = "tool.after", extra = {}) => ({ id, event, kind: "log", argv: ["git", "status"], ...extra });

test("the event registry: validate hooks only on blocking events", () => {
  assert.deepEqual(Object.keys(HOOK_EVENTS), ["run.started", "node.before-enter", "tool.before", "tool.after", "node.completed", "approval.requested", "run.finished"]);
  assert.deepEqual(BLOCKING_EVENTS, ["node.before-enter", "tool.before"]);
  assert.deepEqual(validateHookEntries([entry("a", "tool.before", { kind: "validate" })]), []);
  assert.match(validateHookEntries([entry("a", "run.finished", { kind: "validate" })])[0], /observe-only/);
});

test("entry validation rejects bad shapes", () => {
  const bad = (value, pattern) => assert.match(validateHookEntries([{ ...entry("a"), ...value }]).join("\n"), pattern);
  bad({ id: "" }, /id must match/);
  bad({ id: "has space" }, /id must match/);
  bad({ event: "tool.during" }, /event must be one of/);
  bad({ kind: "shell" }, /kind must be/);
  bad({ argv: [] }, /argv must be/);
  bad({ argv: "git status" }, /argv must be/);
  bad({ argv: ["git", 5] }, /argv\[1\]/);
  bad({ argv: [""] }, /argv\[0\]/);
  bad({ timeoutMs: 30_001 }, /timeoutMs/);
  bad({ timeoutMs: 0 }, /timeoutMs/);
  bad({ timeoutMs: 1.5 }, /timeoutMs/);
  bad({ onFailure: "explode" }, /onFailure/);
  bad({ shell: true }, /not a known property/);
  assert.match(validateHookEntries({}).join(), /must be an array/);
  assert.match(validateHookEntries([entry("a"), entry("a")]).join(), /duplicate/);
  assert.deepEqual(validateHookEntries([entry("a"), entry("a", "tool.before")]), [], "same id on another event is fine");
  assert.deepEqual(validateHookEntries([entry("a", "tool.after", { timeoutMs: 30_000, onFailure: "block" })]), []);
});

test("user hooks load first, then trusted repository hooks; duplicates by id+event keep the first", () => {
  const box = sandbox();
  writeFileSync(userHooksFilePath({ env: box.env }), JSON.stringify({ v: 1, hooks: [entry("user-a"), entry("shared", "tool.after", { argv: ["user"] })] }));
  const repo = repoWith({ version: 1, hooks: [entry("repo-b", "run.finished"), entry("shared", "tool.after", { argv: ["repo"] }), entry("shared", "tool.before")] });
  grantTrust(repo, { ...box.trust, env: box.env });
  const { hooks, skipped } = loadHooks({ env: box.env, repoPath: repo, trust: box.trust });
  assert.deepEqual(hooks.map((item) => `${item.source}:${item.id}:${item.event}`), ["user:user-a:tool.after", "user:shared:tool.after", "repo:repo-b:run.finished", "repo:shared:tool.before"]);
  assert.deepEqual(hooks.find((item) => item.id === "shared" && item.event === "tool.after").argv, ["user"], "a repository hook can never replace a user hook");
  assert.deepEqual(skipped.map((item) => item.reason), ["DUPLICATE"]);
  // Defaults.
  assert.equal(hooks[0].timeoutMs, 10_000);
  assert.equal(hooks[0].onFailure, "ignore");
});

test("untrusted repository hooks are not loaded and are reported; trust is bound to the file bytes", () => {
  const box = sandbox();
  const repo = repoWith({ version: 1, hooks: [entry("repo-a")] });
  let result = loadHooks({ env: box.env, repoPath: repo, trust: box.trust });
  assert.deepEqual(result.hooks, []);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].source, "repo");
  assert.equal(result.skipped[0].reason, "UNTRUSTED");
  assert.match(result.skipped[0].detail, /1 repository hook/);

  grantTrust(repo, { ...box.trust, env: box.env });
  result = loadHooks({ env: box.env, repoPath: repo, trust: box.trust });
  assert.deepEqual(result.hooks.map((item) => item.id), ["repo-a"]);
  assert.deepEqual(result.skipped, []);

  // Any change to the governing bytes revokes the grant again.
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, hooks: [entry("repo-a"), entry("repo-evil")] }));
  result = loadHooks({ env: box.env, repoPath: repo, trust: box.trust });
  assert.deepEqual(result.hooks, []);
  assert.equal(result.skipped[0].reason, "UNTRUSTED");

  // A repository without hooks reports nothing; user hooks still load.
  const plain = repoWith({ version: 1 });
  writeFileSync(userHooksFilePath({ env: box.env }), JSON.stringify({ v: 1, hooks: [entry("u")] }));
  result = loadHooks({ env: box.env, repoPath: plain, trust: box.trust });
  assert.deepEqual(result.hooks.map((item) => item.id), ["u"]);
  assert.deepEqual(result.skipped, []);
});

test("a corrupt trust store means untrusted, never a crash or a load", () => {
  const box = sandbox();
  writeFileSync(box.trustFile, "{not json");
  const repo = repoWith({ version: 1, hooks: [entry("repo-a")] });
  const result = loadHooks({ env: box.env, repoPath: repo, trust: box.trust });
  assert.deepEqual(result.hooks, []);
  assert.equal(result.skipped[0].reason, "UNTRUSTED");
});

test("invalid hooks configuration is a typed error (exit 5), not a silent skip", () => {
  const box = sandbox();
  const userFile = userHooksFilePath({ env: box.env });
  for (const body of ["{nope", JSON.stringify({ v: 2, hooks: [] }), JSON.stringify({ v: 1, hooks: [{ id: "a" }] }), JSON.stringify({ v: 1, hooks: [], extra: 1 }), JSON.stringify([])]) {
    writeFileSync(userFile, body);
    assert.throws(() => loadHooks({ env: box.env }), (error) => error instanceof HooksError && error.code === "HOOKS_INVALID" && error.exitCode === 5, body);
  }
  rmSync(userFile);
  const repo = repoWith({ version: 1, hooks: [{ id: "x", event: "tool.before", kind: "validate", argv: [] }] });
  grantTrust(repo, { ...box.trust, env: box.env });
  assert.throws(() => loadHooks({ env: box.env, repoPath: repo, trust: box.trust }), HooksError);
});

test("config.mjs accepts valid `hooks` in the repository adapter and rejects invalid ones", () => {
  const box = sandbox();
  const good = repoWith({ version: 1, hooks: [entry("a"), entry("b", "tool.before", { kind: "validate", timeoutMs: 500, onFailure: "block" })] });
  const resolved = resolveConfig({ env: box.env, repoPath: good, trust: box.trust });
  assert.equal(resolved.repo.hasAdapter, true);
  const bad = repoWith({ version: 1, hooks: [entry("a", "tool.after", { kind: "validate" })] });
  assert.throws(() => resolveConfig({ env: box.env, repoPath: bad, trust: box.trust }), (error) => error instanceof ConfigError && error.exitCode === 5 && /invalid hooks/.test(error.message));
  const unknown = repoWith({ version: 1, nothooks: [] });
  assert.throws(() => resolveConfig({ env: box.env, repoPath: unknown, trust: box.trust }), ConfigError);
});

// ---------------------------------------------------------------------------------------------
// Execution

test("hooks run sequentially in order and only for their event", async () => {
  const log = newLog();
  const hooks = [hook("first", "tool.after", "log", { log }), hook("other", "run.finished", "log", { log }), hook("second", "tool.after", "log", { log }), hook("third", "tool.after", "log", { log })];
  const { results, decision } = await run("tool.after", hooks);
  assert.deepEqual(results.map((item) => item.id), ["first", "second", "third"]);
  assert.deepEqual(readLog(log).map((item) => item.tag), ["first", "second", "third"]);
  assert.equal(decision.decision, "allow");
  assert.ok(results.every((item) => item.status === "ok" && item.effect === "none" && item.code === 0));
});

test("an unknown event is a programming error", async () => {
  await assert.rejects(() => run("tool.during", []), TypeError);
});

test("the payload is {v:1,event,runId,seq,...} on stdin, redacted; the environment is minimal", async () => {
  const log = newLog();
  const token = `gh${"p"}_${"a1B2c3D4e5".repeat(4)}`;
  const { results } = await runHooks(
    "tool.before",
    { tool: "shell", message: `use ${token} now`, apiKey: "plain-api-key-value", nested: { password: "hunter2", list: [`Bearer ${"abc.def-ghi_jkl1234567890"}`] } },
    { hooks: [hook("p", "tool.before", "log", { log })], env, runId: "run-9", seq: 41, cwd: base },
  );
  assert.equal(results[0].status, "ok");
  const [seen] = readLog(log);
  const payload = JSON.parse(seen.input);
  assert.equal(payload.v, 1);
  assert.equal(payload.event, "tool.before");
  assert.equal(payload.runId, "run-9");
  assert.equal(payload.seq, 41);
  assert.equal(payload.tool, "shell");
  for (const secret of ["a1B2c3D4e5", "plain-api-key-value", "hunter2", "abc.def-ghi_jkl1234567890"]) assert.equal(seen.input.includes(secret), false, `${secret} leaked`);
  assert.match(payload.message, /ghp_…/);
  // Minimal environment: nothing credential-shaped from the parent, plus the hook markers.
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "MY_SECRET"]) assert.equal(seen.env.includes(key), false, key);
  assert.ok(seen.env.includes("ASTERWEAVE_HOOK_EVENT"));
  assert.ok(seen.env.includes("ASTERWEAVE_RUN_ID"));
  assert.deepEqual(Object.keys(minimalHookEnv({ PATH: "/x", GH_TOKEN: "t", HOME: "/h" }, "linux")).sort(), ["HOME", "PATH"]);
  assert.equal(minimalHookEnv({ path: "C:\\x", SYSTEMROOT: "C:\\Windows", TOKEN: "t" }, "win32").path, "C:\\x", "win32 keeps the original key case");
});

test("an oversized payload is replaced by a truncation marker", () => {
  const text = hookPayload("tool.after", { blob: "x".repeat(400_000) }, { runId: "r", seq: 1 });
  assert.deepEqual(JSON.parse(text), { v: 1, event: "tool.after", runId: "r", seq: 1, truncated: true });
});

test("argv is passed literally: no shell interprets metacharacters", async () => {
  const log = newLog();
  const marker = join(base, `pwned${seq++}`);
  const nasty = [`; echo hi > ${marker}`, "$(whoami)", "a b", "&& calc", "`id`", "*"];
  const { results } = await run("tool.after", [hook("lit", "tool.after", "log", { log, extra: nasty })]);
  assert.equal(results[0].status, "ok");
  assert.deepEqual(readLog(log)[0].argv.slice(4), nasty);
  assert.equal(existsSync(marker), false);
});

test("argv[0] must be a bare command or an absolute path; a missing program is a failure", async () => {
  const relative = { id: "rel", event: "tool.before", kind: "validate", source: "user", timeoutMs: 1000, onFailure: "block", argv: ["./hook.sh"] };
  let out = await run("tool.before", [relative]);
  assert.equal(out.results[0].status, "error");
  assert.match(out.results[0].reason, /bare command name or an absolute path/);
  assert.equal(out.decision.reason, "HOOK_FAILED");
  const missing = { ...relative, id: "missing", argv: ["definitely-not-a-real-program-xyz"] };
  out = await run("tool.before", [missing]);
  assert.equal(out.results[0].status, "error");
  assert.equal(out.decision.decision, "deny");
  out = await run("tool.before", [{ ...missing, onFailure: "ignore" }]);
  assert.equal(out.decision.decision, "allow");
  assert.equal(out.results[0].effect, "ignored");
});

test("timeouts: a validate hook with onFailure block denies (HOOK_FAILED); ignore and log hooks do not", async () => {
  let out = await run("tool.before", [sleeper("slow", "validate", { onFailure: "block" })]);
  assert.equal(out.results[0].status, "timeout");
  assert.equal(out.results[0].effect, "blocked");
  assert.equal(out.decision.decision, "deny");
  assert.equal(out.decision.reason, "HOOK_FAILED");
  assert.equal(out.decision.ruleId, "hook:slow");
  out = await run("tool.before", [sleeper("slow", "validate", { onFailure: "ignore" })]);
  assert.equal(out.results[0].status, "timeout");
  assert.equal(out.results[0].effect, "ignored");
  assert.equal(out.decision.decision, "allow");
  out = await run("tool.before", [sleeper("slow-log", "log", { onFailure: "block" })]);
  assert.equal(out.results[0].status, "timeout");
  assert.equal(out.decision.decision, "allow", "log hooks never block");
});

test("failure policy: a failing validate hook blocks or is ignored; exit 2 is an explicit veto", async () => {
  const log = newLog();
  let out = await run("tool.before", [hook("fails", "tool.before", "validate", { log, code: 1, onFailure: "block" })]);
  assert.equal(out.results[0].status, "failed");
  assert.equal(out.decision.reason, "HOOK_FAILED");
  out = await run("tool.before", [hook("fails", "tool.before", "validate", { log, code: 1, onFailure: "ignore" })]);
  assert.equal(out.decision.decision, "allow");
  assert.equal(out.results[0].effect, "ignored");
  // Exit 2 vetoes whatever the failure policy says.
  out = await run("tool.before", [hook("veto", "tool.before", "validate", { log, code: 2, onFailure: "ignore" })]);
  assert.equal(out.results[0].status, "blocked");
  assert.equal(out.decision.reason, "HOOK_BLOCKED");
  assert.equal(out.decision.decision, "deny");
  // Log hooks record failures and vetoes but never change the decision.
  out = await run("tool.after", [hook("l1", "tool.after", "log", { log, code: 1 }), hook("l2", "tool.after", "log", { log, code: 2 })]);
  assert.equal(out.decision.decision, "allow");
  assert.deepEqual(out.results.map((item) => item.status), ["failed", "failed"]);
  assert.equal(out.results.every((item) => item.effect === "ignored"), true);
});

test("a validate hook can only tighten a decision, never approve", async () => {
  const log = newLog();
  const verdict = (decision, extra = {}) => hook(`v-${decision}`, "tool.before", "validate", { log, stdout: JSON.stringify({ decision, reason: "because" }), ...extra });
  const start = (decision) => makeDecision(decision, decision === "deny" ? "DESTRUCTIVE_COMMAND" : "DEFAULT_BRANCH_PUSH", "rule", { message: "earlier" });

  // allow -> deny / require-approval
  let out = await run("tool.before", [verdict("deny")]);
  assert.deepEqual([out.decision.decision, out.decision.reason], ["deny", "HOOK_BLOCKED"]);
  assert.match(out.decision.detail.message, /because/);
  out = await run("tool.before", [verdict("require-approval")]);
  assert.deepEqual([out.decision.decision, out.decision.reason], ["require-approval", "HOOK_BLOCKED"]);
  out = await run("tool.before", [verdict("ask")]);
  assert.equal(out.decision.decision, "require-approval");
  // An "allow" verdict changes nothing, in particular it cannot lift an earlier require-approval.
  out = await run("tool.before", [verdict("allow")], { decision: start("require-approval") });
  assert.equal(out.decision.decision, "require-approval");
  assert.equal(out.decision.reason, "DEFAULT_BRANCH_PUSH");
  out = await run("tool.before", [hook("quiet", "tool.before", "validate", { log })], { decision: start("require-approval") });
  assert.equal(out.decision.decision, "require-approval", "exit 0 does not approve either");
  // require-approval -> deny tightens further.
  out = await run("tool.before", [verdict("deny")], { decision: start("require-approval") });
  assert.equal(out.decision.decision, "deny");
  // Once blocking, validate hooks do not run any more; log hooks still observe.
  const gated = newLog();
  out = await run("tool.before", [hook("val", "tool.before", "validate", { log: gated }), hook("obs", "tool.before", "log", { log: gated })], { decision: start("deny") });
  assert.equal(out.decision.reason, "DESTRUCTIVE_COMMAND");
  assert.deepEqual(out.results.map((item) => item.status), ["skipped", "ok"]);
  assert.deepEqual(readLog(gated).map((item) => item.tag), ["obs"]);
  // After the first deny the rest of the validate hooks are skipped.
  const chain = newLog();
  out = await run("tool.before", [verdict("deny", { log: chain }), hook("later", "tool.before", "validate", { log: chain })]);
  assert.deepEqual(out.results.map((item) => item.status), ["blocked", "skipped"]);
  assert.deepEqual(readLog(chain).map((item) => item.tag), ["v-deny"]);
  // Verdicts from log hooks are ignored.
  out = await run("tool.after", [hook("logv", "tool.after", "log", { log, stdout: JSON.stringify({ decision: "deny" }) })]);
  assert.equal(out.decision.decision, "allow");
});

test("verdict parsing: plain text is logged only; malformed or unknown verdicts are failures", async () => {
  const log = newLog();
  let out = await run("tool.before", [hook("text", "tool.before", "validate", { log, stdout: "all good\n" })]);
  assert.equal(out.decision.decision, "allow");
  assert.equal(out.results[0].stdout, "all good\n");
  out = await run("tool.before", [hook("junk", "tool.before", "validate", { log, stdout: "{oops" })]);
  assert.equal(out.results[0].status, "failed");
  assert.equal(out.decision.reason, "HOOK_FAILED");
  out = await run("tool.before", [hook("unknown", "tool.before", "validate", { log, stdout: JSON.stringify({ decision: "maybe" }) })]);
  assert.equal(out.decision.reason, "HOOK_FAILED");
  out = await run("tool.before", [hook("junk-ok", "tool.before", "validate", { log, stdout: "{oops", onFailure: "ignore" })]);
  assert.equal(out.decision.decision, "allow");
});

test("repository hooks are authorized by the guard before they run; user hooks are not", async () => {
  const repo = realpathSync.native(mkdtempSync(join(base, "guarded-")));
  mkdirSync(join(repo, "scripts"));
  writeFileSync(join(repo, "scripts", "record.mjs"), readFileSync(recordScript()));
  // The guard is an allow-list: a repository hook (node ...) only runs when the USER's policy lists its exact argv prefix in allowCommands.
  const bare = { workspaceRoot: repo, cwd: repo, mode: "supervised", env: {}, userDir: join(base, "nouser"), homedir: () => base };
  const guardCtx = { ...bare, allowCommands: [[process.execPath, join(repo, "scripts", "record.mjs")]] };
  const log = join(repo, "log.jsonl");
  const ok = { ...hook("ok", "tool.before", "validate", { log, source: "repo" }), argv: [process.execPath, join(repo, "scripts", "record.mjs"), log, "ok"] };
  const secret = { ...hook("secret", "tool.before", "validate", { log, source: "repo" }), argv: [process.execPath, join(repo, "scripts", "record.mjs"), log, "secret", "0", "", ".env"] };
  const outside = { ...hook("outside", "tool.before", "validate", { log, source: "repo" }), argv: [process.execPath, recordScript(), log, "outside"] };
  const destructive = { ...hook("destructive", "tool.before", "validate", { log, source: "repo" }), argv: ["git", "reset", "--hard"] };

  let out = await runHooks("tool.before", {}, { hooks: [ok], env, cwd: repo, guardCtx, killGraceMs: 200 });
  assert.equal(out.results[0].status, "ok");
  assert.equal(out.decision.decision, "allow");
  out = await runHooks("tool.before", {}, { hooks: [ok], env, cwd: repo, guardCtx: bare, killGraceMs: 200 });
  assert.equal(out.results[0].status, "denied", "without allowCommands the repository hook is not an understood form");
  for (const denied of [secret, outside, destructive]) {
    const before = readLog(log).length;
    out = await runHooks("tool.before", {}, { hooks: [denied], env, cwd: repo, guardCtx, killGraceMs: 200 });
    assert.equal(out.results[0].status, "denied", denied.id);
    assert.equal(out.decision.decision, "deny");
    assert.equal(readLog(log).length, before, `${denied.id} must not have run`);
  }
  // The same command as a USER hook runs: user hooks are the user's own configuration.
  const userLog = newLog();
  out = await runHooks("tool.before", {}, { hooks: [{ ...hook("user", "tool.before", "validate", { log: userLog, source: "user" }) }], env, cwd: repo, guardCtx, killGraceMs: 200 });
  assert.equal(out.results[0].status, "ok");
});
