// Regression tests for the round-5 security finding N1 of the allow-list classifier, and the staff round-5 items:
//   N1  EMBEDDED REPOSITORIES. A hostile repository can COMMIT a directory that looks like a bare repository (evil/HEAD, evil/config, evil/objects/*,
//       evil/refs/*, evil/hooks/*; or the variant with only HEAD + commondir). git run with such a directory as its working directory uses evil/config
//       (core.fsmonitor, diff.external, hooks, remote URLs): attacker code. Every git / gh form is therefore understood only when git's discovery from the
//       EFFECTIVE working directory (payload cwd, moved by cd / Set-Location / pushd) ends at the verified root's own .git.
//   S-4 a file called `head` is a HEAD file on every platform (case-insensitive file systems).
//   Low core.hooksPath is relative to the top of the working tree: a root that is not that top makes commit / push not understood.
//   Safe-by-construction reads: the classifier's own git reads use safe.bareRepository=explicit and GIT_CEILING_DIRECTORIES.
// Dangerous command text appears only here, in test source. Injected platforms / lstat make the cases identical on Windows and POSIX hosts; the
// real-repository tests skip without git. NOTHING in this file ever runs git inside an embedded directory except the one hardened read that must fail.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import { evaluate } from "./guard-fixture.mjs";
import { runGitSync } from "../src/runtime/shell-classify.mjs";
import { classifyShell } from "./guard-fixture.mjs";

const gone = () => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};
const contexts = {
  posix: { platform: "linux", workspaceRoot: "/home/u/work/repo", cwd: "/home/u/work/repo", userDir: "/home/u/.config/asterweave", homedir: () => "/home/u", realpath: (value) => value, readdir: gone, lstat: gone },
  win32: { platform: "win32", workspaceRoot: "C:\\work\\repo", cwd: "C:\\work\\repo", userDir: "C:\\Users\\u\\AppData\\Roaming\\asterweave", homedir: () => "C:\\Users\\u", realpath: (value) => value, readdir: gone, lstat: gone },
};
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
  const ctx = { mode, env: {}, branchOf: () => "feat/x", remotesOf: () => ["origin"], hooksPathOf: () => null, ...(mode === "autonomous" ? { policy: policy() } : {}), ...contexts[on], ...(dialect ? { dialect } : {}), ...extra };
  return evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
}
function tool(name, path, on = "posix", extra = {}) {
  return evaluate({ type: "tool", tool: { name, input: { path } } }, { mode: "supervised", env: {}, ...contexts[on], ...extra });
}
const verdict = (decision) => `${decision.decision}/${decision.reason}`;
const label = (options) => `${options.dialect ?? "all"}/${options.on ?? "posix"}`;
const SEP = { posix: "/", win32: "\\" };
/** A path below the workspace root of platform `on`. */
const at = (on, ...parts) => [contexts[on].workspaceRoot, ...parts].join(SEP[on]);
/** Supervised: not allowed (ask or deny). Autonomous: denied. */
function notAllowed(command, options = {}) {
  const supervised = run(command, options);
  assert.notEqual(supervised.decision, "allow", `supervised ${label(options)}: ${JSON.stringify(command)} -> ${verdict(supervised)}`);
  const autonomous = run(command, { ...options, mode: "autonomous" });
  assert.equal(autonomous.decision, "deny", `autonomous ${label(options)}: ${JSON.stringify(command)} -> ${verdict(autonomous)}`);
}
function allowed(command, options = {}) {
  for (const mode of ["supervised", "autonomous"]) {
    const decision = run(command, { ...options, mode });
    assert.equal(decision.decision, "allow", `${mode} ${label(options)}: ${JSON.stringify(command)} -> ${verdict(decision)}`);
  }
}
const present = (...paths) => (value) => {
  if (paths.some((entry) => entry.toLowerCase() === String(value).toLowerCase())) return { isSymbolicLink: () => false };
  return gone();
};

