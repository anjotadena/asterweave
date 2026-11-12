// Opt-in, read-only import of Claude Code transcripts (~/.claude/projects/<path-slug>/<sessionId>.jsonl) into memory.
//
// FORMAT ASSUMPTIONS LIVE IN ONE PLACE: `CLAUDE_FORMAT` and `parseClaudeLine` below. Claude Code's transcript format is not a
// published contract, so the parser is versioned by the per-line `version` field (the build that WROTE the line: the VS Code
// extension bundles its own build, so the installed `claude --version` says nothing about a file). A line outside the tested
// range is parsed best-effort and reported as a format warning; an unknown record type is skipped (forward compatible). Only
// `user` and `assistant` records are ever imported; request payloads (`api-request*`), file snapshots and attachments never are.
// Hidden reasoning (`thinking` / `redacted_thinking` blocks) is dropped before anything reaches capture.
//
// GUARANTEES (tests/memory-import.test.mjs covers each, except symlink skipping, which needs link privileges on Windows):
//   - OPT-IN: the caller refuses unless memory.claudeImportEnabled = true (user config only).
//   - AUTHORIZATION BOUNDARY: only project directories whose slug matches a work tree root of the CURRENT clone (or a
//     subdirectory of one) are opened, and every record's `cwd` must resolve to the same clone (`sameRepo`); the slug is lossy,
//     so a folder that merely looks the same is rejected per record ('other-repo'). Symlinked directories and files are skipped.
//     A slug longer than CLAUDE_FORMAT.longSlugPrefix also matches directories that start with its first N characters (Claude
//     Code shortens long names with a hash suffix that is NOT reproduced): a DISCOVERY HINT only; the per-record check decides.
//   - NESTED transcripts (*.jsonl up to CLAUDE_FORMAT.nestedDepth directory levels below a project directory, e.g. subagent
//     files) are read only with --include-sidechains, through the same per-record check, with their own watermark rows.
//   - BOUNDED: one run consumes at most `maxBytes` of transcript lines across all files (but at least one complete line when
//     any remain, so reruns always progress), stops at a complete-line watermark and reports `partial`.
//   - READ-ONLY: Claude-owned files are opened 'r' and only read. Nothing under ~/.claude is created, changed or deleted.
//   - IDEMPOTENT: event ids come from the source (claude:<sessionId>:<uuid>[:<block>]), so a replay is a no-op in capture.
//     A per-file watermark (size, byte offset, last uuid and where it starts, mtime) makes re-runs incremental; a file that
//     shrank or whose watermark line no longer holds the recorded uuid (rotation, truncation, compaction) is rescanned from 0,
//     which is safe because of the ids.
//   - A TORN final line (no newline yet) is never consumed and the watermark stays before it. Malformed lines are counted,
//     skipped and reported, and the watermark moves past them (they cannot become valid later).
//   - Capture's rules apply: redaction before persistence, tombstones (forgotten ids never come back), expiry from the SOURCE
//     time (an event already past retention is skipped, never stored as "new"), order by file offset, private visibility.
//   - NO ECHO OF ASTERWEAVE'S OWN MEMORY: Claude sessions driven by an asterweave run of THIS repository (their `provider.session`
//     ids in the run ledgers) are skipped per record ('asterweave-run'): they hold the injected memory section, so a forgotten
//     item would otherwise return under a new id. As defence in depth any `<asterweave-memory>…</asterweave-memory>` block (case
//     and spacing tolerated; an unclosed one runs to the end of the text) is stripped from every imported text before capture.
//   - THE LIVE PIPELINE'S TOOL-OUTPUT POLICY: memory.toolResultExcerptChars = 0 stores a content-free marker per tool result;
//     otherwise a text-only excerpt, redacted then cut, with the same header and source metadata. A tool call is stored as its
//     name and a one-line input summary (scalar fields only), never the full input.
//   - Source ids must be UUID-shaped (SOURCE_ID); anything else is malformed. A line over MAX_LINE_BYTES is skipped unread
//     ('oversized-line') and the watermark moves past it. Watermarks are keyed by repository AND path (watermarkKey).

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { runBinary } from "../../proc.mjs";
import { gitEnv } from "../../repo.mjs";
import { summarizeInput, TOOL_RESULT_EXCERPT_MAX, toolResultExcerpt } from "../claude/stream.mjs";
import { EVENTS_FILE, repoDirName, runsRoot } from "../ledger.mjs";
import { appendEvent } from "./capture.mjs";
import { addDays, clockOf, toIso, transaction } from "./db.mjs";
import { redactForMemory } from "./redact.mjs";
import { openSession } from "./sessions.mjs";
import { withDefaults } from "./settings.mjs";
import { isTombstoned } from "./tombstones.mjs";
import { worktreeIdOf } from "./workspace.mjs";

// --- the format: every assumption about Claude Code's files ---------------------------------------------------------

