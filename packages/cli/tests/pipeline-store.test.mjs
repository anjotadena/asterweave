// Event-first pipeline store: layout, crash recovery, torn tail, caps, rotation, lock, schema version.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { EVENTS_FILE, EVENT_CAP_BYTES, READ_CAP_BYTES, ROTATED_FILE, STATE_FILE, loadPipeline, openPipelineSession, parseRepoSlug, pipelineDir, pipelinesRoot } from "../src/runtime/pipeline/store.mjs";
import { normalizePull, normalizeRun, planPoll } from "../src/runtime/pipeline/state.mjs";

const MERGE = "b".repeat(40);
const HEAD = "a".repeat(40);
const init = { repo: "o/r", host: "github.com", prNumber: 5 };
const T0 = Date.parse("2026-01-01T00:00:00Z");

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "aw-pipeline-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { env: { ASTERWEAVE_CONFIG_DIR: root } };
  const dir = pipelineDir("github.com", "o/r", 5, options);
  return { root, options, dir };
}
const pull = normalizePull({ number: 5, state: "closed", merged: true, merged_at: "2026-01-01T00:00:05Z", merge_commit_sha: MERGE, base: { ref: "main" }, head: { ref: "f", sha: HEAD } });
const run = (over = {}) => normalizeRun({ id: 1, run_attempt: 1, name: "CI", path: ".github/workflows/ci.yml", workflow_id: 7, status: "completed", conclusion: "success", event: "push", head_sha: MERGE, created_at: "2026-01-01T00:00:10Z", run_started_at: "2026-01-01T00:00:10Z", updated_at: "2026-01-01T00:01:00Z", ...over });
const pollEvent = (state, extra = {}) => planPoll(state, { pull, observations: [run()], ...extra }, { now: new Date(T0 + 120_000).toISOString() }).event;

test("layout: pipelines/<hash>/<owner-name>/pr-<n> under the user directory; repo slugs are strict", (t) => {
  const { root, options, dir } = fixture(t);
  assert.ok(dir.startsWith(pipelinesRoot(options)));
  assert.ok(pipelinesRoot(options).startsWith(root));
  assert.match(path.relative(pipelinesRoot(options), dir).split(path.sep).join("/"), /^[0-9a-f]{32}\/o-r\/pr-5$/);
  assert.equal(pipelineDir("github.com", "o/r", 5, options), dir, "stable");
  assert.notEqual(pipelineDir("ghe.example.com", "o/r", 5, options), dir, "the host is part of the identity");
  for (const bad of ["../x/y", "o/r/z", "o", "o/..", "-o/r", "o/r%2f", "o/ r", ""]) assert.equal(parseRepoSlug(bad), null, bad);
  assert.throws(() => pipelineDir("github.com", "o/..", 5, options), (error) => error.code === "PIPELINE_ARGS_INVALID" && error.exitCode === 2);
  assert.throws(() => pipelineDir("github.com", "o/r", 0, options), /Invalid/);
  assert.match(path.basename(path.dirname(pipelineDir("github.com", "o/r.", 5, options))), /^o-r_$/, "no trailing dot in a Windows directory name");
});

test("create, append, close; reload folds the same state; files and schema version", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  assert.equal(session.state.schemaVersion, 1);
  assert.equal(session.state.pr.state, "open");
  const state = session.append(pollEvent(session.state));
  assert.equal(state.pr.state, "merged");
  assert.equal(session.lastSeq, 2);
  session.close();
  const snapshot = JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8"));
  assert.equal(snapshot.lastSeq, 2);
  assert.equal(snapshot.schemaVersion, 1);
  const loaded = loadPipeline(dir);
  assert.equal(loaded.behind, 0);
  assert.deepEqual(loaded.state, state);
  assert.deepEqual(loaded.events.map((event) => event.type), ["init", "poll"]);
  assert.deepEqual(loaded.events.map((event) => event.seq), [1, 2]);
  assert.ok(!existsSync(path.join(dir, "run.lock")), "the lock is released on close");
});

test("event-first: an event without its snapshot is recovered by folding on read and rewritten on the next open", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  const event = pollEvent(session.state);
  session.close();
  appendFileSync(path.join(dir, EVENTS_FILE), `${JSON.stringify({ v: 1, seq: 2, at: event.at, ...event })}\n`);
  const view = loadPipeline(dir);
  assert.equal(view.behind, 1);
  assert.equal(view.state.pr.state, "merged");
  assert.equal(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")).lastSeq, 1, "reading never rewrites the snapshot");
  openPipelineSession(dir, init).close();
  assert.equal(JSON.parse(readFileSync(path.join(dir, STATE_FILE), "utf8")).lastSeq, 2);
});

