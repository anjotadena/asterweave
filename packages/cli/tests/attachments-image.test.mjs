// inspectImage: magic-byte format detection, header dimensions, limits, hostile files, metadata stripping. Synthetic images only.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { inspectImage, readImageFile } from "../src/runtime/attachments.mjs";
import { parseImage, sha256Hex } from "../src/runtime/image-format.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";
import { EXIF_GPS_TEXT, exifPayload, iccPayload, makeJpeg, makePng, makeWebp, pngChunk, xmpPayload } from "./image-fixture.mjs";

after(cleanupTemp);

const ok = (source, opts) => {
  const result = inspectImage(source, opts);
  assert.equal(result.ok, true, JSON.stringify(result.problems));
  return result;
};
const bad = (source, code, opts) => {
  const result = inspectImage(source, opts);
  assert.equal(result.ok, false);
  assert.equal(result.problems[0].code, code, result.problems[0].message);
  return result;
};
const has = (buf, text) => buf.includes(Buffer.from(text, "latin1"));

test("format and size come from the header, for all three formats", () => {
  const cases = [
    [makePng({ width: 3, height: 5 }), "png", "image/png", 3, 5],
    [makeJpeg({ width: 7, height: 9 }), "jpeg", "image/jpeg", 7, 9],
    [makeWebp({ kind: "lossy", width: 11, height: 13 }), "webp", "image/webp", 11, 13],
    [makeWebp({ kind: "lossless", width: 17, height: 19 }), "webp", "image/webp", 17, 19],
    [makeWebp({ kind: "extended", width: 21, height: 23 }), "webp", "image/webp", 21, 23],
  ];
  for (const [bytes, format, mime, width, height] of cases) {
    const { image } = ok(bytes);
    assert.deepEqual([image.format, image.mime, image.width, image.height], [format, mime, width, height]);
    assert.equal(image.metadataStripped, true);
    assert.match(image.id, /^img_[0-9a-f]{12}$/);
    assert.equal(image.sha256, sha256Hex(ok(bytes).bytes), "the hash is of the STRIPPED bytes");
  }
});

test("a SOF2 (progressive) JPEG and a multi-scan layout parse", () => {
  const { image } = ok(makeJpeg({ width: 40, height: 30, sof: 0xc2 }));
  assert.deepEqual([image.width, image.height], [40, 30]);
});

test("the extension and any claimed type are ignored: bytes decide", () => {
  const dir = tempDir("aw-img-ext-");
  writeFileSync(join(dir, "photo.jpg"), makePng());
  writeFileSync(join(dir, "diagram.png"), makeJpeg());
  writeFileSync(join(dir, "shot.gif"), makeWebp());
  assert.equal(ok(join(dir, "photo.jpg")).image.format, "png");
  assert.equal(ok(join(dir, "diagram.png")).image.format, "jpeg");
  assert.equal(ok(join(dir, "shot.gif")).image.format, "webp");
  writeFileSync(join(dir, "real.png"), Buffer.from("GIF89a\x01\0\x01\0\0\0\0", "latin1"));
  bad(join(dir, "real.png"), "UNSUPPORTED_FORMAT");
});

test("GIF, SVG, BMP, TIFF, HEIC, PDF, RIFF-not-WebP, text, random bytes and an empty file are refused", () => {
  const samples = {
    GIF: Buffer.from("GIF89a\x01\0\x01\0\x80\0\0", "latin1"),
    SVG: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><script>alert(1)</script></svg>'),
    "SVG (xml)": Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'),
    BMP: Buffer.from("BM\x1e\0\0\0\0\0\0\0\x1a\0\0\0", "latin1"),
    TIFF: Buffer.from("II*\0\x08\0\0\0\0\0", "latin1"),
    "TIFF big-endian": Buffer.from("MM\0*\0\0\0\x08\0\0", "latin1"),
    HEIC: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypheic\0\0\0\0mif1heic", "latin1")]),
    PDF: Buffer.from("%PDF-1.7\n1 0 obj\n", "latin1"),
    RIFF: Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVEfmt ", "latin1")]),
    text: Buffer.from("hello, this is not an image at all"),
    random: Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 0xff)),
  };
  for (const [name, bytes] of Object.entries(samples)) {
    const result = bad(bytes, "UNSUPPORTED_FORMAT");
    assert.match(result.problems[0].message, /only PNG, JPEG and WebP/, name);
  }
  bad(Buffer.alloc(0), "EMPTY");
  assert.match(bad(samples.GIF, "UNSUPPORTED_FORMAT").problems[0].message, /GIF/);
  assert.match(bad(samples.SVG, "UNSUPPORTED_FORMAT").problems[0].message, /SVG/);
});

