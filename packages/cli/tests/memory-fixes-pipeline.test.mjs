// Regression tests for the conversation-memory review fixes: clone anchors, origin failures, forget scrubbing checkpoints and
// titles, expiry filters, summary coverage, a locked store, missing node:sqlite, forgotten sessions and the deferred start.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { startMemory } from "../src/commands/run-runner.mjs";
import { readOriginStatus } from "../src/repo.mjs";
import { appendEvent } from "../src/runtime/memory/capture.mjs";
import { latestValidCheckpoint } from "../src/runtime/memory/checkpoints.mjs";
import { openMemory } from "../src/runtime/memory/db.mjs";
import { forgetEvents, forgetItem, forgetSession, FORGOTTEN_TITLE } from "../src/runtime/memory/forget.mjs";
import { compareAnchors, listAmbiguities, readCloneAnchor, resolveAmbiguity, resolveRepoIdentity } from "../src/runtime/memory/identity.mjs";
import { inspectItem, listItems } from "../src/runtime/memory/items.mjs";
import { createMemoryPipeline, sessionIdForRun } from "../src/runtime/memory/pipeline.mjs";
import { searchMemory } from "../src/runtime/memory/search.mjs";
import { cleanupAll, git, sink, tempDir, track, world } from "./memory-fixture.mjs";

after(cleanupAll);

const SETTINGS = { historyRetentionDays: 30, summaryRetentionDays: 30 };
const REMOTE = "https://github.com/acme/widgets.git";
const probeOf = () => ({ verifiable: true, branch: "main", head: "a".repeat(40), fingerprint: "fp1:aaaa", worktreeId: "wt_1", dirtyCount: 0 });
const bareRun = (runId = "r1") => ({ runId, goal: "g", status: "active", currentNode: "analyze", approvals: [], nodes: {} });
const turn = (text, extra = {}) => ({ ok: true, resultText: text, toolEvents: [], toolResults: 0, model: "m", ...extra });

async function pipe(w, extra = {}) {
  return createMemoryPipeline({
    settings: { ...SETTINGS, ...(extra.settings ?? {}) }, storeOptions: { userDir: w.userDir, now: w.now, ...(extra.storeOptions ?? {}) },
    repo: extra.repo ?? { cloneKey: "/clone/widgets", remote: REMOTE }, runId: extra.runId ?? "r1", goal: extra.goal ?? "Add caching to the registry lookup",
    run: extra.run ?? bareRun(extra.runId), workspace: "/clone/widgets", owner: w.owner, probe: async () => probeOf(), externalSessionId: extra.externalSessionId ?? null,
    model: "claude-sonnet-5-5", providerContextLost: false, onDegraded: extra.onDegraded, onNote: extra.onNote, deferStart: extra.deferStart, ...(extra.summarizer ? { summarizer: extra.summarizer } : {}),
  });
}

function commitRepo(dir, text) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "file.txt"), text);
  git(dir, "add", "file.txt");
  git(dir, "-c", "user.email=t@example.invalid", "-c", "user.name=t", "commit", "-m", text);
}

// --- 1. clone anchors ------------------------------------------------------------------------------------------------

test("sec-1: a no-remote repository replaced at the same path by one with a different root commit is ambiguous: no capture, no injection", async () => {
  const w = world();
  const dir = join(tempDir("aw-anchor-"), "repo");
  commitRepo(dir, "first repository");
  const first = await readCloneAnchor({ workspace: dir, git: true });
  assert.equal(first.ok, true);
  assert.match(first.anchor, /^git:[0-9a-f]{40}$/);
  const cloneKey = join(dir, ".git");
  const p1 = await pipe(w, { repo: { cloneKey, remote: null, anchor: first.anchor }, goal: "We decided to use Redis for the session cache." });
  await p1.onTurn({ node: "analyze", attempt: 1, result: turn("Noted the Redis plan.") });
  assert.equal(p1.status().degraded.length, 0);
  p1.close();

  commitRepo(dir, "an unrelated repository"); // rm -rf + git init + commit at the same path
  const second = await readCloneAnchor({ workspace: dir, git: true });
  assert.notEqual(second.anchor, first.anchor);
  const lines = [];
  const p2 = await pipe(w, { runId: "r2", repo: { cloneKey, remote: null, anchor: second.anchor }, goal: "Use Redis?", onDegraded: (line) => lines.push(line) });
  assert.match(p2.status().paused, /different history/);
  assert.equal(p2.context({ node: "analyze" }, { objective: "Redis session cache" }), null, "nothing injected");
  await p2.onTurn({ node: "analyze", attempt: 1, result: turn("captured?") });
  p2.close();
  assert.equal(w.mem.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sessionIdForRun("r2")).n, 0, "no capture");
  const open = listAmbiguities(w.mem, cloneKey);
  assert.equal(open.length, 1);
  assert.equal(open[0].kind, "history");
  assert.match(lines.join("\n"), /capture paused/);
  // resolving 'new' binds the clone to a fresh repository and its new anchor; the next run is not ambiguous
  const resolved = resolveAmbiguity(w.mem, cloneKey, "new");
  assert.equal(resolved.ok, true);
  assert.notEqual(resolved.repoId, resolved.previousRepoId);
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey, remote: null, anchor: second.anchor }).status, "ok");
});

