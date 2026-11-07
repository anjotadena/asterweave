// Regression tests for the round-4 security findings of the allow-list classifier:
//   G  `git push <word> ...` is a push to a LOCAL PATH unless <word> is a configured remote (and a git directory can be built with plain file writes)
//   C  findstr (`/f:file`, `//f:file` under Git Bash) reads names from a file outside the workspace: removed from the allow-list
//   H  git read forms take path operands (`git diff /abs/a b`, `git blame /abs/x`, `git ls-files /abs`): every operand is checked strictly
//   A  wildcard reads of .git/config (`cat .gi*/config`, `.git/c*`, `.[g]it/config`, `Get-Content .gi*\config`)
//   B  `git config --get <key>` only for the small GIT_CONFIG_SAFE key list, no scope flag but --local / --global
//   S  shrunk allow set: cmd `dir` only with /b, `gh pr create` only with --title / --body / --base
// Dangerous command text appears only here, in test source. Forced-platform contexts (injected realpath / lstat, no host file system) make the
// cases identical on Windows and POSIX hosts; the real-repository tests skip without git.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { evaluate } from "./guard-fixture.mjs";
import { classifyShell } from "./guard-fixture.mjs";

const gone = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const contexts = {
  posix: { platform: "linux", workspaceRoot: "/home/u/work/repo", cwd: "/home/u/work/repo", userDir: "/home/u/.config/asterweave", homedir: () => "/home/u", realpath: (value) => value, readdir: gone, lstat: gone },
  win32: { platform: "win32", workspaceRoot: "C:\\work\\repo", cwd: "C:\\work\\repo", userDir: "C:\\Users\\u\\AppData\\Roaming\\asterweave", homedir: () => "C:\\Users\\u", realpath: (value) => value, readdir: gone, lstat: gone },
};
/** The (dialect, platform) readings a command can get. */
const MATRIX = [
  { dialect: "posix", on: "posix" },
  { dialect: "posix", on: "win32" },
  { dialect: "cmd", on: "win32" },
  { dialect: "powershell", on: "win32" },
  { dialect: "powershell", on: "posix" },
  { dialect: undefined, on: "win32" },
];
const policy = () => ({ v: 1, mode: "autonomous", autonomous: { workflows: ["delivery@1"], repos: ["k"], branches: ["feat/*"], tools: ["shell", "read", "write", "edit", "git"], operations: ["commit", "push-branch", "open-pr"] } });
function run(command, { on = "posix", mode = "supervised", dialect, ...extra } = {}) {
  const ctx = { mode, env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], ...(mode === "autonomous" ? { policy: policy() } : {}), ...contexts[on], ...(dialect ? { dialect } : {}), ...extra };
  return evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
}
function tool(name, path, on = "posix", extra = {}) {
  return evaluate({ type: "tool", tool: { name, input: { path } } }, { mode: "supervised", env: {}, ...contexts[on], ...extra });
}
const verdict = (decision) => `${decision.decision}/${decision.reason}`;
const label = (options) => `${options.dialect ?? "all"}/${options.on ?? "posix"}`;
/** Supervised: not allowed (ask or deny). Autonomous: denied. */
function notAllowed(command, options = {}) {
  const supervised = run(command, options);
  assert.notEqual(supervised.decision, "allow", `supervised ${label(options)}: ${JSON.stringify(command)} -> ${verdict(supervised)}`);
  const autonomous = run(command, { ...options, mode: "autonomous" });
  assert.equal(autonomous.decision, "deny", `autonomous ${label(options)}: ${JSON.stringify(command)} -> ${verdict(autonomous)}`);
}
const allowed = (command, options = {}) => {
  const decision = run(command, options);
  assert.equal(decision.decision, "allow", `${label(options)}: ${JSON.stringify(command)} -> ${verdict(decision)}`);
};
const everywhere = (commands, matrix = MATRIX) => {
  for (const options of matrix) for (const command of commands) notAllowed(command, options);
};
const present = (...paths) => (value) => {
  if (paths.some((entry) => entry.toLowerCase() === String(value).toLowerCase())) return { isSymbolicLink: () => false };
  return gone();
};

