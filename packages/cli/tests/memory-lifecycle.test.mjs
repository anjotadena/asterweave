// Memory lifecycle: search and authorisation, retention and cleanup, forget, items, date phrases.

import assert from "node:assert/strict";
import test, { after } from "node:test";
import { readEvents } from "../src/runtime/memory/capture.mjs";
import { saveCheckpoint, latestCheckpoint } from "../src/runtime/memory/checkpoints.mjs";
import { parseTimeBound } from "../src/runtime/memory/dates.mjs";
import { forgetBySearch, forgetEvents, forgetItem, forgetSession } from "../src/runtime/memory/forget.mjs";
import { confirmItem, correctItem, disputeItem, exportableDecisions, findItem, inspectItem, listItems, proposeItem, supersedeItem } from "../src/runtime/memory/items.mjs";
import { pendingCleanup, physicalCleanup, planRetentionChange, applyRetentionChange, reindexSearch } from "../src/runtime/memory/retention.mjs";
import { listCandidates, matchExpression, searchMemory, semanticRetrievalAllowed, tokenize } from "../src/runtime/memory/search.mjs";
import { archiveSession, findSession, listSessions, setVisibility } from "../src/runtime/memory/sessions.mjs";
import { tombstoneHash } from "../src/runtime/memory/tombstones.mjs";
import { appendEvent } from "../src/runtime/memory/capture.mjs";
import { openSession } from "../src/runtime/memory/sessions.mjs";
import { cleanupAll, DAY, rawBytes, T0, world } from "./memory-fixture.mjs";

after(cleanupAll);

const iso = (ms) => new Date(ms).toISOString();
const search = (w, query, extra = {}) => searchMemory(w.mem, { viewer: w.owner, repoId: w.repoId, query, ...extra }, w.settings);
const count = (w, table) => Number(w.mem.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);

// --- search and authorisation --------------------------------------------------------------------------

test("search finds events and items with id, UTC and local time, session and a snippet; weak and absent evidence are explicit", () => {
  const w = world();
  const s = w.session({ title: "Auth work" });
  w.event(s.id, "We should rotate the signing key every quarter", { id: "k1" });
  w.event(s.id, "Unrelated chatter about lunch", { id: "k2" });
  const hit = search(w, "signing key", { timeZone: "Asia/Manila" });
  assert.deepEqual([hit.evidence, hit.mode, hit.events.length], ["strong", "all", 1]);
  const [e] = hit.events;
  assert.deepEqual([e.id, e.sessionId, e.sessionTitle, e.eventTime, e.eventTimeLocal], ["k1", s.id, "Auth work", T0, "2026-11-11 17:30:00"]);
  assert.match(e.snippet, /\[signing\] \[key\]|\[signing\]/);
  const weak = search(w, "signing lunch");
  assert.deepEqual([weak.evidence, weak.mode, weak.events.length], ["weak", "any", 2]);
  assert.match(weak.notes.join(" "), /weak evidence/);
  const none = search(w, "kubernetes");
  assert.deepEqual([none.evidence, none.events, none.items], ["none", [], []]);
  assert.match(none.notes[0], /No stored memory matches/);
  assert.equal(search(w, "!!! ???").evidence, "none");
  assert.equal(search(w, '"signing" OR (key NEAR/2 x* ) AND').ok, true, "FTS operators in user text are neutralised, not parsed");
  assert.deepEqual(tokenize('A "b" OR c*'), ["a", "b", "or", "c"]);
  assert.equal(matchExpression(["a", "b"], "all"), '"a" "b"');
});

