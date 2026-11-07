import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { launchCommand, launchCommands } from "../src/commands/launch.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { grantTrust } from "../src/trust.mjs";
import { SEQ } from "../src/tui/terminal.mjs";
import { FAKE_GH_TOKEN, TOKEN_SHAPED, claudeStatus } from "./auth-helpers.mjs";
import { DOWN, SIGNED_OUT_CLAUDE, frames, ghSignedIn, ghSignedOut, lastFrame, launchContext, makeWorld, press, setup, waitForSession } from "./launch-fixture.mjs";
import { cleanupTemp, fakeTerminal, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const NOT_AVAILABLE = "Not available in this build (agent sessions arrive in a later phase).";

/** Every raw-mode entry was matched by a restore, and each restore showed the cursor and left the alt screen. */
function assertBalanced(term) {
  const raw = term.stdin.rawCalls;
  assert.ok(raw.length % 2 === 0 && raw.every((value, index) => value === (index % 2 === 0)), `raw mode toggles in pairs: ${JSON.stringify(raw)}`);
  const text = term.text();
  const count = (needle) => text.split(needle).length - 1;
  assert.equal(count(SEQ.altScreenOn), count(SEQ.altScreenOff), "alternate screen entered and left equally often");
  assert.equal(count(SEQ.altScreenOff), raw.length / 2);
  if (raw.length > 0) assert.ok(text.includes(SEQ.showCursor));
}

function boot(world, options = {}) {
  const { env, cwd, ...rest } = options;
  const term = fakeTerminal();
  const ctx = launchContext(term, world, { env, cwd, ...rest });
  return { term, ctx, running: launchCommand(ctx) };
}

async function toSession(world, options) {
  const started = boot(world, options);
  await waitForSession(started.term);
  return started;
}

async function exitSession({ term, running }) {
  term.stdin.write("/exit\r");
  assert.equal(await running, EXIT.OK);
  assertBalanced(term);
}

const assertNoTokens = (term, world) => {
  const everything = `${term.text()}${term.errText()}${JSON.stringify(world.log)}${JSON.stringify(world.logins)}`;
  assert.doesNotMatch(everything, TOKEN_SHAPED);
  assert.equal(everything.includes(FAKE_GH_TOKEN), false);
};

// --- non-interactive and usage -----------------------------------------------------------------------

test("launchCommands exposes the handler in registry shape", () => {
  const entry = launchCommands.get("launch");
  assert.equal(entry.handler, launchCommand);
  assert.deepEqual(entry.boolean, ["json"]);
  assert.ok(entry.summary);
});

test("non-TTY launch exits 2 with the exact message, writes nothing to stdout and never enters raw mode", async () => {
  const { env } = setup();
  const term = fakeTerminal({ tty: false });
  const code = await runCli(["launch"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env }, { commands: new Map(launchCommands) });
  assert.equal(code, EXIT.USAGE);
  assert.equal(term.errText(), "Asterweave launch error: interactive mode requires a TTY; use --json or a TTY terminal\n");
  assert.equal(term.text(), "");
  assert.deepEqual(term.stdin.rawCalls, []);
});

test("TERM=dumb counts as non-interactive even on a TTY", async () => {
  const { env } = setup();
  const world = makeWorld();
  const { term, running } = boot(world, { env: { ...env, TERM: "dumb" } });
  await assert.rejects(running, (error) => error.exitCode === EXIT.USAGE && /requires a TTY/.test(error.message));
  assert.equal(term.text(), "");
  assert.deepEqual(world.log, [], "nothing was probed");
});

test("--json is rejected for launch (exit 2) and never prompts", async () => {
  const { env } = setup();
  const term = fakeTerminal();
  const world = makeWorld();
  const code = await runCli(["launch", "--json"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, spawn: world.spawn }, { commands: new Map(launchCommands) });
  assert.equal(code, EXIT.USAGE);
  const body = JSON.parse(term.text());
  assert.equal(body.ok, false);
  assert.equal(body.error.code, "USAGE");
  assert.deepEqual(term.stdin.rawCalls, []);
  assert.equal(term.text().includes("\x1b"), false);
  assert.deepEqual(world.log, []);
});

// --- signed in + connected: straight to the session -----------------------------------------------------

test("signed in with a connection: no sign-in, no repo pickers, banner then session, /exit -> 0", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld();
  const started = await toSession(world, { env: { ...env, GH_TOKEN: FAKE_GH_TOKEN }, cwd: clone });
  const { term } = started;

  const screen = lastFrame(term);
  for (const line of [
    "✓ Signed in: GitHub (octo-dev)",
    "✓ Repo: acme/widgets (main)",
    "✓ Runner: Local",
    "✓ Model: Claude Code · claude.ai",
    "Asterweave account: unavailable (local session)",
    "Claude Code · local",
    "Welcome to widgets. How can I help today?",
    "/commands show commands   @context add context (e.g. @repo)",
    "/ @ select  Enter confirm  Esc close",
  ]) assert.ok(screen.includes(line), `banner/session screen includes: ${line}\n${screen}`);
  assert.match(screen, /^Asterweave v9\.9\.9 \| acme\/widgets \(main\) {3}\/help · Esc to close$/m);
  assert.match(screen, /^> /m, "persistent composer");
  assert.equal(screen.split("\n").at(-1).startsWith("> "), true, "composer is the last line");
  assert.equal(screen.includes("!"), false, "no warnings");
  assert.equal(term.text().includes("Sign in to continue."), false);
  assert.equal(term.text().includes("Select a repository"), false);

  assert.equal(world.logins.length, 0);
  assert.equal(world.log.some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false, "no gh repo list");
  for (const entry of world.log.filter((item) => item.name === "claude")) assert.deepEqual(entry.args, ["auth", "status"]);
  assert.deepEqual(term.stdin.rawCalls, [true], "inside the session");
  await exitSession(started);
  assert.equal(existsSync(join(started.ctx.env.ASTERWEAVE_CONFIG_DIR, "credentials.json")), false, "launch persists no credential reference by itself");
  assertNoTokens(term, world);
});

