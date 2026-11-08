// TUI /context /usage /attachments /image: slash completion, honest unknowns, sanitised and bounded output, resize and
// non-TTY safety. Fake terminal helpers; the attachment store is a fake; no model is ever called.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { createSessionViews } from "../src/commands/context.mjs";
import { resolveRepo } from "../src/commands/run.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { createSession as createStoredSession } from "../src/runtime/sessions.mjs";
import { createStyle, stripAnsi } from "../src/tui/render.mjs";
import { HINT_LINE, SLASH_COMMANDS, renderSessionScreen } from "../src/tui/screens.mjs";
import { createSession, withTerminal } from "../src/tui/session.mjs";
import { SEQ, createTerminal } from "../src/tui/terminal.mjs";
import { deliveryGraph, wait } from "./loop-fixture.mjs";
import { cleanupTemp, fakeTerminal, git, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);
const plain = createStyle({ env: {}, isTTY: false });
const ESC = String.fromCharCode(27);

function harness({ views, columns = 100, rows = 40, tty = true } = {}) {
  const term = fakeTerminal({ columns, rows, tty });
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  let session;
  const running = withTerminal({ terminal, stdin: term.stdin, proc }, ({ input }) => {
    session = createSession({ terminal, input, style: plain, version: "1.2.3", repo: "acme/widgets", branch: "main", banner: [], views });
    return session.run();
  });
  const frames = () => term.text().split(SEQ.clear).length - 1;
  const last = () => stripAnsi(term.text().split(SEQ.clear).at(-1));
  const ready = waitFor(() => frames() > 0, { label: "first frame" });
  /** Type a line and wait until `expected` shows (the view result arrives asynchronously). */
  const command = async (line, expected) => {
    term.stdin.write(`${line}\r`);
    await waitFor(() => last().includes(expected), { label: `${line} -> ${expected}` });
    return last();
  };
  return { term, running, session: () => session, frames, last, ready, command };
}

async function leave(h) {
  h.term.stdin.write("\x03");
  await h.running;
}

// --- slash completion ---------------------------------------------------------------------------------------------

test("slash completion lists /context /usage /attachments /image; the hint line names /context", async () => {
  const h = harness();
  await h.ready;
  h.term.stdin.write("/");
  await waitFor(() => h.last().includes("Commands"));
  for (const name of ["/context", "/usage", "/attachments", "/image", "/commands", "/exit"]) assert.ok(h.last().includes(name), name);
  assert.ok(h.last().includes("context size, usage and budgets"));
  assert.ok(HINT_LINE.includes("/context"));
  assert.equal(HINT_LINE.includes("add context (@)"), false);
  assert.ok(HINT_LINE.includes("@context add context"), "@ still adds context");
  assert.deepEqual(SLASH_COMMANDS.map(({ name }) => name).filter((name) => ["/context", "/usage", "/attachments", "/image"].includes(name)).sort(), ["/attachments", "/context", "/image", "/usage"]);
  h.term.stdin.write("a");
  await waitFor(() => !h.last().includes("context size, usage and budgets"));
  assert.ok(h.last().includes("/attachments"));
  await leave(h);
});

test("/commands lists the new commands", async () => {
  const h = harness();
  await h.ready;
  const screen = await h.command("/commands", "Commands:");
  for (const name of ["/context", "/usage", "/attachments", "/image"]) assert.ok(screen.includes(name), name);
  await leave(h);
});

// --- no run yet ---------------------------------------------------------------------------------------------------

test("without views: /context and /usage say 'no run yet' with unknown values; /attachments and /image say there is no session", async () => {
  const h = harness();
  await h.ready;
  const context = await h.command("/context", "Context size: unknown");
  assert.ok(context.includes("Context and usage: no run yet"));
  assert.match(context, /Cumulative usage: in unknown, out unknown, cache read unknown, cache creation unknown, total unknown/);
  assert.match(context, /Budget remaining: tokens unknown/);
  assert.doesNotMatch(context, /in 0\b|total 0\b/);
  const usage = await h.command("/usage", "Nothing has been measured yet.");
  assert.ok(usage.includes("Usage of no run yet"));
  await h.command("/attachments", "There is no active session to attach images to.");
  await h.command("/image C:/x/y.png", "There is no active session to attach images to.");
  await h.command("/image", "Usage: /image <path>");
  await leave(h);
});

// --- a fixture run: measured and unknown ----------------------------------------------------------------------------

let repoPath;
function repoDir() {
  if (repoPath) return repoPath;
  repoPath = tempDir("aw-tc-repo-");
  git(repoPath, "init", "-b", "main");
  writeFileSync(join(repoPath, "README.md"), "hello\n");
  git(repoPath, "add", "README.md");
  git(repoPath, "commit", "-m", "initial");
  return repoPath;
}
const envFor = (userDir) => {
  const env = { ASTERWEAVE_CONFIG_DIR: userDir };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
};
const HASH = "e".repeat(64);
const staged = { id: "img_eeeeeeeeeeee", sha256: HASH, format: "png", bytes: 4096, width: 64, height: 48, name: "shot.png" };