let base;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-round4-")));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

// --- G: a push needs a configured remote -----------------------------------------------------------------------------------

test("G: `git push <remote> <branch>` is understood only when <remote> is configured (injected remotesOf)", () => {
  for (const options of MATRIX) {
    allowed("git push origin feat/x", options);
    allowed("git push -u origin feat/x", options);
    notAllowed("git push x feat/x", options);
    notAllowed("git push -u x feat/x", options);
    notAllowed("git push upstream feat/x", options);
    notAllowed("git push x HEAD", options);
  }
  // Unknown remotes (no reader, a null answer, a reader that throws, a nonsense answer) understand no push at all.
  for (const remotesOf of [() => null, () => undefined, () => [], () => "origin", () => ({}), () => { throw new Error("boom"); }]) {
    notAllowed("git push origin feat/x", { remotesOf });
    notAllowed("git push -u origin feat/x", { remotesOf });
  }
  // A configured remote named x is fine; the remotes of the classification come from the verified workspace root only.
  const seen = [];
  allowed("git push x feat/x", { remotesOf: (directory) => { seen.push(directory); return ["x"]; } });
  assert.deepEqual(seen, ["/home/u/work/repo"]);
});

test("G: the remotes are read once per classification, and not at all when no push is looked at", () => {
  let reads = 0;
  const remotesOf = () => {
    reads += 1;
    return ["origin"];
  };
  run("git push origin a && git push origin b; git push -u origin c", { remotesOf });
  assert.equal(reads, 1);
  reads = 0;
  run("git status; cat README.md", { remotesOf });
  assert.equal(reads, 0);
});

test("G: a remote word that is also the name of something in the workspace is refused", () => {
  const lstat = present("/home/u/work/repo/origin");
  notAllowed("git push origin feat/x", { lstat });
  allowed("git push origin feat/x", { lstat: present("/home/u/work/repo/other") });
  // The working directory counts too (git resolves the word relative to where it runs).
  notAllowed("cd sub; git push origin feat/x", { lstat: present("/home/u/work/repo/sub/origin") });
});

test("G: file writes that build a git directory are protected (the exact attack sequence)", () => {
  for (const on of ["posix", "win32"]) {
    const root = on === "posix" ? "/home/u/work/repo" : "C:\\work\\repo";
    const sep = on === "posix" ? "/" : "\\";
    const at = (...parts) => [root, ...parts].join(sep);
    // 1. x/HEAD is refused by name, whatever sits beside it.
    assert.equal(verdict(tool("write", at("x", "HEAD"), on)), "deny/PROTECTED_PATH", `${on} HEAD`);
    assert.equal(verdict(tool("edit", at("x", "HEAD"), on)), "deny/PROTECTED_PATH", `${on} edit HEAD`);
    // 2. a hook-named file in a directory called hooks is refused by name.
    assert.equal(verdict(tool("write", at("x", "hooks", "pre-receive"), on)), "deny/PROTECTED_PATH", `${on} hooks/pre-receive`);
    // 3. beside a HEAD file, config / packed-refs / hooks / objects / refs are part of a git directory.
    const withHead = { lstat: present(at("x", "HEAD")) };
    for (const parts of [["x", "config"], ["x", "packed-refs"], ["x", "hooks", "any-name"], ["x", "hooks", "nested", "y"]]) {
      assert.equal(verdict(tool("write", at(...parts), on, withHead)), "deny/PROTECTED_PATH", `${on} ${parts.join("/")}`);
    }
    // The last of HEAD, objects and refs to appear is refused too.
    const objects = { lstat: present(at("x", "HEAD"), at("x", "refs")) };
    assert.equal(verdict(tool("write", at("x", "objects", "pack", "a"), on, objects)), "deny/PROTECTED_PATH", `${on} objects`);
    const refs = { lstat: present(at("x", "HEAD"), at("x", "objects")) };
    assert.equal(verdict(tool("write", at("x", "refs", "heads", "main"), on, refs)), "deny/PROTECTED_PATH", `${on} refs`);
    // Ordinary directories with the same names are untouched.
    for (const parts of [["x", "config"], ["docs", "refs", "a.md"], ["src", "objects", "a.js"], ["config", "app.json"], ["src", "hooks", "useThing.ts"]]) {
      assert.equal(tool("write", at(...parts), on).decision, "allow", `${on} ${parts.join("/")}`);
    }
    assert.equal(tool("write", at("x", "objects", "a"), on, { lstat: present(at("x", "HEAD")) }).decision, "allow", "HEAD alone does not make a git directory out of objects/");
  }
  // The same through shell writers.
  for (const command of ["cp a.txt x/HEAD", "touch x/HEAD", "echo y > x/HEAD", "tee x/hooks/pre-receive"]) {
    assert.equal(verdict(run(command)), "deny/PROTECTED_PATH", command);
  }
});

