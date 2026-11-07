// Run ledger: round trip, ordering, crash recovery, torn tail, redaction, schema versions, listing.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import test, { after } from "node:test";
import { USER_FILES, runsDir } from "../src/paths.mjs";
import { RUN_SCHEMA_VERSION, appendEvent, createRun, isValidRunId, listRuns, loadRun, repairTail, repoDirName, runDir, runsRoot } from "../src/runtime/ledger.mjs";
import { acquireRunLock } from "../src/runtime/lock.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const REPO_KEY = process.platform === "win32" ? "c:\\work\\repo\\.git" : "/work/repo/.git";

function sandbox() {
  const userDir = tempDir("aw-ledger-");
  let tick = Date.UTC(2026, 0, 1);
  return { env: { ASTERWEAVE_CONFIG_DIR: userDir }, userDir, now: () => new Date((tick += 1000)).toISOString() };
}

function runFor(runId, extra = {}) {
  return {
    v: 1,
    runId,
    graph: { id: "delivery", version: 1, hash: "abc" },
    repo: { key: REPO_KEY, realpath: "/work/repo" },
    goal: "ship it",
    status: "active",
    currentNode: "intake",
    nodes: {},
    ...extra,
  };
}

const eventsOf = (dir) => join(dir, "events.jsonl");
const bytes = (file) => readFileSync(file);
const isPrefix = (before, after) => after.subarray(0, before.length).equals(before);

test("runsDir is <userDir>/runs on every platform, and USER_FILES stays a file-only list", () => {
  assert.equal(runsDir({ platform: "linux", env: { ASTERWEAVE_CONFIG_DIR: "/c" }, homedir: () => "/h" }), "/c/runs");
  assert.equal(runsDir({ platform: "win32", env: { ASTERWEAVE_CONFIG_DIR: "C:\\u\\asterweave" }, homedir: () => "C:\\h" }), "C:\\u\\asterweave\\runs");
  assert.equal(runsRoot({ platform: "darwin", env: {}, homedir: () => "/Users/a" }), "/Users/a/Library/Application Support/asterweave/runs");
  assert.equal("runs" in USER_FILES, false);
  assert.equal(Object.isFrozen(USER_FILES), true);
});

test("repo directory names are sha256-derived and safe on Windows and POSIX", () => {
  const hostile = ["C:\\Users\\Me\\repo\\.git", "/a/../../etc", "x:y*?<>|\"", "a b/c", "CON", "é\u0000"];
  const names = hostile.map(repoDirName);
  for (const name of names) assert.match(name, /^[0-9a-f]{32}$/);
  assert.equal(new Set(names).size, names.length);
  assert.equal(repoDirName("same"), repoDirName("same"));
  assert.throws(() => repoDirName(""), TypeError);
  // A real directory can be made for every one of them on this OS.
  const box = sandbox();
  hostile.forEach((key, index) => {
    const { dir } = createRun(key, runFor(`run-${index}`), box);
    assert.equal(nodeFs.statSync(dir).isDirectory(), true);
  });
});

test("run ids that could escape or collide with device names are refused", () => {
  for (const bad of ["", "..", "a/b", "a\\b", "-x", ".hidden", "x".repeat(65), "con", "NUL", "com1", "lpt9", "a b", null, 5]) {
    assert.equal(isValidRunId(bad), false, String(bad));
  }
  assert.equal(isValidRunId("run-20260101_abc"), true);
  assert.throws(() => runDir(REPO_KEY, "../evil", {}), (error) => error.code === "RUN_ID_INVALID" && error.exitCode === 2);
});

