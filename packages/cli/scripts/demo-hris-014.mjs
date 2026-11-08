#!/usr/bin/env node

// The HRIS-014 fixture demo: one task ("accrue leave balance monthly" for the Unexaro HRIS fixture repository) taken from sign-in to a
// "closable" verdict, plus the failure paths, with the REAL command handlers (runCli with the real registry) and injected seams.
//
// EVERYTHING HERE IS A FIXTURE. No live model (the runner talks to tests/fixtures/fake-claude.mjs), no live GitHub (an in-process fake
// `fetch`, tests/fixtures/fake-github.mjs) and no live MCP server (tests/fixtures/mcp-server.mjs). Every directory is a fresh temp
// directory; ASTERWEAVE_CONFIG_DIR is always one of them and the real user directory is never read or written.
//
//   node packages/cli/scripts/demo-hris-014.mjs          (or: npm run demo:hris-014)
//
// Prints PASS/FAIL per step, a fixture-vs-live coverage table, and exits non-zero if any step failed. Zero dependencies.

import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runCli } from "../src/cli.mjs";
import { registerAllCommands } from "../src/commands/index.mjs";
import { pipelineCommand } from "../src/commands/pipeline.mjs";
import { createRunCommand, resolveRepo } from "../src/commands/run.mjs";
import { runHooks } from "../src/runtime/hooks.mjs";
import { loadRun, runDir } from "../src/runtime/ledger.mjs";
import { loadSession } from "../src/runtime/sessions.mjs";
import { grantTrust } from "../src/trust.mjs";
import { createFakeGithub } from "../tests/fixtures/fake-github.mjs";
import { deliveryGraph, grantPending } from "../tests/loop-fixture.mjs";
import { fakeTerminal, git, waitFor } from "../tests/repo-fixture.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "tests", "fixtures");
const FAKE_CLAUDE = join(FIXTURES, "fake-claude.mjs");
const MCP_SERVER = join(FIXTURES, "mcp-server.mjs");
const SID = "11111111-2222-4333-8444-555555555555";
// 60 s by default; a heavily loaded CI machine may raise it with DEMO_TIME_LIMIT_SECONDS (the demo itself needs about 10 s).
const TIME_LIMIT_MS = Number.isInteger(Number(process.env.DEMO_TIME_LIMIT_SECONDS)) && Number(process.env.DEMO_TIME_LIMIT_SECONDS) >= 60 && Number(process.env.DEMO_TIME_LIMIT_SECONDS) <= 600 ? Number(process.env.DEMO_TIME_LIMIT_SECONDS) * 1000 : 60_000;
const TASK = "HRIS-014";
const GOAL = "HRIS-014: accrue leave balance monthly";

// --- harness -----------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
const sink = () => { const chunks = []; return { write: (text) => { chunks.push(String(text)); return true; }, text: () => chunks.join("") }; };
const NO_SPAWN = () => { throw new Error("spawn must not be called"); };
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const countType = (events, type) => events.filter((event) => event.type === type).length;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

let ROOT = null;
function newDir(name) {
  ROOT ??= realpathSync.native(mkdtempSync(join(tmpdir(), "aw-demo-")));
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** The repository fixture: a small HR system with an MCP server definition and a trusted-adapter required check. */
function makeHrisRepo(name) {
  const repo = newDir(name);
  const write = (file, text) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text); };
  const mcpScenario = join(repo, "..", `${name}-mcp-scenario.json`);
  writeFileSync(mcpScenario, "{}\n");
  write("README.md", "# Unexaro HRIS (fixture)\n\nHRIS-014: monthly leave balance accrual.\n");
  write("package.json", `${JSON.stringify({ name: "unexaro-hris", private: true, scripts: { test: "node --test" } }, null, 2)}\n`);
  write("src/hris/leave.js", "export const balance = (employee) => employee.leaveDays;\n");
  write("tests/leave.test.js", "// placeholder\n");
  write(".mcp.json", `${JSON.stringify({ mcpServers: { "hris-files": { command: process.execPath, args: [MCP_SERVER, mcpScenario] } } }, null, 2)}\n`);
  write(".claude/asterweave.json", `${JSON.stringify({ version: 1, completion: { requiredChecks: ["e2e"] } }, null, 2)}\n`);
  git(repo, "init", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  git(repo, "remote", "add", "origin", "https://github.com/unexaro/hris.git");
  return repo;
}

/** A user directory + environment + scenario files for one fake-claude. `claudeMissing` points the runner at a binary that does not exist. */
function makeWorld(name, { repo = null, scenario = { protocol: true }, config, policy, envExtra = {}, claudeMissing = false } = {}) {
  const root = newDir(name);
  const home = join(root, "home");
  const userDir = join(root, "user");
  mkdirSync(home, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  const env = { ASTERWEAVE_CONFIG_DIR: userDir, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "AppData") };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, envExtra);
  if (config) writeFileSync(join(userDir, "config.json"), JSON.stringify(config));
  if (policy) writeFileSync(join(userDir, "policy.json"), JSON.stringify(policy));
  const scenarioFile = join(root, "scenario.json");
  const recordFile = join(root, "record.json");
  const recordLog = join(root, "invocations.jsonl"); // fake-claude appends one line per started `claude` process: the model-call counter
  const world = {
    name, root, home, userDir, env, repo, scenarioFile, recordFile, recordLog,
    claude: claudeMissing ? { claudePath: join(root, process.platform === "win32" ? "no-such-claude.exe" : "no-such-claude") } : { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE, "--fake-scenario", scenarioFile] },
    setScenario: (next) => writeFileSync(scenarioFile, JSON.stringify({ record: recordFile, recordLog, sessionId: SID, ...next })),
    invocations: () => (existsSync(recordLog) ? readFileSync(recordLog, "utf8").split("\n").filter(Boolean).length : 0),
    trust: (dir = repo) => grantTrust(dir, { env }),
  };
  world.setScenario(scenario);
  return world;
}