/** The shapes of an embedded directory git can take for a repository, as the entries a hostile repository commits. */
const SHAPES = Object.freeze([
  { name: "bare-shaped (HEAD, objects, refs, config, hooks)", entries: ["HEAD", "objects", "refs", "config", "hooks"] },
  { name: "HEAD only", entries: ["HEAD"] },
  { name: "commondir variant (HEAD + commondir)", entries: ["HEAD", "commondir"] },
  { name: "a .git file or directory", entries: [".git"] },
  { name: "objects + refs without HEAD", entries: ["objects", "refs"] },
]);
const EVIL_COMMANDS = [
  "cd evil && git status", "cd evil && git log", "cd evil && git diff", "cd evil && git commit -m x", "cd evil && git push origin feat/x", "cd evil/refs && git status",
  "cd evil; git status", "cd evil && gh pr create --fill", "Set-Location evil; git status", "Set-Location -Path evil; git log", "pushd evil && git status", "cd ./evil && git status",
  "cd evil/refs/heads && git log", "cd evil/hooks && git status", "cd evil && git status | head -1", "cd evil && ls && git status",
];
const PAYLOAD_COMMANDS = ["git status", "git log", "git diff", "git commit -m x", "git push origin feat/x", "gh pr create --fill", "git push -u origin feat/x"];

// --- N1: the classifier ----------------------------------------------------------------------------------------------------

test("N1: `cd <embedded dir> && git|gh ...` is not understood in any dialect, platform or shape of the directory (ask when supervised, deny when autonomous)", () => {
  for (const options of MATRIX) {
    for (const shape of SHAPES) {
      const lstat = present(...shape.entries.map((entry) => at(options.on, "evil", entry)));
      for (const command of EVIL_COMMANDS) notAllowed(command, { ...options, lstat });
    }
  }
});

test("N1: the finding names the cause (git-embedded-repository) and is an ordinary unparseable question, not a hard refusal", () => {
  const lstat = present(at("posix", "evil", "HEAD"));
  // Round 6: the guard does not follow a cd, so the embedded directory is found from the PAYLOAD working directory; the cd line asks for its own reason.
  const result = classifyShell("git status", { ...contexts.posix, env: {}, dialect: "posix", lstat, cwd: at("posix", "evil") });
  const finding = result.findings.find((entry) => entry.ruleId === "git-embedded-repository");
  assert.ok(finding, JSON.stringify(result.findings));
  assert.equal(finding.code, "UNPARSEABLE_COMMAND");
  assert.equal(finding.hard, undefined);
  assert.match(finding.detail, /'HEAD'/);
  assert.equal(run("git status", { lstat, cwd: at("posix", "evil") }).decision, "require-approval");
  const chained = classifyShell("cd evil && git status", { ...contexts.posix, env: {}, dialect: "posix", lstat });
  assert.ok(chained.findings.some((entry) => entry.ruleId === "cwd-change-with-other-commands" && entry.code === "UNPARSEABLE_COMMAND" && entry.hard === undefined), JSON.stringify(chained.findings));
  assert.equal(run("cd evil && git status", { lstat }).decision, "require-approval");
  // A LONE cd into the embedded directory is refused too (the next command would start there): the same walk, on the cd target.
  const lone = classifyShell("cd ./evil", { ...contexts.posix, env: {}, dialect: "posix", lstat });
  assert.ok(lone.findings.some((entry) => entry.ruleId === "git-embedded-repository"), JSON.stringify(lone.findings));
});

test("N1: a payload cwd inside an embedded directory understands no git or gh form (cwd = evil, evil/refs, evil/refs/heads)", () => {
  for (const options of MATRIX) {
    for (const shape of SHAPES) {
      const lstat = present(...shape.entries.map((entry) => at(options.on, "evil", entry)));
      for (const where of [["evil"], ["evil", "refs"], ["evil", "refs", "heads"]]) {
        for (const command of PAYLOAD_COMMANDS) notAllowed(command, { ...options, lstat, cwd: at(options.on, ...where) });
      }
    }
  }
});

