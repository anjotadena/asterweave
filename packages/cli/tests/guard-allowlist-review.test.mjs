// Regression tests for the last review pass of the allow-list classifier (findings 1-6 of the staff and security reviews):
//   1  redirection-only segments and every other degenerate segment
//   2  PowerShell provider / drive qualified paths (env:, HKCU:, FileSystem::, C:x ...)
//   3  repository hook mechanisms are protected paths (husky, lefthook, pre-commit, .gitattributes, core.hooksPath)
//   4  allowCommands: an option after the listed prefix does not match
//   5  `cd -`, unbounded / hidden listings, trusted-root budget overrun, credentials in .git/config and remote URLs
// Dangerous command text appears only here, in test source, never on a shell command line. Forced-platform contexts (injected realpath,
// no host file system) make the cases identical on Windows and POSIX hosts; the hooksPath tests with a real repository skip without git.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { after, before } from "node:test";
import { runCli } from "../src/cli.mjs";
import { evaluate, evaluateMutation, presentDirectories } from "./guard-fixture.mjs";
import { canonicalJson, policyHash, validatePolicy } from "../src/runtime/policy.mjs";
import { classifyShell } from "./guard-fixture.mjs";

const gone = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const contexts = {
  posix: { platform: "linux", workspaceRoot: "/home/u/work/repo", cwd: "/home/u/work/repo", userDir: "/home/u/.config/asterweave", homedir: () => "/home/u", realpath: (value) => value, readdir: gone },
  win32: { platform: "win32", workspaceRoot: "C:\\work\\repo", cwd: "C:\\work\\repo", userDir: "C:\\Users\\u\\AppData\\Roaming\\asterweave", homedir: () => "C:\\Users\\u", realpath: (value) => value, readdir: gone },
};
/** Every (dialect, platform) reading a command can get: the Bash tool, cmd, the PowerShell tool, and all three at once (the run loop on Windows). */
const MATRIX = [
  { dialect: "posix", on: "posix" },
  { dialect: "posix", on: "win32" },
  { dialect: "cmd", on: "win32" },
  { dialect: "powershell", on: "win32" },
  { dialect: "powershell", on: "posix" },
  { dialect: undefined, on: "win32" },
];
const policy = (extra = {}) => ({ v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["k"], branches: ["feat/*"], tools: ["shell", "read", "write", "edit", "git"], operations: ["commit", "push-branch", "open-pr"] }, ...extra });
function run(command, { on = "posix", mode = "supervised", dialect, policyExtra, ...extra } = {}) {
  const ctx = { mode, env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], ...(mode === "autonomous" || policyExtra ? { policy: policy(policyExtra) } : {}), ...contexts[on], ...(dialect ? { dialect } : {}), ...extra };
  return evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
}
const tool = (name, path, on = "posix", extra = {}) => evaluate({ type: "tool", tool: { name, input: { path } } }, { mode: "supervised", env: {}, ...contexts[on], ...extra });
const verdict = (decision) => `${decision.decision}/${decision.reason}`;
/** Supervised: not allowed (ask or deny). Autonomous: denied. */
function notAllowed(command, options = {}) {
  const supervised = run(command, options);
  assert.notEqual(supervised.decision, "allow", `supervised ${options.dialect ?? "all"}/${options.on ?? "posix"}: ${JSON.stringify(command)} -> ${verdict(supervised)}`);
  const autonomous = run(command, { ...options, mode: "autonomous" });
  assert.equal(autonomous.decision, "deny", `autonomous ${options.dialect ?? "all"}/${options.on ?? "posix"}: ${JSON.stringify(command)} -> ${verdict(autonomous)}`);
  return supervised;
}
const everywhere = (commands) => {
  for (const options of MATRIX) for (const command of commands) notAllowed(command, options);
};

let base;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-review-")));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

// --- 1: redirection-only and degenerate segments ----------------------------------------------------------------------------

