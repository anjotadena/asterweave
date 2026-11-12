// M2 live pipeline: capture wiring on the real run path (run start / --session with the Claude runner and a scripted turn
// seam), checkpoints, summaries, extraction, failure visibility. Temp user directories, a fake clock where time matters.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../src/args.mjs";
import { contextCommand } from "../src/commands/context.mjs";
import { memoryCommand } from "../src/commands/memory.mjs";
import { createRunCommand, resolveRepo, runCommandMeta } from "../src/commands/run.mjs";
import { readEvents as readMemoryEvents } from "../src/runtime/memory/capture.mjs";
import { latestValidCheckpoint, saveCheckpoint } from "../src/runtime/memory/checkpoints.mjs";
import { estimateTokens } from "../src/runtime/memory/context.mjs";
import { openMemory } from "../src/runtime/memory/db.mjs";
import { extractStatements } from "../src/runtime/memory/extract.mjs";
import { confirmItem, listItems } from "../src/runtime/memory/items.mjs";
import { attachMemory, createMemoryPipeline, pairExcerpts, sessionIdForRun } from "../src/runtime/memory/pipeline.mjs";
import { createStreamParser, EXCERPT_REDACT_MARGIN } from "../src/runtime/claude/stream.mjs";
import { runDir } from "../src/runtime/ledger.mjs";
import { createSession } from "../src/runtime/sessions.mjs";
import { grantTrust } from "../src/trust.mjs";
import { readEvents as readLedger } from "./loop-fixture.mjs";
import { cleanupAll, git, rawBytes, T0, tempDir, track, world } from "./memory-fixture.mjs";

after(cleanupAll);

const FAKE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const SID = "11111111-2222-4333-8444-555555555555";
const SETTINGS = { historyRetentionDays: 30, summaryRetentionDays: 30 };
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};
const fence = "```";

/** A scripted claude turn: answers the protocol of buildPrompt (evidence per required kind, then complete). */
function scriptedTurns(prompts, { onTurn, tools = true } = {}) {
  return async (opts) => {
    prompts.push(opts.prompt);
    await onTurn?.(opts, prompts.length);
    const line = (label) => new RegExp(`^${label}: (.*)$`, "m").exec(opts.prompt)?.[1]?.trim();
    const kinds = (line("Required evidence") ?? "none").split(",").map((kind) => kind.trim()).filter((kind) => kind && kind !== "none");
    const artifact = line("Artifact evidence needing sha256");
    const blocks = kinds.map((kind) => JSON.stringify({ v: 1, type: "evidence", evidence: { kind, summary: `${kind} ok`, result: "pass", ...(kind === artifact ? { sha256: createHash("sha256").update(String(line("Node"))).digest("hex") } : {}) } }));
    blocks.push(JSON.stringify({ v: 1, type: "complete", outcome: "pass" }));
    return {
      ok: true, providerSessionId: SID, model: "claude-sonnet-5-5", usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 },
      toolEvents: tools ? [{ id: `tu_${prompts.length}`, name: "Read", inputSummary: "file_path=README.md", at: new Date().toISOString() }] : [], toolResults: tools ? 1 : 0,
      resultText: `Done with ${line("Node")}.\n\n${blocks.map((block) => `${fence}json\n${block}\n${fence}`).join("\n\n")}`, costUsd: 0, error: null, exitCode: 0, killed: false, malformedLines: 0, durationMs: 1,
    };
  };
}

let sharedRepo;
function repoDir() {
  if (sharedRepo) return sharedRepo;
  sharedRepo = tempDir("aw-mp-repo-");
  git(sharedRepo, "init", "-b", "main");
  writeFileSync(join(sharedRepo, "README.md"), "hello\n");
  git(sharedRepo, "add", "README.md");
  git(sharedRepo, "commit", "-m", "initial");
  return sharedRepo;
}

