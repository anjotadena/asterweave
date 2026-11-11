// Lexical search over stored events and memory items, plus the retrieval interface later phases plug into.
//
// - FTS5 keyword search. User text is tokenised and each term is double-quoted before it reaches MATCH, so it can neither
//   raise a syntax error nor inject FTS operators. All terms must match (AND); only when that finds nothing and there are
//   several terms does it fall back to ANY term, and then every result is marked `weak` with how many terms it matched.
// - Filters: date range (event time for events, recorded time for items), session, task. With no keyword it browses by time.
// - AUTHORISATION is part of every query, not a post-filter: a private session is visible to its owner only, even in a
//   repository other people use; a shared one to readers of that repository; user-scope items to their owner only.
// - EXPIRY is part of every query: an event or session past `expires_at` is gone from results the instant it expires, whether or
//   not maintenance has deleted it yet. Archived sessions are searched like any other until they expire. Searching never writes
//   to a session and never moves an expiry (the optional trace row is a separate, content-free record).
// - HONEST ABOUT EVIDENCE: `evidence` is 'strong' (every term matched), 'weak' (partial matches only) or 'none'.

import { addDays, notExpired } from "./db.mjs";
import { formatLocal } from "./dates.mjs";
import { toItem } from "./items.mjs";
import { latestCheckpoint } from "./checkpoints.mjs";
import { readEvents } from "./capture.mjs";
import { findSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";

export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 100;
const MAX_TERMS = 12;

/** Distinct lower-case word terms of free text (at most 12, each at most 64 characters). */
export function tokenize(text) {
  const words = String(text ?? "").normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.map((word) => word.slice(0, 64)))].slice(0, MAX_TERMS);
}

/** An FTS5 MATCH expression from terms; every term is a quoted string (terms contain only letters and digits). */
export function matchExpression(terms, mode) {
  return terms.map((term) => `"${term}"`).join(mode === "any" ? " OR " : " ");
}

const EVENT_SQL = (fts) => `
  SELECT e.id, e.session_id, e.seq, e.type, e.role, e.event_time, e.status, e.truncated, s.title, s.state, s.task_id,
         ${fts ? "snippet(events_fts, 0, '[', ']', '…', 14) AS snip, bm25(events_fts) AS score, e.content AS content" : "substr(e.content, 1, 160) AS snip, 0.0 AS score, e.content AS content"}
  FROM ${fts ? "events_fts JOIN events e ON e.rid = events_fts.rowid" : "events e"} JOIN sessions s ON s.id = e.session_id
  WHERE ${fts ? "events_fts MATCH :q AND " : ""}s.repo_id = :repo AND (s.owner = :viewer OR s.visibility = 'shared')
    AND s.expires_at > :now AND e.expires_at > :now
    AND (:since IS NULL OR e.event_time >= :since) AND (:until IS NULL OR e.event_time <= :until)
    AND (:session IS NULL OR e.session_id = :session) AND (:task IS NULL OR s.task_id = :task)
  ORDER BY ${fts ? "score, " : ""}e.event_time DESC, e.rid DESC LIMIT :limit`;

const ITEM_SQL = (fts) => `
  SELECT i.*, ${fts ? "snippet(items_fts, 0, '[', ']', '…', 14) AS snip, bm25(items_fts) AS score" : "substr(i.content, 1, 160) AS snip, 0.0 AS score"}
  FROM ${fts ? "items_fts JOIN memory_items i ON i.rid = items_fts.rowid" : "memory_items i"}
  WHERE ${fts ? "items_fts MATCH :q AND " : ""}((i.scope = 'user' AND i.owner = :viewer) OR (i.scope != 'user' AND i.repo_id = :repo AND (i.owner = :viewer OR i.visibility = 'shared')))
    AND ${notExpired("i.expires_at")}
    AND (:since IS NULL OR i.recorded_at >= :since) AND (:until IS NULL OR i.recorded_at <= :until)
    AND (:session IS NULL OR i.session_id = :session)
  ORDER BY ${fts ? "score, " : ""}i.recorded_at DESC, i.rid DESC LIMIT :limit`;