test("N1: the same commands from the root, and from a normal subdirectory (packages/cli) stay allowed (usability); a cd with other commands asks, a lone plain cd is understood", () => {
  for (const options of MATRIX) {
    const lstat = present(at(options.on, "packages", "cli"), at(options.on, "packages", "cli", "package.json"), at(options.on, "packages", "cli", "src"), at(options.on, "docs", "refs"), at(options.on, "src", "objects"));
    for (const command of ["git status", "git log --oneline", "git diff", "git commit -m x", "git push origin feat/x", "gh pr create --fill"]) allowed(command, { ...options, lstat });
    // Round 6: the guard never follows a cd, so none of these chains is understood (the directory git would run in is unknown) ...
    for (const command of ["cd packages/cli && git status", "cd packages/cli && git commit -m x", "cd packages/cli && git push origin feat/x", "cd packages/cli && gh pr create --fill", "cd docs/refs && git log", "cd src/objects && git status", "cd . && git status"]) notAllowed(command, { ...options, lstat });
    // ... while a lone cd to a plain existing directory is.
    for (const command of ["cd packages/cli", "cd docs/refs", "cd src/objects", "cd ."]) allowed(command, { ...options, lstat });
    for (const command of PAYLOAD_COMMANDS) allowed(command, { ...options, lstat, cwd: at(options.on, "packages", "cli") });
    // `objects` or `refs` ALONE is an ordinary directory name; both together (without HEAD) are refused (see SHAPES).
    allowed("git status", { ...options, lstat: present(at(options.on, "x", "objects")), cwd: at(options.on, "x") });
  }
});

test("N1: a nested repository of its own (packages/sub/.git) is not the verified repository either", () => {
  for (const options of MATRIX) {
    const lstat = present(at(options.on, "packages"), at(options.on, "packages", "sub"), at(options.on, "packages", "sub", ".git"));
    notAllowed("git status", { ...options, lstat, cwd: at(options.on, "packages", "sub") });
    notAllowed("cd packages/sub && git status", { ...options, lstat });
    notAllowed("cd packages/sub", { ...options, lstat }); // a lone cd into a nested repository: the next command would start there
    allowed("cd packages", { ...options, lstat });
    allowed("git status", { ...options, lstat, cwd: at(options.on, "packages") });
  }
});

test("N1: a working directory outside the workspace root understands no git or gh form", () => {
  const outside = { posix: ["/home/u/work/other", "/home/u/work/repo2", "/", "/home/u"], win32: ["C:\\work\\other", "C:\\work\\repo2", "C:\\", "D:\\work\\repo"] };
  for (const options of MATRIX) {
    for (const cwd of outside[options.on]) {
      for (const command of ["git status", "git log", "git commit -m x", "git push origin feat/x", "gh pr create --fill"]) notAllowed(command, { ...options, cwd });
    }
  }
  // Non-git commands are judged as before (the path checks decide), so this is only about git and gh.
  allowed("git status", { on: "posix", cwd: "/home/u/work/repo" });
  allowed("git status", { on: "posix", cwd: "/home/u/work/repo/" });
});

test("N1: no cwd state exists any more: a cd in one dialect pass cannot leak into the next, a cd chain is never followed", () => {
  const lstat = present(at("win32", "evil", "HEAD"), at("win32", "sub"));
  notAllowed("cd evil && git status", { on: "win32", lstat });
  allowed("git status", { on: "win32", lstat });
  notAllowed("cd sub && git status", { on: "win32", lstat }); // followed before; now not understood at all
  allowed("cd sub", { on: "win32", lstat });
});

test("N1: a symbolic link inside the workspace that leads into an embedded directory is judged by where it leads", () => {
  // The injected realpath says `link` is really evil/refs: the walk starts from the real directory.
  const realpath = (value) => (value === "/home/u/work/repo/link" ? "/home/u/work/repo/evil/refs" : value);
  const lstat = present("/home/u/work/repo/evil/HEAD");
  notAllowed("cd link && git status", { lstat, realpath });
  // ... and one that leads outside the root.
  notAllowed("git status", { realpath: (value) => (value === "/home/u/work/repo/link" ? "/etc" : value), cwd: "/home/u/work/repo/link" });
});

