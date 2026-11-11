// Memory sessions: a conversation bound to an owner and a repository. Private by default: only the owner reads a private
// session's transcript, even inside a repository other people use. `shared` is an explicit, separate step.
//
// A session's `expires_at` is the latest expiry of its events (or creation + retention while it has none). Reading,
// searching, resuming and archiving never move it; only a NEW event can, and it only ever extends from that event's own time.

import { randomBytes } from "node:crypto";
import { addDays, degradedResult, newId, notExpired, transaction } from "./db.mjs";
import { cleanField } from "./redact.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";

export const MIN_ID_PREFIX = 6;

/** A random local owner id, persisted in the database. The CLI uses it for "who am I"; it is a label, not authentication. */
export function localOwner(mem) {
  const existing = mem.db.prepare("SELECT value FROM meta WHERE key = 'owner_id'").get();
  if (existing) return existing.value;
  mem.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('owner_id', ?)").run(`u_${randomBytes(12).toString("hex")}`);
  return mem.db.prepare("SELECT value FROM meta WHERE key = 'owner_id'").get().value;
}

/** The owner id if one exists, without creating it (read-only callers). */
export function existingOwner(mem) {
  return mem.db.prepare("SELECT value FROM meta WHERE key = 'owner_id'").get()?.value ?? null;
}

export function toSession(row) {
  return {
    id: row.id,
    owner: row.owner,
    repoId: row.repo_id,
    taskId: row.task_id,
    visibility: row.visibility,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    expiresAt: row.expires_at,
    lastSeq: Number(row.last_seq),
  };
}

/** Whether `viewer` may read a session's content: the owner always; anyone else only when it is explicitly shared. */
export const canRead = (session, viewer) => session.owner === viewer || session.visibility === "shared";

/**
 * Create a session, or return the existing one with the same id (idempotent).
 * @param {import('./db.mjs').Memory} mem
 * @param {{id?: string, owner: string, identity?: import('./identity.mjs').RepoIdentity, repoId?: string, taskId?: string, visibility?: 'private'|'shared', title?: string}} input
 * @param {object} [settings]
 */
export function openSession(mem, input, settings) {
  const cfg = withDefaults(settings);
  try {
    if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
    if (input.identity?.ambiguous) {
      return { ok: false, saved: false, status: "repo_ambiguous", message: "The repository's remote changed and has not been resolved; run `asterweave memory repo resolve`." };
    }
    const repoId = input.repoId ?? input.identity?.repoId ?? null;
    if (!repoId) return { ok: false, saved: false, status: "rejected", reason: "repo_unknown", message: "A session needs a resolved repository." };
    if (typeof input.owner !== "string" || input.owner === "") return { ok: false, saved: false, status: "rejected", reason: "owner_required", message: "A session needs an owner." };
    const visibility = input.visibility === "shared" ? "shared" : "private";
    const id = typeof input.id === "string" && input.id !== "" ? input.id.slice(0, 120) : newId("ms");
    return transaction(mem, () => {
      const existing = mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
      if (existing) {
        if (existing.owner !== input.owner || existing.repo_id !== repoId) {
          return { ok: false, saved: false, status: "rejected", reason: "session_conflict", message: "A session with this id belongs to another owner or repository." };
        }
        return { ok: true, saved: true, created: false, session: toSession(existing) };
      }
      if (isTombstoned(mem.db, "session", id)) return { ok: true, saved: false, status: "forgotten" };
      const at = mem.now();
      mem.db
        .prepare(
          `INSERT INTO sessions (id, owner, repo_id, task_id, visibility, title, state, created_at, updated_at, last_activity_at, expires_at, last_seq)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0)`,
        )
        .run(id, input.owner, repoId, input.taskId ? String(input.taskId).slice(0, 200) : null, visibility, cleanField(input.title, 200) ?? "", at, at, at, addDays(at, cfg.historyRetentionDays));
      return { ok: true, saved: true, created: true, session: toSession(mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id)) };
    });
  } catch (error) {
    return degradedResult(error);
  }
}

