// Memory items: small, durable statements (a decision, a constraint, a preference...) with provenance.
//
// STATUS RULES (each has a test)
//   - A new item is ALWAYS `proposed`, whoever wrote it. The only road to `confirmed` is `confirmItem` with `explicit: true`
//     (a person's own act: the CLI sets it; nothing automatic does). So an `assistant_suggestion` can never become confirmed,
//     and can never replace a confirmed item, without that explicit call.
//   - Changing a CONFIRMED item (dispute, supersede, correct) also needs `explicit: true`.
//   - Superseding or correcting never edits history: the old item becomes `superseded`, keeps its text, and links forward
//     (`replaced_by`) while the new one links back (`supersedes`).
//   - Only the owner changes an item.
//
// RETENTION. Unconfirmed items expire `summaryRetentionDays` after they were recorded. A CONFIRMED item has no expiry
// (`expires_at` NULL): a deliberate decision is durable until the owner forgets it (forget.mjs) or supersedes it. This is the
// disclosed exception to time-based retention. When the events an item was drawn from expire or are forgotten, the item keeps
// its text and is flagged `source_expired`; forgetting a source event deletes the items drawn from it.
//
// VISIBILITY. user-scope items are for their owner only. repository/session items are the owner's unless `visibility` is
// 'shared', in which case other readers of the SAME repository may read them.

import { stringifyJson } from "../../json.mjs";
import { addDays, degradedResult, newId, notExpired, placeholders, transaction } from "./db.mjs";
import { cleanField } from "./redact.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";

export const ITEM_KINDS = Object.freeze(["decision", "requirement", "constraint", "preference", "observation"]);
export const ITEM_SCOPES = Object.freeze(["user", "repository", "session"]);
export const ITEM_ORIGINS = Object.freeze(["user_decision", "assistant_suggestion", "tool_observation"]);
export const ITEM_CONTENT_MAX = 4000;
const SOURCES_MAX = 50;

export function toItem(row) {
  let sources = [];
  try {
    sources = JSON.parse(row.source_event_ids);
  } catch {
    // a damaged list reads as empty
  }
  return {
    id: row.id,
    owner: row.owner,
    repoId: row.repo_id,
    sessionId: row.session_id,
    visibility: row.visibility,
    scope: row.scope,
    kind: row.kind,
    content: row.content,
    status: row.status,
    origin: row.origin,
    confidence: row.confidence,
    sourceEventIds: Array.isArray(sources) ? sources : [],
    recordedAt: row.recorded_at,
    effectiveAt: row.effective_at,
    lastVerifiedAt: row.last_verified_at,
    expiresAt: row.expires_at,
    supersedes: row.supersedes,
    replacedBy: row.replaced_by,
    sourceExpired: row.source_expired === 1,
  };
}

/** May `viewer` read this row? The owner always; others only a shared, non-user-scope item of the repository they are reading. */
export function canReadItem(row, viewer, repoId) {
  if (row.owner === viewer) return true;
  return row.scope !== "user" && row.visibility === "shared" && repoId !== undefined && repoId !== null && row.repo_id === repoId;
}

const fail = (code, message) => ({ ok: false, code, message });

/** Event ids from `ids` that `owner` may cite: they exist, are unexpired and belong to a session the owner can read (in `repoId` when given). */
function citableEvents(mem, ids, owner, repoId) {
  if (ids.length === 0) return [];
  const rows = mem.db
    .prepare(
      `SELECT e.id FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.id IN (${placeholders(ids.length)}) AND e.expires_at > ? AND (s.owner = ? OR s.visibility = 'shared') AND (? IS NULL OR s.repo_id = ?)`,
    )
    .all(...ids, mem.now(), owner, repoId ?? null, repoId ?? null);
  return rows.map((row) => row.id);
}

function insertItem(mem, row, sources) {
  mem.db
    .prepare(
      `INSERT INTO memory_items (id, owner, repo_id, session_id, visibility, scope, kind, content, status, origin, confidence, source_event_ids,
         recorded_at, effective_at, last_verified_at, expires_at, supersedes, replaced_by, source_expired, updated_at)
       VALUES (:id, :owner, :repo_id, :session_id, :visibility, :scope, :kind, :content, :status, :origin, :confidence, :source_event_ids,
         :recorded_at, :effective_at, :last_verified_at, :expires_at, :supersedes, NULL, :source_expired, :recorded_at)`,
    )
    .run({ ...row, source_event_ids: stringifyJson(sources) });
  const link = mem.db.prepare("INSERT OR IGNORE INTO item_sources (item_id, event_id) VALUES (?, ?)");
  for (const eventId of sources) link.run(row.id, eventId);
}