test("sec-1: unborn clones take their first commit only while no memory is stored; folders outside git are anchored by inode/birth time", async () => {
  assert.equal(compareAnchors("git:aaa,bbb", "git:bbb,ccc"), "record", "a shared root is the same repository");
  assert.equal(compareAnchors("git:aaa", "git:ccc"), "mismatch");
  assert.equal(compareAnchors(null, "git:aaa"), "record", "a pre-anchor binding records its anchor");
  assert.equal(compareAnchors("git:aaa", undefined), "skip");
  const w = world();
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/clone/empty", remote: null, anchor: "unborn" }).status, "created");
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/clone/empty", remote: null, anchor: "git:aaa" }).status, "ok", "no memory yet: rebind silently");
  const used = resolveRepoIdentity(w.mem, { cloneKey: "/clone/used", remote: null, anchor: "unborn" });
  w.session({ identity: used });
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/clone/used", remote: null, anchor: "git:bbb" }).ambiguous, true, "memory stored: ambiguity");
  assert.equal(resolveRepoIdentity(w.mem, { cloneKey: "/clone/widgets", remote: REMOTE, anchor: "git:zzz" }).ambiguous, false, "a remote is the identity");

  const unborn = join(tempDir("aw-unborn-"), "repo");
  mkdirSync(unborn);
  git(unborn, "init", "-b", "main");
  assert.deepEqual(await readCloneAnchor({ workspace: unborn, git: true }), { ok: true, anchor: "unborn" });
  const folder = join(tempDir("aw-folder-"), "plain");
  mkdirSync(folder);
  const a = await readCloneAnchor({ workspace: folder, git: false });
  rmSync(folder, { recursive: true });
  writeFileSync(join(folder, "..", "spacer"), "x"); // take the old inode's slot elsewhere
  mkdirSync(folder);
  const b = await readCloneAnchor({ workspace: folder, git: false });
  assert.match(a.anchor, /^dir:/);
  assert.notEqual(a.anchor, b.anchor, "a recreated folder is a different anchor");
});

// --- 2. origin failures ----------------------------------------------------------------------------------------------

test("staff-M2: 'no origin' and 'git failed' are told apart; a failed read skips memory for the run and records no ambiguity", async () => {
  const dir = join(tempDir("aw-origin-"), "repo");
  commitRepo(dir, "no remote here");
  assert.deepEqual(await readOriginStatus(dir), { state: "none" });
  const notRepo = tempDir("aw-notrepo-");
  assert.equal((await readOriginStatus(notRepo)).state, "failed");

  const w = world({ cloneKey: "/clone/x" });
  const stderr = sink();
  const ctx = { env: { ...process.env, ASTERWEAVE_CONFIG_DIR: w.userDir }, userDir: w.userDir, now: w.now, options: {}, stderr };
  const memory = await startMemory(ctx, { readOriginStatus: async () => ({ state: "failed", reason: "index.lock exists" }) }, {
    repo: { key: "/clone/x", git: true, workspace: dir }, run: { ...bareRun("r-fail"), goal: "do it" }, workspace: dir, branch: "main", externalSessionId: null, providerContextLost: true,
  });
  assert.equal(memory.inert, true);
  assert.equal(memory.context({ node: "analyze" }, {}), null);
  memory.close();
  assert.match(stderr.text(), /git could not read the origin remote \(index\.lock exists\)/);
  assert.equal(w.mem.db.prepare("SELECT COUNT(*) AS n FROM repo_ambiguities").get().n, 0, "no false remote-changed ambiguity");
  assert.equal(w.mem.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sessionIdForRun("r-fail")).n, 0);
});

// --- 3, 4. forget ----------------------------------------------------------------------------------------------------

