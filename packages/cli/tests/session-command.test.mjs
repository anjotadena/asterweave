// `asterweave session ...` (handler called directly: the lead registers it), real git repo and real ledger in temp dirs.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { resolveRepo } from "../src/commands/run.mjs";
import { sessionCommand, sessionCommandMeta, sessionHelpText } from "../src/commands/session.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { repoSessionsDir, sessionDir } from "../src/runtime/sessions.mjs";
import { cleanupTemp, fakeTerminal, git, tempDir, waitFor } from "./repo-fixture.mjs";
import { deliveryGraph, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};
const envFor = (userDir) => {
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};

function world() {
  const userDir = tempDir("aw-sc-user-");
  const repo = tempDir("aw-sc-repo-");
  git(repo, "init", "-b", "main");
  writeFileSync(join(repo, "README.md"), "hello\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-m", "initial");
  const env = envFor(userDir);
  const call = async (args, { options = {}, cwd = repo, seams = {}, stdin, stdout, extra = {} } = {}) => {
    const out = stdout ?? sink();
    const err = sink();
    const ctx = { stdout: out, stderr: err, stdin: stdin ?? sink(), env, cwd, positionals: args, options, sessionSeams: seams, ...extra };
    let code;
    let error = null;
    try {
      code = await sessionCommand(ctx);
    } catch (e) {
      error = e;
      code = e.exitCode ?? 1;
    }
    const text = typeof out.text === "function" ? out.text() : "";
    return { code, out: text, error, json: () => JSON.parse(text) };
  };
  const makeRun = async (runId = "run-s1", goal = "ship it") => {
    const identity = await resolveRepo({ cwd: repo, env });
    const { dir } = createRunForGraph({ graph: deliveryGraph, goal, repo: { key: identity.key, realpath: identity.workspace }, runId, env });
    await runLoop({ dir, graph: deliveryGraph, executor: createFakeExecutor({ v: 1, steps: [{ node: "intake", action: wait(0) }] }), sleep: async () => {}, workspaceRoot: identity.workspace, guardOptions: { env, userDir } });
    return dir;
  };
  return { userDir, repo, env, call, makeRun };
}

test("meta: options are the union; help text documents every subcommand and the JSON shapes", () => {
  assert.deepEqual(sessionCommandMeta.options, ["json", "all", "yes", "title", "worktree", "run", "older-than", "image"]);
  for (const sub of ["list", "show", "search", "start", "resume", "fork", "archive", "clean", "transcript", "attach", "detach"]) assert.match(sessionHelpText, new RegExp(`\\n  ${sub} `));
  assert.match(sessionHelpText, /JSON \(stable\)/);
});

test("usage errors: unknown subcommand, a flag that does not belong, extra argument, bad ids", async () => {
  const w = world();
  assert.equal((await w.call([])).code, EXIT.USAGE);
  assert.equal((await w.call(["frobnicate"])).code, EXIT.USAGE);
  assert.equal((await w.call(["list"], { options: { title: "x" } })).code, EXIT.USAGE);
  assert.equal((await w.call(["list", "extra"])).code, EXIT.USAGE);
  assert.equal((await w.call(["show"])).code, EXIT.USAGE);
  assert.equal((await w.call(["show", "s_ab"])).code, EXIT.USAGE);
  const missing = await w.call(["show", "s_deadbeef"]);
  assert.equal(missing.error.code, "SESSION_NOT_FOUND");
  assert.equal((await w.call(["start"], { options: { worktree: true } })).code, EXIT.USAGE);
  assert.equal((await w.call(["clean"], { options: { "older-than": "abc" } })).code, EXIT.USAGE);
  assert.equal((await w.call(["search"])).code, EXIT.USAGE);
});

