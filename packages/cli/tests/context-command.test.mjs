// `asterweave context` (handler called directly: the lead registers it), against a real ledger in a temp user directory.
// The attachment store (Track I) is injected as a fake: these tests do not depend on it.

import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { collectAccounting, contextCommand, contextCommandMeta, contextHelpText, createSessionViews } from "../src/commands/context.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { CliError, EXIT } from "../src/exit-codes.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { pinRouting } from "../src/runtime/routing.mjs";
import { createSession, linkRun } from "../src/runtime/sessions.mjs";
import { deliveryGraph, wait } from "./loop-fixture.mjs";
import { cleanupTemp, git, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

let repo;
function repoDir() {
  if (repo) return repo;
  repo = tempDir("aw-cc-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  return repo;
}

const envFor = (userDir) => {
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

const waits = (count) => Array.from({ length: count }, () => ({ node: "intake", action: wait(0) }));
const HASH = "d".repeat(64);
const attachment = { id: "img_dddddddddddd", sha256: HASH, format: "png", mime: "image/png", bytes: 2048, width: 32, height: 16, name: "shot.png", metadataStripped: true };

/** A fake of runtime/attachments.mjs: records calls, never touches the disk. */
function fakeApi({ list = [attachment], add } = {}) {
  const calls = [];
  return {
    calls,
    listAttachments: (sessionId, opts) => { calls.push(["list", sessionId, Boolean(opts?.repoKey)]); return list; },
    addAttachment: add ?? ((sessionId, source, opts) => { calls.push(["add", sessionId, source, Boolean(opts?.repoKey)]); return { ok: true, attachment, problems: [] }; }),
  };
}

async function seed(userDir, { usage, runId = "run-c", budgets, policy, routing, withSession } = {}) {
  const env = envFor(userDir);
  if (policy) writeFileSync(join(userDir, "policy.json"), JSON.stringify(policy));
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: { key: identity.key, realpath: identity.workspace }, runId, routing, env });
  const executor = { ...createFakeExecutor({ v: 1, steps: waits(2) }), ...(usage ? { usage } : {}) };
  await runLoop({ dir, graph: deliveryGraph, executor, sleep: async () => {}, workspaceRoot: identity.workspace, budgets, guardOptions: { env, userDir } });
  let session = null;
  if (withSession) {
    session = createSession({ repoKey: identity.key, workspace: identity.workspace, title: withSession }, { env }).session;
    linkRun(identity.key, session.id, { runId, node: null }, { env });
  }
  return { env, identity, session };
}

async function call(env, positionals = [], options = {}, extra = {}) {
  const stdout = sink();
  const ctx = { stdout, stderr: sink(), stdin: sink(), env, cwd: repoDir(), positionals, options, ...extra };
  const code = await contextCommand(ctx);
  return { code, out: stdout.text() };
}

test("context meta and help: json and session only", () => {
  assert.deepEqual(contextCommandMeta.options, ["json", "session"]);
  assert.deepEqual(contextCommandMeta.boolean, ["json"]);
  assert.match(contextHelpText, /Usage: asterweave context/);
  assert.match(contextHelpText, /never 0/);
});

test("context --json: stable { ok, context } with the three numbers separate and unknown as null", async () => {
  const { env } = await seed(tempDir("aw-cc-user-"), { usage: () => ({ inputTokens: 100, outputTokens: 20, contextTokens: 640, model: "claude-sonnet-5-5" }) });
  const { code, out } = await call(env, [], { json: true }, { attachmentsApi: fakeApi() });
  assert.equal(code, EXIT.OK);
  const body = JSON.parse(out);
  assert.deepEqual(Object.keys(body), ["ok", "context"]);
  assert.equal(body.ok, true);
  const c = body.context;
  assert.equal(c.runId, "run-c");
  assert.equal(c.contextTokens.tokens, 640, "latest measured, not the sum");
  assert.equal(c.cumulative.inputTokens, 300, "summed over the three reports of the run");
  assert.equal(c.cumulative.outputTokens, 60);
  assert.equal(c.cumulative.cacheReadTokens, null);
  assert.equal(c.window.tokens, null);
  assert.equal(c.percentUsed, null);
  assert.equal(c.budget.tokens.used, 360);
  assert.equal(c.budget.tokens.remaining, null, "no token limit");
  assert.deepEqual(Object.keys(c.byModel), ["claude-sonnet-5-5"]);
  assert.equal(c.counters.cacheReadTokens, "unknown");
  for (const key of ["contextTokens", "window", "percentUsed", "cumulative", "counters", "budget", "byNode", "byModel", "attachments", "route", "policy"]) assert.ok(key in c, key);
});

test("context text: the three numbers, measured vs unknown; a run that reported nothing is unknown, not 0", async () => {
  const { env } = await seed(tempDir("aw-cc-user-"));
  const { out } = await call(env, [], {}, { attachmentsApi: fakeApi({ list: [] }) });
  assert.match(out, /1\. Context size[^\n]*\n  unknown/);
  assert.match(out, /input tokens\s+unknown/);
  assert.match(out, /total \(budget counter\)\s+unknown/);
  assert.doesNotMatch(out, /input tokens\s+0/);
  assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(out.replace(/\n/g, "")));
});

