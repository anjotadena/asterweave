// Bounded tool output. Every tool and MCP result passes through `boundOutput` before it can reach a model, a
// ledger or a terminal:
//
//   - untrusted JSON-like values are reduced to plain bounded data (depth, items, keys, string length capped; the
//     keys __proto__ / constructor / prototype are dropped; functions, symbols, bigints and cycles become markers);
//   - control sequences are stripped (sanitizeForTerminal) and secrets redacted (redactText) BEFORE anything is
//     hashed, stored or shown, so no secret is ever written to an artifact;
//   - the head of the text is kept within maxBytes / maxLines / maxLineChars, with an explicit truncation marker;
//   - when the output was cut and an `artifactDir` is given, the FULL (sanitized, redacted) text is stored at
//     `<artifactDir>/<sha256>.txt` (private mode, atomic) and referenced by path.
//
// Result: { excerpt, truncated, bytes, lines, shownBytes, shownLines, sha256, artifactPath, artifactError?, notes }.

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { stringifyJson } from "../../json.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";

/** Defaults for a tool that declares no limits. */
export const DEFAULT_LIMITS = Object.freeze({ timeoutMs: 30_000, maxBytes: 32 * 1024, maxLines: 400, maxItems: 100 });
/** Ceilings no tool can raise. */
export const HARD_LIMITS = Object.freeze({ timeoutMs: 300_000, maxBytes: 1024 * 1024, maxLines: 10_000, maxItems: 1000 });
/** Longest line kept in an excerpt. */
export const MAX_LINE_CHARS = 2000;
/** Longest input text examined at all; the rest is dropped (and noted). */
export const INGEST_CAP_CHARS = 8 * 1024 * 1024;

const MAX_DEPTH = 8;
const MAX_KEYS = 200;
const MAX_STRING = 100_000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Reduce an untrusted value to plain bounded JSON data. Never throws and never mutates its input.
 * @param {unknown} value
 * @param {{maxItems?: number, notes?: Set<string>}} [options]
 */
export function toPlainData(value, { maxItems = DEFAULT_LIMITS.maxItems, notes = new Set() } = {}) {
  const seen = new WeakSet();
  const visit = (node, depth) => {
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "number") return Number.isFinite(node) ? node : null;
    if (typeof node === "string") {
      if (node.length > MAX_STRING) notes.add("string-cut");
      return node.length > MAX_STRING ? node.slice(0, MAX_STRING) : node;
    }
    if (typeof node !== "object") {
      notes.add("unsupported-value");
      return `[unsupported ${typeof node}]`;
    }
    if (depth >= MAX_DEPTH) {
      notes.add("depth-limit");
      return "[depth limit]";
    }
    if (seen.has(node)) {
      notes.add("cycle");
      return "[cycle]";
    }
    seen.add(node);
    try {
      if (Array.isArray(node)) {
        if (node.length > maxItems) notes.add("items-cut");
        return node.slice(0, maxItems).map((item) => visit(item, depth + 1));
      }
      const out = Object.create(null);
      let kept = 0;
      for (const key of Object.keys(node)) {
        if (FORBIDDEN_KEYS.has(key)) {
          notes.add("forbidden-key-dropped");
          continue;
        }
        if (kept >= MAX_KEYS) {
          notes.add("keys-cut");
          break;
        }
        kept += 1;
        out[key.length > 200 ? `${key.slice(0, 200)}...` : key] = visit(node[key], depth + 1);
      }
      return out;
    } finally {
      seen.delete(node);
    }
  };
  try {
    return visit(value, 0);
  } catch {
    notes.add("unreadable-value");
    return "[unreadable value]";
  }
}

/** Largest prefix of `text` that fits in `maxBytes` UTF-8 bytes, cut on a code point boundary. */
function headByBytes(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let out = "";
  let bytes = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch);
    if (bytes + size > maxBytes) break;
    out += ch;
    bytes += size;
  }
  return out;
}

function writeAtomicText(file, text, fs) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // Nothing to clean up.
    }
    throw error;
  }
}

/**
 * Bound one tool result.
 *
 * @param {unknown} value  Text, or a JSON-like value (serialized after `toPlainData`).
 * @param {{maxBytes?: number, maxLines?: number, maxItems?: number, maxLineChars?: number, artifactDir?: string,
 *   fs?: typeof nodeFs}} [options]
 */
export function boundOutput(value, options = {}) {
  const maxBytes = Math.min(options.maxBytes ?? DEFAULT_LIMITS.maxBytes, HARD_LIMITS.maxBytes);
  const maxLines = Math.min(options.maxLines ?? DEFAULT_LIMITS.maxLines, HARD_LIMITS.maxLines);
  const maxItems = Math.min(options.maxItems ?? DEFAULT_LIMITS.maxItems, HARD_LIMITS.maxItems);
  const maxLineChars = options.maxLineChars ?? MAX_LINE_CHARS;
  const fs = options.fs ?? nodeFs;
  const notes = new Set();

  let text;
  if (typeof value === "string") text = value;
  else {
    try {
      text = stringifyJson(toPlainData(value, { maxItems, notes }), 2) ?? "";
    } catch {
      text = "[unserializable value]";
      notes.add("unserializable");
    }
  }
  if (text.length > INGEST_CAP_CHARS) {
    text = text.slice(0, INGEST_CAP_CHARS);
    notes.add("input-cut");
  }

  // Sanitize, then redact: the stored artifact and the excerpt are both free of control sequences and secrets.
  const full = redactText(sanitizeForTerminal(text)).text;
  const bytes = Buffer.byteLength(full);
  const sha256 = sha256Hex(full);
  const allLines = full.split("\n");

  const kept = [];
  let shownBytes = 0;
  let cutLine = false;
  for (const raw of allLines) {
    if (kept.length >= maxLines) break;
    let line = raw;
    if (line.length > maxLineChars) {
      line = `${line.slice(0, maxLineChars)}...[line cut, ${raw.length} chars]`;
      cutLine = true;
    }
    const room = maxBytes - shownBytes - (kept.length > 0 ? 1 : 0);
    if (room <= 0) break;
    if (Buffer.byteLength(line) > room) {
      line = headByBytes(line, room);
      kept.push(line);
      shownBytes += Buffer.byteLength(line) + (kept.length > 1 ? 1 : 0);
      break;
    }
    shownBytes += Buffer.byteLength(line) + (kept.length > 0 ? 1 : 0);
    kept.push(line);
  }
  const head = kept.join("\n");
  shownBytes = Buffer.byteLength(head);
  const truncated = kept.length < allLines.length || shownBytes < bytes || cutLine || notes.has("input-cut");

  const result = {
    excerpt: head,
    truncated,
    bytes,
    lines: allLines.length,
    shownBytes,
    shownLines: kept.length,
    sha256,
    artifactPath: null,
    notes: [...notes].sort(),
  };
  if (truncated && typeof options.artifactDir === "string" && options.artifactDir !== "") {
    const file = path.join(options.artifactDir, `${sha256}.txt`);
    try {
      writeAtomicText(file, full, fs);
      result.artifactPath = file;
    } catch {
      result.artifactError = "artifact-write-failed";
    }
  }
  if (truncated) {
    const where = result.artifactPath ? "; full output stored as an artifact" : "";
    result.excerpt = `${head}\n[output truncated: showing ${result.shownBytes} of ${bytes} bytes, ${result.shownLines} of ${result.lines} lines; sha256 ${sha256.slice(0, 16)}${where}]`;
  }
  return result;
}
