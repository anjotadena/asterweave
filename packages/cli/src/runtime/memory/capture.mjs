// Capture API: the one way events enter the memory database.
//
// Guarantees (each has a test):
//   - IDEMPOTENT by event id. Replaying an event never duplicates it. The only change a replay can make is the single upgrade
//     incomplete -> complete (a streamed message that was cut off and later finished); a complete event is never modified.
//   - ORDERED. Each session has its own counter; `seq` is allocated inside a `BEGIN IMMEDIATE` transaction, so concurrent
//     writers get distinct, gap-free numbers and UNIQUE(session_id, seq) backs it up. Reads order by seq.
//   - REDACTED BEFORE PERSISTENCE, then bounded: redaction sees the whole text, truncation comes after (redact.mjs).
//   - BOUNDED. Message text and tool output have separate caps; a cut event stores `truncated = 1` and the original length.
//   - HONEST. Streamed output that was interrupted is stored `incomplete`, never `complete`. Hidden reasoning (types such as
//     "thinking") is never stored; only visible message and tool events are, and only whitelisted fields are copied.
//   - EXPLICIT ABOUT FAILURE. A storage error returns `{ok:false, saved:false, degraded:true}`; nothing here ever reports
//     `saved: true` for a write that did not commit. `memory.enabled = false` returns `{ok:true, saved:false, status:'disabled'}`
//     without touching the database; existing data is kept.
//   - EXPIRY IS FIXED AT WRITE: expires_at = event time + memory.historyRetentionDays, with the event time clamped to "now" so
//     a future-dated event cannot buy extra retention. An event already past its expiry is not stored.