test("torn tail: ignored on read, cut off under the lock, recorded as store.repaired; complete events are never touched", (t) => {
  const { dir } = fixture(t);
  const first = openPipelineSession(dir, init);
  first.append(pollEvent(first.state));
  first.close();
  const file = path.join(dir, EVENTS_FILE);
  const before = readFileSync(file);
  appendFileSync(file, '{"v":1,"seq":3,"type":"poll","at":"2026-01-01T');
  const view = loadPipeline(dir);
  assert.equal(view.torn, true);
  assert.equal(view.state.pr.state, "merged", "complete events still fold");
  assert.equal(view.events.length, 2);
  const session = openPipelineSession(dir, init);
  assert.equal(session.state.pr.state, "merged");
  const after = readFileSync(file);
  assert.deepEqual(after.subarray(0, before.length), before, "the complete lines are byte-identical");
  const events = loadPipeline(dir).events;
  assert.equal(events.at(-1).type, "store.repaired");
  assert.ok(events.at(-1).droppedBytes > 0);
  assert.equal(events.at(-1).seq, 3);
  assert.equal(loadPipeline(dir).torn, false);
  session.append({ type: "link", runId: "r1" });
  assert.equal(session.state.links.runId, "r1");
  session.close();
});

test("a corrupt line or a broken sequence in the middle is an error and the file is left alone", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  session.append(pollEvent(session.state));
  session.close();
  const file = path.join(dir, EVENTS_FILE);
  const original = readFileSync(file, "utf8");
  const lines = original.split("\n");
  writeFileSync(file, `${lines[0]}\nnot json\n${lines[1]}\n`);
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_LOG_CORRUPT");
  writeFileSync(file, `${lines[1]}\n${lines[0]}\n`);
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_LOG_CORRUPT");
  writeFileSync(file, original);
  assert.equal(loadPipeline(dir).events.length, 2);
  writeFileSync(file, `${lines[0]}\n`);
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_LOG_CORRUPT", "a snapshot ahead of the log is corruption");
});

test("caps: a log or a state file over 8 MiB is refused untouched; one event over 1 MiB is refused", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  assert.throws(() => session.append({ type: "link", pad: "x".repeat(EVENT_CAP_BYTES) }), (error) => error.code === "PIPELINE_EVENT_TOO_LARGE");
  assert.equal(session.lastSeq, 1, "nothing was written");
  session.close();
  const file = path.join(dir, EVENTS_FILE);
  appendFileSync(file, " ".repeat(READ_CAP_BYTES));
  const size = statSync(file).size;
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_LOG_TOO_LARGE");
  assert.throws(() => openPipelineSession(dir, init), (error) => error.code === "PIPELINE_LOG_TOO_LARGE");
  assert.equal(statSync(file).size, size, "never truncated");
  assert.ok(!existsSync(path.join(dir, "run.lock")), "the lock is released when open fails");
  writeFileSync(file, readFileSync(file).subarray(0, 1));
  writeFileSync(path.join(dir, STATE_FILE), " ".repeat(READ_CAP_BYTES + 1));
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_LOG_TOO_LARGE");
});

