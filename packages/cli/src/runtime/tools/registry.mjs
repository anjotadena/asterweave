// Typed capability registry. A capability is a tool the run loop may offer at some graph stages:
//
//   register({ id, kind: "builtin"|"api"|"mcp", description, inputSchema, stages: [node ids], readOnly,
//              limits: {timeoutMs, maxBytes, maxLines, maxItems}, run(input, ctx),
//              capability?, retry?: {attempts, baseMs, maxMs}, request?(input) -> {method, url}, origin?: {server, tool} })
//
// - `capability` is the canonical name of what the tool does (default: its id). A capability can be registered only
//   ONCE, whatever route (builtin, api, mcp) provides it: an MCP tool can never shadow or duplicate a builtin.
// - `forStage(node)` returns ONLY the small list of tools scoped to that stage (at most STAGE_TOOL_LIMIT).
// - `invoke(id, input, ctx)` validates the input against the schema, applies the timeout, retries transient errors of
//   read-only tools with bounded, jittered backoff, bounds the output (bounds.mjs) and returns an UNTRUSTED envelope:
//   { ok, trust: "untrusted", source, content }. The envelope is data. Nothing in it is ever merged into instructions,
//   and it cannot register a tool, trigger a call or change an approval (the registry only changes through register()).
// - Errors never echo a raw value: messages are authored by this code, sanitized, redacted and capped.
//
// ctx for invoke: { node?, signal?, artifactDir?, fs?, sleep?(ms, signal), random?() }.

import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { check } from "../schema.mjs";
import { boundOutput, DEFAULT_LIMITS, HARD_LIMITS } from "./bounds.mjs";
import { boundedCanonicalJson } from "./descriptor.mjs";

export const TOOL_KINDS = Object.freeze(["builtin", "api", "mcp"]);
export const STAGE_TOOL_LIMIT = 16;
export const MAX_RETRY_ATTEMPTS = 4;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/;
const STAGE = /^[a-z][a-z0-9-]{0,39}$/;
const DESCRIPTION_LIMIT = 1000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const safeText = (value, length = 300) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, length);

/** A tool failure with a stable code. `transient` marks errors a read-only tool may retry. */
export class ToolError extends Error {
  /** @param {string} code @param {string} message @param {{transient?: boolean, retryAfterMs?: number}} [options] */
  constructor(code, message, { transient = false, retryAfterMs } = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.transient = transient === true;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** The registry rejected a registration (programming error, not a run-time condition). */
export class RegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RegistryError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new RegistryError(code, message);
}

function normalizeLimits(raw) {
  const limits = { ...DEFAULT_LIMITS };
  if (raw === undefined) return limits;
  if (!isObject(raw)) fail("REGISTRY_LIMITS_INVALID", "limits must be an object");
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.hasOwn(DEFAULT_LIMITS, key)) fail("REGISTRY_LIMITS_INVALID", `limits.${safeText(key, 40)} is not a known limit`);
    if (!Number.isInteger(value) || value < 1 || value > HARD_LIMITS[key]) fail("REGISTRY_LIMITS_INVALID", `limits.${key} must be an integer from 1 to ${HARD_LIMITS[key]}`);
    limits[key] = value;
  }
  return limits;
}

function normalizeRetry(raw, readOnly) {
  if (raw === undefined) return null;
  if (!readOnly) fail("REGISTRY_RETRY_FORBIDDEN", "only read-only tools may declare a retry policy");
  if (!isObject(raw)) fail("REGISTRY_RETRY_INVALID", "retry must be an object");
  const { attempts = 3, baseMs = 200, maxMs = 5000 } = raw;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_RETRY_ATTEMPTS) fail("REGISTRY_RETRY_INVALID", `retry.attempts must be an integer from 1 to ${MAX_RETRY_ATTEMPTS}`);
  if (!Number.isInteger(baseMs) || baseMs < 0 || baseMs > 60_000 || !Number.isInteger(maxMs) || maxMs < baseMs || maxMs > 60_000) fail("REGISTRY_RETRY_INVALID", "retry.baseMs and retry.maxMs must be integers up to 60000 with baseMs <= maxMs");
  return Object.freeze({ attempts, baseMs, maxMs });
}

/**
 * A server-supplied schema is untrusted: a `pattern` is an attacker-chosen regular expression (a syntax error, or catastrophic
 * backtracking). Patterns are removed from MCP schemas at registration; every other keyword the checker supports is bounded.
 */
export function stripPatterns(schema, depth = 0) {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema) || depth > 32) return schema;
  delete schema.pattern;
  if (schema.properties !== null && typeof schema.properties === "object" && !Array.isArray(schema.properties)) {
    for (const key of Object.keys(schema.properties)) stripPatterns(schema.properties[key], depth + 1);
  }
  if (schema.items !== undefined) stripPatterns(schema.items, depth + 1);
  if (schema.additionalProperties !== null && typeof schema.additionalProperties === "object") stripPatterns(schema.additionalProperties, depth + 1);
  return schema;
}

