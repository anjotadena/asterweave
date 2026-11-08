// Pure image header parsing and metadata stripping for PNG, JPEG and WebP. No dependencies, no decoding.
//
// The format is decided by MAGIC BYTES only (never an extension or a claimed mime). Only header structure is parsed (PNG chunk list,
// JPEG marker segments, WebP RIFF chunks): pixel data is never decompressed or interpreted, so a decompression bomb is rejected from
// its declared dimensions alone. Every read is bounds-checked against the buffer, and every loop is bounded by a count cap that is
// checked right after each step, with memory that does not grow with skipped or dropped structures.
//
// Stripping is an ALLOWLIST: a structure survives only when it is needed to decode the image AND its size and value ranges are exactly
// what its type allows, so kept structures carry only decodable fields. Pixel and entropy-coded data (and table values) are NOT
// inspected: a covert channel inside them is not removed. Everything else is dropped and reported, or the file is refused.
//
// Limits are CONSERVATIVE GUESSES chosen by this tool, NOT documented provider limits (see website/docs/cli/images.md).
//
// Trailing data after the end marker (PNG IEND, JPEG EOI, the RIFF size of a WebP) is STRIPPED (not rejected): a polyglot such as an
// image with an archive appended is cut back to the image, and `trailing-data` is reported among the dropped kinds.

import { createHash } from "node:crypto";
import { walkJpeg, stripJpeg } from "./image-jpeg.mjs";
import { ascii, checkDimensions, fail, MAX_STRUCTURES } from "./image-util.mjs";
import { walkWebp, stripWebp } from "./image-webp.mjs";

export const IMAGE_LIMITS = Object.freeze({
  maxBytes: 5 * 1024 * 1024,
  maxDimension: 8000,
  minDimension: 1,
  maxPixels: 40_000_000,
  perMessage: 10,
  perSession: 20,
});

export const IMAGE_FORMATS = Object.freeze({
  png: Object.freeze({ mime: "image/png", ext: "png" }),
  jpeg: Object.freeze({ mime: "image/jpeg", ext: "jpg" }),
  webp: Object.freeze({ mime: "image/webp", ext: "webp" }),
});

export { checkDimensions };
export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_CHUNKS = MAX_STRUCTURES;

/** "png" | "jpeg" | "webp" | null, from the first bytes only. */
export function sniffFormat(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 12 && ascii(buf, 0, 4) === "RIFF" && ascii(buf, 8, 12) === "WEBP") return "webp";
  return null;
}