test("sec-5: forgetting an extracted item rewrites the checkpoints that carried it: a follow-on run's memory text no longer contains it", async () => {
  const w = world();
  const p1 = await pipe(w, { externalSessionId: "fs_1", goal: "We decided to use Postgres advisory locks for the job queue." });
  await p1.finish({ run: bareRun() });
  const sid1 = p1.sessionId;
  p1.close();
  assert.match(latestValidCheckpoint(w.mem, sid1).checkpoint.decisions, /advisory locks/);
  const followOn = async (runId) => {
    const p = await pipe(w, { runId, externalSessionId: "fs_1", goal: "Continue the work" });
    const text = p.context({ node: "analyze" }, { objective: "next step" }) ?? "";
    p.close();
    return text;
  };
  assert.match(await followOn("r2"), /advisory locks/, "control: injected before the forget");
  const item = listItems(w.mem, { viewer: w.owner, repoId: w.repoId }).find((entry) => /advisory locks/.test(entry.content));
  assert.ok(item);
  assert.equal(forgetItem(w.mem, { viewer: w.owner, itemId: item.id }).ok, true);
  const cp = latestValidCheckpoint(w.mem, sid1);
  assert.equal(cp.skipped.length, 0, "the rewritten checkpoint still matches its digest");
  assert.doesNotMatch(cp.checkpoint.decisions ?? "", /advisory locks/);
  assert.doesNotMatch(await followOn("r3"), /Decisions noted:[^]*advisory locks/);
});

test("sec-6: forgetting the goal event resets the session title shown by search and show", async () => {
  const w = world();
  const p = await pipe(w, { goal: "Rotate the zebracorn credentials" });
  await p.onTurn({ node: "analyze", attempt: 1, result: turn("Working on the rotation plan.") });
  p.close();
  assert.match(w.mem.db.prepare("SELECT title FROM sessions WHERE id = ?").get(p.sessionId).title, /zebracorn/);
  assert.equal(forgetEvents(w.mem, { viewer: w.owner, eventIds: ["r1:goal"] }).ok, true);
  assert.equal(w.mem.db.prepare("SELECT title FROM sessions WHERE id = ?").get(p.sessionId).title, FORGOTTEN_TITLE);
  const hits = searchMemory(w.mem, { viewer: w.owner, repoId: w.repoId, query: "rotation plan" });
  assert.ok(hits.events.length > 0);
  assert.ok(hits.events.every((event) => event.sessionTitle === FORGOTTEN_TITLE));
});

// --- 5. expiry -------------------------------------------------------------------------------------------------------

test("sec-11 / staff-L5: expired items are not copied into checkpoints and an expired chain neighbour is not shown by inspect", async () => {
  const w = world();
  const p = await pipe(w, { goal: "We decided to use Redis for the session cache." });
  const item = listItems(w.mem, { viewer: w.owner, repoId: w.repoId })[0];
  assert.ok(item);
  w.mem.db.prepare("UPDATE memory_items SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", item.id);
  p.onCommitted({ ...bareRun(), currentNode: "plan" }, []);
  assert.doesNotMatch(latestValidCheckpoint(w.mem, p.sessionId).checkpoint.decisions ?? "", /Redis/);
  p.close();

  // a second item replaced by the expired one: inspect names the neighbour without its text
  const columns = w.mem.db.prepare("PRAGMA table_info(memory_items)").all().map((column) => column.name).filter((name) => name !== "rid");
  const select = columns.map((name) => (name === "id" ? "'it_live_copy'" : name === "expires_at" ? "NULL" : name === "replaced_by" ? ":old" : name)).join(", ");
  w.mem.db.prepare(`INSERT INTO memory_items (${columns.join(", ")}) SELECT ${select} FROM memory_items WHERE id = :old`).run({ old: item.id });
  const inspected = inspectItem(w.mem, "it_live_copy", w.owner, { repoId: w.repoId });
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.replacedBy, { id: item.id, status: "unavailable" });
});

// --- 6. summary coverage ---------------------------------------------------------------------------------------------

test("staff-M2: a summary that read one page of a longer backlog covers only what it read", async () => {
  const w = world();
  const seen = [];
  const summarizer = { name: "stub", summarize: ({ events }) => { seen.push(events.length); return `summary of ${events.length}`; } };
  const p = await pipe(w, { summarizer, settings: { summaryMinNewEvents: 1, summaryDebounceMinutes: 0 } });
  for (let i = 0; i < 450; i += 1) appendEvent(w.mem, p.sessionId, { id: `bulk-${i}`, type: "message", role: "user", content: `line ${i}` }, SETTINGS, { viewer: w.owner });
  p.onCommitted(bareRun(), [{ type: "node.completed", node: "analyze" }]);
  await p.finish({ run: bareRun() });
  const last = Number(w.mem.db.prepare("SELECT last_seq FROM sessions WHERE id = ?").get(p.sessionId).last_seq);
  const cp = latestValidCheckpoint(w.mem, p.sessionId).checkpoint;
  p.close();
  assert.equal(seen[0], 400);
  assert.ok(cp.summaryCoveredSeq < last, `covered ${cp.summaryCoveredSeq} of ${last}: the unread tail stays uncovered`);
  assert.ok(cp.summaryCoveredSeq >= 400);
});

