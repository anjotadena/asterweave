// Forget: delete stored content on request, and everything derived from it.
//
// Removed together, in one transaction: the events (and, through triggers, their full-text rows), every memory item drawn
// from them, every checkpoint that covers them (a summary is derived text), retrieval traces that name them, and the
// item_sources links. What stays is content-free: a tombstone (hash of the id, kind, time). Every insert path checks
// tombstones first (capture.mjs, sessions.mjs, items.mjs), so replaying the source cannot bring the data back.
//
// After the commit the database is scrubbed (FTS segment merge + WAL truncate) and `secure_delete` has zeroed the freed pages.
// Honest limits: copies outside the database (backups, an exported file, a terminal scrollback), and what a storage device
// keeps below the file system, are not reachable from here.
//
// Only the OWNER may forget. Forgetting a session also forgets its checkpoints and items scoped to it. Forgetting a source
// event deletes the items drawn from it, even a confirmed one: the user asked for that text, and what was derived from it, to go.
// Every function takes `dryRun: true` to count what would be deleted (the real run, rolled back).

import { checkpointDigest, checkpointIntact } from "./checkpoints.mjs";
import { dryRun, placeholders, scrub, transaction } from "./db.mjs";
import { findItem } from "./items.mjs";
import { searchMemory } from "./search.mjs";
import { findSession } from "./sessions.mjs";
import { addTombstone } from "./tombstones.mjs";

const empty = () => ({ events: 0, items: 0, checkpoints: 0, sessions: 0, traces: 0 });
const chunks = (list, size = 400) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));
/** The title a session gets when the event it was derived from (the goal, the first user line) is forgotten. */
export const FORGOTTEN_TITLE = "(forgotten)";
// The form the live pipeline copies an item into checkpoints.decisions with (pipeline.mjs decisionLines): whitespace collapsed,
// 200 characters and an ellipsis. A 48-character prefix also matches a line whose tail was altered by redaction.
const clipped = (text) => {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > 200 ? `${value.slice(0, 200)}…` : value;
};
const needlesOf = (content) => {
  const full = clipped(content);
  return full === "" ? [] : [...new Set([full, full.slice(0, 48)])];
};

/**
 * Checkpoints carry derived copies of item text (decisions, injected by the context builder). Remove every line that carries a
 * forgotten item from the checkpoints of the item's source sessions, its own session and any session whose decisions contain it.
 * An intact row is rewritten with a fresh digest; a row that no longer matches its digest is deleted (it cannot be rewritten
 * without vouching for damaged content).
 */
function scrubCheckpointDecisions(db, rows, counts) {
  const needles = [...new Set(rows.flatMap((row) => needlesOf(row.content)))];
  if (needles.length === 0) return;
  const sessions = new Set(rows.map((row) => row.session_id).filter(Boolean));
  for (const part of chunks(rows.map((row) => row.id))) {
    for (const row of db.prepare(`SELECT DISTINCT e.session_id FROM item_sources s JOIN events e ON e.id = s.event_id WHERE s.item_id IN (${placeholders(part.length)})`).all(...part)) sessions.add(row.session_id);
  }
  const candidates = new Map();
  const bySession = db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND decisions IS NOT NULL");
  for (const id of sessions) for (const row of bySession.all(id)) candidates.set(row.id, row);
  const byText = db.prepare("SELECT * FROM checkpoints WHERE decisions IS NOT NULL AND instr(decisions, ?) > 0");
  for (const needle of needles) for (const row of byText.all(needle)) candidates.set(row.id, row);
  const rewrite = db.prepare("UPDATE checkpoints SET decisions = ?, digest = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM checkpoints WHERE id = ?");
  for (const row of candidates.values()) {
    const lines = String(row.decisions).split("\n");
    const kept = lines.filter((line) => !needles.some((needle) => line.includes(needle)));
    if (kept.length === lines.length) continue;
    if (!checkpointIntact(row)) {
      counts.checkpoints += Number(remove.run(row.id).changes);
      continue;
    }
    const next = { ...row, decisions: kept.length > 0 ? kept.join("\n") : null };
    rewrite.run(next.decisions, row.digest === null || row.digest === undefined ? null : checkpointDigest(next), row.id);
  }
}