test("context: an exhausted token budget shows 0 remaining", async () => {
  const policy = { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["x"], tools: ["read"], operations: [], budgets: { tokens: 100 } } };
  const { env } = await seed(tempDir("aw-cc-user-"), { usage: () => ({ inputTokens: 80, outputTokens: 40 }), policy });
  const body = JSON.parse((await call(env, [], { json: true })).out);
  assert.equal(body.context.budget.tokens.limit, 100);
  assert.equal(body.context.budget.tokens.remaining, 0);
  assert.match((await call(env)).out, /EXHAUSTED/);
});

test("context --session: the session's run and staged attachments (hashes and sizes, no bytes)", async () => {
  const { env, session } = await seed(tempDir("aw-cc-user-"), { usage: () => ({ tokens: 10 }), withSession: "Fix login" });
  const api = fakeApi();
  const body = JSON.parse((await call(env, [], { json: true, session: session.id }, { attachmentsApi: api })).out);
  assert.equal(body.context.sessionId, session.id);
  assert.equal(body.context.title, "Fix login");
  assert.equal(body.context.runId, "run-c");
  assert.equal(body.context.attachments.count, 1);
  assert.equal(body.context.attachments.bytes, 2048);
  assert.equal(body.context.attachments.sentOn, "first-turn");
  assert.deepEqual(Object.keys(body.context.attachments.items[0]).sort(), ["bytes", "format", "height", "id", "name", "sentRunId", "sha256", "width"]);
  assert.deepEqual(api.calls[0], ["list", session.id, true], "the store is asked about that session");
  // Without --session the run is mapped back to its linked session.
  const implicit = JSON.parse((await call(env, [], { json: true }, { attachmentsApi: api })).out);
  assert.equal(implicit.context.sessionId, session.id);
});

test("context: no attachment store means unknown attachments, not zero", async () => {
  const { env, session } = await seed(tempDir("aw-cc-user-"), { withSession: "s" });
  const broken = { listAttachments: () => { throw new Error("boom"); } };
  const body = JSON.parse((await call(env, [], { json: true }, { attachmentsApi: broken })).out);
  assert.equal(body.context.sessionId, session.id);
  assert.equal(body.context.attachments.count, null);
  assert.match((await call(env, [], {}, { attachmentsApi: broken })).out, /Attachments: unknown/);
});

test("context: pinned route and drift", async () => {
  const { env } = await seed(tempDir("aw-cc-user-"), { routing: pinRouting({ default: "claude-opus-5-5", effort: "high", fallback: [], stages: {} }) });
  const body = JSON.parse((await call(env, [], { json: true })).out);
  assert.equal(body.context.route.model, "claude-opus-5-5");
  assert.equal(body.context.route.pinned, true);
  assert.equal(body.context.route.drifted, true, "the current configuration has no model.default");
  assert.match((await call(env)).out, /DRIFT/);
});

