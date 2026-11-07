// Differential test: everything the plugin's hook-guard.mjs denies or asks about, the CLI guard denies or asks
// about at least as strictly. The plugin module is imported by THIS TEST ONLY (never at runtime), like
// tests/redact-parity.test.mjs. Where the CLI is intentionally stricter or intentionally more precise, the
// command is listed explicitly below with the reason.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import { evaluateCommand, evaluatePush, runHook } from "../../../plugins/asterweave/scripts/hook-guard.mjs";
import { runCli } from "../src/cli.mjs";
import { evaluate, rank } from "./guard-fixture.mjs";

let base;
let root;
let userDir;
let home;

before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-parity-")));
  root = join(base, "work");
  userDir = join(base, "userdir");
  home = join(base, "home");
  for (const dir of [root, userDir, home]) mkdirSync(dir, { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const pluginRank = (command, branch) => {
  if (evaluateCommand(command).blocked) return 2;
  return evaluatePush(command, { cwd: root, branchOf: () => branch }).ask ? 1 : 0;
};
const cliDecision = (command, branch) =>
  evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, { workspaceRoot: root, cwd: root, mode: "supervised", userDir, homedir: () => home, env: {}, branchOf: () => branch, remotesOf: () => ["origin"] });

// Fixtures copied from plugins/asterweave/tests/hooks.test.mjs.
const PLUGIN_DENY = ["git reset --hard HEAD~1", "rm -rf /", "git clean -fdx"];
const PLUGIN_ALLOW = ["dotnet test App.sln"];
const PLUGIN_PUSH = [
  // [command, current branch, plugin asks]
  ["git push -u origin feat/pos", "feat/pos", false],
  ["git push", "feat/pos", false],
  ["git push --tags", "main", false],
  ["git push origin --delete old-branch", "feat/pos", false],
  ["git status && git log", "main", false],
  ["git push origin master", "feat/pos", true],
  ["git push origin HEAD:main", "feat/pos", true],
  ["git push origin +refs/heads/release:refs/heads/main", "feat/pos", true],
  ["git push", "main", true],
  ["dotnet test && git -C ../repo push origin", "main", true],
  ["git push --all origin", "feat/pos", true],
  ["git push origin main", "feat/pos", true],
];

test("plugin deny fixtures are denied by the CLI guard", () => {
  for (const command of PLUGIN_DENY) {
    assert.equal(evaluateCommand(command).blocked, true, `fixture drifted: ${command}`);
    assert.equal(cliDecision(command, "feat/pos").decision, "deny", command);
  }
});

// The CLI guard is an ALLOW-LIST, so plugin ALLOW fixtures that are not an understood form now ASK (never deny). Each one is listed with its reason.
const INTENTIONALLY_STRICTER = new Map([
  ["dotnet test App.sln", "build tools and interpreters are not in the allow-list (a user can list the exact command in policy.json allowCommands)"],
  ["git push", "a bare push is not an understood form (the allow-list needs 'git push <remote> <branch>')"],
  ["git push --tags", "extra push flags are not allow-listed"],
  ["git push origin --delete old-branch", "a branch deletion is not an understood form"],
]);

test("plugin allow fixtures remain allowed, or are listed in INTENTIONALLY_STRICTER with a reason", () => {
  for (const command of [...PLUGIN_ALLOW, "git status && git log"]) {
    assert.equal(pluginRank(command, "feat/pos"), 0);
    if (INTENTIONALLY_STRICTER.has(command)) assert.equal(cliDecision(command, "feat/pos").decision, "require-approval", command);
    else assert.equal(cliDecision(command, "feat/pos").decision, "allow", command);
  }
  for (const [command, why] of INTENTIONALLY_STRICTER) {
    assert.ok(why.length > 10, command);
    const decision = cliDecision(command, "feat/pos");
    assert.equal(`${decision.decision}/${decision.reason}`, "require-approval/UNPARSEABLE_COMMAND", command);
  }
});

test("plugin push fixtures: asks stay asks (or become denies), non-asks stay allowed", () => {
  for (const [command, branch, asks] of PLUGIN_PUSH) {
    assert.equal(evaluatePush(command, { cwd: root, branchOf: () => branch }).ask, asks, `fixture drifted: ${command}`);
    const decision = cliDecision(command, branch);
    if (asks) assert.ok(rank(decision) >= 1, `${command} -> ${decision.decision}`);
    else if (INTENTIONALLY_STRICTER.has(command)) assert.equal(decision.decision, "require-approval", command);
    else assert.equal(decision.decision, "allow", command);
  }
  // The two that changed class, on purpose:
  //  - a leading '+' is a FORCE push of that ref, so the CLI denies it instead of asking;
  //  - '-C ../repo' leaves the workspace, so the CLI denies it (PATH_OUTSIDE_WORKSPACE) instead of asking.
  assert.equal(cliDecision("git push origin +refs/heads/release:refs/heads/main", "feat/pos").decision, "deny");
  assert.equal(cliDecision("dotnet test && git -C ../repo push origin", "main").reason, "PATH_OUTSIDE_WORKSPACE");
  // Inside the workspace the same -C form still asks.
  assert.equal(cliDecision("dotnet test && git -C sub push origin", "main").reason, "DEFAULT_BRANCH_PUSH");
});

// Commands where the plugin is NOT strict enough and the CLI is: [command, branch, why].
const STRICTER = [
  ["git -c user.name=x push origin main", "feat/x", "-c takes a value, so the plugin never sees the push"],
  ["git -c k=v push origin feat/x", "feat/x", "-c with a key outside the harmless allow-list is unparseable (a config key can run commands)"],
  ["git -c k=v push --force", "feat/x", "force push behind -c is still denied (the plugin regex also catches this one)"],
  ["git clean -d -f", "feat/x", "separate -d -f flags"],
  ["git clean --force", "feat/x", "long force flag"],
  ["git push origin +feat:feat", "feat/x", "a +refspec is a force push"],
  ["git push -uf origin feat", "feat/x", "combined short flags containing f"],
  ["rm -rf /tmp/some-dir", "feat/x", "recursive delete outside the workspace"],
  ["rm -rf *", "feat/x", "wipes the workspace"],
  [process.platform === "win32" ? "Remove-Item -Force -Recurse C:\\Temp\\x" : "Remove-Item -Force -Recurse /tmp/x", "feat/x", "either flag order, any path outside the workspace"],
  ["git checkout main -- .", "feat/x", "bulk restore with a source"],
  ["git push origin --delete main", "feat/x", "deleting the default branch"],
  ["git push origin HEAD", "main", "HEAD resolves to the current branch"],
  ["git push", "", "unknown current branch asks"],
  ['git push origin "main"', "feat/x", "quoted refspec"],
  ["bash -c 'echo hi'", "feat/x", "unparseable inline shell"],
  ["echo $(date)", "feat/x", "command substitution"],
  ["cat .env", "feat/x", "secret access"],
  ["asterweave run approve r1", "feat/x", "approval self-grant"],
  ["curl https://example.invalid", "feat/x", "network egress"],
  ["git merge feat/y", "feat/x", "merge needs approval"],
];

// Commands where the CLI intentionally asks LESS than the plugin because it parses flag values: [command, branch, why].
const MORE_PRECISE = [["git push origin feat/x -o main", "feat/x", "-o takes a value; 'main' is a push option, not a refspec"]];

test("intentional differences are exactly the listed ones", () => {
  for (const [command, branch, why] of STRICTER) {
    const decision = cliDecision(command, branch === "" ? null : branch);
    const plugin = pluginRank(command, branch === "" ? null : branch);
    assert.ok(rank(decision) > plugin || (plugin === 2 && decision.decision === "deny"), `${command} (${why}) -> ${decision.decision}, plugin ${plugin}`);
  }
  for (const [command, branch, why] of MORE_PRECISE) {
    assert.equal(pluginRank(command, branch), 1, `${command}: the plugin asks`);
    // Not an understood form any more, so it asks; but it is not judged a default-branch push (the flag value is not a refspec).
    const decision = cliDecision(command, branch);
    assert.equal(decision.decision, "require-approval", `${command} (${why})`);
    assert.notEqual(decision.reason, "DEFAULT_BRANCH_PUSH", `${command} (${why})`);
  }
});

// A broad corpus: for every command the CLI must be at least as strict as the plugin unless it is listed in MORE_PRECISE.
const CORPUS = [
  "ls", "pwd", "git status", "git log --oneline", "git diff", "git add .", 'git commit -m "message"', "npm test", "node --test", "dotnet build", "dotnet test App.sln",
  "git reset --hard", "git reset --hard HEAD", "git reset --soft HEAD~1", "git reset", "GIT RESET --HARD", "git  reset   --hard", "echo ok && git reset --hard", "git reset --hard; ls",
  "git clean -f", "git clean -fd", "git clean -xdf", "git clean -n", "git clean -nd", "git clean -i",
  "git checkout .", "git checkout -- .", "git restore .", "git restore -- .", "git checkout main", "git checkout -b feat/x", "git restore file.txt", "git checkout . && ls",
  "git push --force", "git push -f origin feat", "git push --force-with-lease", "git push origin feat --force", "git push", "git push -u origin feat/x", "git push --tags", "git push --follow-tags",
  "git push origin main", "git push origin master", "git push origin HEAD:main", "git push origin HEAD:refs/heads/master", "git push origin refs/heads/main", "git push --all", "git push --mirror",
  "git push origin :main", "git push origin --delete feat", "git push origin -d feat", "git push -d origin main",
  "git -C ../x push origin main", "git -C sub push", "echo hi && git push origin main", "git fetch && git push origin main", "git status; git push origin master", "git push origin main | cat",
  "rm -rf /", "rm -rf ~", "rm -rf .", "rm -rf ..", "rm -rf $HOME", "rm -fr /", "rm -rf ./build", "rm -rf node_modules", "rm -f file", "rm file",
  "Remove-Item -Recurse -Force C:\\", "Remove-Item -Recurse -Force .\\build", "Remove-Item -r -fo /", "Remove-Item -Recurse -Force $HOME", "Remove-Item -Recurse -Force $env:USERPROFILE", "Remove-Item file.txt",
  "DROP DATABASE prod", "drop schema x", "TRUNCATE TABLE t", "SELECT 1", 'psql -c "DROP DATABASE x"',
  "docker system prune -a", "docker system prune -af", "docker system prune", "docker ps -a", "docker system prune --all",
  "kubectl delete ns x", "kubectl delete namespace x", "kubectl delete pod x", "kubectl get ns",
  "terraform destroy", "terraform plan", "terraform apply",
  "bash -c 'git reset --hard'", 'sh -c "git push --force"', "sudo git reset --hard", "FOO=1 git clean -fd", "env X=1 git push -f", "time git reset --hard", "nohup git push origin main &",
];

test("differential corpus: the CLI is at least as strict as the plugin", () => {
  const exceptions = new Set(MORE_PRECISE.map(([command]) => command));
  for (const command of CORPUS) {
    if (exceptions.has(command)) continue;
    for (const branch of ["feat/x", "main"]) {
      const plugin = pluginRank(command, branch);
      const decision = cliDecision(command, branch);
      assert.ok(rank(decision) >= plugin, `${command} on ${branch}: plugin ${plugin}, CLI ${decision.decision}/${decision.reason}`);
    }
  }
});

test("hook output parity: for each plugin deny / ask fixture the CLI hook answers deny / ask or stricter", async () => {
  const strength = { deny: 2, ask: 1, none: 0 };
  async function viaPlugin(command, cwd) {
    const output = await runHook(JSON.stringify({ tool_input: { command }, cwd }));
    return output.stdout ? JSON.parse(output.stdout).hookSpecificOutput.permissionDecision : "none";
  }
  async function viaCli(command, cwd) {
    const chunks = [];
    const code = await runCli(["hook", "pre-tool-use"], {
      stdin: Readable.from([Buffer.from(JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }))]),
      stdout: { write: (text) => chunks.push(String(text)) },
      stderr: { write: () => {} },
      env: { ASTERWEAVE_CONFIG_DIR: userDir, CLAUDE_PROJECT_DIR: root },
      cwd: root,
      homedir: () => home,
    });
    assert.equal(code, 0);
    const text = chunks.join("");
    return text ? JSON.parse(text).hookSpecificOutput.permissionDecision : "none";
  }
  for (const command of [...PLUGIN_DENY, "git push origin main", "git push --all origin", "git push origin master", "git push origin HEAD:main", "ls", "dotnet test App.sln"]) {
    const plugin = await viaPlugin(command, root);
    const cli = await viaCli(command, root);
    assert.ok(strength[cli] >= strength[plugin], `${command}: plugin ${plugin}, CLI ${cli}`);
  }
  // Not vacuous: with the workspace pinned by CLAUDE_PROJECT_DIR the CLI hook really allows ordinary commands and asks (not denies) for a default-branch push.
  assert.equal(await viaCli("ls", root), "none");
  assert.equal(await viaCli("git push origin main", root), "ask");
});