test("start, list, show, search, archive, fork: the lifecycle with stable JSON", async () => {
  const w = world();
  const empty = await w.call(["list"], { options: { json: true } });
  assert.deepEqual([empty.code, empty.json().sessions], [0, []]);

  const started = await w.call(["start"], { options: { json: true, title: "Fix the login bug" } });
  assert.equal(started.code, 0);
  const s = started.json().session;
  assert.deepEqual([s.schemaVersion, s.branch, s.title, s.runId, s.worktree, s.providerSessionId], [2, "main", "Fix the login bug", null, null, null]);
  assert.equal(started.json().worktree, null);
  assert.equal(s.workspace, (await resolveRepo({ cwd: w.repo, env: w.env })).workspace);

  const listed = (await w.call(["list"], { options: { json: true } })).json();
  assert.deepEqual(listed.sessions.map((x) => x.id), [s.id]);
  assert.deepEqual(Object.keys(listed.sessions[0]).sort(), ["archivedAt", "branch", "checkpoints", "createdAt", "id", "node", "parentSessionId", "runId", "status", "title", "updatedAt", "worktree"]);

  const shown = (await w.call(["show", s.id.slice(0, 8)], { options: { json: true } })).json();
  assert.equal(shown.session.id, s.id, "prefix");
  assert.equal(shown.ok, true);

  const found = (await w.call(["search", "LOGIN"], { options: { json: true } })).json();
  assert.deepEqual(found.results.map((x) => [x.id, x.matched]), [[s.id, ["title"]]]);
  assert.deepEqual((await w.call(["search", "nothing-like-it"], { options: { json: true } })).json().results, []);

  const forked = (await w.call(["fork", s.id], { options: { json: true } })).json();
  assert.equal(forked.parentSessionId, s.id);
  assert.equal(forked.session.parentSessionId, s.id);
  assert.equal(forked.session.title, "Fork of Fix the login bug");
  assert.equal(forked.session.providerSessionId, null);

  const archived = (await w.call(["archive", s.id], { options: { json: true } })).json();
  assert.deepEqual([archived.changed, archived.session.status], [true, "archived"]);
  assert.equal((await w.call(["archive", s.id], { options: { json: true } })).json().changed, false);
  assert.equal((await w.call(["list"], { options: { json: true } })).json().sessions.length, 1, "archived hidden by default");
  assert.equal((await w.call(["list"], { options: { json: true, all: true } })).json().sessions.length, 2);

  const text = await w.call(["list"], { options: { all: true } });
  assert.match(text.out, new RegExp(s.id));
  assert.match(text.out, /archived/);
});

test("text output neutralises terminal escapes in titles", async () => {
  const w = world();
  await w.call(["start"], { options: { title: "evil \u001b]0;pwn\u0007 \u001b[2Jtitle" } });
  const { out } = await w.call(["list"]);
  assert.doesNotMatch(out, /\u001b|\u0007/);
});

test("start --run links the newest run (or a named one), copies the goal; transcript summarises events without raw payloads", async () => {
  const w = world();
  await w.makeRun("run-s1", "ship the thing");
  const started = (await w.call(["start"], { options: { json: true, run: true } })).json().session;
  assert.deepEqual([started.runId, started.goal, started.node], ["run-s1", "ship the thing", "intake"]);
  assert.equal(started.title, "ship the thing");
  const named = (await w.call(["start"], { options: { json: true, run: "run-s1" } })).json().session;
  assert.equal(named.runId, "run-s1");
  assert.equal((await w.call(["start"], { options: { run: "no-such-run" } })).error.code, "RUN_NOT_FOUND");

  const t = (await w.call(["transcript", started.id], { options: { json: true } })).json();
  assert.equal(t.runId, "run-s1");
  assert.ok(t.total > 0 && t.shown === Math.min(t.total, 200));
  assert.ok(t.events.every((e) => typeof e.seq === "number" && typeof e.type === "string"));
  assert.equal(t.events[0].type, "run.created");
  assert.ok(!JSON.stringify(t).includes('"input"') && !JSON.stringify(t).includes('"output"'), "no raw tool payloads");
  assert.match((await w.call(["transcript", started.id])).out, /run\.created/);

  const noRun = (await w.call(["start"], { options: { json: true, title: "bare" } })).json().session;
  assert.equal((await w.call(["transcript", noRun.id])).error.code, "SESSION_NO_RUN");
  assert.equal((await w.call(["search", "ship"], { options: { json: true } })).json().results.length, 2, "goal is searchable");
});

