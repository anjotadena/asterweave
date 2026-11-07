// Regression tests for the round-6 simplification of the allow-list classifier: THE GUARD NEVER MODELS A DIRECTORY CHANGE.
//
// The final reviews proved that a modeled working directory diverges from the real shell: a FAILING cd (`cd evil && cd ../nope; git status` runs git from evil),
// WILDCARD operands (`cd ev*`, `cd ev?l`, `cd [e]vil`, `Set-Location ev*`, `sl e?il` expand into the embedded repository in posix, PowerShell and cmd), trailing dots
// and spaces (`cd evil.` in cmd), bash's physical fallback (`cd link/../x`), CDPATH, and a glob / trailing-dot cd into a committed symlink followed by `cat secret.txt`.
// New rules:
//   1. A command line that contains cd / chdir / Set-Location / sl / pushd / popd / Push-Location / Pop-Location TOGETHER WITH ANY OTHER command is not understood at all
//      (finding cwd-change-with-other-commands: ask when supervised, deny when autonomous).
//   2. A LONE cd is understood only for a plain in-workspace directory (no wildcard, trailing dot / space, `~`, `$`, `%`, `-`, provider form, CDPATH-sensitive spelling,
//      embedded repository).
//   3. EVERY git or gh form (reads included) needs `<root>/.git` and `hooksPathOf(root) !== false`; the payload working directory is still walked for embedded repositories.
// Dangerous-looking command text appears only here, in test source. Injected platforms / lstat make the cases identical on Windows and POSIX hosts. The real-git test
// only CLASSIFIES: it never runs the git command, and asserts that the fsmonitor marker of the embedded directory was never written.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, before } from "node:test";
import { classifyShell, evaluate } from "./guard-fixture.mjs";

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
const verdict = (decision) => `${decision.decision}/${decision.reason}`;
const label = (options, command) => `${options.dialect ?? "all"}/${options.on ?? "posix"}/cwd=${options.cwd ?? "root"}: ${JSON.stringify(command)}`;
const SEP = { posix: "/", win32: "\\" };
const at = (on, ...parts) => [contexts[on].workspaceRoot, ...parts].join(SEP[on]);
function notAllowed(command, options = {}) {
  const supervised = run(command, options);
  assert.notEqual(supervised.decision, "allow", `supervised ${label(options, command)} -> ${verdict(supervised)}`);
  const autonomous = run(command, { ...options, mode: "autonomous" });
  assert.equal(autonomous.decision, "deny", `autonomous ${label(options, command)} -> ${verdict(autonomous)}`);
}
function allowed(command, options = {}) {
  for (const mode of ["supervised", "autonomous"]) {
    const decision = run(command, { ...options, mode });
    assert.equal(decision.decision, "allow", `${mode} ${label(options, command)} -> ${verdict(decision)}`);
  }
}
/** An lstat that reports the given paths as real directories / files (everything else is missing). */
const present = (...paths) => (value) => {
  if (paths.some((entry) => entry.toLowerCase() === String(value).toLowerCase())) return { isSymbolicLink: () => false, isDirectory: () => true };
  return gone();
};
/** The file system of the reviewers' proofs: an embedded repository `evil/`, a directory `jn/` with a secret, `src/`, `sub/`, `packages/cli`, a file `afile.txt`. */
const world = (on) => {
  const dirs = [["evil"], ["evil", "HEAD"], ["evil", "objects"], ["evil", "refs"], ["evil", "config"], ["jn"], ["src"], ["sub"], ["packages"], ["packages", "cli"], ["link"], ["afile.txt"]];
  return present(...dirs.map((parts) => at(on, ...parts)));
};

/** Every reviewer row that read ALLOW before round 6 (all must be refused whatever the dialect and whatever the payload working directory). */
const REVIEWER_ROWS = [
  "cd ev* && git status", "cd ev*; git status", "cd ev?l && git status", "cd [e]vil && git status", "cd e*l; git log", "cd evi[l]; git diff",
  "cd e* && gh pr create --title t --body b", "Set-Location ev*; git status", "Set-Location -Path ev*; git status", "sl e?il; git status",
  "cd evil. && git status", "cd j* && cat secret.txt", "cd j?; cat secret.txt", "cd jn. && type secret.txt", 'cd "jn " && cat secret.txt', "cd j* && ls",
  "cd nonexist; git status", "cd evil; cd ../nope; git status", "cd evil && cd ../nope || git status", "cd ../nope; git status", "cd ../afile.txt; git status",
  "cd ../nope\ngit status", "cd link/../x && git status", "cd sub && git status", "ls && cd src", "cd src && cat a.js",
  // the other directory-changing commands, before / after / inside a group
  "pushd src && git status", "git status && popd", "Push-Location src; git status", "git status; Pop-Location", "(cd src && git status)", "{ cd src; git status; }", "git status | cd src",
  "cd src && git commit -m x", "cd src && git push origin feat/x", "ls; cd src; ls", "cd src; cd ..",
];
const WHERE = [[], ["evil"]];