test("date range, session and task filters", () => {
  const w = world();
  const a = w.session({ id: "sa", taskId: "TASK-1" });
  const b = w.session({ id: "sb", taskId: "TASK-2" });
  const t = Date.parse(T0);
  w.event(a.id, "deploy plan alpha", { id: "d1", eventTime: iso(t - 5 * DAY) });
  w.event(a.id, "deploy plan beta", { id: "d2", eventTime: iso(t - 1 * DAY) });
  w.event(b.id, "deploy plan gamma", { id: "d3", eventTime: iso(t - 2 * DAY) });
  const ids = (r) => r.events.map((e) => e.id).sort();
  assert.deepEqual(ids(search(w, "deploy")), ["d1", "d2", "d3"]);
  assert.deepEqual(ids(search(w, "deploy", { since: iso(t - 3 * DAY) })), ["d2", "d3"]);
  assert.deepEqual(ids(search(w, "deploy", { until: iso(t - 3 * DAY) })), ["d1"]);
  assert.deepEqual(ids(search(w, "deploy", { sessionId: "sb" })), ["d3"]);
  assert.deepEqual(ids(search(w, "deploy", { taskId: "TASK-1" })), ["d1", "d2"]);
  assert.equal(search(w, "deploy", { since: iso(t), until: iso(t - DAY) }).ok, false);
  assert.deepEqual(ids(search(w, "", { since: iso(t - 3 * DAY) })), ["d2", "d3"], "no keyword: browse by time");
});

test("date phrases resolve deterministically against the injected clock in the given time zone", () => {
  const now = "2026-11-11T09:30:00.000Z"; // Wednesday 17:30 in Manila
  const at = (text, edge, timeZone = "Asia/Manila") => parseTimeBound(text, { now, timeZone, edge });
  assert.equal(at("yesterday", "start").iso, "2026-11-09T16:00:00.000Z");
  assert.equal(at("yesterday", "end").iso, "2026-11-10T15:59:59.999Z");
  assert.equal(at("last tuesday", "start").iso, "2026-11-09T16:00:00.000Z");
  assert.equal(at("last wednesday", "start").iso, "2026-11-03T16:00:00.000Z", "today is a Wednesday: a week ago");
  assert.equal(at("last week", "start").iso, "2026-11-01T16:00:00.000Z");
  assert.equal(at("3 days ago", "start").iso, "2026-11-07T16:00:00.000Z");
  assert.equal(at("2 hours ago", "start").iso, "2026-11-11T07:30:00.000Z");
  assert.equal(at("2026-11-03", "start").iso, "2026-11-02T16:00:00.000Z");
  assert.equal(at("2026-11-03T10:00:00Z", "start").iso, "2026-11-03T10:00:00.000Z");
  assert.equal(at("2026-11-03T10:00:00+02:00", "start").iso, "2026-11-03T08:00:00.000Z");
  assert.equal(at("yesterday", "start", "UTC").iso, "2026-11-10T00:00:00.000Z", "the zone changes the day boundary");
  assert.equal(at("2026-02-30", "start").ok, false);
  assert.equal(at("whenever", "start").ok, false);
  assert.equal(at("today", "start", "Not/AZone").ok, false);
});

test("private by default: another reader of the same repository sees nothing until the owner shares the session", () => {
  const w = world();
  const s = w.session({ id: "mine" });
  w.event(s.id, "confidential migration plan", { id: "p1" });
  const bob = (extra) => searchMemory(w.mem, { viewer: "u_bob", repoId: w.repoId, query: "migration", ...extra }, w.settings);
  assert.equal(bob().evidence, "none");
  assert.equal(findSession(w.mem, "mine", "u_bob").ok, false);
  assert.deepEqual(listSessions(w.mem, { viewer: "u_bob", repoId: w.repoId }), []);
  assert.equal(setVisibility(w.mem, "mine", "u_bob", "shared").ok, false, "only the owner shares");
  assert.equal(setVisibility(w.mem, "mine", w.owner, "shared").changed, true);
  assert.equal(bob().events.length, 1);
  assert.equal(searchMemory(w.mem, { viewer: "u_bob", repoId: "r_elsewhere", query: "migration" }, w.settings).evidence, "none", "and only inside that repository");
  assert.deepEqual(forgetEvents(w.mem, { viewer: "u_bob", eventIds: ["p1"] }).events, 0, "a reader cannot delete another owner's events");
});

