// JPEG structure walk and metadata stripping (allowlist). See image-format.mjs for the rules.
//
// Kept: SOI, DQT, DHT, DAC (arithmetic coding only), DRI, ONE non-hierarchical SOFn, SOS with its entropy-coded data, EOI, a MINIMAL
// JFIF APP0 (rewritten: no thumbnail) and a NORMALISED Adobe APP14 (only the colour transform byte, which decoders need). Kept
// structures carry only decodable fields with the exact sizes and value ranges their type allows; the pixel (entropy-coded) data and
// the table values themselves are not inspected, so a covert channel inside them is NOT removed. Dropped: every other marker (APP1
// EXIF/XMP, APP2 including ICC profiles, APP13, COM, JPGn, DNL, unknown). TEM and RST markers outside entropy-coded data, a second
// frame header and hierarchical frame headers are refused. Memory does not grow with dropped or skipped bytes.

import { ascii, fail, MAX_STRUCTURES } from "./image-util.mjs";

const SOF_OK = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc9, 0xca, 0xcb]);
const isSofByte = (marker) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
const MINIMAL_JFIF = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

function validDqt(buf, from, to) {
  let p = from;
  while (p < to) {
    const precision = buf[p] >> 4;
    if (precision > 1 || (buf[p] & 15) > 3) return false;
    p += 1 + 64 * (precision + 1);
  }
  return to > from && p === to;
}

function validDht(buf, from, to) {
  let p = from;
  while (p < to) {
    if (p + 17 > to || buf[p] >> 4 > 1 || (buf[p] & 15) > 3) return false;
    let sum = 0;
    for (let i = 1; i <= 16; i += 1) sum += buf[p + i];
    if (sum > 256) return false;
    p += 17 + sum;
  }
  return to > from && p === to;
}

/** DAC: (Tc/Tb, value) pairs; DC conditioning needs L <= U, AC needs Kx in 1..63; each table at most once. */
function validDac(buf, from, to, seen) {
  if (to === from || (to - from) % 2 !== 0) return false;
  for (let p = from; p < to; p += 2) {
    const tc = buf[p] >> 4;
    const tb = buf[p] & 15;
    const value = buf[p + 1];
    if (tc > 1 || tb > 3 || seen.has(tc * 4 + tb)) return false;
    seen.add(tc * 4 + tb);
    if (tc === 0 ? (value & 15) > value >> 4 : value < 1 || value > 63) return false;
  }
  return true;
}

function classifyApp1(buf, dataStart) {
  const head = ascii(buf, dataStart, dataStart + 36);
  if (head.startsWith("Exif\0")) return "exif";
  if (head.startsWith("http://ns.adobe.com/xap/1.0/") || head.startsWith("http://ns.adobe.com/xmp/extension/")) return "xmp";
  return "app1-other";
}

function dropKind(marker, buf, dataStart, size) {
  if (marker === 0xe1) return classifyApp1(buf, dataStart);
  if (marker === 0xe2) return ascii(buf, dataStart, dataStart + 12) === "ICC_PROFILE\0" && size >= 14 ? "icc" : "app2-other";
  if (marker === 0xed) return "iptc";
  if (marker === 0xfe) return "comment";
  if (marker === 0xe0) return "app0-other";
  if (marker >= 0xe3 && marker <= 0xef) return "app-other";
  if (marker >= 0xf0 && marker <= 0xfd) return "jpgn";
  return "other-marker";
}

