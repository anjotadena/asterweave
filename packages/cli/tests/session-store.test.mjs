// Session store: layout, events-first durability, migration, corruption, locking (real files in temp dirs, no git, no network).

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, truncateSync, readdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { repoDirName } from "../src/runtime/ledger.mjs";
import {
  addCheckpoint, archiveSession, cleanTitle, createSession, forkSession, linkRun, listSessions, loadSession, markResumed, repoSessionsDir, resolveSessionId,
  searchSessions, sessionDir,
} from "../src/runtime/sessions.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const here = dirname(fileURLToPath(import.meta.url));
const REPO = "repo-key-one";
const ws = "/work/space";

function fixture() {
  const userDir = tempDir("aw-ss-");
  return { userDir, opts: { userDir }, base: repoSessionsDir(REPO, { userDir }) };
}
const make = (opts, extra = {}) => createSession({ repoKey: REPO, workspace: ws, branch: "main", title: "Fix login", ...extra }, opts).session;
const nodeFsLike = () => nodeFs;
const readLines = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

test("create: layout, v2 record, id shape, created event first, snapshot second", () => {
  const { opts, userDir } = fixture();
  const { session, dir } = createSession({ repoKey: REPO, workspace: ws, branch: "main", title: "  Fix\nlogin  " }, opts);
  assert.match(session.id, /^s_[0-9a-f]{16}$/);
  assert.equal(dir, join(userDir, "sessions", repoDirName(REPO), session.id));
  assert.equal(session.schemaVersion, 2);
  assert.equal(session.status, "active");
  assert.equal(session.title, "Fix login");
  assert.equal(session.providerSessionId, null);
  assert.equal(session.worktree, null);
  assert.deepEqual([session.checkpoints, session.approvals], [[], []]);
  assert.equal(session.usage.tokens, null, "unknown usage is null, never 0");
  const events = readLines(join(dir, "events.jsonl"));
  assert.deepEqual([events.length, events[0].type, events[0].seq, events[0].sessionId], [1, "created", 1, session.id]);
  assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).lastSeq, 1);
});

test("title is sanitised, redacted and clipped; secrets never reach disk", () => {
  const { opts } = fixture();
  const token = `ghp_${"a1B2".repeat(9)}`;
  const s = make(opts, { title: `\u001b]0;pwn\u0007 key ${token} ${"x".repeat(300)}` });
  assert.ok(s.title.length <= 120);
  assert.doesNotMatch(s.title, /\u001b/);
  const dir = sessionDir(REPO, s.id, opts);
  for (const file of ["session.json", "events.jsonl"]) assert.doesNotMatch(readFileSync(join(dir, file), "utf8"), /a1B2a1B2/);
  assert.equal(cleanTitle(undefined), "");
});

test("id resolution: exact, unique prefix (>= 6), too short, ambiguous, unknown", () => {
  const { opts, base } = fixture();
  const a = make(opts);
  assert.equal(resolveSessionId(REPO, a.id, opts), a.id);
  assert.equal(resolveSessionId(REPO, a.id.slice(0, 8), opts), a.id);
  assert.throws(() => resolveSessionId(REPO, "s_ab", opts), (e) => e.exitCode === 2);
  assert.throws(() => resolveSessionId(REPO, "s_zzzzzzzz", opts), (e) => e.code === "SESSION_NOT_FOUND");
  assert.throws(() => resolveSessionId(REPO, "../etc", opts), (e) => e.code === "SESSION_ID_INVALID");
  mkdirSync(join(base, "s_aaaaaaaaaaaaaaa1"));
  mkdirSync(join(base, "s_aaaaaaaaaaaaaaa2"));
  assert.throws(() => resolveSessionId(REPO, "s_aaaaaa", opts), (e) => e.code === "SESSION_AMBIGUOUS" && e.exitCode === 2);
});