test("user-scope items are for their owner only; shared repository items are readable by the repository's other readers", () => {
  const w = world();
  const base = { owner: w.owner, repoId: w.repoId, origin: "user_decision", kind: "preference" };
  const mine = proposeItem(w.mem, { ...base, scope: "user", content: "I like tabs", visibility: "shared" }, w.settings).item;
  const repoPrivate = proposeItem(w.mem, { ...base, scope: "repository", kind: "decision", content: "private repository choice about tabs" }, w.settings).item;
  const repoShared = proposeItem(w.mem, { ...base, scope: "repository", kind: "decision", content: "shared repository choice about tabs", visibility: "shared" }, w.settings).item;
  const bob = searchMemory(w.mem, { viewer: "u_bob", repoId: w.repoId, query: "tabs" }, w.settings);
  assert.deepEqual(bob.items.map((i) => i.id), [repoShared.id]);
  assert.equal(search(w, "tabs").items.length, 3);
  assert.equal(findItem(w.mem, mine.id, "u_bob", { repoId: w.repoId }).ok, false);
  assert.equal(findItem(w.mem, repoPrivate.id, "u_bob", { repoId: w.repoId }).ok, false);
  assert.equal(findItem(w.mem, repoShared.id, "u_bob", { repoId: w.repoId }).ok, true);
  assert.equal(confirmItem(w.mem, repoShared.id, "u_bob", { explicit: true }).ok, false, "only the owner changes an item");
});

test("archived sessions stay searchable until they expire", () => {
  const w = world();
  const s = w.session({ id: "arch" });
  w.event(s.id, "remember the zebra deadline", { id: "z" });
  const before = w.mem.db.prepare("SELECT expires_at FROM sessions WHERE id = 'arch'").get().expires_at;
  assert.equal(archiveSession(w.mem, "arch", w.owner).changed, true);
  const hit = search(w, "zebra");
  assert.deepEqual([hit.events.length, hit.events[0].archived], [1, true]);
  assert.equal(w.mem.db.prepare("SELECT expires_at FROM sessions WHERE id = 'arch'").get().expires_at, before, "archiving does not renew retention");
  w.now.advance(10 * DAY);
  assert.equal(search(w, "zebra").evidence, "none");
});

// --- retention -----------------------------------------------------------------------------------------

test("retention boundary: readable one millisecond before expires_at, gone exactly at it", () => {
  const w = world();
  const s = w.session({ id: "b" });
  const saved = w.event(s.id, "boundary phrase", { id: "e" });
  assert.equal(saved.expiresAt, iso(Date.parse(T0) + 10 * DAY));
  w.now.set(iso(Date.parse(saved.expiresAt) - 1));
  assert.equal(search(w, "boundary").events.length, 1);
  assert.equal(readEvents(w.mem, s.id).length, 1);
  assert.equal(findSession(w.mem, "b", w.owner).ok, true);
  w.now.set(saved.expiresAt);
  assert.equal(search(w, "boundary").events.length, 0);
  assert.equal(readEvents(w.mem, s.id).length, 0);
  assert.equal(findSession(w.mem, "b", w.owner).ok, false, "the session expires with its last event");
});

