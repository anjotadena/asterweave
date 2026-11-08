// Stream-json parser (untrusted input: malformed, huge, polluting, fuzzed) and the failure classifier.

import assert from "node:assert/strict";
import test from "node:test";
import { classifyFailure, describeFailure, FAILURE_CLASSES } from "../src/runtime/claude/classify.mjs";
import { createStreamParser, summarizeInput } from "../src/runtime/claude/stream.mjs";
import { nextRoute, resolveRoute } from "../src/runtime/routing.mjs";

const line = (value) => `${typeof value === "string" ? value : JSON.stringify(value)}\n`;
const SID = "11111111-2222-4333-8444-555555555555";
const parse = (input, options) => {
  const parser = createStreamParser({ now: () => 0, ...options });
  for (const chunk of Array.isArray(input) ? input : [input]) parser.push(chunk);
  return parser.finish();
};
const happy = [
  { type: "system", subtype: "init", session_id: SID, model: "claude-sonnet-5-5", tools: ["Bash", "Read"] },
  { type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "git status", description: "x" } }] } },
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", content: "SECRET-TOOL-OUTPUT" }] } },
  { type: "stream_event", event: { whatever: 1 } },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
  { type: "result", subtype: "success", is_error: false, result: "all done", session_id: SID, total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
];

test("stream: extracts init, tool use, tool result count, result, usage and cost", () => {
  const events = [];
  const state = parse(happy.map(line), { onEvent: (event) => events.push(event.kind) });
  assert.equal(state.providerSessionId, SID);
  assert.equal(state.model, "claude-sonnet-5-5");
  assert.equal(state.initTools, 2);
  assert.equal(state.toolEvents.length, 1);
  assert.deepEqual({ id: state.toolEvents[0].id, name: state.toolEvents[0].name, inputSummary: state.toolEvents[0].inputSummary }, { id: "tu_1", name: "Bash", inputSummary: "command=git status description=x" });
  assert.equal(state.toolEvents[0].at, "1970-01-01T00:00:00.000Z");
  assert.equal(state.toolResults, 1);
  assert.equal(state.resultText, "all done");
  assert.ok(state.resultSeen && !state.resultIsError);
  assert.deepEqual(state.usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 });
  assert.equal(state.costUsd, 0.5);
  assert.equal(state.rateLimitEvents, 1);
  assert.equal(state.rateLimitStatus, "allowed_warning");
  assert.equal(state.malformedLines, 0);
  assert.deepEqual(events, ["init", "text", "tool_use", "tool_result", "rate_limit", "result"]);
  assert.ok(!JSON.stringify(state).includes("SECRET-TOOL-OUTPUT"));
});

test("stream: missing or invalid usage is unknown (null), never 0", () => {
  const none = parse(line({ type: "result", subtype: "success", result: "x" }));
  assert.deepEqual(none.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });
  assert.equal(none.costUsd, null);
  const odd = parse(line({ type: "result", subtype: "success", usage: { input_tokens: -1, output_tokens: "7", cache_read_input_tokens: 1.5, cache_creation_input_tokens: 9 }, total_cost_usd: "free" }));
  assert.deepEqual(odd.usage, { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: 9 });
  assert.equal(odd.costUsd, null);
});

test("stream: an error result is flagged; a result is still honoured past the event cap", () => {
  assert.ok(parse(line({ type: "result", subtype: "error_max_turns", result: "stop" })).resultIsError);
  assert.ok(parse(line({ type: "result", subtype: "success", is_error: true, result: "x" })).resultIsError);
  const flood = Array.from({ length: 30 }, () => line({ type: "assistant", message: { content: [] } }));
  const state = parse([...flood, line({ type: "result", subtype: "success", result: "late" })], { limits: { maxEvents: 10 } });
  assert.equal(state.eventCount, 11);
  assert.equal(state.droppedEvents, 20);
  assert.equal(state.resultText, "late");
});