// --- GitHub sign-in (required) ------------------------------------------------------------------------------

test("GitHub not authenticated: sign-in screen, gh login hand-off with the terminal restored, then repository pickers", async () => {
  const { env, clone, files } = setup();
  const world = makeWorld({ gh: ghSignedOut(), onGhLogin: (state) => { state.gh = ghSignedIn(); } });
  const { term, running } = boot(world, { env, cwd: clone });

  await waitFor(() => term.text().includes("Sign in to continue."), { label: "the sign-in screen" });
  const screen = lastFrame(term);
  assert.match(screen, /^\? Choose a provider:$/m);
  assert.match(screen, /^> GitHub \(recommended\)$/m);
  assert.match(screen, /^ {2}Browser sign-in$/m);
  assert.ok(screen.includes("A browser will open to authorize Asterweave. After approval, return here to continue."));
  assert.equal(screen.includes("Welcome to"), false, "no session before sign-in");

  term.stdin.write("\r");
  await waitFor(() => term.text().includes("Select a branch for acme/widgets"), { label: "branch picker (repository comes from origin)" });
  assert.equal(world.logins.length, 1);
  assert.deepEqual(world.logins[0].args, ["auth", "login", "--web", "-h", "github.com", "-s", "repo,read:org"]);
  assert.equal(world.logins[0].name, "gh");
  assert.equal(world.logins[0].stdio, "inherit");
  assert.deepEqual(world.logins[0].rawCalls, [true, false], "raw mode was turned off before the hand-off");
  assert.ok(term.text().indexOf(SEQ.altScreenOff) < term.text().indexOf("Select a branch for acme/widgets"), "terminal restored before anything after the hand-off");
  assert.equal(existsSync(files.repo), false, "nothing connected yet");
  assert.equal(term.text().includes("Select a repository"), false, "the clone's origin decides the repository: no repository picker");
  assert.ok(lastFrame(term).includes("Repository: acme/widgets (from origin)"));

  term.stdin.write("\r");
  await waitForSession(term);
  assert.ok(lastFrame(term).includes("✓ Signed in: GitHub (octo-dev)") && lastFrame(term).includes("✓ Repo: acme/widgets (main)"));
  assert.equal(JSON.parse(readFileSync(files.repo, "utf8")).repository, "acme/widgets");
  const credentials = readFileSync(files.credentials, "utf8");
  assert.match(credentials, /gh-cli/);
  assert.match(credentials, /octo-dev/);
  assert.equal(world.log.some((entry) => entry.name === "gh" && entry.args[0] === "repo"), false, "no gh repo list when origin names the repository");
  await exitSession({ term, running });
  assertNoTokens(term, world);
});