test("context: errors are clear and exit codes are the existing ones", async () => {
  const empty = envFor(tempDir("aw-cc-empty-"));
  await assert.rejects(call(empty), (error) => error instanceof CliError && error.code === "RUN_NOT_FOUND" && error.exitCode === EXIT.ERROR && Boolean(error.remediation));
  const { env } = await seed(tempDir("aw-cc-user-"), { runId: "run-named" });
  assert.equal(JSON.parse((await call(env, ["run-named"], { json: true })).out).context.runId, "run-named");
  await assert.rejects(call(env, ["nope"]), (error) => error.code === "RUN_NOT_FOUND" && error.exitCode === EXIT.ERROR);
  await assert.rejects(call(env, ["run-named", "extra"]), (error) => error.exitCode === EXIT.USAGE);
  await assert.rejects(call(env, ["run-named"], { session: "abc" }), (error) => error.exitCode === EXIT.USAGE);
  await assert.rejects(call(env, [], { session: true }), (error) => error.exitCode === EXIT.USAGE);
  await assert.rejects(call(env, [], { session: "zzzzzzzz" }), (error) => error instanceof CliError && error.exitCode !== EXIT.OK);
});

test("hostile session title is sanitised in text and JSON", async () => {
  const esc = String.fromCharCode(27);
  const { env, session } = await seed(tempDir("aw-cc-user-"), { withSession: `a${esc}[31mb${esc}]0;x\u0007c` });
  for (const options of [{}, { json: true }]) {
    const { out } = await call(env, [], { ...options, session: session.id });
    assert.equal(out.includes(esc), false);
    assert.equal(out.includes("\u0007"), false);
  }
});

test("collectAccounting without a run (TUI path) is a view of unknowns, not an error", async () => {
  const identity = await resolveRepo({ cwd: repoDir(), env: envFor(tempDir("aw-cc-none-")) });
  const { view, run } = await collectAccounting({ env: envFor(tempDir("aw-cc-none2-")), attachmentsApi: fakeApi() }, { repoKey: identity.key, requireRun: false });
  assert.equal(run, null);
  assert.equal(view.source, "none");
  assert.equal(view.contextTokens.tokens, null);
});

test("session views: context, usage, attachments, image; never throw; no repository is honest", async () => {
  const { env, identity, session } = await seed(tempDir("aw-cc-user-"), { usage: () => ({ inputTokens: 5, outputTokens: 6, contextTokens: 77 }), withSession: "views" });
  const api = fakeApi();
  const views = createSessionViews({ env, attachmentsApi: api }, { repoKey: identity.key });
  assert.match((await views.context()).join("\n"), /77 tokens at/);
  assert.match((await views.usage()).join("\n"), /Usage of run run-c[\s\S]*input 15 \(measured\), output 18 \(measured\)/);
  const attachments = (await views.attachments()).join("\n");
  assert.match(attachments, new RegExp(`Session ${session.id}: 1 staged`));
  assert.match(attachments, /sha256 dddddddddddd/);
  assert.equal(attachments.includes(HASH), false);
  const staged = (await views.image("C:/x/shot.png")).join("\n");
  assert.match(staged, /Staged on session/);
  assert.match(staged, /nothing was sent now/);
  assert.deepEqual(api.calls.find((call) => call[0] === "add"), ["add", session.id, "C:/x/shot.png", true]);
  const refused = createSessionViews({ env, attachmentsApi: fakeApi({ add: () => ({ ok: false, attachment: null, problems: ["not an image"] }) }) }, { repoKey: identity.key });
  assert.deepEqual((await refused.image("x")).slice(0, 2), ["Image not staged:", "  not an image"]);
  const throwing = createSessionViews({ env, attachmentsApi: fakeApi({ add: () => { throw new Error("disk\u0007"); } }) }, { repoKey: identity.key });
  assert.match((await throwing.image("x")).join("\n"), /Could not read this: disk/);
  const none = createSessionViews({ env }, { repoKey: null });
  for (const name of ["context", "usage", "attachments", "image"]) assert.match((await none[name]("x")).join(" "), /No repository identity/);
});

test("session views without a run or a session say so", async () => {
  const identity = await resolveRepo({ cwd: repoDir(), env: envFor(tempDir("aw-cc-x-")) });
  const env = envFor(tempDir("aw-cc-empty2-"));
  const views = createSessionViews({ env, attachmentsApi: fakeApi() }, { repoKey: identity.key });
  assert.match((await views.context()).join("\n"), /no run yet/);
  assert.match((await views.usage()).join("\n"), /no run yet/);
  assert.match((await views.attachments()).join("\n"), /no active session/i);
  assert.match((await views.image("x")).join("\n"), /no active session/i);
});

