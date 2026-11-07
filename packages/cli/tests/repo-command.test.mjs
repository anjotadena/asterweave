import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { parseArgs } from "../src/args.mjs";
import { runCli } from "../src/cli.mjs";
import { repoCommand, repoCommands } from "../src/commands/repo.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { stripAnsi } from "../src/tui/render.mjs";
import { SEQ } from "../src/tui/terminal.mjs";
import { cleanupTemp, fakeTerminal, ghInstalled, ghOnlySpawn, ghReply, git, makeClone, snapshot, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const secret = ["ghp", "_", "Q".repeat(36)].join("");
const REPOS = JSON.stringify([
  { nameWithOwner: "acme/other", defaultBranchRef: { name: "main" } },
  { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } },
]);

function setup(cloneOptions) {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone(cloneOptions);
  return { configDir, clone, env: { ...process.env, TERM: "xterm", ASTERWEAVE_CONFIG_DIR: configDir }, recordFile: join(configDir, "repo.json") };
}

/** In-process runCli for the non-interactive paths (real git, no gh needed). */
async function run(args, { env, cwd, tty = false } = {}) {
  const term = fakeTerminal({ tty });
  const code = await runCli(["repo", ...args], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd }, { commands: new Map(repoCommands) });
  return { code, stdout: term.text(), stderr: term.errText(), term };
}

/** Direct handler call so tests can inject `exists`/`spawn` for gh. */
function handlerContext(term, { args, env, cwd, spawn, exists = ghInstalled }) {
  const parsed = parseArgs(args, { boolean: ["json", "help", "version"] });
  return { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd, spawn, exists, version: "9.9.9", name: "repo", argv: args, ...parsed };
}

const frames = (term) => term.text().split(SEQ.clear).length - 1;
const lastFrame = (term) => stripAnsi(term.text().split(SEQ.clear).at(-1));
async function press(term, key) {
  const before = frames(term);
  term.stdin.write(key);
  await waitFor(() => frames(term) > before, { label: `a redraw after ${JSON.stringify(key)}` });
}
const UP = "\x1b[A";
const DOWN = "\x1b[B";

function assertRestored(term) {
  assert.deepEqual(term.stdin.rawCalls, [true, false], "raw mode entered once and restored once");
  assert.ok(term.text().includes(SEQ.showCursor) && term.text().includes(SEQ.altScreenOff), "cursor shown and alternate screen left");
}

// --- non-interactive ------------------------------------------------------------------------------

test("repoCommands exposes the handler in registry shape", () => {
  const entry = repoCommands.get("repo");
  assert.equal(entry.handler, repoCommand);
  assert.deepEqual(entry.boolean, ["json"]);
  assert.ok(entry.summary);
});

test("non-TTY connect with missing flags exits 2 and names the flags to pass", async () => {
  const { env, clone, recordFile } = setup();
  let result = await run(["connect"], { env, cwd: clone });
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.stderr, /--repo owner\/name and --branch <name>/);
  assert.match(result.stderr, /asterweave repo connect --repo/);
  assert.equal(result.stdout, "");

  result = await run(["connect", "--repo", "acme/widgets"], { env, cwd: clone });
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.stderr, /needs --branch <name> when/);
  assert.doesNotMatch(result.stderr, /--repo owner/);

  result = await run(["connect", "--repo", "widgets", "--branch", "main"], { env, cwd: clone });
  assert.equal(result.code, EXIT.USAGE);
  assert.match(result.stderr, /owner\/name/);
  assert.equal(existsSync(recordFile), false);
});

test("unknown or missing subcommands are usage errors", async () => {
  const { env, clone } = setup();
  for (const args of [[], ["bogus"], ["status", "extra"], ["connect", "--repo"]]) {
    const result = await run(args, { env, cwd: clone });
    assert.equal(result.code, EXIT.USAGE, JSON.stringify(args));
    assert.equal(result.stdout, "");
  }
});

test("connect --json prints exactly one JSON object on stdout and leaves the clone untouched", async () => {
  const { env, clone, recordFile } = setup();
  const before = snapshot(clone);
  const result = await run(["connect", "--repo", "acme/widgets", "--branch", "dev", "--path", clone, "--json"], { env, cwd: tempDir("aw-elsewhere-") });
  assert.equal(result.code, EXIT.OK);
  assert.equal(result.stderr, "");
  assert.ok(result.stdout.endsWith("\n") && result.stdout.trim().split("\n").length === 1, "one line");
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, repository: "acme/widgets", branch: "dev", path: clone, runner: "local" });
  assert.deepEqual(Object.keys(JSON.parse(result.stdout)), ["ok", "repository", "branch", "path", "runner"]);
  assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).branch, "dev");
  assert.deepEqual(snapshot(clone), before, "HEAD, branch and work tree unchanged");
});

