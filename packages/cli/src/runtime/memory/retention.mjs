// Retention: when stored data stops being readable, and how it is physically removed.
//
// TWO SEPARATE THINGS, on purpose:
//   1. LOGICAL EXPIRY is immediate. Every row carries an explicit `expires_at` fixed at write time (event time + retention);
//      every read query filters on it (db.mjs notExpired). At exactly `expires_at` the row is already gone from reads
//      (`expires_at <= now` is expired). Reading, searching, resuming and archiving never change it.
//   2. PHYSICAL CLEANUP is deferred and batched. `physicalCleanup` deletes expired rows in bounded batches, each in its own
//      transaction together with its progress row, so an interruption loses nothing and the next run simply continues (the
//      work list is "whatever is still expired", so a rerun is always safe). It removes the FTS rows (triggers), the
//      checkpoints whose sources expired (their own expiry is the earliest of their sources), flags the items drawn from the
//      removed events `source_expired`, and removes sessions left empty. Confirmed items are NOT removed: they are durable
//      under the disclosed policy (items.mjs) and only flagged when their sources go.
//
// CHANGING RETENTION (`planRetentionChange` / `applyRetentionChange`): shortening applies to existing data; lengthening applies
// only to data that has not yet expired (it never brings expired data back). The plan is computed by running the real change
// inside a transaction and rolling it back, so "N events would expire" is exactly what applying does.

import { clockOf, dryRun, openMemory, placeholders, scrub, transaction } from "./db.mjs";

export const DEFAULT_BATCH_SIZE = 200;
const STARTUP_BATCH_SIZE = 200;
const STARTUP_MAX_BATCHES = 2;
const TASKS = ["events", "checkpoints", "items", "traces", "sessions"];

function progress(db, task, { removed, cursor, partial, at }) {
  db.prepare(
    `INSERT INTO maintenance_progress (task, cursor, state, rows_removed, updated_at, last_completed_at) VALUES (:task, :cursor, :state, :removed, :at, :done)
     ON CONFLICT(task) DO UPDATE SET cursor = excluded.cursor, state = excluded.state, rows_removed = maintenance_progress.rows_removed + :removed,
       updated_at = excluded.updated_at, last_completed_at = COALESCE(excluded.last_completed_at, maintenance_progress.last_completed_at)`,
  ).run({ task, cursor: cursor === null ? null : String(cursor), state: partial ? "partial" : "idle", removed, at, done: partial ? null : at });
}