test("N1: running out of time or file-system calls during the walk is a refusal (command-too-complex), never 'nothing there'", () => {
  const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  const slow = () => {
    sleep();
    return gone();
  };
  for (const mode of ["supervised", "autonomous"]) {
    const decision = run("git status", { mode, lstat: slow, budgetMs: 20, cwd: at("posix", "a", "b", "c", "d", "e", "f") });
    assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND", mode);
    assert.equal(decision.ruleId, "command-too-complex", mode);
  }
  // 1800 directories deep x 4 entries looked at each is more than MAX_FS_CALLS (6000).
  const deep = Array.from({ length: 1800 }, () => "a").join("/");
  for (const mode of ["supervised", "autonomous"]) {
    const decision = run("git status", { mode, budgetMs: 60_000, cwd: `${at("posix")}/${deep}` });
    assert.equal(verdict(decision), "deny/UNPARSEABLE_COMMAND", mode);
    assert.equal(decision.ruleId, "command-too-complex", mode);
  }
});

test("N1: the walk is counted: a normal subdirectory costs a handful of lstat calls, the root one (its .git entry)", () => {
  let calls = 0;
  const lstat = (value) => {
    calls += 1;
    return gone(value);
  };
  run("git status", { lstat });
  assert.equal(calls, 1, "from the root only <root>/.git is looked at");
  calls = 0;
  run("git status", { lstat, cwd: at("posix", "packages", "cli") });
  assert.ok(calls > 1 && calls <= 12, `calls: ${calls}`);
});

// --- Low: core.hooksPath is relative to the top of the working tree ----------------------------------------------------------

test("Low / F5: when the root is not the top of its working tree (hooksPathOf false) NO git or gh form is understood (reads, commit, push, gh pr create)", () => {
  for (const options of MATRIX) {
    const hooksPathOf = () => false;
    for (const command of ["git commit -m x", "git push origin feat/x", "git push -u origin feat/x", "git status", "git log", "git diff", "gh pr create --fill"]) notAllowed(command, { ...options, hooksPathOf });
    allowed("ls", { ...options, hooksPathOf });
    allowed("git commit -m x", { ...options, hooksPathOf: () => null });
    allowed("git commit -m x", { ...options, hooksPathOf: () => ".githooks" });
    allowed("git commit -m x", { ...options, hooksPathOf: () => { throw new Error("boom"); } });
  }
});

test("Low / F5: hooksPathOf is read once for all git forms together, and not at all without a git or gh form", () => {
  let reads = 0;
  const hooksPathOf = () => {
    reads += 1;
    return null;
  };
  run("cat README.md; ls", { hooksPathOf });
  assert.equal(reads, 0);
  run("git status; git log; cat README.md", { hooksPathOf });
  assert.equal(reads, 1);
  reads = 0;
  run("git commit -m a && git push origin feat/x; git commit -m b", { hooksPathOf });
  assert.equal(reads, 1);
});

// --- S-4: HEAD is HEAD on every platform -----------------------------------------------------------------------------------------------------

test("S-4: a file named head / Head / HEAD is refused as a git HEAD file on POSIX hosts too (macOS file systems are case-insensitive)", () => {
  for (const on of ["posix", "win32"]) {
    for (const name of ["HEAD", "head", "Head", "hEaD"]) {
      for (const mode of ["write", "edit"]) assert.equal(verdict(tool(mode, at(on, "x", name), on)), "deny/PROTECTED_PATH", `${on} ${mode} ${name}`);
    }
    assert.equal(verdict(run(`touch x/head`, { on })), "deny/PROTECTED_PATH", `${on} touch`);
    // Other names are untouched.
    for (const name of ["header", "heads", "ahead", "HEAD.md"]) assert.equal(tool("write", at(on, "x", name), on).decision, "allow", `${on} ${name}`);
  }
  // A lower-case `head` next to objects/ and refs/ completes a git directory.
  assert.equal(verdict(tool("write", at("posix", "x", "objects", "a"), "posix", { lstat: present(at("posix", "x", "HEAD"), at("posix", "x", "refs")) })), "deny/PROTECTED_PATH");
});

// --- Source hygiene (S-1) ----------------------------------------------------------------------------------------------------------------------------

