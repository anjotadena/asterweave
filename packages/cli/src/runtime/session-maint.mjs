// Session maintenance: the resume plan and the clean plan/apply. Split from sessions.mjs (the store) to keep both files small.
// Neither starts anything: `resumeSession` only checks, `cleanApply` deletes session records and nothing else.

import path from "node:path";
import { CliError, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { EVENT_VERSION, foldCase, fsOf, inspectDir, isObject, isoNow, isValidSessionId, loadSession, readAll, repoSessionsDir, stamp, withSessionLock } from "./sessions.mjs";

const DIR_ENTRIES_MAX = 10_000;
const TERMINAL_RUN = new Set(["completed", "aborted"]);

/**
 * Check that a session can be resumed and say what the runner would have to do. Starts NOTHING.
 * Seams (all optional; an absent seam is reported as "not checked", never as ok):
 *   identify(workspace) -> repo key | null     currentBranch(dir) -> string | null
 *   inspectWorktree(path) -> {exists, branch}  runStatus(runId) -> {status, behind, torn} | null
 * @returns {Promise<{ok: boolean, problems: {code: string, message: string, remediation: string}[], sessionId: string, runId: string|null,
 *   node: string|null, needsReconcile: boolean, workspace: string, cwd: string, branch: string|null, checks: object}>}
 */
export async function resumeSession(repoKey, idOrPrefix, options = {}) {
  const fs = fsOf(options);
  const fold = foldCase(options);
  const { session } = loadSession(repoKey, idOrPrefix, options);
  const problems = [];
  const checks = {};
  const problem = (code, message, remediation) => problems.push({ code, message, remediation });
  const attempt = async (fn, ...args) => {
    try {
      return { value: await fn(...args) };
    } catch {
      return { failed: true };
    }
  };

  if (session.status === "archived") problem("SESSION_ARCHIVED", "The session is archived.", `Fork it instead: asterweave session fork ${session.id}`);

  let workspaceOk = false;
  try {
    if (!fs.statSync(session.workspace).isDirectory()) throw new Error("not a directory");
    const real = fs.realpathSync.native(session.workspace);
    workspaceOk = true;
    if (fold(real) !== fold(session.workspace)) {
      workspaceOk = false;
      problem("WORKSPACE_MOVED", "The workspace path now resolves somewhere else.", "Resume from the original location, or fork the session from the repository you want to use.");
    }
  } catch {
    problem("WORKSPACE_MISSING", "The workspace directory no longer exists.", "Restore the directory, or fork the session from another clone.");
  }
  checks.workspace = workspaceOk ? "ok" : "failed";

  if (workspaceOk && typeof options.identify === "function") {
    const found = await attempt(options.identify, session.workspace);
    if (found.failed || typeof found.value !== "string" || fold(found.value) !== fold(session.repoKey)) {
      problem("REPO_MISMATCH", "The workspace is not (or no longer) a work tree of the repository this session belongs to.", "Check that the directory is still a clone of the same repository.");
      checks.repository = "failed";
    } else checks.repository = "ok";
  } else checks.repository = workspaceOk ? "not checked" : "skipped";

  const worktree = session.worktree;
  if (worktree !== null) {
    let exists = false;
    try {
      exists = fs.statSync(worktree.path).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) problem("WORKTREE_MISSING", "The session's worktree no longer exists.", "Fork the session to continue in a new worktree; nothing was recreated or removed.");
    checks.worktree = exists ? "present" : "missing";
    if (exists && worktree.branch && typeof options.inspectWorktree === "function") {
      const info = await attempt(options.inspectWorktree, worktree.path);
      if (info.failed || info.value?.branch === undefined || info.value.branch !== worktree.branch) {
        problem("WORKTREE_BRANCH_MISMATCH", "The worktree is not on the branch the session recorded.", "Check out the recorded branch in that worktree, or fork the session.");
        checks.branch = "failed";
      } else checks.branch = "ok";
    } else checks.branch = exists ? "not checked" : "skipped";
  } else if (session.branch !== null && workspaceOk && typeof options.currentBranch === "function") {
    const now = await attempt(options.currentBranch, session.workspace);
    if (now.failed || now.value !== session.branch) {
      problem("BRANCH_MISMATCH", "The workspace is not on the branch the session recorded.", `Check out the recorded branch first, or fork the session.`);
      checks.branch = "failed";
    } else checks.branch = "ok";
  } else checks.branch = session.branch === null ? "none recorded" : "not checked";

  let needsReconcile = false;
  if (session.runId !== null) {
    if (typeof options.runStatus === "function") {
      const info = await attempt(options.runStatus, session.runId);
      if (info.failed || !isObject(info.value)) {
        problem("RUN_MISSING", "The run linked to this session cannot be read.", "Check `asterweave run show` for the run id; it may belong to another repository.");
        checks.run = "failed";
      } else {
        // An "active" run with nobody driving it was interrupted mid-step; events past the snapshot or a torn tail also need folding.
        needsReconcile = (info.value.behind ?? 0) > 0 || info.value.torn === true || info.value.status === "active";
        checks.run = TERMINAL_RUN.has(info.value.status) ? "finished" : "open";
      }
    } else checks.run = "not checked";
  } else checks.run = "none linked";

  return { ok: problems.length === 0, problems, sessionId: session.id, runId: session.runId, node: session.node, needsReconcile, workspace: session.workspace, cwd: worktree?.path ?? session.workspace, branch: worktree?.branch ?? session.branch, checks };
}

// Cleaning -----------------------------------------------------------------------------------------

function dirBytes(dir, fs) {
  let total = 0;
  let seen = 0;
  const stack = [dir];
  while (stack.length > 0 && seen < DIR_ENTRIES_MAX) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      seen += 1;
      const full = path.join(current, entry.name);
      try {
        if (entry.isDirectory()) stack.push(full);
        else total += fs.lstatSync(full).size;
      } catch {
        // vanished while counting
      }
    }
  }
  return total;
}