test("1: a segment that is only a redirection is never allowed (it truncates or creates a file) in any dialect", () => {
  everywhere(["> src/a.js", ">> src/a.js", ">| src/a.js", "< src/a.js", "&> src/a.js", "ls; > src/a.js", "echo hi && > src/a.js", "ls | > src/a.js", "> src/new.txt", "2>&1", "> /dev/null", "ls\n> src/a.js"]);
  // A redirection next to a command word is unchanged: to the null device it is still fine, to a file it is still not understood.
  assert.equal(run("echo hi > /dev/null").decision, "allow");
  assert.equal(run("echo hi 2>&1").decision, "allow");
  notAllowed("echo hi > src/a.js");
});

test("1: in autonomous mode with a policy that omits the write tool, evaluateMutation still refuses `> file` (truncate and create)", () => {
  const noWrite = policy();
  noWrite.autonomous.tools = ["shell"];
  for (const dialect of ["posix", "powershell", "cmd", ["posix", "powershell", "cmd"]]) {
    for (const command of ["> src/a.js", "> src/new.txt", ">> src/a.js", ">| src/a.js", "ls; > src/a.js", "echo hi && > src/a.js"]) {
      const decision = evaluateMutation({ type: "tool", tool: { name: "shell", input: { command } } }, { mode: "autonomous", policy: noWrite, env: {}, lockHeld: true, branchOf: () => "feat/x", remotesOf: () => ["origin"], dialect, ...contexts.posix });
      assert.equal(decision.decision, "deny", `${JSON.stringify(dialect)} ${command} -> ${verdict(decision)}`);
      assert.equal(decision.reason, "UNPARSEABLE_COMMAND");
    }
  }
  // The write tool is not in the policy: the Write tool itself is refused too (nothing reaches a file by another door).
  assert.equal(tool("write", "/home/u/work/repo/src/a.js", "posix", { mode: "autonomous", policy: noWrite }).decision, "deny");
});

test("1: every other degenerate segment is asked about (denied when autonomous) or is justified as a no-op", () => {
  // Not allowed: commands that do something, or shell syntax the classifier does not model.
  everywhere([":", "true", "cd", "cd -", "FOO=bar", "FOO=bar; ls", "export FOO=bar", "$x = 1", "$x=1", "then", "{", "!", "<<< x", "<<EOF", "$(true)"]);
  // Allowed because NO command runs at all: empty text, whitespace, separators with nothing around them. (`&& ls` and `ls &&` are syntax
  // errors in every shell; the only command in them is the allow-listed `ls`.)
  for (const options of MATRIX) for (const command of ["", "   ", "\n\n", ";;", "|", "(", ")", "ls ;"]) assert.equal(run(command, options).decision, "allow", `${options.dialect}/${options.on}: ${JSON.stringify(command)}`);
  // A comment is a no-op in POSIX and PowerShell, but cmd has no `#` comment: it is a command word there.
  assert.equal(run("# hi", { dialect: "posix" }).decision, "allow");
  assert.equal(run("# hi", { dialect: "powershell", on: "win32" }).decision, "allow");
  notAllowed("# hi", { dialect: "cmd", on: "win32" });
  notAllowed("# hi", { on: "win32" });
});

// --- 2: PowerShell provider and drive qualified paths -----------------------------------------------------------------------

