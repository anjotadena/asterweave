// Image attachments of a session: inspect (magic bytes, header dimensions, limits), strip metadata, store a content-addressed copy
// under `<sessionDir>/attachments/<sha256>.<ext>`, and record metadata on the session (never bytes).
//
// PUBLIC API (stable; the TUI and the commands use exactly these):
//   inspectImage(source, opts)                 -> {ok, image, bytes, source, problems}   source: a path string or a Buffer; pure given the bytes
//   addAttachment(sessionId, source, opts)     -> {ok, attachment, duplicate?, problems[]}   never throws for an expected problem
//   listAttachments(sessionId, opts)           -> attachment[]                             ([] when the session cannot be read)
//   removeAttachment(sessionId, id, opts)      -> {ok, removed, preview, problems[]}       a PREVIEW unless opts.confirm === true
//   markAttachmentsSent(sessionId, ids, runId, opts), readAttachmentBytes(sessionId, attachment, opts)
// `opts`: { repoKey?, userDir?, env?, platform?, homedir?, fs?, now?, cwd?, name?, limits? }. `repoKey` is optional: without it the
// session directory is found by id under the sessions root. Image bytes are untrusted data: they are never decoded beyond header
// parsing, never logged and never part of a returned record, an event or an error message (hashes and sizes only).

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { IMAGE_FORMATS, IMAGE_LIMITS, parseImage, sha256Hex, stripMetadata } from "./image-format.mjs";
import { isValidRunId, loadRun, repoDirName, runDir } from "./ledger.mjs";
import { cleanAttachmentName, commitSessionEvent, isObject, isValidSessionId, loadSession, MAX_FILE_BYTES, mutateSession, readAll, sessionsRoot } from "./sessions.mjs";

export { IMAGE_FORMATS, IMAGE_LIMITS };
export const ATTACHMENTS_DIR = "attachments";
const MIN_ID_PREFIX = 8; // "img_" + 4 hex digits

// A problem is { code, message }; it also prints as "CODE: message" (String(problem)) for callers that list problems as plain lines.
const problem = (code, message) => Object.defineProperty({ code, message }, "toString", { value: () => `${code}: ${message}` });
const refuse = (...problems) => ({ ok: false, attachment: null, problems });
const clipText = (text, limit) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);

/** The store-related options only (nothing else reaches the session store). */
function storeOptions(opts = {}) {
  const out = {};
  for (const key of ["env", "platform", "homedir", "fs", "userDir", "now", "lockWaitMs", "lock", "maxFileBytes"]) if (opts[key] !== undefined) out[key] = opts[key];
  return out;
}

// Reading a file ----------------------------------------------------------------------------------

/** Windows device namespaces (a leading two-slash form) and UNC network paths: a named pipe or a device reports a regular file of size 0. */
export const isDeviceOrUncPath = (value) => /^[\\/]{2}/.test(String(value));
const unsafe = () => ({ ok: false, problems: [problem("UNSAFE_PATH", "device paths (\\\\.\\ and \\\\?\\) and network (UNC) paths are not accepted; copy the image to a local file first")] });

/**
 * Read one image file through a descriptor: lstat first (regular files only; a symlink is followed ONLY because the user named it, and
 * is resolved with realpath), size capped BEFORE reading, and the read itself capped at limit+1 so a growing file cannot overflow.
 * @returns {{ok: true, bytes: Buffer, source: object} | {ok: false, problems: object[]}}
 */