test("list: newest first, status filter, limit; search is case-insensitive, literal and bounded", () => {
  const { opts } = fixture();
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString();
  const o = { ...opts, now };
  const a = make(o, { title: "Alpha Feature", branch: "feat/alpha", goal: "ship the Widget" });
  const b = make(o, { title: "Beta", runId: "run-XyZ-1" });
  const c = make(o, { title: "(a.*)" });
  archiveSession(REPO, b.id, o);
  assert.deepEqual(listSessions(REPO, o).sessions.map((s) => s.id), [c.id, b.id, a.id]);
  assert.deepEqual(listSessions(REPO, { ...o, status: "archived" }).sessions.map((s) => s.id), [b.id]);
  const limited = listSessions(REPO, { ...o, limit: 1 });
  assert.deepEqual([limited.sessions.length, limited.truncated], [1, true]);
  assert.deepEqual(searchSessions(REPO, "ALPHA", o).results.map((r) => r.id), [a.id]);
  assert.deepEqual(searchSessions(REPO, "feat/ALPHA", o).results[0].matched, ["branch"]);
  assert.deepEqual(searchSessions(REPO, "widget", o).results.map((r) => r.id), [a.id], "goal");
  assert.deepEqual(searchSessions(REPO, "xyz-1", o).results.map((r) => r.id), [b.id], "run id");
  assert.deepEqual(searchSessions(REPO, "(a.*)", o).results.map((r) => r.id), [c.id], "no regex: the text is literal");
  assert.equal(searchSessions(REPO, "a.*", o).results.length, 1, "'a.*' is not a pattern (matches only the literal text in the title)");
  assert.equal(searchSessions(REPO, "a", { ...o, limit: 2 }).results.length, 2);
  assert.throws(() => searchSessions(REPO, "   ", o), (e) => e.exitCode === 2);
});

test("other repositories are invisible", () => {
  const { opts } = fixture();
  make(opts);
  assert.equal(listSessions("some-other-repo", opts).sessions.length, 0);
});

test("archive is idempotent and records one event; resumed/checkpoint/run-linked events fold into the record", () => {
  const { opts } = fixture();
  const s = make(opts);
  const first = archiveSession(REPO, s.id, opts);
  assert.deepEqual([first.changed, first.session.status], [true, "archived"]);
  assert.ok(first.session.archivedAt);
  const again = archiveSession(REPO, s.id, opts);
  assert.equal(again.changed, false);
  const cp = addCheckpoint(REPO, s.id, { runId: "r1", node: "plan", seq: 4, note: "after plan" }, opts).session.checkpoints;
  assert.deepEqual([cp.length, cp[0].runId, cp[0].seq], [1, "r1", 4]);
  const linked = linkRun(REPO, s.id, { runId: "r1", node: "build", goal: "g" }, opts).session;
  assert.deepEqual([linked.runId, linked.node, linked.goal], ["r1", "build", "g"]);
  markResumed(REPO, s.id, opts);
  const types = readLines(join(sessionDir(REPO, s.id, opts), "events.jsonl")).map((e) => e.type);
  assert.deepEqual(types, ["created", "archived", "checkpoint", "run-linked", "resumed"]);
  assert.deepEqual(loadSession(REPO, s.id, opts).session, JSON.parse(readFileSync(join(sessionDir(REPO, s.id, opts), "session.json"), "utf8")));
});

test("fork: new id, parent link, checkpoints up to the last verified one, provider id not copied, parent gets a forked event", () => {
  const { opts } = fixture();
  const parent = make(opts, { title: "Parent" });
  for (const [seq, note] of [[2, "a"], [5, "b"], [9, "c"]]) addCheckpoint(REPO, parent.id, { runId: "r1", node: "n", seq, note }, opts);
  // Pretend the runner stored a provider session id (no API for it yet: write through a patch event).
  const dir = sessionDir(REPO, parent.id, opts);
  const snap = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  writeFileSync(join(dir, "session.json"), JSON.stringify({ ...snap, providerSessionId: "prov-1" }));
  const forked = forkSession(REPO, parent.id, { ...opts, verified: (cp) => cp.seq <= 5 });
  assert.notEqual(forked.session.id, parent.id);
  assert.equal(forked.session.parentSessionId, parent.id);
  assert.deepEqual(forked.session.checkpoints.map((c) => c.seq), [2, 5]);
  assert.equal(forked.session.providerSessionId, null);
  assert.equal(forked.session.runId, null);
  assert.equal(forked.session.title, "Fork of Parent");
  assert.equal(forked.session.status, "active");
  const parentEvents = readLines(join(dir, "events.jsonl"));
  assert.equal(parentEvents.at(-1).type, "forked");
  assert.equal(parentEvents.at(-1).childId, forked.session.id);
  assert.equal(readLines(join(sessionDir(REPO, forked.session.id, opts), "events.jsonl"))[0].fromCheckpoint.seq, 5);
  assert.equal(forkSession(REPO, parent.id, { ...opts, verified: () => false, title: "T" }).session.checkpoints.length, 0, "nothing verified: nothing copied");
});

