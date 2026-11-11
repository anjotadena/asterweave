// Redaction and bounding of text BEFORE it reaches the memory database.
//
// Everything stored goes through here first (event content, titles, checkpoint fields, item content). The base rules are
// src/redact.mjs (tokens, keys, connection strings, URL credentials, private keys, email masking); this file adds a few
// shapes seen in transcripts that the shared list does not cover. Redaction runs on the FULL text and truncation runs after,
// never before: cutting first could split a token below a pattern's minimum length and leave its prefix behind.

import { redactText } from "../../redact.mjs";

/** Raw input larger than this is cut (at a token boundary) before redaction so a hostile 1 GiB string cannot stall the regexes. */
export const RAW_INPUT_CAP = 2 * 1024 * 1024;

const EXTRA = [
  [/(?<![A-Za-z0-9_-])ya29\.[A-Za-z0-9_-]{20,}/g, "ya29.…"],
  [/(?<![A-Za-z0-9_])(whsec_)[A-Za-z0-9]{16,}/g, "$1…"],
  [/https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/gi, "https://hooks.slack.com/services/[redacted]"],
  [/(\bAuthorization\s*:\s*)[^\r\n]+/gi, "$1[redacted]"],
  [/(\b(?:Set-)?Cookie\s*:\s*)[^\r\n]+/gi, "$1[redacted]"],
];

// Control characters other than tab, newline and carriage return carry no meaning in a transcript and can hide text.
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

/**
 * Redact one string. Non-strings and empty values become "".
 * @param {unknown} value
 * @returns {{text: string, count: number, rawChars: number}}
 */
export function redactForMemory(value) {
  let text = typeof value === "string" ? value : value == null ? "" : String(value);
  const rawChars = text.length;
  if (text.length > RAW_INPUT_CAP) {
    text = text.slice(0, RAW_INPUT_CAP);
    const lastBreak = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\t"));
    if (lastBreak > RAW_INPUT_CAP / 2) text = text.slice(0, lastBreak); // never keep half a token
  }
  text = text.replace(CONTROLS, "");
  let count = 0;
  const base = redactText(text);
  text = base.text;
  count += base.count;
  for (const [pattern, replacement] of EXTRA) {
    text = text.replace(pattern, (...match) => {
      count += 1;
      return replacement.replace(/\$(\d)/g, (_, group) => match[Number(group)] ?? "");
    });
  }
  return { text, count, rawChars };
}

/**
 * Cut `text` to at most `max` characters (never in the middle of a surrogate pair) and say so in the text itself.
 * @returns {{text: string, truncated: boolean, originalChars: number}}
 */
export function boundText(text, max) {
  if (text.length <= max) return { text, truncated: false, originalChars: text.length };
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: `${text.slice(0, end)}\n[truncated: ${text.length - end} more characters not stored]`, truncated: true, originalChars: text.length };
}

/** Redact then bound a short free-text field (title, checkpoint field); `null` for an empty result. */
export function cleanField(value, max = 2000) {
  const { text } = redactForMemory(value);
  const trimmed = text.trim();
  return trimmed === "" ? null : boundText(trimmed, max).text;
}