test("B1: an organisation/collaborator clone that gh repo list does not return connects from its origin, without a repository picker", async () => {
  const { env, clone, files } = setup({ cloneOptions: { origin: "https://github.com/acme/widgets.git" } });
  // gh repo list only returns repositories OWNED by the signed-in user: acme/widgets is not among them.
  const world = makeWorld({ repos: JSON.stringify([{ nameWithOwner: "octo-dev/personal", defaultBranchRef: { name: "main" } }]) });
  const { term, running } = boot(world, { env, cwd: clone });
  await waitFor(() => term.text().includes("Select a branch for acme/widgets"), { label: "branch picker" });
  assert.equal(term.text().includes("Select a repository"), false);
  assert.ok(lastFrame(term).includes("Repository: acme/widgets (from origin)"));
  term.stdin.write("\r");
  await waitForSession(term);
  assert.deepEqual({ repository: JSON.parse(readFileSync(files.repo, "utf8")).repository, ghRepoList: world.log.some((entry) => entry.name === "gh" && entry.args[0] === "repo") }, { repository: "acme/widgets", ghRepoList: false });
  await exitSession({ term, running });
});

test("Browser sign-in signs the model provider in, then GitHub is still required", async () => {
  const { env, clone, files } = setup({ connected: true });
  const world = makeWorld({
    gh: ghSignedOut(),
    claude: SIGNED_OUT_CLAUDE,
    onClaudeLogin: (state) => { state.claude = claudeStatus(); },
    onGhLogin: (state) => { state.gh = ghSignedIn(); },
  });
  const { term, running } = boot(world, { env, cwd: clone });

  await waitFor(() => term.text().includes("Sign in to continue."));
  await press(term, DOWN);
  assert.match(lastFrame(term), /> Browser sign-in/);
  term.stdin.write("\r");
  await waitFor(() => lastFrame(term).includes("GitHub sign-in is required to continue."), { label: "the picker again" });
  assert.deepEqual(world.logins.map((login) => [login.name, login.args]), [["claude", ["auth", "login"]]]);
  assert.deepEqual(world.logins[0].rawCalls, [true, false]);
  assert.equal(lastFrame(term).includes("Welcome to"), false, "no session without GitHub");
  assert.match(lastFrame(term), /> GitHub \(recommended\)/);

  term.stdin.write("\r");
  await waitForSession(term);
  assert.deepEqual(world.logins.map((login) => login.name), ["claude", "gh"]);
  assert.ok(lastFrame(term).includes("✓ Model: Claude Code · claude.ai"));
  assert.match(readFileSync(files.credentials, "utf8"), /claude-cli/);
  assert.match(readFileSync(files.credentials, "utf8"), /gh-cli/);
  await exitSession({ term, running });
});

test("a failed model sign-in is reported on the picker and GitHub is still asked for", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ gh: ghSignedOut(), claude: SIGNED_OUT_CLAUDE, claudeInstalled: false });
  const { term, running } = boot(world, { env, cwd: clone });
  await waitFor(() => term.text().includes("Sign in to continue."));
  await press(term, DOWN);
  term.stdin.write("\r");
  await waitFor(() => lastFrame(term).includes("Model sign-in did not complete"));
  assert.ok(lastFrame(term).replace(/\s*\n\s*/g, " ").includes("GitHub sign-in is required to continue."), "the notice wraps on narrow terminals");
  term.stdin.write("\x03");
  assert.equal(await running, EXIT.INTERRUPTED);
  assertBalanced(term);
});