async function fixtureRun({ usage, policy, title }) {
  const userDir = tempDir("aw-tc-user-");
  const env = envFor(userDir);
  if (policy) writeFileSync(join(userDir, "policy.json"), JSON.stringify(policy));
  const identity = await resolveRepo({ cwd: repoDir(), env });
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: { key: identity.key, realpath: identity.workspace }, runId: "run-t", env });
  const executor = { ...createFakeExecutor({ v: 1, steps: [{ node: "intake", action: wait(0) }, { node: "intake", action: wait(0) }] }), ...(usage ? { usage } : {}) };
  await runLoop({ dir, graph: deliveryGraph, executor, sleep: async () => {}, workspaceRoot: identity.workspace, guardOptions: { env, userDir } });
  const session = title === undefined ? null : createStoredSession({ repoKey: identity.key, workspace: identity.workspace, title }, { env }).session;
  return { env, identity, session };
}

function liveViews({ env, identity }, api) {
  return createSessionViews({ env, attachmentsApi: api }, { repoKey: identity.key });
}

test("/context for a fixture run: three separate numbers, measured values numeric, unknown values 'unknown'", async () => {
  const fx = await fixtureRun({ usage: () => ({ inputTokens: 100, outputTokens: 20, contextTokens: 640, model: "claude-sonnet-5-5" }) });
  const h = harness({ views: liveViews(fx, { listAttachments: () => [] }) });
  await h.ready;
  const screen = await h.command("/context", "Full report: asterweave context");
  assert.match(screen, /Context and usage: run run-t/);
  assert.match(screen, /Context size: 640 tokens at \w[\w-]* \(measured, latest, not a sum\)/);
  assert.match(screen, /window unknown \(none documented\), used unknown/);
  assert.match(screen, /Cumulative usage: in 300, out 60, cache read unknown, cache creation unknown, total 360/);
  assert.match(screen, /Budget remaining: tokens 360 \(no limit\); tool calls \d+\/200 \(\d+ left\)/);
  assert.match(screen, /Attachments: 0 staged, 0 sent/);
  const lines = screen.split("\n").filter((line) => /^(Context size|Cumulative usage|Budget remaining)/.test(line));
  assert.equal(lines.length, 3, "three separate lines for the three numbers");
  assert.notEqual(lines[0], lines[1]);
  await leave(h);
});

test("/usage for a run that reported nothing shows unknown, never 0", async () => {
  const fx = await fixtureRun({});
  const h = harness({ views: liveViews(fx, { listAttachments: () => [] }) });
  await h.ready;
  const screen = await h.command("/usage", "Full report: asterweave usage");
  assert.match(screen, /input unknown, output unknown/);
  assert.match(screen, /total \(budget counter\) unknown/);
  assert.match(screen, /context size unknown/);
  assert.match(screen, /nodes: no usage recorded/);
  assert.doesNotMatch(screen, /input 0\b|total \(budget counter\) 0\b/);
  await leave(h);
});

test("/context with an exhausted token budget shows 0 left, EXHAUSTED", async () => {
  const policy = { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["x"], tools: ["read"], operations: [], budgets: { tokens: 100 } } };
  const fx = await fixtureRun({ usage: () => ({ inputTokens: 80, outputTokens: 40 }), policy });
  const h = harness({ views: liveViews(fx, { listAttachments: () => [] }) });
  await h.ready;
  const screen = await h.command("/context", "EXHAUSTED");
  assert.match(screen, /tokens 360\/100 \(0 left, EXHAUSTED\)/);
  await leave(h);
});

test("/attachments and /image through the session store seam: hashes and sizes only, nothing sent", async () => {
  const fx = await fixtureRun({ title: "images" });
  const calls = [];
  const api = {
    listAttachments: (id) => { calls.push(["list", id]); return [staged]; },
    addAttachment: (id, source) => { calls.push(["add", id, source]); return { ok: true, attachment: staged, problems: [] }; },
  };
  const h = harness({ views: liveViews(fx, api) });
  await h.ready;
  const list = await h.command("/attachments", "1 staged image(s)");
  assert.ok(list.includes("img_eeeeeeeeeeee") && list.includes("shot.png") && list.includes("4.0 KiB") && list.includes("64x48"));
  assert.ok(list.includes(`sha256 ${"e".repeat(12)}`));
  assert.equal(list.includes(HASH), false, "only a hash prefix");
  const added = await h.command('/image "C:/pics/my shot.png"', "Staged on session");
  assert.ok(h.session().transcript.join("\n").includes("nothing was sent now"));
  assert.ok(added.includes(`Staged on session ${fx.session.id}`));
  assert.deepEqual(calls.find((call) => call[0] === "add"), ["add", fx.session.id, "C:/pics/my shot.png"]);
  await leave(h);
});