test("G: hook-manager configuration names are protected (lint-staged, husky rc, overcommit, simple-git-hooks, pre-commit)", () => {
  const names = [".lintstagedrc", ".lintstagedrc.json", ".lintstagedrc.yaml", ".lintstagedrc.mjs", "lint-staged.config.js", "lint-staged.config.mjs", ".huskyrc", ".huskyrc.json", ".overcommit.yml", ".simple-git-hooks.json", ".simple-git-hooks.js", "simple-git-hooks.js", ".pre-commit-config.yaml", ".pre-commit-config.yml", ".pre-commit-config.json"];
  for (const on of ["posix", "win32"]) {
    const root = on === "posix" ? "/home/u/work/repo/" : "C:\\work\\repo\\";
    for (const name of names) for (const mode of ["write", "edit"]) assert.equal(verdict(tool(mode, root + name, on)), "deny/PROTECTED_PATH", `${on} ${name}`);
    assert.equal(tool("write", `${root}package.json`, on).decision, "allow", "package.json stays unprotected (documented residual risk)");
    assert.equal(tool("write", `${root}lint-staged.md`, on).decision, "allow");
  }
});

test("G (real git): the guard denies every write that would build a bare repository, and the push to it is refused", (t) => {
  const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (git(base, "--version").status !== 0) return t.skip("git is not available");
  const root = join(base, "attack");
  mkdirSync(root, { recursive: true });
  assert.equal(git(root, "init", "-q").status, 0);
  assert.equal(git(root, "remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  const ctx = { workspaceRoot: root, cwd: root, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x" };
  const autonomous = { ...ctx, mode: "autonomous", policy: policy() };
  const write = (file, context = ctx) => evaluate({ type: "tool", tool: { name: "write", input: { path: join(root, file) } } }, context);
  const shell = (command, context = ctx) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, context);

  // The attacker's sequence: HEAD, config, hooks/pre-receive (and objects / refs). Each Write is classified BEFORE the file is created (here the test
  // creates it directly, as an attacker who got past the guard would), and each is denied.
  for (const file of ["x/HEAD", "x/config", "x/hooks/pre-receive"]) {
    assert.equal(verdict(write(file)), "deny/PROTECTED_PATH", file);
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), file === "x/HEAD" ? "ref: refs/heads/main\n" : "#\n");
  }
  mkdirSync(join(root, "x", "objects", "info"), { recursive: true });
  assert.equal(verdict(write("x/refs/heads/.keep")), "deny/PROTECTED_PATH", "the last of HEAD, objects and refs to appear is refused");
  mkdirSync(join(root, "x", "refs", "heads"), { recursive: true });
  // Once HEAD exists, config / hooks / objects / refs below it are denied as parts of a git directory.
  for (const file of ["x/config", "x/hooks/pre-receive", "x/hooks/anything", "x/packed-refs", "x/objects/pack/p", "x/refs/heads/main"]) {
    assert.equal(verdict(write(file)), "deny/PROTECTED_PATH", file);
    assert.equal(write(file, autonomous).decision, "deny", file);
  }
  // The bare repository now exists in the workspace. The push to it is refused (x is no configured remote), the push to the real remote is not.
  const refused = shell("git push x feat/x");
  assert.equal(verdict(refused), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(shell("git push x feat/x", autonomous).decision, "deny");
  assert.equal(shell("git push -u x feat/x", autonomous).decision, "deny");
  assert.equal(shell("git push origin feat/x").decision, "allow", "the configured remote still works");
  assert.equal(shell("git push origin feat/x", autonomous).decision, "allow");
  // A directory called like the configured remote is refused too.
  mkdirSync(join(root, "origin"), { recursive: true });
  assert.equal(verdict(shell("git push origin feat/x")), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(shell("git push origin feat/x", autonomous).decision, "deny");
});