export const CLAUDE_FORMAT = Object.freeze({
  /** Per-line `version` values this parser was checked against: >= min and < below. Others parse best-effort with a warning. */
  testedVersions: Object.freeze({ min: "1.0.0", below: "3.0.0" }),
  /** The only record types that are imported. */
  messageTypes: Object.freeze(["user", "assistant"]),
  /** Record types that must never be imported (request payloads, file snapshots, attachments). Listed for tests and docs. */
  neverImport: Object.freeze(["api-request", "api-request-shape", "api-request-blob", "file-history-snapshot", "attachment"]),
  /** Content blocks that carry hidden reasoning: always dropped. */
  hiddenBlocks: Object.freeze(["thinking", "redacted_thinking"]),
  /** Transcript files: one per session directly inside a project directory; nested ones (e.g. subagents) in subdirectories. */
  fileSuffix: ".jsonl",
  /** How many directory levels below a project directory nested transcripts are looked for (only with --include-sidechains). */
  nestedDepth: 3,
  /**
   * UNVERIFIED (observed, not a published contract): Claude Code cuts a project-directory name longer than this many characters
   * and appends a hash suffix. The hash is NOT reproduced: a longer expected slug also matches directories whose name starts
   * with its first `longSlugPrefix` characters. A discovery hint only; every record's cwd is still checked.
   */
  longSlugPrefix: 200,
});

/** The per-run read budget of `memory import claude --max-bytes`: bytes of transcript lines consumed across all files. */
export const IMPORT_MAX_BYTES = Object.freeze({ default: 64 * 1024 * 1024, min: 1024, max: 4 * 1024 * 1024 * 1024 });

const MESSAGE_TYPES = new Set(CLAUDE_FORMAT.messageTypes);
const HIDDEN = new Set(CLAUDE_FORMAT.hiddenBlocks);

/** Numeric compare of dotted versions ("2.1.322" vs "3.0.0"); a missing part is 0. */
export function compareVersions(a, b) {
  const pa = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const pb = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Whether a per-line version is inside the tested range (a missing or non-numeric version is not). */
export function versionKnown(version) {
  if (typeof version !== "string" || !/^\d+\.\d+/.test(version)) return false;
  const { min, below } = CLAUDE_FORMAT.testedVersions;
  return compareVersions(version, min) >= 0 && compareVersions(version, below) < 0;
}

const str = (value) => (typeof value === "string" && value !== "" ? value : null);

/** Shape of an imported sessionId / uuid: 8-64 hex digits and dashes, starting and ending with a hex digit. */
export const SOURCE_ID = /^[0-9a-f][0-9a-f-]{6,62}[0-9a-f]$/i;
const sourceId = (value) => (typeof value === "string" && SOURCE_ID.test(value) ? value : null);

/** Longest transcript line (bytes, without its newline) that is buffered and parsed; a longer one is skipped unread. */
export const MAX_LINE_BYTES = 8 * 1024 * 1024;

/**
 * Remove every asterweave memory section from `text`: open-to-close pairs, then everything from an unclosed opening tag, then
 * stray closing tags. Case and whitespace inside the tags are tolerated. Linear: each tag is searched for once.
 * @returns {{text: string, sections: number}}
 */
export function stripMemorySections(text) {
  if (typeof text !== "string" || !/asterweave-memory/i.test(text)) return { text, sections: 0 };
  const open = /<\s*asterweave-memory\b/gi;
  const close = /<\s*\/\s*asterweave-memory\s*>/gi;
  let out = "";
  let pos = 0;
  let sections = 0;
  for (;;) {
    open.lastIndex = pos;
    const o = open.exec(text);
    if (!o) {
      out += text.slice(pos);
      break;
    }
    out += text.slice(pos, o.index);
    sections += 1;
    close.lastIndex = o.index + o[0].length;
    const c = close.exec(text);
    if (!c) break; // unclosed: the rest of the text is the section
    pos = c.index + c[0].length;
  }
  close.lastIndex = 0;
  return { text: out.replace(close, ""), sections };
}

/** The TEXT parts of a tool_result's content (never images or other blocks), each with its memory sections stripped. */
function toolResultContent(content, counter) {
  const strip = (text) => {
    const s = stripMemorySections(text);
    counter.sections += s.sections;
    return s.text;
  };
  if (typeof content === "string") return strip(content);
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => ({ type: "text", text: strip(part.text) }));
}

// Keep in sync with pipeline.mjs (TOOL_RESULT_MARKER, excerptHeader): imported tool output is stored exactly like live output.
const TOOL_RESULT_MARKER = "[tool result received; its output is not captured]";
const excerptHeader = (item, kept) => `[tool result${item.isError ? " (error)" : ""}: excerpt of ${kept} of ${item.originalChars} chars${item.truncated ? ", truncated" : ""}]`;
const TOOL_NAME_MAX = 100;

/**
 * Parse ONE transcript line. Never throws.
 * @param {string} line  one line without its newline
 * @param {{includeSidechains?: boolean}} [options]
 * @returns {{kind: 'malformed', reason: string} |
 *   {kind: 'skip', reason: 'unsupported-type'|'meta'|'sidechain'|'missing-id'|'no-timestamp'|'empty', type: string|null, version: string|null, uuid: string|null} |
 *   {kind: 'message', type: 'user'|'assistant', version: string|null, versionKnown: boolean, uuid: string, sessionId: string, parentUuid: string|null,
 *    timestamp: string, cwd: string|null, gitBranch: string|null, model: string|null, isSidechain: boolean, hiddenBlocks: number, memorySections: number,
 *    blocks: Array<{type:'text', text:string} | {type:'tool_use', id:string|null, name:string, input:unknown} | {type:'tool_result', toolUseId:string|null, content:string|Array<{type:'text', text:string}>, isError:boolean}>}}
 *   `uuid` on a skip is null unless it is UUID-shaped (it may become a watermark). A message's sessionId and uuid are always
 *   UUID-shaped (else 'malformed', reason 'id'); its texts have their asterweave memory sections stripped (`memorySections` counts them).
 */