/** Public, run-less view of a tool. */
function describeTool(tool) {
  return Object.freeze({
    id: tool.id,
    kind: tool.kind,
    capability: tool.capability,
    description: tool.description,
    inputSchema: tool.inputSchema,
    stages: tool.stages,
    readOnly: tool.readOnly,
    limits: tool.limits,
    ...(tool.origin ? { origin: tool.origin } : {}),
  });
}

const defaultSleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });

function errorResult(source, code, message, attempts = 0) {
  return { ok: false, trust: "untrusted", source, error: { code, message: safeText(message) }, attempts };
}

/** Run `fn(signal)` under a timeout and the caller's signal. Rejects with a ToolError on timeout / abort. */
function withDeadline(fn, timeoutMs, outer) {
  const controller = new AbortController();
  let timer;
  let onOuter;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ToolError("TOOL_TIMEOUT", `the tool exceeded its ${timeoutMs}ms time limit`, { transient: true }));
    }, timeoutMs);
    onOuter = () => {
      controller.abort();
      reject(new ToolError("TOOL_ABORTED", "the call was cancelled"));
    };
    if (outer?.aborted) onOuter();
    else outer?.addEventListener?.("abort", onOuter, { once: true });
  });
  guard.catch(() => {});
  const work = Promise.resolve().then(() => fn(controller.signal));
  work.catch(() => {});
  return Promise.race([work, guard]).finally(() => {
    clearTimeout(timer);
    outer?.removeEventListener?.("abort", onOuter);
  });
}

/**
 * @param {{stageLimit?: number}} [options]
 */
