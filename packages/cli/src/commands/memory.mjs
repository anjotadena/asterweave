// `asterweave memory status|search|show|confirm|correct|supersede|forget|export|archive|unarchive|retention|capture|maintain|repo|trace|import`.
//
// The conversation-memory store (src/runtime/memory/): a local, UNENCRYPTED SQLite file at <userDir>/memory/memory.db. M1 ships
// the store and these commands; M2 (runtime/memory/pipeline.mjs) feeds it from `asterweave run` and injects a delimited memory section
// into each model request (`memory trace` shows what was attached). M3 adds `memory import claude`: an opt-in, read-only import of this
// repository's Claude Code transcripts (runtime/memory/claude-import.mjs). Text
// output is sanitised, JSON goes through stringifyJson, errors use the CLI's usual envelope.
//
// Settings (memory.*) come from user config.json and ASTERWEAVE_MEMORY_* environment variables only; a repository cannot set them.
// `retention --set` and `capture on|off` write the user config.json (everything else in it is preserved).
//
// Exit codes: 0 ok · 1 error (not found, store unavailable, degraded write) · 2 usage (including a destructive command without
// --yes on a non-terminal) · 5 invalid memory configuration · 130 interrupted.

import * as nodeFs from "node:fs";
import path from "node:path";
import { coerceValue, ConfigError, resolveMemoryConfig } from "../config.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { readOriginStatus } from "../repo.mjs";
import { readEvents, toEvent } from "../runtime/memory/capture.mjs";
import { latestCheckpoint } from "../runtime/memory/checkpoints.mjs";
import { memoryDbPath, openMemory, schemaVersion } from "../runtime/memory/db.mjs";
import { defaultTimeZone, formatLocal, parseTimeBound } from "../runtime/memory/dates.mjs";
import { forgetBySearch, forgetEvents, forgetItem, forgetSession } from "../runtime/memory/forget.mjs";
import { asterweaveRunSessions, claudeHomeDir, importClaude, IMPORT_MAX_BYTES, IMPORT_META_KEY, listWorktreeRoots, MAX_LINE_BYTES } from "../runtime/memory/claude-import.mjs";
import { describeRepo, listAmbiguities, readCloneAnchor, readRepositoryBirth, resolveAmbiguity, resolveRepoIdentity } from "../runtime/memory/identity.mjs";
import { confirmItem, correctItem, exportableDecisions, ITEM_KINDS, inspectItem, supersedeItem } from "../runtime/memory/items.mjs";
import { applyRetentionChange, pendingCleanup, physicalCleanup, planRetentionChange, reindexSearch, startupMaintenance } from "../runtime/memory/retention.mjs";
import { listTraces, traceTotals } from "../runtime/memory/context.mjs";
import { searchMemory } from "../runtime/memory/search.mjs";
import { archiveSession, existingOwner, findSession, localOwner, unarchiveSession } from "../runtime/memory/sessions.mjs";
import { settingsFromEntries } from "../runtime/memory/settings.mjs";
import { readJson, writeJsonAtomic } from "../store.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { resolveRepo } from "./run.mjs";
import { isInteractive, runtimeSeams, seams } from "./shared.mjs";
import { userFilePath } from "../paths.mjs";

export const memoryCommandMeta = Object.freeze({
  summary: "Search, review, export and delete the local conversation memory",
  boolean: ["json", "yes", "force", "reindex", "dry-run", "include-sidechains"],
  options: ["json", "yes", "force", "reindex", "since", "until", "session", "task", "limit", "only", "text", "kind", "out", "set", "query", "batch-size", "max-batches", "dry-run", "include-sidechains", "max-bytes"],
});

const USAGE =
  "Usage: asterweave memory status | search [text] [--since d] [--until d] [--session id] [--task id] [--only events|items] [--limit n] | show <id> | confirm <itemId> | correct <itemId> --text t | supersede <itemId> --text t [--kind k] | forget <id> | forget --query text [filters] [--yes] | export [--out path [--force]] | archive <session> | unarchive <session> | retention [--set days] [--yes] | capture [on|off] | maintain [--batch-size n] [--max-batches n] [--reindex] | repo [resolve same|new] | trace [runId] [--session id] | import claude [--dry-run] [--include-sidechains] [--max-bytes n]   (every subcommand accepts --json)";

export const memoryHelpText = `${[
  "asterweave memory - the local conversation memory (stored history, decisions, and what to keep or delete)",
  "",
  USAGE,
  "",
  "  status      where the store is, whether capture is on, retention, counts, and this repository's identity",
  "  search      keyword search (FTS5) over stored events and memory items, with --since/--until (2026-11-03, yesterday, last tuesday,",
  "              3 days ago, last week ...), --session, --task. Says 'weak' or 'none' when the evidence is weak or absent",
  "  show        one item (with its sources and history), session (with its checkpoint) or event",
  "  confirm     mark a proposed item confirmed. Only this explicit command (or supersede/correct on a confirmed item) can confirm",
  "  correct     fix an item's wording: a new version replaces it, the old one is kept as superseded",
  "  supersede   replace an item by a new one; the old one is kept as superseded",
  "  forget      delete an event, session or item and everything derived from it (items, checkpoints, search index), leaving a",
  "              content-free tombstone so it cannot be re-imported. Previews first; needs --yes (or a y/N on a terminal)",
  "  export      write ONLY confirmed repository decisions, requirements and constraints (Markdown, or JSON with --json) to stdout or",
  "              --out <path> (an existing file is never overwritten without --force). Never transcripts",
  "  archive     mark a session archived (still searchable; retention is unchanged). unarchive undoes it",
  "  retention   show, or with --set <days> preview and apply a new history retention period (shortening expires data now;",
  "              lengthening never revives expired data)",
  "  capture     show, or turn on/off FUTURE capture (memory.enabled). Off keeps what is stored; use forget to delete",
  "  maintain    delete expired data in bounded batches now (--reindex rebuilds the search index). Safe to rerun after an interruption",
  "  repo        show this clone's repository identity; 'repo resolve same|new' settles a changed remote",
  "  trace       which memories were attached to each model request of a run (or --session: a memory or file session id): ids,",
  "              rationale, estimated tokens, cache hit or miss, latency. Ids and numbers only, never content",
  "  import      'import claude': OPT-IN (memory.claudeImportEnabled = true in your user config). Reads, never changes, the Claude Code",
  "              transcripts of THIS repository and its worktrees (~/.claude/projects). Idempotent and incremental; --dry-run shows",
  "              files, sessions, events and skips by reason without writing; --include-sidechains also imports subagent turns and",
  "              nested transcript files; --max-bytes n bounds what one run reads (default 64 MiB; rerun to continue)",
  "",
  "Privacy: the file is a plain, unencrypted SQLite database protected only by the permissions of your user directory.",
  "Text is redacted (tokens, keys, URL credentials, emails masked) BEFORE it is stored; redaction is pattern based and not perfect.",
  "Sessions are private to you unless explicitly shared. Retention: events expire history-retention-days after they happened and",
  "are hidden at that instant; reading, searching, resuming and archiving never extend it. Confirmed items are durable until forgotten.",
  "Settings: memory.* in the user config.json or ASTERWEAVE_MEMORY_* variables; a repository's config cannot set them.",
  "",
  "JSON (stable): every subcommand prints {ok:true, ...} or the usual {ok:false,error}. search: {query, mode, evidence:'strong'|'weak'|'none', events:[], items:[], notes:[]};",
  "  status: {memory:{storage, settings, repo, counts, pendingCleanup, notes}}; forget: {dryRun, applied, events, items, checkpoints, sessions}; retention: {plan, applied}.",
  "Exit codes: 0 ok · 1 error · 2 usage (including a deletion without --yes on a non-terminal) · 5 invalid memory configuration · 130 interrupted",
].join("\n")}\n`;

