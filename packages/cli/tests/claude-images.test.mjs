// Image input for a claude turn: the stream-json message builder (UNVERIFIED shape), argv, stdin through the fake claude, and the
// executor's first-turn-only behaviour. No model call anywhere: the child is tests/fixtures/fake-claude.mjs.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { buildClaudeArgv } from "../src/runtime/claude/argv.mjs";
import { createClaudeExecutor } from "../src/runtime/claude/executor.mjs";
import { buildStreamJsonInput, validateImages } from "../src/runtime/claude/images.mjs";
import { runClaudeTurn } from "../src/runtime/claude/run.mjs";
import { makeJpeg, makePng } from "./image-fixture.mjs";
import { deliveryGraph } from "./loop-fixture.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const temps = [];
const tempDir = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-cimg-"))); temps.push(dir); return dir; };
after(() => { for (const dir of temps) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* a just-killed child can hold its cwd on Windows */ } } });

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const asImage = (bytes, mime) => ({ mime, dataBase64: bytes.toString("base64") });
const PNG = makePng({ width: 4, height: 4 });
const JPG = makeJpeg({ width: 6, height: 2 });
const hostEnv = { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" };

test("buildStreamJsonInput: ONE newline-terminated user message, image blocks first, then the text block", () => {
  const line = buildStreamJsonInput({ prompt: "Node: intake\nline two", images: [asImage(PNG, "image/png"), asImage(JPG, "image/jpeg")] }).toString("utf8");
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false, "a single JSON line");
  const message = JSON.parse(line);
  assert.equal(message.type, "user");
  assert.equal(message.message.role, "user");
  assert.deepEqual(message.message.content.map((block) => block.type), ["image", "image", "text"]);
  assert.deepEqual(message.message.content[0].source, { type: "base64", media_type: "image/png", data: PNG.toString("base64") });
  assert.equal(message.message.content[2].text, "Node: intake\nline two");
});

test("validateImages refuses malformed input without echoing the data", () => {
  const secretish = "AAAA-not-base64!!";
  for (const images of [undefined, [], "x", [null], [{ mime: "image/gif", dataBase64: "AAAA" }], [{ mime: "image/png", dataBase64: "" }], [{ mime: "image/png", dataBase64: secretish }], [{ mime: "image/png" }], Array.from({ length: 11 }, () => asImage(PNG, "image/png")), [{ mime: "image/png", dataBase64: "A".repeat(8 * 1024 * 1024) }]]) {
    assert.throws(() => validateImages(images), (error) => error.code === "INVALID_ARGUMENT" && !error.message.includes(secretish));
  }
  assert.doesNotThrow(() => validateImages([asImage(PNG, "image/png")]));
});

test("argv: --input-format stream-json only with images, and never any image data", () => {
  const plain = buildClaudeArgv({});
  assert.equal(plain.includes("--input-format"), false);
  assert.equal(buildClaudeArgv({ images: [] }).includes("--input-format"), false);
  const images = [asImage(PNG, "image/png")];
  const argv = buildClaudeArgv({ images });
  assert.deepEqual(argv.slice(argv.indexOf("--input-format"), argv.indexOf("--input-format") + 2), ["--input-format", "stream-json"]);
  assert.equal(argv.join(" ").includes(images[0].dataBase64), false);
});

async function turn(scenario, options) {
  const dir = tempDir();
  const scenarioFile = join(dir, "scenario.json");
  const recordFile = join(dir, "record.json");
  writeFileSync(scenarioFile, JSON.stringify({ record: recordFile, ...scenario }));
  const result = await runClaudeTurn({ prompt: "Node: intake\nGoal: look", cwd: dir, deadlineMs: 20_000, env: hostEnv, claudePath: process.execPath, claudeArgs: [FAKE, "--fake-scenario", scenarioFile], ...options });
  return { result, record: () => JSON.parse(readFileSync(recordFile, "utf8")) };
}