test("searching, reading, resuming and archiving never move an expiry", () => {
  const w = world();
  const s = w.session({ id: "r" });
  w.event(s.id, "stable expiry phrase", { id: "e" });
  saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 1, goal: "g" }, w.settings);
  const snapshot = () => JSON.stringify([w.mem.db.prepare("SELECT expires_at FROM events").all(), w.mem.db.prepare("SELECT expires_at, last_activity_at FROM sessions").all(), w.mem.db.prepare("SELECT expires_at FROM checkpoints").all()]);
  const before = snapshot();
  w.now.advance(5 * DAY);
  search(w, "stable", { trace: true });
  readEvents(w.mem, s.id);
  findSession(w.mem, "r", w.owner);
  latestCheckpoint(w.mem, s.id, w.owner);
  listCandidates(w.mem, { viewer: w.owner, repoId: w.repoId, sessionId: s.id });
  archiveSession(w.mem, "r", w.owner);
  assert.equal(snapshot(), before);
  w.now.advance(5 * DAY);
  assert.equal(search(w, "stable").evidence, "none", "five days of reading did not buy any extra time");
});

test("logical expiry is immediate; physical cleanup comes later and removes the index, derived checkpoints, and flags items", () => {
  const w = world();
  const s = w.session({ id: "x" });
  w.event(s.id, "ephemeral note about ledgers", { id: "e1" });
  saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 1, goal: "derived summary" }, w.settings);
  const item = proposeItem(w.mem, { owner: w.owner, repoId: w.repoId, origin: "assistant_suggestion", kind: "decision", content: "keep ledgers append-only", sourceEventIds: ["e1"] }, w.settings).item;
  confirmItem(w.mem, item.id, w.owner, { explicit: true });
  w.now.advance(10 * DAY);
  assert.equal(search(w, "ledgers").events.length, 0, "hidden already");
  assert.equal(latestCheckpoint(w.mem, s.id, w.owner), null);
  const pending = pendingCleanup(w.mem);
  assert.deepEqual([pending.events, pending.checkpoints], [1, 1]);
  assert.equal(count(w, "events"), 1, "still physically present");
  const result = physicalCleanup(w.mem);
  assert.equal(result.complete, true);
  assert.deepEqual([count(w, "events"), count(w, "checkpoints"), count(w, "sessions"), Number(w.mem.db.prepare("SELECT COUNT(*) n FROM events_fts").get().n)], [0, 0, 0, 0]);
  const kept = findItem(w.mem, item.id, w.owner);
  assert.deepEqual([kept.ok, kept.item.status, kept.item.sourceExpired, kept.item.expiresAt], [true, "confirmed", true, null], "a confirmed decision outlives its transcript, flagged");
  assert.ok(!rawBytes(w.mem).includes("ephemeral note about ledgers"));
  const info = inspectItem(w.mem, item.id, w.owner);
  assert.deepEqual(info.sources.map((x) => [x.available, x.reason]), [[false, "expired_or_removed"]]);
});

test("cleanup is batched, resumable and retry-safe", () => {
  const w = world();
  const s = w.session({ id: "bulk" });
  for (let i = 0; i < 5; i += 1) w.event(s.id, `bulk row ${i}`, { id: `b${i}` });
  w.now.advance(10 * DAY);
  const first = physicalCleanup(w.mem, { batchSize: 2, maxBatches: 1 });
  assert.deepEqual([first.removed.events, first.batches, first.complete], [2, 1, false]);
  assert.equal(count(w, "events"), 3);
  const progress = w.mem.db.prepare("SELECT state, rows_removed FROM maintenance_progress WHERE task = 'events'").get();
  assert.deepEqual([progress.state, Number(progress.rows_removed)], ["partial", 2]);
  let calls = 0;
  assert.throws(() => physicalCleanup(w.mem, { batchSize: 2, onBatch: () => { if ((calls += 1) === 2) throw new Error("crash mid-run"); } }), /crash mid-run/);
  assert.equal(count(w, "events"), 1, "the failed batch rolled back; the one before it stayed committed");
  const done = physicalCleanup(w.mem, { batchSize: 2 });
  assert.equal(done.complete, true);
  assert.deepEqual([count(w, "events"), count(w, "sessions")], [0, 0]);
  assert.equal(Number(w.mem.db.prepare("SELECT rows_removed n FROM maintenance_progress WHERE task = 'events'").get().n), 5);
  assert.equal(physicalCleanup(w.mem).batches, 0, "nothing left to do");
});

