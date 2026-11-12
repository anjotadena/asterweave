// Idle and cold resume. Pure decisions plus one bounded, read-only workspace check (workspace.mjs).
//
// GAP. Computed from the session's PERSISTED last_activity_at, read BEFORE the new turn is captured (capture moves it). UTC ISO
// strings, so the gap is correct across restarts and time zones. A last activity in the FUTURE (clock skew, a copied database)
// is treated as cold: the conservative reading.
//
//   gap < idleRefreshMinutes                  -> continue
//   idleRefreshMinutes <= gap < coldResume    -> refresh (task/agent status re-read from the run state; no rebuild)
//   gap >= coldResumeMinutes, or the model's context is gone (no provider session to resume, a context reset) or the
//   model/provider changed                    -> cold: rebuild from persistent state and VALIDATE the checkpoint
//
// VALIDATION (cold only): branch, HEAD, changed-files fingerprint, worktree identity and the referenced run's status, against what
// the checkpoint recorded (a normal resume of the run, e.g. waiting-approval -> active after an approval, is expected, not a change; an
// inconsistent run status is reported as a run-state change, never as a workspace change). Unchanged -> continue from its next action. Changed or unverifiable -> its completion claims are marked
// UNVERIFIED (the injected section says so, and a new checkpoint version records it) and must be re-verified. Old approvals never
// authorise new actions: the injected section says so in its preface, and nothing here reads or grants an approval.
//
// NEW TOPIC. A request whose keywords barely overlap the checkpoint's goal and next action is a new intent: the old task state is
// not forced onto it.

import { queryTerms } from "./context.mjs";

const MINUTE = 60_000;

/**
 * @param {{lastActivityAt: string|null, now: string, idleRefreshMinutes: number, coldResumeMinutes: number,
 *   providerContextLost?: boolean, modelChanged?: boolean}} input
 * @returns {{mode: 'new'|'continue'|'refresh'|'cold', gapMinutes: number|null, reasons: string[]}}
 */
export function classifyGap(input) {
  if (!input.lastActivityAt) return { mode: "new", gapMinutes: null, reasons: ["no earlier activity"] };
  const gapMs = Date.parse(input.now) - Date.parse(input.lastActivityAt);
  const reasons = [];
  if (!Number.isFinite(gapMs)) return { mode: "cold", gapMinutes: null, reasons: ["last activity unreadable"] };
  if (gapMs < 0) reasons.push("last activity is in the future (clock skew): treated as cold");
  const gapMinutes = Math.max(0, Math.floor(gapMs / MINUTE));
  if (gapMs >= input.coldResumeMinutes * MINUTE) reasons.push(`idle ${gapMinutes} min >= ${input.coldResumeMinutes}`);
  if (input.providerContextLost) reasons.push("the model's earlier context is not available (new provider session)");
  if (input.modelChanged) reasons.push("the model changed");
  if (reasons.length > 0) return { mode: "cold", gapMinutes, reasons };
  if (gapMs >= input.idleRefreshMinutes * MINUTE) return { mode: "refresh", gapMinutes, reasons: [`idle ${gapMinutes} min >= ${input.idleRefreshMinutes}`] };
  return { mode: "continue", gapMinutes, reasons: [] };
}

/**
 * Compare a checkpoint's recorded workspace with a fresh probe (probeWorkspace) and the referenced run's status.
 * @returns {{unchanged: boolean, changes: string[]}}
 */
export function validateCheckpoint(checkpoint, probe, { runStatus = null } = {}) {
  const changes = [];
  if (!probe?.verifiable) changes.push("workspace not verifiable");
  else {
    if (checkpoint.branch && probe.branch !== checkpoint.branch) changes.push(`branch ${checkpoint.branch} -> ${probe.branch ?? "detached"}`);
    if (checkpoint.headCommit && probe.head !== checkpoint.headCommit) changes.push(`HEAD ${checkpoint.headCommit.slice(0, 7)} -> ${String(probe.head).slice(0, 7)}`);
    if (checkpoint.changedFilesFingerprint && probe.fingerprint !== checkpoint.changedFilesFingerprint) changes.push("changed files differ");
    if (checkpoint.worktreeId && probe.worktreeId !== checkpoint.worktreeId) changes.push("another worktree");
  }
  const recorded = checkpoint.runningRefs?.status ?? null;
  if (recorded && runStatus && !expectedRunTransition(recorded, runStatus)) changes.push(`run status ${recorded} -> ${runStatus}`);
  return { unchanged: changes.length === 0, changes };
}

/** Run statuses a run is resumed FROM (graph.mjs RESUMABLE): resuming one makes the run `active` again. */
const RESUMED_FROM = new Set(["waiting-approval", "waiting-external", "paused", "blocked"]);

/**
 * True for a run-status move that a normal resume makes (the same status, or a waiting/paused/blocked run made active again, e.g. approve
 * then resume). Anything else (a run recorded active that is now completed or aborted, a paused run that completed) is inconsistent with
 * the checkpoint and flagged. This is the run's state, not the workspace: the workspace checks above are separate.
 */
export function expectedRunTransition(recorded, current) {
  return recorded === current || (RESUMED_FROM.has(recorded) && current === "active");
}

const onlyRunState = (changes) => changes.length > 0 && changes.every((change) => change.startsWith("run status "));

/** True when the request's keywords barely overlap the checkpoint's goal + next action (a new intent). */
export function isNewTopic(request, checkpoint) {
  if (!checkpoint) return false;
  const asked = new Set(queryTerms(request));
  const known = new Set(queryTerms(`${checkpoint.goal ?? ""} ${checkpoint.nextAction ?? ""}`));
  if (asked.size < 2 || known.size === 0) return false;
  let overlap = 0;
  for (const term of asked) if (known.has(term)) overlap += 1;
  return overlap / Math.min(asked.size, known.size) < 0.2;
}

const firstLine = (text) => String(text ?? "").split(/\r?\n/).map((line) => line.replace(/^-\s*/, "").trim()).find(Boolean) ?? null;

/**
 * The one-line resume note, ONLY with evidence: what was complete and what is next, and what was checked.
 * @returns {string|null}
 */
export function resumeNote(checkpoint, validation, probe) {
  if (!checkpoint) return null;
  if (!validation.unchanged) return `${onlyRunState(validation.changes) ? "The run state changed" : "The workspace changed"} since the last checkpoint (${validation.changes.join("; ")}): its completion claims are unverified and must be re-checked before relying on them.`;
  const done = firstLine(checkpoint.completedWork);
  const next = firstLine(checkpoint.nextAction);
  if (!done && !next) return null;
  return `${done ? `${done} is complete. ` : ""}${next ? `Next: ${next}; ` : ""}checked branch ${probe.branch ?? "detached"} at HEAD ${String(probe.head).slice(0, 7)}.`;
}
