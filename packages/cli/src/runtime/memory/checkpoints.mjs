// Checkpoints: a session's derived working summary (goal, decisions, completed work, blockers, next action) plus the git
// facts it was written against. Derived content, so it is the first thing to go when its sources expire or are forgotten.
//
// STALE WRITERS CANNOT WIN. A writer states the version it read (`expectedVersion`, 0 for none). The write is accepted only if
// that is still the latest version AND it covers at least as much of the transcript as the latest does; otherwise it is
// refused (`stale_version` / `stale_coverage`) and nothing changes. Versions are UNIQUE per session, so even two writers that
// raced past the check cannot both commit.
//
// EXPIRY: a checkpoint expires at the EARLIEST of (creation + summaryRetentionDays) and the expiry of any event it covers, so
// it disappears from reads in the same instant its oldest source does (physical removal follows in maintenance).

import { redactDeep } from "../../redact.mjs";
import { addDays, degradedResult, transaction } from "./db.mjs";
import { cleanField } from "./redact.mjs";
import { findSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";

const TEXT_MAX = 4000;
const REFS_MAX = 100;

const text = (value) => cleanField(Array.isArray(value) ? value.map((item) => `- ${String(item)}`).join("\n") : value, TEXT_MAX);

function jsonField(value) {
  if (value === undefined || value === null) return null;
  const trimmed = Array.isArray(value) ? value.slice(0, REFS_MAX) : value;
  return JSON.stringify(redactDeep(trimmed).value);
}

/**
 * @param {import('./db.mjs').Memory} mem
 * @param {string} sessionId
 * @param {{expectedVersion: number, coveredSeq: number, goal?: string, decisions?: string|string[], completedWork?: string|string[],
 *   blockers?: string|string[], nextAction?: string, branch?: string, headCommit?: string, worktreeId?: string,
 *   changedFilesFingerprint?: string, runningRefs?: unknown, sourceRefs?: unknown, generationMeta?: unknown}} input
 * @param {object} [settings]
 * @param {{viewer?: string}} [options]
 */
export function saveCheckpoint(mem, sessionId, input, settings, options = {}) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
  try {
    if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 0) return rejected("version_invalid", "expectedVersion must be the version the writer read (0 for none).");
    if (!Number.isInteger(input.coveredSeq) || input.coveredSeq < 0) return rejected("coverage_invalid", "coveredSeq must be a non-negative integer.");
    return transaction(mem, () => {
      const { db } = mem;
      const session = db.prepare("SELECT id, owner, last_seq FROM sessions WHERE id = ?").get(sessionId);
      if (!session || (options.viewer !== undefined && session.owner !== options.viewer)) return rejected("session_not_found", "No such session.");
      if (isTombstoned(db, "session", sessionId)) return { ok: true, saved: false, status: "forgotten" };
      if (input.coveredSeq > Number(session.last_seq)) return rejected("coverage_invalid", "coveredSeq is beyond the last event of the session.");
      const latest = db.prepare("SELECT version, covered_seq FROM checkpoints WHERE session_id = ? ORDER BY version DESC LIMIT 1").get(sessionId);
      const currentVersion = latest ? Number(latest.version) : 0;
      if (currentVersion !== input.expectedVersion) return { ok: false, saved: false, status: "stale_version", currentVersion };
      if (latest && input.coveredSeq < Number(latest.covered_seq)) return { ok: false, saved: false, status: "stale_coverage", currentVersion, coveredSeq: Number(latest.covered_seq) };

      const at = mem.now();
      const summaryExpiry = addDays(at, cfg.summaryRetentionDays);
      const sources = db.prepare("SELECT MIN(expires_at) AS earliest FROM events WHERE session_id = ? AND seq <= ? AND expires_at > ?").get(sessionId, input.coveredSeq, at);
      const expiresAt = sources.earliest && sources.earliest < summaryExpiry ? sources.earliest : summaryExpiry;
      const version = currentVersion + 1;
      db.prepare(
        `INSERT INTO checkpoints (session_id, version, covered_seq, goal, decisions, completed_work, blockers, next_action, branch, head_commit, worktree_id,
           changed_files_fingerprint, running_refs, source_refs, generation_meta, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sessionId, version, input.coveredSeq, text(input.goal), text(input.decisions), text(input.completedWork), text(input.blockers), text(input.nextAction),
        cleanField(input.branch, 200), cleanField(input.headCommit, 80), cleanField(input.worktreeId, 200), cleanField(input.changedFilesFingerprint, 200),
        jsonField(input.runningRefs), jsonField(input.sourceRefs), jsonField(input.generationMeta), at, expiresAt,
      );
      return { ok: true, saved: true, version, coveredSeq: input.coveredSeq, expiresAt };
    });
  } catch (error) {
    return degradedResult(error);
  }
}

const rejected = (reason, message) => ({ ok: false, saved: false, status: "rejected", reason, message });

function toCheckpoint(row) {
  const parse = (value) => {
    try {
      return value === null ? null : JSON.parse(value);
    } catch {
      return null;
    }
  };
  return {
    sessionId: row.session_id,
    version: Number(row.version),
    coveredSeq: Number(row.covered_seq),
    goal: row.goal,
    decisions: row.decisions,
    completedWork: row.completed_work,
    blockers: row.blockers,
    nextAction: row.next_action,
    branch: row.branch,
    headCommit: row.head_commit,
    worktreeId: row.worktree_id,
    changedFilesFingerprint: row.changed_files_fingerprint,
    runningRefs: parse(row.running_refs),
    sourceRefs: parse(row.source_refs),
    generationMeta: parse(row.generation_meta),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** The newest unexpired checkpoint of a session `viewer` may read, or null. */
export function latestCheckpoint(mem, idOrPrefix, viewer) {
  const found = findSession(mem, idOrPrefix, viewer);
  if (!found.ok) return null;
  const row = mem.db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND expires_at > ? ORDER BY version DESC LIMIT 1").get(found.session.id, mem.now());
  return row ? toCheckpoint(row) : null;
}