import { addDays, degradedResult, openMemory, toIso, transaction } from "./db.mjs";
import { boundText, cleanField, redactForMemory } from "./redact.mjs";
import { openSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";

export const MESSAGE_MAX_CHARS = 64_000;
export const TOOL_OUTPUT_MAX_CHARS = 16_000;
export const EVENT_ID_MAX = 200;
const TYPES = new Set(["message", "tool_call", "tool_result", "system"]);
const ROLES = new Set(["user", "assistant", "tool", "system"]);
/** Event types that carry hidden model reasoning. They are dropped, never stored. */
const HIDDEN_TYPES = new Set(["thinking", "reasoning", "redacted_thinking", "chain_of_thought", "chain-of-thought", "scratchpad", "reasoning_content"]);

const short = (value, limit = 200) => (typeof value === "string" && value.trim() !== "" ? cleanField(value, limit) : null);

/**
 * @typedef {object} CaptureEvent
 * @property {string} id            Stable idempotency key (the same logical event always has the same id).
 * @property {'message'|'tool_call'|'tool_result'|'system'} type
 * @property {'user'|'assistant'|'tool'|'system'} [role]
 * @property {string} content       Visible text only.
 * @property {string} [agentId] @property {string} [model] @property {string} [provider]
 * @property {string} [toolCallId]  Links a tool_result to its tool_call.
 * @property {string|number|Date} [eventTime]  When it happened (default: now).
 * @property {'complete'|'incomplete'} [status] @property {boolean} [interrupted] @property {boolean} [complete]
 * @property {string} [artifactRef] Reference to a stored artifact (never the artifact itself).
 * @property {number} [sourceChars] @property {boolean} [sourceTruncated]  The content was already cut by the caller (a bounded tool-output
 *   excerpt) from a source of `sourceChars` characters: with `sourceTruncated: true` the event is stored `truncated = 1` with that length as
 *   `original_chars`, so the metadata describes the source, not the excerpt.
 */

/**
 * Append one event to a session.
 * @param {import('./db.mjs').Memory} mem
 * @param {string} sessionId
 * @param {CaptureEvent} event
 * @param {object} [settings]  memory settings (enabled, historyRetentionDays)
 * @param {{viewer?: string}} [options]  when given, must be the session's owner
 */
export function appendEvent(mem, sessionId, event, settings, options = {}) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
  try {
    const id = typeof event?.id === "string" ? event.id.trim() : "";
    if (id === "" || id.length > EVENT_ID_MAX) return rejected("id_invalid", "An event needs a stable string id of at most 200 characters.");
    const type = String(event.type ?? "message");
    if (HIDDEN_TYPES.has(type.toLowerCase())) return { ok: true, saved: false, status: "skipped", reason: "hidden_reasoning" };
    if (!TYPES.has(type)) return rejected("type_invalid", `Event type must be one of ${[...TYPES].join(", ")}.`);
    const role = event.role === undefined || event.role === null ? null : String(event.role);
    if (role !== null && !ROLES.has(role)) return rejected("role_invalid", `Event role must be one of ${[...ROLES].join(", ")}.`);

    const nowIso = mem.now();
    let eventTime = nowIso;
    if (event.eventTime !== undefined && event.eventTime !== null) {
      try {
        eventTime = toIso(event.eventTime);
      } catch {
        return rejected("time_invalid", "eventTime must be a valid date or timestamp.");
      }
    }
    // The retention clock starts at the event time, but never later than now.
    const basis = eventTime < nowIso ? eventTime : nowIso;
    const expiresAt = addDays(basis, cfg.historyRetentionDays);
    const incomplete = event.status === "incomplete" || event.interrupted === true || event.complete === false;
    const status = incomplete ? "incomplete" : "complete";

    const redacted = redactForMemory(event.content);
    const cut = boundText(redacted.text, type === "tool_result" || type === "tool_call" ? TOOL_OUTPUT_MAX_CHARS : MESSAGE_MAX_CHARS);
    // A caller that already cut the content (a bounded tool excerpt) says how long the source was: the metadata describes the source.
    const source = event.sourceTruncated === true && Number.isSafeInteger(event.sourceChars) && event.sourceChars >= 0 ? event.sourceChars : null;
    const bounded = source === null ? cut : { ...cut, truncated: true, originalChars: source };

    return transaction(mem, () => {
      const { db } = mem;
      const session = db.prepare("SELECT id, owner, state FROM sessions WHERE id = ?").get(sessionId);
      if (!session || (options.viewer !== undefined && session.owner !== options.viewer)) return rejected("session_not_found", "No such session.");
      if (isTombstoned(db, "session", sessionId) || isTombstoned(db, "event", id)) return { ok: true, saved: false, status: "forgotten" };

      const existing = db.prepare("SELECT rid, session_id, seq, status FROM events WHERE id = ?").get(id);
      if (existing) {
        if (existing.session_id !== sessionId) return rejected("id_conflict", "An event with this id belongs to another session.");
        if (existing.status === "incomplete" && status === "complete") {
          // The one permitted change: the finished version of a cut-off event.
          db.prepare("UPDATE events SET content = ?, status = 'complete', truncated = ?, original_chars = ?, tool_call_id = COALESCE(?, tool_call_id), artifact_ref = COALESCE(?, artifact_ref) WHERE rid = ?")
            .run(bounded.text, bounded.truncated ? 1 : 0, bounded.originalChars, short(event.toolCallId), short(event.artifactRef, 500), existing.rid);
          return { ok: true, saved: true, duplicate: true, upgraded: true, id, sessionId, seq: Number(existing.seq), status: "complete", truncated: bounded.truncated };
        }
        return { ok: true, saved: true, duplicate: true, upgraded: false, id, sessionId, seq: Number(existing.seq), status: existing.status };
      }
      if (session.state === "archived") return rejected("session_archived", "The session is archived; unarchive it to add events.");
      if (expiresAt <= nowIso) return { ok: true, saved: false, status: "expired", reason: "past_retention" };

      const seq = Number(db.prepare("UPDATE sessions SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq").get(sessionId).last_seq);
      db.prepare(
        `INSERT INTO events (id, session_id, seq, type, role, content, agent_id, model, provider, tool_call_id, event_time, ingested_at, expires_at, status, truncated, original_chars, artifact_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, sessionId, seq, type, role, bounded.text, short(event.agentId), short(event.model), short(event.provider), short(event.toolCallId), eventTime, nowIso, expiresAt, status, bounded.truncated ? 1 : 0, bounded.originalChars, short(event.artifactRef, 500));
      db.prepare("UPDATE sessions SET last_activity_at = ?, updated_at = ?, expires_at = CASE WHEN expires_at > ? THEN expires_at ELSE ? END WHERE id = ?").run(nowIso, nowIso, expiresAt, expiresAt, sessionId);
      return { ok: true, saved: true, duplicate: false, upgraded: false, id, sessionId, seq, status, truncated: bounded.truncated, redactions: redacted.count, expiresAt };
    });
  } catch (error) {
    return degradedResult(error);
  }
}

const rejected = (reason, message) => ({ ok: false, saved: false, status: "rejected", reason, message });

/**
 * Convenience for callers that hold options rather than an open database: open, make sure the session exists, append, close.
 * Every failure, including an unavailable SQLite or an unwritable directory, comes back as a degraded result.
 * @param {object} options  openMemory options (userDir, now, fs, ...)
 * @param {{owner: string, identity?: object, repoId?: string, sessionId?: string, taskId?: string, visibility?: string, title?: string}} session
 */
export function captureEvent(options, session, event, settings) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
  let mem;
  try {
    mem = openMemory(options);
    const opened = openSession(mem, { ...session, id: session.sessionId }, cfg);
    if (!opened.ok || opened.saved === false) return opened;
    return appendEvent(mem, opened.session.id, event, cfg, { viewer: session.owner });
  } catch (error) {
    return degradedResult(error);
  } finally {
    mem?.close();
  }
}

/** Events of a session in order, for a viewer who may read it. Expired events are never returned. */
export function readEvents(mem, sessionId, { limit = 200, afterSeq = 0 } = {}) {
  const now = mem.now();
  return mem.db
    .prepare(
      `SELECT id, seq, type, role, content, agent_id, model, provider, tool_call_id, event_time, ingested_at, expires_at, status, truncated, original_chars, artifact_ref
       FROM events WHERE session_id = :session AND seq > :after AND expires_at > :now ORDER BY seq LIMIT :limit`,
    )
    .all({ session: sessionId, after: afterSeq, now, limit: Math.max(1, Math.min(2000, limit)) })
    .map(toEvent);
}

/**
 * The NEWEST events of a session (at most `limit`, after `afterSeq`), returned oldest first. Same filters as readEvents: expired events are
 * never returned, and the caller checks the viewer may read the session. One bounded read (ORDER BY seq DESC LIMIT n), not a scan from seq 1.
 */
export function readLatestEvents(mem, sessionId, { limit = 24, afterSeq = 0 } = {}) {
  const now = mem.now();
  return mem.db
    .prepare(
      `SELECT id, seq, type, role, content, agent_id, model, provider, tool_call_id, event_time, ingested_at, expires_at, status, truncated, original_chars, artifact_ref
       FROM events WHERE session_id = :session AND seq > :after AND expires_at > :now ORDER BY seq DESC LIMIT :limit`,
    )
    .all({ session: sessionId, after: afterSeq, now, limit: Math.max(1, Math.min(2000, limit)) })
    .map(toEvent)
    .reverse();
}

export function toEvent(row) {
  return {
    id: row.id,
    seq: Number(row.seq),
    type: row.type,
    role: row.role,
    content: row.content,
    agentId: row.agent_id,
    model: row.model,
    provider: row.provider,
    toolCallId: row.tool_call_id,
    eventTime: row.event_time,
    ingestedAt: row.ingested_at,
    expiresAt: row.expires_at,
    status: row.status,
    truncated: row.truncated === 1,
    originalChars: row.original_chars === null ? null : Number(row.original_chars),
    artifactRef: row.artifact_ref,
  };
}