export function readImageFile(file, opts = {}) {
  const fs = opts.fs ?? nodeFs;
  const limits = { ...IMAGE_LIMITS, ...opts.limits };
  if (typeof file !== "string" || file === "" || file.includes("\0")) return { ok: false, problems: [problem("INVALID_PATH", "the image path is empty or not valid")] };
  const win = (opts.platform ?? process.platform) === "win32";
  const absolute = path.resolve(opts.cwd ?? process.cwd(), file);
  // Windows device namespaces (\. and \?) and UNC paths are refused: a named pipe or a device reports a regular file of size 0.
  if (win && (isDeviceOrUncPath(file) || isDeviceOrUncPath(absolute))) return unsafe();
  const name = cleanAttachmentName(path.basename(absolute));
  const tooLarge = () => problem("TOO_LARGE", `the file is larger than ${limits.maxBytes / 1048576} MiB`);
  let real = absolute;
  let viaSymlink = false;
  let info;
  if (win) {
    // an intermediate junction or symlinked directory can lead into a device namespace too
    try {
      if (isDeviceOrUncPath(fs.realpathSync.native(path.dirname(absolute)))) return unsafe();
    } catch {
      // a missing parent is reported by lstat below
    }
  }
  try {
    info = fs.lstatSync(absolute);
    if (info.isSymbolicLink()) {
      real = fs.realpathSync.native(absolute);
      if (win && isDeviceOrUncPath(real)) return unsafe();
      viaSymlink = true;
      info = fs.statSync(real);
    }
  } catch (error) {
    return { ok: false, problems: [problem(error?.code === "ENOENT" ? "NOT_FOUND" : "UNREADABLE", `cannot read ${clipText(name, 80)} (${clipText(error?.code ?? "error", 20)})`)] };
  }
  if (!info.isFile()) return { ok: false, problems: [problem("NOT_REGULAR", `${clipText(name, 80)} is not a regular file (directories, devices and pipes are refused)`)] };
  if (info.size > limits.maxBytes) return { ok: false, problems: [tooLarge()] };
  if (info.size === 0) return { ok: false, problems: [problem("EMPTY", "the file is empty")] };
  let fd;
  try {
    fd = fs.openSync(real, (fs.constants?.O_RDONLY ?? 0) | (fs.constants?.O_NONBLOCK ?? 0));
  } catch (error) {
    return { ok: false, problems: [problem("UNREADABLE", `cannot open ${clipText(name, 80)} (${clipText(error?.code ?? "error", 20)})`)] };
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return { ok: false, problems: [problem("NOT_REGULAR", `${clipText(name, 80)} is not a regular file`)] };
    if (opened.size > limits.maxBytes) return { ok: false, problems: [tooLarge()] };
    const buffer = Buffer.alloc(limits.maxBytes + 1);
    let got = 0;
    while (got < buffer.length) {
      const read = fs.readSync(fd, buffer, got, buffer.length - got, got);
      if (read === 0) break;
      got += read;
    }
    if (got > limits.maxBytes) return { ok: false, problems: [tooLarge()] };
    return { ok: true, bytes: Buffer.from(buffer.subarray(0, got)), source: { name, viaSymlink, resolved: viaSymlink ? clipText(real, 200) : null } };
  } catch (error) {
    return { ok: false, problems: [problem("UNREADABLE", `cannot read ${clipText(name, 80)} (${clipText(error?.code ?? "error", 20)})`)] };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // already closed
    }
  }
}

// Inspecting --------------------------------------------------------------------------------------

/**
 * Validate an image and produce its STRIPPED bytes. `source` is a path (read through readImageFile) or a Buffer/Uint8Array
 * (pure; `opts.name` names it). Format = magic bytes only. Limits: opts.limits over IMAGE_LIMITS.
 * @returns {{ok: true, image: object, bytes: Buffer, source: object, problems: []} | {ok: false, problems: {code: string, message: string}[]}}
 */
export function inspectImage(source, opts = {}) {
  const limits = { ...IMAGE_LIMITS, ...opts.limits };
  let bytes;
  let origin;
  if (typeof source === "string") {
    const read = readImageFile(source, { ...opts, limits });
    if (!read.ok) return { ok: false, problems: read.problems };
    ({ bytes, source: origin } = read);
  } else if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    bytes = Buffer.isBuffer(source) ? source : Buffer.from(source.buffer, source.byteOffset, source.byteLength);
    if (bytes.length > limits.maxBytes) return { ok: false, problems: [problem("TOO_LARGE", `the image is larger than ${limits.maxBytes / 1048576} MiB`)] };
    origin = { name: cleanAttachmentName(opts.name ?? "image"), viaSymlink: false, resolved: null };
  } else return { ok: false, problems: [problem("INVALID_SOURCE", "the image source must be a file path or bytes")] };

  const parsed = parseImage(bytes, limits);
  if (!parsed.ok) return { ok: false, problems: [problem(parsed.code, `${origin.name}: ${parsed.message}`)] };
  const stripped = stripMetadata(bytes, parsed);
  const again = parseImage(stripped.bytes, limits);
  if (!again.ok || again.format !== parsed.format || again.width !== parsed.width || again.height !== parsed.height || again.end !== stripped.bytes.length) {
    return { ok: false, problems: [problem("STRIP_FAILED", `${origin.name}: the image could not be cleaned of metadata safely`)] };
  }
  const sha256 = sha256Hex(stripped.bytes);
  const format = IMAGE_FORMATS[parsed.format];
  return {
    ok: true,
    problems: [],
    bytes: stripped.bytes,
    source: origin,
    image: {
      id: `img_${sha256.slice(0, 12)}`,
      sha256,
      format: parsed.format,
      mime: format.mime,
      ext: format.ext,
      width: parsed.width,
      height: parsed.height,
      bytes: stripped.bytes.length,
      originalBytes: bytes.length,
      originalSha256: sha256Hex(bytes),
      name: origin.name,
      metadataStripped: true,
      dropped: stripped.dropped,
    },
  };
}