/**
 * Propose a new item (status `proposed`).
 * @param {import('./db.mjs').Memory} mem
 * @param {{id?: string, owner: string, repoId?: string|null, sessionId?: string|null, scope?: string, kind: string, content: string, origin: string,
 *   visibility?: 'private'|'shared', confidence?: number|null, sourceEventIds?: string[], effectiveAt?: string}} input
 * @param {object} [settings]
 */
export function proposeItem(mem, input, settings) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
  try {
    const scope = input.scope ?? cfg.defaultScope;
    if (!ITEM_SCOPES.includes(scope)) return fail("USAGE", `scope must be one of ${ITEM_SCOPES.join(", ")}.`);
    if (!ITEM_KINDS.includes(input.kind)) return fail("USAGE", `kind must be one of ${ITEM_KINDS.join(", ")}.`);
    if (!ITEM_ORIGINS.includes(input.origin)) return fail("USAGE", `origin must be one of ${ITEM_ORIGINS.join(", ")}.`);
    if (typeof input.owner !== "string" || input.owner === "") return fail("USAGE", "An item needs an owner.");
    if ((scope === "repository" || scope === "session") && !input.repoId) return fail("USAGE", `A ${scope}-scope item needs a repository.`);
    if (scope === "session" && !input.sessionId) return fail("USAGE", "A session-scope item needs a session id.");
    if (input.confidence !== undefined && input.confidence !== null && !(typeof input.confidence === "number" && input.confidence >= 0 && input.confidence <= 1)) return fail("USAGE", "confidence must be between 0 and 1.");
    const content = cleanField(input.content, ITEM_CONTENT_MAX);
    if (content === null) return fail("USAGE", "An item needs text.");
    const wanted = [...new Set((input.sourceEventIds ?? []).map(String))].slice(0, SOURCES_MAX);
    const id = typeof input.id === "string" && input.id !== "" ? input.id.slice(0, 120) : newId("mi");
    return transaction(mem, () => {
      if (isTombstoned(mem.db, "item", id)) return { ok: true, saved: false, status: "forgotten" };
      if (mem.db.prepare("SELECT 1 FROM memory_items WHERE id = ?").get(id)) return fail("ITEM_EXISTS", "An item with this id already exists.");
      const sources = citableEvents(mem, wanted, input.owner, input.repoId ?? null);
      if (sources.length !== wanted.length) return fail("SOURCE_NOT_FOUND", "A cited source event does not exist, has expired, or is not readable by the owner.");
      const at = mem.now();
      insertItem(mem, {
        id, owner: input.owner, repo_id: input.repoId ?? null, session_id: scope === "session" ? input.sessionId : null,
        visibility: input.visibility === "shared" ? "shared" : "private", scope, kind: input.kind, content, status: "proposed", origin: input.origin,
        confidence: input.confidence ?? null, recorded_at: at, effective_at: input.effectiveAt ?? null, last_verified_at: null,
        expires_at: addDays(at, cfg.summaryRetentionDays), supersedes: null, source_expired: 0,
      }, sources);
      return { ok: true, saved: true, item: toItem(mem.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id)) };
    });
  } catch (error) {
    return degradedResult(error);
  }
}

/** One readable item by exact id or unique prefix (>= 6 characters). */
export function findItem(mem, idOrPrefix, viewer, { repoId } = {}) {
  const text = String(idOrPrefix ?? "");
  const now = mem.now();
  const rows = mem.db
    .prepare(`SELECT * FROM memory_items WHERE (id = :id OR (length(:id) >= 6 AND substr(id, 1, length(:id)) = :id)) AND ${notExpired("expires_at")} LIMIT 5`)
    .all({ id: text, now });
  const visible = rows.filter((row) => canReadItem(row, viewer, repoId));
  const exact = visible.find((row) => row.id === text);
  if (exact) return { ok: true, row: exact, item: toItem(exact) };
  if (visible.length === 1) return { ok: true, row: visible[0], item: toItem(visible[0]) };
  if (visible.length > 1) return fail("ITEM_AMBIGUOUS", "More than one item starts with that prefix; give more characters.");
  return fail("ITEM_NOT_FOUND", "No readable item has that id.");
}

function ownedItem(mem, idOrPrefix, viewer) {
  const found = findItem(mem, idOrPrefix, viewer);
  if (!found.ok) return found;
  if (found.row.owner !== viewer) return fail("ITEM_NOT_FOUND", "No readable item has that id.");
  return found;
}

