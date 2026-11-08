// Hostile images (security review probes as regression tests): marker floods, dimension smuggling, metadata that survived "stripping".
// Synthetic images built in code only.

import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import test from "node:test";
import { inspectImage } from "../src/runtime/attachments.mjs";
import { crc32 } from "./image-fixture.mjs";

const SECRET = "GPS=37.7749,-122.4194 OWNER=alice";
const seg = (marker, data) => {
  const head = Buffer.alloc(4);
  head[0] = 0xff;
  head[1] = marker;
  head.writeUInt16BE(Buffer.from(data).length + 2, 2);
  return Buffer.concat([head, Buffer.from(data)]);
};
const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const sof = (marker = 0xc0, w = 10, h = 10) => seg(marker, Buffer.from([8, h >> 8, h & 255, w >> 8, w & 255, 1, 1, 0x11, 0]));
const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
const jpeg = (extra = [], { frame = sof() } = {}) => Buffer.concat([SOI, ...extra, frame, sos, Buffer.from([0x12, 0x34, 0x56]), EOI]);

const verdict = (buf) => {
  const result = inspectImage(buf, { name: "x" });
  return result.ok ? { ok: true, survives: result.bytes.includes(Buffer.from(SECRET)), dropped: result.image.dropped, image: result.image } : { ok: false, code: result.problems[0].code, message: result.problems[0].message };
};
const accepted = (buf) => {
  const v = verdict(buf);
  assert.equal(v.ok, true, v.message);
  assert.equal(v.survives, false, "the secret must not survive stripping");
  return v;
};
const refused = (buf, ...codes) => {
  const v = verdict(buf);
  assert.equal(v.ok, false);
  assert.ok(codes.includes(v.code), `${v.code}: ${v.message}`);
  return v;
};

test("JPEG: APP0 (any identifier), JFIF thumbnails, JPGn, Adobe tails and ICC text do not survive", () => {
  assert.ok(accepted(jpeg([seg(0xe0, Buffer.from(`AVI1\0${SECRET}`))])).dropped.includes("app0-other"));
  const thumb = Buffer.concat([Buffer.from("JFIF\0\x01\x02\0\0\x01\0\x01", "latin1"), Buffer.from([2, 1]), Buffer.from(SECRET.padEnd(6, " "))]);
  assert.ok(accepted(jpeg([seg(0xe0, thumb)])).dropped.includes("thumbnail"));
  assert.ok(accepted(jpeg([seg(0xe0, Buffer.from(`JFXX\0\x10${SECRET}`))])).dropped.includes("app0-other"));
  assert.ok(accepted(jpeg([seg(0xf0, Buffer.from(SECRET))])).dropped.includes("jpgn"));
  assert.ok(accepted(jpeg([seg(0xee, Buffer.from(`Adobe\0\x64\0\0\0\0\x01${SECRET}`, "latin1"))])).dropped.includes("app14-extra"));
  assert.ok(accepted(jpeg([seg(0xe2, Buffer.from(`ICC_PROFILE\0\x01\x01${SECRET}`, "latin1"))])).dropped.includes("icc"));
  assert.ok(accepted(jpeg([seg(0xdc, Buffer.from(SECRET))])).dropped.includes("other-marker"));
  const between = Buffer.concat([SOI, sof(), sos, Buffer.from([1, 2]), seg(0xfe, Buffer.from(SECRET)), sos, Buffer.from([3]), EOI]);
  assert.ok(accepted(between).dropped.includes("comment"));
});

test("JPEG: a kept segment of the wrong size cannot carry text (the file is refused)", () => {
  refused(jpeg([seg(0xdb, Buffer.from(SECRET))]), "INVALID");
  refused(jpeg([seg(0xc4, Buffer.concat([Buffer.alloc(17), Buffer.from(SECRET)]))]), "INVALID");
  refused(jpeg([seg(0xdd, Buffer.from(SECRET))]), "INVALID");
  refused(Buffer.concat([SOI, seg(0xc0, Buffer.concat([Buffer.from([8, 0, 10, 0, 10, 1, 1, 0x11, 0]), Buffer.from(SECRET)])), sos, EOI]), "INVALID");
  refused(Buffer.concat([SOI, sof(), seg(0xda, Buffer.concat([Buffer.from([1, 1, 0, 0, 0x3f, 0]), Buffer.from(SECRET)])), EOI]), "INVALID");
});