const PROVIDER_PATHS = [
  "Get-Content env:GITHUB_TOKEN", "gc env:ANTHROPIC_API_KEY", "Get-ChildItem env:", "ls env:", "dir Env:", "dir Env:\\", "gci -Path env: -Name", "gc -Pa env:PATH", "Get-Item Env:AWS_SECRET_ACCESS_KEY",
  "cat env:GITHUB_TOKEN", "type env:GITHUB_TOKEN", "Get-Content -LiteralPath env:GITHUB_TOKEN", "Get-Content -TotalCount 1 env:GH_TOKEN", "Get-Content -Path a.txt,env:GITHUB_TOKEN",
  "Get-Content FileSystem::C:\\Windows\\win.ini", "gc FileSystem::\\\\host\\share\\x", "Get-Content Microsoft.PowerShell.Core\\FileSystem::C:\\Users\\x\\.gitconfig",
  "cat FileSystem::C:\\Users\\Anjo\\AppData\\Roaming\\asterweave\\policy.json", "Select-String -Pattern . -Path FileSystem::C:\\Windows\\win.ini", "Get-ChildItem FileSystem::C:\\Users",
  "Get-Content Temp:\\x", "Get-ChildItem HKCU:\\Software", "Test-Path HKLM:\\SOFTWARE", "Get-Item -Path HKLM:\\SAM", "Get-ChildItem Cert:\\", "Get-ChildItem WSMan:\\", "Get-Content Registry::HKLM\\x",
  "Get-Content variable:", "Get-Content function:prompt", "Get-Content alias:ls", "Select-String -Pattern x -Path env:*",
  "Set-Location env:; Get-Content GITHUB_TOKEN", "cd FileSystem::C:\\; Get-Content Windows\\win.ini", "sl env:", "Set-Location -Path HKLM:\\",
  "Get-ChildItem C:", "Get-Content C:a.txt", "Get-ChildItem D:",
];

test("2: PowerShell provider, drive-relative and stream qualified paths are never allowed, in any dialect", () => {
  everywhere(PROVIDER_PATHS);
});

test("2: provider paths are a deny (not a question) wherever a PowerShell provider can exist", () => {
  for (const command of ["Get-Content env:GITHUB_TOKEN", "gc FileSystem::\\\\host\\share\\x", "Get-ChildItem HKCU:\\Software", "dir Env:"]) {
    assert.equal(verdict(run(command, { on: "win32", dialect: "powershell" })), "deny/PATH_OUTSIDE_WORKSPACE", command);
    assert.equal(verdict(run(command, { on: "win32" })), "deny/PATH_OUTSIDE_WORKSPACE", `all dialects: ${command}`);
  }
  assert.equal(verdict(run("Get-ChildItem C:", { on: "win32", dialect: "powershell" })), "require-approval/UNPARSEABLE_COMMAND");
  // A secret or protected name in the same operand keeps its own, earlier verdict.
  assert.equal(verdict(run("type .env::$DATA", { on: "win32", dialect: "cmd" })), "deny/SECRET_ACCESS");
  assert.equal(verdict(run("type C:\\Users\\u\\.aws\\credentials:x", { on: "win32", dialect: "cmd" })), "deny/SECRET_ACCESS");
});

test("2: as tool paths on Windows the same qualified spellings are refused; NTFS stream spellings keep their own verdicts", () => {
  for (const file of ["env:GITHUB_TOKEN", "FileSystem::C:\\Windows\\win.ini", "HKCU:\\Software", "Temp:\\x", "C:a.txt", "Cert:\\", "Microsoft.PowerShell.Core"]) {
    for (const name of ["read", "write", "edit"]) {
      const decision = tool(name, file, "win32");
      if (file === "Microsoft.PowerShell.Core") assert.equal(decision.decision, "allow", `${name} ${file} is an ordinary relative name`);
      else assert.equal(verdict(decision), "deny/PATH_OUTSIDE_WORKSPACE", `${name} ${file}`);
    }
  }
  assert.equal(verdict(tool("write", "C:\\work\\repo\\.git::$INDEX_ALLOCATION\\hooks\\pre-commit", "win32")), "deny/PROTECTED_PATH");
  assert.equal(tool("read", "C:\\work\\repo\\src\\a.txt", "win32").decision, "allow");
  // On POSIX a colon is an ordinary character in a tool path.
  assert.equal(tool("read", "/home/u/work/repo/src/a:b.txt", "posix").decision, "allow");
});