test("createRun / appendEvent / loadRun round trip", () => {
  const box = sandbox();
  const { dir, run } = createRun(REPO_KEY, runFor("run-1"), box);
  assert.equal(dir, runDir(REPO_KEY, "run-1", box));
  assert.equal(run.lastSeq, 1, "run.created is event 1");
  assert.ok(run.createdAt && run.updatedAt);

  const first = appendEvent(dir, { type: "node.entered", node: "intake", attempt: 1 }, { ...box, run: { ...run, currentNode: "intake", status: "active" } });
  const second = appendEvent(dir, { type: "tool.decision", decision: "allow", reason: "ok", ruleId: "R1" }, box);
  assert.deepEqual([first.seq, second.seq], [2, 3]);

  const loaded = loadRun(dir);
  assert.equal(loaded.run.lastSeq, 3);
  assert.deepEqual(loaded.events.map((e) => [e.seq, e.type]), [[1, "run.created"], [2, "node.entered"], [3, "tool.decision"]]);
  assert.equal(loaded.events[0].goal, "ship it");
  assert.equal(loaded.behind, 0);
  assert.deepEqual(loaded.pending, []);
  assert.equal(loaded.torn, false);
  assert.ok(loaded.events.every((e) => e.v === 1 && e.runId === "run-1"));
  assert.equal(JSON.parse(readFileSync(join(dir, "run.json"), "utf8")).lastSeq, 3);
});