test("JPEG: a second frame header and hierarchical frame headers cannot smuggle dimensions", () => {
  refused(Buffer.concat([SOI, sof(), sof(0xc2, 0xffff, 0xffff), sos, Buffer.from([1]), EOI]), "INVALID", "DIMENSIONS");
  for (const marker of [0xc5, 0xc6, 0xc7, 0xcd, 0xce, 0xcf]) refused(jpeg([], { frame: sof(marker) }), "INVALID", "DIMENSIONS");
  refused(Buffer.concat([SOI, sos, sof(), EOI]), "INVALID");
});

test("JPEG: TEM and RST markers outside image data are refused instantly, with flat memory (5 MiB of FF01)", () => {
  const total = 5 * 1024 * 1024 - 64;
  const head = Buffer.concat([SOI, sof(), sos, Buffer.from([1])]);
  const flood = Buffer.alloc(total - head.length - 2);
  for (let i = 0; i + 1 < flood.length; i += 2) {
    flood[i] = 0xff;
    flood[i + 1] = 0x01;
  }
  const buf = Buffer.concat([head, flood, EOI]);
  globalThis.gc?.();
  const before = process.memoryUsage().heapUsed;
  const started = process.hrtime.bigint();
  const v = refused(buf, "INVALID");
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  const growth = process.memoryUsage().heapUsed - before;
  assert.ok(ms < 50, `${ms} ms`);
  assert.ok(growth < 20 * 1024 * 1024, `heap grew ${growth} bytes`);
  assert.match(v.message, /not allowed outside image data/);

  const rst = Buffer.alloc(total);
  rst[0] = 0xff;
  rst[1] = 0xd8;
  for (let i = 2; i + 1 < rst.length; i += 2) {
    rst[i] = 0xff;
    rst[i + 1] = 0xd0;
  }
  refused(rst, "INVALID");
});

test("JPEG: more segments than the cap are refused quickly (tiny APP5 segments)", () => {
  const buf = Buffer.alloc(5 * 1024 * 1024 - 64);
  buf[0] = 0xff;
  buf[1] = 0xd8;
  for (let i = 2; i + 3 < buf.length; i += 4) {
    buf[i] = 0xff;
    buf[i + 1] = 0xe5;
    buf[i + 2] = 0;
    buf[i + 3] = 2;
  }
  const started = process.hrtime.bigint();
  refused(buf, "INVALID", "TRUNCATED");
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200);
  refused(Buffer.concat([SOI, Buffer.alloc(5 * 1024 * 1024 - 8, 0xff)]), "TRUNCATED");
});

// PNG -------------------------------------------------------------------------------------------------

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chunk = (type, data) => {
  const d = Buffer.from(data);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(d.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), d])));
  return Buffer.concat([head, d, crc]);
};
const ihdr = (colorType = 0, depth = 8) => { const b = Buffer.alloc(13); b.writeUInt32BE(1, 0); b.writeUInt32BE(1, 4); b[8] = depth; b[9] = colorType; return b; };
const png = (middle = [], colorType = 0, depth = 8) => Buffer.concat([sig, chunk("IHDR", ihdr(colorType, depth)), ...middle, chunk("IDAT", deflateSync(Buffer.from([0, 0]))), chunk("IEND", Buffer.alloc(0))]);

test("PNG: private critical chunks are refused; iCCP, text and trailing data do not survive; kept chunks must have valid sizes", () => {
  refused(png([chunk("PRIV", SECRET)]), "INVALID");
  assert.ok(accepted(png([chunk("iCCP", Buffer.concat([Buffer.from(SECRET.slice(0, 79)), Buffer.from([0, 0]), deflateSync(Buffer.from(SECRET))]))])).dropped.includes("icc"));
  assert.ok(accepted(png([chunk("tEXt", `Comment\0${SECRET}`)])).dropped.includes("text"));
  assert.ok(accepted(png([chunk("prIv", SECRET)])).dropped.includes("other-ancillary"));
  assert.ok(accepted(Buffer.concat([png(), Buffer.from(SECRET)])).dropped.includes("trailing-data"));
  refused(png([chunk("gAMA", SECRET)]), "INVALID");
  refused(png([chunk("pHYs", SECRET)]), "INVALID");
  accepted(png([chunk("gAMA", Buffer.from([0, 1, 0x86, 0xa0])), chunk("pHYs", Buffer.alloc(9)), chunk("sRGB", Buffer.from([0]))]));
});