test("denied scopes send the user to sign-in instead of the session; Esc cancels with exit 1", async () => {
  const { env, clone, files } = setup({ connected: true });
  const world = makeWorld({ gh: ghSignedIn({ scopes: "gist" }) });
  const { term, running } = boot(world, { env, cwd: clone });
  const outcome = assert.rejects(running, (error) => error.code === "LAUNCH_CANCELLED" && error.exitCode === EXIT.ERROR && /GitHub sign-in/.test(error.message));
  await waitFor(() => term.text().includes("Sign in to continue."));
  assert.match(lastFrame(term), /lacks required scope\(s\): repo, read:org/);
  term.stdin.write("\x1b");
  await outcome;
  assertBalanced(term);
  assert.equal(term.text().includes("Welcome to"), false);
  assert.equal(world.logins.length, 0);
  assert.equal(existsSync(files.credentials), false);
});

test("expired or revoked gh state also requires sign-in", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ gh: ghSignedIn({ state: "error" }), onGhLogin: (state) => { state.gh = ghSignedIn(); } });
  const { term, running } = boot(world, { env, cwd: clone });
  await waitFor(() => term.text().includes("Sign in to continue."));
  assert.match(lastFrame(term), /not valid \(state: error\)/);
  term.stdin.write("\r");
  await waitForSession(term);
  await exitSession({ term, running });
});

test("Ctrl+C at the provider picker returns 130 and restores the terminal", async () => {
  const { env, clone, files } = setup();
  const world = makeWorld({ gh: ghSignedOut() });
  const { term, running } = boot(world, { env, cwd: clone });
  await waitFor(() => term.text().includes("Sign in to continue."));
  term.stdin.write("\x03");
  assert.equal(await running, EXIT.INTERRUPTED);
  assertBalanced(term);
  assert.equal(existsSync(files.credentials) || existsSync(files.repo), false);
});

test("gh missing: remediation and exit 3, no sign-in screen, no session", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ ghInstalled: false });
  const { term, running } = boot(world, { env, cwd: clone });
  await assert.rejects(running, (error) => error.code === "GH_NOT_INSTALLED" && error.exitCode === EXIT.AUTH && /cli\.github\.com/.test(error.remediation));
  assert.equal(term.text(), "");
  assert.deepEqual(term.stdin.rawCalls, []);
});

test("gh missing through runCli prints the remediation on stderr and exits 3", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ ghInstalled: false });
  const term = fakeTerminal();
  // runCli cannot inject `exists`, so drive the handler through a registry entry that adds it.
  const commands = new Map([["launch", { ...launchCommands.get("launch"), handler: (ctx) => launchCommand({ ...ctx, exists: world.exists }) }]]);
  const code = await runCli(["launch"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd: clone, spawn: world.spawn }, { commands });
  assert.equal(code, EXIT.AUTH);
  assert.match(term.errText(), /^Asterweave launch error: The GitHub CLI \(gh\) was not found\.\n/);
  assert.match(term.errText(), /https:\/\/cli\.github\.com\//);
  assert.equal(term.text(), "");
});

// --- interrupted logins -------------------------------------------------------------------------------------------

test("interrupted gh login (non-zero exit, signal, or SIGINT) -> 130 and nothing is persisted", async (t) => {
  const variants = {
    "non-zero exit": { ghLoginCode: 1 },
    "killed by a signal": { ghLoginSignal: "SIGTERM", ghLoginCode: 0 },
    SIGINT: { ghLoginHang: true },
  };
  for (const [label, overrides] of Object.entries(variants)) {
    await t.test(label, async () => {
      const { env, clone, files } = setup();
      const world = makeWorld({ gh: ghSignedOut(), onGhLogin: (state) => { state.gh = ghSignedIn(); }, ...overrides });
      const { term, ctx, running } = boot(world, { env, cwd: clone });
      const outcome = assert.rejects(running, (error) => error.exitCode === EXIT.INTERRUPTED && error.code === "LOGIN_INTERRUPTED");
      await waitFor(() => term.text().includes("Sign in to continue."));
      term.stdin.write("\r");
      if (overrides.ghLoginHang) {
        await waitFor(() => world.logins.length === 1, { label: "the hand-off" });
        ctx.proc.emit("SIGINT");
      }
      await outcome;
      assertBalanced(term);
      assert.equal(existsSync(files.credentials), false, "no credential reference");
      assert.equal(existsSync(files.repo), false, "no repository connection");
      assert.equal(term.text().includes("Select a repository"), false);
      assert.equal(ctx.proc.listenerCount("SIGINT"), 0, "SIGINT listener removed");
    });
  }
});