test("the child receives exactly the image bytes on stdin (sha256 of the decoded data), text last, nothing in argv", async () => {
  const { result, record } = await turn({}, { images: [asImage(PNG, "image/png"), asImage(JPG, "image/jpeg")] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const seen = record();
  assert.equal(seen.inputFormat, "stream-json");
  assert.deepEqual(seen.blockTypes, ["image", "image", "text"]);
  assert.deepEqual(seen.images.map((image) => [image.mediaType, image.decodedBytes, image.decodedSha256]), [["image/png", PNG.length, sha(PNG)], ["image/jpeg", JPG.length, sha(JPG)]]);
  assert.ok(seen.argv.includes("--input-format"));
  assert.equal(seen.argv.join(" ").includes(PNG.toString("base64").slice(0, 30)), false);
  assert.ok(seen.stdinBytes > PNG.length + JPG.length, "the images travelled on stdin");
});

test("the prompt text still reaches the child in image mode (protocol answer parses the Node line)", async () => {
  const { result } = await turn({ protocol: true }, { images: [asImage(PNG, "image/png")] });
  assert.equal(result.ok, true);
  assert.match(result.resultText, /Done with intake/);
});

test("without images the turn is unchanged: plain text on stdin, no input format", async () => {
  const { result, record } = await turn({}, {});
  assert.equal(result.ok, true);
  const seen = record();
  assert.equal(seen.inputFormat, undefined);
  assert.equal(seen.argv.includes("--input-format"), false);
});

test("a child that rejects images fails the turn; invalid images fail before any child starts", async () => {
  const rejected = await turn({ rejectImages: true }, { images: [asImage(PNG, "image/png")] });
  assert.equal(rejected.result.ok, false);
  assert.ok(rejected.result.error);
  let spawned = 0;
  const bad = await runClaudeTurn({ prompt: "p", cwd: tempDir(), env: hostEnv, claudePath: process.execPath, claudeVersion: "2.1.5", images: [{ mime: "image/gif", dataBase64: "AAAA" }], spawn: () => { spawned += 1; throw new Error("must not spawn"); } });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.class, "invalid-request");
  assert.equal(spawned, 0);
});

// --- executor ---------------------------------------------------------------------------------------

const SID = "abcd1234-ef56-4789-8abc-def012345678";
const OK = (extra = {}) => ({ ok: true, providerSessionId: SID, model: "claude-sonnet-5-5", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: null, cacheCreationTokens: null }, toolEvents: [], resultText: "```json\n{\"v\":1,\"type\":\"wait\",\"ms\":0}\n```", costUsd: null, error: null, exitCode: 0, killed: false, malformedLines: 0, ...extra });
const ctx = (attempt = 1) => ({ runId: "r1", goal: "g", node: "intake", attempt, step: 0, feedback: null, signal: undefined });

function executor({ turns, fallback = [] } = {}) {
  const calls = [];
  const sent = [];
  let loads = 0;
  const items = [{ id: `img_${sha(PNG).slice(0, 12)}`, sha256: sha(PNG), bytes: PNG.length }, { id: `img_${sha(JPG).slice(0, 12)}`, sha256: sha(JPG), bytes: JPG.length }];
  const exec = createClaudeExecutor({
    graph: deliveryGraph, cwd: process.cwd(), runId: "r1", runDir: tempDir(), configDir: "/cfg", claude: { claudeVersion: "2.1.5" },
    routing: { default: "claude-sonnet-5-5", effort: null, fallback, stages: {} },
    runTurn: async (options) => { calls.push(options); return (turns ?? [OK()])[Math.min(calls.length - 1, (turns ?? [OK()]).length - 1)]; },
    attachments: { items, load: () => { loads += 1; return [asImage(PNG, "image/png"), asImage(JPG, "image/jpeg")]; } },
    onAttachmentsSent: (ids) => sent.push(ids),
  });
  return { exec, calls, sent, items, loads: () => loads };
}

test("executor: images ride the FIRST turn only; later turns carry none; the sent hook fires once", async () => {
  const { exec, calls, sent, items, loads } = executor();
  await exec.decide(ctx(1), await exec.observe(ctx(1)));
  await exec.decide(ctx(2), await exec.observe(ctx(2)));
  await exec.decide(ctx(3), await exec.observe(ctx(3)));
  assert.equal(calls.length, 3);
  assert.equal(calls[0].images.length, 2);
  assert.equal(calls[1].images, undefined);
  assert.equal(calls[2].images, undefined);
  assert.equal(loads(), 1, "the stored copies are read once");
  assert.deepEqual(sent, [items.map((item) => item.id)]);
});