function dropTraces(db, ids) {
  let count = 0;
  const stmt = db.prepare("DELETE FROM retrieval_traces WHERE selected_ids LIKE ? ESCAPE '\\'");
  for (const id of ids) count += Number(stmt.run(`%"${String(id).replace(/[\\%_]/g, "\\$&")}"%`).changes);
  return count;
}

/** Delete items by id with their links and traces; tombstone each. */
function deleteItems(mem, itemIds, at, counts) {
  const { db } = mem;
  const rows = [];
  for (const part of chunks(itemIds)) rows.push(...db.prepare(`SELECT id, content, session_id FROM memory_items WHERE id IN (${placeholders(part.length)})`).all(...part));
  scrubCheckpointDecisions(db, rows, counts); // before item_sources goes: it names the source sessions
  for (const part of chunks(itemIds)) {
    const marks = placeholders(part.length);
    db.prepare(`UPDATE memory_items SET supersedes = NULL WHERE supersedes IN (${marks})`).run(...part);
    db.prepare(`UPDATE memory_items SET replaced_by = NULL WHERE replaced_by IN (${marks})`).run(...part);
    db.prepare(`DELETE FROM item_sources WHERE item_id IN (${marks})`).run(...part);
    counts.items += Number(db.prepare(`DELETE FROM memory_items WHERE id IN (${marks})`).run(...part).changes);
  }
  for (const id of itemIds) addTombstone(db, "item", id, at);
  counts.traces += dropTraces(db, itemIds);
}

/** Delete events and everything derived from them. `events` rows: {rid, id, session_id, seq}. */
function deleteEvents(mem, events, at, counts) {
  const { db } = mem;
  if (events.length === 0) return;
  const ids = events.map((event) => event.id);
  const derived = new Set();
  for (const part of chunks(ids)) {
    for (const row of db.prepare(`SELECT DISTINCT item_id FROM item_sources WHERE event_id IN (${placeholders(part.length)})`).all(...part)) derived.add(row.item_id);
  }
  // Items that merely list a source id in their JSON are covered by item_sources; this also catches any that lost the link row.
  const listed = db.prepare("SELECT id, source_event_ids FROM memory_items WHERE source_event_ids != '[]'").all();
  const idSet = new Set(ids);
  for (const row of listed) {
    try {
      if (JSON.parse(row.source_event_ids).some((id) => idSet.has(id))) derived.add(row.id);
    } catch {
      // a damaged list names no source
    }
  }
  if (derived.size) deleteItems(mem, [...derived], at, counts);
  // A session's title is derived from its goal / first user line: when that event goes, the title goes with it.
  const firstUser = db.prepare("SELECT id FROM events WHERE session_id = ? AND type = 'message' AND role = 'user' ORDER BY seq LIMIT 1");
  const retitle = db.prepare("UPDATE sessions SET title = ? WHERE id = ?");
  for (const sessionId of new Set(events.map((event) => event.session_id))) {
    const first = firstUser.get(sessionId)?.id;
    if ((first !== undefined && idSet.has(first)) || events.some((event) => event.session_id === sessionId && String(event.id).endsWith(":goal"))) retitle.run(FORGOTTEN_TITLE, sessionId);
  }
  const firstSeq = new Map();
  for (const event of events) firstSeq.set(event.session_id, Math.min(firstSeq.get(event.session_id) ?? Infinity, Number(event.seq)));
  for (const [sessionId, seq] of firstSeq) counts.checkpoints += Number(db.prepare("DELETE FROM checkpoints WHERE session_id = ? AND covered_seq >= ?").run(sessionId, seq).changes);
  for (const part of chunks(events.map((event) => event.rid))) counts.events += Number(db.prepare(`DELETE FROM events WHERE rid IN (${placeholders(part.length)})`).run(...part).changes);
  for (const id of ids) addTombstone(db, "event", id, at);
  counts.traces += dropTraces(db, ids);
}

function finish(mem, options, work) {
  const counts = empty();
  if (options.dryRun === true) return { ok: true, dryRun: true, ...dryRun(mem, () => work(counts) ?? counts) };
  const result = transaction(mem, () => work(counts) ?? counts);
  if (result.ok === false) return result;
  scrub(mem);
  return { ok: true, dryRun: false, ...result };
}