test("start --worktree uses the worktree module through a seam; the session records it; a failing plan creates nothing", async () => {
  const w = world();
  const calls = [];
  const worktree = {
    planWorktree: async (input) => {
      calls.push(["plan", input.name, input.base]);
      return { path: join(w.userDir, "wt", input.name), branch: `asterweave/${input.name}`, base: "main" };
    },
    createWorktree: async (plan) => {
      calls.push(["create", plan.path]);
      return { ok: true, path: plan.path, branch: plan.branch, base: { ref: "HEAD", commit: "c0ffee".repeat(6) + "abcd" }, created: true };
    },
  };
  const body = (await w.call(["start"], { options: { json: true, worktree: "feat-a" }, seams: { worktree } })).json();
  assert.deepEqual(calls.map((c) => c[0]), ["plan", "create"]);
  assert.deepEqual(body.session.worktree, { path: join(w.userDir, "wt", "feat-a"), branch: "asterweave/feat-a", base: "c0ffee".repeat(6) + "abcd", created: true }, "the record uses what createWorktree returned");
  assert.equal(body.session.branch, "asterweave/feat-a");
  const seen = [];
  const spy = { planWorktree: async (input) => { seen.push(input); return worktree.planWorktree(input); }, createWorktree: async (plan, options) => { seen.push(options); return worktree.createWorktree(plan); } };
  const spawn = () => assert.fail("not used by the fake");
  const ac = new AbortController();
  await w.call(["start"], { options: { worktree: "feat-b" }, seams: { worktree: spy }, extra: { spawn, signal: ac.signal, platform: process.platform } });
  assert.equal(seen.length, 2, "both plan and create got the options");
  for (const given of seen) {
    assert.equal(given.env.ASTERWEAVE_CONFIG_DIR, w.userDir, "the worktree module gets the command's environment");
    assert.equal(given.spawn, spawn);
    assert.equal(given.signal, ac.signal);
    assert.equal(given.platform, process.platform);
  }
  const failing = { planWorktree: async () => { throw Object.assign(new Error("bad name"), { exitCode: 2 }); }, createWorktree: async () => assert.fail("must not create") };
  const failed = await w.call(["start"], { options: { worktree: "BAD" }, seams: { worktree: failing } });
  assert.equal(failed.code, 2);
  assert.equal((await w.call(["list"], { options: { json: true } })).json().sessions.length, 1, "no session for a failed worktree");
  const none = await w.call(["start"], { options: { worktree: "x" }, seams: { worktree: {} } });
  assert.equal(none.error.code, "WORKTREE_UNAVAILABLE");
});

