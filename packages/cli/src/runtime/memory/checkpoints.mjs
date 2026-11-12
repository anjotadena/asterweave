// Checkpoints: a session's derived working summary (goal, decisions, completed work, blockers, next action) plus the git
// facts it was written against. Derived content, so it is the first thing to go when its sources expire or are forgotten.
//
// STALE WRITERS CANNOT WIN. A writer states the version it read (`expectedVersion`, 0 for none). The write is accepted only if
// that is still the latest version AND it covers at least as much of the transcript as the latest does; otherwise it is
// refused (`stale_version` / `stale_coverage`) and nothing changes. Versions are UNIQUE per session, so even two writers that
// raced past the check cannot both commit.
//
// SUMMARY (M2). A checkpoint row also carries the session's compact summary and its own coverage watermark
// (`summary_covered_seq` <= covered_seq). A write without a summary CARRIES FORWARD the latest one inside the same transaction,
// so a task checkpoint never drops a summary; a write with a summary that covers LESS than the latest is refused
// (`stale_summary`): an older summary never overwrites newer coverage.
//
// INTEGRITY (M2). Each row stores a sha256 `digest` over its stored fields. `latestValidCheckpoint` skips a row whose digest
// does not match (a damaged or hand-edited checkpoint) and returns the previous valid version instead.
//
// EXPIRY: a checkpoint expires at the EARLIEST of (creation + summaryRetentionDays) and the expiry of any event it covers, so
// it disappears from reads in the same instant its oldest source does (physical removal follows in maintenance).