export function walkJpeg(buf) {
  const items = [];
  const dropped = new Set();
  let pos = 2;
  let count = 0;
  let sof = null;
  let scans = 0;
  let sawJfif = false;
  let sawAdobe = false;
  let sofMarker = 0;
  const dacSeen = new Set();
  for (;;) {
    if (pos >= buf.length) return fail("TRUNCATED", "the JPEG ends before its EOI marker");
    if (buf[pos] !== 0xff) return fail("INVALID", "the JPEG has a malformed marker");
    while (pos < buf.length && buf[pos] === 0xff) pos += 1; // fill bytes
    if (pos >= buf.length) return fail("TRUNCATED", "the JPEG ends before its EOI marker");
    const marker = buf[pos];
    pos += 1;
    const start = pos - 2;
    count += 1;
    if (count > MAX_STRUCTURES) return fail("INVALID", "the JPEG has too many segments");
    if (marker === 0xd9) {
      items.push({ kind: "keep", start, end: pos });
      break;
    }
    if (marker === 0x00 || marker === 0x01 || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) return fail("INVALID", "the JPEG has a marker that is not allowed outside image data");
    if (pos + 2 > buf.length) return fail("TRUNCATED", "the JPEG is truncated inside a segment");
    const length = buf.readUInt16BE(pos);
    if (length < 2) return fail("INVALID", "the JPEG has a malformed segment length");
    const end = pos + length;
    if (end > buf.length) return fail("TRUNCATED", "the JPEG is truncated inside a segment");
    const dataStart = pos + 2;
    const size = length - 2;
    let keep = null;
    if (isSofByte(marker)) {
      if (!SOF_OK.has(marker)) return fail("INVALID", "the JPEG uses a hierarchical frame header, which is not accepted");
      if (sof !== null) return fail("INVALID", "the JPEG has more than one frame header");
      if (size < 9 || buf[dataStart + 5] < 1 || size !== 6 + 3 * buf[dataStart + 5]) return fail("INVALID", "the JPEG frame header has an invalid size");
      sof = { height: buf.readUInt16BE(dataStart + 1), width: buf.readUInt16BE(dataStart + 3) };
      sofMarker = marker;
      keep = "keep";
    } else if (marker === 0xc4) {
      if (!validDht(buf, dataStart, end)) return fail("INVALID", "the JPEG has a malformed Huffman table");
      keep = "keep";
    } else if (marker === 0xdb) {
      if (!validDqt(buf, dataStart, end)) return fail("INVALID", "the JPEG has a malformed quantisation table");
      keep = "keep";
    } else if (marker === 0xdd) {
      if (size !== 2) return fail("INVALID", "the JPEG has a malformed restart interval");
      keep = "keep";
    } else if (marker === 0xcc) {
      if (!validDac(buf, dataStart, end, dacSeen)) return fail("INVALID", "the JPEG has a malformed arithmetic conditioning segment");
      keep = "keep";
    } else if (marker === 0xda) {
      if (sof === null) return fail("INVALID", "the JPEG has image data before its frame header");
      const components = buf[dataStart];
      if (components < 1 || components > 4 || size !== 4 + 2 * components) return fail("INVALID", "the JPEG scan header has an invalid size");
      keep = "keep";
    } else if (marker === 0xe0 && !sawJfif && size >= 14 && ascii(buf, dataStart, dataStart + 5) === "JFIF\0") {
      sawJfif = true;
      keep = "jfif";
      if (size > 14 || buf[dataStart + 12] !== 0 || buf[dataStart + 13] !== 0) dropped.add("thumbnail");
    } else if (marker === 0xee && !sawAdobe && size >= 12 && ascii(buf, dataStart, dataStart + 5) === "Adobe" && buf[dataStart + 11] <= 2) {
      sawAdobe = true;
      keep = "adobe";
      if (size > 12) dropped.add("app14-extra");
    } else dropped.add(dropKind(marker, buf, dataStart, size));
    if (keep !== null) items.push({ kind: keep, start, end, dataStart });
    pos = end;
    if (marker === 0xda) {
      const scanStart = pos;
      while (pos + 1 < buf.length) {
        if (buf[pos] === 0xff) {
          const next = buf[pos + 1];
          if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) {
            pos += 2;
            continue;
          }
          if (next === 0xff) {
            pos += 1;
            continue;
          }
          break;
        }
        pos += 1;
      }
      if (pos + 1 >= buf.length) return fail("TRUNCATED", "the JPEG ends inside its image data");
      items.push({ kind: "scan", start: scanStart, end: pos });
      scans += 1;
    }
  }
  if (sof === null || scans === 0) return fail("INVALID", "the JPEG has no frame header or no image data");
  if (dacSeen.size > 0 && ![0xc9, 0xca, 0xcb].includes(sofMarker)) return fail("INVALID", "the JPEG has arithmetic conditioning but does not use arithmetic coding");
  return { ok: true, format: "jpeg", width: sof.width, height: sof.height, end: pos, items, dropped };
}

export function stripJpeg(buf, walk) {
  const parts = [buf.subarray(0, 2)];
  for (const item of walk.items) {
    if (item.kind === "jfif") parts.push(MINIMAL_JFIF);
    else if (item.kind === "adobe") parts.push(Buffer.from([0xff, 0xee, 0x00, 0x0e, 0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, buf[item.dataStart + 11]]));
    else parts.push(buf.subarray(item.start, item.end));
  }
  return { bytes: Buffer.concat(parts), dropped: walk.dropped };
}