const matchedCount = (terms, text) => {
  const lower = String(text).toLowerCase();
  return terms.filter((term) => lower.includes(term)).length;
};

/**
 * @param {import('./db.mjs').Memory} mem
 * @param {{viewer: string, repoId: string, query?: string, since?: string|null, until?: string|null, sessionId?: string|null, taskId?: string|null,
 *   include?: Array<'events'|'items'>, limit?: number, timeZone?: string, trace?: boolean}} input  `since` / `until` are ISO instants (dates.mjs resolves phrases)
 * @param {object} [settings]
 */
export function searchMemory(mem, input, settings) {
  const cfg = withDefaults(settings);
  const limit = Math.max(1, Math.min(SEARCH_MAX_LIMIT, Number.isInteger(input.limit) ? input.limit : SEARCH_DEFAULT_LIMIT));
  const include = input.include ?? ["events", "items"];
  const terms = tokenize(input.query);
  const notes = [];
  if (String(input.query ?? "").trim() !== "" && terms.length === 0) {
    return { ok: true, query: input.query, terms, mode: "none", evidence: "none", events: [], items: [], truncated: false, notes: ["The search text has no letters or digits to match."] };
  }
  const since = input.since ?? null;
  const until = input.until ?? null;
  if (since && until && since > until) return { ok: false, code: "USAGE", message: "--since is later than --until." };
  const started = Date.now();
  const base = { viewer: input.viewer, repo: input.repoId, now: mem.now(), since, until, session: input.sessionId ?? null, task: input.taskId ?? null, limit: limit + 1 };

  const run = (mode) => {
    const fts = terms.length > 0;
    const params = fts ? { ...base, q: matchExpression(terms, mode) } : base;
    const events = include.includes("events") ? mem.db.prepare(EVENT_SQL(fts)).all(params) : [];
    const items = include.includes("items") && input.taskId == null ? mem.db.prepare(ITEM_SQL(fts)).all({ viewer: params.viewer, repo: params.repo, now: params.now, since, until, session: base.session, limit: limit + 1, ...(fts ? { q: params.q } : {}) }) : [];
    return { events, items };
  };

  let mode = terms.length === 0 ? "browse" : "all";
  let found = run(mode === "browse" ? "all" : "all");
  if (terms.length > 1 && found.events.length === 0 && found.items.length === 0) {
    mode = "any";
    found = run("any");
  }

  const shapeEvent = (row) => ({
    kind: "event",
    id: row.id,
    sessionId: row.session_id,
    sessionTitle: row.title,
    archived: row.state === "archived",
    taskId: row.task_id,
    seq: Number(row.seq),
    eventType: row.type,
    role: row.role,
    eventTime: row.event_time,
    eventTimeLocal: formatLocal(row.event_time, input.timeZone),
    snippet: row.snip,
    status: row.status,
    truncated: row.truncated === 1,
    matchedTerms: terms.length > 0 ? matchedCount(terms, row.content) : null,
    score: Number(row.score),
  });
  const shapeItem = (row) => ({
    kind: "item",
    ...toItem(row),
    recordedAtLocal: formatLocal(row.recorded_at, input.timeZone),
    snippet: row.snip,
    matchedTerms: terms.length > 0 ? matchedCount(terms, row.content) : null,
    score: Number(row.score),
  });
  const rank = (list) => (mode === "any" ? list.sort((a, b) => b.matchedTerms - a.matchedTerms || a.score - b.score) : list);
  let events = rank(found.events.map(shapeEvent));
  let items = rank(found.items.map(shapeItem));
  const truncated = events.length > limit || items.length > limit;
  events = events.slice(0, limit);
  items = items.slice(0, limit);

  const total = events.length + items.length;
  const evidence = total === 0 ? "none" : mode === "any" ? "weak" : "strong";
  if (total === 0) notes.push("No stored memory matches. Nothing is known about this from memory.");
  if (evidence === "weak") notes.push(`No result contains all ${terms.length} terms; these match only some of them. Treat them as weak evidence.`);
  if (events.some((event) => event.status === "incomplete")) notes.push("Some events are incomplete (the stream was interrupted); their text may be cut off.");
  if (events.some((event) => event.truncated)) notes.push("Some events were truncated when stored.");

  const result = { ok: true, query: input.query ?? "", terms, mode, evidence, events, items, truncated, notes };
  if (input.trace === true) recordTrace(mem, { owner: input.viewer, repoId: input.repoId, sessionId: input.sessionId ?? null, selectedIds: [...events, ...items].map((hit) => hit.id), rationale: `lexical:${mode}`, tokenEstimate: null, cacheState: "none", timingMs: Date.now() - started }, cfg);
  return result;
}