test("durability: events past the snapshot are folded on load and persisted by the next write", () => {
  const { opts } = fixture();
  const s = make(opts);
  const dir = sessionDir(REPO, s.id, opts);
  const snapshot = readFileSync(join(dir, "session.json"), "utf8");
  archiveSession(REPO, s.id, opts);
  writeFileSync(join(dir, "session.json"), snapshot); // the snapshot write "never happened"
  const loaded = loadSession(REPO, s.id, opts);
  assert.equal(loaded.behind, 1);
  assert.equal(loaded.session.status, "archived");
  assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).status, "active", "a read does not rewrite");
  addCheckpoint(REPO, s.id, { runId: "r", node: "n", seq: 1 }, opts);
  const after = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  assert.deepEqual([after.status, after.lastSeq, after.checkpoints.length], ["archived", 3, 1]);
});

test("torn final event line: ignored on read, cut off under the lock before the next append", () => {
  const { opts } = fixture();
  const s = make(opts);
  const dir = sessionDir(REPO, s.id, opts);
  writeFileSync(join(dir, "events.jsonl"), '{"v":1,"seq":2,"type":"arch', { flag: "a" });
  const loaded = loadSession(REPO, s.id, opts);
  assert.equal(loaded.torn, true);
  archiveSession(REPO, s.id, opts);
  const events = readLines(join(dir, "events.jsonl"));
  assert.deepEqual(events.map((e) => [e.seq, e.type]), [[1, "created"], [2, "archived"]]);
});

test("snapshot lost (crash during create): rebuilt from the created event", () => {
  const { opts } = fixture();
  const s = make(opts, { title: "Lost snapshot" });
  const dir = sessionDir(REPO, s.id, opts);
  unlinkSync(join(dir, "session.json"));
  const loaded = loadSession(REPO, s.id, opts);
  assert.equal(loaded.session.title, "Lost snapshot");
  assert.match(loaded.notes.join(" "), /rebuilt/);
  assert.ok(existsSync(join(dir, "session.json")));
});

function v1Fixture(opts, id = "s_0123456789abcdef") {
  const dir = join(repoSessionsDir(REPO, opts), id);
  mkdirSync(dir, { recursive: true });
  const v1 = { id, repoKey: REPO, workspace: ws, createdAt: "2026-01-02T03:04:05.000Z", runId: "run-old" };
  writeFileSync(join(dir, "session.json"), `${JSON.stringify(v1)}\n`);
  return { dir, id, v1 };
}

test("migration v1 to v2: fields mapped, .bak-v1 kept once, migrated event, never destructive", () => {
  const { opts } = fixture();
  const { dir, id, v1 } = v1Fixture(opts);
  const original = readFileSync(join(dir, "session.json"), "utf8");
  const loaded = loadSession(REPO, id, opts);
  const s = loaded.session;
  assert.deepEqual([s.schemaVersion, s.id, s.repoKey, s.workspace, s.runId, s.createdAt, s.status, s.branch, s.worktree, s.parentSessionId], [2, id, REPO, ws, "run-old", v1.createdAt, "active", null, null, null]);
  assert.equal(readFileSync(join(dir, "session.json.bak-v1"), "utf8"), original, "backup is the untouched original");
  assert.equal(JSON.parse(readFileSync(join(dir, "session.json"), "utf8")).schemaVersion, 2);
  assert.equal(readLines(join(dir, "events.jsonl"))[0].type, "migrated");
  // Second load: nothing to migrate, backup unchanged, no second event.
  loadSession(REPO, id, opts);
  assert.equal(readFileSync(join(dir, "session.json.bak-v1"), "utf8"), original);
  assert.equal(readLines(join(dir, "events.jsonl")).length, 1);
  assert.equal(listSessions(REPO, opts).sessions[0].id, id);
});

test("migration with read-only access: strictly read-only load returns the migrated view and writes nothing", () => {
  const { opts } = fixture();
  const { dir, id } = v1Fixture(opts);
  const loaded = loadSession(REPO, id, { ...opts, repair: false });
  assert.equal(loaded.session.schemaVersion, 2);
  assert.deepEqual(readdirSync(dir), ["session.json"]);
});