test("a refused or throwing image store is reported, the session keeps running", async () => {
  const fx = await fixtureRun({ title: "bad" });
  const api = { listAttachments: () => [], addAttachment: (id, source) => { if (source === "boom") throw new Error("disk full"); return { ok: false, attachment: null, problems: ["not a PNG, JPEG or WebP image"] }; } };
  const h = harness({ views: liveViews(fx, api) });
  await h.ready;
  const refused = await h.command("/image nope.gif", "Image not staged:");
  assert.ok(refused.includes("not a PNG, JPEG or WebP image"));
  await h.command("/image boom", "Could not read this: disk full");
  await h.command("/usage", "Usage of");
  await leave(h);
});

// --- hostile and bounded output ---------------------------------------------------------------------------------------

test("hostile titles, models and view output are sanitised and bounded", async () => {
  const hostile = `${ESC}[31mred${ESC}]0;pwn\u0007${ESC}[2J\u202e`;
  const fx = await fixtureRun({ usage: () => ({ inputTokens: 1, contextTokens: 2, model: "claude-sonnet-5-5" }), title: hostile });
  const real = liveViews(fx, { listAttachments: () => [{ ...staged, name: hostile }] });
  const views = {
    context: real.context,
    attachments: real.attachments,
    usage: () => [hostile, ...Array.from({ length: 100 }, (_, i) => `line ${i}`)],
    image: () => `not an array ${hostile}`,
  };
  const h = harness({ views });
  await h.ready;
  const raw = () => h.term.text().split(SEQ.clear).at(-1);
  await h.command("/context", "Context and usage");
  await h.command("/attachments", "1 staged image(s)");
  const usage = await h.command("/usage", "more line(s) not shown");
  assert.ok(usage.includes("61 more line(s) not shown"), "bounded to 40 lines");
  await h.command("/image x", "> /image x");
  const text = h.term.text();
  for (const bad of ["\u0007", "\u202e", `${ESC}]0;pwn`, `${ESC}[2J${ESC}[2J`]) assert.equal(raw().includes(bad), false, JSON.stringify(bad));
  assert.equal(h.session().transcript.join("\n").includes(ESC), false, "no escape reaches the transcript");
  assert.equal(h.term.errText(), "");
  assert.ok(text.length > 0);
  await leave(h);
});

test("a view that throws or never resolves does not break the session", async () => {
  const h = harness({ views: { context: () => { throw new Error("boom"); }, usage: () => new Promise(() => {}) } });
  await h.ready;
  await h.command("/context", "That view could not be read.");
  h.term.stdin.write("/usage\r");
  await waitFor(() => h.last().includes("> /usage"));
  h.term.stdin.write("/exit\r");
  assert.equal(await Promise.race([h.running, new Promise((resolve) => setTimeout(() => resolve("stuck"), 3000))]), 0);
});

test("a late view result after exit draws nothing and does not throw", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness({ views: { context: async () => { await gate; return ["late"]; } } });
  await h.ready;
  h.term.stdin.write("/context\r");
  await waitFor(() => h.last().includes("> /context"));
  h.term.stdin.write("/exit\r");
  assert.equal(await h.running, 0);
  const before = h.term.text().length;
  release();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.term.text().length, before, "nothing drawn after the terminal was restored");
});

test("results keep the order the commands were typed", async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve(["slow-result"]), 40));
  const h = harness({ views: { context: () => slow, usage: () => ["fast-result"] } });
  await h.ready;
  h.term.stdin.write("/context\r");
  h.term.stdin.write("/usage\r");
  await waitFor(() => h.last().includes("fast-result"));
  const transcript = h.session().transcript;
  assert.ok(transcript.indexOf("slow-result") < transcript.indexOf("fast-result"));
  await leave(h);
});

// --- resize and non-TTY --------------------------------------------------------------------------------------------

test("long view lines wrap on a narrow terminal and the frame keeps its size", async () => {
  const fx = await fixtureRun({ usage: () => ({ inputTokens: 5, outputTokens: 6, contextTokens: 7 }) });
  const h = harness({ views: liveViews(fx, { listAttachments: () => [] }), columns: 40, rows: 24 });
  await h.ready;
  await h.command("/context", "Full report");
  const lines = h.last().split("\n");
  assert.equal(lines.length, 24);
  assert.ok(lines.every((line) => [...line].length <= 40), "no line is wider than the terminal");
  h.term.stdout.columns = 60;
  h.term.stdout.emit("resize");
  await waitFor(() => h.last().split("\n").every((line) => [...line].length <= 60));
  await leave(h);
});

test("the pure screen renderer shows view output on tiny terminals without throwing", () => {
  const screen = renderSessionScreen({ version: "1", repo: "a/b", branch: "m", transcript: ["Context size: unknown"], width: 8, rows: 3, style: plain });
  assert.ok(screen.length > 0);
});

test("non-TTY: the session views are plain data (the interactive terminal is never entered for them)", async () => {
  const views = createSessionViews({ env: envFor(tempDir("aw-tc-nt-")) }, { repoKey: null });
  for (const name of ["context", "usage", "attachments"]) {
    const lines = await views[name]();
    assert.ok(Array.isArray(lines) && lines.every((line) => typeof line === "string" && !line.includes(ESC)));
  }
});
