// `asterweave session list|show|search|start|resume|fork|archive|clean|transcript`.
//
// A session ties a repository workspace (optionally a worktree and a run) to a title and checkpoints; the records live in
// <userDir>/sessions/<repoDir>/<id>/ (see src/runtime/sessions.mjs). NO subcommand starts a model, a run or a runner: `start`
// only records a session, `resume` only checks it and prints what to do next. Text output is sanitised; JSON goes through
// stringifyJson. Errors are the CLI's usual envelope {ok:false,error:{code,message,remediation}}.
//
// Exit codes: 0 ok · 1 error (including a session that cannot be resumed, or written by a newer asterweave) · 2 usage
// (including `clean` without --yes when there is something to delete) · 130 interrupted.

import { dirname } from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { runBinary } from "../proc.mjs";
import { sanitizeForTerminal, sanitizeLines, suggestCommand } from "../redact.mjs";
import { gitEnv } from "../repo.mjs";
import { isValidRunId, listRuns, loadRun, runDir } from "../runtime/ledger.mjs";
import { cleanApply, cleanPlan, resumeSession } from "../runtime/session-maint.mjs";
import { archiveSession, createSession, forkSession, listSessions, loadSession, searchSessions } from "../runtime/sessions.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { attachInspected, attachmentViews, imagePaths, inspectAll, storeProblemError } from "./images.mjs";
import { resolveRepo } from "./run.mjs";
import { attachCommand, attachmentLines, detachCommand } from "./session-images.mjs";
import { isInteractive, seams, stringOption } from "./shared.mjs";

export const sessionCommandMeta = Object.freeze({
  summary: "List, start, resume, fork, archive and clean sessions",
  boolean: ["json", "all", "yes"],
  options: ["json", "all", "yes", "title", "worktree", "run", "older-than", "image"],
});

const USAGE =
  "Usage: asterweave session list [--all] [--json] | show <id> [--json] | search <text> [--json] | start [--title t] [--worktree name] [--run [runId]] [--image path]... [--json] | attach <id> <path>... [--json] | detach <id> <attachmentId> [--yes] [--json] | resume <id> [--json] | fork <id> [--title t] [--json] | archive <id> [--json] | clean [--older-than days] [--yes] [--json] | transcript <id> [--json]";