// --- C: findstr is not in the allow-list -----------------------------------------------------------------------------------

test("C: findstr is never allowed, in any dialect, in any spelling", () => {
  const commands = ["findstr //f:list.txt S", "findstr /f:list.txt S", "findstr /g:pat.txt a.txt", "findstr /d:C:\\ S a.txt", "findstr S a.txt", "findstr /i S a.txt", "findstr /c:abc a.txt", "findstr", "FINDSTR /f:list.txt S", "MSYS_NO_PATHCONV=1 findstr /f:list.txt S", "findstr.exe S a.txt"];
  everywhere(commands);
  for (const dialect of ["posix", "powershell", "cmd"]) for (const command of commands) notAllowed(command, { dialect, on: "win32" });
  for (const command of ["findstr S a.txt | head -1", "ls | findstr S"]) notAllowed(command, { dialect: "cmd", on: "win32" });
  allowed("grep S README.md");
  allowed("grep -n S README.md src/a.js");
});

// --- H: git path operands are checked strictly -------------------------------------------------------------------------------

const GIT_OUTSIDE = [
  "git diff /c/Users/Anjo/.config/gh/hosts.yml README.md",
  "git show HEAD -- /data/x",
  "git blame /c/Users/Anjo/x.txt",
  "git ls-files /c/Users/Anjo",
  "git log -- /data/x",
  "git log /data/x",
  "git diff HEAD -- /etc/hostname",
  "git diff ../outside.txt README.md",
  "git ls-files ../other",
  "git blame -- ../x.txt",
  "git diff --no-index /c/Users/Anjo/x.txt README.md",
  "git diff --no-index a b",
  "git diff --ext-diff",
  "git diff --textconv",
  "git show --textconv HEAD:README.md",
  "git diff --output=out.txt",
  "git log --output out.txt",
];

test("H: git read forms refuse path operands outside the workspace (before and after --), in every dialect", () => {
  everywhere(GIT_OUTSIDE);
  // A Linux workspace and a plain absolute path that is not an OS root: asked, not silently passed.
  for (const command of ["git show HEAD -- /data/x", "git diff /data/x README.md", "git ls-files /data"]) {
    notAllowed(command, { on: "posix", dialect: "posix" });
    notAllowed(command, { on: "win32", dialect: "cmd" });
  }
});

test("H: ordinary revision and path operands inside the workspace stay allowed", () => {
  for (const options of MATRIX) {
    for (const command of ["git diff HEAD~1 README.md", "git diff main..feat/x -- src/a.js", "git log --oneline -5 -- src/a.js", "git show HEAD:README.md", "git show HEAD", "git blame src/a.js", "git ls-files src", "git ls-files",
      "git log --grep=/re/", "git log --author=me -- docs", "git diff --stat origin/main", "git rev-parse --short HEAD", "git log v1.0..HEAD", "git diff --no-ext-diff --no-textconv HEAD"]) allowed(command, options);
  }
});