test("rotation: past 4 MiB the next append starts a new file with a checkpoint; one generation is kept; the state is unchanged", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  session.append(pollEvent(session.state));
  for (let i = 0; i < 5; i += 1) session.append({ type: "link", sessionId: `s${i}`, pad: "x".repeat(900_000) });
  assert.ok(statSync(path.join(dir, EVENTS_FILE)).size >= 4 * 1024 * 1024);
  const before = structuredClone(session.state);
  session.append({ type: "link", sessionId: "after" });
  session.close();
  assert.ok(existsSync(path.join(dir, ROTATED_FILE)));
  const fresh = readFileSync(path.join(dir, EVENTS_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(fresh.map((event) => event.type), ["checkpoint", "link"]);
  const loaded = loadPipeline(dir);
  assert.equal(loaded.state.pr.state, before.pr.state);
  assert.deepEqual(loaded.state.slots, before.slots);
  assert.equal(loaded.state.links.sessionId, "after");
  assert.equal(loaded.lastSeq, fresh.at(-1).seq);
  // seq keeps counting across the rotation
  assert.equal(fresh[0].seq, 8);
  const reopened = openPipelineSession(dir, init);
  reopened.append({ type: "link", sessionId: "again" });
  reopened.close();
  assert.equal(loadPipeline(dir).state.links.sessionId, "again");
});

test("lock: one writer per PR; a stale lock is taken over; losing the lock stops appends", (t) => {
  const { dir } = fixture(t);
  const first = openPipelineSession(dir, init);
  assert.throws(() => openPipelineSession(dir, init), (error) => error.code === "PIPELINE_LOCKED" && error.exitCode === 1);
  assert.doesNotThrow(() => loadPipeline(dir), "readers never need the lock");
  first.close();
  const again = openPipelineSession(dir, init);
  again.close();

  const holder = openPipelineSession(dir, init);
  const taken = openPipelineSession(dir, init, { lock: { pidAlive: () => false } });
  assert.throws(() => holder.append({ type: "link", runId: "x" }), (error) => error.code === "PIPELINE_LOCK_LOST");
  taken.append({ type: "link", runId: "y" });
  taken.close();
  holder.close();
  assert.equal(loadPipeline(dir).state.links.runId, "y");
});

test("a newer schema version is refused with exit 5 and left untouched", (t) => {
  const { dir } = fixture(t);
  openPipelineSession(dir, init).close();
  const file = path.join(dir, STATE_FILE);
  const data = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...data, schemaVersion: 2 }));
  const bytes = readFileSync(file);
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_SCHEMA_TOO_NEW" && error.exitCode === 5);
  assert.throws(() => openPipelineSession(dir, init), (error) => error.code === "PIPELINE_SCHEMA_TOO_NEW");
  assert.deepEqual(readFileSync(file), bytes);
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, lastSeq: 1, slots: [] }));
  assert.throws(() => loadPipeline(dir), (error) => error.code === "PIPELINE_STATE_CORRUPT");
});

test("records are redacted, reserved keys cannot be forged, and the type is validated", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  const token = "ghp" + "_" + "S".repeat(36);
  session.append({ type: "link", sessionId: `tok ${token}`, seq: 99, v: 7, at: "forged" });
  assert.throws(() => session.append({ type: "Bad Type" }), TypeError);
  session.close();
  const text = readFileSync(path.join(dir, EVENTS_FILE), "utf8") + readFileSync(path.join(dir, STATE_FILE), "utf8");
  assert.ok(!text.includes(token));
  const last = loadPipeline(dir).events.at(-1);
  assert.equal(last.seq, 2);
  assert.equal(last.v, 1);
  assert.notEqual(last.at, "forged");
});

test("opening needs a valid repo for a new pipeline", (t) => {
  const { dir } = fixture(t);
  assert.throws(() => openPipelineSession(dir, { repo: "../x", prNumber: 1 }), TypeError);
  assert.ok(!existsSync(path.join(dir, "run.lock")));
});

test("rotation is crash-safe: a failure while swapping the logs leaves a consistent store and no sequence gap", (t) => {
  const { dir } = fixture(t);
  const session = openPipelineSession(dir, init);
  for (let i = 0; i < 5; i += 1) session.append({ type: "link", sessionId: `s${i}`, pad: "x".repeat(900_000) });
  const seqBefore = session.lastSeq;
  session.close();
  const failing = { ...nodeFs, renameSync: (from, to) => { if (String(to).endsWith(`${path.sep}${EVENTS_FILE}`)) throw Object.assign(new Error("injected"), { code: "EIO" }); return nodeFs.renameSync(from, to); } };
  const broken = openPipelineSession(dir, init, { fs: failing });
  assert.throws(() => broken.append({ type: "link", sessionId: "lost" }), /injected/);
  assert.equal(broken.lastSeq, seqBefore, "the sequence did not advance on a failed rotation");
  broken.close();
  // The old log was moved aside before the failure; the snapshot still describes the state. Reopening and appending must work with consecutive seq.
  const loaded = loadPipeline(dir);
  assert.equal(loaded.state.links.sessionId, "s4");
  const again = openPipelineSession(dir, init);
  again.append({ type: "link", sessionId: "after" });
  again.close();
  const final = loadPipeline(dir);
  assert.equal(final.state.links.sessionId, "after");
  assert.equal(final.lastSeq, seqBefore + 1);
  assert.ok(final.events.every((event, index, all) => index === 0 || event.seq === all[index - 1].seq + 1));
});