export const sessionHelpText = `${[
  "asterweave session - sessions: a repository workspace (and worktree, run) with a title and checkpoints",
  "",
  USAGE,
  "",
  "  list        active sessions of this repository (--all adds archived ones)",
  "  show        one session, including checkpoints and approval references",
  "  search      case-insensitive text search over title, branch, goal, run id and id (literal text, not a pattern)",
  "  start       record a new session for this repository (no runner is started); --worktree creates an isolated worktree",
  "              first, --run links the newest run (or the given run id)",
  "  attach      store image copies (PNG, JPEG or WebP; EXIF/XMP/text metadata stripped) in a session; start --image does the same. Nothing is sent",
  "              until `run start --session <id>` sends the not-yet-sent images with its first turn (see the images docs page)",
  "  detach      remove one attached image (its stored copy) after a preview; needs --yes without a terminal. Refused while a run that used it is open",
  "  resume      check that the session can continue and print the exact next command; changes nothing else",
  "  fork        a new session from an existing one: checkpoints up to the last verified one, no provider session id",
  "  archive     mark a session archived (idempotent)",
  "  clean       preview archived sessions that could be deleted; --yes (or a y/N answer on a terminal) deletes them.",
  "              Only session records are removed: never workspaces, worktrees or runs. Without --yes on a non-terminal: exit 2.",
  "  transcript  summary of the linked run's events (bounded; no tool output)",
  "",
  "Session ids may be given as a unique prefix of at least 6 characters.",
  "list, show, search, resume and transcript never write: no migration, no quarantine, no log repair (an old or damaged record is shown",
  "as it would be repaired). start, fork, archive and clean repair what they touch; resume records nothing.",
  "session.json and events.jsonl larger than 8 MiB are not read (reported as a problem).",
  "",
  "JSON (stable):",
  "  list        { ok, sessions: [{ id, title, status, branch, runId, node, parentSessionId, worktree, checkpoints, createdAt, updatedAt, archivedAt }], problems: [{ id, error, message }], truncated }",
  "  show        { ok, session: { schemaVersion, id, repoKey, workspace, branch, worktree: { path, branch, base, created } | null, providerSessionId, runId, node,",
  "                parentSessionId, goal, title, status, checkpoints: [{ at, runId, node, seq, note }], approvals: [{ id, kind, subject, at }],",
  "                usage: { tokens, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }, attachments: [<attachment>], createdAt, updatedAt, archivedAt, lastSeq }, notes, behind }",
  "              (null = unknown or not set; usage numbers are copies of measured totals)",
  "  search      { ok, query, results: [<list row> + matched: [field]], truncated }",
  "  start       { ok, session, worktree: { path, branch, created } | null, attachments?: [<attachment>] }   (attachments only with --image)",
  "  attach      { ok, sessionId, attachments: [<attachment>], duplicates: [id] }   <attachment> = { id, sha256, format, mime, bytes, width, height, name,",
  "                metadataStripped, dropped: [kind], sentRunId }   (hashes and sizes only: image bytes are never printed)",
  "  detach      { ok, removed, sessionId, attachment }",
  "  resume      { ok, plan: { ok, problems: [{ code, message, remediation }], sessionId, runId, node, needsReconcile, workspace, cwd, branch, checks }, nextCommand }",
  "              (cwd = the directory to work in: the worktree path when the session has a worktree, else the workspace)",
  "              (when plan.ok is false: ok is false, an error object is included, exit 1)",
  "  fork        { ok, session, parentSessionId, keptCheckpoints }",
  "  archive     { ok, session, changed }",
  "  clean       { ok, applied, plan: { items: [{ id, title, status, branch, worktree, ageDays, bytes, eligible, reason }], totalBytes }, removed: [{ id, bytes }], skipped: [{ id, reason }] }",
  "  transcript  { ok, sessionId, runId, total, shown, truncated, events: [{ seq, at, type, node?, status?, reason?, tool?, decision? }] }",
  "Exit codes: 0 ok · 1 error or cannot resume · 2 usage · 130 interrupted",
].join("\n")}\n`;

const FLAGS = {
  list: ["json", "all"],
  show: ["json"],
  search: ["json"],
  start: ["json", "title", "worktree", "run", "image"],
  attach: ["json"],
  detach: ["json", "yes"],
  resume: ["json"],
  fork: ["json", "title"],
  archive: ["json"],
  clean: ["json", "yes", "older-than"],
  transcript: ["json"],
};
const TRANSCRIPT_MAX = 200;
const TRANSCRIPT_FIELDS = ["node", "from", "to", "status", "reason", "tool", "decision", "outcome", "attempt"];

const write = (stream, text) => stream.write(text);
const safe = (text, limit = 200) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const json = (ctx) => ctx.options?.json === true;

function check(ctx, sub, positionals, max) {
  const allowed = new Set(FLAGS[sub]);
  for (const key of Object.keys(ctx.options ?? {})) {
    if (!allowed.has(key)) throw new UsageError(`Option --${safe(key, 40)} does not apply to 'session ${sub}'.`, { remediation: USAGE });
  }
  if (positionals.length > max) throw new UsageError(`Unexpected argument '${safe(positionals[max], 40)}'.`, { remediation: USAGE });
}

// Git: only plain read-only plumbing, with the same hardening flags as run.mjs (no hooks, no pager, no fsmonitor).
async function currentBranchOf(ctx, cwd) {
  const platform = ctx.platform ?? process.platform;
  const flags = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand=", "-c", "safe.bareRepository=explicit"];
  // Discovery must not climb above the directory's parent into some other repository.
  const parent = dirname(cwd);
  const env = { ...gitEnv(ctx.env), ...(parent !== cwd ? { GIT_CEILING_DIRECTORIES: parent } : {}) };
  const result = await runBinary("git", [...flags, "symbolic-ref", "--short", "-q", "HEAD"], { cwd, env, spawn: ctx.spawn, exists: ctx.exists, platform: ctx.platform, timeoutMs: ctx.timeoutMs ?? 15_000 });
  const name = result.error || result.code !== 0 ? "" : result.stdout.trim();
  return name === "" ? null : name;
}