test("H: an absolute-looking operand outside the workspace that is not an OS path is asked about, a --flag=value regex is not", () => {
  const classify = (command) => classifyShell(command, { ...contexts.posix, env: {}, dialect: "posix", allowCommands: [["mytool"]] });
  assert.ok(classify("mytool /data/x").findings.some((finding) => finding.ruleId === "path-absolute-unplaced"));
  assert.equal(classify("mytool --pattern=/data/x").findings.some((finding) => finding.ruleId === "path-absolute-unplaced"), false);
  assert.equal(classify("mytool /home/u/work/repo/nothing-here").findings.some((finding) => finding.ruleId === "path-absolute-unplaced"), false);
  // grep patterns and -e values are patterns, not files.
  allowed("grep /api/users src/a.js");
  allowed("grep -e /api/users src/a.js");
  notAllowed("grep x /data/x");
  notAllowed("cat /data/x");
});

// --- A: wildcard reads of .git/config ----------------------------------------------------------------------------------------

const SLASH_GLOBS = ["cat .gi*/config", "cat .git/co?fig", "cat .git/c*", "cat .git*/config", "cat .[g]it/config", "cat .g?t/config", "cat .*/config", "cat .git/*", "head -n 3 .gi*/config", "grep url .gi*/config", "grep -n url .git/c*", "cat .git/[c]onfig", "cat .git/config.w*"];
const BACKSLASH_GLOBS = ["Get-Content .gi*\\config", "gc -Path .gi*\\config", "Select-String -Pattern url -Path .gi*\\config", "Get-Content -Path .git\\c*", "Get-Content .[g]it\\config", "type .gi*\\config", "Get-Content .git\\*", "Get-Content .*\\config", "Select-String url .gi*\\config"];

test("A: wildcards that can match .git and config are not allowed (they read .git/config, which can hold remote credentials)", () => {
  everywhere(["cat .git/config"]);
  for (const options of MATRIX) for (const command of SLASH_GLOBS) notAllowed(command, options);
  for (const options of [{ dialect: "powershell", on: "win32" }, { dialect: "powershell", on: "posix" }, { dialect: "cmd", on: "win32" }, { dialect: undefined, on: "win32" }]) {
    for (const command of BACKSLASH_GLOBS) notAllowed(command, options);
  }
});

test("A: the Read tool and wildcard-free paths behave as before; .git/HEAD and ordinary wildcards stay allowed", () => {
  for (const on of ["posix", "win32"]) {
    const root = on === "posix" ? "/home/u/work/repo/" : "C:\\work\\repo\\";
    assert.equal(verdict(tool("read", `${root}.git${on === "posix" ? "/" : "\\"}config`, on)), "require-approval/UNPARSEABLE_COMMAND");
    assert.notEqual(tool("read", `${root}.gi*${on === "posix" ? "/" : "\\"}config`, on).decision, "allow", `${on} read of a wildcard that can be .git/config`);
    assert.equal(tool("read", `${root}.git${on === "posix" ? "/" : "\\"}HEAD`, on).decision, "allow");
  }
  for (const options of MATRIX) {
    for (const command of ["ls *.md", "cat src/*.js", "cat .git/HEAD", "ls .github*", "cat *.md", "grep todo src/*.js", "cat docs/config.md", "cat .github/*.yml", "head -n 5 src/c*.js"]) allowed(command, options);
  }
  for (const options of [{ dialect: "powershell", on: "win32" }, { dialect: "powershell", on: "posix" }]) {
    for (const command of ["Get-ChildItem src\\*.js", "Get-Content docs\\*.md", "Get-ChildItem .github*", "Get-Content .github\\*.yml"]) allowed(command, options);
  }
  // A POSIX shell never lets `*` or `?` expand to a leading dot, so `*/config` is not .git/config there; PowerShell and cmd wildcards can.
  allowed("cat ?git/config", { dialect: "posix" });
  notAllowed("Get-Content *\\config", { dialect: "powershell", on: "win32" });
});

test("A: writes through a wildcard that names .git are protected", () => {
  for (const options of MATRIX) {
    for (const command of ["cp a.txt .gi*/hooks/pre-commit", "cp a.txt .[g]it/config"]) {
      const decision = run(command, options);
      assert.equal(verdict(decision), "deny/PROTECTED_PATH", `${label(options)} ${command}`);
    }
  }
});