export function parseClaudeLine(line, { includeSidechains = false } = {}) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    return { kind: "malformed", reason: "json" };
  }
  if (record === null || typeof record !== "object" || Array.isArray(record)) return { kind: "malformed", reason: "not-object" };
  const type = str(record.type);
  const version = str(record.version);
  const rawUuid = str(record.uuid);
  const uuid = sourceId(rawUuid);
  const base = { type, version, uuid };
  if (!MESSAGE_TYPES.has(type)) return { kind: "skip", reason: "unsupported-type", ...base };
  if (record.isMeta === true) return { kind: "skip", reason: "meta", ...base };
  if (record.isSidechain === true && !includeSidechains) return { kind: "skip", reason: "sidechain", ...base };
  const rawSessionId = str(record.sessionId);
  if (!rawUuid || !rawSessionId) return { kind: "skip", reason: "missing-id", ...base };
  const sessionId = sourceId(rawSessionId);
  if (!uuid || !sessionId) return { kind: "malformed", reason: "id" };
  let timestamp;
  try {
    timestamp = toIso(record.timestamp ?? "");
  } catch {
    return { kind: "skip", reason: "no-timestamp", ...base };
  }
  const message = record.message && typeof record.message === "object" ? record.message : {};
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : Array.isArray(message.content) ? message.content : [];
  const blocks = [];
  let hiddenBlocks = 0;
  const counter = { sections: 0 };
  for (const block of content) {
    const kind = str(block?.type);
    if (kind === null) continue;
    if (HIDDEN.has(kind)) hiddenBlocks += 1;
    else if (kind === "text" && typeof block.text === "string") {
      const stripped = stripMemorySections(block.text);
      counter.sections += stripped.sections;
      if (stripped.text.trim() !== "") blocks.push({ type: "text", text: stripped.text });
    } else if (kind === "tool_use") blocks.push({ type: "tool_use", id: str(block.id), name: (str(block.name) ?? "tool").slice(0, TOOL_NAME_MAX), input: block.input ?? null });
    else if (kind === "tool_result") blocks.push({ type: "tool_result", toolUseId: str(block.tool_use_id), content: toolResultContent(block.content, counter), isError: block.is_error === true });
    // any other block type (image, document, server tool blocks, future types) is not imported
  }
  const memorySections = counter.sections;
  if (blocks.length === 0) return { kind: "skip", reason: hiddenBlocks > 0 ? "hidden-reasoning" : "empty", ...base, hiddenBlocks, memorySections };
  return {
    kind: "message",
    type,
    version,
    versionKnown: versionKnown(version),
    uuid,
    sessionId,
    parentUuid: str(record.parentUuid),
    timestamp,
    cwd: str(record.cwd),
    gitBranch: str(record.gitBranch),
    model: type === "assistant" ? str(message.model) ?? str(record.requestedModel) : null,
    isSidechain: record.isSidechain === true,
    hiddenBlocks,
    memorySections,
    blocks,
  };
}

/** memory.toolResultExcerptChars as the live pipeline reads it: a whole number in 0..TOOL_RESULT_EXCERPT_MAX (undefined: the default). */
function excerptLimit(value) {
  const n = value === undefined ? withDefaults().toolResultExcerptChars : value;
  return Math.min(Math.max(0, Math.trunc(Number(n)) || 0), TOOL_RESULT_EXCERPT_MAX);
}

/**
 * Capture events for one parsed message, in block order. Text blocks become ONE message event; each tool_use a tool_call (its
 * name and a one-line input summary) and each tool_result a tool_result (linked by the tool-use id) holding, like the live
 * pipeline, a content-free marker when `toolResultExcerptChars` is 0, else a redacted text-only excerpt cut to that many
 * characters under a one-line header. The first event's id is claude:<sessionId>:<uuid>; further events of the same record
 * append :<n>. Deterministic, so a replay yields the same ids.
 * @param {object} msg  a parsed 'message'
 * @param {{toolResultExcerptChars?: number}} [options]  default: memory.toolResultExcerptChars's default
 */
export function eventsFromMessage(msg, { toolResultExcerptChars } = {}) {
  const limit = excerptLimit(toolResultExcerptChars);
  const baseId = `claude:${msg.sessionId}:${msg.uuid}`;
  const out = [];
  const text = msg.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n\n");
  const common = { eventTime: msg.timestamp, provider: "anthropic", agentId: "claude-code" };
  if (text !== "") out.push({ ...common, type: "message", role: msg.type, content: text, model: msg.model ?? undefined });
  for (const block of msg.blocks) {
    if (block.type === "tool_use") {
      // summarizeInput is cut to a fixed length, which could leave the start of a memory tag: strip again after it
      const summary = stripMemorySections(`${block.name} ${summarizeInput(block.input)}`.trim()).text;
      out.push({ ...common, type: "tool_call", role: "assistant", content: summary, toolCallId: block.id ?? undefined, model: msg.model ?? undefined });
    } else if (block.type === "tool_result") {
      const event = { ...common, type: "tool_result", role: "tool", toolCallId: block.toolUseId ?? undefined };
      if (limit === 0) out.push({ ...event, content: TOOL_RESULT_MARKER });
      else {
        const item = toolResultExcerpt({ content: block.content, is_error: block.isError }, limit);
        const kept = item.excerpt.slice(0, limit);
        const truncated = item.truncated === true || item.originalChars > kept.length;
        out.push({ ...event, content: `${excerptHeader({ ...item, truncated }, kept.length)}\n${kept}`, sourceChars: item.originalChars, sourceTruncated: truncated });
      }
    }
  }
  return out.map((event, index) => ({ ...event, id: index === 0 ? baseId : `${baseId}:${index}` }));
}