/** A short name for a recognisable unsupported format (for the error message only). */
export function describeUnsupported(buf) {
  const head = ascii(buf, 0, 12);
  const text = ascii(buf, 0, 256).replace(/^﻿/, "").trimStart().toLowerCase();
  if (head.startsWith("GIF8")) return "GIF";
  if (head.startsWith("%PDF")) return "PDF";
  if (text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg"))) return "SVG";
  if (head.startsWith("BM")) return "BMP";
  if (head.startsWith("II*\0") || head.startsWith("MM\0*")) return "TIFF";
  if (head.slice(4, 8) === "ftyp") return "HEIC/AVIF (ISO media)";
  if (head.startsWith("RIFF")) return "RIFF (not WebP)";
  return null;
}

// PNG -----------------------------------------------------------------------------------------------

// Chunks that may survive. Each kept chunk must have exactly the size and value range its type allows FOR THIS IMAGE'S COLOUR TYPE, so
// it cannot carry free text. A palette is kept only for colour type 3, tRNS only within the palette (or its exact length for types 0
// and 2). iCCP (a profile name and free-form data) and every other ancillary chunk are dropped; an unknown CRITICAL chunk (uppercase
// first letter) means the file cannot be decoded as a plain PNG: refused. The compressed pixel data is not inspected.
const PNG_DEPTHS = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const PNG_SBIT = { 0: 1, 2: 3, 3: 3, 4: 2, 6: 4 };
const PNG_BKGD = { 0: 2, 2: 6, 3: 1, 4: 2, 6: 6 };
const PNG_NAMED = { eXIf: "exif", tEXt: "text", iTXt: "text", zTXt: "text", tIME: "time", iCCP: "icc" };
const PNG_FIXED = new Set(["gAMA", "cHRM", "sRGB", "pHYs", "sBIT", "bKGD", "PLTE", "tRNS", "IDAT", "IEND"]);

/** true = keep, false = drop, a string = the file is invalid. `at` is the offset of the chunk data. */
function pngRule(type, len, buf, at, state) {
  const bad = `the PNG ${type} chunk has an invalid size or value`;
  switch (type) {
    case "PLTE":
      if (state.colorType !== 3) return false;
      if (len % 3 !== 0 || len < 3 || len / 3 > 1 << state.depth || state.palette > 0 || state.sawData) return bad;
      state.palette = len / 3;
      return true;
    case "tRNS":
      if (state.colorType === 4 || state.colorType === 6) return false;
      if (state.colorType === 0) return len === 2 ? true : bad;
      if (state.colorType === 2) return len === 6 ? true : bad;
      return state.palette > 0 && len >= 1 && len <= state.palette ? true : bad;
    case "gAMA": return len === 4 ? true : bad;
    case "cHRM": return len === 32 ? true : bad;
    case "sRGB": return len === 1 && buf[at] <= 3 ? true : bad;
    case "pHYs": return len === 9 && buf[at + 8] <= 1 ? true : bad;
    case "sBIT": return len === PNG_SBIT[state.colorType] ? true : bad;
    case "bKGD": return len === PNG_BKGD[state.colorType] ? true : bad;
    case "IDAT":
      if (state.colorType === 3 && state.palette === 0) return "the PNG has image data before its palette";
      state.sawData = true;
      return true;
    default: return len === 0 ? true : bad; // IEND
  }
}

function walkPng(buf) {
  const kept = [];
  const dropped = new Set();
  let pos = 8;
  let count = 0;
  const state = { colorType: -1, depth: 0, palette: 0, sawData: false };
  for (;;) {
    if (pos + 12 > buf.length) return fail("TRUNCATED", "the PNG ends before its IEND chunk");
    const len = buf.readUInt32BE(pos);
    const type = ascii(buf, pos + 4, pos + 8);
    if (len > 0x7fffffff || !/^[A-Za-z]{4}$/.test(type)) return fail("INVALID", "the PNG has a malformed chunk header");
    const end = pos + 12 + len;
    if (end > buf.length) return fail("TRUNCATED", "the PNG is truncated inside a chunk");
    if (count === 0) {
      if (type !== "IHDR" || len !== 13) return fail("INVALID", "the PNG does not start with a valid IHDR chunk");
      state.depth = buf[pos + 16];
      state.colorType = buf[pos + 17];
      if (!PNG_DEPTHS[state.colorType]?.includes(state.depth) || buf[pos + 18] !== 0 || buf[pos + 19] !== 0 || buf[pos + 20] > 1) return fail("INVALID", "the PNG header has an invalid colour type, bit depth or method");
      kept.push({ start: pos, end });
    }
    count += 1;
    if (count > MAX_CHUNKS) return fail("INVALID", "the PNG has too many chunks");
    if (count > 1) {
      if (PNG_FIXED.has(type)) {
        const rule = pngRule(type, len, buf, pos + 8, state);
        if (typeof rule === "string") return fail("INVALID", rule);
        if (rule) kept.push({ start: pos, end });
        else dropped.add("other-ancillary");
      } else if (type.charCodeAt(0) < 0x61) return fail("INVALID", `the PNG has an unknown critical chunk (${type})`);
      else dropped.add(PNG_NAMED[type] ?? "other-ancillary");
    }
    pos = end;
    if (type === "IEND") break;
  }
  if (!state.sawData) return fail("INVALID", "the PNG has no image data");
  return { ok: true, format: "png", width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), end: pos, kept, dropped };
}

function stripPng(buf, walk) {
  return { bytes: Buffer.concat([PNG_SIGNATURE, ...walk.kept.map((chunk) => buf.subarray(chunk.start, chunk.end))]), dropped: walk.dropped };
}

// Public --------------------------------------------------------------------------------------------

/**
 * Parse the structure and dimensions of `buf`. Never decodes pixels.
 * @returns {{ok: true, format: string, width: number, height: number, end: number} | {ok: false, code: string, message: string}}
 */
export function parseImage(buf, limits = IMAGE_LIMITS) {
  if (!Buffer.isBuffer(buf)) return fail("INVALID", "the image data is not a buffer");
  if (buf.length === 0) return fail("EMPTY", "the file is empty");
  const format = sniffFormat(buf);
  if (format === null) {
    const name = describeUnsupported(buf);
    return fail("UNSUPPORTED_FORMAT", `${name ? `this looks like ${name}, which is not accepted` : "the file is not a recognised image"}; only PNG, JPEG and WebP are supported (decided by the file's first bytes)`);
  }
  const walk = format === "png" ? walkPng(buf) : format === "jpeg" ? walkJpeg(buf, limits) : walkWebp(buf, limits);
  if (walk.ok !== true) return walk;
  const bad = checkDimensions(walk.width, walk.height, limits);
  return bad ?? walk;
}

/**
 * Metadata removal. @param {Buffer} buf  @param {object} parsed  The ok result of parseImage for `buf`.
 * @returns {{bytes: Buffer, dropped: string[]}}  `dropped` lists the kinds removed (sorted); `trailing-data` when bytes after the end marker were cut.
 */
export function stripMetadata(buf, parsed) {
  const done = parsed.format === "png" ? stripPng(buf, parsed) : parsed.format === "jpeg" ? stripJpeg(buf, parsed) : stripWebp(buf, parsed);
  const dropped = new Set(done.dropped);
  if (buf.length > parsed.end) dropped.add("trailing-data");
  return { bytes: done.bytes, dropped: [...dropped].sort() };
}
