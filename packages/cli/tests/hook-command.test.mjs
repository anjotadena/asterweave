// `asterweave hook pre-tool-use`: real subprocess tests (piped stdio) plus registry-level checks for the
// hidden-command support in cli.mjs. Contract: exit 0 with the plugin's hookSpecificOutput document for every
// payload (malformed input is a DENY, never a pass), exit 2 only for usage errors.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { helpText, runCli, usageText } from "../src/cli.mjs";
import { registerAllCommands } from "../src/commands/index.mjs";

const bin = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
let base;
let workspace;
let userDir;

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-hookcmd-")));
  workspace = join(base, "work");
  userDir = join(base, "user");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(workspace, "a.txt"), "a\n");
  // Every git or gh form is understood only in a workspace root that has a .git entry (round 6): a real repository when git exists, else the entry alone.
  if (spawnSync("git", ["init", "-q"], { cwd: workspace, windowsHide: true }).status !== 0) mkdirSync(join(workspace, ".git"), { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function spawnCli(args, { input, env = {}, cwd = workspace } = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    input,
    cwd,
    encoding: "utf8",
    // CLAUDE_PROJECT_DIR is pinned: the hook takes the workspace boundary from it (or from the git top level), and a
    // developer running these tests inside Claude Code has it set to the repository under test.
    env: { ...process.env, ASTERWEAVE_CONFIG_DIR: userDir, CLAUDE_PROJECT_DIR: workspace, ...env },
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const payload = (command, extra = {}) => JSON.stringify({ tool_name: "Bash", cwd: workspace, tool_input: { command }, ...extra });
const hook = (input, options) => spawnCli(["hook", "pre-tool-use"], { input, ...options });
function decisionOf(result) {
  assert.equal(result.code, 0, `exit ${result.code}: ${result.err}`);
  if (result.out === "") return { permissionDecision: "none", permissionDecisionReason: "" };
  const parsed = JSON.parse(result.out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PreToolUse");
  return parsed.hookSpecificOutput;
}

test("denies a destructive command with the plugin's output shape", () => {
  const result = hook(payload("git reset --hard HEAD~1"));
  assert.equal(result.code, 0);
  assert.deepEqual(Object.keys(JSON.parse(result.out)), ["hookSpecificOutput"]);
  const output = decisionOf(result);
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /^Asterweave blocked this command: git reset --hard/);
  assert.equal(decisionOf(hook(payload("git clean -fdx"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("rm -rf /"))).permissionDecision, "deny");
});

test("asks for a push to the default branch and mentions submit-pr", () => {
  for (const command of ["git push origin main", "git -c user.name=x push origin master", "git push origin HEAD:main", "git push --all origin"]) {
    const output = decisionOf(hook(payload(command)));
    assert.equal(output.permissionDecision, "ask", command);
    assert.match(output.permissionDecisionReason, /submit-pr/);
  }
});

test("allows ordinary commands with no output (the normal permission flow continues)", () => {
  for (const command of ["ls", "git status", "cat a.txt", "git log --oneline", "git commit -m msg"]) {
    const result = hook(payload(command));
    assert.equal(result.code, 0, command);
    assert.equal(result.out, "", command);
  }
});

test("G: a push is understood only to a remote configured in the workspace repository (the real hook, a real repository)", (t) => {
  const repo = join(base, "pushrepo");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (git("--version").status !== 0) return t.skip("git is not available");
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  const env = { CLAUDE_PROJECT_DIR: repo };
  const asked = (command) => decisionOf(hook(payload(command, { cwd: repo }), { env, cwd: repo })).permissionDecision;
  for (const command of ["git push -u origin feat/x", "git push origin feat/x"]) assert.equal(asked(command), "none", command);
  // `x` is no configured remote: git would read it as the local path x and run the receive-pack hooks of the repository found there.
  for (const command of ["git push x feat/x", "git push -u x feat/x", "git push upstream feat/x"]) assert.equal(asked(command), "ask", command);
});

test("asks (never silently allows) for forms the allow-list does not understand: build tools, interpreters, wrappers, writes", () => {
  for (const command of ["npm test", "dotnet test App.sln", "exec -a x git push origin feat/x", "stdbuf -o 0 ls", "echo x > out.txt", "node a.js"]) {
    const output = decisionOf(hook(payload(command)));
    assert.equal(output.permissionDecision, "ask", command);
  }
});

test("the hook never emits an allow document: --emit-allow no longer exists (unknown flag, exit 2, which blocks)", () => {
  const result = spawnCli(["hook", "pre-tool-use", "--emit-allow"], { input: payload("ls") });
  assert.equal(result.code, 2);
  assert.equal(result.out.includes("hookSpecificOutput"), false);
  // Every allowed command prints nothing at all: an explicit "allow" would skip the user's own permission prompt.
  for (const command of ["ls", "git status", "cat a.txt"]) assert.equal(hook(payload(command)).out, "", command);
});

test("malformed input is denied, never passed (exit 0 with a deny document)", () => {
  const cases = [
    ["not json", "{nope"],
    ["empty stdin", ""],
    ["json null", "null"],
    ["json array", "[]"],
    ["json string", '"git status"'],
    ["no tool_input", JSON.stringify({ tool_name: "Bash" })],
    ["tool_input is a string", JSON.stringify({ tool_input: "ls" })],
    ["command is a number", JSON.stringify({ tool_input: { command: 5 } })],
    ["command is an array", JSON.stringify({ tool_input: { command: ["ls"] } })],
    ["command missing", JSON.stringify({ tool_input: {} })],
    ["script is an object", JSON.stringify({ tool_input: { script: {} } })],
    ["write without a path", JSON.stringify({ tool_name: "Write", tool_input: {} })],
  ];
  for (const [label, input] of cases) {
    const output = decisionOf(hook(input));
    assert.equal(output.permissionDecision, "deny", label);
    assert.match(output.permissionDecisionReason, /blocked/, label);
  }
  // `script` is accepted like the plugin does.
  assert.equal(decisionOf(hook(JSON.stringify({ tool_input: { script: "git reset --hard" } }))).permissionDecision, "deny");
});

test("an oversized payload is denied", () => {
  const huge = payload("ls", { padding: "x".repeat(2 * 1024 * 1024) });
  const output = decisionOf(hook(huge));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /larger than 1 MiB/);
});

test("the guard rules beyond the plugin apply: secrets, paths outside the workspace, self-approval", () => {
  assert.equal(decisionOf(hook(payload("cat .env"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("cat ../elsewhere.txt"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("asterweave run approve r1 --approval a --subject abc"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("asterweave run approve r1 --approval a --subject abc --nonce 0123456789abcdef"))).permissionDecision, "deny", "a quoted nonce does not make it acceptable");
  assert.equal(decisionOf(hook(payload("asterweave mcp test files --approve abcdef123456 --nonce 0123456789abcdef"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload(`echo x > "${join(userDir, "runs", "r", "run.json")}"`))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("echo $(whoami)"))).permissionDecision, "ask", "supervised: unparseable asks");
  assert.equal(decisionOf(hook(payload("npm install left-pad"))).permissionDecision, "ask");
  assert.equal(decisionOf(hook(JSON.stringify({ tool_name: "Write", cwd: workspace, tool_input: { file_path: join(base, "outside.txt") } }))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(JSON.stringify({ tool_name: "Edit", cwd: workspace, tool_input: { file_path: join(workspace, "a.txt") } }))).permissionDecision, "none");
});

test("payload.cwd is only the working directory: the workspace root comes from CLAUDE_PROJECT_DIR (changed from: the payload cwd was the root)", () => {
  const sub = join(workspace, "sub");
  mkdirSync(sub, { recursive: true });
  // From a sub directory, ../a.txt is still inside the project root.
  assert.equal(decisionOf(hook(payload("cat ../a.txt", { cwd: sub }))).permissionDecision, "none");
  // A cwd outside the root (a model that cd'd to the parent) does not widen the boundary: everything it touches is outside.
  assert.equal(decisionOf(hook(payload("cat a.txt", { cwd: base }))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("cat ../elsewhere.txt"))).permissionDecision, "deny");
  // No payload cwd: the process cwd is the working directory.
  assert.equal(decisionOf(hook(payload("cat a.txt", { cwd: undefined }), { cwd: workspace })).permissionDecision, "none");
  assert.equal(decisionOf(hook(payload("cat a.txt", { cwd: "relative/path" }), { cwd: workspace })).permissionDecision, "none", "a relative payload cwd falls back to the process cwd");
});

test("H6: with cwd = the home directory or the filesystem root nothing becomes inside the workspace", () => {
  const home = join(base, "fakehome");
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "notes.txt"), "n\n");
  // The project root is the workspace; a payload whose cwd is the "home" directory reads outside it.
  assert.equal(decisionOf(hook(payload("cat notes.txt", { cwd: home }))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("cat notes.txt", { cwd: parse(base).root }))).permissionDecision, "deny");
});

test("H6: without CLAUDE_PROJECT_DIR the root is the git top level of the cwd; no git repository means deny", () => {
  const repo = join(base, "gitrepo");
  mkdirSync(join(repo, "pkg"), { recursive: true });
  writeFileSync(join(repo, "pkg", "a.txt"), "a\n");
  const git = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8" });
  assert.equal(git.status, 0, git.stderr);
  const noProject = { CLAUDE_PROJECT_DIR: undefined };
  // Inside the repository the top level is the root: ../README from pkg is inside, ../../x leaves it.
  assert.equal(decisionOf(hook(payload("cat a.txt", { cwd: join(repo, "pkg") }), { env: noProject })).permissionDecision, "none");
  assert.equal(decisionOf(hook(payload("cat ../README", { cwd: join(repo, "pkg") }), { env: noProject })).permissionDecision, "none");
  assert.equal(decisionOf(hook(payload("cat ../../outside.txt", { cwd: join(repo, "pkg") }), { env: noProject })).permissionDecision, "deny");
  // A directory that is not in a repository: the root cannot be determined.
  const plain = join(base, "plain");
  mkdirSync(plain, { recursive: true });
  const output = decisionOf(hook(payload("ls", { cwd: plain }), { env: noProject }));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /workspace root cannot be determined/);
});

test("H6: a CLAUDE_PROJECT_DIR that is relative or missing is a deny", () => {
  assert.match(decisionOf(hook(payload("ls"), { env: { CLAUDE_PROJECT_DIR: "relative/dir" } })).permissionDecisionReason, /not an absolute path/);
  assert.match(decisionOf(hook(payload("ls"), { env: { CLAUDE_PROJECT_DIR: join(base, "does-not-exist") } })).permissionDecisionReason, /does not exist/);
});

test("H2: Bash is classified as a POSIX shell on every host (backslash escapes are removed), PowerShell with backtick escapes", () => {
  const bash = (command) => decisionOf(hook(payload(command))).permissionDecision;
  assert.equal(bash("git rese\\t --hard"), "deny");
  assert.equal(bash("g\\it reset --hard"), "deny");
  assert.equal(bash("git push origin ma\\in"), "ask");
  const powershell = (command) => decisionOf(hook(payload(command, { tool_name: "PowerShell" }))).permissionDecision;
  assert.equal(powershell("git re`set --hard"), "deny");
  assert.equal(powershell("git push origin ma`in"), "ask");
});

test("H1: oversized commands are denied before any classification", () => {
  const output = decisionOf(hook(payload(`echo ${"a".repeat(70 * 1024)}`)));
  assert.equal(output.permissionDecision, "deny");
  assert.match(output.permissionDecisionReason, /longer than/);
});

test("H5: the Write and Edit tools may not touch .git, .claude settings or .mcp.json", () => {
  for (const file of [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".claude/settings.local.json", ".claude/asterweave.json", ".claude/hooks/x.mjs", ".mcp.json"]) {
    for (const tool_name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      const input = tool_name === "NotebookEdit" ? { notebook_path: join(workspace, file) } : { file_path: join(workspace, file) };
      const output = decisionOf(hook(JSON.stringify({ tool_name, cwd: workspace, tool_input: input })));
      assert.equal(output.permissionDecision, "deny", `${tool_name} ${file}`);
    }
  }
  assert.equal(decisionOf(hook(payload("echo x > .git/hooks/pre-commit"))).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("tee .claude/settings.json"))).permissionDecision, "deny");
  assert.equal(hook(JSON.stringify({ tool_name: "Write", cwd: workspace, tool_input: { file_path: join(workspace, "docs", "a.md") } })).out, "");
});