// --- locations ---------------------------------------------------------------------------------------------------------

/** Claude Code's project-directory name for a path: every character that is not an ASCII letter or digit becomes '-'. */
export const slugFor = (dir) => String(dir).replace(/[^a-zA-Z0-9]/g, "-");

/** ~/.claude (or an absolute CLAUDE_CONFIG_DIR), from the given environment only: never the process's own. */
export function claudeHomeDir({ env = {}, platform = process.platform, homedir } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (typeof env.CLAUDE_CONFIG_DIR === "string" && p.isAbsolute(env.CLAUDE_CONFIG_DIR)) return env.CLAUDE_CONFIG_DIR;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME) || env.HOME || env.USERPROFILE || (typeof homedir === "function" ? homedir() : null);
  return typeof home === "string" && home !== "" ? p.join(home, ".claude") : null;
}

function gitFlags(platform) {
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand="];
}

/** The work tree roots of the clone at `workspace` (`git worktree list --porcelain`), always including `workspace`. */
export async function listWorktreeRoots(workspace, options = {}) {
  const platform = options.platform ?? process.platform;
  const roots = [workspace];
  try {
    const result = await runBinary("git", [...gitFlags(platform), "worktree", "list", "--porcelain"], {
      cwd: workspace, env: gitEnv(options.env ?? {}), spawn: options.spawn, exists: options.exists, platform, timeoutMs: options.timeoutMs ?? 10_000,
    });
    if (!result.error && result.code === 0) {
      for (const line of String(result.stdout).split(/\r?\n/)) if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length));
    }
  } catch {
    // no git: the current work tree alone
  }
  const fs = options.fs ?? nodeFs;
  const out = new Set();
  for (const root of roots) {
    out.add(root);
    try {
      out.add(fs.realpathSync.native(root));
    } catch {
      // a worktree that no longer exists keeps its recorded path only
    }
  }
  return [...out];
}

/**
 * Project directories under <claudeDir>/projects that belong to `roots` by name: the root's slug, or a subdirectory's
 * (slug + '-'). A slug longer than `slugPrefixLength` also matches names starting with its first `slugPrefixLength`
 * characters (the long-slug hint; such directories are also listed in `hinted`). Names are compared case-insensitively on
 * win32. Symlinks are never followed.
 * @returns {{projectsDir: string|null, dirs: string[], hinted: string[], symlinks: number}}
 */
export function discoverProjectDirs(claudeDir, roots, { fs = nodeFs, platform = process.platform, slugPrefixLength = CLAUDE_FORMAT.longSlugPrefix } = {}) {
  if (!claudeDir) return { projectsDir: null, dirs: [], hinted: [], symlinks: 0 };
  const fold = (s) => (platform === "win32" ? s.toLowerCase() : s);
  const projectsDir = path.join(claudeDir, "projects");
  let entries;
  try {
    entries = fs.readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return { projectsDir, dirs: [], hinted: [], symlinks: 0 };
  }
  const slugs = [...new Set(roots.map((root) => fold(slugFor(root))))].filter((slug) => slug.replace(/-/g, "") !== "");
  const prefixes = slugs.filter((slug) => slug.length > slugPrefixLength).map((slug) => slug.slice(0, slugPrefixLength));
  const dirs = [];
  const hinted = [];
  let symlinks = 0;
  for (const entry of entries) {
    const name = fold(entry.name);
    const exact = slugs.some((slug) => name === slug || name.startsWith(`${slug}-`));
    const hint = !exact && prefixes.some((prefix) => name.startsWith(prefix));
    if (!exact && !hint) continue;
    if (entry.isSymbolicLink()) {
      symlinks += 1;
      continue;
    }
    if (!entry.isDirectory()) continue;
    dirs.push(path.join(projectsDir, entry.name));
    if (hint) hinted.push(path.join(projectsDir, entry.name));
  }
  return { projectsDir, dirs: dirs.sort(), hinted: hinted.sort(), symlinks };
}

// --- reading ------------------------------------------------------------------------------------------------------------

const CHUNK = 4 * 1024 * 1024;

/**
 * Lines of `fd` between byte offsets, each with its byte range. The last one is `torn` when it has no newline. A line longer
 * than `maxLine` bytes is not buffered: it is yielded `oversized` with its byte range and empty text. The pieces of a line that
 * spans reads are kept in a list and joined once.
 */