test("PNG: free bytes in PLTE, tRNS, sBIT and bKGD cannot survive (palette only for type 3, exact lengths per colour type)", () => {
  // a palette in a truecolour or greyscale image is a hint a decoder ignores: dropped, never kept
  assert.ok(accepted(png([chunk("PLTE", Buffer.from(SECRET.padEnd(36, " ")))], 2)).dropped.includes("other-ancillary"));
  assert.ok(accepted(png([chunk("PLTE", Buffer.from(SECRET.padEnd(36, " ")))], 0)).dropped.includes("other-ancillary"));
  // colour type 3: the palette fits the bit depth; tRNS fits the palette
  accepted(png([chunk("PLTE", Buffer.alloc(6, 7)), chunk("tRNS", Buffer.from([1, 2]))], 3, 1));
  refused(png([chunk("PLTE", Buffer.alloc(9, 7))], 3, 1), "INVALID"); // 3 entries do not fit 1 bit
  refused(png([chunk("PLTE", Buffer.alloc(6, 7)), chunk("tRNS", Buffer.from(SECRET))], 3, 8), "INVALID");
  refused(png([chunk("PLTE", Buffer.alloc(6, 7)), chunk("tRNS", Buffer.from([1, 2, 3]))], 3, 8), "INVALID"); // longer than the palette
  refused(png([chunk("tRNS", Buffer.from([1]))], 3, 8), "INVALID"); // no palette yet
  refused(png([], 3, 8), "INVALID"); // image data before any palette
  refused(png([chunk("PLTE", Buffer.alloc(6)), chunk("PLTE", Buffer.alloc(6))], 3, 8), "INVALID");
  // exact lengths for the other colour types; tRNS is dropped where it cannot apply
  accepted(png([chunk("tRNS", Buffer.alloc(2))], 0));
  refused(png([chunk("tRNS", Buffer.from(SECRET))], 0), "INVALID");
  accepted(png([chunk("tRNS", Buffer.alloc(6))], 2));
  refused(png([chunk("tRNS", Buffer.from(SECRET))], 2), "INVALID");
  assert.ok(accepted(png([chunk("tRNS", Buffer.from(SECRET))], 6, 8)).dropped.includes("other-ancillary"));
  refused(png([chunk("sBIT", Buffer.from(SECRET))], 2), "INVALID");
  refused(png([chunk("bKGD", Buffer.from(SECRET))], 2), "INVALID");
  accepted(png([chunk("sBIT", Buffer.from([8, 8, 8])), chunk("bKGD", Buffer.alloc(6))], 2));
  refused(png([], 1), "INVALID"); // colour type 1 does not exist
  refused(png([], 2, 4), "INVALID"); // 4-bit truecolour does not exist
});

// WebP ------------------------------------------------------------------------------------------------