test("2: legitimate controls still allow (workspace-relative paths, a fully qualified drive path inside the workspace)", () => {
  const ps = { on: "win32", dialect: "powershell" };
  for (const command of ["Get-Content README.md", "Get-ChildItem", "Get-ChildItem src", "Get-Content C:\\work\\repo\\README.md", "Get-Content C:/work/repo/README.md", "Get-Content -Path src\\a.txt -TotalCount 3", "Test-Path src", "Set-Location src", "Select-String -Pattern x -Path src\\a.txt"]) {
    assert.equal(run(command, ps).decision, "allow", command);
    assert.equal(run(command, { ...ps, mode: "autonomous" }).decision, "allow", `autonomous: ${command}`);
  }
  for (const command of ["cat README.md", "ls", "ls -la src", "grep -n x src/a.txt", "git show HEAD:README.md"]) assert.equal(run(command).decision, "allow", command);
  // Outside the workspace a fully qualified drive path is still a PATH_OUTSIDE_WORKSPACE deny, not a colon question.
  assert.equal(verdict(run("Get-Content C:\\Windows\\win.ini", ps)), "deny/PATH_OUTSIDE_WORKSPACE");
});

test("2: a refused cd leaves the working directory alone, and the command is not allowed", () => {
  // `Set-Location env:` must not make `GITHUB_TOKEN` look like a workspace file (or move the cwd for the next segment).
  const result = classifyShell("Set-Location env:; Get-Content GITHUB_TOKEN", { ...contexts.win32, dialect: "powershell", env: {} });
  assert.ok(result.findings.some((finding) => finding.ruleId === "path-provider"), JSON.stringify(result.findings));
  assert.equal(result.findings.some((finding) => finding.ruleId === "path-outside-workspace"), false, "the cwd did not move outside");
  notAllowed("cd FileSystem::C:\\; Get-Content Windows\\win.ini", { on: "win32", dialect: "powershell" });
  // Round 6: the guard does not follow a cd at all: a cd together with another command asks (the secret floor still denies on its own).
  assert.equal(run("cd src && cat a.txt").decision, "require-approval");
  assert.equal(run("cd src && cat ../.env").reason, "SECRET_ACCESS");
});

// --- 3: repository hook mechanisms ----------------------------------------------------------------------------------------------

const HOOK_FILES = [".husky/pre-commit", ".husky/_/husky.sh", ".githooks/pre-push", ".git-hooks/commit-msg", "lefthook.yml", "lefthook.yaml", ".lefthook.yml", "lefthook-local.yml", ".lefthook/pre-commit/a.sh", ".pre-commit-config.yaml", ".gitattributes", "sub/.gitattributes", "packages/a/.husky/pre-commit"];

test("3: the Write and Edit tools cannot write husky, lefthook, pre-commit, .gitattributes or .githooks files; reads are untouched", () => {
  for (const on of ["posix", "win32"]) {
    const root = on === "posix" ? "/home/u/work/repo/" : "C:\\work\\repo\\";
    for (const file of HOOK_FILES) {
      for (const name of ["write", "edit"]) assert.equal(verdict(tool(name, root + file, on)), "deny/PROTECTED_PATH", `${on} ${name} ${file}`);
      assert.equal(tool("read", root + file, on).decision, "allow", `${on} read ${file}`);
    }
    assert.equal(tool("write", `${root}src/a.txt`, on).decision, "allow");
    assert.equal(tool("write", `${root}package.json`, on).decision, "allow", "package.json is deliberately NOT protected wholesale (documented residual risk)");
  }
  for (const file of HOOK_FILES) assert.equal(tool("write", `/home/u/work/repo/${file}`, "posix", { mode: "autonomous", policy: policy() }).decision, "deny", `autonomous ${file}`);
  // Windows spellings count too.
  for (const file of ["C:\\work\\repo\\.HUSKY\\pre-commit", "C:\\work\\repo\\.husky.\\pre-commit", "C:\\work\\repo\\.husky::$INDEX_ALLOCATION\\pre-commit", "C:\\work\\repo\\LEFTHOOK.YML", "C:\\work\\repo\\.GitAttributes"]) {
    assert.equal(verdict(tool("write", file, "win32")), "deny/PROTECTED_PATH", file);
  }
});