function* readLines(fs, fd, start, end, maxLine = MAX_LINE_BYTES) {
  let pos = start;
  let parts = [];
  let partLen = 0;
  let oversized = false;
  let lineStart = start;
  while (pos < end) {
    const want = Math.min(CHUNK, end - pos);
    const buf = Buffer.allocUnsafe(want);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) break;
    const data = buf.subarray(0, n);
    const dataStart = pos;
    pos += n;
    let from = 0;
    for (let i = data.indexOf(0x0a); i !== -1; i = data.indexOf(0x0a, from)) {
      const lineEnd = dataStart + i + 1;
      if (oversized || partLen + (i - from) > maxLine) yield { start: lineStart, end: lineEnd, text: "", torn: false, oversized: true };
      else {
        const bytes = parts.length ? Buffer.concat([...parts, data.subarray(from, i)]) : data.subarray(from, i);
        yield { start: lineStart, end: lineEnd, text: bytes.toString("utf8").replace(/\r$/, ""), torn: false, oversized: false };
      }
      parts = [];
      partLen = 0;
      oversized = false;
      from = i + 1;
      lineStart = lineEnd;
    }
    const rest = n - from;
    if (rest > 0) {
      if (!oversized && partLen + rest > maxLine) {
        oversized = true; // stop buffering; the bytes up to the next newline are only counted
        parts = [];
      }
      if (!oversized) parts.push(data.subarray(from));
      partLen += rest;
    }
  }
  if (partLen > 0) yield { start: lineStart, end: lineStart + partLen, text: oversized ? "" : Buffer.concat(parts).toString("utf8"), torn: true, oversized };
}

function readSlice(fs, fd, start, end) {
  const len = Math.max(0, Math.min(end - start, MAX_LINE_BYTES + 1)); // only the first line is ever needed
  const buf = Buffer.alloc(len);
  const n = len ? fs.readSync(fd, buf, 0, len, start) : 0;
  return buf.toString("utf8", 0, n);
}

/** Whether the stored watermark still describes this file. */
function watermarkHolds(fs, fd, mark, size) {
  if (size < mark.offset) return { ok: false, reason: "shrank" };
  if (!mark.last_uuid) return { ok: true };
  const slice = readSlice(fs, fd, Number(mark.last_uuid_offset), Number(mark.offset));
  const first = slice.split("\n")[0];
  try {
    if (JSON.parse(first)?.uuid === mark.last_uuid) return { ok: true };
  } catch {
    // fall through
  }
  return { ok: false, reason: "watermark-moved" };
}

// --- the importer -------------------------------------------------------------------------------------------------------

export const IMPORT_META_KEY = "claude_import_last_at";
const TITLE_MAX = 80;
const SKIP_KEYS = ["expired", "tombstoned", "malformed", "unsupported-type", "sidechain", "other-repo", "asterweave-run", "predates-clone", "meta", "hidden-reasoning", "empty", "missing-id", "no-timestamp", "already-imported", "rejected", "symlink", "oversized-line"];

const memorySessionId = (repoId, claudeSessionId) => `ms_cc_${createHash("sha256").update(`claude:${repoId}:${claudeSessionId}`).digest("hex").slice(0, 24)}`;
const fileKey = (file, platform) => (platform === "win32" ? file.toLowerCase() : file);
/**
 * The claude_import_files.path value of a transcript: `<repoId>|<path>` (case-folded on win32), so the watermark of a file read
 * from one repository never answers for another. A legacy row keyed by the path alone is honoured only for the repo_id it records.
 */
export const watermarkKey = (repoId, file, platform = process.platform) => `${repoId}|${fileKey(file, platform)}`;

/** Bounds of the read-only scan of this repository's run ledgers for the Claude sessions asterweave itself drove. */
export const RUN_SCAN_LIMITS = Object.freeze({ maxRuns: 10_000, maxLedgerBytes: 64 * 1024 * 1024 });

/**
 * Claude session ids recorded by asterweave runs of the repository `repoKey` (`provider.session` events in
 * <runsRoot>/<repoDir>/<runId>/events.jsonl), lower-cased. Read-only and tolerant: a missing, corrupt or symlinked ledger is
 * skipped, never an error; at most RUN_SCAN_LIMITS.maxRuns runs and maxLedgerBytes per ledger are read (`truncated` says a
 * bound was hit).
 * @param {string} repoKey
 * @param {{env?: object, platform?: string, homedir?: Function, fs?: typeof nodeFs}} [options]  as for ledger.runsRoot
 * @returns {{ids: Set<string>, runs: number, truncated: boolean}}
 */
export function asterweaveRunSessions(repoKey, options = {}) {
  const fs = options.fs ?? nodeFs;
  const ids = new Set();
  let runs = 0;
  let truncated = false;
  let entries;
  let base;
  try {
    base = path.join(runsRoot(options), repoDirName(repoKey));
    entries = fs.readdirSync(base, { withFileTypes: true });
  } catch {
    return { ids, runs, truncated };
  }
  if (entries.length > RUN_SCAN_LIMITS.maxRuns) truncated = true;
  for (const entry of entries.slice(0, RUN_SCAN_LIMITS.maxRuns)) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const file = path.join(base, entry.name, EVENTS_FILE);
    let size;
    let fd;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile()) continue;
      size = stat.size;
      fd = fs.openSync(file, "r");
    } catch {
      continue;
    }
    runs += 1;
    if (size > RUN_SCAN_LIMITS.maxLedgerBytes) truncated = true;
    try {
      for (const line of readLines(fs, fd, 0, Math.min(size, RUN_SCAN_LIMITS.maxLedgerBytes))) {
        if (line.oversized || !line.text.includes("provider.session")) continue;
        try {
          const event = JSON.parse(line.text);
          if (event?.type === "provider.session" && typeof event.providerSessionId === "string" && event.providerSessionId !== "") ids.add(event.providerSessionId.toLowerCase());
        } catch {
          // a torn or corrupt ledger line: not a session record
        }
      }
    } catch {
      // unreadable: what was read counts
    } finally {
      fs.closeSync(fd);
    }
  }
  return { ids, runs, truncated };
}