test("seq is monotonic and a record cannot override seq, at, v or runId", () => {
  const box = sandbox();
  const { dir } = createRun(REPO_KEY, runFor("run-2"), box);
  const hostile = appendEvent(dir, { type: "evidence.recorded", seq: 999, at: "1999-01-01T00:00:00.000Z", v: 9, runId: "other", kind: "task" }, box);
  assert.equal(hostile.seq, 2);
  assert.notEqual(hostile.at, "1999-01-01T00:00:00.000Z");
  assert.equal(hostile.event.v, 1);
  assert.equal(hostile.event.runId, "run-2");
  const line = JSON.parse(readFileSync(eventsOf(dir), "utf8").trim().split("\n")[1]);
  assert.deepEqual([line.seq, line.v, line.runId, line.kind], [2, 1, "run-2", "task"]);
  for (let i = 0; i < 5; i += 1) appendEvent(dir, { type: "hook.result" }, box);
  assert.deepEqual(loadRun(dir).events.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  assert.throws(() => appendEvent(dir, { type: "Bad Type" }, box), TypeError);
  assert.throws(() => appendEvent(dir, {}, box), TypeError);
});

test("the event is written before the snapshot: a crash in between leaves a recoverable run (behind)", () => {
  const box = sandbox();
  const { dir, run } = createRun(REPO_KEY, runFor("run-3"), box);
  const crashing = {
    ...nodeFs,
    renameSync(from, to) {
      if (basename(String(to)) === "run.json") throw Object.assign(new Error("simulated crash"), { code: "EIO" }); // not retried by writeJsonAtomic
      return nodeFs.renameSync(from, to);
    },
  };
  assert.throws(() => appendEvent(dir, { type: "node.entered", node: "intake" }, { ...box, fs: crashing, run: { ...run, currentNode: "analyze" } }), (error) => error.code === "STORE_WRITE_FAILED");
  const loaded = loadRun(dir);
  assert.equal(loaded.run.lastSeq, 1, "snapshot still at the previous event");
  assert.equal(loaded.run.currentNode, "intake", "snapshot not advanced");
  assert.equal(loaded.behind, 1);
  assert.deepEqual(loaded.pending.map((e) => [e.seq, e.type]), [[2, "node.entered"]]);

  // Appending without folding is refused; folding and passing the run catches the snapshot up.
  assert.throws(() => appendEvent(dir, { type: "hook.result" }, box), (error) => error.code === "RUN_BEHIND");
  const folded = appendEvent(dir, { type: "node.completed", node: "intake" }, { ...box, run: { ...loaded.run, currentNode: "analyze" } });
  assert.equal(folded.seq, 3);
  const after = loadRun(dir);
  assert.equal(after.behind, 0);
  assert.equal(after.run.currentNode, "analyze");
});

test("a torn last line is ignored on read, refused on append, and cut off only by repairTail under the lock", () => {
  const box = sandbox();
  const { dir } = createRun(REPO_KEY, runFor("run-4"), box);
  appendEvent(dir, { type: "node.entered", node: "intake" }, box);
  const file = eventsOf(dir);
  const fragment = '{"v":1,"seq":3,"at":"2026-01-01T00:00:09.000Z","runId":"run-4","type":"node.comp';
  appendFileSync(file, fragment);
  const torn = bytes(file);

  const loaded = loadRun(dir);
  assert.equal(loaded.torn, true);
  assert.equal(loaded.tornBytes, Buffer.byteLength(fragment));
  assert.deepEqual(loaded.events.map((e) => e.seq), [1, 2], "partial line ignored");

  // Nothing may modify the file without the lock: every attempt refuses and leaves the bytes alone.
  assert.throws(() => appendEvent(dir, { type: "hook.result" }, box), (error) => error.code === "RUN_TAIL_TORN");
  assert.throws(() => repairTail(dir, {}), (error) => error.code === "RUN_LOCK_REQUIRED");
  assert.throws(() => repairTail(dir, { lockToken: "nope" }), (error) => error.code === "RUN_LOCK_REQUIRED");
  assert.deepEqual(bytes(file), torn);

  const lock = acquireRunLock(dir);
  try {
    assert.throws(() => repairTail(dir, { lockToken: `${lock.token}x` }), (error) => error.code === "RUN_LOCK_REQUIRED");
    assert.deepEqual(bytes(file), torn);
    const result = repairTail(dir, { lockToken: lock.token, now: box.now });
    assert.deepEqual([result.repaired, result.droppedBytes, result.seq], [true, Buffer.byteLength(fragment), 3]);
    assert.equal(repairTail(dir, { lockToken: lock.token }).repaired, false, "nothing left to repair");
  } finally {
    lock.release();
  }
  assert.ok(isPrefix(torn.subarray(0, torn.length - Buffer.byteLength(fragment)), bytes(file)), "complete lines untouched");
  const repaired = loadRun(dir);
  assert.equal(repaired.torn, false);
  assert.equal(repaired.behind, 0);
  const last = repaired.events.at(-1);
  assert.deepEqual([last.type, last.seq, last.reason, last.droppedBytes], ["ledger.repaired", 3, "torn-tail", Buffer.byteLength(fragment)]);
  assert.match(last.droppedSha256, /^[0-9a-f]{64}$/);
  assert.equal(appendEvent(dir, { type: "hook.result" }, box).seq, 4);
});

test("appendEvent can be required to hold the run lock", () => {
  const box = sandbox();
  const { dir } = createRun(REPO_KEY, runFor("run-5"), box);
  assert.throws(() => appendEvent(dir, { type: "hook.result" }, { ...box, lockToken: "none" }), (error) => error.code === "RUN_LOCK_REQUIRED");
  assert.equal(loadRun(dir).events.length, 1);
  const lock = acquireRunLock(dir);
  try {
    assert.equal(appendEvent(dir, { type: "hook.result" }, { ...box, lockToken: lock.token }).seq, 2);
  } finally {
    lock.release();
  }
});

test("secrets are redacted in events and snapshots before anything is written", () => {
  const box = sandbox();
  const secret = `ghp_${"A1b2C3d4E5".repeat(4)}`;
  const { dir, run } = createRun(REPO_KEY, runFor("run-6", { goal: `deploy with ${secret}` }), box);
  appendEvent(dir, { type: "tool.decision", reason: `curl -H "Authorization: Bearer ${secret}1234"`, nested: { list: [secret, { token: `password=${secret}` }] } }, { ...box, run: { ...run, note: secret } });
  for (const file of ["run.json", "events.jsonl"]) assert.ok(!readFileSync(join(dir, file), "utf8").includes(secret), `${file} holds no raw token`);
  const loaded = loadRun(dir);
  assert.match(loaded.run.goal, /ghp_…/);
  assert.match(loaded.events.at(-1).nested.list[0], /^ghp_…$/);
  assert.equal(loaded.run.note, "ghp_…");
});

test("a run.json with a higher schema version is refused untouched; an older one is accepted", () => {
  const box = sandbox();
  const { dir } = createRun(REPO_KEY, runFor("run-7"), box);
  assert.equal(loadRun(dir, { supportedVersion: RUN_SCHEMA_VERSION + 1 }).run.v, 1, "older than supported: accepted");

  const file = join(dir, "run.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...snapshot, v: RUN_SCHEMA_VERSION + 1 }));
  const before = [bytes(file), bytes(eventsOf(dir))];
  const tooNew = (error) => error.code === "RUN_SCHEMA_TOO_NEW" && error.exitCode === 5 && /newer/.test(error.message);
  assert.throws(() => loadRun(dir), tooNew);
  assert.throws(() => appendEvent(dir, { type: "hook.result" }, box), tooNew);
  assert.throws(() => repairTail(dir, { lockToken: "x" }), (error) => error.code === "RUN_LOCK_REQUIRED" || tooNew(error));
  assert.deepEqual(listRuns(REPO_KEY, box).map((r) => r.error), ["RUN_SCHEMA_TOO_NEW"]);
  assert.deepEqual([bytes(file), bytes(eventsOf(dir))], before);
  assert.throws(() => createRun(REPO_KEY, runFor("run-8", { v: RUN_SCHEMA_VERSION + 1 }), box), tooNew);
});

test("events.jsonl is never truncated or rewritten; an existing run id is not overwritten", () => {
  const box = sandbox();
  const { dir, run } = createRun(REPO_KEY, runFor("run-9"), box);
  const file = eventsOf(dir);
  let previous = bytes(file);
  const steps = [
    () => appendEvent(dir, { type: "node.entered", node: "intake" }, { ...box, run }),
    () => appendEvent(dir, { type: "evidence.recorded", kind: "task" }, box),
    () => loadRun(dir),
    () => listRuns(REPO_KEY, box),
    () => assert.throws(() => createRun(REPO_KEY, runFor("run-9", { goal: "overwrite" }), box), (error) => error.code === "RUN_EXISTS"),
    () => appendEvent(dir, { type: "run.paused" }, box),
  ];
  for (const step of steps) {
    step();
    const current = bytes(file);
    assert.ok(isPrefix(previous, current), "previous bytes are a prefix of the new contents");
    previous = current;
  }
  assert.equal(loadRun(dir).run.goal, "ship it");
  assert.equal(loadRun(dir).events.length, 4);
});

test("a log that disagrees with the snapshot is reported as corrupt, not guessed at", () => {
  const box = sandbox();
  const { dir } = createRun(REPO_KEY, runFor("run-10"), box);
  appendEvent(dir, { type: "hook.result" }, box);
  const file = eventsOf(dir);
  const text = readFileSync(file, "utf8");
  const lines = text.trim().split("\n");

  writeFileSync(file, `${lines[0]}\n`); // snapshot says 2, log has 1
  assert.throws(() => loadRun(dir), (error) => error.code === "RUN_LEDGER_CORRUPT");
  writeFileSync(file, `${lines[0]}\n${lines[1].replace('"seq":2', '"seq":5')}\n`);
  assert.throws(() => loadRun(dir), (error) => error.code === "RUN_LEDGER_CORRUPT");
  writeFileSync(file, `${lines[0]}\nnot json\n`);
  assert.throws(() => loadRun(dir), (error) => error.code === "RUN_LEDGER_CORRUPT");
  writeFileSync(file, `${lines[0]}\n${lines[1].replace('"run-10"', '"other"')}\n`);
  assert.throws(() => loadRun(dir), (error) => error.code === "RUN_LEDGER_CORRUPT");
  assert.throws(() => loadRun(join(dir, "missing")), (error) => error.code === "RUN_NOT_FOUND");
});

test("listRuns returns the repository's runs newest first and ignores strangers", () => {
  const box = sandbox();
  const stamps = { "run-a": "2026-01-02T00:00:00.000Z", "run-b": "2026-03-01T00:00:00.000Z", "run-c": "2026-02-01T00:00:00.000Z" };
  for (const [runId, createdAt] of Object.entries(stamps)) createRun(REPO_KEY, runFor(runId, { createdAt }), box);
  createRun(`${REPO_KEY}-other`, runFor("run-z", { createdAt: "2027-01-01T00:00:00.000Z" }), box);
  mkdirSync(join(runsRoot(box), repoDirName(REPO_KEY), "not a run id"), { recursive: true });
  writeFileSync(join(runsRoot(box), repoDirName(REPO_KEY), "stray.txt"), "x");
  mkdirSync(join(runsRoot(box), repoDirName(REPO_KEY), "run-empty"));

  const listed = listRuns(REPO_KEY, box);
  assert.deepEqual(listed.map((r) => r.runId), ["run-b", "run-c", "run-a", "run-empty"]);
  assert.equal(listed[0].status, "active");
  assert.equal(listed[0].goal, "ship it");
  assert.equal(listed[3].error, "RUN_NOT_FOUND", "unreadable runs are listed last, not fatal");
  assert.deepEqual(listRuns("no-such-repo", box), []);
});
