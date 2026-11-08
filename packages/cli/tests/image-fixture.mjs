// Synthetic, structurally valid PNG / JPEG / WebP generators for tests. Header-level only: the pixel data is not a real picture
// (the code under test never decodes it). Nothing is read from disk; nothing is a real photo.

import { deflateSync } from "node:zlib";

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u16be = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };

export function pngChunk(type, data = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32be(data.length), body, u32be(crc32(body))]);
}

/** @param {{width?: number, height?: number, before?: [string, Buffer][], after?: [string, Buffer][], trailing?: Buffer}} o */
export function makePng({ width = 3, height = 5, before = [], after = [], trailing } = {}) {
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  const rows = Math.min(height, 8) * (1 + 3 * Math.min(width, 8));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    ...before.map(([type, data]) => pngChunk(type, data)),
    pngChunk("IDAT", deflateSync(Buffer.alloc(rows))),
    ...after.map(([type, data]) => pngChunk(type, data)),
    pngChunk("IEND"),
    ...(trailing ? [trailing] : []),
  ]);
}

const seg = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker]), u16be(payload.length + 2), payload]);
export const EXIF_GPS_TEXT = "GPSLatitude=51.5007N GPSLongitude=0.1246W";
export const exifPayload = () => Buffer.concat([Buffer.from("Exif\0\0", "latin1"), Buffer.from("MM\0*\0\0\0\b", "latin1"), Buffer.from(EXIF_GPS_TEXT, "latin1")]);
export const xmpPayload = () => Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>secret-xmp-author</x:xmpmeta>", "latin1");
export const iccPayload = () => Buffer.concat([Buffer.from("ICC_PROFILE\0\x01\x01", "latin1"), Buffer.from("profile-bytes")]);

/** @param {{width?: number, height?: number, segments?: [number, Buffer][], trailing?: Buffer, sof?: number}} o  `segments` go after JFIF. */
export function makeJpeg({ width = 7, height = 9, segments = [], trailing, sof = 0xc0 } = {}) {
  const jfif = seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
  const dqt = seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)]));
  const frame = seg(sof, Buffer.concat([Buffer.from([8]), u16be(height), u16be(width), Buffer.from([1, 1, 0x11, 0])]));
  const dht = seg(0xc4, Buffer.concat([Buffer.from([0]), Buffer.alloc(16, 0)]));
  const sos = seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0]));
  const entropy = Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0x78]); // byte stuffing and an RST marker
  return Buffer.concat([Buffer.from([0xff, 0xd8]), jfif, ...segments.map(([marker, payload]) => seg(marker, payload)), dqt, frame, dht, sos, entropy, Buffer.from([0xff, 0xd9]), ...(trailing ? [trailing] : [])]);
}

const riffChunk = (fourcc, data) => Buffer.concat([Buffer.from(fourcc, "latin1"), u32le(data.length), data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
const u24le = (n) => Buffer.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff]);

/** @param {{kind?: 'lossy'|'lossless'|'extended', width?: number, height?: number, exif?: boolean, xmp?: boolean, icc?: boolean, trailing?: Buffer}} o */
export function makeWebp({ kind = "lossy", width = 11, height = 13, exif = false, xmp = false, icc = false, trailing } = {}) {
  const lossy = Buffer.concat([Buffer.from([0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]), Buffer.from([width & 0xff, (width >> 8) & 0x3f, height & 0xff, (height >> 8) & 0x3f]), Buffer.alloc(7, 5)]);
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  const lossless = Buffer.concat([Buffer.from([0x2f]), u32le(bits), Buffer.alloc(6, 3)]);
  const chunks = [];
  if (kind === "extended") {
    const flags = (icc ? 0x20 : 0) | (exif ? 0x08 : 0) | (xmp ? 0x04 : 0);
    chunks.push(riffChunk("VP8X", Buffer.concat([Buffer.from([flags, 0, 0, 0]), u24le(width - 1), u24le(height - 1)])));
    if (icc) chunks.push(riffChunk("ICCP", Buffer.from("icc-profile-data")));
    chunks.push(riffChunk("VP8 ", lossy));
    if (exif) chunks.push(riffChunk("EXIF", Buffer.from(`Exif\0\0${EXIF_GPS_TEXT}`, "latin1")));
    if (xmp) chunks.push(riffChunk("XMP ", Buffer.from("<x:xmpmeta>secret-xmp-author</x:xmpmeta>")));
  } else chunks.push(riffChunk(kind === "lossless" ? "VP8L" : "VP8 ", kind === "lossless" ? lossless : lossy));
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), ...chunks]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), u32le(body.length), body, ...(trailing ? [trailing] : [])]);
}