const FLAGS = {
  status: ["json"],
  search: ["json", "since", "until", "session", "task", "only", "limit"],
  show: ["json", "limit"],
  confirm: ["json"],
  correct: ["json", "text"],
  supersede: ["json", "text", "kind"],
  forget: ["json", "yes", "query", "since", "until", "session", "task"],
  export: ["json", "out", "force"],
  archive: ["json"],
  unarchive: ["json"],
  retention: ["json", "set", "yes"],
  capture: ["json"],
  maintain: ["json", "batch-size", "max-batches", "reindex"],
  repo: ["json"],
  trace: ["json", "session", "limit"],
  import: ["json", "dry-run", "include-sidechains", "max-bytes"],
};
const MAX_POSITIONALS = { status: 0, search: Infinity, show: 1, confirm: 1, correct: 1, supersede: 1, forget: 1, export: 0, archive: 1, unarchive: 1, retention: 0, capture: 1, maintain: 0, repo: 2, trace: 1, import: 1 };

const safe = (text, limit = 200) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const json = (ctx) => ctx.options?.json === true;
const write = (ctx, text) => ctx.stdout.write(text);

function check(ctx, sub) {
  const allowed = new Set(FLAGS[sub]);
  for (const key of Object.keys(ctx.options ?? {})) {
    if (!allowed.has(key)) throw new UsageError(`Option --${safe(key, 40)} does not apply to 'memory ${sub}'.`, { remediation: USAGE });
  }
  const extra = ctx.positionals.slice(1);
  if (extra.length > MAX_POSITIONALS[sub]) throw new UsageError(`Unexpected argument '${safe(extra[MAX_POSITIONALS[sub]], 40)}'.`, { remediation: USAGE });
}

function str(ctx, name) {
  const value = ctx.options?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} requires a value.`, { remediation: USAGE });
  return value.trim();
}

function intOption(ctx, name, min, max) {
  const raw = str(ctx, name);
  if (raw === undefined) return undefined;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`--${name} needs a whole number from ${min} to ${max}.`, { remediation: USAGE });
  return Number(raw);
}

/** A byte count for --max-bytes: plain digits only (no units, signs or decimals), from IMPORT_MAX_BYTES.min to .max. */
function bytesOption(ctx, name) {
  const raw = str(ctx, name);
  if (raw === undefined) return undefined;
  const { min, max } = IMPORT_MAX_BYTES;
  if (!/^\d{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new UsageError(`--${name} needs a whole number of bytes from ${min} to ${max} (digits only).`, { remediation: USAGE });
  return Number(raw);
}

/** A failed {ok:false, code, message} result as the CLI error it should be. */
function failure(result) {
  if (result.degraded) return new CliError(`The memory store could not be written: ${safe(result.message)}`, { code: "MEMORY_WRITE_FAILED", remediation: "Nothing was saved. Check the user directory is writable, then retry." });
  if (result.code === "USAGE" || result.code === "CONFIRMATION_REQUIRED") return new UsageError(safe(result.message), { code: result.code });
  return new CliError(safe(result.message ?? result.status ?? "failed"), { code: result.code ?? "MEMORY_ERROR" });
}
const must = (result) => {
  if (result.ok === false) throw failure(result);
  return result;
};

// --- context ---------------------------------------------------------------------------------------------------------

const storeOptions = (ctx) => ({ ...seams(ctx), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.userDir ? { userDir: ctx.userDir } : {}), ...(ctx.loadSqlite ? { loadSqlite: ctx.loadSqlite } : {}) });
const userConfigFile = (ctx) => (ctx.userDir ? path.join(ctx.userDir, "config.json") : userFilePath("config", { env: ctx.env, platform: ctx.platform, homedir: ctx.homedir }));

function loadSettings(ctx) {
  const resolved = resolveMemoryConfig({ ...seams(ctx), userConfigFile: userConfigFile(ctx) });
  return { entries: resolved.entries, settings: settingsFromEntries(resolved.entries) };
}

async function detectRepo(ctx) {
  const repo = await resolveRepo(ctx);
  // Same identity inputs as `run` (run-runner.mjs startMemory): "git could not answer" is never read as "no origin", which would record
  // a false changed-remote ambiguity; the repository is then `unavailable` and no identity is resolved or written.
  let remote = null;
  let unavailable;
  if (repo.git) {
    const origin = await readOriginStatus(repo.workspace, runtimeSeams(ctx));
    if (origin.state === "ok") remote = origin.origin.url;
    else if (origin.state === "failed") unavailable = `git could not read the origin remote (${safe(origin.reason, 120)})`;
  }
  let anchor = null;
  if (unavailable === undefined && remote === null) {
    const read = await readCloneAnchor({ workspace: repo.workspace, git: repo.git === true }, { env: ctx.env ?? {}, ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.exists ? { exists: ctx.exists } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}), ...(ctx.fs ? { fs: ctx.fs } : {}) });
    if (read.ok) anchor = read.anchor;
    else unavailable = `the repository's identity could not be read (${safe(read.reason, 120)})`;
  }
  return { cloneKey: repo.key, kind: repo.git ? "git-common-dir" : "directory", remote, anchor, workspace: repo.workspace, ...(unavailable !== undefined ? { unavailable } : {}) };
}

/**
 * Open the store and work out who is asking and which repository. `write:false` never creates the database; on a machine
 * with none, `mem` is null and callers report "nothing stored".
 */
async function openContext(ctx, { write }) {
  const detected = await detectRepo(ctx);
  const mem = openMemory({ ...storeOptions(ctx), create: write });
  if (mem === null) return { mem: null, detected, identity: null, viewer: null };
  try {
    const viewer = ctx.memoryOwner ?? (write ? localOwner(mem) : existingOwner(mem) ?? "");
    // An unreadable identity resolves nothing (and so records no ambiguity): the repository reads as having no memory, with a warning.
    const identity = detected.unavailable ? { status: "unavailable", repoId: null, ambiguous: false, remote: null, ambiguity: null, unavailable: detected.unavailable } : resolveRepoIdentity(mem, detected, { create: write });
    return { mem, detected, identity, viewer };
  } catch (error) {
    mem.close();
    throw error;
  }
}

async function using(ctx, opts, work) {
  const c = await openContext(ctx, opts);
  try {
    return await work(c);
  } finally {
    c.mem?.close();
  }
}

function identityWarnings(identity) {
  if (identity?.unavailable) return [`This repository's identity could not be read, so its memory is not shown and nothing is written: ${identity.unavailable}. Try again; if git keeps failing, run 'asterweave doctor'.`];
  if (!identity?.ambiguous) return [];
  const what = identity.reason === "history"
    ? "This folder now holds a repository with a different history (its root commit changed) than the one its memory belongs to"
    : `The remote of this clone changed (now ${identity.remote ?? "none"})`;
  return [`${what}. Memory stays bound to the previous repository and capture is paused until you run: asterweave memory repo resolve same|new`];
}