/** The worktree module (Track W) when this build has it; `ctx.sessionSeams.worktree` replaces it in tests. */
async function worktreeApi(ctx) {
  if (ctx.sessionSeams?.worktree !== undefined) return ctx.sessionSeams.worktree;
  try {
    return await import("../runtime/worktree.mjs");
  } catch {
    return null;
  }
}

const storeOptions = (ctx) => ({ ...seams(ctx), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.userDir ? { userDir: ctx.userDir } : {}) });
/** Options for the worktree module: the same environment, user directory and process seams as the session store. */
const worktreeOptions = (ctx) => {
  const options = storeOptions(ctx);
  for (const key of ["spawn", "exists", "signal"]) if (ctx[key] !== undefined) options[key] = ctx[key];
  return options;
};

// list, show, search, resume and transcript never write (no migration, quarantine or log repair); start, fork, archive and
// clean may. A v1 record is migrated by the next write command.
const readOnly = (ctx) => ({ ...storeOptions(ctx), repair: false });

const when = (value) => value ?? "unknown";
const row = (s) => `${s.id}  ${s.status.padEnd(8)}  ${when(s.updatedAt)}  ${s.branch ?? "-"}  ${s.title || "(untitled)"}${s.runId ? `  run ${s.runId}` : ""}${s.parentSessionId ? `  fork of ${s.parentSessionId}` : ""}`;

// --- list / show / search ----------------------------------------------------------------------