/**
 * One session by exact id or unique prefix (>= 6 characters), only if `viewer` may read it and it has not expired.
 * @returns {{ok: true, session: object} | {ok: false, code: 'SESSION_NOT_FOUND'|'SESSION_AMBIGUOUS', message: string}}
 */
export function findSession(mem, idOrPrefix, viewer) {
  const text = String(idOrPrefix ?? "");
  const now = mem.now();
  const rows = mem.db
    .prepare(`SELECT * FROM sessions WHERE (id = :id OR (length(:id) >= ${MIN_ID_PREFIX} AND substr(id, 1, length(:id)) = :id)) AND ${notExpired("expires_at")} LIMIT 3`)
    .all({ id: text, now });
  const visible = rows.map(toSession).filter((session) => canRead(session, viewer));
  const exact = visible.find((session) => session.id === text);
  if (exact) return { ok: true, session: exact };
  if (visible.length === 1) return { ok: true, session: visible[0] };
  if (visible.length > 1) return { ok: false, code: "SESSION_AMBIGUOUS", message: "More than one session starts with that prefix; give more characters." };
  return { ok: false, code: "SESSION_NOT_FOUND", message: "No readable session has that id." };
}

/** Sessions of a repository that `viewer` may read and that have not expired, newest activity first. */
export function listSessions(mem, { viewer, repoId, includeArchived = true, limit = 50 }) {
  const now = mem.now();
  const rows = mem.db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND ${notExpired("e.expires_at")}) AS event_count
       FROM sessions s
       WHERE s.repo_id = :repo AND ${notExpired("s.expires_at", ":now")} AND (s.owner = :viewer OR s.visibility = 'shared')
         AND (:archived = 1 OR s.state = 'active')
       ORDER BY s.last_activity_at DESC, s.id LIMIT :limit`,
    )
    .all({ repo: repoId, now, viewer, archived: includeArchived ? 1 : 0, limit: Math.max(1, Math.min(500, limit)) });
  return rows.map((row) => ({ ...toSession(row), eventCount: Number(row.event_count) }));
}

function ownedSession(mem, idOrPrefix, viewer) {
  const found = findSession(mem, idOrPrefix, viewer);
  if (!found.ok) return found;
  if (found.session.owner !== viewer) return { ok: false, code: "SESSION_NOT_FOUND", message: "No readable session has that id." };
  return found;
}

/**
 * Archive a session. It stays searchable until it expires, and archiving never changes `expires_at`.
 * @returns {{ok: true, changed: boolean, session: object} | {ok: false, code: string, message: string}}
 */
export function archiveSession(mem, idOrPrefix, viewer) {
  return setState(mem, idOrPrefix, viewer, "archived");
}

/** Make an archived session active again (it does not renew retention). */
export function unarchiveSession(mem, idOrPrefix, viewer) {
  return setState(mem, idOrPrefix, viewer, "active");
}

function setState(mem, idOrPrefix, viewer, state) {
  const found = ownedSession(mem, idOrPrefix, viewer);
  if (!found.ok) return found;
  if (found.session.state === state) return { ok: true, changed: false, session: found.session };
  const at = mem.now();
  transaction(mem, () => mem.db.prepare("UPDATE sessions SET state = ?, archived_at = ?, updated_at = ? WHERE id = ?").run(state, state === "archived" ? at : null, at, found.session.id));
  return { ok: true, changed: true, session: toSession(mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(found.session.id)) };
}

/** Explicitly share or unshare a session (owner only). Sharing is never implied by anything else. */
export function setVisibility(mem, idOrPrefix, viewer, visibility) {
  if (visibility !== "private" && visibility !== "shared") return { ok: false, code: "USAGE", message: "Visibility must be 'private' or 'shared'." };
  const found = ownedSession(mem, idOrPrefix, viewer);
  if (!found.ok) return found;
  const at = mem.now();
  transaction(mem, () => mem.db.prepare("UPDATE sessions SET visibility = ?, updated_at = ? WHERE id = ?").run(visibility, at, found.session.id));
  return { ok: true, changed: found.session.visibility !== visibility, session: toSession(mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(found.session.id)) };
}