// --- repository selection ------------------------------------------------------------------------------------------

test("Esc in the repository picker cancels (exit 1) and Ctrl+C interrupts (130); nothing is connected", async () => {
  for (const [key, check] of [["\x1b", "cancel"], ["\x03", "interrupt"]]) {
    const { env, clone, files } = setup({ cloneOptions: { origin: null } }); // no origin: the picker is the fallback
    const world = makeWorld();
    const { term, running } = boot(world, { env, cwd: clone });
    const settled = check === "cancel"
      ? assert.rejects(running, (error) => error.code === "LAUNCH_CANCELLED" && error.exitCode === EXIT.ERROR)
      : running.then((code) => assert.equal(code, EXIT.INTERRUPTED));
    await waitFor(() => term.text().includes("Select a repository"));
    term.stdin.write(key);
    await settled;
    assertBalanced(term);
    assert.equal(existsSync(files.repo), false, check);
  }
});

test("outside a git clone the repository step fails with a typed error and a hint", async () => {
  const { env, files } = setup();
  const notAClone = tempDir("aw-plain-");
  const world = makeWorld();
  const { term, running } = boot(world, { env, cwd: notAClone });
  const outcome = assert.rejects(running, (error) => error.code === "REPO_BRANCHES_FAILED" && /inside a local clone/.test(error.remediation));
  await waitFor(() => term.text().includes("Select a repository"));
  term.stdin.write("\r");
  await outcome;
  assertBalanced(term);
  assert.equal(existsSync(files.repo), false);
});

test("a stale connection (path gone) falls back to the pickers", async () => {
  const { env, clone, files } = setup({ connected: true, cloneOptions: { origin: null } });
  const record = JSON.parse(readFileSync(files.repo, "utf8"));
  writeFileSync(files.repo, JSON.stringify({ ...record, path: join(clone, "gone") }));
  const world = makeWorld();
  const { term, running } = boot(world, { env, cwd: clone });
  await waitFor(() => term.text().includes("Select a repository"));
  term.stdin.write("\x03");
  assert.equal(await running, EXIT.INTERRUPTED);
  assertBalanced(term);
});

// --- banner warnings ----------------------------------------------------------------------------------------------

test("model provider not signed in is a warning line and the session still starts", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ claude: SIGNED_OUT_CLAUDE });
  const started = await toSession(world, { env, cwd: clone });
  const screen = lastFrame(started.term);
  assert.ok(screen.includes("! Model provider: not signed in — run: asterweave auth login model"));
  assert.equal(screen.includes("✓ Model:"), false);
  assert.ok(screen.includes("Asterweave account: unavailable (local session)"));
  await exitSession(started);
});

test("claude missing is also only a warning", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ claudeInstalled: false });
  const started = await toSession(world, { env, cwd: clone });
  assert.match(lastFrame(started.term), /^! Model provider: Claude Code \(claude\) was not found\.$/m);
  await exitSession(started);
});

test("unknown token scopes (GH_SCOPES_UNKNOWN) continue with a warning", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld({ gh: ghSignedIn({ scopes: "", tokenSource: "GH_TOKEN" }) });
  const started = await toSession(world, { env, cwd: clone });
  assert.match(lastFrame(started.term), /^! GitHub: token scopes could not be verified/m);
  assert.equal(world.logins.length, 0);
  await exitSession(started);
});