async function cliFixture(envExtra = {}) {
  const userDir = tempDir("aw-mp-user-");
  const env = { ...Object.fromEntries(["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]])), ASTERWEAVE_CONFIG_DIR: userDir, ...envExtra };
  const scenarioFile = join(userDir, "scenario.json");
  writeFileSync(scenarioFile, JSON.stringify({ sessionId: SID }));
  grantTrust(repoDir(), { env });
  const identity = await resolveRepo({ cwd: repoDir(), env });
  return { userDir, env, identity, claude: { claudePath: process.execPath, claudeArgs: [FAKE, "--fake-scenario", scenarioFile] } };
}

async function runCmd(fx, argv, { runTurn, extra = {}, memory } = {}) {
  const stdout = sink();
  const stderr = sink();
  const parsed = parseArgs(argv, { boolean: [...runCommandMeta.boolean, "help", "version"] });
  const handler = createRunCommand({ claude: fx.claude, runTurn, loopOptions: { sleep: async () => {} }, ...(memory ? { memory } : {}) });
  const code = await handler({ stdin: sink(), stdout, stderr, env: fx.env, cwd: repoDir(), name: "run", argv, ...parsed, ...extra });
  let body = null;
  try { body = JSON.parse(stdout.text()); } catch { /* text */ }
  return { code, out: stdout.text(), err: stderr.text(), body };
}

const openStore = (fx) => track(openMemory({ userDir: fx.userDir, create: false }));

test("live run path: run start captures the goal, replies and tool calls incrementally; a later run in the same session gets a delimited memory section", async () => {
  const fx = await cliFixture();
  const fileSession = createSession({ repoKey: fx.identity.key, workspace: repoDir(), branch: "main", title: "memory", goal: "add a cache" }, { env: fx.env }).session.id;
  const prompts = [];
  let midRunEvents = null;
  const first = await runCmd(fx, ["start", "We decided to use Redis for the session cache. Add caching to the registry lookup", "--session", fileSession, "--run-id", "run-mem-1", "--json"], {
    runTurn: scriptedTurns(prompts, { onTurn: (_opts, n) => {
      if (n !== 2) return;
      const mem = openStore(fx); // incremental: the first turn is already stored while the run is still going
      midRunEvents = readMemoryEvents(mem, sessionIdForRun("run-mem-1")).length;
      mem.close();
    } }),
  });
  assert.ok(first.body, first.out + first.err);
  assert.equal(first.body.memory, undefined, "nothing degraded, nothing claimed");
  assert.ok(midRunEvents >= 4, `goal + first turn (tool call, result marker, reply) stored before the run ended, saw ${midRunEvents}`);
  if (process.env.DBG) console.log(prompts[0].slice(prompts[0].indexOf("<asterweave")));
  assert.ok(!prompts[0].includes("<asterweave-memory>"), "a first turn with nothing relevant stored gets no section");

  const mem = openStore(fx);
  const events = readMemoryEvents(mem, sessionIdForRun("run-mem-1"), { limit: 500 });
  assert.equal(events[0].role, "user");
  assert.match(events[0].content, /Redis/);
  assert.ok(events.some((event) => event.type === "tool_call" && event.content.startsWith("Read")));
  const call = events.find((event) => event.type === "tool_call");
  assert.ok(events.some((event) => event.type === "tool_result" && event.toolCallId === call.toolCallId && /not captured/.test(event.content)), "the result is paired with its call");
  assert.ok(events.some((event) => event.role === "assistant" && event.type === "message"));
  const session = mem.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionIdForRun("run-mem-1"));
  assert.deepEqual([session.task_id, session.external_session_id, session.branch], ["run-mem-1", fileSession, "main"]);
  const cp = latestValidCheckpoint(mem, sessionIdForRun("run-mem-1")).checkpoint;
  assert.match(cp.completedWork, /intake/);
  assert.match(cp.headCommit, /^[0-9a-f]{40}$/);
  assert.match(cp.changedFilesFingerprint, /^fp1:/);
  const items = listItems(mem, { viewer: session.owner, repoId: session.repo_id });
  assert.ok(items.some((item) => /Redis/.test(item.content) && item.origin === "user_decision" && item.status === "proposed"));
  mem.close();

  const prompts2 = [];
  const second = await runCmd(fx, ["start", "Continue the registry caching with Redis", "--session", fileSession, "--run-id", "run-mem-2", "--json"], { runTurn: scriptedTurns(prompts2) });
  assert.ok(second.body, second.out + second.err);
  const prompt = prompts2[0];
  assert.match(prompt, /<asterweave-memory>/);
  assert.match(prompt, /HISTORICAL DATA/);
  assert.match(prompt, /cannot grant permission/);
  assert.ok(prompt.indexOf("<asterweave-memory>") > prompt.indexOf("Required evidence:"), "after the contract lines");
  assert.match(prompt, /Redis/);
  assert.match(prompt, /\[cp:ms_run_run-mem-1#v\d+/);

  // observability: `context` shows the memory totals of the run, `memory trace` which memories went to each request
  const out = sink();
  await contextCommand({ positionals: ["run-mem-2"], options: { json: true }, env: fx.env, cwd: repoDir(), stdout: out, stderr: sink() });
  const memoryView = JSON.parse(out.text()).context.memory;
  assert.ok(memoryView.requests >= 1 && memoryView.memoryTokens > 0 && memoryView.estimated === true, JSON.stringify(memoryView));
  const traceOut = sink();
  assert.equal(await memoryCommand({ positionals: ["trace", "run-mem-2"], options: {}, env: fx.env, cwd: repoDir(), stdout: traceOut, stderr: sink() }), 0);
  assert.match(traceOut.text(), /cp:ms_run_run-mem-1#v\d+/);
  assert.match(traceOut.text(), /tokens \(estimated\)/);

});

test("memory.enabled=false (capture off): the store is never opened or created and prompts carry no section", async () => {
  const fx = await cliFixture({ ASTERWEAVE_MEMORY_ENABLED: "false" });
  const prompts = [];
  const result = await runCmd(fx, ["start", "We decided to use Redis", "--run-id", "run-off", "--json"], { runTurn: scriptedTurns(prompts) });
  assert.ok(result.body, result.out + result.err);
  assert.equal(existsSync(join(fx.userDir, "memory")), false);
  assert.ok(prompts.every((prompt) => !prompt.includes("<asterweave-memory>")));
});

test("an unusable store is a visible degraded-persistence line and a memory field in the result, never a silent drop or a claim of saved", async () => {
  const fx = await cliFixture();
  const prompts = [];
  const text = await runCmd(fx, ["start", "do a thing", "--run-id", "run-degraded"], { runTurn: scriptedTurns(prompts), extra: { loadSqlite: () => { throw new Error("no sqlite here"); } } });
  assert.match(text.err, /Memory: degraded persistence/);
  assert.match(text.err, /NOT fully saved/);
  assert.ok(readLedger(runDir(fx.identity.key, "run-degraded", { env: fx.env })).some((event) => event.type === "memory.status" && event.state === "degraded"), "the run ledger records it");
  const fx2 = await cliFixture();
  const json = await runCmd(fx2, ["start", "do a thing", "--run-id", "run-degraded-json", "--json"], { runTurn: scriptedTurns([]), extra: { loadSqlite: () => { throw new Error("no sqlite here"); } } });
  assert.equal(json.body.memory.degraded, true);
  assert.equal(json.body.memory.saved, 0);
  assert.ok(json.body.memory.reasons[0].includes("store could not be opened"));
});

// --- pipeline level ------------------------------------------------------------------------------------------------

const REMOTE = "https://github.com/acme/widgets.git";
const probeOf = (overrides = {}) => ({ verifiable: true, branch: "main", head: "a".repeat(40), fingerprint: "fp1:aaaa", worktreeId: "wt_1", dirtyCount: 0, ...overrides });
const runState = (status = "active", node = "analyze") => ({
  runId: "r1", goal: "Add caching to the registry lookup", status, currentNode: node, approvals: [],
  nodes: { intake: { status: "passed", attemptLog: [{ evidence: [{ kind: "task", result: "pass" }] }], failureSignatures: [] }, analyze: { status: "running", attemptLog: [], failureSignatures: [] } },
});

async function pipe(w, extra = {}) {
  let probe = extra.probeState ?? probeOf();
  const pipeline = await createMemoryPipeline({
    settings: { ...SETTINGS, ...(extra.settings ?? {}) }, storeOptions: { userDir: w.userDir, now: w.now }, repo: { cloneKey: "/clone/widgets", remote: REMOTE },
    runId: extra.runId ?? "r1", goal: extra.goal ?? "Add caching to the registry lookup", run: extra.run ?? runState(), workspace: "/clone/widgets", owner: w.owner,
    probe: async () => probe, externalSessionId: extra.externalSessionId ?? null, model: extra.model ?? "claude-sonnet-5-5", providerContextLost: extra.providerContextLost ?? false,
    ...(extra.summarizer ? { summarizer: extra.summarizer } : {}), onDegraded: extra.onDegraded,
  });
  pipeline.setProbe = (next) => { probe = next; };
  return pipeline;
}

const turn = (text, extra = {}) => ({ ok: true, resultText: text, toolEvents: [], toolResults: 0, model: "m", ...extra });

test("duplicate and interrupted turns are not duplicated: replay is idempotent, a cut-off reply is incomplete and upgraded once", async () => {
  const w = world();
  const p = await pipe(w);
  await p.onTurn({ node: "analyze", attempt: 1, iteration: 3, result: turn("partial answ", { killed: true }), interrupted: true });
  const sid = p.sessionId;
  const before = readMemoryEvents(w.mem, sid);
  assert.equal(before.at(-1).status, "incomplete");
  p.close();
  // the same turn re-driven by a new process (same run, node, attempt, iteration): same ids
  const again = await pipe(w);
  await again.onTurn({ node: "analyze", attempt: 1, iteration: 3, result: turn("partial answer, now complete", { toolEvents: [{ id: "tu_9", name: "Grep", inputSummary: "pattern=x" }], toolResults: 1 }) });
  const after2 = readMemoryEvents(w.mem, sid);
  const replies = after2.filter((event) => event.role === "assistant" && event.type === "message");
  assert.equal(replies.length, 1, "one reply, upgraded in place");
  assert.equal(replies[0].status, "complete");
  assert.equal(after2.filter((event) => event.type === "message" && event.role === "user").length, 1, "the goal is stored once across both processes");
  again.close();
});

test("checkpoints: deterministic from run state on start, transitions and finish; a stale writer cannot overwrite newer coverage", async () => {
  const w = world();
  const p = await pipe(w);
  p.onCommitted(runState("waiting-approval", "plan"), [{ type: "node.completed", node: "analyze" }]);
  await p.finish({ run: runState("waiting-approval", "plan") });
  const cp = latestValidCheckpoint(w.mem, p.sessionId).checkpoint;
  assert.match(cp.nextAction, /pending approval at plan/);
  assert.match(cp.completedWork, /intake \(evidence: task pass\)/);
  assert.equal(cp.headCommit, "a".repeat(40));
  assert.equal(cp.runningRefs.status, "waiting-approval");
  const stale = saveCheckpoint(w.mem, p.sessionId, { expectedVersion: cp.version - 1, coveredSeq: cp.coveredSeq, goal: "old" }, SETTINGS);
  assert.equal(stale.status, "stale_version");
  p.close();
});

test("concurrent summaries: an older summary can never overwrite newer coverage", () => {
  const w = world();
  const s = w.session();
  for (let i = 0; i < 6; i += 1) w.event(s.id, `message ${i}`);
  assert.equal(saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 6, summary: "covers six", summaryCoveredSeq: 6 }, SETTINGS).saved, true);
  // writer B read version 0 too and covers less: refused by version
  assert.equal(saveCheckpoint(w.mem, s.id, { expectedVersion: 0, coveredSeq: 6, summary: "covers three", summaryCoveredSeq: 3 }, SETTINGS).status, "stale_version");
  // writer B re-reads (version 1) but still covers less: refused by coverage
  assert.equal(saveCheckpoint(w.mem, s.id, { expectedVersion: 1, coveredSeq: 6, summary: "covers three", summaryCoveredSeq: 3 }, SETTINGS).status, "stale_summary");
  // a checkpoint without a summary carries the newer one forward
  assert.equal(saveCheckpoint(w.mem, s.id, { expectedVersion: 1, coveredSeq: 6, goal: "g" }, SETTINGS).saved, true);
  const cp = latestValidCheckpoint(w.mem, s.id).checkpoint;
  assert.deepEqual([cp.summary, cp.summaryCoveredSeq], ["covers six", 6]);
});

test("summaries: an unchanged idle session triggers zero summarizer calls; the threshold triggers one; failure degrades visibly and keeps events", async () => {
  const w = world();
  let calls = 0;
  const summarizer = { name: "counting", summarize: ({ events }) => { calls += 1; return `summary of ${events.length}`; } };
  const p = await pipe(w, { summarizer, settings: { summaryMinNewEvents: 5, summaryDebounceMinutes: 10 } });
  w.now.advance(3 * 60 * 60_000); // idle for hours: no timer, no call
  assert.equal(calls, 0);
  p.close();
  const again = await pipe(w, { summarizer, settings: { summaryMinNewEvents: 5, summaryDebounceMinutes: 10 } });
  assert.equal(calls, 0, "re-opening an unchanged session makes no call");
  for (let i = 0; i < 5; i += 1) await again.onTurn({ node: "analyze", attempt: 1, iteration: i, result: turn(`reply ${i}`) });
  assert.equal(calls, 1, "5 uncovered events reach the threshold once");
  const cp = latestValidCheckpoint(w.mem, again.sessionId).checkpoint;
  assert.match(cp.summary, /summary of/);
  assert.ok(cp.summaryCoveredSeq >= 5 && cp.summaryCoveredSeq <= cp.coveredSeq, "the summary watermark is within the checkpoint coverage");
  await again.onTurn({ node: "analyze", attempt: 1, iteration: 9, result: turn("one more") });
  assert.equal(calls, 1, "below threshold again: no call");
  again.close();

  const lines = [];
  const failing = await pipe(w, { summarizer: { name: "broken", summarize: () => { throw new Error("model down"); } }, settings: { summaryMinNewEvents: 1, summaryDebounceMinutes: 0 }, onDegraded: (line) => lines.push(line) });
  await failing.onTurn({ node: "analyze", attempt: 2, iteration: 1, result: turn("after the failure") });
  assert.match(lines.join("\n"), /degraded persistence \(summary: refresh failed/);
  assert.ok(readMemoryEvents(w.mem, failing.sessionId, { limit: 500 }).some((event) => event.content === "after the failure"), "events are kept");
  assert.equal(latestValidCheckpoint(w.mem, failing.sessionId).checkpoint.summary, cp.summary, "the last valid summary stays");
  assert.ok(failing.drainEvents().some((record) => record.type === "memory.status" && record.state === "degraded"));
  failing.close();
});

test("decision extraction: conservative user patterns propose; explicit switch supersedes a proposal; conflict disputes; a suggestion never touches a confirmation", async () => {
  assert.deepEqual(extractStatements("Should we use Redis? I am not sure.", "user"), []);
  assert.deepEqual(extractStatements("We will not switch to Redis.", "user"), []);
  assert.equal(extractStatements("Let's use pnpm for package management.", "user")[0].subject, "package management");
  assert.deepEqual(extractStatements("We decided to use Postgres", "assistant"), [], "assistant prose is not a decision");

  const w = world();
  const p = await pipe(w, { goal: "Let's use npm for package management." });
  let items = listItems(w.mem, { viewer: w.owner, repoId: w.repoId });
  assert.equal(items.length, 1);
  const first = items[0];
  assert.deepEqual([first.status, first.origin], ["proposed", "user_decision"]);
  p.close();
  const p2 = await pipe(w, { runId: "r2", goal: "Switch to pnpm for package management instead of npm." });
  items = listItems(w.mem, { viewer: w.owner, repoId: w.repoId });
  const old = items.find((item) => item.id === first.id);
  assert.equal(old.status, "superseded");
  const replacement = items.find((item) => item.supersedes === first.id);
  assert.match(replacement.content, /pnpm/);
  assert.equal(replacement.status, "proposed");
  assert.equal(confirmItem(w.mem, replacement.id, w.owner, { explicit: true }).changed, true);
  p2.close();
  const p3 = await pipe(w, { runId: "r3", goal: "Let's use yarn for package management." });
  items = listItems(w.mem, { viewer: w.owner, repoId: w.repoId });
  assert.equal(items.find((item) => item.id === replacement.id).status, "confirmed", "a confirmed decision is never changed automatically");
  assert.equal(items.find((item) => /yarn/.test(item.content)).status, "disputed", "the conflict is visible");
  await p3.onTurn({ node: "plan", attempt: 1, iteration: 1, result: turn("Recommendation: use bun for package management") });
  items = listItems(w.mem, { viewer: w.owner, repoId: w.repoId });
  const suggestion = items.find((item) => /bun/.test(item.content));
  assert.deepEqual([suggestion.origin, suggestion.status], ["assistant_suggestion", "proposed"]);
  assert.equal(items.find((item) => item.id === replacement.id).status, "confirmed");
  p3.close();
});

test("fake executor wiring: attachMemory builds a section per decision and captures the action; getters stay live", async () => {
  const w = world();
  const p = await pipe(w);
  let calls = 0;
  const inner = { id: "fake", get providerSessionId() { return `live-${calls}`; }, async observe() { return { objective: "Inspect" }; }, async decide() { calls += 1; return { v: 1, type: "complete", outcome: "pass" }; }, drainEvents: () => [{ type: "runner.turn" }] };
  const wrapped = attachMemory(inner, p);
  await wrapped.decide({ node: "analyze", attempt: 1, iteration: 1 }, await wrapped.observe({}));
  assert.equal(wrapped.providerSessionId, "live-1");
  assert.ok(readMemoryEvents(w.mem, p.sessionId).some((event) => event.role === "assistant" && event.content.includes('"complete"')));
  assert.deepEqual(wrapped.drainEvents({}).map((event) => event.type), ["runner.turn"]);
  p.close();
});

test("a seeded ~200-event session: the injected memory section is far smaller than a full replay (labelled estimates)", async () => {
  const w = world();
  const p = await pipe(w, { settings: { summaryMinNewEvents: 20, summaryDebounceMinutes: 0 } });
  for (let i = 0; i < 100; i += 1) {
    await p.onTurn({ node: "implement", attempt: 1, iteration: i, result: turn(`Step ${i}: edited registry module, ran the focused tests, all passing. ${"detail ".repeat(60)}`, { toolEvents: [{ id: `t${i}`, name: "Edit", inputSummary: `file_path=src/registry/${i}.mjs` }], toolResults: 1 }) });
  }
  const events = readMemoryEvents(w.mem, p.sessionId, { limit: 2000 });
  assert.ok(events.length >= 200, `seeded ${events.length} events`);
  const fullReplay = estimateTokens(events.map((event) => event.content).join("\n"));
  const section = p.context({ node: "implement", attempt: 2 }, { objective: "Continue the registry caching" }, { freshProviderSession: true });
  assert.ok(section, "a section is built");
  const memoryTokens = estimateTokens(section);
  const status = p.status();
  console.log(`[estimated tokens] full replay: ${fullReplay}; memory section: ${memoryTokens}; summary/extraction overhead: 0 (deterministic, no model call); summarizer calls: ${status.summarizerCalls}`);
  assert.ok(memoryTokens <= 4000, "within the default memory budget");
  assert.ok(memoryTokens * 5 < fullReplay, "far smaller than a full replay");
  p.close();
});

test("the clock seam: events and checkpoints use the injected UTC clock", async () => {
  const w = world({ start: T0 });
  const p = await pipe(w);
  assert.equal(readMemoryEvents(w.mem, p.sessionId)[0].eventTime, T0);
  p.close();
});

// --- bounded tool evidence (memory.toolResultExcerptChars) -----------------------------------------------------------

const GH = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const userEvent = (content) => `${JSON.stringify({ type: "user", message: { content } })}\n`;

test("stream parser: no excerpt option = tool output never read; with one, text blocks only, redacted BEFORE the cut, bounded, never emitted", () => {
  const blocks = [{ type: "tool_result", tool_use_id: "tu_1", is_error: true, content: [{ type: "text", text: `${"a".repeat(40)} ${GH} more` }, { type: "image", source: { type: "base64", data: "IMAGE_BYTES_MARKER" } }, { type: "text", text: "second block" }] }, { type: "tool_result", tool_use_id: "tu_2", content: "plain string output" }];
  const off = createStreamParser();
  off.push(userEvent(blocks));
  const offState = off.finish();
  assert.equal(offState.toolResults, 2);
  assert.equal(offState.toolResultExcerpts, undefined, "nothing is retained without the option");
  assert.ok(!JSON.stringify(offState).includes("aaaa"));

  const emitted = [];
  const on = createStreamParser({ toolResultExcerptChars: 50, onEvent: (event) => emitted.push(event) });
  on.push(userEvent(blocks));
  const state = on.finish();
  assert.equal(state.toolResults, 2, "counting is unchanged");
  const [first, second] = state.toolResultExcerpts;
  assert.equal(first.toolUseId, "tu_1");
  assert.equal(first.isError, true);
  assert.ok(first.excerpt.length <= 50 && first.excerptChars === first.excerpt.length);
  assert.equal(first.truncated, true);
  assert.equal(first.originalChars, 41 + GH.length + 5 + 1 + "second block".length, "the source length counts text blocks only");
  assert.ok(first.excerpt.includes("ghp_…") && !first.excerpt.includes("ghp_abc"), "a secret crossing the cut is redacted, not left as a short prefix");
  assert.ok(!JSON.stringify(state).includes("IMAGE_BYTES_MARKER"), "image blocks are never read");
  assert.deepEqual([second.excerpt, second.truncated, second.isError], ["plain string output", false, false]);
  assert.deepEqual(emitted.map((event) => event.kind), ["tool_result"]);
  assert.ok(!JSON.stringify(emitted).includes("plain string"), "the emitted event stays content-free");

  const huge = createStreamParser({ toolResultExcerptChars: 10 });
  huge.push(userEvent([{ type: "tool_result", tool_use_id: "t", content: "x".repeat(200_000) }]));
  const big = huge.finish().toolResultExcerpts[0];
  assert.deepEqual([big.excerpt.length, big.originalChars, big.truncated], [10, 200_000, true]);
  assert.ok(EXCERPT_REDACT_MARGIN >= 1024);
});

test("pipeline: excerpts are paired by id then order, stored redacted with source-length metadata; limit 0 stores only the marker", async () => {
  assert.deepEqual(pairExcerpts([{ id: "a" }, { id: "b" }, { id: "c" }], [{ toolUseId: "b", excerpt: "B" }, { toolUseId: "zz", excerpt: "Z" }]).map((x) => x?.excerpt ?? null), ["Z", "B", null]);
  const w = world();
  const p = await pipe(w);
  assert.equal(p.toolResultExcerptChars, 2000);
  await p.onTurn({ node: "analyze", attempt: 1, iteration: 1, result: turn("read two files", {
    toolEvents: [{ id: "tu_a", name: "Read", inputSummary: "file_path=a" }, { id: "tu_b", name: "Read", inputSummary: "file_path=b" }], toolResults: 2,
    toolResultExcerpts: [{ toolUseId: "tu_b", isError: true, excerpt: "B failed", originalChars: 8, excerptChars: 8, truncated: false }, { toolUseId: "tu_a", isError: false, excerpt: `A head ${GH} tail`, originalChars: 9000, excerptChars: 60, truncated: true }],
  }) });
  const results = readMemoryEvents(w.mem, p.sessionId).filter((event) => event.type === "tool_result");
  const a = results.find((event) => event.toolCallId === "tu_a");
  const b = results.find((event) => event.toolCallId === "tu_b");
  assert.match(a.content, /^\[tool result: excerpt of \d+ of 9000 chars, truncated\]\nA head /);
  assert.deepEqual([a.truncated, a.originalChars], [true, 9000]);
  assert.match(b.content, /^\[tool result \(error\): excerpt of 8 of 8 chars\]\nB failed$/);
  assert.equal(b.truncated, false);
  assert.ok(!rawBytes(w.mem).includes(GH), "the secret never reaches the database bytes");
  p.close();

  const off = await pipe(w, { runId: "r-off", settings: { toolResultExcerptChars: 0 } });
  assert.equal(off.toolResultExcerptChars, 0);
  await off.onTurn({ node: "analyze", attempt: 1, iteration: 1, result: turn("x", { toolEvents: [{ id: "tu_c", name: "Read", inputSummary: "" }], toolResults: 1, toolResultExcerpts: [{ toolUseId: "tu_c", excerpt: "OFF_MARKER", originalChars: 10 }] }) });
  const marker = readMemoryEvents(w.mem, off.sessionId).find((event) => event.type === "tool_result");
  assert.match(marker.content, /not captured/);
  assert.ok(!rawBytes(w.mem).includes("OFF_MARKER"));
  off.close();
});

function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map((name) => join(dir, String(name))).filter((file) => statSync(file).isFile());
}

test("end to end with the real stream parser: the excerpt is stored in memory only, never in the ledger, the run directory, the output or the traces", async () => {
  const fx = await cliFixture();
  const scenarioFile = fx.claude.claudeArgs[2];
  const text = `EVIDENCE_HEAD ${GH} ${"z".repeat(3000)} EVIDENCE_TAIL`;
  writeFileSync(scenarioFile, JSON.stringify({ sessionId: SID, protocol: true, toolUses: [{ id: "tu_e1", name: "Read", input: { file_path: "README.md" } }], toolResultContent: [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "IMAGE_DATA_MARKER" } }] }));
  const run = await runCmd(fx, ["start", "Inspect the README", "--run-id", "run-evidence", "--json"]);
  assert.ok(run.body, run.out + run.err);
  for (const out of [run.out, run.err]) assert.ok(!out.includes("EVIDENCE_HEAD") && !out.includes(GH));
  for (const file of filesUnder(runDir(fx.identity.key, "run-evidence", { env: fx.env }))) {
    const bytes = readFileSync(file, "latin1");
    assert.ok(!bytes.includes("EVIDENCE_HEAD") && !bytes.includes("zzzzzzzzzz"), `${file} holds no tool output`);
  }
  const mem = openStore(fx);
  const results = readMemoryEvents(mem, sessionIdForRun("run-evidence"), { limit: 500 }).filter((event) => event.type === "tool_result");
  assert.ok(results.length > 0);
  for (const event of results) {
    assert.match(event.content, /^\[tool result: excerpt of 2000 of \d+ chars, truncated\]\nEVIDENCE_HEAD /);
    assert.ok(!event.content.includes("EVIDENCE_TAIL"), "cut at the limit");
    assert.deepEqual([event.truncated, event.originalChars, event.toolCallId], [true, text.length, "tu_e1"]);
  }
  const raw = rawBytes(mem);
  assert.ok(!raw.includes(GH) && !raw.includes("IMAGE_DATA_MARKER"), "no secret and no image bytes on disk");
  const traces = JSON.stringify(mem.db.prepare("SELECT * FROM retrieval_traces").all());
  assert.ok(!traces.includes("EVIDENCE_HEAD"), "traces hold ids and numbers only");
  mem.close();

  // memory.toolResultExcerptChars = 0: the parser is never asked, only the marker is stored
  const fx0 = await cliFixture();
  writeFileSync(join(fx0.userDir, "config.json"), JSON.stringify({ memory: { toolResultExcerptChars: 0 } }));
  writeFileSync(fx0.claude.claudeArgs[2], JSON.stringify({ sessionId: SID, protocol: true, toolUses: [{ id: "tu_e1", name: "Read", input: {} }], toolResultContent: text }));
  assert.ok((await runCmd(fx0, ["start", "Inspect the README", "--run-id", "run-evidence-0", "--json"])).body);
  const mem0 = openStore(fx0);
  assert.ok(readMemoryEvents(mem0, sessionIdForRun("run-evidence-0"), { limit: 500 }).filter((event) => event.type === "tool_result").every((event) => /not captured/.test(event.content)));
  assert.ok(!rawBytes(mem0).includes("EVIDENCE_HEAD"));
  mem0.close();
});

test("dev fake runner (ASTERWEAVE_DEV_EXECUTORS=1, --runner fake): captures like the Claude runner and a second run gets a memory section", async () => {
  const fx = await cliFixture({ ASTERWEAVE_DEV_EXECUTORS: "1" });
  const script = join(fx.userDir, "script.json");
  writeFileSync(script, JSON.stringify({ v: 1, steps: [] }));
  const sections = [];
  const { runLoop } = await import("../src/runtime/loop.mjs");
  const runLoopImpl = async (options) => {
    const result = await runLoop(options);
    sections.push(options.executor.lastMemorySection?.() ?? null);
    return result;
  };
  const call = async (goal, runId) => {
    const parsed = parseArgs(["start", goal, "--runner", "fake", "--script", script, "--run-id", runId, "--json"], { boolean: [...runCommandMeta.boolean, "help", "version"] });
    const handler = createRunCommand({ runLoopImpl, loopOptions: { sleep: async () => {} } });
    const out = sink();
    await handler({ stdin: sink(), stdout: out, stderr: sink(), env: fx.env, cwd: repoDir(), name: "run", ...parsed });
    return JSON.parse(out.text());
  };
  const first = await call("We decided to use Redis for the session cache. Add caching to the registry lookup", "run-fake-1");
  assert.equal(first.memory, undefined, "nothing degraded");
  const mem = openStore(fx);
  const events = readMemoryEvents(mem, sessionIdForRun("run-fake-1"), { limit: 200 });
  assert.match(events[0].content, /Redis/, "the goal is captured");
  assert.ok(events.some((event) => event.role === "assistant" && event.type === "message"), "the scripted action is captured");
  assert.ok(latestValidCheckpoint(mem, sessionIdForRun("run-fake-1")).checkpoint, "a checkpoint is written");
  mem.close();
  await call("Continue the Redis session cache for the registry lookup", "run-fake-2");
  assert.match(String(sections.at(-1)), /<asterweave-memory>[\s\S]*Redis/, "the second run's decision got a memory section");
});

test("the excerpt option reaches the turn only with a live pipeline: memory off asks for nothing", async () => {
  for (const [envExtra, expected] of [[{}, 2000], [{ ASTERWEAVE_MEMORY_ENABLED: "false" }, undefined]]) {
    const fx = await cliFixture(envExtra);
    const seen = [];
    const inner = scriptedTurns([]);
    await runCmd(fx, ["start", "Inspect", "--run-id", `run-opt-${expected ?? "off"}`, "--json"], { runTurn: async (opts) => { seen.push(opts.toolResultExcerptChars); return inner(opts); } });
    assert.ok(seen.length > 0 && seen.every((value) => value === expected), `${JSON.stringify(envExtra)}: ${seen}`);
  }
});