test("S-1: no stray control characters in the CLI sources, tests or docs (tab, LF and CRLF line structure only)", () => {
  const cliRoot = fileURLToPath(new URL("..", import.meta.url));
  const roots = [join(cliRoot, "src"), join(cliRoot, "tests"), join(cliRoot, "..", "..", "website", "docs", "cli")];
  const found = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) {
        if (entry !== "node_modules") visit(full);
      } else if (/\.(?:mjs|cjs|js|md|json)$/.test(entry)) {
        readFileSync(full, "utf8").split("\n").forEach((line, index) => {
          const text = line.endsWith("\r") ? line.slice(0, -1) : line;
          const match = /[\u0000-\u0008\u000b-\u001f\u007f]/.exec(text);
          if (match) found.push(`${full}:${index + 1} U+${match[0].charCodeAt(0).toString(16).padStart(4, "0")}`);
        });
      }
    }
  };
  for (const root of roots) if (existsSync(root)) visit(root);
  assert.deepEqual(found, []);
});

// --- Real git ----------------------------------------------------------------------------------------------------------------------------------------

let base;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-round5-")));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const gitIn = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const forward = (value) => value.split("\\").join("/");

/** An embedded bare-repository-shaped directory built with PLAIN file writes (what a hostile commit carries). The configuration would run a marker write. */
function buildEvil(root, name, marker) {
  const evil = join(root, name);
  for (const dir of ["objects/info", "refs/heads", "hooks"]) mkdirSync(join(evil, dir), { recursive: true });
  writeFileSync(join(evil, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(evil, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = "echo pwned > '${forward(marker)}'; false"\n[remote "origin"]\n\turl = https://example.invalid/evil.git\n`);
  writeFileSync(join(evil, "objects", "info", "keep"), "");
  writeFileSync(join(evil, "refs", "heads", "keep"), "");
  return evil;
}

test("N1 (real git, classification only): the command that WOULD run core.fsmonitor from the embedded directory is refused, and nothing executes it", (t) => {
  if (gitIn(base, "--version").status !== 0) return t.skip("git is not available");
  const root = join(base, "proof");
  mkdirSync(root, { recursive: true });
  assert.equal(gitIn(root, "init", "-q").status, 0);
  assert.equal(gitIn(root, "remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  const marker = join(root, "MARKER.txt");
  const evil = buildEvil(root, "evil", marker);
  mkdirSync(join(root, "packages", "cli"), { recursive: true });
  // The commondir variant: HEAD + commondir only; objects, refs and config live elsewhere.
  mkdirSync(join(root, "evil2"), { recursive: true });
  writeFileSync(join(root, "evil2", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(root, "evil2", "commondir"), "../evil\n");
  const ctx = { workspaceRoot: root, cwd: root, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x" };
  const autonomous = { ...ctx, mode: "autonomous", policy: policy() };
  const shell = (command, context = ctx, cwd = root) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, { ...context, cwd });
  const commands = ["cd evil && git status", "cd evil && git log", "cd evil && git diff", "cd evil && git commit -m x", "cd evil && git push origin feat/x", "cd evil/refs && git status", "cd evil2 && git status", "cd evil && gh pr create --fill"];
  for (const command of commands) {
    assert.equal(verdict(shell(command)), "require-approval/UNPARSEABLE_COMMAND", command);
    assert.equal(shell(command, autonomous).decision, "deny", command);
  }
  for (const [where, command] of [[evil, "git status"], [evil, "git commit -m x"], [evil, "git push origin feat/x"], [join(evil, "refs"), "git log"], [join(root, "evil2"), "git status"]]) {
    assert.equal(verdict(shell(command, ctx, where)), "require-approval/UNPARSEABLE_COMMAND", `${where} ${command}`);
    assert.equal(shell(command, autonomous, where).decision, "deny", `${where} ${command}`);
  }
  // The controls: the root and an ordinary subdirectory are still understood (a real file system, a real remote read).
  for (const command of ["git status", "git push origin feat/x", "git commit -m x", "cd packages/cli", "cd ./packages/cli"]) {
    assert.equal(shell(command, autonomous).decision, "allow", command);
  }
  // Round 6: a cd chain is never followed, whatever it leads to.
  for (const command of ["cd packages/cli && git status", "cd packages/cli && git push origin feat/x"]) assert.equal(shell(command, autonomous).decision, "deny", command);
  assert.equal(verdict(shell("cd evil", ctx)), "require-approval/UNPARSEABLE_COMMAND", "a lone cd into the embedded directory");
  assert.equal(shell("git status", autonomous, join(root, "packages", "cli")).decision, "allow");
  assert.equal(existsSync(marker), false, "the guard only classifies: the fsmonitor payload in the embedded configuration never ran");
});

test("N1 (real git): the classifier's own reads use safe.bareRepository=explicit: git refuses to use the embedded directory (and nothing runs)", (t) => {
  const version = /(\d+)\.(\d+)\.(\d+)/.exec(gitIn(base, "--version").stdout ?? "");
  if (version === null) return t.skip("git is not available");
  const [major, minor, patch] = version.slice(1).map(Number);
  if (major < 2 || (major === 2 && (minor < 38 || (minor === 38 && patch < 1)))) return t.skip("git is older than 2.38.1 (no safe.bareRepository)");
  const root = join(base, "explicit");
  mkdirSync(root, { recursive: true });
  assert.equal(gitIn(root, "init", "-q").status, 0);
  const marker = join(root, "MARKER.txt");
  const evil = buildEvil(root, "evil", marker);
  // The hardened run (fsmonitor off, hooks off, explicit bare repositories) inside the embedded directory: git refuses to take it for a repository.
  assert.throws(() => runGitSync(["rev-parse", "--git-dir"], evil, { readConfig: true }));
  assert.equal(existsSync(marker), false);
  // ... while the real repository at the root still works.
  assert.equal(runGitSync(["rev-parse", "--git-dir"], root, { readConfig: true }), ".git");
});

test("N1 (real git): GIT_CEILING_DIRECTORIES keeps the classifier's reads from walking from a non-repository root into the repository above it", (t) => {
  if (gitIn(base, "--version").status !== 0) return t.skip("git is not available");
  const parent = join(base, "ceiling");
  const child = join(parent, "child");
  mkdirSync(child, { recursive: true });
  assert.equal(gitIn(parent, "init", "-q").status, 0);
  assert.equal(gitIn(parent, "remote", "add", "origin", "https://example.invalid/parent.git").status, 0);
  const ctx = { workspaceRoot: child, cwd: child, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x" };
  // `origin` is a remote of the PARENT repository only: the child root is not a repository, so no push is understood.
  assert.equal(verdict(evaluate({ type: "tool", tool: { name: "shell", input: { command: "git push origin feat/x" } } }, ctx)), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(runGitSync(["config", "--get", "remote.origin.url"], parent, { readConfig: true }), "https://example.invalid/parent.git");
  assert.throws(() => runGitSync(["config", "--get", "remote.origin.url"], child, { readConfig: true, ceiling: parent }));
});

test("Low (real git): a workspace root that is a subdirectory of the working tree makes commit and push not understood; the repository top is fine", (t) => {
  if (gitIn(base, "--version").status !== 0) return t.skip("git is not available");
  const top = join(base, "toprepo");
  const sub = join(top, "app");
  mkdirSync(sub, { recursive: true });
  assert.equal(gitIn(top, "init", "-q").status, 0);
  assert.equal(gitIn(top, "remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  assert.equal(gitIn(top, "config", "core.hooksPath", "hk").status, 0);
  const make = (root) => ({ workspaceRoot: root, cwd: root, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x" });
  const shell = (command, ctx) => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, ctx);
  assert.equal(shell("git commit -m x", make(top)).decision, "allow");
  assert.equal(shell("git push origin feat/x", make(top)).decision, "allow");
  // `hk` would mean top/hk to git, not app/hk: the guard cannot protect the right directory, so it understands no hook-running form.
  assert.equal(verdict(shell("git commit -m x", make(sub))), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(verdict(shell("git push origin feat/x", make(sub))), "require-approval/UNPARSEABLE_COMMAND");
  // Round 6 (F5): the root is not the top of its working tree, so no git form at all is understood, reads included.
  assert.equal(verdict(shell("git status", make(sub))), "require-approval/UNPARSEABLE_COMMAND");
  assert.equal(verdict(shell("gh pr create --fill", make(sub))), "require-approval/UNPARSEABLE_COMMAND");
});