test("untrusted repository with executable config shows the trust notice and nothing is executed", async () => {
  const { env, clone } = setup({ connected: true });
  writeFileSync(join(clone, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "node", args: ["-e", "process.exit(9)"] } } }));
  const world = makeWorld();
  const started = await toSession(world, { env, cwd: clone });
  const screen = lastFrame(started.term).replace(/\n\s+/g, " "); // warnings wrap on narrow terminals
  assert.ok(screen.includes(`! Repository config not trusted — run: asterweave trust grant --path ${clone}`), screen);
  assert.equal(world.log.some((entry) => entry.name === "node"), false);
  await exitSession(started);

  // Granting trust removes the notice.
  grantTrust(clone, { env });
  const trusted = await toSession(makeWorld(), { env, cwd: clone });
  assert.equal(lastFrame(trusted.term).includes("Repository config not trusted"), false);
  await exitSession(trusted);
});

test("an untrusted repository without executable config shows no notice", async () => {
  const { env, clone } = setup({ connected: true });
  const started = await toSession(makeWorld(), { env, cwd: clone });
  assert.equal(lastFrame(started.term).includes("not trusted"), false);
  await exitSession(started);
});

// --- session behaviour through launch ------------------------------------------------------------------------------

test("free text and /sessions /usage /settings print the not-available line and spawn nothing", async () => {
  const { env, clone } = setup({ connected: true });
  const world = makeWorld();
  const started = await toSession(world, { env, cwd: clone });
  const { term } = started;
  const spawned = world.log.length;

  for (const line of ["hello world", "/sessions", "/usage", "/settings", "/context"]) {
    const before = frames(term);
    term.stdin.write(`${line}\r`);
    await waitFor(() => frames(term) >= before + line.length + 1 && lastFrame(term).includes(`> ${line}`), { label: line });
    const screen = lastFrame(term);
    const index = screen.lastIndexOf(`> ${line}`);
    assert.ok(screen.slice(index).includes(NOT_AVAILABLE), `${line} -> not available`);
  }
  assert.equal(world.log.length, spawned, "no process was spawned after the session started");
  assert.equal(world.log.some((entry) => entry.name === "claude" && entry.args.includes("-p")), false);
  assert.equal(term.errText(), "");
  await exitSession(started);
});

test("Ctrl+C -> 130, Ctrl+D -> 0, closed input -> 0; the terminal is restored every time", async () => {
  for (const [input, expected] of [["\x03", EXIT.INTERRUPTED], ["\x04", EXIT.OK], [null, EXIT.OK]]) {
    const { env, clone } = setup({ connected: true });
    const started = await toSession(makeWorld(), { env, cwd: clone });
    if (input === null) started.term.stdin.end();
    else started.term.stdin.write(input);
    assert.equal(await started.running, expected, JSON.stringify(input));
    assertBalanced(started.term);
    assert.equal(started.term.stdin.rawCalls.at(-1), false);
  }
});

test("SIGINT during the session restores the terminal and returns 130", async () => {
  const { env, clone } = setup({ connected: true });
  const started = await toSession(makeWorld(), { env, cwd: clone });
  started.ctx.proc.emit("SIGINT");
  assert.equal(await started.running, EXIT.INTERRUPTED);
  assertBalanced(started.term);
  assert.equal(started.ctx.proc.exitCode, 130);
  assert.equal(started.ctx.proc.listenerCount("SIGINT"), 0);
});

test("an error thrown inside the session loop still restores the terminal", async () => {
  const { env, clone } = setup({ connected: true });
  const started = await toSession(makeWorld(), { env, cwd: clone });
  const { term } = started;
  Object.defineProperty(term.stdout, "columns", { configurable: true, get() { throw new Error("render exploded"); } });
  const outcome = assert.rejects(started.running, /render exploded/);
  term.stdin.write("x");
  await outcome;
  assert.deepEqual(term.stdin.rawCalls, [true, false]);
  assert.ok(term.text().includes(SEQ.showCursor));
  assert.ok(term.text().includes(SEQ.altScreenOff));
});

test("resize re-renders the session at the new width", async () => {
  const { env, clone } = setup({ connected: true });
  const started = await toSession(makeWorld(), { env, cwd: clone });
  const { term } = started;
  const before = frames(term);
  term.stdout.columns = 40;
  term.stdout.emit("resize");
  await waitFor(() => frames(term) > before, { label: "resize redraw" });
  for (const line of lastFrame(term).split("\n")) assert.ok([...line].length <= 40, `line fits 40 columns: ${line}`);
  await exitSession(started);
});