test("changing retention: the dry run reports exactly what applying does; shortening expires now; lengthening never revives", () => {
  const w = world();
  const s = w.session({ id: "c" });
  const t = Date.parse(T0);
  for (let age = 0; age < 6; age += 1) w.event(s.id, `aged ${age} days`, { id: `a${age}`, eventTime: iso(t - age * DAY) });
  saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 6, goal: "all of it" }, w.settings);
  const plan = planRetentionChange(w.mem, { days: 3 });
  assert.equal(plan.events.wouldExpire, 3, "events aged 3, 4 and 5 days would expire under 3 days");
  assert.equal(plan.checkpoints.wouldExpire, 1);
  assert.equal(count(w, "events"), 6);
  assert.equal(readEvents(w.mem, s.id).length, 6, "a plan changes nothing");
  assert.deepEqual(JSON.parse(JSON.stringify(planRetentionChange(w.mem, { days: 3 }))), JSON.parse(JSON.stringify(plan)), "deterministic");
  const applied = applyRetentionChange(w.mem, { days: 3 });
  assert.equal(applied.events.wouldExpire, plan.events.wouldExpire);
  assert.equal(readEvents(w.mem, s.id).length, 3);
  assert.equal(latestCheckpoint(w.mem, s.id, w.owner), null);
  const longer = planRetentionChange(w.mem, { days: 100 });
  assert.equal(longer.events.wouldExpire, 0);
  assert.equal(longer.events.keptLonger, 3);
  applyRetentionChange(w.mem, { days: 100 });
  assert.equal(readEvents(w.mem, s.id).length, 3, "expired events are not brought back");
  assert.throws(() => planRetentionChange(w.mem, { days: 0 }), RangeError);
});

// --- forget --------------------------------------------------------------------------------------------

function forgetWorld() {
  const w = world();
  const s = w.session({ id: "f" });
  w.event(s.id, "the quokka migration is scheduled", { id: "q1" });
  w.event(s.id, "another quokka remark", { id: "q2" });
  w.event(s.id, "innocent remark", { id: "ok" });
  saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 3, goal: "quokka summary" }, w.settings);
  const item = proposeItem(w.mem, { owner: w.owner, repoId: w.repoId, origin: "tool_observation", kind: "observation", content: "quokka facts", sourceEventIds: ["q1"] }, w.settings).item;
  return { w, s, item };
}

test("forgetting an event removes its content, derived items, covering checkpoints and index entries, and writes a content-free tombstone", () => {
  const { w, s, item } = forgetWorld();
  const preview = forgetEvents(w.mem, { viewer: w.owner, eventIds: ["q1"], dryRun: true });
  assert.deepEqual([preview.events, preview.items, preview.checkpoints, preview.dryRun], [1, 1, 1, true]);
  assert.equal(count(w, "events"), 3, "a dry run deletes nothing");
  const done = forgetEvents(w.mem, { viewer: w.owner, eventIds: ["q1", "nope"] });
  assert.deepEqual([done.events, done.items, done.checkpoints, done.notFound], [1, 1, 1, 1]);
  assert.equal(search(w, "quokka").events.length, 1);
  assert.equal(findItem(w.mem, item.id, w.owner).ok, false);
  assert.equal(latestCheckpoint(w.mem, s.id, w.owner), null);
  assert.equal(Number(w.mem.db.prepare("SELECT COUNT(*) n FROM events_fts WHERE events_fts MATCH 'migration'").get().n), 0);
  const tomb = w.mem.db.prepare("SELECT * FROM tombstones").all();
  assert.equal(tomb.length, 2);
  assert.deepEqual(Object.keys(tomb[0]).sort(), ["deleted_at", "hash", "kind"], "a tombstone carries no content");
  assert.ok(tomb.some((row) => row.hash === tombstoneHash("event", "q1")));
  const bytes = rawBytes(w.mem);
  for (const gone of ["quokka migration is scheduled", "quokka summary", "quokka facts"]) assert.ok(!bytes.includes(gone), gone);
});