test("truncated images are refused at every format", () => {
  const png = makePng();
  bad(png.subarray(0, png.length - 12), "TRUNCATED");
  bad(png.subarray(0, 20), "TRUNCATED");
  const jpeg = makeJpeg();
  bad(jpeg.subarray(0, jpeg.length - 2), "TRUNCATED");
  bad(jpeg.subarray(0, 30), "TRUNCATED");
  const webp = makeWebp({ kind: "extended" });
  bad(webp.subarray(0, webp.length - 3), "TRUNCATED");
  bad(Buffer.from([0xff, 0xd8, 0xff]), "TRUNCATED");
});

test("malformed structure is refused", () => {
  bad(Buffer.concat([makePng().subarray(0, 8), pngChunk("tEXt", Buffer.from("a\0b"))]), "INVALID");
  bad(Buffer.concat([makePng().subarray(0, 8), pngChunk("tEXt", Buffer.from("a\0b")), pngChunk("IEND")]), "INVALID"); // first chunk is not IHDR
  bad(Buffer.concat([makePng().subarray(0, 33), pngChunk("IEND")]), "INVALID"); // signature + IHDR + IEND: no IDAT
  const lie = Buffer.from(makeWebp({ kind: "lossless" }));
  lie.writeUInt32LE(0x7fffff00, 4);
  bad(lie, "TRUNCATED");
  bad(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00, 0x00]), "INVALID");
});

test("dimension limits: more than 8000, zero, and more than 40 megapixels are refused; the boundary passes", () => {
  bad(makePng({ width: 8001, height: 10 }), "DIMENSIONS");
  bad(makePng({ width: 10, height: 8001 }), "DIMENSIONS");
  bad(makePng({ width: 0, height: 10 }), "DIMENSIONS");
  bad(makePng({ width: 0xffffffff, height: 0xffffffff }), "DIMENSIONS");
  bad(makePng({ width: 8000, height: 6000 }), "DIMENSIONS"); // 48 MP: a decompression bomb by pixel count
  bad(makeJpeg({ width: 0, height: 5 }), "DIMENSIONS");
  bad(makeJpeg({ width: 5, height: 0 }), "DIMENSIONS");
  bad(makeWebp({ kind: "extended", width: 8001, height: 4 }), "DIMENSIONS");
  assert.equal(ok(makePng({ width: 8000, height: 5000 })).image.width, 8000); // exactly 40 MP
  assert.equal(ok(makePng({ width: 1, height: 1 })).image.height, 1);
  assert.equal(ok(makeJpeg({ width: 8000, height: 1 })).image.width, 8000);
});

test("the byte limit is 5 MiB, checked before and while reading", () => {
  const big = Buffer.concat([makePng(), Buffer.alloc(5 * 1024 * 1024)]);
  bad(big, "TOO_LARGE");
  const dir = tempDir("aw-img-big-");
  const file = join(dir, "big.png");
  writeFileSync(file, big);
  let reads = 0;
  const counting = { ...nodeFs, readSync: (...args) => { reads += 1; return nodeFs.readSync(...args); } };
  bad(file, "TOO_LARGE", { fs: counting });
  assert.equal(reads, 0, "the size is capped before any read");
  // a file that claims to be small but keeps growing: the read is capped at limit + 1
  const lying = {
    ...nodeFs,
    fstatSync: (fd) => { const info = nodeFs.fstatSync(fd); return { isFile: () => true, size: 100, mtimeMs: info.mtimeMs }; },
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, size: 100 }),
  };
  bad(file, "TOO_LARGE", { fs: lying });
  // limits are overridable
  bad(makePng({ width: 10, height: 10 }), "DIMENSIONS", { limits: { maxDimension: 5 } });
});

