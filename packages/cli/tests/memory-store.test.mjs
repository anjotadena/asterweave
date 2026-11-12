// Memory store: database, migrations, capture, redaction, checkpoints.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { appendEvent, captureEvent, MESSAGE_MAX_CHARS, readEvents, TOOL_OUTPUT_MAX_CHARS } from "../src/runtime/memory/capture.mjs";
import { saveCheckpoint, latestCheckpoint } from "../src/runtime/memory/checkpoints.mjs";
import { MemoryError, memoryDbPath, openMemory, rollbackTo, schemaVersion, migrate } from "../src/runtime/memory/db.mjs";
import { redactForMemory } from "../src/runtime/memory/redact.mjs";
import { MIGRATIONS, SCHEMA_VERSION } from "../src/runtime/memory/schema.mjs";
import { openSession } from "../src/runtime/memory/sessions.mjs";
import { cleanupAll, DAY, makeClock, rawBytes, sink, T0, tempDir, track, world } from "./memory-fixture.mjs";

after(cleanupAll);

const tables = (mem) => mem.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all().map((r) => r.name);

test("a fresh database is migrated to the current schema, reopening is a no-op, and a newer schema is refused", () => {
  const w = world();
  assert.equal(schemaVersion(w.mem.db), SCHEMA_VERSION);
  for (const name of ["sessions", "events", "events_fts", "checkpoints", "memory_items", "tombstones", "retrieval_traces", "maintenance_progress", "repos", "repo_aliases", "repo_clones"]) assert.ok(tables(w.mem).includes(name), name);
  w.mem.close();
  const again = w.open();
  assert.equal(schemaVersion(again.db), SCHEMA_VERSION);
  again.db.exec("PRAGMA user_version = 99");
  again.close();
  assert.throws(() => w.open(), (error) => error instanceof MemoryError && error.code === "MEMORY_SCHEMA_NEWER");
});

test("every migration documents a down; rolling back removes the schema and migrating restores it", () => {
  for (const step of MIGRATIONS) assert.ok(step.up.length > 0 && step.down.length > 0 && Number.isInteger(step.version), step.name);
  const w = world();
  rollbackTo(w.mem.db, 0);
  assert.equal(schemaVersion(w.mem.db), 0);
  assert.ok(!tables(w.mem).includes("events"));
  migrate(w.mem.db);
  assert.ok(tables(w.mem).includes("events"));
});

test("a migration that fails halfway is rolled back entirely (user_version unchanged)", () => {
  const w = world();
  const bad = [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: "broken", up: "CREATE TABLE half (a); SELECT * FROM missing_table;", down: "DROP TABLE half;" }];
  assert.throws(() => migrate(w.mem.db, { migrations: bad }));
  assert.equal(schemaVersion(w.mem.db), SCHEMA_VERSION);
  assert.ok(!tables(w.mem).includes("half"));
});

test("the database lives under <userDir>/memory with restrictive modes where the platform honours them", { skip: process.platform === "win32" && "POSIX modes only" }, () => {
  const w = world();
  assert.equal(w.mem.path, memoryDbPath({ userDir: w.userDir }));
  assert.equal(statSync(w.mem.path).mode & 0o077, 0);
  assert.equal(statSync(join(w.userDir, "memory")).mode & 0o077, 0);
});

