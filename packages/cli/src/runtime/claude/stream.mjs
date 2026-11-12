// Tolerant parser of `claude -p --output-format stream-json` output.
//
// UNVERIFIED: the event shapes below ({type:"system",subtype:"init"}, assistant `message.content[]` blocks, `tool_result`,
// {type:"result"}) are the spec's best guess and were never checked against a live claude. EVERYTHING the child prints is
// untrusted data:
//   - split at the Buffer level on 0x0A; a line over `maxLineBytes` is dropped (counted as malformed), not decoded;
//   - strict UTF-8 per line; invalid UTF-8 or JSON, or a non-object value, is a malformed line (counted, never fatal here);
//   - after `maxEvents` events only the final `result` event is still honoured; the rest is dropped and counted;
//   - fields are READ with own-property checks into fresh values; nothing from the child is ever assigned onto an object by
//     key, so `__proto__`/`constructor` payloads cannot pollute anything; unknown fields are ignored;
//   - every string that leaves this module is redacted, terminal-sanitized and length-bounded.
//
// TOOL RESULTS are counted, and their content is NOT read unless the caller asks for bounded evidence with
// `toolResultExcerptChars` > 0 (the memory pipeline does, from memory.toolResultExcerptChars; with memory off it is 0 and nothing
// is retained). Then, per tool_result block, at most `maxToolResultExcerpts` records {toolUseId, isError, excerpt, originalChars,
// excerptChars, truncated} are kept: the excerpt comes from TEXT content only (a string, or `type:"text"` blocks; images and
// any other block are never read), at most limit + EXCERPT_REDACT_MARGIN raw characters are looked at, that window is redacted
// FIRST and only then cut to the limit (so a secret crossing the cut is still recognised). The excerpt leaves this module only
// through `finish().toolResultExcerpts`: never through `onEvent` (the emitted tool_result event stays content-free), so it cannot
// reach the terminal, and the runner's ledger records do not copy it.

import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { PROVIDER_SESSION_PATTERN } from "./argv.mjs";

export const STREAM_LIMITS = Object.freeze({ maxLineBytes: 1024 * 1024, maxEvents: 5000, maxToolEvents: 1000, maxResultChars: 64 * 1024, maxTextChars: 64 * 1024, summaryChars: 200, nameChars: 100, maxToolResultExcerpts: 200 });
/** Upper bound of `toolResultExcerptChars` (memory.toolResultExcerptChars has the same maximum). */
export const TOOL_RESULT_EXCERPT_MAX = 16_000; // equals capture TOOL_OUTPUT_MAX_CHARS: an excerpt never exceeds one stored tool event
/** Raw characters looked at beyond the limit, so redaction sees a secret that crosses the cut whole. */
export const EXCERPT_REDACT_MARGIN = 4096;

const clean = (value, max) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, max);
const own = (object, key) => (object !== null && typeof object === "object" && Object.hasOwn(object, key) ? object[key] : undefined);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const tailText = (text, max) => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);

/** One-line summary of a tool input: scalar fields only, bounded, redacted. */
export function summarizeInput(input, max = STREAM_LIMITS.summaryChars) {
  if (typeof input === "string") return clean(input, max);
  if (!isObject(input)) return "";
  const parts = [];
  for (const key of Object.keys(input).slice(0, 10)) {
    const value = input[key];
    const shown = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value).slice(0, 80) : Array.isArray(value) ? "[list]" : value === null ? "null" : "[object]";
    parts.push(`${key.slice(0, 30)}=${shown}`);
  }
  return clean(parts.join(" "), max);
}

/**
 * Bounded evidence of one tool_result block (see the header). Text content only; redacted before it is cut.
 * @returns {{toolUseId: string, isError: boolean, excerpt: string, originalChars: number, excerptChars: number, truncated: boolean}}
 */
export function toolResultExcerpt(block, max, nameChars = STREAM_LIMITS.nameChars) {
  const content = own(block, "content");
  const window = max + EXCERPT_REDACT_MARGIN;
  let raw = "";
  let originalChars = 0;
  const take = (text) => {
    if (originalChars > 0) {
      originalChars += 1;
      if (raw.length < window) raw += "\n";
    }
    originalChars += text.length;
    if (raw.length < window) raw += text.slice(0, window - raw.length);
  };
  if (typeof content === "string") take(content);
  else if (Array.isArray(content)) {
    for (const part of content.slice(0, 200)) if (own(part, "type") === "text" && typeof own(part, "text") === "string") take(own(part, "text"));
  }
  const redacted = redactText(raw).text;
  const excerpt = redacted.slice(0, max);
  return { toolUseId: clean(own(block, "tool_use_id"), nameChars), isError: own(block, "is_error") === true, excerpt, originalChars, excerptChars: excerpt.length, truncated: originalChars > max || redacted.length > max };
}