test("stream: lines split across chunks, CRLF and a final line without newline", () => {
  const text = happy.map(line).join("").replaceAll("\n", "\r\n").trimEnd();
  const bytes = Buffer.from(text, "utf8");
  const parser = createStreamParser({ now: () => 0 });
  for (let offset = 0; offset < bytes.length; offset += 7) parser.push(bytes.subarray(offset, offset + 7));
  const state = parser.finish();
  assert.equal(state.resultText, "all done");
  assert.equal(state.malformedLines, 0);
});

test("stream: multi-byte characters split across chunks decode intact", () => {
  const bytes = Buffer.from(line({ type: "result", subtype: "success", result: "héllo wörld ✓ 😀" }), "utf8");
  const parser = createStreamParser();
  for (let offset = 0; offset < bytes.length; offset += 1) parser.push(bytes.subarray(offset, offset + 1));
  assert.equal(parser.finish().resultText, "héllo wörld ✓ 😀");
});

test("stream: malformed lines are counted, not fatal; valid ones around them still count", () => {
  const input = [line(happy[0]), "not json\n", "[1,2]\n", "\"str\"\n", "42\n", "null\n", "{\"type\":\n", Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d, 0x0a]), line(happy[5])];
  const state = parse(input);
  assert.equal(state.malformedLines, 7);
  assert.ok(state.resultSeen);
  assert.equal(state.providerSessionId, SID);
});

test("stream: an oversized line is dropped without decoding and parsing resumes after it", () => {
  const limits = { maxLineBytes: 1000 };
  const parser = createStreamParser({ limits });
  parser.push(Buffer.from('{"type":"assistant","pad":"'));
  for (let index = 0; index < 5; index += 1) parser.push(Buffer.alloc(400, 0x61));
  parser.push(Buffer.from(`"}\n${line(happy[5])}`));
  const state = parser.finish();
  assert.equal(state.oversizedLines, 1);
  assert.equal(state.malformedLines, 1);
  assert.ok(state.resultSeen);
  // A complete oversized line inside one chunk is dropped too.
  const whole = parse([`{"type":"assistant","pad":"${"a".repeat(2000)}"}\n`, line(happy[5])], { limits });
  assert.equal(whole.oversizedLines, 1);
  assert.ok(whole.resultSeen);
});

test("stream: prototype pollution payloads change nothing", () => {
  const payload = '{"__proto__":{"polluted":true},"type":"assistant","message":{"__proto__":{"polluted":true},"content":[{"type":"tool_use","id":"a","name":"__proto__","input":{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}}]},"constructor":{"prototype":{"polluted":true}}}\n';
  const state = parse([payload, '{"type":"result","subtype":"success","result":"ok","usage":{"__proto__":{"input_tokens":5}},"__proto__":{"is_error":true}}\n']);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(state.toolEvents[0].name, "__proto__");
  assert.equal(state.toolEvents[0].inputSummary, "__proto__=[object] constructor=[object]");
  assert.equal(state.usage.inputTokens, null);
  assert.ok(!state.resultIsError);
});

test("stream: strings are sanitized, redacted and bounded", () => {
  const token = ["gh", "p_", "a".repeat(36)].join("");
  const state = parse([line({ type: "assistant", message: { content: [{ type: "tool_use", id: "i\u001b]0;evil\u0007d", name: `Bash\u001b[2J${"n".repeat(300)}`, input: { command: `echo ${token} \u001b[31m${"x".repeat(500)}` } }] } }), line({ type: "result", subtype: "success", result: `\u001b]52;c;AAAA\u0007${token}` })]);
  const tool = state.toolEvents[0];
  assert.ok(tool.name.length <= 100 && !tool.name.includes("\u001b"));
  assert.ok(!tool.id.includes("\u001b") && !tool.id.includes("\u0007"));
  assert.ok(tool.inputSummary.length <= 200 && !tool.inputSummary.includes(token) && !tool.inputSummary.includes("\u001b"));
  assert.ok(!state.resultText.includes(token) && !state.resultText.includes("\u001b"));
});