test("files: directories, missing paths and non-regular files are refused; a user-named symlink is resolved", (t) => {
  const dir = tempDir("aw-img-file-");
  mkdirSync(join(dir, "folder"));
  assert.equal(readImageFile(join(dir, "folder")).problems[0].code, "NOT_REGULAR");
  assert.equal(readImageFile(join(dir, "missing.png")).problems[0].code, "NOT_FOUND");
  assert.equal(readImageFile("").problems[0].code, "INVALID_PATH");
  assert.equal(readImageFile("a\0b.png").problems[0].code, "INVALID_PATH");
  writeFileSync(join(dir, "empty.png"), "");
  assert.equal(readImageFile(join(dir, "empty.png")).problems[0].code, "EMPTY");
  const fifoLike = { ...nodeFs, lstatSync: (p) => ({ isFile: () => false, isSymbolicLink: () => false, size: 5 }) };
  assert.equal(readImageFile(join(dir, "x"), { fs: fifoLike }).problems[0].code, "NOT_REGULAR");
  // opened descriptor is not a regular file (swapped after lstat)
  writeFileSync(join(dir, "swap.png"), makePng());
  const swapped = { ...nodeFs, fstatSync: () => ({ isFile: () => false, size: 5 }) };
  assert.equal(readImageFile(join(dir, "swap.png"), { fs: swapped }).problems[0].code, "NOT_REGULAR");

  writeFileSync(join(dir, "target.png"), makePng());
  try {
    symlinkSync(join(dir, "target.png"), join(dir, "link.png"));
  } catch {
    t.diagnostic("symlinks are not available here; the resolved-path case is skipped");
    return;
  }
  const read = readImageFile(join(dir, "link.png"));
  assert.equal(read.ok, true);
  assert.equal(read.source.viaSymlink, true);
  assert.match(read.source.resolved, /target\.png$/);
  assert.equal(read.source.name, "link.png");
  const dangling = join(dir, "dangling.png");
  symlinkSync(join(dir, "nowhere.png"), dangling);
  assert.equal(readImageFile(dangling).ok, false);
});

test("file names are sanitized and never carry control sequences", () => {
  const result = ok(makePng(), { name: "\u001b]0;pwned\u0007evil\nname-with-a-very-long-tail-".padEnd(200, "x") });
  assert.doesNotMatch(result.image.name, /[\u001b\u0007\n]/);
  assert.ok(result.image.name.length <= 80);
});

test("trailing data after the end marker is STRIPPED and reported (polyglot defence)", () => {
  const zip = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), Buffer.from("payload-after-image")]);
  for (const [name, make] of [["png", makePng], ["jpeg", makeJpeg], ["webp", makeWebp]]) {
    const clean = make();
    const result = ok(make({ trailing: zip }));
    assert.ok(result.image.dropped.includes("trailing-data"), name);
    assert.equal(has(result.bytes, "payload-after-image"), false, name);
    assert.deepEqual(result.bytes, ok(clean).bytes, `${name}: same stripped bytes as the clean image`);
    assert.equal(result.image.originalBytes, clean.length + zip.length);
  }
});

test("PNG: text, time, exif and icc chunks are dropped; only the allowlisted chunks are kept", () => {
  const source = makePng({
    before: [
      ["gAMA", Buffer.from([0, 1, 0x86, 0xa0])], ["sRGB", Buffer.from([0])], ["cHRM", Buffer.alloc(32, 1)], ["iCCP", Buffer.from("icc\0\0data")], ["tRNS", Buffer.alloc(6, 1)],
      ["tEXt", Buffer.from("Author\0secret-author")], ["iTXt", Buffer.from("XML:com.adobe.xmp\0\0\0\0\0secret-xmp")], ["zTXt", Buffer.from("Comment\0\0xx")],
      ["tIME", Buffer.alloc(7, 2)], ["eXIf", Buffer.from(`MM\0*${EXIF_GPS_TEXT}`)], ["prIv", Buffer.from("private-ancillary")],
    ],
  });
  const result = ok(source);
  assert.deepEqual(result.image.dropped, ["exif", "icc", "other-ancillary", "text", "time"]);
  for (const secret of ["secret-author", "secret-xmp", "GPSLatitude", "private-ancillary", "tEXt", "iTXt", "zTXt", "tIME", "eXIf"]) assert.equal(has(result.bytes, secret), false, secret);
  for (const kept of ["IHDR", "gAMA", "sRGB", "cHRM", "tRNS", "IDAT", "IEND"]) assert.equal(has(result.bytes, kept), true, kept);
  assert.equal(has(result.bytes, "iCCP"), false, "iCCP can carry text and is dropped");
  assert.ok(result.bytes.length < source.length);
  assert.equal(parseImage(result.bytes).ok, true);
});

