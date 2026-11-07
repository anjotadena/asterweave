// The one JSON writer for everything that reaches a stream (stdout results and the --json error
// envelope). JSON.stringify escapes only the C0 controls; it passes C1 controls (U+007F-U+009F),
// bidirectional controls and the U+2028/U+2029 line separators through raw. A consumer that prints or
// pipes that output into a terminal or a log viewer would then interpret them (for example U+009B is an
// 8-bit CSI, U+202E reverses the displayed text), so they are written as \uXXXX escapes. The result is
// still plain JSON: it parses back to exactly the same value.
//
// The escape runs on the serialised text. Those code points can only occur inside JSON strings (object
// keys included) because the structural characters are all ASCII, so a text-level replace is exact.

const UNSAFE_IN_JSON = /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const escapeCodePoint = (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`;

/**
 * `JSON.stringify` whose output never contains a raw C1 / bidi / line-separator code point.
 * @param {unknown} value
 * @param {number | string} [space]
 * @returns {string}
 */
export function stringifyJson(value, space) {
  const text = JSON.stringify(value, null, space);
  return typeof text === "string" ? text.replace(UNSAFE_IN_JSON, escapeCodePoint) : text;
}