test("a session written by a newer schema is a clear read-only error and is left untouched", () => {
  const { opts } = fixture();
  const s = make(opts);
  const file = join(sessionDir(REPO, s.id, opts), "session.json");
  const future = `${JSON.stringify({ schemaVersion: 3, id: s.id, repoKey: REPO })}\n`;
  writeFileSync(file, future);
  assert.throws(() => loadSession(REPO, s.id, opts), (e) => e.code === "SESSION_SCHEMA_TOO_NEW" && e.exitCode === 1 && /newer asterweave/.test(e.message));
  assert.throws(() => archiveSession(REPO, s.id, opts), (e) => e.code === "SESSION_SCHEMA_TOO_NEW");
  assert.equal(readFileSync(file, "utf8"), future);
  const listing = listSessions(REPO, opts);
  assert.equal(listing.problems[0].error, "SESSION_SCHEMA_TOO_NEW", "list reports it instead of crashing");
});

test("corrupt snapshot: quarantined to session.json.corrupt-<ts>, rebuilt from events when possible, list never crashes", () => {
  const { opts } = fixture();
  const good = make(opts, { title: "Survivor" });
  const bad = make(opts, { title: "Damaged" });
  const dir = sessionDir(REPO, bad.id, opts);
  writeFileSync(join(dir, "session.json"), '{"schemaVersion": 2, "id": ');
  const listing = listSessions(REPO, { ...opts, now: () => "2026-02-03T04:05:06.000Z" });
  assert.equal(listing.sessions.length, 2, "recovered from the log");
  const quarantined = readdirSync(dir).filter((n) => n.startsWith("session.json.corrupt-"));
  assert.equal(quarantined.length, 1);
  assert.doesNotMatch(quarantined[0], /[:]/, "usable as a file name on Windows");
  assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), '{"schemaVersion": 2, "id": ');
  assert.equal(loadSession(REPO, bad.id, opts).session.title, "Damaged");
  assert.ok(listing.sessions.some((s) => s.id === good.id));
  assert.equal(readLines(join(dir, "events.jsonl")).at(-1).type, "repaired");

  // No log to rebuild from: reported, quarantine file kept, listing still works.
  const orphan = join(repoSessionsDir(REPO, opts), "s_ffffffffffffffff");
  mkdirSync(orphan);
  writeFileSync(join(orphan, "session.json"), "not json at all");
  const again = listSessions(REPO, opts);
  assert.equal(again.sessions.length, 2);
  assert.equal(again.problems.length, 1);
  assert.equal(again.problems[0].error, "SESSION_CORRUPT");
  assert.equal(readFileSync(join(orphan, "session.json"), "utf8"), "not json at all", "left as it is");
});

test("stale lock takeover and live lock timeout", () => {
  const { opts } = fixture();
  const s = make(opts);
  const dir = sessionDir(REPO, s.id, opts);
  writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: 1, hostname: "elsewhere", token: "t", acquiredAt: "2000-01-01T00:00:00.000Z" }));
  const old = new Date(Date.now() - 10 * 60_000);
  utimesSync(join(dir, "run.lock"), old, old);
  assert.equal(archiveSession(REPO, s.id, opts).changed, true);
  writeFileSync(join(dir, "run.lock"), JSON.stringify({ pid: process.pid, hostname: "elsewhere", token: "t", acquiredAt: new Date().toISOString() }));
  assert.throws(() => addCheckpoint(REPO, s.id, { runId: "r", seq: 1 }, { ...opts, lockWaitMs: 60 }), (e) => e.code === "SESSION_LOCKED" && !/\.lock/.test(e.message));
});

function child(userDir, op, id, goFile) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [join(here, "session-store-child.mjs"), userDir, REPO, op, id, goFile], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.on("close", (code) => resolve({ code, out: out.trim() }));
  });
}