test("connect defaults --path to the working directory and prints the connected block without escape bytes", async () => {
  const { env, clone } = setup();
  writeFileSync(join(clone, "wip.txt"), "x");
  const before = snapshot(clone);
  const result = await run(["connect", "--repo", "acme/widgets", "--branch", "main"], { env, cwd: clone });
  assert.equal(result.code, EXIT.OK);
  assert.match(result.stdout, /Local runner connected\./);
  assert.match(result.stdout, /Repository {2}acme\/widgets/);
  assert.match(result.stdout, /Branch {6}main/);
  assert.ok(result.stdout.includes(`Path        ${clone}`));
  assert.doesNotMatch(result.stdout, /uncommitted changes/, "work-tree state is not inspected");
  assert.equal(result.stdout.includes("\x1b"), false);
  assert.equal(result.stderr, "");
  assert.deepEqual(snapshot(clone), before);
});

test("connect --json failures use the JSON error envelope and write nothing", async () => {
  const { env, clone, recordFile } = setup();
  const mismatch = await run(["connect", "--repo", "acme/other", "--branch", "main", "--path", clone, "--json"], { env, cwd: clone });
  assert.equal(mismatch.code, EXIT.ERROR);
  assert.equal(mismatch.stderr, "");
  const body = JSON.parse(mismatch.stdout);
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "REPO_ORIGIN_MISMATCH");
  assert.ok(body.error.remediation);

  const branch = await run(["connect", "--repo", "acme/widgets", "--branch", "ghost", "--path", clone, "--json"], { env, cwd: clone });
  assert.equal(branch.code, EXIT.ERROR);
  assert.equal(JSON.parse(branch.stdout).error.code, "REPO_BRANCH_NOT_FOUND");
  assert.equal(existsSync(recordFile), false);
});

test("--json never prompts, even on a TTY: missing flags are a usage error", async () => {
  const { env, clone } = setup();
  const result = await run(["connect", "--json"], { env, cwd: clone, tty: true });
  assert.equal(result.code, EXIT.USAGE);
  assert.deepEqual(result.term.stdin.rawCalls, []);
  assert.equal(result.term.text().includes("\x1b"), false);
  assert.equal(JSON.parse(result.stdout).error.code, "USAGE");
});

test("an embedded-credential origin URL never appears in any output or in repo.json", async () => {
  const good = setup({ origin: `https://x-access-token:${secret}@github.com/acme/widgets.git` });
  for (const extra of [[], ["--json"]]) {
    const result = await run(["connect", "--repo", "acme/widgets", "--branch", "main", ...extra], { env: good.env, cwd: good.clone });
    assert.equal(result.code, EXIT.OK);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
  assert.equal(readFileSync(good.recordFile, "utf8").includes(secret), false);
  const status = await run(["status", "--json"], { env: good.env, cwd: good.clone });
  assert.equal(`${status.stdout}${status.stderr}`.includes(secret), false);

  const bad = setup({ origin: `https://x-access-token:${secret}@github.com/acme/other.git` });
  for (const extra of [[], ["--json"]]) {
    const result = await run(["connect", "--repo", "acme/widgets", "--branch", "main", ...extra], { env: bad.env, cwd: bad.clone });
    assert.equal(result.code, EXIT.ERROR);
    assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
  }
  assert.equal(existsSync(bad.recordFile), false);
});

// --- status -------------------------------------------------------------------------------------------

test("status: not connected, connected (human and JSON), and a vanished path", async () => {
  const { env, clone, recordFile } = setup();
  let result = await run(["status"], { env, cwd: clone });
  assert.equal(result.code, EXIT.OK);
  assert.match(result.stdout, /No repository connected/);
  result = await run(["status", "--json"], { env, cwd: clone });
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, connected: false });

  await run(["connect", "--repo", "acme/widgets", "--branch", "main", "--json"], { env, cwd: clone });
  git(clone, "checkout", "dev");
  result = await run(["status", "--json"], { env, cwd: clone });
  assert.equal(result.code, EXIT.OK);
  assert.equal(result.stderr, "");
  const status = JSON.parse(result.stdout);
  assert.deepEqual({ ok: status.ok, connected: status.connected, repository: status.repository, branch: status.branch, currentBranch: status.currentBranch, path: status.path, runner: status.runner, dirty: status.dirty, trust: status.trust }, {
    ok: true, connected: true, repository: "acme/widgets", branch: "main", currentBranch: "dev", path: clone, runner: "local", dirty: null, trust: { trusted: false, reason: "NOT_GRANTED" },
  });

  result = await run(["status"], { env, cwd: clone });
  assert.equal(result.code, EXIT.OK);
  assert.match(result.stdout, /Branch {6}main \(checked out: dev\)/);
  assert.match(result.stdout, /Trust {7}untrusted \(NOT_GRANTED\)/);
  assert.match(result.stdout, /Work tree {3}unknown/);

  const record = JSON.parse(readFileSync(recordFile, "utf8"));
  writeFileSync(recordFile, JSON.stringify({ ...record, path: join(clone, "gone") }));
  result = await run(["status"], { env, cwd: clone });
  assert.equal(result.code, EXIT.ERROR);
  assert.match(result.stderr, /no longer exists/);
  result = await run(["status", "--json"], { env, cwd: clone });
  assert.equal(result.code, EXIT.ERROR);
  assert.equal(JSON.parse(result.stdout).problem, "REPO_PATH_MISSING");
});