/**
 * Store what a retrieval chose and why: ids and numbers only, never text. Failure is swallowed (a trace is diagnostics, not data).
 * @returns {boolean} whether it was stored
 */
export function recordTrace(mem, trace, settings) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return false;
  try {
    const at = mem.now();
    mem.db
      .prepare("INSERT INTO retrieval_traces (owner, repo_id, session_id, created_at, expires_at, selected_ids, rationale, token_estimate, cache_state, timing_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(trace.owner, trace.repoId ?? null, trace.sessionId ?? null, at, addDays(at, cfg.historyRetentionDays), JSON.stringify((trace.selectedIds ?? []).slice(0, 200)), String(trace.rationale ?? "").slice(0, 200), trace.tokenEstimate ?? null, trace.cacheState ?? null, trace.timingMs ?? null);
    return true;
  } catch {
    return false;
  }
}

/**
 * The retrieval interface a context builder uses (a later phase): what could be put in front of a model for this viewer and
 * repository, authorised and unexpired. It selects nothing and ranks nothing beyond recency; budgeting is the caller's job.
 * @returns {{items: object[], recentEvents: object[], checkpoint: object|null}}
 */
export function listCandidates(mem, { viewer, repoId, sessionId = null, itemStatuses = ["confirmed"], includeScopes = ["user", "repository", "session"], limit = 8 }) {
  const cap = Math.max(1, Math.min(50, limit));
  const rows = mem.db
    .prepare(
      `SELECT i.* FROM memory_items i
       WHERE ((i.scope = 'user' AND i.owner = :viewer) OR (i.scope != 'user' AND i.repo_id = :repo AND (i.owner = :viewer OR i.visibility = 'shared')))
         AND ${notExpired("i.expires_at")}
         AND (i.scope != 'session' OR i.session_id = :session)
       ORDER BY i.recorded_at DESC, i.rid DESC LIMIT 200`,
    )
    .all({ viewer, repo: repoId, now: mem.now(), session: sessionId });
  const items = rows.map(toItem).filter((item) => itemStatuses.includes(item.status) && includeScopes.includes(item.scope)).slice(0, cap);
  let recentEvents = [];
  let checkpoint = null;
  if (sessionId) {
    const found = findSession(mem, sessionId, viewer);
    if (found.ok && found.session.repoId === repoId) {
      const all = readEvents(mem, found.session.id, { limit: 2000 });
      recentEvents = all.slice(-cap);
      checkpoint = latestCheckpoint(mem, found.session.id, viewer);
    }
  }
  return { items, recentEvents, checkpoint };
}

/**
 * Optional semantic retrieval. OFF by default and not implemented in this build: no retriever ships, and nothing calls one.
 * The contract a future implementation must meet:
 * @typedef {object} SemanticRetriever
 * @property {string} name
 * @property {(query: string, candidates: Array<{id: string, kind: 'event'|'item', text: string}>, options: {limit: number}) => Promise<string[]>} rank
 *   Returns candidate ids best first. It receives ALREADY-AUTHORISED, unexpired, redacted candidates only, and must not persist them.
 */

/** True only when the user turned the setting on AND a retriever with the expected shape was supplied. */
export function semanticRetrievalAllowed(settings, retriever) {
  return settings?.semanticSearchEnabled === true && typeof retriever?.name === "string" && typeof retriever?.rank === "function";
}