function titleOf(events, claudeSessionId) {
  const first = events.find((e) => e.type === "message" && e.role === "user" && e.content.trim() !== "");
  // Redact the WHOLE text first and cut after: cutting first could leave the prefix of a secret below a pattern's minimum length.
  const line = first ? redactForMemory(first.content).text.trim().split(/\r?\n/)[0] : `Claude Code session ${claudeSessionId.slice(0, 8)}`;
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

/**
 * Nested transcript files below a project directory: *.jsonl inside its subdirectories, down to CLAUDE_FORMAT.nestedDepth
 * levels, breadth first and sorted per directory. Symlinked entries are counted and never followed.
 * @returns {{files: string[], symlinks: number}}
 */
function listNested(fs, projectDir) {
  const files = [];
  let symlinks = 0;
  let level = [projectDir];
  for (let depth = 0; depth <= CLAUDE_FORMAT.nestedDepth && level.length > 0; depth += 1) {
    const next = [];
    for (const dir of level) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const isTranscript = entry.name.endsWith(CLAUDE_FORMAT.fileSuffix);
        if (entry.isSymbolicLink()) {
          // depth 0: a symlinked top-level transcript is already counted by the caller; a symlinked subdirectory is counted here
          if (depth > 0 || !isTranscript) symlinks += 1;
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < CLAUDE_FORMAT.nestedDepth) next.push(full);
        else if (depth > 0 && isTranscript && entry.isFile()) files.push(full);
      }
    }
    level = next;
  }
  return { files, symlinks };
}

/**
 * Import (or, with `dryRun`, only classify) the Claude Code transcripts of the current clone.
 * @param {{mem: import('./db.mjs').Memory|null, now?: Function, dryRun?: boolean, includeSidechains?: boolean, maxBytes?: number, claudeDir: string|null, roots: string[],
 *   sameRepo: (cwd: string) => Promise<boolean>, repoId: string|null, owner: string|null, settings?: object, fs?: typeof nodeFs, platform?: string,
 *   slugPrefixLength?: number, runSessions?: Iterable<string>, notBefore?: string|null}} input
 *   `mem` may be null only for a dry run on a machine with no store yet. `maxBytes` is the per-run read budget (default
 *   IMPORT_MAX_BYTES.default). `slugPrefixLength` overrides CLAUDE_FORMAT.longSlugPrefix (internal: tests only, no flag).
 *   `runSessions`: Claude session ids driven by asterweave runs (asterweaveRunSessions): every record of them is skipped
 *   ('asterweave-run'). `notBefore` (ISO time): records older than it are skipped ('predates-clone'); null/absent: no cutoff.
 */
export async function importClaude(input) {
  const { mem, claudeDir, roots, sameRepo, repoId, owner } = input;
  const dry = input.dryRun === true;
  const fs = input.fs ?? nodeFs;
  const platform = input.platform ?? process.platform;
  const cfg = withDefaults(input.settings);
  if (!dry && (!mem || !repoId || !owner)) throw new TypeError("importClaude needs an open store, a repository and an owner");
  const now = mem ? mem.now() : clockOf({ now: input.now })();
  const skipped = Object.fromEntries(SKIP_KEYS.map((key) => [key, 0]));
  const warnings = new Map();
  const includeSidechains = input.includeSidechains === true;
  const maxBytes = input.maxBytes ?? IMPORT_MAX_BYTES.default;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("importClaude needs a positive whole maxBytes");
  const budget = { max: maxBytes, used: 0 };
  const runSessions = new Set([...(input.runSessions ?? [])].map((id) => String(id).toLowerCase()));
  const notBefore = input.notBefore ? toIso(input.notBefore) : null;
  const stats = { memorySections: 0 };
  const report = { dryRun: dry, claudeDir, projectsDir: null, dirs: [], files: [], sessions: 0, events: 0, partial: false, maxBytes, bytesRead: 0, skipped, memorySectionsStripped: 0, notBefore, formatWarnings: [], errors: [] };
  const discovered = discoverProjectDirs(claudeDir, roots, { fs, platform, slugPrefixLength: input.slugPrefixLength });
  const hinted = new Set(discovered.hinted);
  report.projectsDir = discovered.projectsDir;
  skipped.symlink += discovered.symlinks;
  const sessionsTouched = new Set();
  const seenThisRun = new Set();
  const repoCache = new Map();
  const inRepo = async (cwd) => {
    if (!cwd) return false;
    if (!repoCache.has(cwd)) {
      let same = false;
      try {
        same = (await sameRepo(cwd)) === true;
      } catch {
        same = false;
      }
      repoCache.set(cwd, same);
    }
    return repoCache.get(cwd);
  };

  for (const dir of discovered.dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const files = entries.filter((entry) => entry.name.endsWith(CLAUDE_FORMAT.fileSuffix));
    const paths = [];
    for (const entry of files.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isSymbolicLink()) {
        skipped.symlink += 1;
        continue;
      }
      if (entry.isFile()) paths.push(path.join(dir, entry.name));
    }
    // Top-level transcripts first, so a session is opened (and titled) by its main transcript, then the nested ones.
    // Subdirectories are not even listed without --include-sidechains.
    const nested = includeSidechains ? listNested(fs, dir) : { files: [], symlinks: 0 };
    skipped.symlink += nested.symlinks;
    report.dirs.push({ dir, files: files.length, nested: nested.files.length, hint: hinted.has(dir) ? "long-slug-prefix" : null });
    for (const file of [...paths, ...nested.files]) {
      // eslint-disable-next-line no-await-in-loop
      const result = await importFile({ mem, dry, fs, platform, file, cfg, now, repoId, owner, includeSidechains, inRepo, skipped, warnings, sessionsTouched, seenThisRun, budget, runSessions, notBefore, stats });
      report.files.push(result);
      report.events += result.events;
      if (result.partial) report.partial = true;
      if (result.error) report.errors.push({ file, message: result.error });
    }
  }
  report.bytesRead = budget.used;
  report.sessions = sessionsTouched.size;
  report.memorySectionsStripped = stats.memorySections;
  report.formatWarnings = [...warnings.entries()].map(([version, lines]) => ({
    version,
    lines,
    message: `Claude Code transcript format ${version === "(none)" ? "without a version" : `version ${version}`} is outside the tested range (>= ${CLAUDE_FORMAT.testedVersions.min} < ${CLAUDE_FORMAT.testedVersions.below}); ${lines} line(s) were parsed best-effort.`,
  }));
  if (!dry && mem) mem.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(IMPORT_META_KEY, mem.now());
  return report;
}

