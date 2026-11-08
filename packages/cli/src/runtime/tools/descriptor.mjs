// MCP server descriptor hash. An approval binds this hash, so anything that changes WHAT would run, or WHAT the
// server offers, makes the approval stale:
//
//   sha256( canonical JSON of { transport, command, args, cwd, envRefs ({KEY: credential reference NAME}; NEVER a value),
//                               url (userinfo and query values removed), tools: [{name, description: sha256, schema: sha256(inputSchema)}] } )
//
// Swapping the credential a key points at (`${cred:A}` -> `${cred:B}`) or rewriting a tool description (a "rug pull") changes the hash.
//
// The canonical form sorts keys, rejects anything that is not plain JSON, and is BOUNDED (depth, node count,
// size): a hostile server's inputSchema can never crash or stall the process. The tool list is sorted by name.

import { createHash } from "node:crypto";
import { stringifyJson } from "../../json.mjs";

export const DESCRIPTOR_VERSION = 2;
const CRED_REF = /^\$\{cred:([A-Za-z_][A-Za-z0-9_]{0,63})\}$/;

// upper case only, exactly what `mcp add` accepts (one rule for add, validate and the descriptor)
const VAR_REF = /^\$\{([A-Z_][A-Z0-9_]{0,63})\}$/;

/**
 * An env value that is a REFERENCE, never a literal: `${cred:NAME}` (Asterweave's) or `${NAME}` (Claude Code expands it from its
 * environment; UNVERIFIED here). A default (`${NAME:-x}`) is not a reference: it could carry a literal.
 * @returns {{kind: "cred"|"var", name: string} | null}
 */
export function envReference(value) {
  if (typeof value !== "string") return null;
  const cred = CRED_REF.exec(value);
  if (cred) return { kind: "cred", name: cred[1] };
  const variable = VAR_REF.exec(value);
  return variable ? { kind: "var", name: variable[1] } : null;
}

/** The variable name a reference (either form) points at, or null for anything else. */
export function credentialRef(value) {
  return envReference(value)?.name ?? null;
}
const MAX_DEPTH = 24;
const MAX_NODES = 20_000;
const MAX_CHARS = 512 * 1024;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export class DescriptorError extends Error {
  constructor(message) {
    super(message);
    this.name = "DescriptorError";
    this.code = "DESCRIPTOR_INVALID";
  }
}

/** Canonical JSON with sorted keys; throws DescriptorError beyond the bounds or for non-JSON values. */
export function boundedCanonicalJson(value) {
  const state = { nodes: 0, chars: 0 };
  const visit = (node, depth) => {
    if (depth > MAX_DEPTH) throw new DescriptorError("value nested too deeply to hash");
    if (++state.nodes > MAX_NODES) throw new DescriptorError("value too large to hash");
    let text;
    if (node === null || typeof node === "boolean") text = String(node);
    else if (typeof node === "number") {
      if (!Number.isFinite(node)) throw new DescriptorError("non-finite number");
      text = stringifyJson(node);
    } else if (typeof node === "string") text = stringifyJson(node);
    else if (Array.isArray(node)) text = `[${node.map((item) => visit(item === undefined ? null : item, depth + 1)).join(",")}]`;
    else if (typeof node === "object") {
      const keys = Object.keys(node).filter((key) => node[key] !== undefined).sort();
      text = `{${keys.map((key) => `${stringifyJson(key)}:${visit(node[key], depth + 1)}`).join(",")}}`;
    } else throw new DescriptorError("value is not plain JSON");
    state.chars += text.length;
    if (state.chars > MAX_CHARS * 4) throw new DescriptorError("value too large to hash");
    return text;
  };
  const out = visit(value, 0);
  if (out.length > MAX_CHARS) throw new DescriptorError("value too large to hash");
  return out;
}

/** sha256 of the canonical JSON of one tool input schema. */
export function schemaHash(schema) {
  return sha256(boundedCanonicalJson(schema ?? {}));
}

function urlForHash(value) {
  if (typeof value !== "string" || value === "") return null;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, "");
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function refMarker(value) {
  const ref = envReference(value);
  return ref === null ? "[literal]" : ref.kind === "cred" ? ref.name : `env:${ref.name}`;
}

/**
 * The canonical descriptor of a server definition plus (optionally) its advertised tool list.
 * @param {{transport?: string, command?: string, args?: string[], cwd?: string, env?: Record<string, unknown>, url?: string}} definition
 * @param {Array<{name: string, inputSchema?: unknown}> | null} [tools]  null = not listed yet.
 */
export function descriptorOf(definition, tools = null) {
  const def = definition ?? {};
  return {
    v: DESCRIPTOR_VERSION,
    transport: typeof def.transport === "string" ? def.transport : "stdio",
    command: typeof def.command === "string" ? def.command : null,
    args: Array.isArray(def.args) ? def.args.map((arg) => String(arg)) : [],
    cwd: typeof def.cwd === "string" ? def.cwd : null,
    // reference NAMES only; a literal value is hashed as a marker (it is never passed to a server anyway)
    // `${cred:NAME}` hashes as NAME (unchanged since descriptor v2, so existing approvals stay valid); `${NAME}` as env:NAME
    envRefs: def.env && typeof def.env === "object" ? Object.fromEntries(Object.keys(def.env).sort().map((key) => [key, refMarker(def.env[key])])) : {},
    url: urlForHash(def.url),
    tools: tools === null ? null : tools.map((tool) => ({ name: String(tool.name), description: sha256(String(tool.description ?? "")), schema: schemaHash(tool.inputSchema) })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/**
 * The descriptor hash. Without a tool list (`null`) it covers the definition only (used before the first listing);
 * an approval records the hash that INCLUDES the list it saw, so a later change of either side is stale.
 */
export function descriptorHash(definition, tools = null) {
  return sha256(boundedCanonicalJson(descriptorOf(definition, tools)));
}
