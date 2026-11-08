// Key-level diff of JSON configuration files, for verifying what `claude mcp|plugin ...` actually changed. Pure; no I/O.
//
// A file is split into UNITS: every entry of a declared "collection" (`mcpServers`, `enabledPlugins`: one unit per server or plugin,
// named `collection.entry`) and every other top-level key (one unit named after the key). The diff lists units that were added,
// removed or changed, never their values: callers decide whether that set is exactly the intended change. A file that is not
// valid JSON is one opaque unit (its digest), so a change to it is never silently "no change". Parsing is null-prototype safe
// (units live in a Map; a `__proto__` key is just another key).

import { createHash } from "node:crypto";
import { stringifyJson } from "../../json.mjs";
import { boundedCanonicalJson } from "../tools/descriptor.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (text) => createHash("sha256").update(text).digest("hex");

function canonical(value) {
  try {
    return boundedCanonicalJson(value);
  } catch {
    return `unhashable:${sha(stringifyJson(value) ?? "null")}`;
  }
}

/**
 * @param {string|null} text  File content; null = the file does not exist.
 * @param {{collections?: string[], only?: string[]|null}} [options]  `only`: keep just these top-level keys (a file Claude Code also
 *   uses for its own bookkeeping, such as ~/.claude.json, is judged on the subtree Asterweave asked for).
 * @returns {{state: "missing"|"ok"|"invalid", units: Map<string, string>, values: Map<string, unknown>}}
 */
export function parseUnits(text, { collections = [], only = null } = {}) {
  const units = new Map();
  const values = new Map();
  if (text === null || text === undefined) return { state: "missing", units, values };
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body.trim() === "") return { state: "ok", units, values };
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    units.set("<unparseable>", sha(text));
    return { state: "invalid", units, values };
  }
  const put = (name, value) => { units.set(name, canonical(value)); values.set(name, value); };
  if (!isObject(data)) {
    put("<root>", data);
    return { state: "ok", units, values };
  }
  for (const key of Object.keys(data)) {
    if (only !== null && !only.includes(key)) continue;
    if (collections.includes(key) && isObject(data[key])) {
      for (const entry of Object.keys(data[key])) put(`${key}.${entry}`, data[key][entry]);
    } else put(key, data[key]);
  }
  return { state: "ok", units, values };
}

/** Units that differ between two parsed files. @returns {{unit: string, op: "added"|"removed"|"changed"}[]} sorted by unit */
export function diffUnits(before, after) {
  const out = [];
  for (const [unit, value] of after.units) {
    if (!before.units.has(unit)) out.push({ unit, op: "added" });
    else if (before.units.get(unit) !== value) out.push({ unit, op: "changed" });
  }
  for (const unit of before.units.keys()) if (!after.units.has(unit)) out.push({ unit, op: "removed" });
  return out.sort((a, b) => (a.unit < b.unit ? -1 : a.unit > b.unit ? 1 : 0));
}

const sameJson = (a, b) => canonical(a) === canonical(b);
const stringMap = (value) => isObject(value) && Object.values(value).every((item) => typeof item === "string");

/**
 * Whether a server entry written by `claude mcp add` is the one that was requested (UNVERIFIED shape: `type` may be absent,
 * `args`/`env`/`headers` may be absent or empty; any other key is a mismatch).
 * @param {unknown} entry
 * @param {{transport: "stdio"|"http"|"sse", command?: string, args?: string[], env?: Record<string,string>, url?: string, headers?: Record<string,string>}} want
 * @returns {string[]} problems (names only, never values); empty = a match
 */
export function serverEntryProblems(entry, want) {
  if (!isObject(entry)) return ["the new entry is not an object"];
  const problems = [];
  const keys = Object.keys(entry);
  const type = typeof entry.type === "string" ? entry.type : typeof entry.command === "string" ? "stdio" : null;
  if (type !== want.transport) problems.push("the transport differs from the request");
  if (want.transport === "stdio") {
    for (const key of keys) if (!["type", "command", "args", "env"].includes(key)) problems.push(`the entry has an unexpected key '${key.slice(0, 40)}'`);
    if (entry.command !== want.command) problems.push("the command differs from the request");
    if (!sameJson(entry.args ?? [], want.args ?? [])) problems.push("the arguments differ from the request");
    if (!stringMap(entry.env ?? {}) || !sameJson(entry.env ?? {}, want.env ?? {})) problems.push("the environment entries differ from the request");
  } else {
    for (const key of keys) if (!["type", "url", "headers"].includes(key)) problems.push(`the entry has an unexpected key '${key.slice(0, 40)}'`);
    let same = false;
    try { same = typeof entry.url === "string" && new URL(entry.url).href === new URL(want.url).href; } catch { same = false; }
    if (!same) problems.push("the url differs from the request");
    if (!stringMap(entry.headers ?? {}) || !sameJson(entry.headers ?? {}, want.headers ?? {})) problems.push("the headers differ from the request");
  }
  return problems;
}