// --- B: git config --get --------------------------------------------------------------------------------------------------------

test("B: `git config --get <key>` is allowed only for the small safe key list, with no scope flag but --local / --global", () => {
  for (const options of MATRIX) {
    for (const command of ["git config --get user.name", "git config --get user.email", "git config --get-all user.email", "git config --local --get user.name", "git config --global --get user.email", "git config --get --global core.autocrlf", "git config --get core.quotepath"]) allowed(command, options);
    notAllowed("git config --get sendemail.smtppass", options);
    for (const command of [
      "git config --get sendemail.smtppass", "git config --get sendemail.smtpPass", "git config --get http.proxy", "git config --get http.extraheader", "git config --get http.extraHeader", "git config --get core.sshcommand", "git config --get core.sshCommand",
      "git config --get remote.origin.url", "git config --get remote.origin.pushurl", "git config --get remote.origin.fetch", "git config --get credential.helper", "git config --get url.https://x.insteadof", "git config --get core.hookspath", "git config --get alias.x",
      "git config --get-regexp user", "git config --get-regexp .*", "git config --list", "git config -l", "git config --global --list", "git config --show-origin --get user.name", "git config --show-scope --get user.name", "git config --get --show-origin user.name",
      "git config --system --get user.name", "git config --file /etc/x --get user.name", "git config -f x --get user.name", "git config --worktree --get user.name", "git config --local --global --get user.name", "git config user.name", "git config --get", "git config --get user.name user.email",
      "git config --get-urlmatch http.proxy https://x", "git config --name-only --get user.name", "git config --blob HEAD:x --get user.name",
    ]) notAllowed(command, options);
  }
  assert.equal(verdict(run("git config --get remote.origin.url")), "require-approval/UNPARSEABLE_COMMAND");
});

// --- S: the shrunk allow set -----------------------------------------------------------------------------------------------------

test("S: cmd `dir` is allowed with /b only; every other switch asks", () => {
  for (const command of ["dir /b", "dir /B src", "dir /b src", "dir", "dir src"]) allowed(command, { dialect: "cmd", on: "win32" });
  for (const command of ["dir /s", "dir /S src", "dir /a", "dir /a:h", "dir /ah", "dir /o:n", "dir /q", "dir /x", "dir /s /b", "dir /b /s", "dir /r", "dir /t:w"]) notAllowed(command, { dialect: "cmd", on: "win32" });
  allowed("ls -la src");
});

test("S: `gh pr create` is allowed with --title, --body and --base only; anything that redirects or reads a file asks", () => {
  for (const options of MATRIX) {
    for (const command of ["gh pr create --title t --body b", "gh pr create -t t -b b -B feat/y", "gh pr create --title=t --body=b --base=feat/y", "gh pr create --fill", "gh pr create --draft -t t -b b", "gh pr create --dry-run -f"]) {
      const decision = run(command, { ...options, mode: "autonomous" });
      assert.equal(decision.decision, "allow", `${label(options)} ${command} -> ${verdict(decision)}`);
    }
    for (const command of [
      "gh pr create --head attacker:feat/x -t t -b b", "gh pr create -H attacker:feat/x -t t -b b", "gh pr create --head=x -t t", "gh pr create --repo evil/r -t t -b b", "gh pr create -R evil/r -t t -b b", "gh pr create --web", "gh pr create -w",
      "gh pr create --template t.md", "gh pr create -T t.md", "gh pr create --body-file notes.txt", "gh pr create -F notes.txt", "gh pr create --body-file=/etc/hostname", "gh pr create --label l", "gh pr create --reviewer r", "gh pr create --assignee a", "gh pr create --milestone m", "gh pr create --project p",
      "gh pr create --no-maintainer-edit -t t -b b", "gh pr create --recover x",
    ]) {
      const decision = run(command, { ...options, mode: "autonomous" });
      assert.notEqual(decision.decision, "allow", `${label(options)} ${command}`);
    }
  }
});