const needExplicit = (what) => fail("CONFIRMATION_REQUIRED", `${what} needs the owner's explicit confirmation (an explicit user call, never an automatic one).`);

/** proposed or disputed -> confirmed. `explicit` must be true. Confirmed items have no expiry. */
export function confirmItem(mem, idOrPrefix, viewer, { explicit } = {}) {
  if (explicit !== true) return needExplicit("Confirming an item");
  return guarded(() => {
    const found = ownedItem(mem, idOrPrefix, viewer);
    if (!found.ok) return found;
    const row = found.row;
    if (row.status === "confirmed") return { ok: true, changed: false, item: found.item };
    if (row.status !== "proposed" && row.status !== "disputed") return fail("ITEM_STATE", `A ${row.status} item cannot be confirmed.`);
    const at = mem.now();
    transaction(mem, () => mem.db.prepare("UPDATE memory_items SET status = 'confirmed', expires_at = NULL, last_verified_at = ?, effective_at = COALESCE(effective_at, ?), updated_at = ? WHERE id = ?").run(at, at, at, row.id));
    return { ok: true, changed: true, item: toItem(mem.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(row.id)) };
  });
}

/** proposed or confirmed -> disputed. Disputing a CONFIRMED item needs `explicit: true`; it then loses its durability. */
export function disputeItem(mem, idOrPrefix, viewer, { explicit, summaryRetentionDays } = {}) {
  return guarded(() => {
    const found = ownedItem(mem, idOrPrefix, viewer);
    if (!found.ok) return found;
    const row = found.row;
    if (row.status === "disputed") return { ok: true, changed: false, item: found.item };
    if (row.status !== "proposed" && row.status !== "confirmed") return fail("ITEM_STATE", `A ${row.status} item cannot be disputed.`);
    if (row.status === "confirmed" && explicit !== true) return needExplicit("Disputing a confirmed item");
    const at = mem.now();
    const expires = row.expires_at ?? addDays(at, summaryRetentionDays ?? withDefaults().summaryRetentionDays);
    transaction(mem, () => mem.db.prepare("UPDATE memory_items SET status = 'disputed', expires_at = ?, updated_at = ? WHERE id = ?").run(expires, at, row.id));
    return { ok: true, changed: true, item: toItem(mem.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(row.id)) };
  });
}

/**
 * Replace an item with a new one, keeping the old as `superseded` and linking both ways.
 * A confirmed item can only be replaced with `explicit: true`, in which case the replacement is `confirmed` too (the owner's own
 * replacement of their own decision); otherwise the replacement is `proposed`.
 * @param {{content: string, kind?: string, origin?: string, explicit?: boolean, sourceEventIds?: string[]}} change
 */
export function supersedeItem(mem, idOrPrefix, viewer, change, settings) {
  const cfg = withDefaults(settings);
  return guarded(() => {
    const found = ownedItem(mem, idOrPrefix, viewer);
    if (!found.ok) return found;
    const old = found.row;
    if (old.status === "superseded" || old.status === "deleted") return fail("ITEM_STATE", `A ${old.status} item cannot be superseded.`);
    if (old.status === "confirmed" && change?.explicit !== true) return needExplicit("Replacing a confirmed item");
    const kind = change.kind ?? old.kind;
    const origin = change.origin ?? "user_decision";
    if (!ITEM_KINDS.includes(kind)) return fail("USAGE", `kind must be one of ${ITEM_KINDS.join(", ")}.`);
    if (!ITEM_ORIGINS.includes(origin)) return fail("USAGE", `origin must be one of ${ITEM_ORIGINS.join(", ")}.`);
    const content = cleanField(change.content, ITEM_CONTENT_MAX);
    if (content === null) return fail("USAGE", "The replacement needs text.");
    return transaction(mem, () => {
      const wanted = change.sourceEventIds ? [...new Set(change.sourceEventIds.map(String))].slice(0, SOURCES_MAX) : JSON.parse(old.source_event_ids);
      const sources = citableEvents(mem, wanted, old.owner, old.repo_id);
      if (change.sourceEventIds && sources.length !== wanted.length) return fail("SOURCE_NOT_FOUND", "A cited source event does not exist, has expired, or is not readable by the owner.");
      const at = mem.now();
      const confirmed = old.status === "confirmed" && change.explicit === true;
      const id = newId("mi");
      insertItem(mem, {
        id, owner: old.owner, repo_id: old.repo_id, session_id: old.session_id, visibility: old.visibility, scope: old.scope, kind, content,
        status: confirmed ? "confirmed" : "proposed", origin, confidence: null, recorded_at: at, effective_at: at, last_verified_at: confirmed ? at : null,
        expires_at: confirmed ? null : addDays(at, cfg.summaryRetentionDays), supersedes: old.id, source_expired: sources.length < wanted.length ? 1 : 0,
      }, sources);
      mem.db.prepare("UPDATE memory_items SET status = 'superseded', replaced_by = ?, updated_at = ? WHERE id = ?").run(id, at, old.id);
      return { ok: true, changed: true, previous: toItem(mem.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(old.id)), item: toItem(mem.db.prepare("SELECT * FROM memory_items WHERE id = ?").get(id)) };
    });
  });
}