// --- interactive ----------------------------------------------------------------------------------------

test("interactive: a clone with no origin falls back to the gh repo list picker (Up/Down/Enter), then the branch picker", async () => {
  const { env, clone, recordFile } = setup({ origin: null });
  let before = snapshot(clone);
  const spawn = ghOnlySpawn(ghReply({ stdout: REPOS }));
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect"], env, cwd: clone, spawn }));

  await waitFor(() => term.text().includes("Select a repository"), { label: "repository picker" });
  assert.match(lastFrame(term), /> acme\/other/, "no origin to match: the cursor simply starts at the top");
  await press(term, DOWN);
  assert.match(lastFrame(term), /> acme\/widgets/);
  await press(term, UP);
  assert.match(lastFrame(term), /> acme\/other/);
  await press(term, DOWN);
  git(clone, "remote", "add", "origin", "https://github.com/acme/widgets.git"); // connect re-reads origin, so add it while the picker is open
  before = snapshot(clone);
  term.stdin.write("\r");

  await waitFor(() => term.text().includes("Select a branch for acme/widgets"), { label: "branch picker" });
  assert.match(lastFrame(term), /> main {2}default/);
  await press(term, DOWN);
  assert.match(lastFrame(term), /> dev/);
  term.stdin.write("\r");

  assert.equal(await running, EXIT.OK);
  assertRestored(term);
  const text = term.text();
  assert.ok(text.includes("Local runner connected."));
  assert.ok(text.includes("Repository  acme/widgets") && text.includes("Branch      dev") && text.includes(`Path        ${clone}`));
  assert.ok(text.lastIndexOf("Local runner connected.") > text.lastIndexOf(SEQ.altScreenOff), "the result is printed on the normal screen");
  assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).branch, "dev");
  assert.equal(spawn.ghCalls.length, 1);
  assert.deepEqual(spawn.ghCalls[0].args.slice(0, 2), ["repo", "list"]);
  assert.deepEqual(snapshot(clone), before);
});

test("B1: repo connect uses the clone's origin when gh repo list does not return it: no repository picker, branch picker shows the source", async () => {
  const { env, clone, recordFile } = setup(); // origin https://github.com/acme/widgets.git
  const ownOnly = JSON.stringify([{ nameWithOwner: "octo-dev/personal", defaultBranchRef: { name: "main" } }]);
  const spawn = ghOnlySpawn(ghReply({ stdout: ownOnly }));
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect"], env, cwd: clone, spawn }));
  await waitFor(() => term.text().includes("Select a branch for acme/widgets"), { label: "branch picker" });
  assert.equal(term.text().includes("Select a repository"), false);
  assert.ok(lastFrame(term).includes("Repository: acme/widgets (from origin)"));
  term.stdin.write("\r");
  assert.equal(await running, EXIT.OK);
  assert.equal(spawn.ghCalls.length, 0, "gh repo list is not needed");
  assert.equal(JSON.parse(readFileSync(recordFile, "utf8")).repository, "acme/widgets");
  assertRestored(term);
});

test("interactive: --repo given skips the repository picker and gh entirely", async () => {
  const { env, clone } = setup();
  const spawn = ghOnlySpawn(ghReply({ stdout: REPOS }));
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect", "--repo", "acme/widgets"], env, cwd: clone, spawn }));
  await waitFor(() => term.text().includes("Select a branch for acme/widgets"));
  assert.equal(term.text().includes("Select a repository"), false);
  term.stdin.write("\r");
  assert.equal(await running, EXIT.OK);
  assert.equal(spawn.ghCalls.length, 0);
  assert.match(term.text(), /Branch {6}main/);
  assertRestored(term);
});