async function importFile(c) {
  const { mem, dry, fs, platform, file, cfg, now, repoId, owner, skipped, warnings } = c;
  const key = repoId ? watermarkKey(repoId, file, platform) : null;
  const legacyKey = fileKey(file, platform);
  const { budget } = c;
  const out = { file, events: 0, sessions: [], rescanned: null, tornLine: false, malformed: 0, oversized: 0, unchanged: false, partial: false, error: null };
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return out; // removed between listing and reading: nothing to import
  }
  if (stat.isSymbolicLink()) {
    skipped.symlink += 1;
    return out;
  }
  const size = stat.size;
  const mtime = stat.mtime.toISOString();
  // The repository-scoped row; else a legacy path-only row, but only when it was written for THIS repository.
  let mark = mem && key ? mem.db.prepare("SELECT * FROM claude_import_files WHERE path = ?").get(key) : undefined;
  const legacy = mem && key && !mark ? mem.db.prepare("SELECT * FROM claude_import_files WHERE path = ? AND repo_id = ?").get(legacyKey, repoId) : undefined;
  mark ??= legacy;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    out.error = `cannot be read (${error?.code ?? "error"})`;
    return out;
  }
  try {
    let start = 0;
    if (mark) {
      const holds = watermarkHolds(fs, fd, mark, size);
      if (holds.ok) start = Number(mark.offset);
      else out.rescanned = holds.reason;
      if (holds.ok && start === size) {
        out.unchanged = true;
        return out;
      }
    }
    if (start < size && budget.used >= budget.max) {
      out.partial = true; // the run's budget is spent: nothing read, no watermark written; the next run continues here
      return out;
    }
    // Pass 1: parse the new bytes into candidate events, in file order, within the run's read budget. Once anything was
    // consumed in this run, the read window ends at the budget; before that it runs to the end of the file so that one
    // complete line is always consumed (a line larger than the budget would otherwise never progress).
    const candidates = [];
    let offset = start;
    let lastUuid = mark && !out.rescanned ? mark.last_uuid : null;
    let lastUuidOffset = mark && !out.rescanned ? mark.last_uuid_offset : null;
    const readEnd = budget.used > 0 ? Math.min(size, start + (budget.max - budget.used)) : size;
    for (const line of readLines(fs, fd, start, readEnd)) {
      if (line.torn && line.end >= size) {
        out.tornLine = true; // not consumed: the writer has not finished it
        break;
      }
      const length = line.end - line.start;
      if (line.torn || (budget.used > 0 && budget.used + length > budget.max)) {
        out.partial = true; // cut by the budget window, or would exceed it: the watermark stays after the last complete line
        break;
      }
      budget.used += length;
      offset = line.end;
      if (line.oversized) {
        skipped["oversized-line"] += 1; // never buffered or parsed; the watermark moves past it
        out.oversized += 1;
        continue;
      }
      if (line.text.trim() === "") continue;
      const parsed = parseClaudeLine(line.text, { includeSidechains: c.includeSidechains });
      if (parsed.uuid) {
        lastUuid = parsed.uuid;
        lastUuidOffset = line.start;
      }
      if (parsed.kind === "malformed") {
        skipped.malformed += 1;
        out.malformed += 1;
        continue;
      }
      if (parsed.kind === "skip") {
        skipped[parsed.reason] = (skipped[parsed.reason] ?? 0) + (parsed.reason === "hidden-reasoning" ? parsed.hiddenBlocks : 1);
        continue;
      }
      // A Claude session asterweave itself drove holds the injected memory section and full tool output: never re-imported.
      if (c.runSessions.has(parsed.sessionId.toLowerCase())) {
        skipped["asterweave-run"] += 1;
        continue;
      }
      if (c.notBefore && parsed.timestamp < c.notBefore) {
        skipped["predates-clone"] += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (!(await c.inRepo(parsed.cwd))) {
        skipped["other-repo"] += 1;
        continue;
      }
      if (!parsed.versionKnown) warnings.set(parsed.version ?? "(none)", (warnings.get(parsed.version ?? "(none)") ?? 0) + 1);
      if (parsed.hiddenBlocks > 0) skipped["hidden-reasoning"] += parsed.hiddenBlocks;
      c.stats.memorySections += parsed.memorySections;
      for (const event of eventsFromMessage(parsed, { toolResultExcerptChars: cfg.toolResultExcerptChars })) candidates.push({ event, msg: parsed, lineStart: line.start });
    }
    if (!out.tornLine && offset < size) out.partial = true; // e.g. the budget window ended exactly on a line end
    // Pass 2: classify against retention, tombstones and what is already stored.
    const fresh = [];
    for (const cand of candidates) {
      const { event, msg } = cand;
      const sessionId = repoId ? memorySessionId(repoId, msg.sessionId) : null;
      const basis = event.eventTime < now ? event.eventTime : now;
      if (addDays(basis, cfg.historyRetentionDays) <= now) skipped.expired += 1;
      else if (mem && (isTombstoned(mem.db, "event", event.id) || (sessionId && isTombstoned(mem.db, "session", sessionId)))) skipped.tombstoned += 1;
      else if (c.seenThisRun.has(event.id) || (mem && mem.db.prepare("SELECT 1 FROM events WHERE id = ?").get(event.id))) skipped["already-imported"] += 1;
      else {
        c.seenThisRun.add(event.id);
        fresh.push({ ...cand, sessionId });
      }
    }
    // Pass 3: store (unless dry), one memory session per Claude session, opened only when it gets an event.
    const bySession = new Map();
    for (const cand of fresh) {
      if (!bySession.has(cand.msg.sessionId)) bySession.set(cand.msg.sessionId, []);
      bySession.get(cand.msg.sessionId).push(cand);
    }
    let failedAt = null;
    for (const [claudeSessionId, list] of bySession) {
      out.sessions.push(claudeSessionId);
      c.sessionsTouched.add(claudeSessionId);
      if (dry) {
        out.events += list.length;
        continue;
      }
      const first = list[0].msg;
      const opened = openSession(mem, {
        id: list[0].sessionId, owner, repoId, visibility: "private", title: titleOf(list.map((x) => x.event), claudeSessionId),
        externalSessionId: `claude:${claudeSessionId}`, branch: first.gitBranch ?? undefined, worktreeId: worktreeIdOf(first.cwd, platform) ?? undefined,
      }, cfg);
      if (opened.status === "forgotten") {
        skipped.tombstoned += list.length;
        continue;
      }
      if (!opened.ok || opened.saved === false) {
        failedAt = Math.min(failedAt ?? Infinity, list[0].lineStart);
        out.error = opened.message ?? opened.status ?? "session could not be opened";
        continue;
      }
      for (const cand of list) {
        const saved = appendEvent(mem, opened.session.id, cand.event, cfg, { viewer: owner });
        if (saved.degraded) {
          failedAt = Math.min(failedAt ?? Infinity, cand.lineStart);
          out.error = saved.message;
          break;
        }
        if (saved.saved && !saved.duplicate) out.events += 1;
        else if (saved.status === "forgotten") skipped.tombstoned += 1;
        else if (saved.status === "expired") skipped.expired += 1;
        else if (saved.duplicate) skipped["already-imported"] += 1;
        else skipped.rejected += 1;
      }
    }
    if (!dry) {
      // A failed write leaves the watermark before the failing line so the next run retries it (ids keep that safe).
      const safeOffset = failedAt === null ? offset : Math.min(offset, failedAt);
      const keepUuid = failedAt === null ? lastUuid : null;
      transaction(mem, () => {
        // A legacy path-only row of this repository is replaced by the repository-scoped one (its rescan count carried over).
        if (legacy) mem.db.prepare("DELETE FROM claude_import_files WHERE path = ? AND repo_id = ?").run(legacyKey, repoId);
        mem.db
          .prepare(
            `INSERT INTO claude_import_files (path, repo_id, size, offset, last_uuid, last_uuid_offset, mtime, imported_at, rescans) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET repo_id = excluded.repo_id, size = excluded.size, offset = excluded.offset, last_uuid = excluded.last_uuid,
               last_uuid_offset = excluded.last_uuid_offset, mtime = excluded.mtime, imported_at = excluded.imported_at, rescans = claude_import_files.rescans + excluded.rescans`,
          )
          .run(key, repoId, size, keepUuid === null && failedAt !== null ? 0 : safeOffset, keepUuid, keepUuid === null ? null : lastUuidOffset, mtime, mem.now(), (out.rescanned ? 1 : 0) + Number(legacy?.rescans ?? 0));
      });
    }
    return out;
  } finally {
    fs.closeSync(fd);
  }
}