/** Fix the wording of an item: a supersede that keeps the kind, scope and origin of the original. */
export function correctItem(mem, idOrPrefix, viewer, { content, explicit } = {}, settings) {
  const found = findItem(mem, idOrPrefix, viewer);
  if (!found.ok) return found;
  return supersedeItem(mem, idOrPrefix, viewer, { content, explicit, origin: found.row.origin }, settings);
}

function guarded(work) {
  try {
    return work();
  } catch (error) {
    return degradedResult(error);
  }
}

/**
 * An item with its provenance: the chain it belongs to and every source event, either shown (still stored and readable) or
 * marked unavailable with the reason (expired or removed, forgotten, not readable).
 */
export function inspectItem(mem, idOrPrefix, viewer, { repoId } = {}) {
  const found = findItem(mem, idOrPrefix, viewer, { repoId });
  if (!found.ok) return found;
  const { item } = found;
  const now = mem.now();
  const sources = item.sourceEventIds.map((eventId) => {
    const row = mem.db
      .prepare(
        `SELECT e.id, e.session_id, e.seq, e.event_time, e.content, e.status, s.owner, s.visibility, e.expires_at FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id = ?`,
      )
      .get(eventId);
    if (!row) return { id: eventId, available: false, reason: isTombstoned(mem.db, "event", eventId) ? "forgotten" : "expired_or_removed" };
    if (row.expires_at <= now) return { id: eventId, available: false, reason: "expired_or_removed" };
    if (!(row.owner === viewer || row.visibility === "shared")) return { id: eventId, available: false, reason: "not_readable" };
    return { id: eventId, available: true, sessionId: row.session_id, seq: Number(row.seq), eventTime: row.event_time, status: row.status, snippet: row.content.slice(0, 200) };
  });
  const link = (id) => {
    // An expired neighbour of the chain is named, never shown: its text is past retention.
    const row = id ? mem.db.prepare(`SELECT id, status, kind, content FROM memory_items WHERE id = :id AND ${notExpired("expires_at")}`).get({ id, now }) : null;
    return row ? { id: row.id, status: row.status, kind: row.kind, content: row.content.slice(0, 200) } : id ? { id, status: "unavailable" } : null;
  };
  return { ok: true, item, sources, supersedes: link(item.supersedes), replacedBy: link(item.replacedBy) };
}

/** Readable items of a repository (plus the viewer's user-scope items), newest first. */
export function listItems(mem, { viewer, repoId, status, kind, scope, limit = 50 }) {
  const now = mem.now();
  const rows = mem.db
    .prepare(
      `SELECT i.* FROM memory_items i
       WHERE ((i.scope = 'user' AND i.owner = :viewer) OR (i.scope != 'user' AND i.repo_id = :repo AND (i.owner = :viewer OR i.visibility = 'shared')))
         AND ${notExpired("i.expires_at")}
         AND (:status IS NULL OR i.status = :status) AND (:kind IS NULL OR i.kind = :kind) AND (:scope IS NULL OR i.scope = :scope)
       ORDER BY i.recorded_at DESC, i.id LIMIT :limit`,
    )
    .all({ viewer, repo: repoId ?? null, now, status: status ?? null, kind: kind ?? null, scope: scope ?? null, limit: Math.max(1, Math.min(500, limit)) });
  return rows.map(toItem);
}

/**
 * The deliberate, reviewed project decisions: confirmed repository-scope decisions, requirements and constraints that `viewer`
 * may read. Nothing else leaves the database through export: no transcripts, no proposed or disputed items, no source text.
 */
export function exportableDecisions(mem, { viewer, repoId }) {
  return listItems(mem, { viewer, repoId, status: "confirmed", scope: "repository", limit: 500 }).filter((item) => ["decision", "requirement", "constraint"].includes(item.kind));
}