test("a tombstone blocks the same data from coming back by capture, reimport or reindex", () => {
  const { w, s } = forgetWorld();
  forgetEvents(w.mem, { viewer: w.owner, eventIds: ["q1"] });
  const replay = appendEvent(w.mem, s.id, { id: "q1", type: "message", content: "the quokka migration is scheduled" }, w.settings);
  assert.deepEqual([replay.saved, replay.status], [false, "forgotten"]);
  reindexSearch(w.mem);
  assert.equal(search(w, "migration").events.length, 0);
  assert.equal(proposeItem(w.mem, { id: "mi_fixed", owner: w.owner, repoId: w.repoId, origin: "user_decision", kind: "decision", content: "x" }, w.settings).saved, true);
  forgetItem(w.mem, { viewer: w.owner, itemId: "mi_fixed" });
  assert.equal(proposeItem(w.mem, { id: "mi_fixed", owner: w.owner, repoId: w.repoId, origin: "user_decision", kind: "decision", content: "x again" }, w.settings).status, "forgotten");
  forgetSession(w.mem, { viewer: w.owner, sessionId: "f" });
  assert.equal(openSession(w.mem, { id: "f", owner: w.owner, identity: w.identity }, w.settings).status, "forgotten");
  assert.equal(appendEvent(w.mem, "f", { id: "fresh", type: "message", content: "x" }, w.settings).reason, "session_not_found");
});

test("forgetting a session removes everything under it; forgetting by search needs a full match and only deletes your own data", () => {
  const { w } = forgetWorld();
  const other = w.session({ id: "g" });
  w.event(other.id, "quokka in another session", { id: "q9" });
  const weak = forgetBySearch(w.mem, { viewer: w.owner, repoId: w.repoId, query: "quokka kangaroo" });
  assert.equal(weak.code, "WEAK_MATCH", "an all-terms miss falls back to weak matches, which are refused for deletion");
  assert.equal(count(w, "events"), 4);
  const bySearch = forgetBySearch(w.mem, { viewer: w.owner, repoId: w.repoId, query: "quokka" });
  assert.deepEqual([bySearch.events, bySearch.items], [3, 1]);
  assert.equal(forgetBySearch(w.mem, { viewer: w.owner, repoId: w.repoId, query: "" }).code, "USAGE");
  const gone = forgetSession(w.mem, { viewer: w.owner, sessionId: "f" });
  assert.deepEqual([gone.sessions, gone.events], [1, 1]);
  assert.deepEqual([count(w, "events"), count(w, "checkpoints")], [0, 0]);
  assert.equal(forgetSession(w.mem, { viewer: "u_bob", sessionId: "g" }).ok, false);
});

// --- items ---------------------------------------------------------------------------------------------