async function listCommand(ctx) {
  check(ctx, "list", ctx.positionals.slice(1), 0);
  const repo = await resolveRepo(ctx);
  const result = listSessions(repo.key, { ...readOnly(ctx), ...(ctx.options?.all === true ? {} : { status: "active" }) });
  if (json(ctx)) {
    write(ctx.stdout, `${stringifyJson({ ok: true, ...result })}\n`);
    return EXIT.OK;
  }
  const lines = result.sessions.length === 0 ? ["No sessions for this repository."] : result.sessions.map(row);
  if (result.truncated) lines.push("(more sessions exist; the list is bounded)");
  for (const problem of result.problems) lines.push(`Warning: session ${problem.id} could not be read (${problem.error}).`);
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

async function showCommand(ctx) {
  const [, id, ...extra] = ctx.positionals;
  check(ctx, "show", [id, ...extra].filter((x) => x !== undefined), 1);
  const repo = await resolveRepo(ctx);
  const { session, notes, behind } = loadSession(repo.key, id, readOnly(ctx));
  if (json(ctx)) {
    write(ctx.stdout, `${stringifyJson({ ok: true, session, notes, behind })}\n`);
    return EXIT.OK;
  }
  const lines = [
    `Session ${session.id}  ${session.status}`,
    `Title      ${session.title || "(untitled)"}`,
    `Workspace  ${session.workspace}`,
    `Branch     ${session.branch ?? "-"}`,
    `Worktree   ${session.worktree ? `${session.worktree.path} (${session.worktree.branch ?? "no branch"}${session.worktree.created ? ", created by asterweave" : ""})` : "-"}`,
    `Run        ${session.runId ?? "-"}${session.node ? ` at ${session.node}` : ""}`,
    `Goal       ${session.goal ?? "-"}`,
    `Parent     ${session.parentSessionId ?? "-"}`,
    `Provider   ${session.providerSessionId ?? "-"}`,
    `Usage      ${session.usage.tokens === null ? "tokens unknown" : `${session.usage.tokens} tokens (measured)`}`,
    `Created    ${when(session.createdAt)}   Updated ${when(session.updatedAt)}${session.archivedAt ? `   Archived ${session.archivedAt}` : ""}`,
    `Checkpoints (${session.checkpoints.length})`,
    ...session.checkpoints.map((c) => `  #${c.seq ?? "?"} ${c.runId ?? "-"}/${c.node ?? "-"} ${when(c.at)}${c.note ? `  ${c.note}` : ""}`),
    `Approvals (${session.approvals.length}, references only)`,
    ...session.approvals.map((a) => `  ${a.id} ${a.kind ?? ""} ${a.subject ?? ""}`),
    ...attachmentLines(session),
    ...notes.map((n) => `Note: ${n}`),
  ];
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

async function searchCommand(ctx) {
  const [, text, ...extra] = ctx.positionals;
  check(ctx, "search", [text, ...extra].filter((x) => x !== undefined), 1);
  const repo = await resolveRepo(ctx);
  const result = searchSessions(repo.key, text, readOnly(ctx));
  if (json(ctx)) {
    write(ctx.stdout, `${stringifyJson({ ok: true, ...result })}\n`);
    return EXIT.OK;
  }
  const lines = result.results.length === 0 ? ["No session matches."] : result.results.map((r) => `${row(r)}  [${r.matched.join(", ")}]`);
  if (result.truncated) lines.push("(more sessions match; the result is bounded)");
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// --- start ---------------------------------------------------------------------------------------

async function startCommand(ctx) {
  check(ctx, "start", ctx.positionals.slice(1), 0);
  const title = stringOption(ctx, "title", USAGE);
  const name = stringOption(ctx, "worktree", USAGE);
  const runFlag = ctx.options?.run;
  const inspectedImages = inspectAll(imagePaths(ctx, USAGE), ctx); // every file is validated before a worktree or a session exists
  if (typeof runFlag === "string" && !isValidRunId(runFlag)) throw new UsageError("--run needs a run id (or no value for the newest run).", { remediation: USAGE });
  const repo = await resolveRepo(ctx);
  const options = storeOptions(ctx);

  let run = null;
  if (runFlag !== undefined) {
    let dir;
    if (typeof runFlag === "string") dir = runDir(repo.key, runFlag, options);
    else {
      const newest = listRuns(repo.key, options).find((item) => item.error === undefined);
      if (!newest) throw new CliError("There are no runs for this repository to link.", { code: "RUN_NOT_FOUND", remediation: "Start the session without --run." });
      dir = newest.dir;
    }
    run = loadRun(dir, ctx.fs ? { fs: ctx.fs } : {}).run;
  }

  let worktree = null;
  let branch = await currentBranchOf(ctx, repo.workspace);
  if (name !== undefined) {
    const api = await worktreeApi(ctx);
    if (!api || typeof api.planWorktree !== "function" || typeof api.createWorktree !== "function") {
      throw new CliError("Worktrees are not available in this build.", { code: "WORKTREE_UNAVAILABLE", remediation: "Start the session without --worktree." });
    }
    const wopts = worktreeOptions(ctx);
    const plan = await api.planWorktree({ root: repo.workspace, name, base: "HEAD", ...wopts });
    const made = await api.createWorktree(plan, wopts);
    const done = made !== null && typeof made === "object" ? made : plan; // what was actually created wins over what was planned
    const baseOf = (value) => (typeof value === "string" ? value : value?.commit ?? null);
    worktree = { path: done.path ?? plan.path, branch: done.branch ?? plan.branch ?? null, base: baseOf(done.base) ?? baseOf(plan.base), created: true };
    branch = worktree.branch ?? branch;
  }

  const goal = run?.goal ?? null;
  let created;
  try {
    created = createSession(
      { repoKey: repo.key, workspace: repo.workspace, branch, worktree, title: title ?? goal ?? `Session on ${branch ?? "detached HEAD"}`, goal, runId: run?.runId ?? null, node: run?.currentNode ?? null },
      options,
    );
  } catch (error) {
    if (worktree) throw new CliError(`The worktree was created at ${safe(worktree.path)} but the session could not be recorded: ${safe(error.message)}`, { code: error.code ?? "SESSION_CREATE_FAILED", remediation: "The worktree was kept; remove it yourself if you do not need it." });
    throw error;
  }
  const attached = inspectedImages.length > 0 ? attachInspected(created.session.id, inspectedImages, ctx, repo.key) : { attachments: [], duplicates: [], problem: null };
  // all or nothing: a failed attach leaves the session without images and is ONE error envelope (never a success document first)
  if (attached.problem) throw storeProblemError(attached.problem, `The session ${created.session.id} was recorded without images; attach them later with: asterweave session attach ${created.session.id} <path>`);
  const finalSession = attached.attachments.length > 0 ? loadSession(repo.key, created.session.id, readOnly(ctx)).session : created.session;
  if (json(ctx)) write(ctx.stdout, `${stringifyJson({ ok: true, session: finalSession, worktree: worktree ? { path: worktree.path, branch: worktree.branch, created: true } : null, ...(inspectedImages.length > 0 ? { attachments: attachmentViews(attached.attachments) } : {}) })}\n`);
  else {
    const lines = [`Started session ${created.session.id}${created.session.title ? ` "${created.session.title}"` : ""}`, `Workspace ${created.session.workspace}`];
    if (worktree) lines.push(`Worktree  ${worktree.path} (${worktree.branch ?? "no branch"})`);
    if (run) lines.push(`Linked run ${run.runId}`);
    if (attached.attachments.length > 0) lines.push(...attachmentLines(finalSession).slice(0, 1 + attached.attachments.length), "Stored copies have metadata stripped; nothing is sent until a run starts with this session.");
    lines.push("No runner is started by this command.");
    write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  }
  return EXIT.OK;
}

// --- resume ----------------------------------------------------------------------------------------

async function inspectBranch(ctx, dir) {
  return { exists: true, branch: await currentBranchOf(ctx, dir) };
}

async function resumeCommand(ctx) {
  const [, id, ...extra] = ctx.positionals;
  check(ctx, "resume", [id, ...extra].filter((x) => x !== undefined), 1);
  const repo = await resolveRepo(ctx);
  const options = readOnly(ctx);
  const seam = ctx.sessionSeams ?? {};
  const plan = await resumeSession(repo.key, id, {
    ...options,
    identify: seam.identify ?? (async (workspace) => (await resolveRepo({ ...ctx, cwd: workspace })).key),
    currentBranch: seam.currentBranch ?? ((dir) => currentBranchOf(ctx, dir)),
    inspectWorktree: seam.inspectWorktree ?? ((dir) => inspectBranch(ctx, dir)),
    runStatus: seam.runStatus ?? (async (runId) => {
      const loaded = loadRun(runDir(repo.key, runId, options), ctx.fs ? { fs: ctx.fs } : {});
      return { status: loaded.run.status ?? null, behind: loaded.behind, torn: loaded.torn };
    }),
  });
  const platform = ctx.platform ?? process.platform;
  const nextCommand = plan.ok ? (plan.runId ? `asterweave run show ${plan.runId}` : `asterweave session show ${plan.sessionId}`) : null;
  if (json(ctx)) {
    const body = { ok: plan.ok, plan, nextCommand };
    if (!plan.ok) body.error = { code: "SESSION_NOT_RESUMABLE", message: `${plan.problems.length} problem(s) prevent resuming this session.`, remediation: plan.problems[0].remediation };
    write(ctx.stdout, `${stringifyJson(body)}\n`);
    return plan.ok ? EXIT.OK : EXIT.ERROR;
  }
  const lines = [`Resume plan for session ${plan.sessionId}: ${plan.ok ? "ready" : "NOT ready"}`];
  lines.push(`Workspace ${plan.workspace}`, ...(plan.cwd === plan.workspace ? [] : [`Work in   ${plan.cwd}`]), `Branch    ${plan.branch ?? "-"}`, `Run       ${plan.runId ?? "-"}${plan.node ? ` at ${plan.node}` : ""}`);
  lines.push(`Checks    ${Object.entries(plan.checks).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  if (plan.needsReconcile) lines.push("The linked run was interrupted or its ledger is behind: the runner reconciles pending side effects before continuing.");
  for (const problem of plan.problems) lines.push(`Problem: ${problem.message}`, `  Next: ${problem.remediation}`);
  if (plan.ok) {
    lines.push("", "Next:", `  ${suggestCommand("cd ", plan.cwd, "", platform)}`, `  ${nextCommand}`, "No runner is available in this build: resuming a session does not start anything.");
  }
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  if (!plan.ok) throw new CliError("This session cannot be resumed as it is.", { code: "SESSION_NOT_RESUMABLE", remediation: plan.problems[0].remediation });
  return EXIT.OK;
}

// --- fork / archive -----------------------------------------------------------------------------------

async function forkCommand(ctx) {
  const [, id, ...extra] = ctx.positionals;
  check(ctx, "fork", [id, ...extra].filter((x) => x !== undefined), 1);
  const title = stringOption(ctx, "title", USAGE);
  const repo = await resolveRepo(ctx);
  const options = storeOptions(ctx);
  const verified = (cp) => {
    if (cp.runId === null || cp.seq === null) return false;
    try {
      return loadRun(runDir(repo.key, cp.runId, options), ctx.fs ? { fs: ctx.fs } : {}).events.length >= cp.seq;
    } catch {
      return false;
    }
  };
  const result = forkSession(repo.key, id, { ...options, verified: ctx.sessionSeams?.verified ?? verified, ...(title === undefined ? {} : { title }) });
  if (json(ctx)) write(ctx.stdout, `${stringifyJson({ ok: true, session: result.session, parentSessionId: result.parent.id, keptCheckpoints: result.keptCheckpoints })}\n`);
  else write(ctx.stdout, `${sanitizeLines([`Forked ${result.parent.id} into ${result.session.id} "${result.session.title}"`, `${result.keptCheckpoints} checkpoint(s) kept. The provider session is not copied; the runner starts the fork's own.`])}\n`);
  return EXIT.OK;
}

async function archiveCommand(ctx) {
  const [, id, ...extra] = ctx.positionals;
  check(ctx, "archive", [id, ...extra].filter((x) => x !== undefined), 1);
  const repo = await resolveRepo(ctx);
  const result = archiveSession(repo.key, id, storeOptions(ctx));
  if (json(ctx)) write(ctx.stdout, `${stringifyJson({ ok: true, session: result.session, changed: result.changed })}\n`);
  else write(ctx.stdout, `${sanitizeLines(result.changed ? `Archived session ${result.session.id}` : `Session ${result.session.id} was already archived`)}\n`);
  return EXIT.OK;
}

// --- clean ----------------------------------------------------------------------------------------------

async function confirm(ctx, lines) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(`${sanitizeLines(lines)} `);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

const viewItem = ({ dir: _dir, ...rest }) => rest;
const mb = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);

async function cleanCommand(ctx) {
  check(ctx, "clean", ctx.positionals.slice(1), 0);
  const raw = stringOption(ctx, "older-than", USAGE);
  const days = raw === undefined ? undefined : /^\d{1,5}(\.\d+)?$/.test(raw) ? Number(raw) : null;
  if (days === null) throw new UsageError("--older-than needs a number of days (0 or more).", { remediation: USAGE });
  const repo = await resolveRepo(ctx);
  const options = storeOptions(ctx);
  const plan = cleanPlan(repo.key, { ...options, ...(days === undefined ? {} : { olderThanDays: days }) });
  const deletable = plan.items.filter((item) => item.eligible);
  const view = { items: plan.items.map(viewItem), totalBytes: plan.totalBytes };
  const previewLines = deletable.length === 0
    ? ["No archived sessions to clean."]
    : [`${deletable.length} archived session(s), ${mb(plan.totalBytes)}, would be deleted (session records only; workspaces, worktrees and runs are never touched):`, ...deletable.map((i) => `  ${i.id}  ${i.ageDays ?? "?"}d  ${mb(i.bytes)}  ${i.title || "(untitled)"}${i.worktree ? `  worktree ${i.worktree}` : ""}`)];

  if (deletable.length === 0) {
    if (json(ctx)) write(ctx.stdout, `${stringifyJson({ ok: true, applied: false, plan: view, removed: [], skipped: [] })}\n`);
    else write(ctx.stdout, `${sanitizeLines(previewLines)}\n`);
    return EXIT.OK;
  }
  let approved = ctx.options?.yes === true;
  if (!approved) {
    if (isInteractive(ctx) && !json(ctx)) {
      const answer = await confirm(ctx, [...previewLines, "Delete them? [y/N]"]);
      if (answer.interrupted) return EXIT.INTERRUPTED;
      approved = answer.yes === true;
      if (!approved) {
        write(ctx.stdout, "Nothing was deleted.\n");
        return EXIT.OK;
      }
    } else if (json(ctx)) {
      write(ctx.stdout, `${stringifyJson({ ok: false, applied: false, error: { code: "USAGE", message: "Pass --yes to delete.", remediation: "Review the plan, then run: asterweave session clean --yes" }, plan: view, removed: [], skipped: [] })}\n`);
      return EXIT.USAGE;
    } else {
      write(ctx.stdout, `${sanitizeLines([...previewLines, "Pass --yes to delete."])}\n`);
      return EXIT.USAGE;
    }
  }
  let inspectWorktree = ctx.sessionSeams?.inspectWorktree;
  if (inspectWorktree === undefined && deletable.some((item) => item.worktree)) {
    const api = await worktreeApi(ctx);
    if (api && typeof api.inspectWorktree === "function") inspectWorktree = (dir) => api.inspectWorktree(dir, worktreeOptions(ctx));
  }
  const result = await cleanApply({ ...plan, items: deletable }, { ...options, ...(inspectWorktree ? { inspectWorktree } : {}) });
  if (json(ctx)) write(ctx.stdout, `${stringifyJson({ ok: true, applied: true, plan: view, removed: result.removed, skipped: result.skipped })}\n`);
  else {
    const lines = [`Deleted ${result.removed.length} session(s), ${mb(result.removed.reduce((sum, r) => sum + r.bytes, 0))}.`, ...result.skipped.map((s) => `Kept ${s.id}: ${s.reason}.`)];
    write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  }
  return EXIT.OK;
}

// --- transcript --------------------------------------------------------------------------------------------

const scalar = (value) => (typeof value === "string" ? safe(value, 160) : typeof value === "number" || typeof value === "boolean" ? value : undefined);

async function transcriptCommand(ctx) {
  const [, id, ...extra] = ctx.positionals;
  check(ctx, "transcript", [id, ...extra].filter((x) => x !== undefined), 1);
  const repo = await resolveRepo(ctx);
  const options = readOnly(ctx);
  const { session } = loadSession(repo.key, id, options);
  if (session.runId === null) throw new CliError("This session has no linked run.", { code: "SESSION_NO_RUN", remediation: "Link one with `asterweave session start --run`, or use a session that has a run." });
  const loaded = loadRun(runDir(repo.key, session.runId, options), ctx.fs ? { fs: ctx.fs } : {});
  const shown = loaded.events.slice(-TRANSCRIPT_MAX).map((event) => {
    const entry = { seq: event.seq, at: scalar(event.at) ?? null, type: scalar(event.type) ?? "unknown" };
    for (const field of TRANSCRIPT_FIELDS) {
      const value = scalar(event[field]);
      if (value !== undefined) entry[field] = value;
    }
    return entry;
  });
  const body = { ok: true, sessionId: session.id, runId: session.runId, total: loaded.events.length, shown: shown.length, truncated: loaded.events.length > shown.length, events: shown };
  if (json(ctx)) write(ctx.stdout, `${stringifyJson(body)}\n`);
  else {
    const lines = [`Session ${session.id}, run ${session.runId}: ${body.shown} of ${body.total} event(s)`, ...shown.map((e) => `#${e.seq} ${e.at ?? ""} ${e.type}${TRANSCRIPT_FIELDS.filter((f) => e[f] !== undefined).map((f) => ` ${f}=${e[f]}`).join("")}`)];
    write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  }
  return EXIT.OK;
}

// What session-images.mjs needs from this file.
const imageKit = { check, USAGE, resolveRepo, readOnly, write, json, confirm, isInteractive };

/** Handler for `asterweave session ...`. */
export async function sessionCommand(ctx) {
  const sub = (ctx.positionals ?? [])[0];
  ctx = { ...ctx, positionals: ctx.positionals ?? [] };
  switch (sub) {
    case "list":
      return listCommand(ctx);
    case "show":
      return showCommand(ctx);
    case "search":
      return searchCommand(ctx);
    case "start":
      return startCommand(ctx);
    case "attach":
      return attachCommand(ctx, imageKit);
    case "detach":
      return detachCommand(ctx, imageKit);
    case "resume":
      return resumeCommand(ctx);
    case "fork":
      return forkCommand(ctx);
    case "archive":
      return archiveCommand(ctx);
    case "clean":
      return cleanCommand(ctx);
    case "transcript":
      return transcriptCommand(ctx);
    default:
      throw new UsageError(sub ? `Unknown session subcommand '${safe(sub, 40)}'.` : "Missing session subcommand.", { remediation: USAGE });
  }
}
