// A scriptable stand-in for the `claude` binary. Plain node, no network, no model. Used ONLY by tests.
//
// The scenario is a JSON file named by `--fake-scenario <file>` (preferred: the runner's env allow-list drops unknown
// variables) or by the env FAKE_CLAUDE_SCENARIO. It is re-read on every start. Scenario fields (all optional):
//   version      text printed for --version (default "2.1.5 (Claude Code)")
//   mode         success | fail | error-result | malformed | huge-line | huge-output | hang | ignore-sigterm | grandchild |
//                no-stdin-read | no-result | slow-stdin (default success)
//   sessionId, model, tools, toolUses [{id,name,input}], text, usage, costUsd, resultText, exitCode, stderr
//   record       file to write {argv, stdinBytes, stdinSha256, envKeys, env, cwd} to (secrets must be checked by key name)
//   pidFile      file to write the grandchild pid to (mode grandchild)
//   rejectImages true: a turn whose stream-json input carries image blocks fails with an error result
// With `--input-format stream-json` stdin is ONE user message line; the record file then also holds {inputFormat, blockTypes, images: [{mediaType,
// decodedBytes, decodedSha256, base64Length}]} (never the data itself). Used to prove what the child received.
// The stream shapes are the spec's UNVERIFIED guess, not a recording of a real claude.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const flag = args.indexOf("--fake-scenario");
const scenarioFile = flag >= 0 ? args[flag + 1] : process.env.FAKE_CLAUDE_SCENARIO;
let scenario = scenarioFile ? JSON.parse(readFileSync(scenarioFile, "utf8")) : {};
let mode = scenario.mode ?? "success";
const out = (value) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);


const sessionId = scenario.sessionId ?? "11111111-2222-4333-8444-555555555555";
const init = () => out({ type: "system", subtype: "init", session_id: sessionId, model: scenario.model ?? "claude-sonnet-5-5", tools: scenario.tools ?? ["Bash", "Read"] });
const resultEvent = (extra = {}) => out({ type: "result", subtype: "success", is_error: false, result: scenario.resultText ?? "done", session_id: sessionId, total_cost_usd: scenario.costUsd ?? 0.0123, usage: scenario.usage ?? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }, ...extra });
const hang = () => setInterval(() => {}, 1 << 30);

// The UNVERIFIED stream-json input shape (see src/runtime/claude/images.mjs): {type:"user",message:{content:[{type:"image",source:{media_type,data}},{type:"text",text}]}}.
function parseStreamJsonInput(stdin) {
  if (args[args.indexOf("--input-format") + 1] !== "stream-json" || !args.includes("--input-format")) return null;
  const message = JSON.parse(stdin.toString("utf8").split(String.fromCharCode(10))[0]).message;
  const blocks = message.content;
  const images = blocks.filter((block) => block.type === "image").map((block) => {
    const decoded = Buffer.from(block.source.data, "base64");
    return { mediaType: block.source.media_type, decodedBytes: decoded.length, decodedSha256: createHash("sha256").update(decoded).digest("hex"), base64Length: block.source.data.length };
  });
  return { blockTypes: blocks.map((block) => block.type), images, text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(String.fromCharCode(10)) };
}