test("executor: attachments.sent records counts, sizes and hash prefixes, never bytes", async () => {
  const { exec, items } = executor();
  await exec.decide(ctx(1), await exec.observe(ctx(1)));
  const events = exec.drainEvents().filter((event) => event.type === "attachments.sent");
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: "attachments.sent", node: "intake", count: 2, bytes: PNG.length + JPG.length, turnOk: true, sha256: items.map((item) => item.sha256.slice(0, 12)).join(",") });
  const text = JSON.stringify(events);
  assert.equal(text.includes(PNG.toString("base64").slice(0, 20)), false);
});

test("executor: a failed first turn keeps the images pending (they go again on the fallback turn)", async () => {
  const failure = { ok: false, error: { class: "rate-limit", message: "slow down", remediation: "wait", retryable: true }, providerSessionId: null, usage: {}, toolEvents: [], resultText: "", exitCode: 1, killed: false, malformedLines: 0 };
  const { exec, calls, sent } = executor({ turns: [failure, OK()], fallback: ["claude-haiku-5-5"] });
  await exec.decide(ctx(1), await exec.observe(ctx(1)));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].images.length, 2);
  assert.equal(calls[1].images.length, 2, "the images were not confirmed received, so they are sent again");
  assert.equal(sent.length, 1);
  const events = exec.drainEvents().filter((event) => event.type === "attachments.sent");
  assert.deepEqual(events.map((event) => event.turnOk), [false, true]);
});

test("executor: unreadable stored images stop the run with a clear failure, no turn starts", async () => {
  const calls = [];
  const exec = createClaudeExecutor({
    graph: deliveryGraph, cwd: process.cwd(), runId: "r1", runDir: tempDir(), configDir: "/cfg", claude: { claudeVersion: "2.1.5" },
    runTurn: async (options) => { calls.push(options); return OK(); },
    attachments: { items: [{ id: "img_000000000000", sha256: "0".repeat(64), bytes: 1 }], load: () => { throw new Error("hash mismatch"); } },
  });
  const observation = await exec.observe(ctx(1));
  await assert.rejects(() => exec.decide(ctx(1), observation), (error) => error.class === "invalid-request" && /could not be read/.test(error.message));
  assert.equal(calls.length, 0);
});

test("executor without attachments behaves as before (no images option)", async () => {
  const calls = [];
  const exec = createClaudeExecutor({ graph: deliveryGraph, cwd: process.cwd(), runId: "r1", runDir: tempDir(), configDir: "/cfg", claude: { claudeVersion: "2.1.5" }, runTurn: async (options) => { calls.push(options); return OK(); } });
  await exec.decide(ctx(1), await exec.observe(ctx(1)));
  assert.equal("images" in calls[0], false);
});

test("executor: while images are pending the turn starts a FRESH provider session, and a failed image turn is never resumed", async () => {
  const failure = { ok: false, error: { class: "rate-limit", message: "slow down", remediation: "wait", retryable: true }, providerSessionId: SID, usage: {}, toolEvents: [], resultText: "", exitCode: 1, killed: false, malformedLines: 0 };
  const calls = [];
  const results = [failure, OK({ providerSessionId: "99999999-aaaa-4bbb-8ccc-dddddddddddd" }), OK()];
  const items = [{ id: `img_${sha(PNG).slice(0, 12)}`, sha256: sha(PNG), bytes: PNG.length }];
  const exec = createClaudeExecutor({
    graph: deliveryGraph, cwd: process.cwd(), runId: "r1", runDir: tempDir(), configDir: "/cfg", claude: { claudeVersion: "2.1.5" },
    routing: { default: "claude-sonnet-5-5", effort: null, fallback: ["claude-sonnet-5-5-b"], stages: {} },
    providerSessionId: SID, providerSessionModel: "claude-sonnet-5-5",
    runTurn: async (options) => { calls.push(options); return results[Math.min(calls.length - 1, results.length - 1)]; },
    attachments: { items, load: () => [asImage(PNG, "image/png")] },
  });
  await exec.decide(ctx(1), await exec.observe(ctx(1)));
  assert.equal(calls.length, 2);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.resume, undefined, "never resume a provider session while images are pending");
    assert.match(call.sessionId, /^[0-9a-f-]{36}$/);
    assert.equal(call.images.length, 1);
  }
  assert.notEqual(calls[0].sessionId, calls[1].sessionId);
  // after the image turn succeeded, the next turn resumes the NEW provider session and carries no images
  await exec.decide(ctx(2), await exec.observe(ctx(2)));
  assert.equal(calls[2].resume, "99999999-aaaa-4bbb-8ccc-dddddddddddd");
  assert.equal(calls[2].images, undefined);
});