const rc = (cc, data) => {
  const d = Buffer.from(data);
  const head = Buffer.alloc(8);
  head.write(cc, 0, "latin1");
  head.writeUInt32LE(d.length, 4);
  return Buffer.concat([head, d, d.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const riff = (body) => {
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(4 + body.length, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
};
const vp8l = (w, h, version = 0) => {
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  d.writeUInt32LE((((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14) | (version << 29)) >>> 0, 1);
  return rc("VP8L", d);
};
const vp8x = (w, h, flags = 0, reserved = [0, 0, 0]) => {
  const d = Buffer.alloc(10);
  d[0] = flags;
  d[1] = reserved[0];
  d[2] = reserved[1];
  d[3] = reserved[2];
  d.writeUIntLE(w - 1, 4, 3);
  d.writeUIntLE(h - 1, 7, 3);
  return rc("VP8X", d);
};
const anmf = (w, h, ...subs) => {
  const header = Buffer.alloc(16);
  header.writeUIntLE(w - 1, 6, 3);
  header.writeUIntLE(h - 1, 9, 3);
  return rc("ANMF", Buffer.concat([header, ...subs]));
};

test("WebP: bitstream dimensions are checked against the limits and the canvas (no VP8X smuggling)", () => {
  refused(riff(Buffer.concat([vp8x(10, 10), vp8l(16384, 16384)])), "DIMENSIONS");
  refused(riff(Buffer.concat([vp8x(10, 10), vp8l(12, 12)])), "INVALID");
  accepted(riff(Buffer.concat([vp8x(10, 10), vp8l(10, 10)])));
  refused(riff(Buffer.concat([vp8x(10, 10), vp8l(10, 10), vp8l(10, 10)])), "INVALID");
  refused(riff(vp8l(10, 10, 1)), "INVALID"); // the VP8L version field must be 0
});

test("WebP: animated images are refused (an animation can declare unbounded pixels in a tiny file)", () => {
  const bomb = riff(Buffer.concat([vp8x(6000, 6000, 0x02), rc("ANIM", Buffer.alloc(6)), ...Array.from({ length: 40_000 }, () => anmf(6000, 6000, vp8l(6000, 6000)))]));
  const started = process.hrtime.bigint();
  const v = refused(bomb, "INVALID");
  assert.match(v.message, /animated WebP images are not accepted/);
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 200);
  refused(riff(Buffer.concat([vp8x(10, 10, 0x02), anmf(10, 10, vp8l(10, 10))])), "INVALID");
  refused(riff(Buffer.concat([vp8x(10, 10), vp8l(10, 10), anmf(10, 10, vp8l(10, 10))])), "INVALID", "DIMENSIONS");
});

test("WebP: unknown chunks, ICCP, EXIF and reserved VP8X bytes do not survive", () => {
  assert.ok(accepted(riff(Buffer.concat([vp8x(10, 10, 0x20), rc("ICCP", SECRET), vp8l(10, 10)]))).dropped.includes("icc"));
  assert.ok(accepted(riff(Buffer.concat([vp8x(10, 10, 0x08), vp8l(10, 10), rc("EXIF", SECRET)]))).dropped.includes("exif"));
  assert.ok(accepted(riff(Buffer.concat([vp8l(10, 10), rc("ZZZZ", SECRET)]))).dropped.includes("other-chunk"));
  assert.ok(accepted(riff(Buffer.concat([vp8x(10, 10), vp8l(10, 10), rc("ZZZZ", SECRET)]))).dropped.includes("other-chunk"));
  const reserved = riff(Buffer.concat([vp8x(10, 10, 0x01, Buffer.from("GPS")), vp8l(10, 10)]));
  assert.equal(inspectImage(reserved, { name: "x" }).bytes.includes(Buffer.from("GPS")), false, "the reserved VP8X bytes are zeroed");
  refused(riff(Buffer.concat([rc("VP8X", Buffer.concat([Buffer.alloc(10), Buffer.from(SECRET)])), vp8l(10, 10)])), "INVALID");
});

test("WebP: thousands of empty chunks are refused at the cap without growing memory", () => {
  const parts = [vp8l(10, 10)];
  const empty = Buffer.alloc(8);
  empty.write("ZZZZ", 0, "latin1");
  for (let i = 0; i < 100_010; i += 1) parts.push(empty);
  const started = process.hrtime.bigint();
  refused(riff(Buffer.concat(parts)), "INVALID");
  assert.ok(Number(process.hrtime.bigint() - started) / 1e6 < 500);
});

// JPEG arithmetic conditioning and Adobe ------------------------------------------------------------

test("JPEG: DAC is only valid for arithmetic coding, with in-range values and each table once", () => {
  const arith = (extra) => Buffer.concat([SOI, extra, sof(0xc9), sos, Buffer.from([0x12]), EOI]);
  accepted(arith(seg(0xcc, Buffer.from([0x00, 0x10, 0x10, 0x05]))));
  refused(jpeg([seg(0xcc, Buffer.from([0x00, 0x10]))]), "INVALID"); // DAC in a Huffman JPEG
  refused(arith(seg(0xcc, Buffer.from(SECRET))), "INVALID");
  refused(arith(seg(0xcc, Buffer.from([0x00, 0x12]))), "INVALID"); // L > U
  refused(arith(seg(0xcc, Buffer.from([0x10, 0x00]))), "INVALID"); // AC Kx must be 1..63
  refused(arith(seg(0xcc, Buffer.from([0x10, 0x40]))), "INVALID");
  refused(arith(seg(0xcc, Buffer.from([0x40, 0x01]))), "INVALID"); // Tc > 1
  refused(arith(Buffer.concat([seg(0xcc, Buffer.from([0x00, 0x10])), seg(0xcc, Buffer.from([0x00, 0x10]))])), "INVALID"); // the same table twice
  refused(arith(seg(0xcc, Buffer.from([0x00, 0x10, 0x10]))), "INVALID");
});

test("JPEG: the Adobe APP14 segment is normalised to the colour transform byte", () => {
  const out = inspectImage(jpeg([seg(0xee, Buffer.concat([Buffer.from("Adobe"), Buffer.from([0, 0x64, 0, 0, 0, 0, 2]), Buffer.from("GPS=377")]))]), { name: "x" });
  assert.equal(out.ok, true);
  assert.equal(out.bytes.includes(Buffer.from("GPS=377")), false);
  const at = out.bytes.indexOf(Buffer.from("Adobe"));
  assert.deepEqual([...out.bytes.subarray(at, at + 12)], [0x41, 0x64, 0x6f, 0x62, 0x65, 0, 0x64, 0, 0, 0, 0, 2]);
  const odd = inspectImage(jpeg([seg(0xee, Buffer.from(`Adobe\0\x64\0\0\0\0\x09`, "latin1"))]), { name: "x" });
  assert.equal(odd.ok, true);
  assert.equal(odd.bytes.includes(Buffer.from("Adobe")), false, "an impossible transform value drops the segment");
});