export function createRegistry({ stageLimit = STAGE_TOOL_LIMIT } = {}) {
  /** @type {Map<string, object>} */
  const tools = new Map();
  /** @type {Map<string, string>} capability -> tool id */
  const capabilities = new Map();

  function register(definition) {
    if (!isObject(definition)) fail("REGISTRY_TOOL_INVALID", "a tool definition must be an object");
    const { id, kind, description, inputSchema, stages, readOnly, run } = definition;
    if (typeof id !== "string" || !ID.test(id)) fail("REGISTRY_ID_INVALID", "tool id must match " + ID.source);
    if (!TOOL_KINDS.includes(kind)) fail("REGISTRY_KIND_INVALID", `tool ${safeText(id, 60)}: kind must be one of ${TOOL_KINDS.join(", ")}`);
    if (typeof description !== "string" || description.trim() === "" || description.length > DESCRIPTION_LIMIT) fail("REGISTRY_DESCRIPTION_INVALID", `tool ${safeText(id, 60)}: description must be 1 to ${DESCRIPTION_LIMIT} characters`);
    if (!isObject(inputSchema)) fail("REGISTRY_SCHEMA_INVALID", `tool ${safeText(id, 60)}: inputSchema must be an object`);
    try {
      boundedCanonicalJson(inputSchema);
    } catch {
      fail("REGISTRY_SCHEMA_INVALID", `tool ${safeText(id, 60)}: inputSchema is too large or too deeply nested`);
    }
    if (!Array.isArray(stages) || stages.length === 0 || stages.length > 32 || new Set(stages).size !== stages.length || stages.some((stage) => typeof stage !== "string" || !STAGE.test(stage))) {
      fail("REGISTRY_STAGES_INVALID", `tool ${safeText(id, 60)}: stages must be a non-empty list of distinct node ids`);
    }
    if (typeof readOnly !== "boolean") fail("REGISTRY_READONLY_REQUIRED", `tool ${safeText(id, 60)}: readOnly must be true or false`);
    if (kind === "api" && readOnly !== true) fail("REGISTRY_API_READONLY", `tool ${safeText(id, 60)}: api tools are read-only in this build`);
    if (typeof run !== "function") fail("REGISTRY_RUN_REQUIRED", `tool ${safeText(id, 60)}: run must be a function`);
    if (kind === "api" && typeof definition.request !== "function") fail("REGISTRY_REQUEST_REQUIRED", `tool ${safeText(id, 60)}: an api tool must describe its request`);
    if (kind === "mcp" && !(isObject(definition.origin) && typeof definition.origin.server === "string" && typeof definition.origin.tool === "string")) {
      fail("REGISTRY_ORIGIN_REQUIRED", `tool ${safeText(id, 60)}: an mcp tool must name its server and tool`);
    }
    // api and mcp tools must NAME their capability: a defaulted name could dodge the duplicate-capability rule.
    if ((kind === "api" || kind === "mcp") && typeof definition.capability !== "string") fail("REGISTRY_CAPABILITY_REQUIRED", `tool ${safeText(id, 60)}: an ${kind} tool must declare its capability`);
    const capability = definition.capability ?? id;
    if (typeof capability !== "string" || !ID.test(capability)) fail("REGISTRY_ID_INVALID", `tool ${safeText(id, 60)}: capability must match ${ID.source}`);
    if (tools.has(id)) fail("REGISTRY_DUPLICATE_ID", `a tool with id ${safeText(id, 60)} is already registered`);
    if (capabilities.has(capability)) {
      const holder = tools.get(capabilities.get(capability));
      fail("REGISTRY_DUPLICATE_CAPABILITY", `capability ${safeText(capability, 60)} is already provided by the ${holder.kind} tool ${safeText(holder.id, 60)}; a ${kind} tool cannot provide it again`);
    }
    for (const stage of stages) {
      const count = [...tools.values()].filter((tool) => tool.stages.includes(stage)).length;
      if (count >= stageLimit) fail("REGISTRY_STAGE_FULL", `stage ${stage} already offers ${stageLimit} tools`);
    }
    const tool = Object.freeze({
      id,
      kind,
      capability,
      description: safeText(description, DESCRIPTION_LIMIT),
      inputSchema: kind === "mcp" ? stripPatterns(structuredClone(inputSchema)) : structuredClone(inputSchema),
      stages: Object.freeze([...stages]),
      readOnly,
      limits: Object.freeze(normalizeLimits(definition.limits)),
      retry: normalizeRetry(definition.retry, readOnly),
      run,
      request: typeof definition.request === "function" ? definition.request : null,
      origin: kind === "mcp" ? Object.freeze({ server: definition.origin.server, tool: definition.origin.tool }) : null,
    });
    tools.set(id, tool);
    capabilities.set(capability, id);
    return describeTool(tool);
  }

  const get = (id) => (typeof id === "string" && tools.has(id) ? tools.get(id) : null);

  async function invoke(id, input, ctx = {}) {
    const tool = get(id);
    const source = tool ? `${tool.kind}:${tool.id}` : "unknown";
    if (!tool) return errorResult(source, "TOOL_UNKNOWN", "no such tool is registered");
    if (typeof ctx.node === "string" && !tool.stages.includes(ctx.node)) return errorResult(source, "TOOL_NOT_IN_STAGE", "this tool is not offered at the current stage");
    let problems;
    try {
      problems = check(input, tool.inputSchema, "input");
    } catch {
      return errorResult(source, "TOOL_INPUT_INVALID", "the input could not be validated against the tool schema");
    }
    if (problems.length > 0) return errorResult(source, "TOOL_INPUT_INVALID", problems.slice(0, 3).join("; "));

    const attempts = tool.retry?.attempts ?? 1;
    const sleep = ctx.sleep ?? defaultSleep;
    const random = ctx.random ?? Math.random;
    let lastError = null;
    let made = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      made = attempt;
      try {
        const value = await withDeadline((signal) => tool.run(input, { ...ctx, signal, attempt, tool: describeTool(tool) }), tool.limits.timeoutMs, ctx.signal);
        const content = boundOutput(value, { ...tool.limits, artifactDir: ctx.artifactDir, fs: ctx.fs });
        return { ok: true, trust: "untrusted", source, content, attempts: attempt };
      } catch (error) {
        lastError = error;
        const retriable = tool.retry !== null && error instanceof ToolError && error.transient === true && error.code !== "TOOL_ABORTED" && attempt < attempts && ctx.signal?.aborted !== true;
        if (!retriable) break;
        const ceiling = Math.min(tool.retry.maxMs, tool.retry.baseMs * 2 ** (attempt - 1));
        const jittered = Math.floor(ceiling * (0.5 + 0.5 * Math.min(1, Math.max(0, random()))));
        const wait = Number.isFinite(error.retryAfterMs) ? Math.min(Math.max(error.retryAfterMs, 0), tool.retry.maxMs) : jittered;
        await sleep(wait, ctx.signal);
      }
    }
    if (lastError instanceof ToolError) return errorResult(source, lastError.code, lastError.message, made);
    return errorResult(source, "TOOL_FAILED", "the tool failed unexpectedly", made);
  }

  return Object.freeze({
    register,
    get: (id) => (get(id) ? describeTool(get(id)) : null),
    has: (id) => get(id) !== null,
    /** The {method, url} an api tool would send for `input` (null for other kinds); lets the guard judge what will really be requested. */
    requestOf: (id, input) => {
      const tool = get(id);
      if (!tool || tool.request === null) return null;
      try {
        return tool.request(input);
      } catch {
        return null;
      }
    },
    list: () => [...tools.values()].map(describeTool),
    forStage: (node) => [...tools.values()].filter((tool) => tool.stages.includes(node)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(describeTool),
    invoke,
    size: () => tools.size,
  });
}