test("item status rules: a suggestion is never confirmed or confirmed-over without an explicit call; supersede keeps history", () => {
  const w = world();
  const base = { owner: w.owner, repoId: w.repoId, kind: "decision" };
  const suggested = proposeItem(w.mem, { ...base, origin: "assistant_suggestion", content: "use postgres" }, w.settings).item;
  assert.equal(suggested.status, "proposed", "always proposed first, whoever wrote it");
  assert.equal(proposeItem(w.mem, { ...base, origin: "user_decision", content: "use sqlite" }, w.settings).item.status, "proposed");
  assert.equal(confirmItem(w.mem, suggested.id, w.owner).code, "CONFIRMATION_REQUIRED");
  assert.equal(confirmItem(w.mem, suggested.id, w.owner, { explicit: false }).code, "CONFIRMATION_REQUIRED");
  assert.equal(findItem(w.mem, suggested.id, w.owner).item.status, "proposed");
  const confirmed = confirmItem(w.mem, suggested.id, w.owner, { explicit: true });
  assert.deepEqual([confirmed.item.status, confirmed.item.expiresAt], ["confirmed", null]);

  const sneaky = supersedeItem(w.mem, suggested.id, w.owner, { content: "use mongodb", origin: "assistant_suggestion" }, w.settings);
  assert.equal(sneaky.code, "CONFIRMATION_REQUIRED");
  assert.equal(disputeItem(w.mem, suggested.id, w.owner, {}).code, "CONFIRMATION_REQUIRED");
  assert.equal(correctItem(w.mem, suggested.id, w.owner, { content: "typo fix" }, w.settings).code, "CONFIRMATION_REQUIRED");
  assert.equal(findItem(w.mem, suggested.id, w.owner).item.status, "confirmed", "none of those changed anything");

  const replaced = supersedeItem(w.mem, suggested.id, w.owner, { content: "use sqlite after all", explicit: true }, w.settings);
  assert.deepEqual([replaced.ok, replaced.item.status, replaced.item.supersedes, replaced.previous.status, replaced.previous.replacedBy], [true, "confirmed", suggested.id, "superseded", replaced.item.id]);
  assert.equal(findItem(w.mem, suggested.id, w.owner).item.content, "use postgres", "history keeps the old text");
  const chain = inspectItem(w.mem, replaced.item.id, w.owner);
  assert.equal(chain.supersedes.id, suggested.id);
  assert.equal(supersedeItem(w.mem, suggested.id, w.owner, { content: "again", explicit: true }, w.settings).code, "ITEM_STATE");
  const fixed = correctItem(w.mem, replaced.item.id, w.owner, { content: "use SQLite (node:sqlite)", explicit: true }, w.settings);
  assert.deepEqual([fixed.item.status, fixed.item.kind, fixed.item.origin], ["confirmed", "decision", "user_decision"]);
  const open = supersedeItem(w.mem, listItems(w.mem, { viewer: w.owner, repoId: w.repoId, status: "proposed" })[0].id, w.owner, { content: "refined" }, w.settings);
  assert.equal(open.item.status, "proposed", "replacing an unconfirmed item needs no confirmation and does not confirm");
  const disputed = disputeItem(w.mem, fixed.item.id, w.owner, { explicit: true });
  assert.deepEqual([disputed.item.status, typeof disputed.item.expiresAt], ["disputed", "string"]);
});

test("items cite sources that must exist and be readable; inspect shows them; bad input is rejected", () => {
  const w = world();
  const s = w.session({ id: "i" });
  w.event(s.id, "we decided to cache for five minutes", { id: "src" });
  const base = { owner: w.owner, repoId: w.repoId, origin: "tool_observation", kind: "observation" };
  assert.equal(proposeItem(w.mem, { ...base, content: "x", sourceEventIds: ["missing"] }, w.settings).code, "SOURCE_NOT_FOUND");
  assert.equal(proposeItem(w.mem, { ...base, content: "   " }, w.settings).code, "USAGE");
  assert.equal(proposeItem(w.mem, { ...base, content: "x", kind: "rumour" }, w.settings).code, "USAGE");
  assert.equal(proposeItem(w.mem, { ...base, content: "x", scope: "session" }, w.settings).code, "USAGE");
  assert.equal(proposeItem(w.mem, { ...base, content: "x", confidence: 3 }, w.settings).code, "USAGE");
  assert.equal(proposeItem(w.mem, { ...base, content: "x" }, { ...w.settings, enabled: false }).status, "disabled");
  const item = proposeItem(w.mem, { ...base, content: "cache ttl is 5 minutes, key ghp_abcdefghijklmnopqrstuvwxyz0123456789", sourceEventIds: ["src"], confidence: 0.8 }, w.settings).item;
  assert.ok(!item.content.includes("abcdefghijklmnopqrstuvwxyz0123456789"));
  const info = inspectItem(w.mem, item.id.slice(0, 8), w.owner);
  assert.deepEqual([info.sources[0].available, info.sources[0].sessionId, info.sources[0].snippet], [true, "i", "we decided to cache for five minutes"]);
  assert.equal(info.item.confidence, 0.8);
  assert.equal(findItem(w.mem, "mi_", w.owner).ok, false, "a too-short prefix matches nothing");
});