test("concurrency: simultaneous forks and archives from separate processes do not corrupt anything", async () => {
  const { opts, userDir } = fixture();
  const s = make(opts);
  const go = join(userDir, "go");
  const runs = [..."1234"].map(() => child(userDir, "fork", s.id, go)).concat([child(userDir, "archive", s.id, go), child(userDir, "archive", s.id, go)]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  writeFileSync(go, "go");
  const results = (await Promise.all(runs)).map((r) => JSON.parse(r.out));
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  const archives = results.filter((r) => r.changed !== null);
  assert.deepEqual(archives.map((r) => r.changed).sort(), [false, true], "exactly one archive did the work");
  const forks = results.filter((r) => r.changed === null).map((r) => r.id);
  assert.equal(new Set(forks).size, 4);
  const dir = sessionDir(REPO, s.id, opts);
  const events = readLines(join(dir, "events.jsonl"));
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6], "contiguous sequence, no lost or duplicated line");
  assert.equal(events.filter((e) => e.type === "forked").length, 4);
  const record = JSON.parse(readFileSync(join(dir, "session.json"), "utf8"));
  assert.deepEqual([record.status, record.lastSeq], ["archived", 6]);
  const listing = listSessions(REPO, opts);
  assert.equal(listing.problems.length, 0);
  assert.equal(listing.sessions.length, 5);
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("files over the size cap are never loaded: an oversize snapshot is rebuilt from the log in memory, an oversize log is a problem", () => {
  const { opts } = fixture();
  const a = make(opts, { title: "Big snapshot" });
  const b = make(opts, { title: "Big log" });
  const fileA = join(sessionDir(REPO, a.id, opts), "session.json");
  const fileB = join(sessionDir(REPO, b.id, opts), "events.jsonl");
  truncateSync(fileA, 9 * 1024 * 1024); // zero-filled, over the default 8 MiB cap
  truncateSync(fileB, 9 * 1024 * 1024);
  const real = nodeFsLike();
  let largest = 0;
  const spy = { ...real, readSync: (fd, buffer, ...rest) => { largest = Math.max(largest, buffer.length); return real.readSync(fd, buffer, ...rest); }, readFileSync: (f) => { assert.fail(`readFileSync(${f}) bypasses the cap`); } };
  const listing = listSessions(REPO, { ...opts, repair: false, fs: spy });
  assert.deepEqual(listing.sessions.map((s) => s.id), [a.id], "the snapshot is rebuilt from the (small) log");
  assert.deepEqual(listing.problems.map((p) => [p.id, p.error]), [[b.id, "SESSION_TOO_LARGE"]]);
  assert.ok(largest <= 8 * 1024 * 1024 + 1, "no buffer larger than the cap was allocated");
  assert.equal(real.statSync(fileA).size, 9 * 1024 * 1024, "a read-only listing leaves the file alone");
  assert.throws(() => archiveSession(REPO, b.id, opts), (e) => e.code === "SESSION_TOO_LARGE");
  // The cap is a seam too: a small cap makes an ordinary record over-cap.
  const c = make(opts, { title: "Ordinary" });
  assert.throws(() => loadSession(REPO, c.id, { ...opts, maxFileBytes: 64, repair: false }), (e) => e.code === "SESSION_TOO_LARGE");
});

test("fork of a worktree session: the worktree branch is not inherited as a resume expectation", () => {
  const { opts } = fixture();
  const parent = make(opts, { branch: "asterweave/w1", worktree: { path: "/wt/w1", branch: "asterweave/w1", base: "abc", created: true } });
  const child = forkSession(REPO, parent.id, opts).session;
  assert.deepEqual([child.branch, child.worktree], [null, null]);
  assert.equal(readLines(join(sessionDir(REPO, child.id, opts), "events.jsonl"))[0].forkedFromBranch, "asterweave/w1");
  const plain = forkSession(REPO, make(opts).id, opts).session;
  assert.equal(plain.branch, "main", "without a worktree the branch is inherited");
});

test("listing resolves the directory once, not once per session", () => {
  const { opts, base } = fixture();
  for (let i = 0; i < 6; i += 1) make(opts, { title: `s${i}` });
  const real = nodeFsLike();
  let listings = 0;
  const spy = { ...real, readdirSync: (dir, ...rest) => { if (String(dir) === base) listings += 1; return real.readdirSync(dir, ...rest); } };
  assert.equal(listSessions(REPO, { ...opts, fs: spy }).sessions.length, 6);
  assert.equal(listings, 1);
  listings = 0;
  assert.equal(searchSessions(REPO, "s", { ...opts, fs: spy }).results.length, 6);
  assert.equal(listings, 1);
});