/** Run one CLI invocation through runCli with the real registry; `run` gets the fake claude, `pipeline` gets the fake GitHub seams. */
async function cli(world, argv, { cwd = world.repo ?? world.root, stdin, io = {}, signal, pipeline, envExtra } = {}) {
  const registry = registerAllCommands(new Map());
  registry.get("run").handler = createRunCommand({ claude: world.claude, loopOptions: { sleep: async () => {} } });
  if (pipeline) registry.get("pipeline").handler = (ctx) => pipelineCommand({ ...ctx, pipelineSeams: pipeline.seams });
  const out = sink();
  const err = sink();
  const spawn = io.spawn ?? pipeline?.spawn;
  const code = await runCli(argv, { stdout: out, stderr: err, stdin: stdin ?? { isTTY: false }, env: { ...world.env, ...envExtra }, cwd, homedir: () => world.home, signal, ...io, ...(spawn ? { spawn } : {}) }, { commands: registry });
  const result = { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  pipeline?.outputs.push(result.out, result.err);
  return result;
}

/** `mcp test` on a fake terminal: answer `y` when the prompt shows (the stand-in for the human). */
async function ttyCli(world, argv, key = "y") {
  const terminal = fakeTerminal({ tty: true });
  const done = cli(world, argv, { stdin: terminal.stdin, io: { stdout: terminal.stdout, stderr: terminal.stderr } });
  let finished = false;
  done.then(() => { finished = true; });
  await waitFor(() => finished || /\[y\/N\]/.test(terminal.text()), { label: "the approval prompt" });
  const prompted = /\[y\/N\]/.test(terminal.text());
  if (!finished) terminal.stdin.write(key);
  const result = await done;
  return { code: result.code, out: terminal.text(), err: terminal.errText(), prompted };
}

async function runInfo(world, runId) {
  const identity = await resolveRepo({ cwd: world.repo, env: world.env });
  const dir = runDir(identity.key, runId, { env: world.env });
  return { identity, dir, load: () => loadRun(dir), run: () => loadRun(dir).run, events: () => loadRun(dir).events };
}

/** Steps run in order and print `PASS`/`FAIL`; a step returns detail lines. Exported for the test of the failure exit code. */
export async function runSteps(steps, { log = console.log, clock = Date.now } = {}) {
  const started = clock();
  const results = [];
  for (const { id, title, path, fn } of steps) {
    const t0 = clock();
    try {
      const notes = (await fn()) ?? [];
      results.push({ id, title, ok: true });
      log(`PASS  ${id}  ${title}  (${clock() - t0} ms)`);
      log(`        fixture: ${path}`);
      for (const note of notes) log(`        ${note}`);
    } catch (error) {
      results.push({ id, title, ok: false, error });
      log(`FAIL  ${id}  ${title}`);
      log(`        ${String(error?.message ?? error).split("\n").slice(0, 6).join("\n        ")}`);
    }
  }
  const failed = results.filter((result) => !result.ok);
  return { results, failed: failed.length, passed: results.length - failed.length, elapsedMs: clock() - started };
}

// --- the scenario ------------------------------------------------------------------------------------

export function buildSteps() {
  const S = {}; // state shared between steps
  const steps = [];
  const step = (id, title, path, fn) => steps.push({ id, title, path, fn });
  const TOKEN = ["gho", "_", "D".repeat(36)].join("");
  const HEAD = "a1".repeat(20);
  const MERGE = "b2".repeat(20);
  const PR = 14;
  const ISO = (ms) => new Date(ms).toISOString();

  // 01 auth ---------------------------------------------------------------------------------------------
  step("01", "auth validated (GitHub and model sign-in)", "fake `gh` and `claude` child processes answering `auth status`; no keychain, no network", async () => {
    const world = makeWorld("auth", { repo: null, envExtra: {} });
    world.env.PATH = newDir("auth-bin");
    world.env.Path = world.env.PATH;
    const spawn = (cmd, args) => {
      const child = new EventEmitter();
      child.pid = 4242;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = Object.assign(new EventEmitter(), { end() {} });
      child.kill = () => true;
      const isGh = /^gh(\.|$)/i.test(basename(cmd));
      const reply = isGh
        ? JSON.stringify({ hosts: { "github.com": [{ state: "success", active: true, host: "github.com", login: "unexaro-bot", tokenSource: "keyring", scopes: "gist, read:org, repo", gitProtocol: "https" }] } })
        : JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "dev@example.com", orgName: "Unexaro", subscriptionType: "max" });
      setImmediate(() => { child.stdout.emit("data", Buffer.from(reply)); child.emit("close", 0, null); });
      return child;
    };
    const result = await cli(world, ["auth", "status", "--json"], { cwd: world.root, io: { spawn, exists: (file) => /[\\/](gh|claude)(\.(exe|cmd|com))?$/i.test(file) } });
    assert.equal(result.code, 0, result.err + result.out);
    const body = result.json();
    assert.equal(body.planes.github.status, "ok");
    assert.equal(body.planes.model.status, "ok");
    assert.ok(!result.out.includes("dev@example.com"), "the account e-mail is masked");
    return [`github: ${body.planes.github.account}; model: ${body.planes.model.account}`];
  });

  // 02 repo + MCP + trust -------------------------------------------------------------------------------
  step("02", "repository connected", "a local git repository created in a temp directory; no clone, no network", async () => {
    const repo = makeHrisRepo("hris");
    S.repo = repo;
    S.main = makeWorld("main", {
      repo,
      scenario: { protocol: true, toolUses: [{ id: "tu_1", name: "Read", input: { file_path: "README.md" } }] },
      config: { model: { default: "claude-sonnet-5-5", effort: "high", fallback: ["claude-haiku-5-5"], stages: { plan: "claude-opus-5-5" } } },
    });
    const result = await cli(S.main, ["repo", "connect", "--repo", "unexaro/hris", "--branch", "main", "--path", repo, "--json"], { cwd: S.main.root });
    assert.equal(result.code, 0, result.err + result.out);
    assert.deepEqual([result.json().repository, result.json().branch, result.json().runner], ["unexaro/hris", "main", "local"]);
    return [`connected unexaro/hris (main) at ${repo}`];
  });

  step("03", "fixture MCP server configured, validated and tested", "tests/fixtures/mcp-server.mjs (real child process, tools listed, never called); approval by a fake terminal answering y", async () => {
    const main = S.main;
    const listed = await cli(main, ["mcp", "list", "--json"], { io: { spawn: NO_SPAWN } });
    assert.equal(listed.code, 0, listed.err + listed.out);
    assert.deepEqual(listed.json().servers.map((server) => `${server.source}:${server.name}`), ["project:hris-files"]);
    assert.equal(listed.json().servers[0].health, "not checked", "list only parses");
    const validated = await cli(main, ["mcp", "validate", "--json"], { io: { spawn: NO_SPAWN } });
    assert.equal(validated.code, 0, validated.err + validated.out);
    assert.deepEqual(validated.json().problems, []);
    main.trust(); // the user's `asterweave trust grant` (library call, the stand-in for the human)
    const approved = await ttyCli(main, ["mcp", "test", "hris-files"]);
    assert.equal(approved.code, 0, approved.err || approved.out);
    assert.ok(approved.prompted, "the approval was asked on a terminal");
    const again = await cli(main, ["mcp", "test", "hris-files", "--json"]);
    assert.equal(again.code, 0, again.err + again.out);
    assert.deepEqual(again.json().tools.map((tool) => tool.name), ["echo"]);
    assert.equal(again.json().approval, "existing");
    return ["mcp list/validate parse only (spawn forbidden); mcp test started the fixture, listed tools [echo], recorded an approval"];
  });

  step("04", "model route shown", "user config.json in the temp user directory; no provider is contacted (availability stays 'unverified')", async () => {
    const show = await cli(S.main, ["model", "show", "--json"]);
    assert.equal(show.code, 0, show.err + show.out);
    const body = show.json();
    assert.equal(body.routes.length, 13);
    assert.equal(body.routes.find((route) => route.node === "plan").model, "claude-opus-5-5");
    assert.equal(body.routes.find((route) => route.node === "intake").model, "claude-sonnet-5-5");
    const explain = await cli(S.main, ["model", "explain", "plan"]);
    assert.equal(explain.code, 0, explain.err + explain.out);
    assert.match(explain.out, /claude-opus-5-5/);
    return ["intake: claude-sonnet-5-5 (default); plan: claude-opus-5-5 (stage); fallback: claude-haiku-5-5"];
  });

  step("05", "session started with an isolated worktree", "real `git worktree` under the temp user directory", async () => {
    const started = await cli(S.main, ["session", "start", "--title", `${TASK} leave balance accrual`, "--worktree", "hris-014", "--json"]);
    assert.equal(started.code, 0, started.err + started.out);
    S.sessionId = started.json().session.id;
    S.worktree = started.json().session.worktree.path;
    assert.ok(existsSync(join(S.worktree, "README.md")), "the worktree exists");
    S.main.trust(S.worktree); // an existing worktree needs a trust grant of its own
    return [`session ${S.sessionId}, worktree ${S.worktree}`];
  });

  // 06-09 the run ----------------------------------------------------------------------------------------
  step("06", "run started and driven to the plan approval", "scripted fake claude (protocol mode): one real child process per node; exit 6 waiting for approval", async () => {
    const started = await cli(S.main, ["run", "start", GOAL, "--run-id", "hris-014", "--session", S.sessionId, "--json"]);
    assert.equal(started.code, 6, started.err + started.out);
    assert.equal(started.json().status, "waiting-approval");
    assert.equal(started.json().currentNode, "approve");
    S.info = await runInfo(S.main, "hris-014");
    const events = S.info.events();
    assert.equal(countType(events, "runner.turn"), 4, "intake, analyze, challenge, plan");
    assert.equal(countType(events, "usage"), 4);
    assert.equal(S.main.invocations(), 4, "one fake claude process per turn");
    assert.equal(S.info.run().approvals.filter((approval) => approval.grantedAt === null).length, 1);
    assert.equal(loadSession(S.info.identity.key, S.sessionId, { env: S.main.env }).session.runId, "hris-014", "the session is linked to the run");
    return ["4 claude turns (intake, analyze, challenge, plan), 1 plan approval pending, session linked"];
  });

  step("07", "non-TTY mode refuses to approve or to start servers", "no terminal: flags without a nonce never grant (exit 2); `mcp test` without a terminal is exit 6 and spawns nothing", async () => {
    const bare = await cli(S.main, ["run", "approve", "hris-014", "--json"]);
    assert.equal(bare.code, 2);
    assert.equal(bare.json().error.code, "APPROVAL_TERMINAL_REQUIRED");
    const approval = S.info.run().approvals.find((item) => item.grantedAt === null);
    const forged = await cli(S.main, ["run", "approve", "hris-014", "--approval", approval.id, "--subject", String(approval.subjectHash).slice(0, 12), "--json"]);
    assert.equal(forged.code, 2);
    assert.equal(forged.json().error.code, "APPROVAL_TERMINAL_REQUIRED");
    assert.equal(S.info.run().approvals.find((item) => item.id === approval.id).grantedAt, null, "still pending");
    // `mcp test` for a trusted but never approved server, no terminal: exit 6 and the spawn seam is never touched.
    const dir = newDir("mcp-nontty");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { files: { command: process.execPath, args: [MCP_SERVER, join(dir, "s.json")] } } }));
    S.main.trust(dir);
    const test = await cli(S.main, ["mcp", "test", "files", "--path", dir, "--json"], { io: { spawn: NO_SPAWN } });
    assert.equal(test.code, 6, test.err + test.out);
    return ["run approve without a TTY: exit 2 APPROVAL_TERMINAL_REQUIRED (also with forged flags); mcp test without a TTY: exit 6, nothing spawned"];
  });

  step("08", "plan approved by the person (library tty source)", "tests/loop-fixture grantPending: the same library call `run approve` makes after the y/N prompt", async () => {
    const granted = grantPending({ now: () => new Date().toISOString() }, S.info.dir, deliveryGraph, { by: { source: "tty", name: "hris-014-reviewer" } });
    assert.equal(granted.length, 1);
    const approval = S.info.run().approvals.find((item) => item.id === granted[0]);
    assert.ok(approval.grantedAt, "granted");
    assert.equal(countType(S.info.events(), "approval.granted"), 1);
    S.before = snapshotOf(S.info.run());
    return [`approval ${granted[0]} granted by tty source`];
  });

  step("09", "interrupted mid-turn, blocked by the run lock, then resumed", "fake claude hangs; second `run resume` hits RUN_LOCKED; abort => paused, exit 130; resume completes", async () => {
    const main = S.main;
    const file = join(S.worktree, "src", "hris", "leave-accrual.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export const accrue = (balance, perMonth = 1.75) => balance + perMonth;\n");
    S.fileHash = sha256(readFileSync(file, "utf8"));
    const statusBefore = git(S.worktree, "status", "--porcelain");
    assert.match(statusBefore, /leave-accrual\.js/);

    main.setScenario({ mode: "hang" });
    const calls = main.invocations();
    const controller = new AbortController();
    const first = cli(main, ["run", "resume", "hris-014", "--json"], { signal: controller.signal });
    await waitFor(() => main.invocations() > calls, { timeoutMs: 30_000, label: "the hung claude turn" });
    await sleep(200);
    const second = await cli(main, ["run", "resume", "hris-014", "--json"]);
    assert.equal(second.code, 1, second.err + second.out);
    assert.equal(second.json().error.code, "RUN_LOCKED", "concurrent dispatch is blocked by the run lock");
    assert.equal(main.invocations(), calls + 1, "the blocked resume started no second claude");
    controller.abort();
    const paused = await first;
    assert.equal(paused.code, 130, paused.err + paused.out);
    assert.equal(paused.json().status, "paused");
    const shown = await cli(main, ["run", "show", "hris-014", "--json"]);
    assert.equal(shown.json().run.lock.state, "none", "the lock was released");

    // What survived the interruption.
    const mid = snapshotOf(S.info.run());
    assert.deepEqual(mid.approvals, S.before.approvals, "approvals survive");
    for (const node of ["intake", "analyze", "challenge", "plan"]) assert.deepEqual(mid.nodes[node], S.before.nodes[node], `node ${node} state survives`);
    assert.equal(mid.runId, "hris-014");
    assert.equal(mid.goal, GOAL, "the task id survives");
    assert.equal(sha256(readFileSync(file, "utf8")), S.fileHash, "the worktree change survives");
    assert.equal(git(S.worktree, "status", "--porcelain"), statusBefore);

    main.setScenario({ protocol: true });
    const resumed = await cli(main, ["run", "resume", "hris-014", "--json"]);
    assert.equal(resumed.code, 0, resumed.err + resumed.out);
    assert.equal(resumed.json().status, "completed");
    const end = snapshotOf(S.info.run());
    assert.deepEqual(end.approvals, S.before.approvals, "no approval was asked or granted twice");
    for (const node of ["intake", "analyze", "challenge", "plan"]) assert.deepEqual(end.nodes[node], S.before.nodes[node], `node ${node} was not repeated`);
    assert.equal(sha256(readFileSync(file, "utf8")), S.fileHash);
    assert.equal(loadSession(S.info.identity.key, S.sessionId, { env: main.env }).session.runId, "hris-014");
    S.invocationsAfterRun = main.invocations();
    const usage = await cli(main, ["usage", "hris-014", "--json"]);
    assert.equal(usage.code, 0, usage.err + usage.out);
    return ["run lock held by the hung turn => RUN_LOCKED for the second resume; abort => paused (130); approvals, graph state, worktree file and task id identical after resume; run completed"];
  });

  // 10-16 PR + pipeline ----------------------------------------------------------------------------------
  const github = (() => {
    const clock = { ms: Date.parse("2026-03-02T09:00:00Z") };
    const nowMs = () => clock.ms;
    const fake = createFakeGithub({ owner: "unexaro", repo: "hris", now: nowMs });
    fake.setRate({ resetAtSec: Math.floor(clock.ms / 1000) + 3600 });
    const hooks = [];
    let sleeps = 0;
    const spawned = [];
    const seams = { fetch: fake.fetch, getToken: () => TOKEN, nowMs, random: () => 0.5, sleep: async (ms) => { clock.ms += ms; sleeps += 1; for (const hook of hooks) hook(clock.ms, sleeps); } };
    const spawn = (cmd, args, options) => { spawned.push({ cmd: String(cmd), args }); return nodeSpawn(cmd, args, options); };
    return {
      clock, fake, hooks, spawned, seams, spawn, outputs: [],
      onSleep(fn) { hooks.length = 0; sleeps = 0; hooks.push(fn); },
      reset() { hooks.length = 0; sleeps = 0; },
      body: "Adds monthly accrual.\n\n## Acceptance criteria\n- balance grows by 1.75 days per month\n- accrual is idempotent\n",
      setPull(state) {
        fake.setPull(PR, state);
        const pull = fake.world.pulls.get(PR);
        pull.title = "HRIS-014: accrue leave balance monthly";
        pull.body = this.body;
      },
    };
  })();
  const pipe = (argv, extra = {}) => cli(S.main, ["pipeline", ...argv], { cwd: S.repo, pipeline: github, ...extra });
  const closable = [];
  const CI = ".github/workflows/ci.yml";
  const LINT = ".github/workflows/lint.yml";
  const ciRun = (patch) => github.fake.setRun({ id: 21, name: "CI", path: CI, workflowId: 7, headSha: MERGE, event: "push", ...patch });

  step("10", "pull request created (simulated); not closable before merge", "fake GitHub REST (in-process fetch); required checks = pipeline.json (ci.yml, lint.yml) + trusted adapter (e2e)", async () => {
    writeFileSync(join(S.main.userDir, "pipeline.json"), JSON.stringify({ repos: { "unexaro/hris": { required: ["ci.yml", "lint.yml"], detectionWindowMs: 600_000 } } }));
    github.setPull({ state: "open", headSha: HEAD, head: "feat/hris-014-leave-accrual", base: "main" });
    github.fake.setRun({ id: 11, name: "CI", path: CI, workflowId: 7, headSha: HEAD, event: "pull_request", conclusion: "success" });
    github.fake.setRun({ id: 12, name: "Lint", path: LINT, workflowId: 8, headSha: HEAD, event: "pull_request", conclusion: "success" });
    const status = await pipe(["status", String(PR), "--refresh", "--json"]);
    assert.equal(status.code, 0, status.err + status.out);
    const body = status.json();
    assert.deepEqual([body.pr.state, body.verdict, body.closable], ["open", "waiting", false]);
    assert.deepEqual(body.preMerge.map((key) => `${key.key}:${key.state}`), ["ci.yml:passed", "lint.yml:passed", "e2e:waiting"]);
    assert.deepEqual(body.policy.required, ["ci.yml", "lint.yml", "e2e"], "user policy first, then the trusted adapter");
    closable.push(body.closable);
    return [`PR #${PR} open; pre-merge ci.yml and lint.yml passed on the PR head; verdict waiting (not merged)`];
  });

  step("11", "merge simulated; workflow failure blocks closing", "fake GitHub: merged PR, ci.yml fails on the merge commit while it is watched; run ledger linked with --run", async () => {
    github.setPull({ state: "closed", merged: true, headSha: HEAD, mergeCommitSha: MERGE, mergedAt: ISO(github.clock.ms), base: "main", head: "feat/hris-014-leave-accrual" });
    ciRun({ status: "in_progress", conclusion: null, updatedAt: github.clock.ms });
    github.fake.setRun({ id: 22, name: "Lint", path: LINT, workflowId: 8, headSha: MERGE, event: "push", conclusion: "success" });
    github.onSleep((ms, n) => { if (n === 1) ciRun({ status: "completed", conclusion: "failure", updatedAt: ms }); });
    const watched = await pipe(["watch", String(PR), "--run", "hris-014", "--json"]);
    github.reset();
    assert.equal(watched.code, 1, watched.err + watched.out);
    const body = watched.json();
    assert.deepEqual([body.verdict, body.closable, body.status], ["failed", false, "terminal"]);
    assert.ok(body.blockers.some((blocker) => blocker.key === "ci.yml" && blocker.state === "failed"));
    assert.equal(body.pr.mergeCommitSha, MERGE);
    closable.push(body.closable);
    const verdicts = S.info.events().filter((event) => event.type === "pipeline.verdict");
    assert.equal(verdicts.at(-1)?.verdict, "failed", "the verdict was appended to the run ledger");
    return ["merged; ci.yml failed => verdict failed, exit 1, blocker ci.yml failed; pipeline.verdict appended to the run ledger"];
  });

  step("12", "explicit diagnosis packet (read-only, sent nowhere)", "fake GitHub jobs/files endpoints; no model, no rerun", async () => {
    github.fake.setJobs(21, [{ name: "unit", conclusion: "failure", steps: [{ name: "npm test", number: 3, status: "completed", conclusion: "failure" }, { name: "checkout", number: 1, status: "completed", conclusion: "success" }] }]);
    github.fake.world.files = ["src/hris/leave-accrual.js", "tests/leave.test.js"];
    const calls = github.fake.calls.length;
    const diagnosis = await pipe(["diagnose", String(PR), "--json"]);
    assert.equal(diagnosis.code, 0, diagnosis.err + diagnosis.out);
    const packet = diagnosis.json();
    assert.equal(packet.sentAnywhere, false);
    const failing = packet.failing.find((entry) => entry.key === CI);
    assert.deepEqual(failing.jobs, [{ name: "unit", conclusion: "failure", failedSteps: ["npm test"] }]);
    assert.match(packet.acceptanceCriteria, /1\.75 days/);
    assert.deepEqual(packet.changedFiles, ["src/hris/leave-accrual.js", "tests/leave.test.js"]);
    assert.match(packet.handoff.command, /run start --workflow bugfix/);
    assert.ok(github.fake.calls.slice(calls).every((call) => call.method === "GET"), "only GET requests");
    return ["failing: ci.yml (job unit, step 'npm test'); acceptance criteria and 2 changed files included; handing it to a run is the user's decision"];
  });

  step("13", "duplicate and delayed events are counted and never change the verdict", "fake GitHub: an identical poll (duplicate) and a stale in_progress report arriving after the failure (delayed)", async () => {
    const duplicate = await pipe(["status", String(PR), "--refresh", "--json"]);
    assert.equal(duplicate.code, 0, duplicate.err + duplicate.out);
    assert.ok(duplicate.json().counters.duplicates >= 1, "an identical report is a duplicate");
    assert.equal(duplicate.json().verdict, "failed");
    const finished = github.fake.world.runs.find((run) => run.id === 21);
    const stale = { ...finished, status: "in_progress", conclusion: null, updated_at: ISO(github.clock.ms - 600_000) };
    github.fake.fault(new RegExp(`actions/runs\\?.*head_sha=${MERGE}`), () => new Response(JSON.stringify({ total_count: 1, workflow_runs: [stale] }), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4000", "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(Math.floor(github.clock.ms / 1000) + 3000) } }));
    const delayed = await pipe(["status", String(PR), "--refresh", "--json"]);
    assert.equal(delayed.code, 0, delayed.err + delayed.out);
    assert.ok(delayed.json().counters.outOfOrder >= 1, "the delayed report is counted as out of order");
    assert.equal(delayed.json().keys.find((key) => key.key === "ci.yml").state, "failed", "terminal state is sticky");
    closable.push(delayed.json().closable);
    return [`duplicates: ${duplicate.json().counters.duplicates}; out of order: ${delayed.json().counters.outOfOrder}; ci.yml still failed`];
  });

  step("14", "rerun supersedes the failure; NOT closable until every required check passes", "fake GitHub: ci.yml attempt 2, then the e2e check-run still running, then e2e passes during `watch`", async () => {
    github.clock.ms += 120_000;
    ciRun({ attempt: 2, status: "in_progress", conclusion: null, updatedAt: github.clock.ms });
    github.fake.setCheck({ id: 31, name: "e2e", headSha: MERGE, status: "in_progress", conclusion: null, startedAt: github.clock.ms });
    const rerunning = await pipe(["status", String(PR), "--refresh", "--json"]);
    assert.equal(rerunning.json().verdict, "waiting");
    assert.ok(rerunning.json().counters.superseded >= 1, "attempt 2 superseded attempt 1");
    closable.push(rerunning.json().closable);

    github.clock.ms += 120_000;
    ciRun({ attempt: 2, status: "completed", conclusion: "success", updatedAt: github.clock.ms });
    const partial = await pipe(["status", String(PR), "--refresh", "--json"]);
    const body = partial.json();
    assert.equal(body.keys.find((key) => key.key === "ci.yml").state, "passed");
    assert.equal(body.keys.find((key) => key.key === "ci.yml").attempt, 2);
    assert.deepEqual([body.verdict, body.closable], ["waiting", false], "ci and lint passed but e2e is still running");
    assert.ok(body.blockers.some((blocker) => blocker.key === "e2e" && blocker.state === "running"));
    closable.push(body.closable);

    github.onSleep((ms, n) => { if (n === 1) github.fake.setCheck({ id: 31, name: "e2e", headSha: MERGE, status: "completed", conclusion: "success", startedAt: ms - 60_000, completedAt: ms }); });
    const watched = await pipe(["watch", String(PR), "--run", "hris-014", "--json"]);
    github.reset();
    assert.equal(watched.code, 0, watched.err + watched.out);
    assert.deepEqual([watched.json().verdict, watched.json().closable, watched.json().blockers], ["closable", true, []]);
    closable.push(watched.json().closable);
    assert.deepEqual(closable, [false, false, false, false, false, true], "closable only at the very end");
    const calls = github.fake.calls.length;
    const offline = await pipe(["status", String(PR), "--json"]);
    assert.equal(offline.json().closable, true);
    assert.equal(github.fake.calls.length, calls, "plain status reads the recorded state: no network");
    assert.equal(S.info.events().findLast((event) => event.type === "pipeline.verdict").verdict, "closable");
    return ["ci.yml attempt 2 passed, e2e running => waiting; e2e passed => closable (exit 0); recorded in the run ledger"];
  });

  step("15", "monitoring made ZERO model calls", "fake-claude invocation counter file (one line per claude process) + a spawn spy on every pipeline command", async () => {
    assert.equal(S.main.invocations(), S.invocationsAfterRun, "the invocation counter did not move during pipeline status/watch/diagnose");
    assert.ok(S.invocationsAfterRun >= 6, "the counter was live (the run made claude calls)");
    assert.ok(github.spawned.length > 0, "the spy is wired (git ran)");
    for (const { cmd } of github.spawned) assert.match(basename(cmd), /^git(\.exe)?$/i, `only git was spawned, saw ${cmd}`);
    const all = [...github.fake.calls.map((call) => call.url), ...github.outputs].join("\n");
    assert.ok(!all.includes(TOKEN), "the token never appears in a URL or in output");
    assert.ok(github.fake.calls.every((call) => call.method === "GET"));
    return [`claude processes before and after monitoring: ${S.invocationsAfterRun}; ${github.fake.calls.length} GitHub GET requests; ${github.spawned.length} git processes`];
  });

  // 16-22 failure paths ----------------------------------------------------------------------------------
  const scratch = () => (S.scratch ??= makeHrisRepo("scratch"));

  step("16", "offline runner: claude not installed", "runner pointed at a binary that does not exist; no run is created", async () => {
    const world = makeWorld("offline", { repo: scratch(), claudeMissing: true });
    world.trust();
    const result = await cli(world, ["run", "start", "ship it", "--run-id", "off-1", "--json"]);
    assert.equal(result.code, 1, result.err + result.out);
    assert.equal(result.json().error.code, "RUNNER_NOT_INSTALLED");
    assert.match(result.json().error.remediation, /doctor/);
    assert.equal(existsSync((await runInfo(world, "off-1")).dir), false, "no run directory");
    return ["exit 1 RUNNER_NOT_INSTALLED with a `doctor` remediation; nothing was created"];
  });

  step("17", "invalid MCP configuration is exit 5 with every problem named", "a temp directory with a broken .mcp.json; nothing is started", async () => {
    const world = makeWorld("badmcp", { repo: null });
    const dir = newDir("badmcp-repo");
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { "bad name!": { command: "x" }, nocmd: { type: "stdio" }, leak: { command: "/bin/x", args: ["--token", "abcdef123456"], env: { PLAIN: "literal" } } } }));
    const result = await cli(world, ["mcp", "validate", "--json"], { cwd: dir, io: { spawn: NO_SPAWN } });
    assert.equal(result.code, 5, result.err + result.out);
    const codes = new Set(result.json().problems.map((problem) => problem.code));
    for (const code of ["MCP_DEFINITION_INVALID", "MCP_SECRET_IN_ARGS", "MCP_ENV_LITERAL"]) assert.ok(codes.has(code), code);
    return [`problems: ${[...codes].sort().join(", ")}`];
  });

  step("18", "provider throttling falls back to the next model", "fake claude fails the first turn with a 429 rate-limit text, then succeeds; fallback model from ASTERWEAVE_MODEL_FALLBACK", async () => {
    const world = makeWorld("throttle", { repo: scratch(), scenario: { protocol: true, sequence: [{ mode: "fail", stderr: "API Error: 429 rate limit exceeded\n" }, { mode: "success" }] }, envExtra: { ASTERWEAVE_MODEL: "claude-sonnet-5-5", ASTERWEAVE_MODEL_FALLBACK: "claude-haiku-5-5" } });
    world.trust();
    const result = await cli(world, ["run", "start", "ship it", "--run-id", "thr-1", "--json"]);
    assert.equal(result.code, 6, result.err + result.out);
    const events = (await runInfo(world, "thr-1")).events();
    const fallback = events.find((event) => event.type === "route.fallback");
    assert.deepEqual([fallback.node, fallback.from, fallback.to, fallback.class], ["intake", "claude-sonnet-5-5", "claude-haiku-5-5", "rate-limit"]);
    const turns = events.filter((event) => event.type === "runner.turn");
    assert.deepEqual([turns[0].ok, turns[0].class, turns[1].ok], [false, "rate-limit", true]);
    return ["intake: claude-sonnet-5-5 rate-limited => retried on claude-haiku-5-5 (route.fallback recorded)"];
  });

  step("19", "budget exhaustion blocks the run and leaves a session checkpoint", "policy.json with a 50 token budget; fake claude reports 30 tokens per turn", async () => {
    const world = makeWorld("budget", { repo: scratch(), scenario: { protocol: true, toolUses: [{ id: "t", name: "Read", input: {} }] }, policy: { v: 1, mode: "supervised", autonomous: { workflows: ["delivery@1"], repos: ["*"], tools: ["read"], operations: ["commit"], budgets: { tokens: 50 } } } });
    world.trust();
    const session = (await cli(world, ["session", "start", "--title", "budget", "--json"])).json().session;
    const result = await cli(world, ["run", "start", "ship it", "--run-id", "bud-1", "--session", session.id, "--json"]);
    assert.equal(result.code, 1, result.err + result.out);
    assert.equal(result.json().status, "blocked");
    const info = await runInfo(world, "bud-1");
    assert.equal(info.events().find((event) => event.type === "budget.exhausted").budget, "tokens");
    const loaded = loadSession(info.identity.key, session.id, { env: world.env }).session;
    assert.ok(loaded.checkpoints.some((checkpoint) => checkpoint.runId === "bud-1" && /blocked/.test(checkpoint.note)));
    assert.equal(loaded.providerSessionId, SID);
    return ["tokens budget 50 exhausted in analyze => run blocked (exit 1), checkpoint 'run blocked' in the session"];
  });

  step("20", "safe cancellation: abort pauses the run (exit 130) and leaves no orphan", "fake claude spawns a grandchild process and hangs; the whole process tree must die", async () => {
    const pidFile = join(newDir("cancel-pid"), "grandchild.pid");
    const world = makeWorld("cancel", { repo: scratch(), scenario: { mode: "grandchild", pidFile } });
    world.trust();
    const controller = new AbortController();
    const pending = cli(world, ["run", "start", "ship it", "--run-id", "can-1", "--json"], { signal: controller.signal });
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== "", { timeoutMs: 30_000, label: "the grandchild pid" });
    const pid = Number(readFileSync(pidFile, "utf8"));
    await sleep(300);
    controller.abort();
    const result = await pending;
    assert.equal(result.code, 130, result.err + result.out);
    assert.equal(result.json().status, "paused");
    const info = await runInfo(world, "can-1");
    assert.equal(info.run().status, "paused");
    await waitFor(() => !alive(pid), { timeoutMs: 15_000, label: "the grandchild to die" });
    return [`run paused, exit 130, grandchild ${pid} is gone`];
  });

  step("21", "denied tool request", "the real `hook pre-tool-use` command fed Claude Code PreToolUse payloads on stdin", async () => {
    const payload = (command) => JSON.stringify({ tool_name: "Bash", cwd: S.repo, tool_input: { command } });
    const hook = (command) => cli(S.main, ["hook", "pre-tool-use"], { stdin: Readable.from([payload(command)]), envExtra: { CLAUDE_PROJECT_DIR: S.repo } });
    const destructive = await hook(["git", "reset", "--hard", "HEAD~1"].join(" "));
    assert.equal(destructive.code, 0);
    assert.equal(destructive.json().hookSpecificOutput.permissionDecision, "deny");
    const push = await hook("git push origin main");
    assert.equal(push.json().hookSpecificOutput.permissionDecision, "ask", "a push to the default branch needs a person");
    const ordinary = await hook("git status");
    assert.equal(ordinary.out, "", "an ordinary command passes through untouched");
    return ["destructive git command => deny; push to main => ask; git status => no decision (normal permission flow)"];
  });

  step("22", "hook timeout blocks a validate hook and is recorded", "the real runHooks with a hook process that sleeps 30 s; timeout 300 ms, killed", async () => {
    const dir = newDir("hook-timeout");
    const script = join(dir, "sleep.mjs");
    writeFileSync(script, "setTimeout(() => {}, 30000);\n");
    const hook = { id: "slow-validator", event: "tool.before", kind: "validate", source: "user", timeoutMs: 300, onFailure: "block", argv: [process.execPath, script] };
    const out = await runHooks("tool.before", { tool: "shell" }, { hooks: [hook], env: { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, runId: "hris-014", seq: 1, cwd: dir, killGraceMs: 200 });
    assert.equal(out.results[0].status, "timeout");
    assert.equal(out.results[0].effect, "blocked");
    assert.equal(out.decision.decision, "deny");
    assert.equal(out.decision.reason, "HOOK_FAILED");
    return ["slow-validator timed out after 300 ms => deny HOOK_FAILED (a log hook or onFailure=ignore would not block)"];
  });

  return steps;
}