test("3: shell writes into hook directories and configuration are PROTECTED_PATH (redirection, tee, cp, mv, sed -i)", () => {
  for (const command of ["echo x > .husky/pre-commit", "echo x >> .githooks/pre-push", "tee .husky/pre-commit", "cp a .husky/pre-commit", "mv a lefthook.yml", "sed -i s/a/b/ .pre-commit-config.yaml", "echo x > .gitattributes", "touch .husky/pre-push"]) {
    assert.equal(verdict(run(command)), "deny/PROTECTED_PATH", command);
    assert.equal(run(command, { mode: "autonomous" }).decision, "deny", `autonomous ${command}`);
  }
  for (const command of ["cat .husky/pre-commit", "ls .husky", "cat lefthook.yml", "cat .gitattributes", "cat .pre-commit-config.yaml"]) assert.equal(run(command).decision, "allow", command);
});

test("3: the directory named by core.hooksPath is protected (injected value); it is read once per classification, never when nothing is written", () => {
  let reads = 0;
  const hooksPathOf = (directory) => {
    reads += 1;
    assert.equal(directory, "/home/u/work/repo", "only ever read at the verified workspace root");
    return "tools/hooks";
  };
  for (const name of ["write", "edit"]) {
    assert.equal(verdict(tool(name, "/home/u/work/repo/tools/hooks/pre-commit", "posix", { hooksPathOf })), "deny/PROTECTED_PATH", name);
    assert.equal(verdict(tool(name, "/home/u/work/repo/tools/hooks/nested/x.sh", "posix", { hooksPathOf })), "deny/PROTECTED_PATH");
    assert.equal(tool(name, "/home/u/work/repo/tools/other/x.sh", "posix", { hooksPathOf }).decision, "allow");
    assert.equal(tool(name, "/home/u/work/repo/src/a.txt", "posix", { hooksPathOf }).decision, "allow");
  }
  assert.equal(tool("write", "/home/u/work/repo/tools/hooks/notes.txt", "posix").decision, "allow", "without a configured value only the named mechanisms are protected (a hook-named file in a hooks directory is protected by name since round 4, see guard-round4.test.mjs)");
  assert.equal(verdict(run("echo x > tools/hooks/pre-commit", { hooksPathOf })), "deny/PROTECTED_PATH");
  assert.equal(verdict(run("echo x > ./tools/../tools/Hooks/../hooks/pre-commit", { hooksPathOf })), "deny/PROTECTED_PATH");
  assert.equal(run("cat tools/hooks/pre-commit", { hooksPathOf }).decision, "allow", "reads are untouched");
  reads = 0;
  run("echo a > src/a.txt; echo b > src/b.txt; echo c > src/c.txt", { hooksPathOf });
  assert.equal(reads, 1, "cached for the whole classification");
  reads = 0;
  run("cat src/a.txt; ls", { hooksPathOf });
  assert.equal(reads, 0, "no write, no read of the configuration");
  run("cat src/a.txt; git status; git log", { hooksPathOf });
  assert.equal(reads, 1, "every git form needs the hooks path to be known (round 6): read once");
  // An absolute value, a value outside the workspace, a nonsense value and a throwing reader.
  assert.equal(verdict(tool("write", "/home/u/work/repo/hk/pre-commit", "posix", { hooksPathOf: () => "/home/u/work/repo/hk" })), "deny/PROTECTED_PATH");
  assert.equal(tool("write", "/home/u/work/repo/hk/pre-commit", "posix", { hooksPathOf: () => "/elsewhere/hooks" }).decision, "allow");
  assert.equal(tool("write", "/home/u/work/repo/hk/pre-commit", "posix", { hooksPathOf: () => ({}) }).decision, "allow");
  assert.equal(tool("write", "/home/u/work/repo/hk/pre-commit", "posix", { hooksPathOf: () => "~someone/x" }).decision, "allow");
  // `.` = the workspace root: only files git would run as hooks are protected there, not the whole tree.
  const root = { hooksPathOf: () => "." };
  assert.equal(verdict(tool("write", "/home/u/work/repo/pre-commit", "posix", root)), "deny/PROTECTED_PATH");
  assert.equal(tool("write", "/home/u/work/repo/src/a.txt", "posix", root).decision, "allow");
  assert.equal(tool("write", "/home/u/work/repo/README.md", "posix", root).decision, "allow");
});