test("JPEG: GPS EXIF, XMP, ICC, comments, IPTC and foreign APPn are dropped; a minimal JFIF and Adobe APP14 are kept", () => {
  const source = makeJpeg({
    segments: [[0xe1, exifPayload()], [0xe1, xmpPayload()], [0xe2, iccPayload()], [0xe2, Buffer.from("MPF\0multi-picture")], [0xed, Buffer.from("Photoshop 3.0\0iptc-secret")], [0xfe, Buffer.from("a comment with secret-comment")], [0xe5, Buffer.from("odd-app")], [0xee, Buffer.from("Adobe\0\x64\0\0\0\0\x01")]],
  });
  const result = ok(source);
  assert.deepEqual(result.image.dropped, ["app-other", "app2-other", "comment", "exif", "icc", "iptc", "xmp"]);
  for (const secret of [EXIF_GPS_TEXT, "GPSLatitude", "Exif", "secret-xmp-author", "iptc-secret", "secret-comment", "multi-picture", "odd-app"]) assert.equal(has(result.bytes, secret), false, secret);
  for (const kept of ["JFIF", "Adobe"]) assert.equal(has(result.bytes, kept), true, kept);
  for (const gone of ["ICC_PROFILE", "profile-bytes"]) assert.equal(has(result.bytes, gone), false, gone);
  assert.deepEqual([...result.bytes.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...result.bytes.subarray(-2)], [0xff, 0xd9]);
  assert.ok(has(result.bytes, "\x12\xff\x00\x34\xff\xd0\x56\x78"), "entropy-coded data is copied untouched, stuffing and RST included");
  assert.equal(parseImage(result.bytes).ok, true);
});

test("WebP: EXIF, XMP and ICCP chunks are dropped, the RIFF size and the VP8X flags are fixed", () => {
  const source = makeWebp({ kind: "extended", exif: true, xmp: true, icc: true });
  const flags = (buf) => buf[20];
  assert.equal(flags(source) & 0x0c, 0x0c);
  const result = ok(source);
  assert.deepEqual(result.image.dropped, ["exif", "icc", "xmp"]);
  assert.equal(flags(result.bytes) & 0x2c, 0, "EXIF, XMP and ICC flags cleared");
  assert.equal(result.bytes.readUInt32LE(4), result.bytes.length - 8);
  for (const secret of ["GPSLatitude", "secret-xmp-author", "EXIF", "XMP "]) assert.equal(has(result.bytes, secret), false, secret);
  assert.equal(has(result.bytes, "ICCP"), false);
  assert.equal(parseImage(result.bytes).ok, true);
  assert.equal(parseImage(result.bytes).width, 11);
});

test("stripping is idempotent and a clean image reports nothing dropped", () => {
  for (const make of [makePng, makeJpeg, makeWebp]) {
    const first = ok(make());
    assert.deepEqual(first.image.dropped, []);
    assert.equal(first.image.metadataStripped, true);
    assert.deepEqual(ok(first.bytes).bytes, first.bytes);
    assert.equal(first.image.sha256, ok(first.bytes).image.sha256);
  }
});

test("problem messages never contain image bytes", () => {
  const secret = "SECRET-PIXELS-1234567890";
  const hostile = Buffer.concat([makePng({ width: 9000, height: 9000 }), Buffer.from(secret)]);
  const result = bad(hostile, "DIMENSIONS");
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(bad(Buffer.from(secret), "UNSUPPORTED_FORMAT")).includes(secret), false);
});