const timeZoneOf = (ctx) => ctx.timeZone ?? defaultTimeZone();
const nowOf = (ctx) => (typeof ctx.now === "function" ? ctx.now() : Date.now());

async function confirmPrompt(ctx, lines) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(`${sanitizeLines(lines)} `);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

/** `--yes`, or a y/N on a terminal. Returns "yes", "no", "interrupted" or "needs-yes" (non-terminal without --yes). */
async function approval(ctx, previewLines, question) {
  if (ctx.options?.yes === true) return "yes";
  if (isInteractive(ctx) && !json(ctx)) {
    const answer = await confirmPrompt(ctx, [...previewLines, question]);
    if (answer.interrupted) return "interrupted";
    return answer.yes === true ? "yes" : "no";
  }
  return "needs-yes";
}

function needsYes(ctx, body, lines) {
  if (json(ctx)) write(ctx, `${stringifyJson({ ok: false, applied: false, error: { code: "USAGE", message: "Pass --yes to apply.", remediation: "Review the preview, then rerun with --yes." }, ...body })}\n`);
  else write(ctx, `${sanitizeLines([...lines, "Pass --yes to apply."])}\n`);
  return EXIT.USAGE;
}

// --- status ----------------------------------------------------------------------------------------------------------

async function statusCommand(ctx) {
  check(ctx, "status");
  const { entries, settings } = loadSettings(ctx);
  const file = memoryDbPath(storeOptions(ctx));
  const fs = ctx.fs ?? nodeFs;
  const exists = fs.existsSync(file);
  const memory = {
    storage: { path: file, exists, sizeBytes: exists ? fs.statSync(file).size : 0, encrypted: false, schemaVersion: null },
    settings: { ...settings, origins: Object.fromEntries(Object.entries(entries).map(([key, entry]) => [key.slice("memory.".length), entry.origin])) },
    repo: null,
    counts: { sessions: 0, events: 0, items: 0, checkpoints: 0 },
    pendingCleanup: null,
    notes: ["The store is an unencrypted SQLite file; it is protected only by the permissions of your user directory.", "Memory is injected into the model requests of `asterweave run` as a delimited historical-data section (see `asterweave memory trace`); token counts there are estimates. Claude Code transcripts enter memory only through `asterweave memory import claude` (opt-in, read-only)."],
    import: { claude: { enabled: settings.claudeImportEnabled === true, lastImportAt: null, files: 0 } },
  };
  let warnings = [];
  if (exists) {
    await using(ctx, { write: false }, async ({ mem, detected, identity, viewer }) => {
      memory.storage.schemaVersion = schemaVersion(mem.db);
      memory.pendingCleanup = pendingCleanup(mem);
      memory.maintenance = mem.db.prepare("SELECT task, state, rows_removed, updated_at, last_completed_at FROM maintenance_progress ORDER BY task").all().map((row) => ({ task: row.task, state: row.state, rowsRemoved: Number(row.rows_removed), updatedAt: row.updated_at, lastCompletedAt: row.last_completed_at }));
      warnings = identityWarnings(identity);
      if (identity?.repoId) {
        const now = mem.now();
        const n = (sql, params) => Number(mem.db.prepare(sql).get(params).n);
        const p = { repo: identity.repoId, viewer, now };
        memory.counts = {
          sessions: n("SELECT COUNT(*) AS n FROM sessions s WHERE s.repo_id = :repo AND (s.owner = :viewer OR s.visibility = 'shared') AND s.expires_at > :now", p),
          events: n("SELECT COUNT(*) AS n FROM events e JOIN sessions s ON s.id = e.session_id WHERE s.repo_id = :repo AND (s.owner = :viewer OR s.visibility = 'shared') AND s.expires_at > :now AND e.expires_at > :now", p),
          items: n("SELECT COUNT(*) AS n FROM memory_items i WHERE ((i.scope = 'user' AND i.owner = :viewer) OR (i.scope != 'user' AND i.repo_id = :repo AND (i.owner = :viewer OR i.visibility = 'shared'))) AND (i.expires_at IS NULL OR i.expires_at > :now)", p),
          checkpoints: n("SELECT COUNT(*) AS n FROM checkpoints c JOIN sessions s ON s.id = c.session_id WHERE s.repo_id = :repo AND (s.owner = :viewer OR s.visibility = 'shared') AND c.expires_at > :now", p),
        };
      }
      try {
        memory.import.claude.lastImportAt = mem.db.prepare("SELECT value FROM meta WHERE key = ?").get(IMPORT_META_KEY)?.value ?? null;
        memory.import.claude.files = Number(mem.db.prepare("SELECT COUNT(*) AS n FROM claude_import_files").get().n);
      } catch {
        // an older schema has no import table
      }
      try {
        memory.context = traceTotals(listTraces(mem, { owner: viewer, limit: 1000 }));
      } catch {
        memory.context = null;
      }
      memory.repo = { id: identity?.repoId ?? null, status: identity?.status ?? "unmapped", remote: detected.remote === null ? null : identity?.remote ?? null, ambiguous: identity?.ambiguous === true, ...(identity?.repoId ? (({ id: _id, ...rest }) => rest)(describeRepo(mem, identity.repoId) ?? { id: null }) : {}) };
    });
  }
  memory.warnings = warnings;
  if (json(ctx)) {
    write(ctx, `${stringifyJson({ ok: true, memory })}\n`);
    return EXIT.OK;
  }
  const s = memory.settings;
  const lines = [
    `Store      ${file}${exists ? `  (${memory.storage.sizeBytes} bytes, schema ${memory.storage.schemaVersion})` : "  (nothing stored yet)"}`,
    "Encryption none: a plain SQLite file, protected only by your user directory permissions",
    `Capture    ${s.enabled ? "on" : "OFF (future capture is stopped; stored data is kept)"}  [${s.origins.enabled}]`,
    `Retention  history ${s.historyRetentionDays} days, summaries ${s.summaryRetentionDays} days; confirmed items are kept until forgotten`,
    `Services   semantic search ${s.semanticSearchEnabled ? "on" : "off"}`,
    `Import     Claude Code ${memory.import.claude.enabled ? "enabled" : "disabled (opt-in: memory.claudeImportEnabled in your user config)"}; last import ${memory.import.claude.lastImportAt ?? "never"}${memory.import.claude.files ? ` (${memory.import.claude.files} transcript file(s) tracked)` : ""}`,
    `Repository ${memory.repo ? `${memory.repo.id ?? "(not recorded yet)"}${memory.repo.remote ? `  ${memory.repo.remote}` : ""}` : "(no store yet)"}`,
    `Stored     ${memory.counts.sessions} session(s), ${memory.counts.events} event(s), ${memory.counts.items} item(s), ${memory.counts.checkpoints} checkpoint(s) readable by you`,
    ...(memory.context ? [`Context    ${memory.context.requests} request(s) built, ~${memory.context.memoryTokens} memory tokens injected (estimated), ${memory.context.selected} memories selected, cache ${memory.context.cacheHits} hit(s) / ${memory.context.cacheMisses} miss(es), ${memory.context.retrievalMs} ms retrieval; summary/extraction tokens 0 (deterministic)`] : []),
  ];
  if (memory.pendingCleanup) {
    const pending = Object.values(memory.pendingCleanup).reduce((a, b) => a + b, 0);
    if (pending > 0) lines.push(`Expired    ${pending} expired row(s) are hidden already and wait for physical cleanup (run: asterweave memory maintain)`);
  }
  for (const warning of warnings) lines.push(`Warning: ${warning}`);
  lines.push(...memory.notes);
  write(ctx, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// --- search / show ---------------------------------------------------------------------------------------------------

function bound(ctx, name, edge) {
  const text = str(ctx, name);
  if (text === undefined) return null;
  const parsed = parseTimeBound(text, { now: nowOf(ctx), timeZone: timeZoneOf(ctx), edge });
  if (!parsed.ok) throw new UsageError(`--${name}: ${parsed.message}`, { remediation: USAGE });
  return parsed.iso;
}

function filtersOf(ctx) {
  return { since: bound(ctx, "since", "start"), until: bound(ctx, "until", "end"), sessionId: str(ctx, "session") ?? null, taskId: str(ctx, "task") ?? null };
}

const hitLine = (hit) =>
  hit.kind === "event"
    ? `  ${hit.id}  ${hit.eventTime} (${hit.eventTimeLocal} local)  session ${hit.sessionId}${hit.archived ? " [archived]" : ""}  #${hit.seq} ${hit.role ?? hit.eventType}${hit.status === "incomplete" ? " [incomplete]" : ""}\n      ${hit.snippet.replace(/\s+/g, " ")}`
    : `  ${hit.id}  ${hit.status} ${hit.kind === "item" ? hit.scope : ""} ${hit.recordedAt} (${hit.recordedAtLocal} local)\n      ${hit.snippet.replace(/\s+/g, " ")}`;

async function searchCommand(ctx) {
  check(ctx, "search");
  const only = str(ctx, "only");
  if (only !== undefined && only !== "events" && only !== "items") throw new UsageError("--only must be events or items.", { remediation: USAGE });
  const filters = filtersOf(ctx);
  const limit = intOption(ctx, "limit", 1, 100);
  const query = ctx.positionals.slice(1).join(" ");
  const { settings } = loadSettings(ctx);
  const result = await using(ctx, { write: false }, ({ mem, identity, viewer }) => {
    if (mem === null || !identity?.repoId) return { ok: true, query, terms: [], mode: "none", evidence: "none", events: [], items: [], truncated: false, notes: identity?.unavailable ? [] : ["No memory is stored for this repository yet."], warnings: identityWarnings(identity) };
    const found = searchMemory(mem, { viewer, repoId: identity.repoId, query, ...filters, include: only ? [only] : undefined, limit, timeZone: timeZoneOf(ctx), trace: false }, settings);
    return { ...must(found), warnings: identityWarnings(identity) };
  });
  if (json(ctx)) {
    write(ctx, `${stringifyJson(result)}\n`);
    return EXIT.OK;
  }
  const lines = [`Evidence: ${result.evidence}${result.mode === "any" ? " (partial term matches)" : ""}`];
  if (result.events.length) lines.push(`Events (${result.events.length})`, ...result.events.map(hitLine));
  if (result.items.length) lines.push(`Items (${result.items.length})`, ...result.items.map(hitLine));
  if (result.truncated) lines.push("(more results exist; narrow the search)");
  for (const note of [...result.notes, ...result.warnings]) lines.push(`Note: ${note}`);
  write(ctx, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

function findEvent(mem, id, viewer) {
  const row = mem.db
    .prepare(
      `SELECT e.*, s.title, s.state, s.owner FROM events e JOIN sessions s ON s.id = e.session_id
       WHERE e.id = :id AND (s.owner = :viewer OR s.visibility = 'shared') AND s.expires_at > :now AND e.expires_at > :now`,
    )
    .get({ id, viewer, now: mem.now() });
  return row ? { event: toEvent(row), sessionId: row.session_id, sessionTitle: row.title } : null;
}

async function showCommand(ctx) {
  check(ctx, "show");
  const id = ctx.positionals[1];
  if (id === undefined) throw new UsageError("memory show needs an id.", { remediation: USAGE });
  const limit = intOption(ctx, "limit", 1, 200) ?? 20;
  const body = await using(ctx, { write: false }, ({ mem, identity, viewer }) => {
    if (mem === null) throw new CliError("Nothing is stored yet.", { code: "MEMORY_NOT_FOUND" });
    const repoId = identity?.repoId ?? null;
    const looksItem = id.startsWith("mi_");
    if (looksItem) {
      const item = inspectItem(mem, id, viewer, { repoId });
      return { type: "item", ...must(item) };
    }
    const event = findEvent(mem, id, viewer);
    if (event) return { type: "event", ok: true, ...event };
    const session = findSession(mem, id, viewer);
    if (session.ok) {
      const events = readEvents(mem, session.session.id, { afterSeq: Math.max(0, session.session.lastSeq - limit), limit });
      return { type: "session", ok: true, session: session.session, events, checkpoint: latestCheckpoint(mem, session.session.id, viewer) };
    }
    const item = inspectItem(mem, id, viewer, { repoId });
    if (item.ok) return { type: "item", ...item };
    throw new CliError("Nothing readable has that id.", { code: "MEMORY_NOT_FOUND", remediation: "Ids come from `asterweave memory search`." });
  });
  if (json(ctx)) {
    write(ctx, `${stringifyJson(body)}\n`);
    return EXIT.OK;
  }
  const tz = timeZoneOf(ctx);
  const lines = [];
  if (body.type === "item") {
    const i = body.item;
    lines.push(`Item ${i.id}  ${i.status}  ${i.kind}  scope ${i.scope}  origin ${i.origin}  ${i.visibility}`, `Recorded ${i.recordedAt} (${formatLocal(i.recordedAt, tz)} local)${i.expiresAt ? `  expires ${i.expiresAt}` : "  durable (no expiry)"}${i.sourceExpired ? "  [a source has expired or was removed]" : ""}`, i.content);
    if (body.supersedes) lines.push(`Supersedes ${body.supersedes.id} (${body.supersedes.status})`);
    if (body.replacedBy) lines.push(`Replaced by ${body.replacedBy.id} (${body.replacedBy.status})`);
    lines.push(`Sources (${body.sources.length})`, ...body.sources.map((s) => (s.available ? `  ${s.id}  session ${s.sessionId} #${s.seq} ${s.eventTime}: ${s.snippet.replace(/\s+/g, " ")}` : `  ${s.id}  unavailable (${s.reason})`)));
  } else if (body.type === "session") {
    const s = body.session;
    lines.push(`Session ${s.id}  ${s.state}  ${s.visibility}  "${s.title}"`, `Created ${s.createdAt}  last activity ${s.lastActivityAt} (${formatLocal(s.lastActivityAt, tz)} local)  expires ${s.expiresAt}`);
    if (body.checkpoint) lines.push(`Checkpoint v${body.checkpoint.version} covers #${body.checkpoint.coveredSeq}: goal ${body.checkpoint.goal ?? "-"}; next ${body.checkpoint.nextAction ?? "-"}`);
    lines.push(`Last ${body.events.length} event(s)`, ...body.events.map((e) => `  #${e.seq} ${e.eventTime} ${e.role ?? e.type}${e.status === "incomplete" ? " [incomplete]" : ""}${e.truncated ? " [truncated]" : ""}: ${e.content.slice(0, 160).replace(/\s+/g, " ")}`));
  } else {
    const e = body.event;
    lines.push(`Event ${e.id}  session ${body.sessionId}  #${e.seq}  ${e.role ?? e.type}  ${e.status}${e.truncated ? " [truncated]" : ""}`, `Time ${e.eventTime} (${formatLocal(e.eventTime, tz)} local)  expires ${e.expiresAt}`, e.content);
  }
  write(ctx, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// --- items -----------------------------------------------------------------------------------------------------------

const itemLines = (verb, item) => [`${verb} ${item.id}  ${item.status}  ${item.kind}`, item.content];

async function itemCommand(ctx, sub) {
  check(ctx, sub);
  const id = ctx.positionals[1];
  if (id === undefined) throw new UsageError(`memory ${sub} needs an item id.`, { remediation: USAGE });
  const text = str(ctx, "text");
  if ((sub === "correct" || sub === "supersede") && text === undefined) throw new UsageError(`memory ${sub} needs --text.`, { remediation: USAGE });
  const kind = str(ctx, "kind");
  if (kind !== undefined && !ITEM_KINDS.includes(kind)) throw new UsageError(`--kind must be one of ${ITEM_KINDS.join(", ")}.`, { remediation: USAGE });
  const { settings } = loadSettings(ctx);
  const result = await using(ctx, { write: true }, ({ mem, viewer }) => {
    // Running this command IS the owner's explicit act: that is what `explicit` records.
    if (sub === "confirm") return must(confirmItem(mem, id, viewer, { explicit: true }));
    if (sub === "correct") return must(correctItem(mem, id, viewer, { content: text, explicit: true }, settings));
    return must(supersedeItem(mem, id, viewer, { content: text, kind, explicit: true }, settings));
  });
  if (json(ctx)) {
    write(ctx, `${stringifyJson({ ok: true, ...result })}\n`);
    return EXIT.OK;
  }
  const lines = sub === "confirm" ? (result.changed ? itemLines("Confirmed", result.item) : [`Item ${result.item.id} was already confirmed.`]) : [...itemLines("New", result.item), `${result.previous.id} is kept as superseded.`];
  write(ctx, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// --- forget ----------------------------------------------------------------------------------------------------------

function previewLines(r) {
  const parts = [`${r.events} event(s)`, `${r.items} item(s)`, `${r.checkpoints} checkpoint(s)`, `${r.sessions} session(s)`];
  return [`This would delete ${parts.join(", ")} and the search entries for them, and leave content-free tombstones so they cannot come back.`];
}

async function forgetCommand(ctx) {
  check(ctx, "forget");
  const id = ctx.positionals[1];
  const query = str(ctx, "query");
  if ((id === undefined) === (query === undefined && !(ctx.options.since || ctx.options.until || ctx.options.session || ctx.options.task))) {
    throw new UsageError("Give either an id or --query (with optional filters), not both and not neither.", { remediation: USAGE });
  }
  const filters = filtersOf(ctx);
  const target = await openContext(ctx, { write: true });
  try {
    const { mem, identity, viewer } = target;
    const run = (dry) => {
      if (id === undefined) return forgetBySearch(mem, { viewer, repoId: identity.repoId, query, ...filters, dryRun: dry });
      const asItem = id.startsWith("mi_") ? forgetItem(mem, { viewer, itemId: id, dryRun: dry }) : null;
      if (asItem?.ok) return asItem;
      const session = findSession(mem, id, viewer);
      if (session.ok && !findEventOwned(mem, id, viewer)) return forgetSession(mem, { viewer, sessionId: id, dryRun: dry });
      const asEvents = forgetEvents(mem, { viewer, eventIds: [id], dryRun: dry });
      if (asEvents.ok && asEvents.events > 0) return asEvents;
      const asItemPrefix = forgetItem(mem, { viewer, itemId: id, dryRun: dry });
      if (asItemPrefix.ok) return asItemPrefix;
      return { ok: false, code: "MEMORY_NOT_FOUND", message: "Nothing of yours has that id." };
    };
    const plan = must(run(true));
    const total = plan.events + plan.items + plan.checkpoints + plan.sessions;
    if (total === 0) {
      if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, dryRun: false, applied: false, ...plan })}\n`);
      else write(ctx, "Nothing matched; nothing was deleted.\n");
      return EXIT.OK;
    }
    const lines = previewLines(plan);
    const answer = await approval(ctx, lines, "Delete? [y/N]");
    if (answer === "interrupted") return EXIT.INTERRUPTED;
    if (answer === "no") {
      write(ctx, "Nothing was deleted.\n");
      return EXIT.OK;
    }
    if (answer === "needs-yes") return needsYes(ctx, { plan }, lines);
    const done = must(run(false));
    if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, applied: true, ...done })}\n`);
    else write(ctx, `${sanitizeLines([`Deleted ${done.events} event(s), ${done.items} item(s), ${done.checkpoints} checkpoint(s), ${done.sessions} session(s).`, "Copies outside the memory database (backups, exports, terminal history) are not touched."])}\n`);
    return EXIT.OK;
  } finally {
    target.mem?.close();
  }
}

function findEventOwned(mem, id, viewer) {
  return mem.db.prepare("SELECT 1 FROM events e JOIN sessions s ON s.id = e.session_id WHERE e.id = ? AND s.owner = ?").get(id, viewer) !== undefined;
}

// --- export ----------------------------------------------------------------------------------------------------------

async function exportCommand(ctx) {
  check(ctx, "export");
  const out = str(ctx, "out");
  if (ctx.options.force === true && out === undefined) throw new UsageError("--force only applies with --out.", { remediation: USAGE });
  const items = await using(ctx, { write: false }, ({ mem, identity, viewer }) => (mem && identity?.repoId ? exportableDecisions(mem, { viewer, repoId: identity.repoId }) : []));
  const at = new Date(nowOf(ctx)).toISOString();
  const rows = items.map((i) => ({ id: i.id, kind: i.kind, content: i.content, confirmedAt: i.lastVerifiedAt, recordedAt: i.recordedAt, supersedes: i.supersedes, sourceCount: i.sourceEventIds.length }));
  let text;
  if (json(ctx)) text = `${stringifyJson({ ok: true, exportedAt: at, count: rows.length, decisions: rows, written: out ?? null })}\n`;
  else {
    const body = rows.map((r) => `## ${r.kind}: ${r.content.split("\n")[0].slice(0, 100)}\n\n- id: ${r.id}\n- confirmed: ${r.confirmedAt ?? "unknown"}\n${r.supersedes ? `- supersedes: ${r.supersedes}\n` : ""}\n${r.content}\n`);
    text = ["# Project decisions", "", `Exported ${at} from Asterweave memory. Only confirmed decisions, requirements and constraints are included; no transcripts.`, "", ...(rows.length ? body : ["_No confirmed decisions._", ""])].join("\n");
  }
  if (out === undefined) {
    write(ctx, text.endsWith("\n") ? text : `${text}\n`);
    return EXIT.OK;
  }
  const target = path.resolve(ctx.cwd ?? process.cwd(), out);
  const fs = ctx.fs ?? nodeFs;
  try {
    fs.writeFileSync(target, text, { flag: ctx.options.force === true ? "w" : "wx" });
  } catch (error) {
    if (error?.code === "EEXIST") throw new CliError(`${safe(target)} already exists.`, { code: "EXPORT_EXISTS", remediation: "Choose another path, or pass --force to overwrite it." });
    throw new CliError(`Cannot write ${safe(target)}: ${safe(error?.message)}`, { code: "EXPORT_FAILED" });
  }
  if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, exportedAt: at, count: rows.length, written: target })}\n`);
  else write(ctx, `${sanitizeLines(`Wrote ${rows.length} decision(s) to ${target}`)}\n`);
  return EXIT.OK;
}

// --- archive ---------------------------------------------------------------------------------------------------------

async function archiveCommand(ctx, sub) {
  check(ctx, sub);
  const id = ctx.positionals[1];
  if (id === undefined) throw new UsageError(`memory ${sub} needs a session id.`, { remediation: USAGE });
  const result = await using(ctx, { write: true }, ({ mem, viewer }) => must(sub === "archive" ? archiveSession(mem, id, viewer) : unarchiveSession(mem, id, viewer)));
  if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, changed: result.changed, session: result.session })}\n`);
  else write(ctx, `${sanitizeLines(`${result.changed ? (sub === "archive" ? "Archived" : "Unarchived") : "Session was already"} ${result.session.id}${result.changed ? "" : ` ${result.session.state}`}. Retention is unchanged; it ${result.session.state === "archived" ? "stays searchable until it expires" : "is active"}.`)}\n`);
  return EXIT.OK;
}

// --- config writes: retention and capture -----------------------------------------------------------------------------

function writeUserSetting(ctx, key, value) {
  const file = userConfigFile(ctx);
  const fs = ctx.fs ?? nodeFs;
  let data = readJson(file, { fallback: {}, fs });
  if (data === null || typeof data !== "object" || Array.isArray(data)) throw new ConfigError(`${file} must contain a JSON object.`, { origin: `user:${file}`, remediation: `Fix or delete ${file}.` });
  const name = key.slice("memory.".length);
  if (Object.hasOwn(data, key)) data[key] = value;
  else {
    const section = data.memory && typeof data.memory === "object" && !Array.isArray(data.memory) ? data.memory : {};
    data = { ...data, memory: { ...section, [name]: value } };
  }
  writeJsonAtomic(file, data, { fs });
  return file;
}

const overrideWarning = (entry, key) => (entry.origin.startsWith("env:") ? `${entry.origin.slice(4)} is set and overrides ${key} from the config file for this and every later command.` : null);

async function retentionCommand(ctx) {
  check(ctx, "retention");
  const { entries, settings } = loadSettings(ctx);
  const rawSet = str(ctx, "set");
  const key = "memory.historyRetentionDays";
  if (rawSet === undefined) {
    const body = { ok: true, historyRetentionDays: settings.historyRetentionDays, summaryRetentionDays: settings.summaryRetentionDays, origin: entries[key].origin, pending: null };
    await using(ctx, { write: false }, ({ mem }) => {
      if (mem) body.pending = pendingCleanup(mem);
    });
    if (json(ctx)) write(ctx, `${stringifyJson(body)}\n`);
    else write(ctx, `${sanitizeLines([`History retention ${body.historyRetentionDays} days [${entries[key].origin}]; summaries ${body.summaryRetentionDays} days. Confirmed items are kept until forgotten.`, "Change it with: asterweave memory retention --set <days>"])}\n`);
    return EXIT.OK;
  }
  const days = coerceValue(key, rawSet, { origin: "--set", fromString: true });
  const target = await openContext(ctx, { write: false });
  try {
    const empty = { days, visibleBefore: { events: 0, checkpoints: 0, sessions: 0 }, events: { wouldExpire: 0, keptLonger: 0 }, checkpoints: { wouldExpire: 0 }, sessions: { wouldExpire: 0 } };
    const plan = target.mem ? planRetentionChange(target.mem, { days }) : empty;
    const lines = [
      `History retention ${settings.historyRetentionDays} -> ${days} days.`,
      `${plan.events.wouldExpire} event(s) would expire now (of ${plan.visibleBefore.events} readable), ${plan.checkpoints.wouldExpire} checkpoint(s), ${plan.sessions.wouldExpire} session(s).`,
      ...(plan.events.keptLonger > 0 ? [`${plan.events.keptLonger} event(s) would be kept longer. Data that has already expired is never brought back.`] : []),
    ];
    const answer = await approval(ctx, lines, "Apply? [y/N]");
    if (answer === "interrupted") return EXIT.INTERRUPTED;
    if (answer === "no") {
      write(ctx, "Nothing was changed.\n");
      return EXIT.OK;
    }
    if (answer === "needs-yes") return needsYes(ctx, { plan }, lines);
    const warning = overrideWarning(entries[key], key);
    writeUserSetting(ctx, key, days);
    // The DB must exist for a change to apply to; with none there is nothing stored to recompute.
    const applied = target.mem ? (target.mem.close(), await using(ctx, { write: true }, ({ mem }) => applyRetentionChange(mem, { days }))) : empty;
    if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, applied: true, plan, result: applied, ...(warning ? { warning } : {}) })}\n`);
    else write(ctx, `${sanitizeLines([...lines, "Applied. Expired data is hidden now; run `asterweave memory maintain` to delete it physically.", ...(warning ? [`Warning: ${warning}`] : [])])}\n`);
    return EXIT.OK;
  } finally {
    target.mem?.close();
  }
}

async function captureCommand(ctx) {
  check(ctx, "capture");
  const arg = ctx.positionals[1];
  if (arg !== undefined && arg !== "on" && arg !== "off") throw new UsageError("memory capture takes on or off.", { remediation: USAGE });
  const key = "memory.enabled";
  let { entries } = loadSettings(ctx);
  let warning = null;
  if (arg !== undefined) {
    warning = overrideWarning(entries[key], key);
    writeUserSetting(ctx, key, arg === "on");
    ({ entries } = loadSettings(ctx));
  }
  const enabled = entries[key].value;
  if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, enabled, origin: entries[key].origin, changed: arg !== undefined, ...(warning ? { warning } : {}) })}\n`);
  else write(ctx, `${sanitizeLines([`Capture is ${enabled ? "on" : "off"} [${entries[key].origin}].${arg !== undefined ? " Saved to your user config." : ""}`, ...(enabled ? [] : ["Future capture is stopped. Stored data is kept; delete it with `asterweave memory forget`."]), ...(warning ? [`Warning: ${warning}`] : [])])}\n`);
  return EXIT.OK;
}