/**
 * @param {{limits?: Partial<typeof STREAM_LIMITS>, onEvent?: (event: object) => void, now?: () => number, toolResultExcerptChars?: number}} [options]
 *   `toolResultExcerptChars` (0 to TOOL_RESULT_EXCERPT_MAX; default 0 = tool output is never read): bounded tool evidence, see the header.
 */
export function createStreamParser(options = {}) {
  const limits = { ...STREAM_LIMITS, ...options.limits };
  const excerptChars = Number.isSafeInteger(options.toolResultExcerptChars) && options.toolResultExcerptChars > 0 ? Math.min(options.toolResultExcerptChars, TOOL_RESULT_EXCERPT_MAX) : 0;
  const now = options.now ?? Date.now;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = Buffer.alloc(0);
  let skipping = false; // inside an oversized line: ignore bytes up to the next newline
  const state = {
    providerSessionId: null, model: null, usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null },
    toolEvents: [], toolEventsDropped: 0, toolResults: 0, resultText: "", assistantText: "", costUsd: null,
    resultSeen: false, resultIsError: false, resultSubtype: null, initTools: 0, rateLimitEvents: 0, rateLimitStatus: null,
    malformedLines: 0, oversizedLines: 0, eventCount: 0, droppedEvents: 0, toolResultExcerpts: [], toolResultExcerptsDropped: 0,
  };

  const emit = (event) => {
    if (!options.onEvent) return;
    try { options.onEvent(event); } catch { /* an observer must not break parsing */ }
  };

  function sessionId(value) {
    return typeof value === "string" && PROVIDER_SESSION_PATTERN.test(value) ? value : null;
  }

  function handleResult(event) {
    state.resultSeen = true;
    const subtype = own(event, "subtype");
    state.resultSubtype = typeof subtype === "string" ? clean(subtype, 60) : null;
    state.resultIsError = own(event, "is_error") === true || (typeof subtype === "string" && subtype.startsWith("error"));
    const text = own(event, "result");
    if (typeof text === "string") state.resultText = tailText(clean(text.slice(-limits.maxResultChars * 2), limits.maxResultChars * 2), limits.maxResultChars);
    state.providerSessionId = sessionId(own(event, "session_id")) ?? state.providerSessionId;
    const cost = own(event, "total_cost_usd");
    state.costUsd = typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? cost : state.costUsd;
    const usage = own(event, "usage");
    if (isObject(usage)) {
      state.usage = {
        inputTokens: count(own(usage, "input_tokens")), outputTokens: count(own(usage, "output_tokens")),
        cacheReadTokens: count(own(usage, "cache_read_input_tokens")), cacheCreationTokens: count(own(usage, "cache_creation_input_tokens")),
      };
    }
    emit({ kind: "result", subtype: state.resultSubtype, isError: state.resultIsError });
  }

  function handleAssistant(event) {
    const message = own(event, "message");
    const content = own(message, "content");
    if (typeof content === "string") {
      state.assistantText = tailText(state.assistantText + clean(content, limits.maxTextChars), limits.maxTextChars);
      emit({ kind: "text", chars: Math.min(content.length, limits.maxTextChars) });
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content.slice(0, 200)) {
      const type = own(block, "type");
      if (type === "text" && typeof own(block, "text") === "string") {
        const text = own(block, "text");
        state.assistantText = tailText(state.assistantText + clean(text, limits.maxTextChars), limits.maxTextChars);
        emit({ kind: "text", chars: Math.min(text.length, limits.maxTextChars) });
      } else if (type === "tool_use") {
        const name = clean(own(block, "name"), limits.nameChars);
        if (name === "") continue;
        if (state.toolEvents.length >= limits.maxToolEvents) { state.toolEventsDropped += 1; continue; }
        const toolEvent = { id: clean(own(block, "id"), limits.nameChars), name, inputSummary: summarizeInput(own(block, "input"), limits.summaryChars), at: new Date(now()).toISOString() };
        state.toolEvents.push(toolEvent);
        emit({ kind: "tool_use", ...toolEvent });
      }
    }
  }

  function handleEvent(event) {
    const type = own(event, "type");
    if (state.eventCount >= limits.maxEvents && type !== "result") { state.droppedEvents += 1; return; }
    state.eventCount += 1;
    if (type === "system" && own(event, "subtype") === "init") {
      state.providerSessionId = sessionId(own(event, "session_id")) ?? state.providerSessionId;
      const model = own(event, "model");
      if (typeof model === "string" && model.length > 0) state.model = clean(model, 100);
      const tools = own(event, "tools");
      state.initTools = Array.isArray(tools) ? Math.min(tools.length, 10_000) : 0;
      emit({ kind: "init", model: state.model, tools: state.initTools });
    } else if (type === "assistant") handleAssistant(event);
    else if (type === "user") {
      const content = own(own(event, "message"), "content");
      if (Array.isArray(content)) {
        for (const block of content.slice(0, 200)) {
          if (own(block, "type") !== "tool_result") continue;
          state.toolResults += 1;
          if (excerptChars === 0) continue; // content is never read
          if (state.toolResultExcerpts.length >= limits.maxToolResultExcerpts) state.toolResultExcerptsDropped += 1;
          else state.toolResultExcerpts.push(toolResultExcerpt(block, excerptChars, limits.nameChars));
        }
      }
      emit({ kind: "tool_result" });
    } else if (type === "result") handleResult(event);
    else if (type === "rate_limit_event" || type === "rate_limit") {
      state.rateLimitEvents += 1;
      const status = own(own(event, "rate_limit_info"), "status") ?? own(event, "status");
      state.rateLimitStatus = typeof status === "string" ? clean(status, 40) : state.rateLimitStatus;
      emit({ kind: "rate_limit", status: state.rateLimitStatus });
    }
    // stream_event / partial messages and unknown types: ignored
  }

  function handleLine(bytes) {
    if (bytes.length > 0 && bytes[bytes.length - 1] === 0x0d) bytes = bytes.subarray(0, bytes.length - 1);
    if (bytes.length === 0) return;
    if (bytes.length > limits.maxLineBytes) { state.oversizedLines += 1; state.malformedLines += 1; return; }
    let value;
    try {
      value = JSON.parse(decoder.decode(bytes));
    } catch {
      state.malformedLines += 1;
      return;
    }
    if (!isObject(value)) { state.malformedLines += 1; return; }
    handleEvent(value);
  }

  return {
    /** Feed a chunk (Buffer or string). */
    push(chunk) {
      let data = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      while (data.length > 0) {
        const newline = data.indexOf(0x0a);
        if (skipping) {
          if (newline === -1) return;
          skipping = false;
          data = data.subarray(newline + 1);
          continue;
        }
        if (newline === -1) {
          buffer = buffer.length === 0 ? data : Buffer.concat([buffer, data]);
          if (buffer.length > limits.maxLineBytes) { state.oversizedLines += 1; state.malformedLines += 1; buffer = Buffer.alloc(0); skipping = true; }
          return;
        }
        const line = buffer.length === 0 ? data.subarray(0, newline) : Buffer.concat([buffer, data.subarray(0, newline)]);
        buffer = Buffer.alloc(0);
        data = data.subarray(newline + 1);
        handleLine(line);
      }
    },
    /** Flush a final line without newline and return the extracted state. */
    finish() {
      if (!skipping && buffer.length > 0) handleLine(buffer);
      buffer = Buffer.alloc(0);
      skipping = false;
      return {
        providerSessionId: state.providerSessionId, model: state.model, usage: { ...state.usage }, toolEvents: [...state.toolEvents],
        toolEventsDropped: state.toolEventsDropped, toolResults: state.toolResults,
        resultText: state.resultText !== "" ? state.resultText : state.assistantText, costUsd: state.costUsd,
        resultSeen: state.resultSeen, resultIsError: state.resultIsError, resultSubtype: state.resultSubtype,
        initTools: state.initTools, rateLimitEvents: state.rateLimitEvents, rateLimitStatus: state.rateLimitStatus,
        malformedLines: state.malformedLines, oversizedLines: state.oversizedLines, eventCount: state.eventCount, droppedEvents: state.droppedEvents,
        ...(excerptChars > 0 ? { toolResultExcerpts: state.toolResultExcerpts.map((item) => ({ ...item })), toolResultExcerptsDropped: state.toolResultExcerptsDropped } : {}),
      };
    },
    /** Malformed lines so far (the runner stops a child that floods this). */
    get malformedLines() { return state.malformedLines; },
  };
}