/**
 * Preview of what `cleanApply` would delete: archived sessions (optionally only those archived at least `olderThanDays` ago).
 * With `archivedOnly: false` other sessions are listed too but marked not eligible; they are never deleted.
 */
export function cleanPlan(repoKey, options = {}) {
  const fs = fsOf(options);
  const days = options.olderThanDays;
  if (days !== undefined && (typeof days !== "number" || !Number.isFinite(days) || days < 0)) throw new UsageError("--older-than needs a number of days (0 or more).", { code: "SESSION_CLEAN_INVALID" });
  const nowMs = Date.parse((options.now ?? isoNow)());
  const items = [];
  for (const { session, dir } of readAll(repoKey, options).sessions) {
    const archived = session.status === "archived";
    if (!archived && options.archivedOnly !== false) continue;
    const since = stamp(archived ? session.archivedAt ?? session.updatedAt : session.updatedAt);
    const ageDays = Number.isFinite(since) ? Math.max(0, (nowMs - since) / 86_400_000) : null;
    if (days !== undefined && (ageDays === null || ageDays < days)) continue;
    items.push({
      id: session.id,
      dir,
      title: session.title,
      status: session.status,
      branch: session.branch,
      worktree: session.worktree === null ? null : session.worktree.path,
      ageDays: ageDays === null ? null : Math.floor(ageDays),
      bytes: dirBytes(dir, fs),
      eligible: archived,
      reason: archived ? null : "not archived",
    });
  }
  items.sort((a, b) => (a.id < b.id ? -1 : 1));
  return { repoKey, olderThanDays: days ?? null, archivedOnly: options.archivedOnly !== false, items, totalBytes: items.filter((i) => i.eligible).reduce((sum, i) => sum + i.bytes, 0) };
}

/**
 * Delete ONLY the session directories listed in `plan`, only if still archived, never anything else (workspaces, worktrees and
 * runs are not touched). Each directory is checked to be a real (non-link) directory directly inside this repository's
 * sessions directory. `inspectWorktree(path)` -> {dirty: true|false|"unknown", exists?} guards sessions with a worktree: anything but
 * a clean (or already gone) worktree is skipped. The default seam answers "unknown".
 * @returns {Promise<{removed: {id: string, bytes: number}[], skipped: {id: string, reason: string}[]}>}
 */
export async function cleanApply(plan, options = {}) {
  const fs = fsOf(options);
  const inspect = options.inspectWorktree ?? (() => ({ dirty: "unknown" }));
  const removed = [];
  const skipped = [];
  if (!isObject(plan) || typeof plan.repoKey !== "string" || !Array.isArray(plan.items)) throw new TypeError("cleanApply needs a plan from cleanPlan.");
  const base = repoSessionsDir(plan.repoKey, options);
  let realBase;
  try {
    realBase = fs.realpathSync.native(base);
  } catch {
    return { removed, skipped: plan.items.map((item) => ({ id: String(item?.id), reason: "sessions directory not found" })) };
  }
  const fold = foldCase(options);
  for (const item of plan.items) {
    const id = item?.id;
    const skip = (reason) => skipped.push({ id: isValidSessionId(id) ? id : "(invalid)", reason });
    if (!isValidSessionId(id)) {
      skip("invalid id");
      continue;
    }
    if (item.eligible !== true) {
      skip(item.reason ?? "not eligible");
      continue;
    }
    const dir = path.join(base, id);
    let info;
    try {
      info = fs.lstatSync(dir);
    } catch {
      skip("already gone");
      continue;
    }
    let real = null;
    try {
      real = fs.realpathSync.native(dir);
    } catch {
      // handled as outside below
    }
    if (!info.isDirectory() || info.isSymbolicLink() || real === null || fold(real) !== fold(path.join(realBase, id))) {
      skip("outside the sessions directory");
      continue;
    }
    let state;
    try {
      state = inspectDir(dir, id, options);
    } catch {
      skip("session unreadable; left alone");
      continue;
    }
    if (state.record.status !== "archived") {
      skip("not archived");
      continue;
    }
    if (state.record.worktree !== null) {
      let seen;
      try {
        seen = await inspect(state.record.worktree.path, state.record);
      } catch {
        seen = { dirty: "unknown" };
      }
      if (seen?.exists !== false && seen?.dirty !== false) {
        skip(seen?.dirty === true ? "its worktree has uncommitted changes" : "its worktree state is unknown");
        continue;
      }
    }
    try {
      const bytes = dirBytes(dir, fs);
      withSessionLock(dir, options, () => {
        if (inspectDir(dir, id, options).record.status !== "archived") throw new CliError("not archived", { code: "SESSION_NOT_ARCHIVED" });
        fs.rmSync(dir, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
      });
      removed.push({ id, bytes });
      try {
        fs.appendFileSync(path.join(base, "cleaned.jsonl"), `${stringifyJson({ v: EVENT_VERSION, type: "cleaned", at: (options.now ?? isoNow)(), sessionId: id, bytes })}\n`, { mode: 0o600 });
      } catch {
        // The audit line is best effort; the deletion already happened.
      }
    } catch (error) {
      skip(error?.code === "SESSION_NOT_ARCHIVED" ? "not archived" : error?.code === "SESSION_LOCKED" ? "locked by another process" : "could not be removed");
    }
  }
  return { removed, skipped };
}
