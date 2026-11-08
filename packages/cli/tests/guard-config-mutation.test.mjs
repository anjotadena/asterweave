// Phase F2 guard floors: an agent must not change executable configuration (MCP servers, plugins) through ANY door:
// `asterweave mcp add|remove`, `asterweave plugin install|uninstall|enable|disable`, or `claude mcp|plugin ...` directly.
// Deny, reason APPROVAL_SELF_GRANT, ruleId config-mutation. Read-only forms stay allowed.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { classifyShell, evaluate } from "./guard-fixture.mjs";

let root;
let base;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-guard-cm-")));
  root = join(base, "repo");
  mkdirSync(join(root, ".git"), { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const ctx = (extra = {}) => ({ workspaceRoot: root, cwd: root, mode: "supervised", userDir: join(base, "user"), homedir: () => join(base, "home"), env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], ...extra });
const shell = (command, extra) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx(extra));
const findings = (command) => classifyShell(command, { cwd: root, workspaceRoot: root, userDir: join(base, "user"), homedir: () => join(base, "home"), branchOf: () => "feat/x", remotesOf: () => ["origin"] }).findings;

const DENIED = [
  // asterweave, option order and spelling
  "asterweave mcp add files --scope repo -- node server.js", "asterweave mcp remove files --scope global --yes", "asterweave --json mcp add x --scope repo --yes -- node",
  "asterweave mcp --path . add x --scope repo", "asterweave mcp remove x --path ./repo --scope repo", "asterweave.exe mcp add x", "node packages/cli/bin/asterweave.mjs mcp add x --scope global -- node",
  "asterweave plugin install p@m --scope global --yes", "asterweave plugin uninstall p@m --scope repo", "asterweave plugin enable p@m --scope repo", "asterweave plugin disable p@m --scope global --yes --json",
  "asterweave plugin --path x install p@m --scope repo", "asterweave PLUGIN INSTALL p@m",
  // wrappers and quoting
  "npx asterweave mcp add x", "sudo asterweave plugin install p@m --scope global", "bash -c 'asterweave mcp add x --scope repo'", "env FOO=1 asterweave mcp remove x --scope repo",
  'asterweave "mcp" "add" x --scope repo', "asterweave 'plugin' 'install' p@m --scope global", "echo hi && asterweave mcp add x --scope repo", "cd . && asterweave plugin enable p@m --scope repo",
  // claude directly
  "claude mcp add files -s project -- node server.js", "claude mcp remove files -s user", "claude mcp add-json x '{}' -s project", "claude mcp add-from-claude-desktop", "claude mcp reset-project-choices",
  "claude mcp rm files -s user", "claude --debug mcp add x -s project -- node", "claude.exe mcp add x -s project -- node", "/usr/local/bin/claude mcp add x -s user -- node", "/c/tools/claude.cmd mcp remove x",
  "claude plugin install p@m -s user", "claude plugin uninstall p@m", "claude plugin enable p@m -s project", "claude plugin disable p@m", "claude plugin update p@m", "claude plugin prune",
  "claude plugin marketplace add owner/repo", "claude plugin marketplace remove x", "claude plugins install p@m", "claude plugin remove p@m",
  "sudo claude mcp add x -s user -- node", "bash -c 'claude mcp add x -s user -- node'", "npx @anthropic-ai/claude-code mcp add x -s user -- node", 'claude "mcp" "add" x -s user -- node', "claude -s user mcp add x -- node",
  "env CLAUDE_X=1 claude plugin install p@m",
  // F3: the cli entry point, xargs, an unresolvable command word
  "node ./node_modules/@anthropic-ai/claude-code/cli.js mcp add x -s user -- node e.js", "node C:/Users/a/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/cli.js plugin install x@m -s user",
  "echo add x -s user -- node e.js | xargs claude mcp", "xargs -a args.txt claude mcp", "echo add | xargs asterweave plugin", "cat verbs.txt | xargs asterweave mcp",
  "c=claude; $c mcp add x -s user -- node e.js", "$(echo claude) mcp add x -s user", "%COMSPEC% /c claude mcp add x -s user -- node e.js", "Start-Process claude -ArgumentList 'mcp','add','x'",
  "$c = 'claude'; & $c plugin install x@m",
  // N2: options with values between the area and the verb, variable/glob verbs, unresolved command words
  "claude mcp --debug api add x -s user -- node e.js", "claude mcp --permission-mode plan add x", "claude mcp --add-dir /x add x", "claude -c mcp add x", "claude --resume abc mcp add x", "claude mcp -h add x",
  "claude mcp $V y -s user -- node e.js", "claude mcp ad* y", "claude mcp a?d y", "claude mcp $(echo add) y", "asterweave plugin --keep-data uninstall p",
  "${X} mcp add x", "& $env:C mcp add x", "iex ('cla'+'ude mcp a'+'dd x')", "c=cl; ${c}aude mcp add x", "$CLAUDE mcp add x", "${X} plugin install p@m",
];

