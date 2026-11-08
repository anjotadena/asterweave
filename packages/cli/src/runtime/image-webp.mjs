// WebP (RIFF) structure walk and metadata stripping (allowlist). See image-format.mjs for the rules.
//
// ANIMATED WebP IS REFUSED: every frame declares its own size, so a small file could declare an unbounded number of pixels
// (40,000 frames of 6000 x 6000), which a per-image pixel limit cannot express. Still images only.
// Kept: VP8X (only the alpha flag and the canvas size survive), ALPH, and exactly one VP8 / VP8L. Dropped: EXIF, XMP, ICCP and every
// unknown chunk. The size in the image bitstream header (VP8, VP8L) is checked against the canvas AND the limits, so a small VP8X
// cannot hide a huge bitstream. The bitstream and alpha data themselves are not inspected.

import { ascii, checkDimensions, fail, MAX_STRUCTURES } from "./image-util.mjs";

const u24 = (buf, at) => buf[at] | (buf[at + 1] << 8) | (buf[at + 2] << 16);

/** Chunks in [from, to), bounds-checked; the count cap is checked right after every chunk. */
function chunksIn(buf, from, to) {
  const chunks = [];
  let pos = from;
  while (pos < to) {
    if (pos + 8 > to) return fail("INVALID", "the WebP has a malformed chunk header");
    const size = buf.readUInt32LE(pos + 4);
    const dataStart = pos + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > to) return fail("TRUNCATED", "the WebP is truncated inside a chunk");
    chunks.push({ fourcc: ascii(buf, pos, pos + 4), start: pos, dataStart, dataEnd });
    if (chunks.length > MAX_STRUCTURES) return fail("INVALID", "the WebP has too many chunks");
    pos = dataEnd + (size % 2);
  }
  return { ok: true, chunks };
}

/** Width and height from a VP8 / VP8L header, or null when the header is not valid. */
function bitstreamSize(buf, chunk) {
  const size = chunk.dataEnd - chunk.dataStart;
  const at = chunk.dataStart;
  if (chunk.fourcc === "VP8 ") {
    if (size < 10 || (buf[at] & 1) !== 0 || buf[at + 3] !== 0x9d || buf[at + 4] !== 0x01 || buf[at + 5] !== 0x2a) return null;
    return { width: buf.readUInt16LE(at + 6) & 0x3fff, height: buf.readUInt16LE(at + 8) & 0x3fff };
  }
  if (size < 5 || buf[at] !== 0x2f) return null;
  const bits = buf.readUInt32LE(at + 1);
  if (bits >>> 29 !== 0) return null; // the VP8L version field must be 0
  return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
}

/** Check one image bitstream against the limits and the expected size; returns a failure or null. */
function checkBitstream(buf, chunk, expected, limits) {
  const found = bitstreamSize(buf, chunk);
  if (found === null) return fail("INVALID", `the WebP ${chunk.fourcc.trim()} header is not valid`);
  const bad = checkDimensions(found.width, found.height, limits);
  if (bad) return bad;
  if (expected && (found.width !== expected.width || found.height !== expected.height)) return fail("INVALID", `the WebP ${chunk.fourcc.trim()} is ${found.width} x ${found.height} but the canvas is ${expected.width} x ${expected.height}`);
  return null;
}

export function walkWebp(buf, limits) {
  if (buf.length < 20) return fail("TRUNCATED", "the WebP is too short");
  const riffSize = buf.readUInt32LE(4);
  const end = riffSize + 8;
  if (riffSize < 12 || riffSize % 2 !== 0) return fail("INVALID", "the WebP has a malformed RIFF size");
  if (end > buf.length) return fail("TRUNCATED", "the WebP is shorter than its RIFF size");
  const listed = chunksIn(buf, 12, end);
  if (!listed.ok) return listed;
  const [first, ...rest] = listed.chunks;
  if (!first) return fail("INVALID", "the WebP has no chunks");
  const dropped = new Set();

  if (first.fourcc === "VP8 " || first.fourcc === "VP8L") {
    const bad = checkBitstream(buf, first, null, limits);
    if (bad) return bad;
    if (rest.length > 0) dropped.add("other-chunk");
    const { width, height } = bitstreamSize(buf, first);
    return { ok: true, format: "webp", width, height, end, parts: [{ type: "raw", chunk: first }], dropped };
  }
  if (first.fourcc !== "VP8X") return fail("INVALID", "the WebP does not start with an image chunk");
  if (first.dataEnd - first.dataStart !== 10) return fail("INVALID", "the WebP VP8X chunk has an invalid size");
  const flags = buf[first.dataStart];
  if ((flags & 0x02) !== 0 || rest.some((chunk) => chunk.fourcc === "ANMF")) return fail("INVALID", "animated WebP images are not accepted; use a still image");
  const canvas = { width: 1 + u24(buf, first.dataStart + 4), height: 1 + u24(buf, first.dataStart + 7) };
  const tooBig = checkDimensions(canvas.width, canvas.height, limits);
  if (tooBig) return tooBig;
  const parts = [{ type: "vp8x", chunk: first, flags: flags & 0x10 }]; // only the alpha flag survives
  let images = 0;
  for (const chunk of rest) {
    const { fourcc } = chunk;
    if (fourcc === "ICCP") dropped.add("icc");
    else if (fourcc === "EXIF") dropped.add("exif");
    else if (fourcc === "XMP ") dropped.add("xmp");
    else if (fourcc === "ALPH") parts.push({ type: "raw", chunk });
    else if (fourcc === "VP8 " || fourcc === "VP8L") {
      const bad = checkBitstream(buf, chunk, canvas, limits);
      if (bad) return bad;
      images += 1;
      if (images > 1) return fail("INVALID", "the WebP has more than one image");
      parts.push({ type: "raw", chunk });
    } else dropped.add("other-chunk");
  }
  if (images !== 1) return fail("INVALID", "the WebP has no image data");
  return { ok: true, format: "webp", width: canvas.width, height: canvas.height, end, parts, dropped };
}

const header = (fourcc, size) => {
  const out = Buffer.alloc(8);
  out.write(fourcc, 0, "latin1");
  out.writeUInt32LE(size, 4);
  return out;
};

/** A kept chunk, byte for byte, with a zero pad byte when its size is odd. */
function raw(buf, chunk) {
  return [buf.subarray(chunk.start, chunk.dataEnd), ...((chunk.dataEnd - chunk.dataStart) % 2 === 1 ? [Buffer.alloc(1)] : [])];
}

export function stripWebp(buf, walk) {
  const out = [];
  for (const part of walk.parts) {
    if (part.type === "raw") out.push(...raw(buf, part.chunk));
    else {
      const data = Buffer.from(buf.subarray(part.chunk.dataStart, part.chunk.dataEnd));
      data[0] = part.flags;
      data.fill(0, 1, 4); // the reserved bytes carry nothing
      out.push(header("VP8X", 10), data);
    }
  }
  const body = Buffer.concat(out);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return { bytes: Buffer.concat([head, body]), dropped: walk.dropped };
}