function emitBody(stdin = Buffer.alloc(0), input = null) {
  if (input && scenario.rejectImages && input.images.length > 0) {
    mode = "error-result";
    scenario = { ...scenario, resultText: "invalid_request: this model does not accept images", exitCode: 1 };
  }
  if (scenario.protocol && scenario.resultText === undefined) scenario = { ...scenario, resultText: protocolText(input ? input.text : stdin.toString("utf8")) };
  if (mode === "success" || mode === "no-stdin-read") {
    init();
    for (const use of scenario.toolUses ?? []) out({ type: "assistant", message: { content: [{ type: "text", text: scenario.text ?? "working" }, { type: "tool_use", id: use.id, name: use.name, input: use.input }] } });
    if ((scenario.toolUses ?? []).length > 0) out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "SECRET-OUTPUT" }] } });
    resultEvent();
    process.exitCode = scenario.exitCode ?? 0;
  } else if (mode === "report-hang") {
    // reports a session, a tool call and a result with usage, then never exits (an abort must still keep what it reported)
    init();
    for (const use of scenario.toolUses ?? []) out({ type: "assistant", message: { content: [{ type: "tool_use", id: use.id, name: use.name, input: use.input }] } });
    resultEvent();
    hang();
  } else if (mode === "no-result") {
    init();
    process.exitCode = 0;
  } else if (mode === "fail") {
    process.stderr.write(scenario.stderr ?? "boom\n");
    process.exitCode = scenario.exitCode ?? 1;
  } else if (mode === "error-result") {
    init();
    out({ type: "result", subtype: "error_during_execution", is_error: true, result: scenario.resultText ?? "API Error: 429 rate limit", session_id: sessionId });
    process.exitCode = scenario.exitCode ?? 1;
  } else if (mode === "malformed") {
    init();
    process.stdout.write("this is not json\n[1,2,3]\n\"string\"\n{\"type\":\n");
    process.stdout.write(Buffer.concat([Buffer.from('{"type":"assistant","x":"'), Buffer.from([0xff, 0xfe]), Buffer.from('"}\n')]));
    out('{"__proto__":{"polluted":true},"type":"assistant","message":{"__proto__":{"polluted":true},"content":[]},"constructor":{"prototype":{"polluted":true}}}');
    resultEvent();
    process.exitCode = 0;
  } else if (mode === "huge-line") {
    init();
    process.stdout.write(`{"type":"assistant","pad":"${"a".repeat(scenario.lineBytes ?? 2 * 1024 * 1024)}"}\n`);
    resultEvent();
    process.exitCode = 0;
  } else if (mode === "huge-output") {
    init();
    const chunk = `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(900) }] } })}\n`;
    const pump = () => { while (process.stdout.write(chunk)); process.stdout.once("drain", pump); };
    pump();
  } else if (mode === "hang") {
    init();
    hang();
  } else if (mode === "ignore-sigterm") {
    process.on("SIGTERM", () => {});
    process.on("SIGINT", () => {});
    init();
    hang();
  } else if (mode === "grandchild") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore", detached: process.platform === "win32" }); // Windows: a detached grandchild survives a plain parent kill, so only a tree kill reaches it
    if (scenario.exitAfterSpawn) child.unref();
    if (scenario.pidFile) writeFileSync(scenario.pidFile, String(child.pid));
    init();
    if (scenario.exitAfterSpawn) process.exitCode = 0;
    else hang();
  }
}

function record(stdin, input = null) {
  if (scenario.recordLog) appendFileSync(scenario.recordLog, `${JSON.stringify({ argv: args, ...(input ? { blockTypes: input.blockTypes, images: input.images } : {}) })}
`);
  if (!scenario.record) return;
  writeFileSync(scenario.record, JSON.stringify({ argv: args, stdinBytes: stdin.length, stdinSha256: createHash("sha256").update(stdin).digest("hex"), envKeys: Object.keys(process.env), env: Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(ASTERWEAVE_|CLAUDE|ANTHROPIC_|GITHUB_|GH_|NPM_|AWS_|GOOGLE_)/i.test(key))), cwd: process.cwd(), ...(input ? { inputFormat: "stream-json", blockTypes: input.blockTypes, images: input.images } : {}) }));
}

// scenario.sequence: per-run overrides, picked by a counter file next to the scenario (so a retry sees the next entry).
function applySequence() {
  if (!Array.isArray(scenario.sequence) || scenario.sequence.length === 0) return;
  const counter = `${scenarioFile}.n`;
  let n = 0;
  try { n = Number(readFileSync(counter, "utf8")) || 0; } catch { /* first run */ }
  writeFileSync(counter, String(n + 1));
  scenario = { ...scenario, ...scenario.sequence[Math.min(n, scenario.sequence.length - 1)] };
  mode = scenario.mode ?? "success";
}

// scenario.protocol: answer the Asterweave prompt (Node:, Required evidence:, Artifact evidence needing sha256:) with the fenced action blocks.
function protocolText(prompt) {
  const line = (label) => new RegExp(`^${label}: (.*)$`, "m").exec(prompt)?.[1]?.trim();
  const kinds = (line("Required evidence") ?? "none").split(",").map((kind) => kind.trim()).filter((kind) => kind && kind !== "none");
  const artifact = line("Artifact evidence needing sha256");
  const blocks = kinds.map((kind) => JSON.stringify({ v: 1, type: "evidence", evidence: { kind, summary: `${kind} ok`, result: scenario.evidenceResult ?? "pass", ...(kind === artifact ? { sha256: createHash("sha256").update(`${line("Node")}`).digest("hex") } : {}) } }));
  blocks.push(JSON.stringify({ v: 1, type: "complete", outcome: scenario.outcome ?? "pass", ...(scenario.signature ? { signature: scenario.signature } : {}) }));
  const fence = "`".repeat(3);
  const text = blocks.map((block) => [`${fence}json`, block, fence].join("\n")).join("\n\n");
  return ["Done with " + line("Node") + ".", "", text, ""].join("\n");
}

function main() {
  applySequence();
if (mode === "no-stdin-read" || mode === "hang" || mode === "ignore-sigterm" || mode === "grandchild" || mode === "huge-output" || mode === "report-hang") {
  record(Buffer.alloc(0));
  emitBody();
} else {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const stdin = Buffer.concat(chunks);
    const input = parseStreamJsonInput(stdin);
    record(stdin, input);
    emitBody(stdin, input);
  });
}
}

if (args.includes("--version")) console.log(scenario.version ?? "2.1.5 (Claude Code)");
else main();