// --- 7. a locked store -----------------------------------------------------------------------------------------------

test("staff-M3: a store locked by another connection stops the pipeline after the first failure: prompt, one ledger record", async () => {
  const w = world();
  (await pipe(w, { runId: "r-seed" })).close(); // the clone is known
  const holder = track(openMemory({ userDir: w.userDir }));
  holder.db.exec("BEGIN IMMEDIATE");
  const lines = [];
  const started = Date.now();
  try {
    const p = await pipe(w, { runId: "r-locked", onDegraded: (line) => lines.push(line) });
    for (let i = 0; i < 30; i += 1) {
      await p.onTurn({ node: "analyze", attempt: 1, iteration: i, result: turn(`turn ${i}`, { toolEvents: [{ id: `t${i}`, name: "Read", inputSummary: "x" }], toolResults: 1 }) });
      p.onCommitted(bareRun("r-locked"), []);
    }
    await p.finish({ run: bareRun("r-locked") });
    const records = p.drainEvents();
    assert.equal(records.length, 1, stringifyRecords(records));
    assert.match(records[0].reason, /locked or failing/);
    assert.equal(p.inert, true);
    p.close();
  } finally {
    holder.db.exec("ROLLBACK");
  }
  assert.ok(Date.now() - started < 3000, `finished in ${Date.now() - started} ms`);
  assert.equal(lines.length, 1);
});
const stringifyRecords = (records) => records.map((record) => record.reason).join(" | ");

// --- 8, 9. unavailable store, forgotten session -----------------------------------------------------------------------

test("staff-L1: missing node:sqlite says how to fix it, once", async () => {
  const w = world();
  const lines = [];
  const p = await pipe(w, { storeOptions: { loadSqlite: () => { throw new Error("no sqlite"); } }, onDegraded: (line) => lines.push(line) });
  p.context({ node: "analyze" }, {});
  await p.onTurn({ node: "analyze", attempt: 1, result: turn("x") });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /degraded persistence/);
  assert.match(lines[0], /22\.13 or newer/);
  assert.match(lines[0], /asterweave memory capture off/);
});

test("staff-L3: a run whose memory session was forgotten goes inert quietly", async () => {
  const w = world();
  (await pipe(w)).close();
  assert.equal(forgetSession(w.mem, { viewer: w.owner, sessionId: sessionIdForRun("r1") }).ok, true);
  const lines = [];
  const p = await pipe(w, { onDegraded: (line) => lines.push(line) });
  await p.onTurn({ node: "analyze", attempt: 1, result: turn("after the forget") });
  assert.equal(p.inert, true);
  assert.equal(p.context({ node: "analyze" }, {}), null);
  assert.deepEqual([lines.length, p.status().degraded.length, p.drainEvents().length], [0, 0, 0]);
  p.close();
  assert.equal(w.mem.db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(sessionIdForRun("r1")).n, 0);
});

// --- 10, B. deferred start and the resume note ------------------------------------------------------------------------

test("staff-L4: with deferStart nothing is written and no note is said until the run (holding its lock) first uses memory", async () => {
  const w = world();
  const p0 = await pipe(w);
  await p0.finish({ run: bareRun() });
  p0.close();
  const versions = () => Number(w.mem.db.prepare("SELECT COUNT(*) AS n FROM checkpoints WHERE session_id = ?").get(sessionIdForRun("r1")).n);
  const before = versions();
  w.now.advance(3 * 86_400_000); // a cold resume: a note is due
  const notes = [];
  const lost = await pipe(w, { deferStart: true, onNote: (note) => notes.push(note) });
  assert.ok(lost.toolResultExcerptChars > 0, "the executor still sees the excerpt option at construction");
  lost.close(); // the loop threw RUN_LOCKED: the pipeline was never used
  assert.deepEqual([versions(), notes.length], [before, 0], "a lost lock writes nothing and says nothing");
  const won = await pipe(w, { deferStart: true, onNote: (note) => notes.push(note) });
  const section = won.context({ node: "analyze" }, { objective: "continue" });
  assert.ok(versions() > before);
  assert.equal(notes.length, 1);
  // B: a failed first turn (the executor falls back to another model and rebuilds the section) keeps the note
  await won.onTurn({ node: "analyze", attempt: 1, result: { ok: false, resultText: "", killed: true }, interrupted: true });
  assert.ok(won.resume.note, "kept after a failed turn");
  assert.ok(won.context({ node: "analyze" }, { objective: "continue" })?.includes(won.resume.note.slice(0, 40)) || section === null);
  await won.onTurn({ node: "analyze", attempt: 1, iteration: 1, result: turn("ok now") });
  assert.equal(won.resume.note, null, "said once: cleared after a turn that went through");
  won.close();
});