test("resume: ready prints the plan and the next command; a changed branch or archived session exits 1 with remediation", async () => {
  const w = world();
  await w.makeRun();
  const s = (await w.call(["start"], { options: { json: true, run: true } })).json().session;
  const ready = await w.call(["resume", s.id], { options: { json: true } });
  assert.equal(ready.code, 0);
  assert.deepEqual([ready.json().ok, ready.json().plan.ok, ready.json().plan.problems, ready.json().nextCommand], [true, true, [], "asterweave run show run-s1"]);
  assert.equal(ready.json().plan.checks.repository, "ok");
  assert.equal(ready.json().plan.checks.branch, "ok");
  const types = readFileSync(join(sessionDir((await resolveRepo({ cwd: w.repo, env: w.env })).key, s.id, { userDir: w.userDir }), "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["created"], "resume is read-only: it records nothing");

  const text = await w.call(["resume", s.id]);
  assert.match(text.out, /ready/);
  assert.match(text.out, /asterweave run show run-s1/);
  assert.match(text.out, /does not start anything/);

  git(w.repo, "checkout", "-b", "other");
  const wrong = await w.call(["resume", s.id], { options: { json: true } });
  assert.equal(wrong.code, 1);
  assert.deepEqual([wrong.json().ok, wrong.json().plan.problems.map((p) => p.code), wrong.json().nextCommand], [false, ["BRANCH_MISMATCH"], null]);
  assert.ok(wrong.json().error.remediation);
  const wrongText = await w.call(["resume", s.id]);
  assert.equal(wrongText.code, 1);
  assert.match(wrongText.out, /NOT ready/);
  assert.equal(wrongText.error.code, "SESSION_NOT_RESUMABLE");
  assert.ok(wrongText.error.remediation);

  git(w.repo, "checkout", "main");
  await w.call(["archive", s.id]);
  assert.deepEqual((await w.call(["resume", s.id], { options: { json: true } })).json().plan.problems.map((p) => p.code), ["SESSION_ARCHIVED"]);
});

test("clean: preview by default; non-interactive without --yes exits 2 and deletes nothing; --yes deletes only archived", async () => {
  const w = world();
  const a = (await w.call(["start"], { options: { json: true, title: "keep" } })).json().session;
  const b = (await w.call(["start"], { options: { json: true, title: "drop" } })).json().session;
  const base = { userDir: w.userDir };
  const key = (await resolveRepo({ cwd: w.repo, env: w.env })).key;
  assert.deepEqual((await w.call(["clean"], { options: { json: true } })).json().plan.items, [], "nothing archived yet");
  assert.equal((await w.call(["clean"])).out.trim(), "No archived sessions to clean.");
  await w.call(["archive", b.id]);

  const refused = await w.call(["clean"], { options: { json: true } });
  assert.equal(refused.code, EXIT.USAGE);
  const doc = refused.json();
  assert.deepEqual([doc.ok, doc.applied, doc.error.message, doc.plan.items.map((i) => i.id), "dir" in doc.plan.items[0]], [false, false, "Pass --yes to delete.", [b.id], false]);
  const refusedText = await w.call(["clean"]);
  assert.equal(refusedText.code, EXIT.USAGE);
  assert.match(refusedText.out, /Pass --yes to delete/);
  assert.equal(existsSync(sessionDir(key, b.id, base)), true);

  const done = await w.call(["clean"], { options: { json: true, yes: true } });
  assert.equal(done.code, 0);
  assert.deepEqual([done.json().applied, done.json().removed.map((r) => r.id), done.json().skipped], [true, [b.id], []]);
  assert.equal(existsSync(sessionDir(key, b.id, base)), false);
  assert.equal(existsSync(sessionDir(key, a.id, base)), true);
  assert.equal(existsSync(w.repo), true, "workspace untouched");
});

test("clean: --older-than filters by age; a session with an uninspectable worktree is kept with a reason", async () => {
  const w = world();
  const s = (await w.call(["start"], { options: { json: true } })).json().session;
  await w.call(["archive", s.id]);
  assert.deepEqual((await w.call(["clean"], { options: { json: true, "older-than": "30" } })).json().plan.items, [], "archived just now");
  assert.equal((await w.call(["clean"], { options: { json: true, "older-than": "0", yes: true } })).json().removed.length, 1);
  const worktree = { planWorktree: async () => ({ path: join(w.userDir, "wt"), branch: "b", base: "main" }), createWorktree: async () => {} };
  const t = (await w.call(["start"], { options: { json: true, worktree: "wt" }, seams: { worktree } })).json().session;
  await w.call(["archive", t.id]);
  const kept = (await w.call(["clean"], { options: { json: true, yes: true }, seams: { worktree: {} } })).json();
  assert.deepEqual(kept.removed, []);
  assert.equal(kept.skipped[0].reason, "its worktree state is unknown");
  const gone = (await w.call(["clean"], { options: { json: true, yes: true }, seams: { inspectWorktree: async () => ({ exists: false }) } })).json();
  assert.equal(gone.removed.length, 1);
});

test("clean on a terminal asks y/N: n keeps everything, y deletes", async () => {
  for (const [key, removed] of [["n", false], ["y", true]]) {
    const w = world();
    const s = (await w.call(["start"], { options: { json: true } })).json().session;
    await w.call(["archive", s.id]);
    const terminal = fakeTerminal({ tty: true });
    const pending = w.call(["clean"], { stdin: terminal.stdin, stdout: terminal.stdout });
    await waitFor(() => terminal.text().includes("Delete them?"), { label: "the y/N prompt" });
    terminal.stdin.write(key);
    const result = await pending;
    assert.equal(result.code, 0, result.error?.message);
    const base = { userDir: w.userDir };
    assert.equal(!existsSync(sessionDir((await resolveRepo({ cwd: w.repo, env: w.env })).key, s.id, base)), removed, key);
    assert.match(terminal.text(), /Delete them\?/);
  }
});

test("a session written by a newer asterweave: show and list report it (exit 1 / listed as a problem), file untouched", async () => {
  const w = world();
  const s = (await w.call(["start"], { options: { json: true } })).json().session;
  const file = join(sessionDir((await resolveRepo({ cwd: w.repo, env: w.env })).key, s.id, { userDir: w.userDir }), "session.json");
  const future = JSON.stringify({ schemaVersion: 9, id: s.id, repoKey: "x" });
  writeFileSync(file, future);
  const shown = await w.call(["show", s.id], { options: { json: true } });
  assert.equal(shown.code, 1);
  assert.match(shown.error.message, /newer asterweave/);
  const listed = await w.call(["list"], { options: { json: true } });
  assert.deepEqual([listed.code, listed.json().problems.map((p) => p.error)], [0, ["SESSION_SCHEMA_TOO_NEW"]]);
  assert.equal(readFileSync(file, "utf8"), future);
});

const dirState = (root) => {
  const out = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[full.slice(root.length)] = readFileSync(full).toString("base64");
    }
  };
  walk(root);
  return out;
};