const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

test("3 (real repository): core.hooksPath=.husky and a custom directory: writes denied, reads allowed, the guard reads the config itself", (t) => {
  if (git(base, "--version").status !== 0) return t.skip("git is not available");
  const root = join(base, "hooked");
  mkdirSync(join(root, "tools", "hooks"), { recursive: true });
  mkdirSync(join(root, ".husky"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  assert.equal(git(root, "init", "-q").status, 0);
  assert.equal(git(root, "config", "core.hooksPath", "tools/hooks").status, 0);
  writeFileSync(join(root, "src", "a.txt"), "a\n");
  writeFileSync(join(root, ".husky", "pre-commit"), "echo\n");
  const ctx = { workspaceRoot: root, cwd: root, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x", remotesOf: () => ["origin"] };
  const toolOf = (name, file) => evaluate({ type: "tool", tool: { name, input: { path: join(root, file) } } }, ctx);
  for (const file of [".husky/pre-commit", "tools/hooks/pre-commit", "tools/hooks/new-hook", ".pre-commit-config.yaml", "lefthook.yml", ".gitattributes"]) {
    for (const name of ["write", "edit"]) assert.equal(verdict(toolOf(name, file)), "deny/PROTECTED_PATH", `${name} ${file}`);
  }
  assert.equal(toolOf("write", "src/a.txt").decision, "allow");
  assert.equal(toolOf("write", "tools/other.txt").decision, "allow");
  for (const file of [".husky/pre-commit", "tools/hooks/pre-commit", "src/a.txt"]) assert.equal(toolOf("read", file).decision, "allow", `read ${file}`);
  const shell = (command) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
  assert.equal(verdict(shell("echo x > tools/hooks/pre-commit")), "deny/PROTECTED_PATH");
  assert.equal(shell("cat tools/hooks/pre-commit").decision, "allow");
  // Setting the same value to .husky protects .husky even when nothing else names it.
  assert.equal(git(root, "config", "core.hooksPath", "custom-hooks").status, 0);
  assert.equal(verdict(toolOf("write", "custom-hooks/pre-push")), "deny/PROTECTED_PATH");
  assert.equal(toolOf("write", "tools/hooks/notes.txt").decision, "allow", "the old directory is no longer the configured one");
});

test("3 (hook command): a Write into the configured hooks directory is denied by `asterweave hook pre-tool-use`", async (t) => {
  if (git(base, "--version").status !== 0) return t.skip("git is not available");
  const root = join(base, "hooked-cli");
  const home = join(base, "hooked-cli-home");
  mkdirSync(join(root, "ci", "hooks"), { recursive: true });
  mkdirSync(home, { recursive: true });
  assert.equal(git(root, "init", "-q").status, 0);
  assert.equal(git(root, "config", "core.hooksPath", "ci/hooks").status, 0);
  async function hook(file_path, tool_name = "Write") {
    const chunks = [];
    const code = await runCli(["hook", "pre-tool-use"], {
      stdin: Readable.from([Buffer.from(JSON.stringify({ tool_name, tool_input: { file_path }, cwd: root }))]),
      stdout: { write: (text) => chunks.push(String(text)) },
      stderr: { write: () => {} },
      env: { ASTERWEAVE_CONFIG_DIR: join(base, "ud-hook"), CLAUDE_PROJECT_DIR: root },
      cwd: root,
      homedir: () => home,
    });
    assert.equal(code, 0);
    const text = chunks.join("");
    return text ? JSON.parse(text).hookSpecificOutput.permissionDecision : "none";
  }
  assert.equal(await hook(join(root, "ci", "hooks", "pre-commit")), "deny");
  assert.equal(await hook(join(root, ".husky", "pre-commit"), "Edit"), "deny");
  assert.equal(await hook(join(root, "src", "a.txt")), "none");
});

// --- 4: allowCommands option rule --------------------------------------------------------------------------------------------

test("4: allowCommands: an option after the listed prefix does not match; positional words and `--` pass-through still do", () => {
  const allowCommands = [["npm", "test"], ["node", "--test"], ["npm", "run", "lint"], ["cargo", "test", "--quiet"]];
  for (const mode of ["supervised", "autonomous"]) {
    const options = { mode, policyExtra: { allowCommands } };
    for (const command of ["npm test", "npm test src/a.test.js", "npm test -- --watch=false", "npm test -- --script-shell=calc.exe", "node --test", "node --test tests/a.test.mjs", "npm run lint", "npm run lint src", "cargo test --quiet", "cargo test --quiet name", "npm test && node --test"]) {
      assert.equal(run(command, options).decision, "allow", `${mode}: ${command}`);
    }
    for (const command of [
      "npm test --script-shell=calc.exe", "npm test --prefix=C:\\Windows", "npm test --prefix /tmp/x", "npm test -w pkg", "npm test -", "npm test src --ignore-scripts=false", "node --test --import data:text/javascript,1", "node --test --require ./x.js",
      "node --test -e 1", "npm run lint --script-shell=calc.exe", "cargo test --quiet --manifest-path x", "cargo test --release", "npm test && node --test --import x", "npm test --", "npm test --x -- y",
    ]) {
      // `npm test --` (a bare terminator) is positional-only and allowed; every other form with an option is not.
      if (command === "npm test --") assert.equal(run(command, options).decision, "allow", `${mode}: ${command}`);
      else assert.notEqual(run(command, options).decision, "allow", `${mode}: ${command}`);
    }
  }
  assert.equal(run("npm test --script-shell=calc.exe", { mode: "autonomous", policyExtra: { allowCommands } }).decision, "deny");
  // The floors still apply to positional words.
  assert.equal(run("npm test .env", { policyExtra: { allowCommands } }).reason, "SECRET_ACCESS");
  assert.equal(run("npm test ../../etc", { policyExtra: { allowCommands } }).reason, "PATH_OUTSIDE_WORKSPACE");
});

test("4: the allowCommands rule does not change the policy file shape: validation and the policy hash keep their meaning", () => {
  const withOptionInPrefix = { v: 1, mode: "supervised", allowCommands: [["node", "--test"], ["cargo", "test", "--quiet"]] };
  assert.deepEqual(validatePolicy(withOptionInPrefix), []);
  assert.equal(policyHash(withOptionInPrefix), createHash("sha256").update(canonicalJson(withOptionInPrefix)).digest("hex"));
  assert.equal(policyHash(withOptionInPrefix), policyHash({ allowCommands: [["node", "--test"], ["cargo", "test", "--quiet"]], mode: "supervised", v: 1 }), "key order does not matter");
  assert.notEqual(policyHash(withOptionInPrefix), policyHash({ ...withOptionInPrefix, allowCommands: [["node", "--test"]] }));
});

// --- 5: smaller findings ------------------------------------------------------------------------------------------------------

test("5: `cd -` and the cd operands that name shell state or another user are never allowed; a plain workspace directory is", () => {
  everywhere(["cd -", "cd ~", "cd ~root", "cd ~/src", "cd %CD%", "cd $OLDPWD", "cd $PWD", "cd ${PWD}", "cd -P -", "chdir -", "Set-Location -", "sl -", "Set-Location -Path -", "Set-Location ~", "cd $env:OLDPWD", "pushd src", "popd", "pushd -", "cd src; cd -"]);
  for (const options of MATRIX) {
    const lstat = presentDirectories(contexts[options.on].workspaceRoot + "/src");
    assert.equal(run("cd src", { ...options, lstat }).decision, "allow", `${options.dialect}/${options.on}`);
    // Round 6: a cd combined with any other command is not understood (the directory the others run in cannot be predicted).
    notAllowed("cd src && ls", { ...options, lstat });
  }
});

test("5: unbounded and hidden listings (-Recurse, -Depth, -Force, ls -R) ask; bounded listings still allow", () => {
  const listings = ["Get-ChildItem -Recurse", "Get-ChildItem src -Recurse", "gci -r", "Get-ChildItem -Depth 2", "Get-ChildItem -Force", "dir -Force src", "Get-ChildItem -Path src -Force", "Get-Item -Force src", "gi src -Force", "Get-ChildItem -Recurse -Include *.pem"];
  for (const options of MATRIX) for (const command of listings) assert.notEqual(run(command, options).decision, "allow", `${options.dialect}/${options.on}: ${command}`);
  for (const command of ["ls -R", "ls -lR src", "ls --recursive"]) assert.notEqual(run(command).decision, "allow", command);
  const ps = { on: "win32", dialect: "powershell" };
  for (const command of ["Get-ChildItem", "Get-ChildItem src", "Get-ChildItem -Path src -Name", "Get-ChildItem -Filter *.js src", "Get-Item src"]) assert.equal(run(command, ps).decision, "allow", command);
  for (const command of ["ls", "ls -la src", "ls -a", "ls -1 src"]) assert.equal(run(command).decision, "allow", command);
});

test("5: running out of budget while resolving the trusted roots is a refusal (command-too-complex), not GUARD_UNAVAILABLE", () => {
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const slow = (value) => {
    sleep();
    return value;
  };
  for (const mode of ["supervised", "autonomous"]) {
    const decision = run("ls", { mode, realpath: slow, budgetMs: 20 });
    assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND", mode);
    assert.equal(decision.ruleId, "command-too-complex");
  }
  const result = classifyShell("ls", { ...contexts.posix, env: {}, realpath: slow, budgetMs: 20 });
  assert.ok(result.findings.some((finding) => finding.ruleId === "command-too-complex" && finding.hard === true));
  assert.equal(tool("write", "/home/u/work/repo/src/a.txt", "posix", { realpath: slow, budgetMs: 20 }).decision, "deny");
});

test("5: credentials can sit in remote URLs: reading .git/config or a *.url key asks (denied when autonomous); `git remote -v` and other keys stay allowed", () => {
  for (const options of [{ on: "posix" }, { on: "win32", dialect: "cmd" }, { on: "win32", dialect: "powershell" }, { on: "win32" }]) {
    for (const command of ["cat .git/config", "head -n 5 .git/config", "grep url .git/config", "Get-Content .git/config", "cat ./.git/config", "git config --get remote.origin.url", "git config --get remote.origin.pushurl", "git config --get-all remote.origin.url", "git config --get url.x.insteadOf.url", "cat .git/modules/a/config"]) {
      const supervised = run(command, options);
      assert.equal(supervised.decision, "require-approval", `${options.on}/${options.dialect}: ${command} -> ${verdict(supervised)}`);
      assert.equal(supervised.reason, "UNPARSEABLE_COMMAND");
      assert.equal(run(command, { ...options, mode: "autonomous" }).decision, "deny", command);
    }
  }
  assert.equal(verdict(tool("read", ".git/config")), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(verdict(tool("read", "/home/u/work/repo/.git/config")), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(tool("read", "/home/u/work/repo/.git/HEAD").decision, "allow");
  for (const command of ["git remote -v", "git remote", "git config --get user.name", "git branch --list", "ls .git", "cat .git/HEAD", "git status"]) assert.equal(run(command).decision, "allow", command);
  assert.equal(verdict(run("echo x > .git/config")), "deny/PROTECTED_PATH", "writes are still a deny");
});