// --- maintain / repo ---------------------------------------------------------------------------------------------------

async function maintainCommand(ctx) {
  check(ctx, "maintain");
  const batchSize = intOption(ctx, "batch-size", 1, 5000);
  const maxBatches = intOption(ctx, "max-batches", 1, 100000);
  const result = await using(ctx, { write: false }, ({ mem }) => {
    if (mem === null) return { removed: {}, batches: 0, complete: true, reindexed: false };
    const cleaned = physicalCleanup(mem, { ...(batchSize ? { batchSize } : {}), ...(maxBatches ? { maxBatches } : {}) });
    if (ctx.options.reindex === true) reindexSearch(mem);
    return { ...cleaned, reindexed: ctx.options.reindex === true };
  });
  if (json(ctx)) write(ctx, `${stringifyJson({ ok: true, ...result })}\n`);
  else {
    const total = Object.values(result.removed).reduce((a, b) => a + b, 0);
    write(ctx, `${sanitizeLines([`Removed ${total} expired row(s) in ${result.batches} batch(es).${result.complete ? "" : " More remain; run it again."}`, ...(result.reindexed ? ["Search index rebuilt."] : [])])}\n`);
  }
  return EXIT.OK;
}

async function repoCommand(ctx) {
  check(ctx, "repo");
  const [, action, decision] = ctx.positionals;
  if (action !== undefined && action !== "resolve") throw new UsageError(`Unknown repo action '${safe(action, 40)}'.`, { remediation: USAGE });
  if (action === "resolve" && decision !== "same" && decision !== "new") throw new UsageError("memory repo resolve needs 'same' (the remote moved: keep the history) or 'new' (a different repository).", { remediation: USAGE });
  if (action === undefined && decision !== undefined) throw new UsageError("Unexpected argument.", { remediation: USAGE });
  const body = await using(ctx, { write: true }, ({ mem, detected, identity }) => {
    if (mem === null || !identity) return { ok: true, repo: { id: null, status: "unmapped", cloneKey: detected.cloneKey, remote: detected.remote }, ambiguities: [], resolved: null };
    if (identity.unavailable) throw new CliError(identityWarnings(identity)[0], { code: "REPO_IDENTITY_UNAVAILABLE", remediation: "Nothing was changed. Try again; if git keeps failing, run `asterweave doctor`." });
    let resolved = null;
    if (action === "resolve") {
      resolved = must(resolveAmbiguity(mem, detected.cloneKey, decision));
      const next = resolveRepoIdentity(mem, detected, { create: false });
      return { ok: true, repo: { id: next.repoId, status: next.status, cloneKey: detected.cloneKey, remote: next.remote, ...describeRepo(mem, next.repoId) }, ambiguities: listAmbiguities(mem, detected.cloneKey), resolved };
    }
    return { ok: true, repo: { id: identity.repoId, status: identity.status, cloneKey: detected.cloneKey, remote: identity.remote, ...(identity.repoId ? describeRepo(mem, identity.repoId) : {}) }, ambiguities: listAmbiguities(mem, detected.cloneKey), resolved };
  });
  if (json(ctx)) {
    write(ctx, `${stringifyJson(body)}\n`);
    return EXIT.OK;
  }
  const lines = [`Repository ${body.repo.id ?? "(none recorded yet)"}  ${body.repo.status}`, `Remote     ${body.repo.remote ?? "none (identity is a random id bound to this clone)"}`, `Clone      ${body.repo.cloneKey}`];
  if (body.resolved) lines.push(`Resolved as ${body.resolved.decision}: this clone is now bound to ${body.resolved.repoId}.`);
  for (const a of body.ambiguities) lines.push(`Unresolved: the remote changed to ${a.observed} (detected ${a.detectedAt}). Run: asterweave memory repo resolve same|new`);
  write(ctx, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// --- import ----------------------------------------------------------------------------------------------------------

const SKIP_LABELS = { expired: "expired (past retention at the source time)", tombstoned: "tombstoned (forgotten)", malformed: "malformed lines", "unsupported-type": "unsupported record types", sidechain: "sidechain (subagent) turns", "other-repo": "other repository", meta: "meta records", "hidden-reasoning": "hidden reasoning blocks (never stored)", empty: "empty", "missing-id": "missing id", "no-timestamp": "no timestamp", "already-imported": "already imported", rejected: "rejected by capture", symlink: "symlinks (not followed)", "asterweave-run": "turns of Claude sessions driven by asterweave runs (never re-imported)", "predates-clone": "older than this clone's binding", "oversized-line": `oversized lines (over ${MAX_LINE_BYTES / (1024 * 1024)} MiB, not read)` };

/** `memory import claude [--dry-run] [--include-sidechains] [--max-bytes n]`: opt-in, read-only, idempotent import of this repository's Claude Code transcripts. */
async function importCommand(ctx) {
  check(ctx, "import");
  const source = ctx.positionals[1];
  if (source !== "claude") throw new UsageError(source === undefined ? "memory import needs a source: claude." : `Unknown import source '${safe(source, 40)}'; the only source is claude.`, { remediation: USAGE });
  const maxBytes = bytesOption(ctx, "max-bytes") ?? IMPORT_MAX_BYTES.default;
  const { entries, settings } = loadSettings(ctx);
  const origin = String(entries["memory.claudeImportEnabled"]?.origin ?? "");
  if (settings.claudeImportEnabled !== true || !origin.startsWith("user")) {
    throw new CliError("Importing Claude Code transcripts is off (it is opt-in).", {
      code: "MEMORY_IMPORT_DISABLED",
      remediation: `Set "memory": {"claudeImportEnabled": true} in your user config (${safe(userConfigFile(ctx), 300)}); a repository cannot turn it on. Then preview with: asterweave memory import claude --dry-run`,
    });
  }
  if (settings.enabled === false) throw new CliError("Memory capture is off, so nothing can be imported.", { code: "MEMORY_DISABLED", remediation: "Turn capture on with: asterweave memory capture on" });
  const dry = ctx.options["dry-run"] === true;
  const platform = ctx.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  const repo = await resolveRepo(ctx);
  const roots = await listWorktreeRoots(repo.workspace, { env: ctx.env ?? {}, platform, spawn: ctx.spawn, exists: ctx.exists, fs: ctx.fs });
  // The authorization boundary: a record is imported only when its own cwd resolves to THIS clone (same git common directory).
  const sameRepo = async (cwd) => p.isAbsolute(cwd) && (await resolveRepo({ ...ctx, cwd })).key === repo.key;
  const claudeDir = claudeHomeDir({ env: ctx.env ?? {}, platform, homedir: ctx.homedir });
  // Claude sessions that asterweave runs of this repository drove (their transcripts echo the injected memory section): skipped.
  const runSessions = asterweaveRunSessions(repo.key, seams(ctx));
  // A record written before this repository existed cannot be its history, even at the same path today (a reused folder).
  const birth = await readRepositoryBirth(repo, { env: ctx.env ?? {}, platform, spawn: ctx.spawn, exists: ctx.exists, fs: ctx.fs });
  if (!dry) startupMaintenance(storeOptions(ctx));
  const report = await using(ctx, { write: !dry }, async ({ mem, identity, viewer }) => {
    if (identity?.unavailable) throw new CliError(identityWarnings(identity)[0], { code: "REPO_IDENTITY_UNAVAILABLE", remediation: "Nothing was imported. Try again; if git keeps failing, run `asterweave doctor`." });
    if (identity?.ambiguous) throw new CliError(identityWarnings(identity)[0], { code: "REPO_AMBIGUOUS", remediation: "Run: asterweave memory repo resolve same|new" });
    return importClaude({ mem, now: ctx.now, dryRun: dry, includeSidechains: ctx.options["include-sidechains"] === true, maxBytes, claudeDir, roots, sameRepo, repoId: identity?.repoId ?? null, owner: viewer || null, settings, fs: ctx.fs, platform, runSessions: runSessions.ids, notBefore: birth.at });
  });
  const failed = report.errors.length > 0;
  if (json(ctx)) {
    const body = failed ? { ok: false, error: { code: "MEMORY_IMPORT_PARTIAL", message: "Some transcript lines could not be stored; rerun to retry them.", remediation: "Check the user directory is writable, then rerun." }, import: report } : { ok: true, import: report };
    write(ctx, `${stringifyJson(body)}\n`);
    return failed ? EXIT.ERROR : EXIT.OK;
  }
  const unchanged = report.files.filter((f) => f.unchanged).length;
  const rescanned = report.files.filter((f) => f.rescanned).length;
  const skips = Object.entries(report.skipped).filter(([, n]) => n > 0).map(([key, n]) => `${SKIP_LABELS[key] ?? key} ${n}`);
  const lines = [
    `${dry ? "Dry run (nothing written)" : "Import"}: Claude Code transcripts in ${report.projectsDir ?? "(no Claude Code directory found)"}`,
    `${report.dirs.length} project director${report.dirs.length === 1 ? "y" : "ies"} of this repository, ${report.files.length} transcript file(s) (${unchanged} unchanged, ${rescanned} rescanned)`,
    `${dry ? "Would import" : "Imported"} ${report.events} event(s) in ${report.sessions} session(s)`,
    `Skipped: ${skips.length ? skips.join(", ") : "nothing"}`,
  ];
  if (!report.notBefore) lines.push("  The repository's first-commit time is unknown, so no age cutoff was applied: records written before this repository existed at this path were not excluded.");
  if (report.skipped["predates-clone"] > 0) lines.push(`  ${report.skipped["predates-clone"]} record(s) were written before this repository's first commit or folder existed (${report.notBefore}) and were skipped: the path may have held another repository then`);
  if (report.memorySectionsStripped > 0) lines.push(`  ${report.memorySectionsStripped} asterweave memory section(s) were removed from imported text (memory is never re-imported from a transcript)`);
  if (runSessions.truncated) lines.push("  Warning: the run ledgers were read only up to their bound; a Claude session of a very old asterweave run may not be recognised");
  for (const d of report.dirs) {
    if (d.hint) lines.push(`  ${d.dir}: found by the long-name prefix hint (unverified); each record is still checked against this repository`);
  }
  for (const f of report.files) {
    if (f.events > 0) lines.push(`  ${f.file}: ${f.events} event(s)${f.rescanned ? ` (rescanned: ${f.rescanned})` : ""}`);
    if (f.tornLine) lines.push(`  ${f.file}: the last line is still being written; it is imported once it is complete`);
    if (f.error) lines.push(`  ${f.file}: ${f.error}`);
  }
  for (const warning of report.formatWarnings) lines.push(`Warning: ${warning.message}`);
  if (report.partial) {
    lines.push(dry
      ? `Stopped at the read budget (${report.maxBytes} bytes, --max-bytes): the counts cover only what was read. A real import continues where it stopped on each rerun.`
      : `Stopped at the read budget (${report.maxBytes} bytes, --max-bytes) after complete lines; more remains. Rerun the import to continue.`);
  }
  lines.push("Claude Code's files were only read; nothing under the Claude Code directory was changed.");
  write(ctx, `${sanitizeLines(lines)}\n`);
  return failed ? EXIT.ERROR : EXIT.OK;
}

// --- dispatch --------------------------------------------------------------------------------------------------------

/** `memory trace [runId] [--session id]`: what the context builder attached to each request. Read-only; ids and numbers only. */
async function traceCommand(ctx) {
  check(ctx, "trace");
  const runId = ctx.positionals[1];
  const session = str(ctx, "session");
  if (runId !== undefined && session !== undefined) throw new UsageError("Give either a run id or --session, not both.", { remediation: USAGE });
  if (runId === undefined && session === undefined) throw new UsageError("memory trace needs a run id or --session <id>.", { remediation: USAGE });
  const limit = intOption(ctx, "limit", 1, 1000) ?? 200;
  return using(ctx, { write: false }, async ({ mem, viewer }) => {
    let traces = [];
    if (mem) {
      if (runId !== undefined) traces = listTraces(mem, { owner: viewer, runId, limit });
      else {
        const ids = mem.db.prepare("SELECT id FROM sessions WHERE (id = ? OR external_session_id = ?) AND owner = ?").all(session, session, viewer).map((row) => row.id);
        traces = ids.flatMap((id) => listTraces(mem, { owner: viewer, sessionId: id, limit })).sort((a, b) => a.id - b.id).slice(0, limit);
      }
    }
    const totals = traceTotals(traces);
    if (json(ctx)) {
      write(ctx, `${stringifyJson({ ok: true, traces, totals })}\n`);
      return EXIT.OK;
    }
    if (traces.length === 0) {
      write(ctx, `${sanitizeLines([mem ? "No memory traces for that run or session (memory may have been off, or nothing was built)." : "Nothing is stored yet."])}\n`);
      return EXIT.OK;
    }
    const lines = traces.flatMap((t) => [
      `#${t.id}  ${t.createdAt}  run ${t.runId ?? "-"}  ${t.node ?? "-"}#${t.attempt ?? "-"}  ~${t.memoryTokens ?? 0} tokens (estimated)  cache ${t.cacheHit ? "hit" : "miss"}  ${t.selectedIds.length} selected  ${t.timingMs ?? 0} ms  ${t.rationale}`,
      ...(t.selectedIds.length > 0 ? [`  ids: ${t.selectedIds.join(", ")}`] : []),
    ]);
    lines.push(`Total: ${totals.requests} request(s), ~${totals.memoryTokens} memory tokens (estimated), cache ${totals.cacheHits} hit(s) / ${totals.cacheMisses} miss(es), summary/extraction tokens 0 (deterministic)`);
    write(ctx, `${sanitizeLines(lines)}\n`);
    return EXIT.OK;
  });
}

/** Handler for `asterweave memory ...`. */
export async function memoryCommand(ctx) {
  const sub = (ctx.positionals ?? [])[0];
  ctx = { ...ctx, positionals: ctx.positionals ?? [], options: ctx.options ?? {} };
  if (!sub || !Object.hasOwn(FLAGS, sub)) throw new UsageError(sub ? `Unknown memory subcommand '${safe(sub, 40)}'.` : "Missing memory subcommand.", { remediation: USAGE });
  // Commands that write start with a bounded cleanup of expired rows (hidden from reads either way).
  if (["confirm", "correct", "supersede", "forget", "archive", "unarchive"].includes(sub)) startupMaintenance(storeOptions(ctx));
  switch (sub) {
    case "status":
      return statusCommand(ctx);
    case "search":
      return searchCommand(ctx);
    case "show":
      return showCommand(ctx);
    case "confirm":
    case "correct":
    case "supersede":
      return itemCommand(ctx, sub);
    case "forget":
      return forgetCommand(ctx);
    case "export":
      return exportCommand(ctx);
    case "archive":
    case "unarchive":
      return archiveCommand(ctx, sub);
    case "retention":
      return retentionCommand(ctx);
    case "capture":
      return captureCommand(ctx);
    case "maintain":
      return maintainCommand(ctx);
    case "trace":
      return traceCommand(ctx);
    case "import":
      return importCommand(ctx);
    default:
      return repoCommand(ctx);
  }
}