test("export includes only confirmed repository decisions, requirements and constraints", () => {
  const w = world();
  const base = { owner: w.owner, repoId: w.repoId, origin: "user_decision", scope: "repository" };
  const ids = {};
  for (const [name, kind] of [["decision", "decision"], ["constraint", "constraint"], ["pref", "preference"], ["obs", "observation"], ["proposed", "decision"], ["disputed", "decision"]]) {
    ids[name] = proposeItem(w.mem, { ...base, kind, content: `${name} text` }, w.settings).item.id;
  }
  const user = proposeItem(w.mem, { ...base, scope: "user", kind: "decision", content: "user scope text" }, w.settings).item.id;
  for (const name of ["decision", "constraint", "pref", "obs"]) confirmItem(w.mem, ids[name], w.owner, { explicit: true });
  confirmItem(w.mem, user, w.owner, { explicit: true });
  confirmItem(w.mem, ids.disputed, w.owner, { explicit: true });
  disputeItem(w.mem, ids.disputed, w.owner, { explicit: true });
  assert.deepEqual(exportableDecisions(w.mem, { viewer: w.owner, repoId: w.repoId }).map((i) => i.content).sort(), ["constraint text", "decision text"]);
  assert.deepEqual(exportableDecisions(w.mem, { viewer: "u_bob", repoId: w.repoId }), [], "private items are not exported for anyone else");
});

test("listCandidates is the retrieval interface for later phases: authorised, unexpired, no ranking claims; semantic search stays off", () => {
  const w = world();
  const s = w.session({ id: "cand" });
  w.event(s.id, "one", { id: "c1" });
  w.event(s.id, "two", { id: "c2" });
  const item = proposeItem(w.mem, { owner: w.owner, repoId: w.repoId, origin: "user_decision", kind: "decision", content: "candidate decision" }, w.settings).item;
  confirmItem(w.mem, item.id, w.owner, { explicit: true });
  const mine = listCandidates(w.mem, { viewer: w.owner, repoId: w.repoId, sessionId: "cand", limit: 1 });
  assert.deepEqual([mine.items.length, mine.recentEvents.map((e) => e.id)], [1, ["c2"]]);
  assert.deepEqual(listCandidates(w.mem, { viewer: "u_bob", repoId: w.repoId, sessionId: "cand" }), { items: [], recentEvents: [], checkpoint: null });
  assert.equal(semanticRetrievalAllowed({ semanticSearchEnabled: false }, { name: "x", rank: async () => [] }), false);
  assert.equal(semanticRetrievalAllowed({ semanticSearchEnabled: true }, undefined), false);
  assert.equal(semanticRetrievalAllowed({ semanticSearchEnabled: true }, { name: "x", rank: async () => [] }), true);
});

test("a trace records ids and numbers only", () => {
  const w = world();
  const s = w.session();
  w.event(s.id, "tracing marker content", { id: "tr" });
  search(w, "tracing", { trace: true });
  const row = w.mem.db.prepare("SELECT * FROM retrieval_traces").get();
  assert.deepEqual([JSON.parse(row.selected_ids), row.rationale], [["tr"], "lexical:all"]);
  assert.ok(!JSON.stringify(row).includes("marker content"));
  forgetEvents(w.mem, { viewer: w.owner, eventIds: ["tr"] });
  assert.equal(count(w, "retrieval_traces"), 0, "forgetting scrubs traces that name the event");
});