function snapshotOf(run) {
  return {
    runId: run.runId,
    goal: run.goal,
    approvals: run.approvals.map((approval) => ({ id: approval.id, grantedAt: approval.grantedAt, invalidatedAt: approval.invalidatedAt, subjectHash: approval.subjectHash })),
    nodes: Object.fromEntries(Object.entries(run.nodes).map(([id, node]) => [id, { status: node.status, attempts: node.attempts, outcome: node.outcome }])),
  };
}

export const COVERAGE = [
  ["Model calls (the runner)", "tests/fixtures/fake-claude.mjs (a scripted child process)", "NOT verified live"],
  ["Model provider sign-in", "fake `claude auth status` child process", "NOT verified live"],
  ["GitHub sign-in", "fake `gh auth status` child process; token injected in-process", "NOT verified live"],
  ["GitHub REST (PR, runs, jobs, checks)", "tests/fixtures/fake-github.mjs (in-process fetch)", "NOT verified live"],
  ["PR creation and merge", "simulated in the fake GitHub world (Asterweave never creates a PR here)", "NOT verified live"],
  ["MCP server", "tests/fixtures/mcp-server.mjs (real child process, tools listed only)", "NOT verified live"],
  ["Hooks, guard, approvals, worktrees, ledger, locks", "REAL code, temp directories only", "real code, fixture inputs"],
  ["Rate-limit fallback / budgets / cancellation", "REAL code driven by fake-claude failure text", "provider messages NOT verified live"],
];