// Session store -----------------------------------------------------------------------------------

/** Find the repository key of a session id: from opts.repoKey, else by looking for `<root>/<repoDir>/<id>/session.json`. */
function locate(sessionId, opts) {
  if (!isValidSessionId(sessionId)) return { problems: [problem("SESSION_ID_INVALID", "not a valid session id")] };
  if (typeof opts.repoKey === "string" && opts.repoKey !== "") return { repoKey: opts.repoKey, store: storeOptions(opts) };
  const store = storeOptions(opts);
  const fs = store.fs ?? nodeFs;
  const root = sessionsRoot(store);
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    names = [];
  }
  for (const name of names) {
    const file = path.join(root, name, sessionId, "session.json");
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) continue;
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (isObject(raw) && typeof raw.repoKey === "string" && repoDirName(raw.repoKey) === name) return { repoKey: raw.repoKey, store };
    } catch {
      // not this repository directory
    }
  }
  return { problems: [problem("SESSION_NOT_FOUND", `no session ${clipText(sessionId, 64)} was found`)] };
}

const caught = (error) => {
  if (error instanceof CliError) return [problem(String(error.code ?? "ERROR"), clipText(error.message, 300))];
  throw error;
};

function storedName(attachment) {
  return `${attachment.sha256}.${IMAGE_FORMATS[attachment.format].ext}`;
}