/** Forget events by id. Ids the viewer does not own (or that do not exist) are reported in `notFound`, never revealed. */
export function forgetEvents(mem, { viewer, eventIds, dryRun: dry }) {
  const wanted = [...new Set((eventIds ?? []).map(String))];
  return finish(mem, { dryRun: dry }, (counts) => {
    const owned = [];
    for (const part of chunks(wanted)) {
      owned.push(...mem.db.prepare(`SELECT e.rid, e.id, e.session_id, e.seq FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id IN (${placeholders(part.length)}) AND s.owner = ?`).all(...part, viewer));
    }
    deleteEvents(mem, owned, mem.now(), counts);
    const found = new Set(owned.map((event) => event.id));
    return { ...counts, notFound: wanted.filter((id) => !found.has(id)).length };
  });
}

/** Forget a whole session: its events, checkpoints, items scoped to it or drawn from it, and the session record. */
export function forgetSession(mem, { viewer, sessionId, dryRun: dry }) {
  const found = findSession(mem, sessionId, viewer);
  if (!found.ok || found.session.owner !== viewer) return { ok: false, code: "SESSION_NOT_FOUND", message: "No session of yours has that id." };
  const id = found.session.id;
  return finish(mem, { dryRun: dry }, (counts) => {
    const at = mem.now();
    deleteEvents(mem, mem.db.prepare("SELECT rid, id, session_id, seq FROM events WHERE session_id = ?").all(id), at, counts);
    const scoped = mem.db.prepare("SELECT id FROM memory_items WHERE session_id = ?").all(id).map((row) => row.id);
    if (scoped.length) deleteItems(mem, scoped, at, counts);
    counts.checkpoints += Number(mem.db.prepare("DELETE FROM checkpoints WHERE session_id = ?").run(id).changes);
    counts.sessions += Number(mem.db.prepare("DELETE FROM sessions WHERE id = ?").run(id).changes);
    addTombstone(mem.db, "session", id, at);
    counts.traces += dropTraces(mem.db, [id]);
    return counts;
  });
}

/** Forget one item (and nothing it was drawn from). */
export function forgetItem(mem, { viewer, itemId, dryRun: dry }) {
  const found = findItem(mem, itemId, viewer);
  if (!found.ok || found.row.owner !== viewer) return { ok: false, code: "ITEM_NOT_FOUND", message: "No item of yours has that id." };
  return finish(mem, { dryRun: dry }, (counts) => {
    deleteItems(mem, [found.row.id], mem.now(), counts);
    return counts;
  });
}

/**
 * Forget what a search finds. Only the viewer's own events and items are deleted; hits that belong to someone else's shared
 * session are left alone and counted in `skipped`.
 */
export function forgetBySearch(mem, { viewer, repoId, query, since, until, sessionId, taskId, dryRun: dry }) {
  if (String(query ?? "").trim() === "" && !since && !until && !sessionId && !taskId) return { ok: false, code: "USAGE", message: "Forgetting by search needs a keyword or a filter." };
  const hits = searchMemory(mem, { viewer, repoId, query, since, until, sessionId, taskId, limit: 100 });
  if (!hits.ok) return hits;
  if (hits.evidence === "weak") return { ok: false, code: "WEAK_MATCH", message: "Only partial matches were found; refine the search so every term matches before deleting." };
  const mineItems = hits.items.filter((item) => item.owner === viewer).map((item) => item.id);
  const eventIds = hits.events.map((event) => event.id);
  const result = forgetEvents(mem, { viewer, eventIds, dryRun: dry });
  if (!result.ok) return result;
  const items = mineItems.length ? forgetItemsById(mem, viewer, mineItems, dry) : empty();
  return {
    ...result,
    items: result.items + items.items,
    traces: result.traces + items.traces,
    skipped: result.notFound + (hits.items.length - mineItems.length),
    truncated: hits.truncated,
  };
}

function forgetItemsById(mem, viewer, ids, dry) {
  return finish(mem, { dryRun: dry }, (counts) => {
    const live = ids.filter((id) => mem.db.prepare("SELECT 1 FROM memory_items WHERE id = ? AND owner = ?").get(id, viewer));
    if (live.length) deleteItems(mem, live, mem.now(), counts);
    return counts;
  });
}