test("round 6: every reviewer row is NOT allowed in every dialect, from the root and from a payload working directory inside the embedded repository (ask / deny)", () => {
  for (const options of MATRIX) {
    for (const where of WHERE) {
      const cwd = at(options.on, ...where);
      for (const command of REVIEWER_ROWS) notAllowed(command, { ...options, lstat: world(options.on), cwd });
    }
  }
});

test("round 6: the finding of a cd combined with other commands is cwd-change-with-other-commands (an ordinary question, not a hard refusal)", () => {
  for (const options of MATRIX) {
    const result = classifyShell("cd src && git status", { ...contexts[options.on], env: {}, ...(options.dialect ? { dialect: options.dialect } : {}), lstat: world(options.on), hooksPathOf: () => null, remotesOf: () => ["origin"] });
    const finding = result.findings.find((entry) => entry.ruleId === "cwd-change-with-other-commands");
    assert.ok(finding, `${options.dialect}/${options.on}: ${JSON.stringify(result.findings)}`);
    assert.equal(finding.code, "UNPARSEABLE_COMMAND");
    assert.equal(finding.hard, undefined);
  }
  assert.equal(verdict(run("cd src && ls", { lstat: world("posix") })), "require-approval/UNPARSEABLE_COMMAND");
});

test("round 6: a LONE cd to a plain existing workspace directory is still understood (allowed), in every dialect", () => {
  for (const options of MATRIX) {
    const lstat = world(options.on);
    for (const command of ["cd src", "cd ./src", "cd src/", "cd packages/cli", "cd ../packages", "cd .", "cd ..", "Set-Location src", "cd src;", "chdir src"]) {
      // `cd ..` leaves the root when the payload cwd is the root: judged from packages/cli, it is the workspace again.
      const cwd = command === "cd .." || command === "cd ../packages" ? at(options.on, "packages", "cli") : at(options.on);
      if (command === "Set-Location src" && options.dialect === "posix") continue; // not a posix command
      allowed(command, { ...options, lstat, cwd });
    }
  }
});

test("round 6: a lone cd is refused for every operand the shell resolves in a way the guard cannot predict", () => {
  const lone = [
    "cd ev*", "cd ev?l", "cd [e]vil", "cd evil.", 'cd "jn "', "cd jn.", "cd -", "cd ~", "cd ~/src", "cd $HOME", "cd %CD%", "cd $OLDPWD", "cd link/../x", "cd src/../sub",
    "Set-Location ev*", "Set-Location -Path ev*", "sl e?il", "Set-Location env:", "cd FileSystem::C:\\", "cd C:foo", "cd PROGRA~1", "cd evil", "cd ./evil",
    "cd ..", "cd ../..", "cd /", "cd /etc",
  ];
  for (const options of MATRIX) for (const command of lone) notAllowed(command, { ...options, lstat: world(options.on) });
});

test("round 6: posix CDPATH rule: a relative operand not starting with ./ or ../ is understood only when it is a real directory here (and CDPATH is unset)", () => {
  const lstat = world("posix");
  allowed("cd src", { dialect: "posix", lstat });
  notAllowed("cd missing", { dialect: "posix", lstat });
  notAllowed("cd src", { dialect: "posix", lstat, env: { CDPATH: "/home/u/other" } });
  allowed("cd ./src", { dialect: "posix", lstat, env: { CDPATH: "/home/u/other" } }); // ./name never searches CDPATH
  // A link is not a real directory: the posix reading cannot tell where CDPATH or the link would lead.
  const link = (value) => (String(value).toLowerCase() === at("posix", "ln").toLowerCase() ? { isSymbolicLink: () => true, isDirectory: () => false } : gone());
  notAllowed("cd ln", { dialect: "posix", lstat: link });
});