test("session views work without the attachment store", async () => {
  const { env, identity } = await seed(tempDir("aw-cc-user-"), { withSession: "nostore" });
  const views = createSessionViews({ env, attachmentsApi: { listAttachments: () => { throw new Error("x"); } } }, { repoKey: identity.key });
  assert.match((await views.attachments()).join("\n"), /attachment store is not available/);
  const absent = createSessionViews({ env, attachmentsApi: {} }, { repoKey: identity.key });
  assert.match((await absent.image("x")).join("\n"), /not available in this build/);
});

test("one session for /context, /attachments, /image and the command: the newest run's session, else the newest active one; always named", async () => {
  const { env, identity, session: owner } = await seed(tempDir("aw-cc-user-"), { usage: () => ({ tokens: 3 }), withSession: "run owner" });
  const newer = createSession({ repoKey: identity.key, workspace: identity.workspace, title: "newer, no run" }, { env, now: () => "2031-01-01T00:00:00.000Z" }).session;
  assert.notEqual(newer.id, owner.id);
  const sent = { ...attachment, sentRunId: "run-c" };
  const api = fakeApi({ list: [attachment, sent] });
  const views = createSessionViews({ env, attachmentsApi: api }, { repoKey: identity.key });
  const body = JSON.parse((await call(env, [], { json: true }, { attachmentsApi: api })).out).context;
  assert.equal(body.sessionId, owner.id, "the command uses the newest run's session, not the newest session");
  assert.deepEqual([body.attachments.count, body.attachments.staged, body.attachments.sent], [2, 1, 1]);
  assert.match((await views.context()).join("\n"), new RegExp(`run run-c \\(session ${owner.id}\\)`));
  const listed = (await views.attachments()).join("\n");
  assert.match(listed, new RegExp(`Session ${owner.id}: 1 staged image\\(s\\), 1 sent`));
  assert.match(listed, /asterweave run start --session <id>/);
  assert.match(listed, /sent by run-c/);
  const added = (await views.image("C:/x/a.png")).join("\n");
  assert.match(added, new RegExp(`Staged on session ${owner.id}`));
  assert.match(added, /nothing was sent now/);
  assert.match(added, /asterweave run start --session <id>/);
  assert.deepEqual(api.calls.filter((entry) => entry[0] === "add").map((entry) => entry[1]), [owner.id]);
  assert.ok(api.calls.filter((entry) => entry[0] === "list").every((entry) => entry[1] === owner.id), "the store is only ever asked about that session");
  // An explicit target wins over the default.
  const explicit = JSON.parse((await call(env, [], { json: true, session: newer.id }, { attachmentsApi: api })).out).context;
  assert.equal(explicit.sessionId, newer.id);
});

test("with no run at all the newest active session is used and named; with none, they say so", async () => {
  const userDir = tempDir("aw-cc-user-");
  const env = envFor(userDir);
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const api = fakeApi({ list: [] });
  const views = createSessionViews({ env, attachmentsApi: api }, { repoKey: identity.key });
  assert.match((await views.attachments()).join("\n"), /no active session/i);
  createSession({ repoKey: identity.key, workspace: identity.workspace, title: "old" }, { env, now: () => "2020-01-01T00:00:00.000Z" });
  const newest = createSession({ repoKey: identity.key, workspace: identity.workspace, title: "new" }, { env, now: () => "2029-01-01T00:00:00.000Z" }).session;
  assert.match((await views.attachments()).join("\n"), new RegExp(`Session ${newest.id}: 0 staged image`));
  assert.match((await views.context()).join("\n"), new RegExp(`session ${newest.id} \\(no run linked\\)`));
  assert.match((await views.image("x")).join("\n"), new RegExp(`Staged on session ${newest.id}`));
});

test("store problems render as message or text, sanitised", async () => {
  const { env, identity } = await seed(tempDir("aw-cc-user-"), { withSession: "p" });
  const esc = String.fromCharCode(27);
  const add = () => ({ ok: false, attachment: null, problems: [{ code: "X", message: `bad${esc}[31m image` }, "plain text", 42] });
  const views = createSessionViews({ env, attachmentsApi: fakeApi({ add }) }, { repoKey: identity.key });
  const lines = await views.image("x");
  assert.deepEqual(lines, ["Image not staged:", "  bad image", "  plain text", "  42"]);
});