test("environment variables cannot switch the guard off", () => {
  const env = { ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD: "1", ASTERWEAVE_ALLOW_DEFAULT_BRANCH_PUSH: "1" };
  assert.equal(decisionOf(hook(payload("git reset --hard"), { env })).permissionDecision, "deny");
  assert.equal(decisionOf(hook(payload("git push origin main"), { env })).permissionDecision, "ask");
});

test("usage errors exit 2 (which blocks), and never print a hook document", () => {
  for (const args of [["hook", "pre-tool-use", "--bogus"], ["hook", "pre-tool-use", "--json"], ["hook"], ["hook", "post-tool-use"], ["hook", "pre-tool-use", "extra"], ["hook", "pre-tool-use", "-x"]]) {
    const result = spawnCli(args, { input: payload("ls") });
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.out.includes("hookSpecificOutput"), false);
    // Global quirk: with --json the dispatcher prints its error envelope on stdout instead; either way it exits 2.
    if (!args.includes("--json")) assert.match(result.err, /Asterweave hook error/);
  }
});

test("the hook command is hidden from help and usage but still dispatches", async () => {
  const help = spawnCli(["help"]);
  assert.equal(help.code, 0);
  assert.equal(/^\s+hook\b/m.test(help.out), false, help.out);
  assert.match(help.out, /^\s+doctor\s/m);
  assert.equal(/^\s+hook\b/m.test(spawnCli(["--help"]).out), false);
  assert.equal(/^\s+hook\b/m.test(usageText()), false);
  assert.equal(/^\s+hook\b/m.test(helpText()), false);
  // `help hook` still describes it, and an unknown command is still unknown.
  assert.equal(spawnCli(["help", "hook"]).code, 0);
  assert.equal(spawnCli(["help", "no-such"]).code, 2);
});