function printCoverage(log) {
  const widths = [0, 1, 2].map((column) => Math.max(...COVERAGE.map((row) => row[column].length), ["Path", "Used in this demo", "Live status"][column].length));
  const line = (cells) => `  ${cells.map((cell, column) => cell.padEnd(widths[column])).join("  |  ")}`;
  log("");
  log("Fixture-vs-live coverage (EVERYTHING in this demo is a fixture; nothing below was checked against a live service):");
  log(line(["Path", "Used in this demo", "Live status"]));
  log(`  ${widths.map((width) => "-".repeat(width)).join("--+--")}`);
  for (const row of COVERAGE) log(line(row));
  log("");
  log("No live model, no live GitHub, no live MCP server was contacted. See website/docs/cli/demo.md for the unverified list.");
}

/** Runs the whole demo. Returns the exit code (0 only when every step passed within the time limit). */
export async function main({ log = console.log, steps = null, limitMs = TIME_LIMIT_MS } = {}) {
  log("Asterweave HRIS-014 fixture demo (all paths are fixtures: fake claude, fake GitHub, fixture MCP server; temp directories only)");
  log("");
  let summary;
  try {
    summary = await runSteps(steps ?? buildSteps(), { log });
    const slow = summary.elapsedMs > limitMs;
    printCoverage(log);
    log(`${summary.passed} passed, ${summary.failed} failed, ${(summary.elapsedMs / 1000).toFixed(1)} s${slow ? ` (FAIL: over the ${limitMs / 1000} s limit)` : ""}`);
    return summary.failed === 0 && !slow ? 0 : 1;
  } finally {
    if (ROOT !== null) {
      try { rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 }); } catch { /* a just-stopped child can hold its cwd on Windows; the OS temp cleaner takes it */ }
      ROOT = null;
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await main();
  process.exit(code);
}