/** Atomic, content-addressed write (mode 0600) of the stripped bytes. */
function writeStored(fs, sessionDir, attachment, bytes) {
  const directory = path.join(sessionDir, ATTACHMENTS_DIR);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const final = path.join(directory, storedName(attachment));
  const temp = path.join(directory, `.${attachment.sha256.slice(0, 16)}.${randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    for (let written = 0; written < bytes.length; ) written += fs.writeSync(fd, bytes, written, bytes.length - written);
    try {
      fs.fsyncSync(fd);
    } catch (error) {
      if (error?.code !== "EINVAL" && error?.code !== "ENOTSUP") throw error;
    }
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temp, final);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // best effort
    }
    throw error;
  }
}

const recordOf = (image, at) => ({
  id: image.id, sha256: image.sha256, format: image.format, mime: image.mime, bytes: image.bytes, width: image.width, height: image.height,
  name: image.name, addedAt: at, metadataStripped: image.metadataStripped, dropped: image.dropped, sentRunId: null, claimedRunId: null,
});

/**
 * Copy the STRIPPED bytes of an image into the session and record it. Idempotent by content: attaching the same image twice
 * returns the existing record with `duplicate: true`. Refuses an archived session and more than IMAGE_LIMITS.perSession images.
 * @returns {{ok: boolean, attachment: object|null, duplicate?: boolean, source?: object, problems: {code: string, message: string}[]}}
 */
export function addAttachment(sessionId, source, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return refuse(...found.problems);
  const inspected = inspectImage(source, opts);
  if (!inspected.ok) return refuse(...inspected.problems);
  const limit = { ...IMAGE_LIMITS, ...opts.limits }.perSession;
  const fs = found.store.fs ?? nodeFs;
  try {
    return mutateSession(found.repoKey, sessionId, found.store, ({ dir, record }) => {
      if (record.status !== "active") return refuse(problem("SESSION_ARCHIVED", "the session is archived"));
      const existing = record.attachments.find((item) => item.sha256 === inspected.image.sha256);
      if (existing) return { ok: true, attachment: existing, duplicate: true, source: inspected.source, problems: [] };
      if (record.attachments.length >= limit) return refuse(problem("TOO_MANY", `the session already has ${record.attachments.length} images (at most ${limit}); detach one first`));
      const at = (found.store.now ?? (() => new Date().toISOString()))();
      const attachment = recordOf(inspected.image, at);
      writeStored(fs, dir, attachment, inspected.bytes);
      const next = commitSessionEvent(dir, record, { type: "attachment.added", attachmentId: attachment.id, patch: { attachments: [...record.attachments, attachment] } }, { ...found.store, at });
      return { ok: true, attachment: next.attachments.find((item) => item.sha256 === attachment.sha256) ?? attachment, duplicate: false, source: inspected.source, problems: [] };
    });
  } catch (error) {
    return refuse(...caught(error));
  }
}

/** The attachments of a session (a copy; metadata only). [] when the session cannot be read. */
export function listAttachments(sessionId, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return [];
  try {
    return loadSession(found.repoKey, sessionId, { ...found.store, repair: false }).session.attachments.map((item) => ({ ...item, dropped: [...item.dropped] }));
  } catch (error) {
    if (error instanceof CliError) return [];
    throw error;
  }
}

function resolveAttachment(list, idOrPrefix) {
  const text = typeof idOrPrefix === "string" ? idOrPrefix : "";
  const exact = list.find((item) => item.id === text);
  if (exact) return { attachment: exact };
  if (!/^img_[0-9a-f]{4,12}$/.test(text) || text.length < MIN_ID_PREFIX) return { problems: [problem("ATTACHMENT_ID_INVALID", "pass an attachment id such as img_0123456789ab (see `asterweave session show`)")] };
  const matches = list.filter((item) => item.id.startsWith(text));
  if (matches.length === 0) return { problems: [problem("ATTACHMENT_NOT_FOUND", `the session has no attachment ${clipText(text, 20)}`)] };
  if (matches.length > 1) return { problems: [problem("ATTACHMENT_AMBIGUOUS", `${clipText(text, 20)} matches ${matches.length} attachments; pass more characters`)] };
  return { attachment: matches[0] };
}

/** "open" | "closed" | "unknown" for a run id: a finished (completed, aborted) or missing run is closed; an unreadable one is unknown. */
export function runOpenState(repoKey, runId, store = {}) {
  try {
    const status = loadRun(runDir(repoKey, runId, store), store.fs ? { fs: store.fs } : {}).run.status;
    return status === "completed" || status === "aborted" ? "closed" : "open";
  } catch (error) {
    return error?.code === "RUN_NOT_FOUND" ? "closed" : "unknown";
  }
}

/** A run that sent (or CLAIMED, before its first turn) this attachment and is still open blocks the removal. */
function blockedByRun(repoKey, attachment, store) {
  const runId = attachment.sentRunId ?? attachment.claimedRunId ?? null;
  if (runId === null || !isValidRunId(runId)) return null; // normalisation already nulls invalid ids; never a permanent block
  const state = runOpenState(repoKey, runId, store);
  if (state === "closed") return null;
  return problem("ATTACHMENT_IN_USE", state === "open" ? `run ${clipText(runId, 64)} uses this image and is still open; finish or abort it first` : `run ${clipText(runId, 64)} uses this image and its state could not be read`);
}

/**
 * Remove one attachment: its record and its stored copy (only `<sessionDir>/attachments/<sha>.<ext>`, never anything else).
 * Without `opts.confirm === true` NOTHING is changed and `preview` says what would be removed.
 * @returns {{ok: boolean, removed: boolean, preview: object|null, attachment: object|null, problems: object[]}}
 */
export function removeAttachment(sessionId, attachmentId, opts = {}) {
  const none = (problems) => ({ ok: false, removed: false, preview: null, attachment: null, problems });
  const found = locate(sessionId, opts);
  if (found.problems) return none(found.problems);
  const fs = found.store.fs ?? nodeFs;
  const plan = (record, dir) => {
    const resolved = resolveAttachment(record.attachments, attachmentId);
    if (resolved.problems) return { problems: resolved.problems };
    const blocked = blockedByRun(found.repoKey, resolved.attachment, found.store);
    if (blocked) return { problems: [blocked] };
    return { attachment: resolved.attachment, preview: { id: resolved.attachment.id, name: resolved.attachment.name, bytes: resolved.attachment.bytes, sha256: resolved.attachment.sha256, file: path.join(dir, ATTACHMENTS_DIR, storedName(resolved.attachment)) } };
  };
  try {
    if (opts.confirm !== true) {
      const loaded = loadSession(found.repoKey, sessionId, { ...found.store, repair: false });
      const planned = plan(loaded.session, loaded.dir);
      return planned.problems ? none(planned.problems) : { ok: true, removed: false, preview: planned.preview, attachment: planned.attachment, problems: [] };
    }
    return mutateSession(found.repoKey, sessionId, found.store, ({ dir, record }) => {
      const planned = plan(record, dir);
      if (planned.problems) return none(planned.problems);
      const at = (found.store.now ?? (() => new Date().toISOString()))();
      commitSessionEvent(dir, record, { type: "attachment.removed", attachmentId: planned.attachment.id, patch: { attachments: record.attachments.filter((item) => item.sha256 !== planned.attachment.sha256) } }, { ...found.store, at });
      const file = planned.preview.file;
      try {
        const info = fs.lstatSync(file);
        if (info.isFile() && !info.isSymbolicLink() && path.dirname(file) === path.join(dir, ATTACHMENTS_DIR)) fs.rmSync(file, { force: true });
      } catch {
        // an already missing copy is fine: the record is gone
      }
      return { ok: true, removed: true, preview: planned.preview, attachment: planned.attachment, problems: [] };
    });
  } catch (error) {
    return none(caught(error));
  }
}

/**
 * Attachments a new run would send: not yet sent, and not claimed by a run that is still open (or unreadable). `forRun`: that run's own
 * claims count too (a resume). A claim by a finished or missing run is stale and ignored.
 */
export function pendingAttachmentsOf(list, repoKey, store = {}, forRun = null) {
  return list.filter((item) => item.sentRunId === null && (item.claimedRunId === null || item.claimedRunId === forRun || runOpenState(repoKey, item.claimedRunId, store) === "closed"));
}

export function pendingAttachments(sessionId, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return [];
  return pendingAttachmentsOf(listAttachments(sessionId, opts), found.repoKey, found.store, opts.forRun ?? null);
}

/** The id of the active session that holds images `runId` claimed but has not sent yet (a resume sends them), or null. */
export function sessionClaiming(repoKey, runId, opts = {}) {
  if (!isValidRunId(runId)) return null;
  const found = readAll(repoKey, { ...storeOptions(opts), repair: false }).sessions.find(({ session }) => session.status === "active" && session.attachments.some((item) => item.claimedRunId === runId && item.sentRunId === null));
  return found ? found.session.id : null;
}

/**
 * A run CLAIMS the images it is about to send, before its first turn, so they cannot be detached while it is open. Compare-and-set under
 * the session lock: an image already claimed by ANOTHER run that is still open (or already sent) is SKIPPED, unless the user named it
 * (`opts.explicit`: ids). Claiming a named image resets `sentRunId` (an image named again for a new run is sent again).
 * @returns {{ok: boolean, claimed: string[], skipped: {id: string, heldBy: string}[], problems: object[]}}
 */
export function claimAttachments(sessionId, ids, runId, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return { ok: false, claimed: [], skipped: [], problems: found.problems };
  if (!isValidRunId(runId)) return { ok: false, claimed: [], skipped: [], problems: [problem("RUN_ID_INVALID", "not a valid run id")] };
  try {
    return mutateSession(found.repoKey, sessionId, found.store, ({ dir, record }) => {
      const wanted = new Set(ids);
      const explicit = new Set(opts.explicit ?? []);
      const claimed = [];
      const skipped = [];
      const next = record.attachments.map((item) => {
        if (!wanted.has(item.id)) return item;
        if (!explicit.has(item.id)) {
          const holder = item.claimedRunId !== null && item.claimedRunId !== runId && runOpenState(found.repoKey, item.claimedRunId, found.store) !== "closed" ? item.claimedRunId : null;
          if (holder !== null || item.sentRunId !== null) {
            skipped.push({ id: item.id, heldBy: holder ?? item.sentRunId });
            return item;
          }
        }
        claimed.push(item.id);
        return { ...item, claimedRunId: runId, sentRunId: null };
      });
      if (claimed.length > 0) commitSessionEvent(dir, record, { type: "attachment.claimed", attachmentIds: claimed, runId, patch: { attachments: next } }, found.store);
      return { ok: true, claimed, skipped, problems: [] };
    });
  } catch (error) {
    return { ok: false, claimed: [], skipped: [], problems: caught(error) };
  }
}

/** Mark attachments as sent with the first turn of `runId` (idempotent; already-sent ones keep their run). */
export function markAttachmentsSent(sessionId, ids, runId, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return { ok: false, marked: [], problems: found.problems };
  if (!isValidRunId(runId)) return { ok: false, marked: [], problems: [problem("RUN_ID_INVALID", "not a valid run id")] };
  try {
    return mutateSession(found.repoKey, sessionId, found.store, ({ dir, record }) => {
      const wanted = new Set(ids);
      const marked = [];
      const next = record.attachments.map((item) => {
        if (!wanted.has(item.id) || item.sentRunId !== null) return item;
        marked.push(item.id);
        return { ...item, sentRunId: runId };
      });
      if (marked.length === 0) return { ok: true, marked, problems: [] };
      commitSessionEvent(dir, record, { type: "attachment.sent", attachmentIds: marked, runId, patch: { attachments: next } }, found.store);
      return { ok: true, marked, problems: [] };
    });
  } catch (error) {
    return { ok: false, marked: [], problems: caught(error) };
  }
}

/**
 * The stored bytes of an attachment, verified against its recorded hash and size (a changed or replaced file is refused).
 * @returns {{ok: true, bytes: Buffer} | {ok: false, problems: object[]}}
 */
export function readAttachmentBytes(sessionId, attachment, opts = {}) {
  const found = locate(sessionId, opts);
  if (found.problems) return { ok: false, problems: found.problems };
  const fs = found.store.fs ?? nodeFs;
  try {
    const loaded = loadSession(found.repoKey, sessionId, { ...found.store, repair: false });
    const known = loaded.session.attachments.find((item) => item.sha256 === attachment?.sha256);
    if (!known) return { ok: false, problems: [problem("ATTACHMENT_NOT_FOUND", "the session has no such attachment")] };
    const file = path.join(loaded.dir, ATTACHMENTS_DIR, storedName(known));
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== known.bytes) return { ok: false, problems: [problem("ATTACHMENT_CORRUPT", `the stored copy of ${known.id} is missing or changed`)] };
    const bytes = fs.readFileSync(file);
    if (bytes.length !== known.bytes || sha256Hex(bytes) !== known.sha256) return { ok: false, problems: [problem("ATTACHMENT_CORRUPT", `the stored copy of ${known.id} does not match its hash`)] };
    return { ok: true, bytes };
  } catch (error) {
    if (error instanceof CliError) return { ok: false, problems: caught(error) };
    return { ok: false, problems: [problem("ATTACHMENT_UNREADABLE", "the stored copy could not be read")] };
  }
}

// Display -----------------------------------------------------------------------------------------

const size = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MiB` : `${Math.max(1, Math.ceil(bytes / 1024))} KiB`);

/** One sanitized line: what will be (or was) sent. No bytes. */
export function describeAttachment(attachment) {
  const dropped = attachment.dropped?.length > 0 ? attachment.dropped.join(", ") : "nothing found";
  return sanitizeForTerminal(`${attachment.id}  ${attachment.name || "(unnamed)"}  ${attachment.format}  ${size(attachment.bytes)}  ${attachment.width}x${attachment.height}  sha256 ${attachment.sha256.slice(0, 12)}  metadata ${attachment.metadataStripped ? `stripped (${dropped})` : "NOT stripped"}`);
}

/** JSON-safe view: hashes and sizes only. */
export const attachmentView = (attachment) => ({
  id: attachment.id, sha256: attachment.sha256, format: attachment.format, mime: attachment.mime, bytes: attachment.bytes, width: attachment.width,
  height: attachment.height, name: attachment.name, metadataStripped: attachment.metadataStripped, dropped: [...(attachment.dropped ?? [])], sentRunId: attachment.sentRunId ?? null,
});