test("registry: a hidden command is not listed but dispatches; others are unaffected", async () => {
  const chunks = [];
  const registry = registerAllCommands(new Map());
  registry.set("secret-tool", { handler: (ctx) => { ctx.stdout.write("ran\n"); return 0; }, summary: "Do secret things", boolean: [], hidden: true });
  registry.set("shown-tool", { handler: () => 0, summary: "Do shown things", boolean: [] });
  const usage = usageText(registry);
  assert.equal(usage.includes("secret-tool"), false);
  assert.match(usage, /shown-tool\s+Do shown things/);
  assert.equal(helpText(registry).includes("secret-tool"), false);
  const code = await runCli(["secret-tool"], { stdout: { write: (text) => chunks.push(String(text)) }, stderr: { write: () => {} } }, { commands: registry });
  assert.equal(code, 0);
  assert.equal(chunks.join(""), "ran\n");
  assert.equal(registry.get("hook").hidden, true);
  assert.equal(registry.get("doctor").hidden, false);
});

test("N1: the real hook asks (never stays silent) for git and gh forms run from a committed bare-repository-shaped directory (real repository, plain-fs built evil/)", (t) => {
  const repo = join(base, "embedded");
  mkdirSync(repo, { recursive: true });
  const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
  if (git("--version").status !== 0) return t.skip("git is not available");
  assert.equal(git("init", "-q").status, 0);
  assert.equal(git("remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  const marker = join(repo, "MARKER.txt");
  const evil = join(repo, "evil");
  for (const dir of ["objects/info", "refs/heads", "hooks"]) mkdirSync(join(evil, dir), { recursive: true });
  writeFileSync(join(evil, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(evil, "config"), `[core]\n\tbare = false\n\tworktree = ..\n\tfsmonitor = "echo pwned > '${marker.split("\\").join("/")}'; false"\n`);
  writeFileSync(join(evil, "objects", "info", "keep"), "");
  writeFileSync(join(evil, "refs", "heads", "keep"), "");
  // The commondir variant.
  mkdirSync(join(repo, "evil2"), { recursive: true });
  writeFileSync(join(repo, "evil2", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(repo, "evil2", "commondir"), "../evil\n");
  mkdirSync(join(repo, "packages", "cli"), { recursive: true });
  const env = { CLAUDE_PROJECT_DIR: repo };
  const decide = (tool, command, cwd) => decisionOf(hook(JSON.stringify({ tool_name: tool, cwd, tool_input: { command } }), { env, cwd: repo })).permissionDecision;
  for (const command of ["git status", "git log", "git diff", "git commit -m x", "git push origin feat/x", "gh pr create --fill"]) {
    assert.equal(decide("Bash", command, evil), "ask", `cwd=evil ${command}`);
  }
  assert.equal(decide("Bash", "git log", join(evil, "refs")), "ask");
  assert.equal(decide("Bash", "git status", join(repo, "evil2")), "ask");
  assert.equal(decide("Bash", "cd evil && git status", repo), "ask");
  assert.equal(decide("Bash", "cd evil/refs && git status", repo), "ask");
  assert.equal(decide("Bash", "cd evil && gh pr create --fill", repo), "ask");
  assert.equal(decide("PowerShell", "Set-Location evil; git status", repo), "ask");
  // Controls: the root and an ordinary subdirectory stay silent (allowed).
  assert.equal(decide("Bash", "git status", repo), "none");
  assert.equal(decide("Bash", "git push origin feat/x", repo), "none");
  assert.equal(decide("Bash", "git status", join(repo, "packages", "cli")), "none");
  assert.equal(decide("Bash", "git commit -m x", join(repo, "packages", "cli")), "none");
  // Round 6: the hook never follows a cd, so a cd together with another command asks even when it would land in a normal directory.
  assert.equal(decide("Bash", "cd packages/cli && git commit -m x", repo), "ask");
  assert.equal(existsSync(marker), false, "the hook only classifies: nothing ran the embedded configuration");
});

test("inside an Asterweave run (ASTERWEAVE_RUN_ID set) an ask becomes a deny with a way forward: headless claude cannot answer a prompt", () => {
  const env = { ASTERWEAVE_RUN_ID: "run-1" };
  for (const command of ["git push origin main", "npm test", "node a.js"]) {
    const output = decisionOf(hook(payload(command), { env }));
    assert.equal(output.permissionDecision, "deny", command);
    assert.match(output.permissionDecisionReason, /headless run cannot ask/);
    assert.match(output.permissionDecisionReason, /choose another approach/);
  }
  // Unchanged outside a run, and an allow stays an allow inside one.
  assert.equal(decisionOf(hook(payload("npm test"))).permissionDecision, "ask");
  assert.equal(hook(payload("ls"), { env }).out, "");
});