test("node:sqlite is loaded lazily: an unavailable SQLite is a typed error, capture degrades, and the CLI still runs", async () => {
  const userDir = tempDir("aw-mem-nosqlite-");
  const loadSqlite = () => {
    throw new Error("no sqlite here");
  };
  assert.throws(() => openMemory({ userDir, loadSqlite }), (error) => error instanceof MemoryError && error.code === "MEMORY_UNAVAILABLE" && /Node/.test(error.remediation));
  const result = captureEvent({ userDir, loadSqlite }, { owner: "u", repoId: "r_x" }, { id: "e1", type: "message", content: "hi" }, {});
  assert.deepEqual([result.ok, result.saved, result.degraded], [false, false, true]);
  const out = sink();
  assert.equal(await runCli(["help"], { stdout: out, stderr: sink(), env: {} }), 0);
  // importing the whole CLI must not load node:sqlite
  const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const child = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(`file:///${cli.replaceAll("\\", "/")}`)}).then(() => console.log(process.moduleLoadList.some((m) => /sqlite/i.test(m))))`], { encoding: "utf8" });
  assert.equal(child.stdout.trim(), "false", child.stderr);
});

test("capture is idempotent by event id and ordered per session", () => {
  const w = world();
  const s = w.session();
  const first = w.event(s.id, "first", { id: "a" });
  const dup = w.event(s.id, "first again, different text", { id: "a" });
  assert.deepEqual([first.seq, first.duplicate, dup.seq, dup.duplicate, dup.upgraded], [1, false, 1, true, false]);
  assert.equal(w.event(s.id, "second", { id: "b" }).seq, 2);
  const other = w.session({ id: "other" });
  assert.equal(w.event(other.id, "elsewhere", { id: "c" }).seq, 1, "each session has its own counter");
  assert.deepEqual(readEvents(w.mem, s.id).map((e) => [e.seq, e.content]), [[1, "first"], [2, "second"]], "a replay never changes a stored event");
  const conflict = appendEvent(w.mem, other.id, { id: "a", type: "message", content: "x" }, w.settings);
  assert.equal(conflict.reason, "id_conflict");
});

test("two connections writing one session get distinct, gap-free sequence numbers", () => {
  const w = world();
  const s = w.session();
  const second = w.open();
  for (let i = 0; i < 6; i += 1) assert.equal(appendEvent(i % 2 ? second : w.mem, s.id, { id: `e${i}`, type: "message", content: `m${i}` }, w.settings).seq, i + 1);
  second.close();
});

test("an interrupted stream is stored incomplete, and the finished version may upgrade it exactly once", () => {
  const w = world();
  const s = w.session();
  assert.equal(w.event(s.id, "partial answ", { id: "m", role: "assistant", interrupted: true }).status, "incomplete");
  const cut = w.event(s.id, "x", { id: "n", role: "assistant", complete: false });
  assert.equal(cut.status, "incomplete");
  const done = appendEvent(w.mem, s.id, { id: "m", type: "message", role: "assistant", content: "partial answer, finished" }, w.settings);
  assert.deepEqual([done.upgraded, done.status, done.seq], [true, "complete", 1]);
  const again = appendEvent(w.mem, s.id, { id: "m", type: "message", role: "assistant", content: "different" }, w.settings);
  assert.deepEqual([again.upgraded, again.duplicate], [false, true]);
  assert.equal(readEvents(w.mem, s.id)[0].content, "partial answer, finished");
  const regress = appendEvent(w.mem, s.id, { id: "m", type: "message", content: "cut again", interrupted: true }, w.settings);
  assert.equal(regress.upgraded, false);
});

test("hidden reasoning is never stored; only whitelisted fields are copied", () => {
  const w = world();
  const s = w.session();
  for (const type of ["thinking", "reasoning", "redacted_thinking", "chain_of_thought"]) {
    assert.deepEqual(appendEvent(w.mem, s.id, { id: type, type, content: "secret plan" }, w.settings), { ok: true, saved: false, status: "skipped", reason: "hidden_reasoning" });
  }
  w.event(s.id, "visible", { id: "v", thinking: "private chain of thought", reasoning: "also private" });
  assert.ok(!rawBytes(w.mem).includes("private chain of thought"));
  assert.equal(w.mem.db.prepare("SELECT COUNT(*) n FROM events").get().n, 1);
});

test("secrets are redacted BEFORE persistence: they never reach the database file", () => {
  const w = world();
  const s = w.session({ title: "deploy with ghp_abcdefghijklmnopqrstuvwxyz0123456789 token" });
  w.event(s.id, "use https://bob:hunter2secret@example.com/repo.git and password=correcthorsebattery and mail alice@example.org, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz", { id: "r1" });
  w.event(s.id, "Authorization: Bearer abc123def456ghi789jkl\nCookie: session=zzyyxxwwvvuuttss", { id: "r2" });
  const bytes = rawBytes(w.mem);
  for (const leaked of ["hunter2secret", "correcthorsebattery", "alice@example.org", "abcdefghijklmnopqrstuvwxyz0123456789", "sk-ant-api03-abcdefghij", "abc123def456ghi789jkl", "zzyyxxwwvvuuttss"]) assert.ok(!bytes.includes(leaked), leaked);
  const [row] = readEvents(w.mem, s.id);
  assert.match(row.content, /\[redacted\]/);
  assert.ok(redactForMemory("ya29.a0AfH6SMBabcdefghijklmnopqrstuv").count > 0);
});

test("redaction runs on the whole text, then truncation: a secret straddling the cut cannot leak a prefix", () => {
  const w = world();
  const s = w.session();
  const secret = `ghp_${"Q".repeat(40)}`;
  const content = `${"a ".repeat(Math.floor((TOOL_OUTPUT_MAX_CHARS - 8) / 2))}${secret} tail text`;
  const saved = w.event(s.id, content, { id: "t", type: "tool_result", role: "tool" });
  assert.equal(saved.truncated, true);
  const [row] = readEvents(w.mem, s.id);
  assert.equal(row.truncated, true);
  assert.ok(row.originalChars > TOOL_OUTPUT_MAX_CHARS - 100);
  assert.ok(row.content.length < TOOL_OUTPUT_MAX_CHARS + 100);
  assert.match(row.content, /\[truncated: \d+ more characters not stored\]$/);
  assert.ok(!rawBytes(w.mem).includes("QQQQ"));
  const long = w.event(s.id, "m".repeat(MESSAGE_MAX_CHARS + 500), { id: "long" });
  assert.equal(long.truncated, true);
});

test("a storage failure is reported as degraded and never as saved", () => {
  const w = world();
  const s = w.session();
  w.mem.db.close();
  const result = appendEvent(w.mem, s.id, { id: "x", type: "message", content: "lost" }, w.settings);
  assert.deepEqual([result.ok, result.saved, result.degraded, result.status], [false, false, true, "degraded"]);
  assert.equal(typeof result.message, "string");
});

test("memory.enabled=false stops capture without touching existing data", () => {
  const w = world();
  const s = w.session();
  w.event(s.id, "kept", { id: "k" });
  const off = { ...w.settings, enabled: false };
  assert.deepEqual(appendEvent(w.mem, s.id, { id: "n", type: "message", content: "new" }, off), { ok: true, saved: false, status: "disabled" });
  assert.deepEqual(openSession(w.mem, { owner: w.owner, identity: w.identity, id: "fresh" }, off), { ok: true, saved: false, status: "disabled" });
  assert.deepEqual(readEvents(w.mem, s.id).map((e) => e.content), ["kept"]);
  const result = captureEvent({ userDir: w.userDir, now: w.now }, { owner: w.owner, identity: w.identity }, { id: "z", type: "message", content: "x" }, off);
  assert.equal(result.status, "disabled");
});

test("expiry is fixed at write from the event time; a future event time buys no extra retention; already-expired events are not stored", () => {
  const w = world();
  const s = w.session();
  const past = w.event(s.id, "old", { id: "old", eventTime: new Date(Date.parse(T0) - 3 * DAY).toISOString() });
  assert.equal(past.expiresAt, new Date(Date.parse(T0) + 7 * DAY).toISOString());
  const future = w.event(s.id, "future", { id: "fut", eventTime: new Date(Date.parse(T0) + 400 * DAY).toISOString() });
  assert.equal(future.expiresAt, new Date(Date.parse(T0) + 10 * DAY).toISOString());
  const ancient = appendEvent(w.mem, s.id, { id: "anc", type: "message", content: "x", eventTime: new Date(Date.parse(T0) - 11 * DAY).toISOString() }, w.settings);
  assert.deepEqual([ancient.saved, ancient.status], [false, "expired"]);
  assert.equal(appendEvent(w.mem, s.id, { id: "bad", type: "message", content: "x", eventTime: "not a date" }, w.settings).reason, "time_invalid");
  assert.equal(appendEvent(w.mem, s.id, { id: "bad", type: "nope", content: "x" }, w.settings).reason, "type_invalid");
});

test("an archived session accepts no new events until unarchived", async () => {
  const { archiveSession, unarchiveSession } = await import("../src/runtime/memory/sessions.mjs");
  const w = world();
  const s = w.session();
  assert.equal(archiveSession(w.mem, s.id, w.owner).changed, true);
  assert.equal(appendEvent(w.mem, s.id, { id: "x", type: "message", content: "x" }, w.settings).reason, "session_archived");
  unarchiveSession(w.mem, s.id, w.owner);
  assert.equal(appendEvent(w.mem, s.id, { id: "x", type: "message", content: "x" }, w.settings).saved, true);
});

test("checkpoints: a stale writer cannot overwrite newer coverage; expiry follows the earliest covered event", () => {
  const w = world();
  const s = w.session();
  for (let i = 0; i < 4; i += 1) w.event(s.id, `step ${i}`, { id: `s${i}` });
  const v1 = saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 2, goal: "ship it with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", decisions: ["use sqlite", "no network"] }, w.settings);
  assert.deepEqual([v1.saved, v1.version], [true, 1]);
  const v2 = saveCheckpoint(w.mem, s.id, { expectedVersion: 1, coveredSeq: 4, nextAction: "write tests", sourceRefs: ["s0", "s1"] }, w.settings);
  assert.equal(v2.version, 2);
  const stale = saveCheckpoint(w.mem, s.id, { expectedVersion: 1, coveredSeq: 3, goal: "stale writer" }, w.settings);
  assert.deepEqual([stale.saved, stale.status, stale.currentVersion], [false, "stale_version", 2]);
  const behind = saveCheckpoint(w.mem, s.id, { expectedVersion: 2, coveredSeq: 1 }, w.settings);
  assert.deepEqual([behind.saved, behind.status], [false, "stale_coverage"]);
  assert.equal(saveCheckpoint(w.mem, s.id, { expectedVersion: 2, coveredSeq: 99 }, w.settings).reason, "coverage_invalid");
  const latest = latestCheckpoint(w.mem, s.id, w.owner);
  assert.deepEqual([latest.version, latest.coveredSeq, latest.nextAction, latest.sourceRefs], [2, 4, "write tests", ["s0", "s1"]]);
  assert.ok(!rawBytes(w.mem).includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.equal(latest.expiresAt, new Date(Date.parse(T0) + 10 * DAY).toISOString());
  assert.equal(latestCheckpoint(w.mem, s.id, "u_bob"), null, "private to its owner");
});

test("the fake clock helper drives now() in canonical ISO form", () => {
  const clock = makeClock("2026-01-01T00:00:00Z");
  clock.advance(1500);
  assert.equal(clock(), "2026-01-01T00:00:01.500Z");
  const userDir = tempDir("aw-mem-clock-");
  assert.equal(track(openMemory({ userDir, now: () => Date.parse("2026-02-03T04:05:06Z") })).now(), "2026-02-03T04:05:06.000Z");
});