const ALLOWED = [
  "asterweave mcp list", "asterweave mcp list --json", "asterweave mcp inspect files", "asterweave mcp validate", "asterweave plugin list", "asterweave plugin list --scope all --json", "asterweave plugin inspect p@m",
  "claude --version", "claude -p 'explain mcp add'", "grep -r 'mcp add' docs", "git log --grep='plugin install'", "claude mcp x add", "$CLAUDE mcp list", "asterweave mcp test add", "asterweave mcp inspect remove", "asterweave plugin inspect enable", "claude mcp --help", "asterweave trust status", "claude plugin list", "claude --version", "echo mcp add", "ls plugin", "node ./node_modules/@anthropic-ai/claude-code/cli.js --version", "xargs -n1 echo", "Start-Process notepad -ArgumentList 'x'",
];

test("every door to MCP/plugin mutation is denied as an approval self-grant", () => {
  for (const command of DENIED) {
    const decision = shell(command);
    assert.equal(decision.decision, "deny", command);
    assert.equal(decision.reason, "APPROVAL_SELF_GRANT", command);
    assert.ok(findings(command).some((finding) => finding.ruleId === "config-mutation"), `${command}: ruleId config-mutation`);
  }
});

test("autonomous mode denies them too", () => {
  const autonomous = { mode: "autonomous", policy: { v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["k"], branches: ["feat/*"], tools: ["shell", "read", "write", "edit", "git"], operations: ["commit"] } } };
  for (const command of ["asterweave mcp add x --scope repo", "claude plugin install p@m", "claude mcp add x -s user -- node"]) assert.equal(shell(command, autonomous).reason, "APPROVAL_SELF_GRANT", command);
});

test("read-only forms are not config-mutation floors", () => {
  for (const command of ALLOWED) assert.ok(!findings(command).some((finding) => finding.ruleId === "config-mutation"), command);
  assert.notEqual(shell("asterweave mcp list").reason, "APPROVAL_SELF_GRANT");
  assert.notEqual(shell("asterweave plugin list").reason, "APPROVAL_SELF_GRANT");
});

// Windows spellings are judged under the win32 dialects (the posix dialect would eat the backslashes), so they are tested with an explicit platform.
test("Windows paths and cmd/PowerShell spellings are denied under platform win32", () => {
  // same forced-platform seams as guard.test.mjs (identity realpath, nothing on disk), so it behaves the same on every host
  const options = { platform: "win32", cwd: "C:/work/repo", workspaceRoot: "C:/work/repo", userDir: "C:/Users/u/AppData/Roaming/asterweave", homedir: () => "C:/Users/u", realpath: (value) => value };
  const B = String.fromCharCode(92);
  for (const command of [`C:${B}tools${B}claude.cmd mcp remove x`, `"C:${B}Program Files${B}claude${B}claude.exe" mcp add x -s user -- node`, "claude.exe mcp add x", `node C:${B}x${B}asterweave${B}bin${B}asterweave.mjs plugin install a@b`, "cmd /c claude mcp add x -s user -- node", "powershell -c \"claude plugin install p@m\""]) {
    assert.ok(classifyShell(command, options).findings.some((finding) => finding.ruleId === "config-mutation"), command);
  }
  assert.ok(!classifyShell("claude.exe plugin list", options).findings.some((finding) => finding.ruleId === "config-mutation"));
});