/** One batch of one task; returns how many rows it removed. Runs inside the caller's transaction. */
const BATCHES = {
  events(db, now, size) {
    const rows = db.prepare("SELECT rid, id FROM events WHERE expires_at <= ? ORDER BY rid LIMIT ?").all(now, size);
    if (rows.length === 0) return { count: 0, cursor: null };
    const ids = rows.map((row) => row.id);
    db.prepare(`UPDATE memory_items SET source_expired = 1 WHERE id IN (SELECT item_id FROM item_sources WHERE event_id IN (${placeholders(ids.length)}))`).run(...ids);
    db.prepare(`DELETE FROM item_sources WHERE event_id IN (${placeholders(ids.length)})`).run(...ids);
    db.prepare(`DELETE FROM events WHERE rid IN (${placeholders(rows.length)})`).run(...rows.map((row) => row.rid));
    return { count: rows.length, cursor: rows[rows.length - 1].rid };
  },
  checkpoints(db, now, size) {
    const rows = db.prepare("SELECT id FROM checkpoints WHERE expires_at <= ? ORDER BY id LIMIT ?").all(now, size);
    if (rows.length > 0) db.prepare(`DELETE FROM checkpoints WHERE id IN (${placeholders(rows.length)})`).run(...rows.map((row) => row.id));
    return { count: rows.length, cursor: rows.length ? rows[rows.length - 1].id : null };
  },
  items(db, now, size) {
    const rows = db.prepare("SELECT rid, id FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ? ORDER BY rid LIMIT ?").all(now, size);
    if (rows.length === 0) return { count: 0, cursor: null };
    const ids = rows.map((row) => row.id);
    db.prepare(`DELETE FROM item_sources WHERE item_id IN (${placeholders(ids.length)})`).run(...ids);
    db.prepare(`DELETE FROM memory_items WHERE rid IN (${placeholders(rows.length)})`).run(...rows.map((row) => row.rid));
    return { count: rows.length, cursor: rows[rows.length - 1].rid };
  },
  traces(db, now, size) {
    const rows = db.prepare("SELECT id FROM retrieval_traces WHERE expires_at <= ? ORDER BY id LIMIT ?").all(now, size);
    if (rows.length > 0) db.prepare(`DELETE FROM retrieval_traces WHERE id IN (${placeholders(rows.length)})`).run(...rows.map((row) => row.id));
    return { count: rows.length, cursor: rows.length ? rows[rows.length - 1].id : null };
  },
  sessions(db, now, size) {
    const rows = db.prepare("SELECT id FROM sessions WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id) ORDER BY id LIMIT ?").all(now, size);
    if (rows.length > 0) db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders(rows.length)})`).run(...rows.map((row) => row.id));
    return { count: rows.length, cursor: rows.length ? rows[rows.length - 1].id : null };
  },
};

/** How many expired rows are still physically present, per task (invisible to reads already). */
export function pendingCleanup(mem) {
  const now = mem.now();
  const one = (sql) => Number(mem.db.prepare(sql).get(now).n);
  return {
    events: one("SELECT COUNT(*) AS n FROM events WHERE expires_at <= ?"),
    checkpoints: one("SELECT COUNT(*) AS n FROM checkpoints WHERE expires_at <= ?"),
    items: one("SELECT COUNT(*) AS n FROM memory_items WHERE expires_at IS NOT NULL AND expires_at <= ?"),
    traces: one("SELECT COUNT(*) AS n FROM retrieval_traces WHERE expires_at <= ?"),
    sessions: one("SELECT COUNT(*) AS n FROM sessions WHERE expires_at <= ? AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.id)"),
  };
}

/**
 * Delete expired rows in bounded, individually committed batches.
 * @param {import('./db.mjs').Memory} mem
 * @param {{batchSize?: number, maxBatches?: number, onBatch?: (task: string, count: number) => void}} [options]
 *   `maxBatches` stops after that many non-empty batches (the rest is left for the next run); `onBatch` runs inside each batch's
 *   transaction (a test seam: throwing there rolls that batch back).
 * @returns {{removed: Record<string, number>, batches: number, complete: boolean}}
 */
export function physicalCleanup(mem, { batchSize = DEFAULT_BATCH_SIZE, maxBatches = Infinity, onBatch } = {}) {
  const size = Math.max(1, Math.min(5000, Math.floor(batchSize)));
  const now = mem.now(); // one clock reading for the whole run: a row that expires mid-run waits for the next one
  const removed = Object.fromEntries(TASKS.map((task) => [task, 0]));
  let batches = 0;
  let stopped = false;
  for (const task of TASKS) {
    while (!stopped) {
      if (batches >= maxBatches) {
        stopped = true;
        break;
      }
      const count = transaction(mem, () => {
        const batch = BATCHES[task](mem.db, now, size);
        if (batch.count === 0) return 0;
        onBatch?.(task, batch.count);
        progress(mem.db, task, { removed: batch.count, cursor: batch.cursor, partial: batch.count === size, at: mem.now() });
        return batch.count;
      });
      if (count === 0) break;
      batches += 1;
      removed[task] += count;
    }
  }
  const complete = !Object.values(pendingCleanup(mem)).some((n) => n > 0);
  if (Object.values(removed).some((n) => n > 0)) scrub(mem);
  return { removed, batches, complete };
}

/**
 * Bounded cleanup for the start of a write-capable memory command. Never throws: a store that cannot be opened is skipped.
 * @returns {ReturnType<typeof physicalCleanup> | null}
 */
export function startupMaintenance(options = {}) {
  let mem;
  try {
    mem = openMemory({ ...options, create: false });
    if (mem === null) return null;
    return physicalCleanup(mem, { batchSize: STARTUP_BATCH_SIZE, maxBatches: STARTUP_MAX_BATCHES });
  } catch {
    return null;
  } finally {
    mem?.close();
  }
}

/** Rebuild both full-text indexes from the rows that are stored and unexpired (the safe reindex: forgotten rows are not rows). */
export function reindexSearch(mem) {
  const now = mem.now();
  transaction(mem, () => {
    mem.db.exec("DELETE FROM events_fts; DELETE FROM items_fts;");
    mem.db.prepare("INSERT INTO events_fts(rowid, content) SELECT rid, content FROM events WHERE expires_at > ?").run(now);
    mem.db.prepare("INSERT INTO items_fts(rowid, content) SELECT rid, content FROM memory_items WHERE expires_at IS NULL OR expires_at > ?").run(now);
  });
  scrub(mem);
}

// Changing the retention period -----------------------------------------------------------------------

// The retention clock starts at the earlier of the event time and the time it was stored (capture clamps a future event time).
const NEW_EVENT_EXPIRY = "strftime('%Y-%m-%dT%H:%M:%fZ', min(event_time, ingested_at), :mod)";

function visibleCounts(db, now) {
  const n = (sql) => Number(db.prepare(sql).get(now).n);
  return {
    events: n("SELECT COUNT(*) AS n FROM events WHERE expires_at > ?"),
    checkpoints: n("SELECT COUNT(*) AS n FROM checkpoints WHERE expires_at > ?"),
    sessions: n("SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?"),
  };
}

function changeRetention(mem, days) {
  const { db } = mem;
  const now = mem.now();
  const mod = `+${days} days`;
  const before = visibleCounts(db, now);
  const keptLonger = Number(db.prepare(`SELECT COUNT(*) AS n FROM events WHERE expires_at > :now AND ${NEW_EVENT_EXPIRY} > expires_at`).get({ now, mod }).n);
  db.prepare(`UPDATE events SET expires_at = ${NEW_EVENT_EXPIRY} WHERE ${NEW_EVENT_EXPIRY} < expires_at OR (expires_at > :now AND ${NEW_EVENT_EXPIRY} > expires_at)`).run({ now, mod });
  db.exec("UPDATE sessions SET expires_at = COALESCE((SELECT MAX(e.expires_at) FROM events e WHERE e.session_id = sessions.id), expires_at)");
  // A checkpoint cannot outlive the earliest event it covers.
  db.exec(
    `UPDATE checkpoints SET expires_at = MIN(expires_at, COALESCE((SELECT MIN(e.expires_at) FROM events e WHERE e.session_id = checkpoints.session_id AND e.seq <= checkpoints.covered_seq), expires_at))`,
  );
  const after = visibleCounts(db, now);
  return {
    days,
    visibleBefore: before,
    events: { wouldExpire: before.events - after.events, keptLonger },
    checkpoints: { wouldExpire: before.checkpoints - after.checkpoints },
    sessions: { wouldExpire: before.sessions - after.sessions },
  };
}

function checkDays(days) {
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new RangeError("days must be an integer between 1 and 3650");
}

/** What `applyRetentionChange` would do, computed by doing it and rolling back. Writes nothing. */
export function planRetentionChange(mem, { days }) {
  checkDays(days);
  return dryRun(mem, () => changeRetention(mem, days));
}

/** Recompute `expires_at` of stored events (and the sessions and checkpoints that follow them) for a new retention period. */
export function applyRetentionChange(mem, { days }) {
  checkDays(days);
  return transaction(mem, () => changeRetention(mem, days));
}

export { clockOf };