test("round 6 / F5: EVERY git or gh form needs <root>/.git: a root without one (bare-repository shapes included) asks and is denied when autonomous", () => {
  const forms = ["git status", "git log", "git diff", "git commit -m x", "git push origin feat/x", "gh pr create --fill"];
  const shapes = [[], ["HEAD", "objects", "refs"], ["HEAD", "commondir"], ["HEAD"], ["objects", "refs"]];
  for (const options of MATRIX) {
    for (const entries of shapes) {
      const lstat = present(...entries.map((entry) => at(options.on, entry)));
      for (const command of forms) {
        notAllowed(command, { ...options, lstat, rootGit: false });
        allowed(command, { ...options, lstat }); // the fixture adds <root>/.git: the same command is understood
      }
    }
  }
  const bare = classifyShell("git status", { ...contexts.posix, env: {}, dialect: "posix", rootGit: false, lstat: present("/home/u/work/repo/HEAD", "/home/u/work/repo/objects", "/home/u/work/repo/refs") });
  assert.ok(bare.findings.some((entry) => entry.ruleId === "git-embedded-repository" && /bare repository/.test(entry.detail)), JSON.stringify(bare.findings));
  // A .git FILE (a linked worktree) counts as an entry.
  allowed("git status", { on: "posix", rootGit: false, lstat: present("/home/u/work/repo/.git") });
});

test("round 6 / F5: hooksPathOf false (the root is not the top of its working tree) refuses the read forms as well; null and a value are fine", () => {
  for (const options of MATRIX) {
    for (const command of ["git status", "git log", "git diff", "gh pr create --fill", "git commit -m x"]) {
      notAllowed(command, { ...options, hooksPathOf: () => false });
      allowed(command, { ...options, hooksPathOf: () => null });
      allowed(command, { ...options, hooksPathOf: () => ".githooks" });
    }
  }
});

test("round 6: git forms from the root and from a normal subdirectory payload cwd stay allowed", () => {
  for (const options of MATRIX) {
    const lstat = world(options.on);
    for (const command of ["git status", "git log --oneline", "git diff", "git commit -m x", "git push origin feat/x", "gh pr create --fill"]) {
      allowed(command, { ...options, lstat });
      allowed(command, { ...options, lstat, cwd: at(options.on, "packages", "cli") });
      notAllowed(command, { ...options, lstat, cwd: at(options.on, "evil") });
    }
  }
});

// --- Real git, CLASSIFICATION ONLY: the git command is never executed ------------------------------------------------------------------------------------

let base;
before(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-round6-")));
});
after(() => rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

const gitIn = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const forward = (value) => value.split("\\").join("/");

test("round 6 (real git, classification only): every reviewer row is refused over a real embedded repository, and nothing ever executes its fsmonitor payload", (t) => {
  if (gitIn(base, "--version").status !== 0) return t.skip("git is not available");
  const root = join(base, "proof");
  mkdirSync(root, { recursive: true });
  assert.equal(gitIn(root, "init", "-q").status, 0);
  assert.equal(gitIn(root, "remote", "add", "origin", "https://example.invalid/r.git").status, 0);
  const marker = join(root, "MARKER.txt");
  const evil = join(root, "evil");
  for (const dir of ["objects/info", "refs/heads", "hooks"]) mkdirSync(join(evil, dir), { recursive: true });
  writeFileSync(join(evil, "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(evil, "config"), `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ..\n\tfsmonitor = "echo pwned > '${forward(marker)}'; false"\n`);
  writeFileSync(join(evil, "objects", "info", "keep"), "");
  writeFileSync(join(evil, "refs", "heads", "keep"), "");
  // A directory with a secret and, where the host allows it, a committed link to a directory outside the workspace.
  mkdirSync(join(root, "jn"), { recursive: true });
  writeFileSync(join(root, "jn", "secret.txt"), "s\n");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "afile.txt"), "x\n");
  mkdirSync(join(root, "sub"), { recursive: true });
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "outside\n");
  try {
    symlinkSync(outside, join(root, "link"), "junction");
  } catch {
    // no link support here: the other rows still run
  }
  const ctx = { workspaceRoot: root, mode: "supervised", env: {}, userDir: join(base, "ud"), homedir: () => join(base, "home"), branchOf: () => "feat/x" };
  const shell = (command, cwd, mode = "supervised") => evaluate({ type: "tool", tool: { name: "shell", input: { command } } }, { ...ctx, cwd, mode, ...(mode === "autonomous" ? { policy: policy() } : {}) });
  for (const cwd of [root, evil]) {
    for (const command of REVIEWER_ROWS) {
      assert.equal(shell(command, cwd).decision === "allow", false, `cwd=${cwd}: ${JSON.stringify(command)}`);
      assert.equal(shell(command, cwd, "autonomous").decision, "deny", `autonomous cwd=${cwd}: ${JSON.stringify(command)}`);
    }
  }
  // Controls on the real file system: the root and a lone cd to a plain directory are understood.
  for (const command of ["git status", "cd src", "cd ./sub", "cd jn"]) assert.equal(shell(command, root).decision, "allow", command);
  assert.equal(existsSync(marker), false, "the guard only classifies: the fsmonitor payload in the embedded configuration never ran");
});