test("interactive: Esc cancels with REPO_CONNECT_CANCELLED, restores the terminal, and writes nothing", async () => {
  const { env, clone, recordFile } = setup({ origin: null });
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect"], env, cwd: clone, spawn: ghOnlySpawn(ghReply({ stdout: REPOS })) }));
  const outcome = assert.rejects(running, (error) => error.code === "REPO_CONNECT_CANCELLED" && error.exitCode === EXIT.ERROR);
  await waitFor(() => term.text().includes("Select a repository"));
  term.stdin.write("\x1b");
  await outcome;
  assertRestored(term);
  assert.equal(existsSync(recordFile), false);
  assert.equal(term.text().includes("Local runner connected"), false);
});

test("interactive: Esc in the branch picker also cancels", async () => {
  const { env, clone, recordFile } = setup();
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect", "--repo", "acme/widgets"], env, cwd: clone }));
  const outcome = assert.rejects(running, (error) => error.code === "REPO_CONNECT_CANCELLED");
  await waitFor(() => term.text().includes("Select a branch"));
  term.stdin.write("\x1b");
  await outcome;
  assertRestored(term);
  assert.equal(existsSync(recordFile), false);
});

test("interactive: Ctrl+C returns 130, restores the terminal, and writes nothing", async () => {
  for (const stage of ["repository", "branch"]) {
    const { env, clone, recordFile } = setup(stage === "repository" ? { origin: null } : undefined);
    const term = fakeTerminal();
    const args = stage === "repository" ? ["connect"] : ["connect", "--repo", "acme/widgets"];
    const running = repoCommand(handlerContext(term, { args, env, cwd: clone, spawn: ghOnlySpawn(ghReply({ stdout: REPOS })) }));
    await waitFor(() => term.text().includes(stage === "repository" ? "Select a repository" : "Select a branch"));
    term.stdin.write("\x03");
    assert.equal(await running, EXIT.INTERRUPTED, stage);
    assertRestored(term);
    assert.equal(existsSync(recordFile), false, stage);
    assert.equal(term.text().includes("Local runner connected"), false);
  }
});

test("interactive: a closed input stream is treated as an interrupt (130)", async () => {
  const { env, clone, recordFile } = setup({ origin: null });
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect"], env, cwd: clone, spawn: ghOnlySpawn(ghReply({ stdout: REPOS })) }));
  await waitFor(() => term.text().includes("Select a repository"));
  term.stdin.end();
  assert.equal(await running, EXIT.INTERRUPTED);
  assertRestored(term);
  assert.equal(existsSync(recordFile), false);
});

test("interactive: an error thrown inside the session still restores the terminal", async () => {
  const { env, recordFile } = setup();
  const notARepo = tempDir("aw-plain-");
  const term = fakeTerminal();
  await assert.rejects(repoCommand(handlerContext(term, { args: ["connect", "--repo", "acme/widgets"], env, cwd: notARepo })), (error) => error.code === "REPO_BRANCHES_FAILED");
  assertRestored(term);
  assert.equal(existsSync(recordFile), false);
});

test("interactive: gh failures surface before any raw mode, as typed errors", async () => {
  const { env, clone } = setup({ origin: null });
  const term = fakeTerminal();
  const unauthenticated = ghOnlySpawn(ghReply({ stderr: "To get started with GitHub CLI, please run:  gh auth login", code: 4 }));
  await assert.rejects(repoCommand(handlerContext(term, { args: ["connect"], env, cwd: clone, spawn: unauthenticated })), (error) => error.code === "GH_NOT_AUTHENTICATED" && error.exitCode === EXIT.AUTH);
  assert.deepEqual(term.stdin.rawCalls, []);
  assert.equal(term.text(), "");

  const missing = fakeTerminal();
  await assert.rejects(repoCommand(handlerContext(missing, { args: ["connect"], env, cwd: clone, exists: () => false })), (error) => error.code === "GH_NOT_INSTALLED");
  assert.deepEqual(missing.stdin.rawCalls, []);
});

test("interactive: an origin mismatch is reported after the terminal is restored", async () => {
  const { env, clone, recordFile } = setup();
  const term = fakeTerminal();
  const running = repoCommand(handlerContext(term, { args: ["connect", "--repo", "acme/other"], env, cwd: clone }));
  const outcome = assert.rejects(running, (error) => error.code === "REPO_ORIGIN_MISMATCH");
  await waitFor(() => term.text().includes("Select a branch for acme/other"));
  term.stdin.write("\r");
  await outcome;
  assertRestored(term);
  assert.equal(existsSync(recordFile), false);
});