import { createHash } from "node:crypto";
import { stringifyJson } from "../../json.mjs";
import { redactDeep } from "../../redact.mjs";
import { addDays, degradedResult, transaction } from "./db.mjs";
import { cleanField } from "./redact.mjs";
import { findSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";

const TEXT_MAX = 4000;
export const SUMMARY_MAX = 6000;
const REFS_MAX = 100;

const text = (value) => cleanField(Array.isArray(value) ? value.map((item) => `- ${String(item)}`).join("\n") : value, TEXT_MAX);

function jsonField(value) {
  if (value === undefined || value === null) return null;
  const trimmed = Array.isArray(value) ? value.slice(0, REFS_MAX) : value;
  return stringifyJson(redactDeep(trimmed).value);
}

const DIGEST_FIELDS = ["covered_seq", "goal", "decisions", "completed_work", "blockers", "next_action", "branch", "head_commit", "worktree_id", "changed_files_fingerprint", "running_refs", "source_refs", "generation_meta", "summary", "summary_covered_seq"];

/** sha256 over the stored values of a checkpoint row (column order fixed above). */
export function checkpointDigest(row) {
  const hash = createHash("sha256");
  for (const field of DIGEST_FIELDS) hash.update(`${field}=${row[field] === null || row[field] === undefined ? "\u0000" : String(row[field])}\n`);
  return hash.digest("hex");
}

/**
 * @param {import('./db.mjs').Memory} mem
 * @param {string} sessionId
 * @param {{expectedVersion: number, coveredSeq: number, goal?: string, decisions?: string|string[], completedWork?: string|string[],
 *   blockers?: string|string[], nextAction?: string, branch?: string, headCommit?: string, worktreeId?: string,
 *   changedFilesFingerprint?: string, runningRefs?: unknown, sourceRefs?: unknown, generationMeta?: unknown,
 *   summary?: string, summaryCoveredSeq?: number}} input
 * @param {object} [settings]
 * @param {{viewer?: string}} [options]
 */
export function saveCheckpoint(mem, sessionId, input, settings, options = {}) {
  const cfg = withDefaults(settings);
  if (cfg.enabled === false) return { ok: true, saved: false, status: "disabled" };
  try {
    if (!Number.isInteger(input?.expectedVersion) || input.expectedVersion < 0) return rejected("version_invalid", "expectedVersion must be the version the writer read (0 for none).");
    if (!Number.isInteger(input.coveredSeq) || input.coveredSeq < 0) return rejected("coverage_invalid", "coveredSeq must be a non-negative integer.");
    const hasSummary = typeof input.summary === "string";
    if (hasSummary && (!Number.isInteger(input.summaryCoveredSeq) || input.summaryCoveredSeq < 0 || input.summaryCoveredSeq > input.coveredSeq)) {
      return rejected("coverage_invalid", "summaryCoveredSeq must be a non-negative integer no larger than coveredSeq.");
    }
    return transaction(mem, () => {
      const { db } = mem;
      const session = db.prepare("SELECT id, owner, last_seq FROM sessions WHERE id = ?").get(sessionId);
      if (!session || (options.viewer !== undefined && session.owner !== options.viewer)) return rejected("session_not_found", "No such session.");
      if (isTombstoned(db, "session", sessionId)) return { ok: true, saved: false, status: "forgotten" };
      if (input.coveredSeq > Number(session.last_seq)) return rejected("coverage_invalid", "coveredSeq is beyond the last event of the session.");
      const latest = db.prepare("SELECT version, covered_seq, summary, summary_covered_seq FROM checkpoints WHERE session_id = ? ORDER BY version DESC LIMIT 1").get(sessionId);
      const currentVersion = latest ? Number(latest.version) : 0;
      if (currentVersion !== input.expectedVersion) return { ok: false, saved: false, status: "stale_version", currentVersion };
      if (latest && input.coveredSeq < Number(latest.covered_seq)) return { ok: false, saved: false, status: "stale_coverage", currentVersion, coveredSeq: Number(latest.covered_seq) };
      const latestSummarySeq = latest ? Number(latest.summary_covered_seq ?? 0) : 0;
      if (hasSummary && latest && latest.summary !== null && input.summaryCoveredSeq < latestSummarySeq) {
        return { ok: false, saved: false, status: "stale_summary", currentVersion, summaryCoveredSeq: latestSummarySeq };
      }
      const summary = hasSummary ? cleanField(input.summary, SUMMARY_MAX) : latest?.summary ?? null;
      const summarySeq = hasSummary ? input.summaryCoveredSeq : latestSummarySeq;

      const at = mem.now();
      const summaryExpiry = addDays(at, cfg.summaryRetentionDays);
      const sources = db.prepare("SELECT MIN(expires_at) AS earliest FROM events WHERE session_id = ? AND seq <= ? AND expires_at > ?").get(sessionId, input.coveredSeq, at);
      const expiresAt = sources.earliest && sources.earliest < summaryExpiry ? sources.earliest : summaryExpiry;
      const version = currentVersion + 1;
      const row = {
        session_id: sessionId, version, covered_seq: input.coveredSeq, goal: text(input.goal), decisions: text(input.decisions), completed_work: text(input.completedWork),
        blockers: text(input.blockers), next_action: text(input.nextAction), branch: cleanField(input.branch, 200), head_commit: cleanField(input.headCommit, 80),
        worktree_id: cleanField(input.worktreeId, 200), changed_files_fingerprint: cleanField(input.changedFilesFingerprint, 200), running_refs: jsonField(input.runningRefs),
        source_refs: jsonField(input.sourceRefs), generation_meta: jsonField(input.generationMeta), summary, summary_covered_seq: summarySeq, created_at: at, expires_at: expiresAt,
      };
      row.digest = checkpointDigest(row);
      db.prepare(
        `INSERT INTO checkpoints (session_id, version, covered_seq, goal, decisions, completed_work, blockers, next_action, branch, head_commit, worktree_id,
           changed_files_fingerprint, running_refs, source_refs, generation_meta, summary, summary_covered_seq, digest, created_at, expires_at)
         VALUES (:session_id, :version, :covered_seq, :goal, :decisions, :completed_work, :blockers, :next_action, :branch, :head_commit, :worktree_id,
           :changed_files_fingerprint, :running_refs, :source_refs, :generation_meta, :summary, :summary_covered_seq, :digest, :created_at, :expires_at)`,
      ).run(row);
      return { ok: true, saved: true, version, coveredSeq: input.coveredSeq, summaryCoveredSeq: summarySeq, expiresAt };
    });
  } catch (error) {
    return degradedResult(error);
  }
}

const rejected = (reason, message) => ({ ok: false, saved: false, status: "rejected", reason, message });

function toCheckpoint(row) {
  const parse = (value) => {
    try {
      return value === null || value === undefined ? null : JSON.parse(value);
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
    summary: row.summary ?? null,
    summaryCoveredSeq: Number(row.summary_covered_seq ?? 0),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/** Whether a stored row still matches its digest. Rows written before the digest existed (NULL) are accepted as they are. */
export function checkpointIntact(row) {
  return row.digest === null || row.digest === undefined || row.digest === checkpointDigest(row);
}

/** The newest unexpired checkpoint of a session `viewer` may read, or null. */
export function latestCheckpoint(mem, idOrPrefix, viewer) {
  const found = findSession(mem, idOrPrefix, viewer);
  if (!found.ok) return null;
  const row = mem.db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND expires_at > ? ORDER BY version DESC LIMIT 1").get(found.session.id, mem.now());
  return row ? toCheckpoint(row) : null;
}

/**
 * The newest unexpired checkpoint whose digest matches, walking back over damaged versions (at most 20).
 * @returns {{checkpoint: object|null, latestVersion: number, skipped: number[]}}  `skipped` lists the damaged versions passed over.
 */
export function latestValidCheckpoint(mem, sessionId) {
  const rows = mem.db.prepare("SELECT * FROM checkpoints WHERE session_id = ? AND expires_at > ? ORDER BY version DESC LIMIT 20").all(sessionId, mem.now());
  const skipped = [];
  for (const row of rows) {
    if (checkpointIntact(row)) return { checkpoint: toCheckpoint(row), latestVersion: rows.length > 0 ? Number(rows[0].version) : 0, skipped };
    skipped.push(Number(row.version));
  }
  return { checkpoint: null, latestVersion: rows.length > 0 ? Number(rows[0].version) : 0, skipped };
}

/** The version a new writer must name (0 when the session has none; expired rows still count, versions never repeat). */
export function currentCheckpointVersion(mem, sessionId) {
  const row = mem.db.prepare("SELECT MAX(version) AS v FROM checkpoints WHERE session_id = ?").get(sessionId);
  return row?.v === null || row?.v === undefined ? 0 : Number(row.v);
}