test("stream: result text is bounded and keeps the tail (the fenced action block is at the end)", () => {
  const big = `${"a".repeat(200_000)}\nTAIL-MARKER`;
  const state = parse(line({ type: "result", subtype: "success", result: big }));
  assert.ok(state.resultText.length <= 64 * 1024);
  assert.ok(state.resultText.endsWith("TAIL-MARKER"));
});

test("stream: tool events are capped and counted", () => {
  const blocks = Array.from({ length: 50 }, (_, index) => ({ type: "tool_use", id: `t${index}`, name: "Read", input: {} }));
  const state = parse(line({ type: "assistant", message: { content: blocks } }), { limits: { maxToolEvents: 5 } });
  assert.equal(state.toolEvents.length, 5);
  assert.equal(state.toolEventsDropped, 45);
});

test("stream: an observer that throws does not break parsing", () => {
  const state = parse(happy.map(line), { onEvent: () => { throw new Error("boom"); } });
  assert.ok(state.resultSeen);
});

test("stream: fuzz never throws and never pollutes", () => {
  let seed = 0x1234abcd;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const pieces = ['{"type":"result"', '"subtype":"success"', '"is_error":', 'true', '"usage":{', '"input_tokens":', '9e999', '"__proto__":', '{"polluted":1}', '[', ']', '}', '"', '\\u0000', '\n', '\r\n', '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"A","input":[1,2]}]}}\n', '{"type":"system","subtype":"init","tools":5}\n', 'null\n'];
  for (let round = 0; round < 300; round += 1) {
    const parser = createStreamParser({ limits: { maxLineBytes: 300, maxEvents: 20 }, now: () => 0 });
    const count = Math.floor(random() * 40);
    for (let index = 0; index < count; index += 1) {
      parser.push(random() < 0.2 ? Buffer.from(Array.from({ length: Math.floor(random() * 30) }, () => Math.floor(random() * 256))) : pieces[Math.floor(random() * pieces.length)]);
    }
    const state = parser.finish();
    assert.ok(Number.isInteger(state.malformedLines) && state.malformedLines >= 0);
    for (const value of Object.values(state.usage)) assert.ok(value === null || (Number.isSafeInteger(value) && value >= 0));
  }
  assert.equal({}.polluted, undefined);
});

test("summarizeInput: scalars only, bounded", () => {
  assert.equal(summarizeInput({ a: 1, b: true, c: { d: 1 }, e: [1], f: null }), "a=1 b=true c=[object] e=[list] f=null");
  assert.equal(summarizeInput("plain"), "plain");
  assert.equal(summarizeInput(undefined), "");
  assert.ok(summarizeInput({ k: "z".repeat(1000) }).length <= 200);
});

// --- classification ----------------------------------------------------------------------------------------------

const cls = (input) => classifyFailure(input).class;

test("classify: failure classes from stderr and result text", () => {
  assert.equal(cls({ exitCode: 1, stderrTail: "API Error: 429 Too Many Requests" }), "rate-limit");
  assert.equal(cls({ exitCode: 1, stderrTail: "Claude AI usage limit reached" }), "rate-limit");
  assert.equal(cls({ exitCode: 1, stderrTail: "API Error: 529 overloaded_error" }), "overloaded");
  assert.equal(cls({ exitCode: 1, stderrTail: "API Error: 503 Service Unavailable" }), "5xx");
  assert.equal(cls({ exitCode: 1, stderrTail: "HTTP 502 Bad Gateway" }), "5xx");
  assert.equal(cls({ exitCode: 1, stderrTail: "Invalid API key. Please run /login" }), "auth");
  assert.equal(cls({ exitCode: 1, stderrTail: "401 Unauthorized" }), "auth");
  assert.equal(cls({ exitCode: 1, stderrTail: "getaddrinfo ENOTFOUND api.anthropic.com" }), "offline");
  assert.equal(cls({ exitCode: 1, stderrTail: "connect ECONNREFUSED 127.0.0.1:443" }), "offline");
  assert.equal(cls({ exitCode: 1, stderrTail: "request timed out" }), "timeout");
  assert.equal(cls({ exitCode: 1, stderrTail: "400 invalid_request_error: bad" }), "invalid-request");
  assert.equal(cls({ exitCode: 1, stderrTail: "error: unknown option '--effort'" }), "invalid-request");
  assert.equal(cls({ exitCode: 1, stderrTail: "tool call blocked by hook" }), "policy");
  assert.equal(cls({ exitCode: 0, result: { text: "API Error: 429", isError: true } }), "rate-limit");
  assert.equal(cls({ exitCode: 1, stderrTail: "something odd" }), "unknown");
  assert.equal(cls({ exitCode: 139, stderrTail: "" }), "crashed");
  assert.equal(cls({ exitCode: null, signal: "SIGSEGV" }), "crashed");
  assert.equal(cls({}), "unknown");
});