test("list, show, search, resume and transcript are strictly read-only on a v1 record and on a corrupt snapshot; the next write command repairs", async () => {
  const w = world();
  const key = (await resolveRepo({ cwd: w.repo, env: w.env })).key;
  const base = repoSessionsDir(key, { userDir: w.userDir });
  const v1 = "s_0123456789abcdef";
  mkdirSync(join(base, v1), { recursive: true });
  writeFileSync(join(base, v1, "session.json"), `${JSON.stringify({ id: v1, repoKey: key, workspace: w.repo, createdAt: "2026-01-02T03:04:05.000Z", runId: null })}
`);
  const good = (await w.call(["start"], { options: { json: true, title: "Damaged one" } })).json().session;
  const bad = join(base, good.id, "session.json");
  writeFileSync(bad, '{"schemaVersion": 2, "id": ');

  const before = dirState(w.userDir);
  const listed = await w.call(["list"], { options: { json: true, all: true } });
  assert.deepEqual(listed.json().sessions.map((x) => x.id).sort(), [v1, good.id].sort(), "both are shown, as they would be repaired");
  assert.equal((await w.call(["show", v1], { options: { json: true } })).json().session.schemaVersion, 2);
  assert.equal((await w.call(["show", good.id], { options: { json: true } })).json().session.title, "Damaged one");
  assert.equal((await w.call(["search", "damaged"], { options: { json: true } })).json().results.length, 1);
  assert.equal((await w.call(["resume", v1], { options: { json: true } })).code, 0);
  assert.equal((await w.call(["transcript", v1], { options: { json: true } })).error.code, "SESSION_NO_RUN");
  assert.deepEqual(dirState(w.userDir), before, "every file is byte-identical and no file was added");

  assert.equal((await w.call(["archive", v1], { options: { json: true } })).code, 0, "a write command migrates");
  assert.ok(existsSync(join(base, v1, "session.json.bak-v1")));
  assert.equal((await w.call(["fork", good.id], { options: { json: true } })).code, 0);
  assert.ok(readdirSync(join(base, good.id)).some((n) => n.startsWith("session.json.corrupt-")), "a write command quarantines");
});

test("start --worktree with the real worktree module writes only under the given user dir, never the real one", async () => {
  const w = world();
  const { resolveUserDir } = await import("../src/paths.mjs");
  const realUser = resolveUserDir({ env: process.env });
  const realWorktrees = join(realUser, "worktrees");
  const before = existsSync(realWorktrees) ? readdirSync(realWorktrees).sort() : null;
  const body = (await w.call(["start"], { options: { json: true, worktree: "real-one" } })).json();
  assert.equal(body.ok, true);
  assert.ok(body.session.worktree.path.startsWith(w.userDir), body.session.worktree.path);
  assert.match(body.session.worktree.base, /^[0-9a-f]{40}$/);
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  const after = existsSync(realWorktrees) ? readdirSync(realWorktrees).sort() : null;
  assert.deepEqual(after, before, "the real user directory was not touched");
  // The original resumes in its worktree; a fork of it resumes too (no branch expectation).
  const original = (await w.call(["resume", body.session.id], { options: { json: true } })).json();
  assert.equal(original.plan.ok, true);
  assert.equal(original.plan.cwd, body.session.worktree.path);
  const child = (await w.call(["fork", body.session.id], { options: { json: true } })).json().session;
  const resumed = (await w.call(["resume", child.id], { options: { json: true } })).json();
  assert.deepEqual([resumed.ok, resumed.plan.problems], [true, []]);
  assert.match((await w.call(["resume", body.session.id])).out, /Next:\n\s+cd /);
});