test("classify: our own kills and spawn errors win over text", () => {
  assert.equal(cls({ spawnError: { code: "ENOENT" } }), "not-installed");
  assert.equal(cls({ spawnError: { code: "EMFILE" } }), "crashed");
  assert.equal(cls({ aborted: true, stderrTail: "429" }), "killed");
  assert.equal(cls({ timedOut: true, stderrTail: "429" }), "timeout");
  assert.equal(cls({ outputLimit: true }), "output-limit");
  assert.equal(cls({ protocolViolation: true }), "crashed");
});

test("classify: bounded, sanitized input; retryable flags; every class is described", () => {
  assert.equal(cls({ stderrTail: `${"x".repeat(20_000)} API Error: 429` }), "rate-limit");
  assert.equal(cls({ stderrTail: `API Error: 429 ${"x".repeat(20_000)}` }), "unknown"); // only the bounded tail is read
  assert.equal(cls({ stderrTail: "rate\u001b[2Jlimit" }), "rate-limit");
  assert.equal(classifyFailure({ stderrTail: "API Error: 429 rate_limit_error" }).retryable, true);
  assert.equal(classifyFailure({ stderrTail: "API Error: 401" }).retryable, false);
  for (const failureClass of FAILURE_CLASSES) {
    const described = describeFailure(failureClass);
    assert.ok(described.message.length > 0 && described.remediation.length > 0, failureClass);
  }
});

test("classify: lines up with routing.nextRoute (transient classes advance, the rest never)", () => {
  const route = resolveRoute({ config: { default: "claude-sonnet-5-5", fallback: ["claude-haiku-5-5", "claude-opus-5-5"], stages: {} }, node: "implement" });
  for (const [stderrTail, advances] of [["API Error: 429", true], ["API Error: 529 overloaded_error", true], ["API Error: 503", true], ["request timed out", true], ["API Error: 401 unauthorized", false], ["API Error: 400 invalid_request", false], ["weird", false], ["blocked by hook", false]]) {
    const { class: failureClass } = classifyFailure({ exitCode: 1, stderrTail });
    assert.equal(nextRoute(route, { class: failureClass }).advanced, advances, `${stderrTail} -> ${failureClass}`);
  }
});

test("permanent errors are never classified as transient (a retry or fallback would re-run the turn and its tools)", () => {
  const cls = (text) => classifyFailure({ exitCode: 1, result: { text, isError: true } });
  assert.equal(cls("Ran 500 tests; 3 failed").class, "unknown", "a bare number is not a status code");
  assert.equal(cls("OAuth token has expired. Please run /login. 429 retries skipped").class, "auth");
  assert.equal(cls("PreToolUse hook timed out after 10s").class, "policy");
  assert.equal(cls("the tests hit a timeout in suite x").class, "unknown");
  assert.equal(cls("API Error: 429 rate_limit_error").class, "rate-limit");
  assert.equal(cls("API Error: 529 overloaded_error").class, "overloaded");
  assert.equal(cls("HTTP 503 Service Unavailable").class, "5xx");
  assert.equal(cls("request timed out").class, "timeout");
  for (const permanent of ["Ran 500 tests; 3 failed", "PreToolUse hook timed out after 10s", "API Error: 401 invalid x-api-key"]) assert.equal(cls(permanent).retryable, false, permanent);
});
