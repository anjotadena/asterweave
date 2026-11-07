// Git worktrees for isolated sessions: plan, create, list, inspect and (carefully) remove.
//
// LOCATION: only the existence of Claude Code's `claude -w/--worktree [name]` flag was verified (`claude --help`); where
// it puts its worktrees was NOT verified (it is believed to be inside the repository, which would show untracked content
// unless .gitignore is edited). Whatever it does, Asterweave must never dirty the repository, so the default is
//   `<userDir>/worktrees/<repoDirName>/<name>`      (repoDirName = ledger.mjs repoDirName(repoKey))
// outside every work tree. An explicit `path` option overrides it; such a path is refused when it is inside the
// repository, inside its .git, or inside another worktree of it.
//
// SAFETY MODEL
//  - Every git call: no shell, argument array, allow-listed environment (gitEnv), hooks off (core.hooksPath), fsmonitor
//    off, no pager, no optional locks, safe.bareRepository=explicit and GIT_CEILING_DIRECTORIES so discovery cannot
//    escape upward from the directory we pass.
//  - The repository is UNTRUSTED. `git status` and `git checkout` run `filter.<name>.clean/smudge/process` drivers from
//    the repository config (tests/git-safety.test.mjs proves plain `git status` does). So before anything that hashes
//    or smudges content (create, dirty check, remove) the effective config (`git config --list --show-scope`, which
//    includes config.worktree and include.path files) is scanned: a filter driver that is NOT from the system/global
//    scope (the user's own, e.g. git-lfs) blocks the operation. Create refuses; inspect reports dirty "unknown"; remove
//    refuses because "unknown" is never "clean".
//  - Ownership: a worktree is "created by asterweave" only if `<gitdir>/asterweave-worktree.json` (inside git's private
//    admin directory, never inside the work tree) exists, names this repository and this exact path. Only those are removed.
//  - Removal never uses --force, never deletes a branch and never touches anything but one registered linked worktree.

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { resolveUserDir } from "../paths.mjs";
import { runBinary } from "../proc.mjs";
import { redactText, sanitizeForTerminal, suggestCommand } from "../redact.mjs";
import { gitEnv } from "../repo.mjs";
import { writeJsonAtomic } from "../store.mjs";
import { repoDirName } from "./ledger.mjs";
import { worktreeRootProblem } from "./repo-root.mjs";

export const WORKTREE_MARKER_FILE = "asterweave-worktree.json";
export const WORKTREE_MARKER_VERSION = 1;
export const WORKTREE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const MAX_FILE_BYTES = 8192;
const DEFAULT_BRANCH_PREFIX = "asterweave/";

/**
 * @typedef {object} WorktreeOptions
 * @property {Record<string,string|undefined>} [env]
 * @property {string} [platform]
 * @property {Function} [spawn]     child_process.spawn-compatible (injectable).
 * @property {(file: string) => boolean} [exists]  Executable existence check for PATH lookup (tests).
 * @property {typeof nodeFs} [fs]
 * @property {string} [userDir]     Overrides the user directory.
 * @property {() => string} [homedir]
 * @property {() => string} [now]   ISO timestamp provider.
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal] Checked before every mutating step; abort leaves everything as it was.
 */

const fail = (message, code, { exitCode = EXIT.ERROR, remediation } = {}) => new CliError(message, { code, exitCode, remediation });
const shown = (value, max = 80) => sanitizeForTerminal(String(value ?? "")).slice(0, max);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fsOf = (options) => options?.fs ?? nodeFs;
const platformOf = (options) => options?.platform ?? process.platform;
const fold = (platform) => (value) => (platform === "win32" ? String(value).toLowerCase() : String(value));
const nowOf = (options) => (options?.now ?? (() => new Date().toISOString()))();

function realpath(file, fs) {
  try {
    return (fs.realpathSync.native ?? fs.realpathSync)(file);
  } catch {
    return path.resolve(file);
  }
}

/** realpath of the longest existing ancestor joined with the not-yet-existing remainder. */
function resolveReal(file, fs) {
  const absolute = path.resolve(file);
  const rest = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join((fs.realpathSync.native ?? fs.realpathSync)(current), ...rest.reverse());
    } catch (error) {
      const parent = path.dirname(current);
      if (parent === current || error?.code === "EACCES") return absolute;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

function inside(child, parent, platform) {
  const f = fold(platform);
  const relative = path.relative(f(parent), f(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function throwIfAborted(options) {
  if (options?.signal?.aborted) throw fail("Interrupted before any change was made; nothing was modified.", "WORKTREE_INTERRUPTED", { exitCode: EXIT.INTERRUPTED });
}

// ---------------------------------------------------------------------------------------------
// git

const gitFlags = (platform) => [
  "--no-pager",
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`,
  "-c", "protocol.ext.allow=never",
  "-c", "core.sshCommand=",
  "-c", "safe.bareRepository=explicit",
];

/** Run git in `cwd`. Resolves with {code, stdout, stderr}; throws only when git cannot run at all. */
async function git(options, cwd, args, { ceiling = path.dirname(cwd) } = {}) {
  const platform = platformOf(options);
  const result = await runBinary("git", [...gitFlags(platform), ...args], {
    cwd,
    env: { ...gitEnv(options.env), ...(ceiling === null ? {} : { GIT_CEILING_DIRECTORIES: ceiling }) },
    spawn: options.spawn,
    exists: options.exists,
    platform: options.platform,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (["NOT_FOUND", "SHELL_SHIM_ONLY"].includes(result.error?.code)) {
    throw fail("git was not found.", "GIT_NOT_INSTALLED", { remediation: "Install git (https://git-scm.com/) and make sure it is on PATH." });
  }
  if (result.error) throw fail(`git ${args[0]} failed: ${result.error.code === "ETIMEDOUT" ? "timed out" : "could not run"}.`, "GIT_FAILED");
  return result;
}

const firstLine = (text) => sanitizeForTerminal(redactText(String(text ?? "").trim().split(/\r?\n/)[0] ?? "").text).slice(0, 200);

/**
 * The repository behind `root` (any directory inside a work tree). `key` is the realpath of the git common directory
 * (lower-cased on win32): identical to `resolveRepo(...).key` of commands/run.mjs, so sessions and runs agree.
 * @returns {Promise<{key: string, commonDir: string, workspace: string, repoDir: string, platform: string, options: WorktreeOptions}>}
 */
export async function resolveWorktreeContext(root, options = {}) {
  const fs = fsOf(options);
  const platform = platformOf(options);
  if (typeof root !== "string" || root === "") throw fail("A repository path is required.", "WORKTREE_ROOT_REQUIRED", { exitCode: EXIT.USAGE });
  const cwd = realpath(path.resolve(root), fs);
  // Discovery from `root` may legitimately walk UP (root can be a subdirectory), so this one call has no ceiling; its answer
  // is cross-checked by worktreeRootProblem below, and every later call runs at the work-tree top with the ceiling set.
  const out = await git(options, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], { ceiling: null });
  const lines = out.code === 0 ? out.stdout.split(/\r?\n/).filter(Boolean) : [];
  if (lines.length < 2) throw fail(`${shown(cwd, 160)} is not inside a git work tree.`, "REPO_NOT_GIT", { remediation: "Run this from inside a clone (bare repositories are not supported)." });
  const commonDir = realpath(lines[0], fs);
  const workspace = realpath(lines[1], fs);
  const problem = worktreeRootProblem({ cwd, toplevel: workspace, commonDir, platform, fs });
  if (problem !== null) {
    throw fail(`This repository's work tree is not what git reports: ${problem}.`, "REPO_WORKTREE_MISMATCH", { remediation: "Check core.worktree in the repository's .git/config." });
  }
  const key = fold(platform)(commonDir);
  return { key, commonDir, workspace, repoDir: repoDirName(key), platform, options };
}

/**
 * Whether a content-hashing git command may run in `cwd`. Blocked by any filter driver defined outside the
 * system/global scope (repository, worktree, include files, command line), and by any repository/worktree-level
 * include.path or includeIf.*.path key. Config is listed WITH includes and from `cwd`, so conditional includes
 * (onbranch:, gitdir:) are evaluated for the work tree the later command runs in. Reads config only.
 * @returns {Promise<{safe: boolean, reason?: string}>}
 */
async function filterDriverCheck(options, cwd) {
  const result = await git(options, cwd, ["config", "--list", "-z", "--show-scope", "--includes"]);
  if (result.code !== 0) return { safe: false, reason: "git config could not be read" };
  const tokens = result.stdout.split("\0");
  const offenders = [];
  let includes = 0;
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const scope = tokens[index];
    const key = tokens[index + 1].split("\n", 1)[0].toLowerCase();
    if (scope === "system" || scope === "global") continue;
    // Defence in depth: a repository/worktree-level include (plain or conditional) can pull in a filter driver from a
    // file or under a condition (onbranch:, gitdir:), so it is refused outright even if no driver is visible today.
    if (key === "include.path" || /^includeif\..+\.path$/.test(key)) {
      includes += 1;
      continue;
    }
    if (!/^filter\..+\.(?:clean|smudge|process)$/.test(key)) continue;
    offenders.push(key.replace(/^filter\.(.+)\.[a-z]+$/, "$1"));
  }
  if (offenders.length === 0 && includes === 0) return { safe: true };
  if (offenders.length === 0) return { safe: false, reason: "the repository config includes other config files (include.path / includeIf), which could define filter drivers" };
  return { safe: false, reason: `the repository configures filter driver(s) (${offenders.slice(0, 3).map((name) => shown(name, 40)).join(", ")}) that would run code` };
}

// ---------------------------------------------------------------------------------------------
// Marker and listing

function readBoundedText(file, fs) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.size > MAX_FILE_BYTES) return null;
  return fs.readFileSync(file, "utf8");
}

/** The git admin directory of a work tree: the common dir for the main one, `<common>/worktrees/<id>` for a linked one. */
function adminDirOf(ctx, worktreePath, isMain) {
  if (isMain) return ctx.commonDir;
  const fs = fsOf(ctx.options);
  try {
    const text = readBoundedText(path.join(worktreePath, ".git"), fs);
    const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
    if (!match) return null;
    const admin = realpath(path.resolve(worktreePath, match[1]), fs);
    return inside(admin, path.join(ctx.commonDir, "worktrees"), ctx.platform) && admin !== ctx.commonDir ? admin : null;
  } catch {
    return null;
  }
}

function readMarker(ctx, worktreePath, isMain) {
  if (isMain) return null;
  const admin = adminDirOf(ctx, worktreePath, false);
  if (admin === null) return null;
  const f = fold(ctx.platform);
  try {
    const text = readBoundedText(path.join(admin, WORKTREE_MARKER_FILE), fsOf(ctx.options));
    const marker = text === null ? null : JSON.parse(text);
    if (!isObject(marker) || marker.schemaVersion !== WORKTREE_MARKER_VERSION || marker.createdBy !== "asterweave") return null;
    if (typeof marker.path !== "string" || f(marker.path) !== f(worktreePath) || f(String(marker.repoKey)) !== ctx.key) return null;
    if (typeof marker.name !== "string" || typeof marker.branch !== "string" || !isObject(marker.base) || typeof marker.base.commit !== "string") return null;
    return marker;
  } catch {
    return null;
  }
}

/**
 * Every worktree of the repository (`git worktree list --porcelain -z`). The first entry is the main work tree.
 * @param {string} root  Any directory inside the repository.
 * @param {WorktreeOptions} [options]
 * @returns {Promise<Array<{path: string, head: string|null, branch: string|null, detached: boolean, bare: boolean,
 *   main: boolean, locked: false|string, prunable: boolean, exists: boolean, asterweave: boolean, name: string|null,
 *   base: string|null}>>}
 */
export async function listWorktrees(root, options = {}) {
  return (await listWithContext(await resolveWorktreeContext(root, options))).entries;
}

async function listWithContext(ctx) {
  const fs = fsOf(ctx.options);
  const result = await git(ctx.options, ctx.workspace, ["worktree", "list", "--porcelain", "-z"]);
  if (result.code !== 0) throw fail(`Could not list worktrees: ${firstLine(result.stderr) || `git exit ${result.code}`}`, "WORKTREE_LIST_FAILED");
  const entries = [];
  let current = null;
  const flush = () => {
    if (current?.path) entries.push(current);
    current = null;
  };
  for (const field of result.stdout.split("\0")) {
    if (field === "") {
      flush();
      continue;
    }
    const space = field.indexOf(" ");
    const keyword = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? "" : field.slice(space + 1);
    if (keyword === "worktree") {
      flush();
      current = { path: value, head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
    } else if (current) {
      if (keyword === "HEAD") current.head = /^[0-9a-f]{40,64}$/.test(value) ? value : null;
      else if (keyword === "branch") current.branch = value.replace(/^refs\/heads\//, "");
      else if (keyword === "detached") current.detached = true;
      else if (keyword === "bare") current.bare = true;
      else if (keyword === "locked") current.locked = value === "" ? true : shown(redactText(value).text, 200);
      else if (keyword === "prunable") current.prunable = true;
    }
  }
  flush();
  const list = entries.map((entry, index) => {
    const exists = (() => {
      try {
        return fs.statSync(entry.path).isDirectory();
      } catch {
        return false;
      }
    })();
    const real = exists ? realpath(entry.path, fs) : path.resolve(entry.path);
    const main = index === 0;
    const marker = readMarker(ctx, real, main);
    return { ...entry, path: real, main, exists, asterweave: marker !== null, name: marker?.name ?? null, base: marker?.base.commit ?? null, ...(marker ? { marker } : {}) };
  });
  const entriesOut = list.map(({ marker, ...entry }) => entry);
  return { entries: entriesOut, markers: new Map(list.filter((entry) => entry.marker).map((entry) => [entry.path, entry.marker])), main: entriesOut[0] };
}

// ---------------------------------------------------------------------------------------------
// Plan

function validateName(name) {
  const ok = typeof name === "string" && WORKTREE_NAME_PATTERN.test(name) && !name.includes("..") && !/[.]$/.test(name) && !/\.lock$/.test(name) && !WINDOWS_RESERVED.test(name);
  if (!ok) {
    throw fail(`'${shown(name, 64)}' is not a valid worktree name.`, "WORKTREE_NAME_INVALID", {
      exitCode: EXIT.USAGE,
      remediation: "Use 1-64 characters: lowercase letters, digits, '.', '_' or '-', starting with a letter or digit, not ending in '.' or '.lock', and not a reserved device name.",
    });
  }
}

function plainRefText(value) {
  return typeof value === "string" && value !== "" && value.length <= 200 && !value.startsWith("-") && !/[\x00-\x20\x7f]/.test(value);
}

/**
 * Validate everything `createWorktree` will do, changing nothing.
 * @param {{root: string, name: string, base?: string, branch?: string, path?: string} & WorktreeOptions} input
 *   `path` (absolute, no `..`) overrides the default location `<userDir>/worktrees/<repoDirName>/<name>`.
 * @returns {Promise<{ok: true, repoKey: string, root: string, name: string, branch: string, base: {ref: string, commit: string},
 *   path: string, location: 'user-dir'|'custom'}>}
 * @throws {CliError} WORKTREE_NAME_INVALID/BRANCH_INVALID/BASE_INVALID (exit 2), BRANCH_EXISTS, PATH_EXISTS, PATH_UNSAFE (exit 1)
 */
export async function planWorktree({ root, name, base, branch, path: customPath, ...options } = {}) {
  validateName(name);
  const ctx = await resolveWorktreeContext(root, options);
  const fs = fsOf(options);
  const wanted = branch === undefined ? `${DEFAULT_BRANCH_PREFIX}${name}` : branch;
  const refName = base === undefined ? "HEAD" : base;

  if (!plainRefText(wanted) || wanted === "HEAD" || (await git(options, ctx.workspace, ["check-ref-format", `refs/heads/${wanted}`])).code !== 0) {
    throw fail(`'${shown(wanted, 80)}' is not a valid branch name.`, "WORKTREE_BRANCH_INVALID", { exitCode: EXIT.USAGE, remediation: "Pass a branch name git accepts (see `git check-ref-format`); it must not start with '-'." });
  }
  if ((await git(options, ctx.workspace, ["rev-parse", "--verify", "--quiet", `refs/heads/${wanted}`])).code === 0) {
    throw fail(`The branch '${shown(wanted, 80)}' already exists; a worktree always gets a NEW branch.`, "WORKTREE_BRANCH_EXISTS", { remediation: "Choose another --branch (an existing branch is never reused or reset)." });
  }
  if (!plainRefText(refName)) {
    throw fail(`'${shown(refName, 80)}' is not a valid base.`, "WORKTREE_BASE_INVALID", { exitCode: EXIT.USAGE, remediation: "Pass a branch, tag or commit that exists in this repository." });
  }
  const resolved = await git(options, ctx.workspace, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${refName}^{commit}`]);
  const commit = resolved.stdout.trim();
  if (resolved.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) {
    throw fail(`The base '${shown(refName, 80)}' does not resolve to a commit.`, "WORKTREE_BASE_INVALID", { exitCode: EXIT.USAGE, remediation: "Pass a branch, tag or commit that exists in this repository." });
  }

  const location = customPath === undefined ? "user-dir" : "custom";
  let target;
  if (location === "custom") {
    if (typeof customPath !== "string" || !path.isAbsolute(customPath) || customPath.split(/[\\/]+/).includes("..")) {
      throw fail("The worktree path must be absolute and contain no '..' segment.", "WORKTREE_PATH_UNSAFE", { exitCode: EXIT.USAGE });
    }
    const resolvedPath = path.resolve(customPath);
    target = path.join(resolveReal(path.dirname(resolvedPath), fs), path.basename(resolvedPath));
  } else {
    const userDir = options.userDir ?? resolveUserDir({ env: options.env ?? process.env, platform: options.platform, homedir: options.homedir });
    target = path.join(resolveReal(path.join(userDir, "worktrees", ctx.repoDir), fs), name);
  }

  const entries = (await listWithContext(ctx)).entries;
  const guarded = [ctx.workspace, ctx.commonDir, ...entries.map((entry) => entry.path)];
  const clash = guarded.find((other) => inside(target, other, ctx.platform));
  if (clash !== undefined) {
    throw fail("The worktree path must be outside the repository, its .git directory and every other worktree.", "WORKTREE_PATH_UNSAFE", { remediation: "Omit --path to use the default location in the Asterweave user directory." });
  }
  try {
    fs.lstatSync(target);
    throw fail(`The path ${shown(target, 200)} already exists.`, "WORKTREE_PATH_EXISTS", { remediation: "Choose another name or --path; nothing existing is ever reused or overwritten." });
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code !== "ENOENT") throw fail(`Cannot inspect ${shown(target, 200)}: ${error?.code ?? "error"}.`, "WORKTREE_PATH_UNSAFE");
  }
  return { ok: true, repoKey: ctx.key, root: ctx.workspace, name, branch: wanted, base: { ref: redactText(refName).text, commit }, path: target, location };
}

// ---------------------------------------------------------------------------------------------
// Create

/**
 * Create the worktree described by a plan: `git worktree add --no-checkout -b ...`, then a config scan INSIDE the new
 * worktree (conditional includes are active there), then `reset --hard` to populate; hooks off throughout. Before that,
 * confirming no repository filter driver would run during checkout. Re-validates the plan (it may be stale), claims the
 * target directory with an atomic mkdir (so of two concurrent creates of the same name exactly one wins), and records
 * the asterweave marker. Never reuses a branch or directory.
 * @param {Awaited<ReturnType<typeof planWorktree>> & WorktreeOptions} plan
 * @param {WorktreeOptions} [options]
 */
export async function createWorktree(plan, options = {}) {
  if (!isObject(plan) || plan.ok !== true || !isObject(plan.base)) throw fail("createWorktree needs the result of planWorktree.", "WORKTREE_PLAN_INVALID", { exitCode: EXIT.USAGE });
  const fresh = await planWorktree({ root: plan.root, name: plan.name, branch: plan.branch, base: plan.base.commit, ...(plan.location === "custom" ? { path: plan.path } : {}), ...options });
  fresh.base.ref = typeof plan.base.ref === "string" ? redactText(plan.base.ref).text : fresh.base.ref;
  const f = fold(platformOf(options));
  if (f(fresh.path) !== f(plan.path)) throw fail("The worktree plan is stale (the path changed); plan again.", "WORKTREE_PLAN_STALE");
  const fs = fsOf(options);
  const ctx = await resolveWorktreeContext(fresh.root, options);
  const safety = await filterDriverCheck(options, ctx.workspace);
  if (!safety.safe) throw fail(`Refusing to create a worktree: ${safety.reason}.`, "WORKTREE_UNSAFE_CONFIG", { remediation: "Remove the filter driver from the repository config, or create the worktree yourself with git." });
  throwIfAborted(options);

  const parent = path.dirname(fresh.path);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (f(realpath(parent, fs)) !== f(parent)) throw fail("The worktree parent directory changed while it was being created (symlink?); nothing was created.", "WORKTREE_PATH_UNSAFE");
    fs.mkdirSync(fresh.path, { mode: 0o700 }); // atomic claim: EEXIST for the loser of a race
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (error?.code === "EEXIST") throw fail(`The path ${shown(fresh.path, 200)} was just created by someone else.`, "WORKTREE_PATH_EXISTS");
    throw fail(`Cannot create the worktree directory: ${error?.code ?? "error"}.`, "WORKTREE_CREATE_FAILED");
  }
  const release = () => {
    try {
      fs.rmdirSync(fresh.path); // only succeeds while empty: never removes content
    } catch {
      // Leave anything that is not an empty directory alone.
    }
  };
  if (options.signal?.aborted) {
    release();
    throwIfAborted(options);
  }
  // Two steps so the safety check runs in the context the checkout will run in: conditional includes (onbranch:,
  // gitdir:) only become active inside the NEW worktree. 1) register it without checking anything out.
  let added;
  try {
    added = await git(options, ctx.workspace, ["worktree", "add", "--no-checkout", "-b", fresh.branch, fresh.path, fresh.base.commit]);
  } catch (error) {
    release();
    throw error;
  }
  if (added.code !== 0) {
    release();
    const exists = /already exists|already checked out|is not a valid/i.test(added.stderr);
    throw fail(`git worktree add failed: ${firstLine(added.stderr) || `exit ${added.code}`}`, exists ? "WORKTREE_BRANCH_EXISTS" : "WORKTREE_CREATE_FAILED");
  }

  const created = await listWithContext(ctx);
  const entry = created.entries.find((item) => f(item.path) === f(realpath(fresh.path, fs)));
  const admin = entry ? adminDirOf(ctx, entry.path, false) : null;
  if (!entry || admin === null) {
    throw fail("The worktree was created but could not be registered with Asterweave (its git directory was not found).", "WORKTREE_MARKER_FAILED", { remediation: suggestCommand("Inspect it with: git -C ", fresh.root, " worktree list") });
  }
  // 2) scan the effective config from inside the new worktree; refuse and roll back (it is empty and ours) if unsafe.
  const inner = await filterDriverCheck(options, entry.path);
  if (!inner.safe) {
    const rolledBack = await rollbackUnpopulated(ctx, entry.path, fresh, options);
    throw fail(`Refusing to create a worktree: ${inner.reason}. ${rolledBack ? "The empty worktree and its new branch were removed." : "The empty worktree could not be removed automatically."}`, "WORKTREE_UNSAFE_CONFIG", {
      remediation: rolledBack ? "Remove the filter driver or include from the repository config, or create the worktree yourself with git." : suggestCommand("Inspect it with: git -C ", fresh.root, " worktree list"),
    });
  }
  // The marker goes in BEFORE the checkout so a half-populated worktree is still recognised as ours (and removal then
  // refuses it as dirty instead of silently deleting it).
  const marker = { schemaVersion: WORKTREE_MARKER_VERSION, createdBy: "asterweave", name: fresh.name, branch: fresh.branch, base: fresh.base, path: entry.path, repoKey: ctx.key, createdAt: nowOf(options), id: randomBytes(6).toString("hex") };
  try {
    writeJsonAtomic(path.join(admin, WORKTREE_MARKER_FILE), marker, { fs });
  } catch {
    await rollbackUnpopulated(ctx, entry.path, fresh, options);
    throw fail("The worktree could not be registered with Asterweave (the marker could not be written); it was not populated.", "WORKTREE_MARKER_FAILED");
  }
  // 3) populate with the same hardening, cwd = the new worktree.
  const populated = await git(options, entry.path, ["-c", "submodule.recurse=false", "reset", "--hard", "--quiet", "--no-recurse-submodules", fresh.base.commit]);
  if (populated.code !== 0) {
    const rolledBack = await rollbackUnpopulated(ctx, entry.path, fresh, options);
    throw fail(`Populating the worktree failed: ${firstLine(populated.stderr) || `exit ${populated.code}`}${rolledBack ? " The empty worktree was removed." : ""}`, "WORKTREE_CREATE_FAILED", {
      remediation: rolledBack ? undefined : suggestCommand("Inspect it with: git -C ", entry.path, " status"),
    });
  }
  return { ok: true, name: fresh.name, path: entry.path, branch: fresh.branch, base: fresh.base, head: entry.head, repoKey: ctx.key, created: true };
}

/**
 * Undo `worktree add --no-checkout` for a worktree THIS call just created, only while its directory holds nothing but
 * the `.git` file. This is the single use of `worktree remove --force`: a no-checkout worktree has an empty index, so a
 * plain remove would see every file as deleted. The new branch is deleted with `update-ref -d` guarded by the commit it
 * was created at, and only because it was just created. Returns whether everything was undone.
 */
async function rollbackUnpopulated(ctx, worktreePath, fresh, options) {
  try {
    const names = fsOf(options).readdirSync(worktreePath);
    if (names.length !== 1 || names[0] !== ".git") return false;
    const removed = await git(options, ctx.workspace, ["worktree", "remove", "--force", worktreePath]);
    if (removed.code !== 0) return false;
    await git(options, ctx.workspace, ["update-ref", "-d", `refs/heads/${fresh.branch}`, fresh.base.commit]);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Inspect

async function aheadBehind(ctx, entry, marker) {
  const cwd = entry.path;
  const upstream = await git(ctx.options, cwd, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream.code === 0 && upstream.stdout.trim()) {
    const counts = await git(ctx.options, cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    if (counts.code === 0 && Number.isInteger(ahead) && Number.isInteger(behind)) return { ahead, behind, against: "upstream" };
  }
  if (marker) {
    const count = await git(ctx.options, cwd, ["rev-list", "--count", `${marker.base.commit}..HEAD`]);
    const ahead = Number(count.stdout.trim());
    if (count.code === 0 && Number.isInteger(ahead)) return { ahead, behind: null, against: "base" };
  }
  return { ahead: null, behind: null, against: null };
}

/**
 * State of one worktree. `dirty` is true/false only when the status could be computed safely, else "unknown" with
 * `dirtyReason`. `ahead` counts commits not on the upstream (or, without one, not on the recorded base).
 * @param {string} worktreePath
 * @param {WorktreeOptions & {root?: string}} [options]  `root` is any directory of the same repository (default: the path itself).
 * @returns {Promise<{exists: boolean, registered: boolean, path: string, main: boolean, asterweave: boolean, name: string|null,
 *   branch: string|null, head: string|null, dirty: boolean|'unknown', dirtyReason: string|null, ahead: number|null,
 *   behind: number|null, against: string|null, locked: false|string, prunable: boolean, detachedUnreachable: boolean|null}>}
 */
export async function inspectWorktree(worktreePath, { root, ...options } = {}) {
  const fs = fsOf(options);
  const target = realpath(path.resolve(String(worktreePath)), fs);
  const isDirectory = (() => {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  })();
  const empty = { exists: isDirectory, registered: false, path: target, main: false, asterweave: false, name: null, branch: null, head: null, dirty: "unknown", dirtyReason: "not a registered worktree", ahead: null, behind: null, against: null, locked: false, prunable: false, detachedUnreachable: null };
  if (root === undefined && !isDirectory) return empty;
  const ctx = await resolveWorktreeContext(root ?? target, options);
  const listing = await listWithContext(ctx);
  const f = fold(ctx.platform);
  const entry = listing.entries.find((item) => f(item.path) === f(target));
  if (!entry) return empty;
  const base = { ...empty, registered: true, exists: entry.exists, main: entry.main, asterweave: entry.asterweave, name: entry.name, branch: entry.branch, head: entry.head, locked: entry.locked, prunable: entry.prunable };
  if (!entry.exists) return { ...base, dirtyReason: "the directory is missing" };
  const marker = listing.markers.get(entry.path) ?? null;
  const counts = await aheadBehind(ctx, entry, marker);
  let detachedUnreachable = null;
  if (entry.detached) {
    const containing = await git(options, entry.path, ["for-each-ref", "--contains", "HEAD", "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"]);
    detachedUnreachable = containing.code === 0 ? containing.stdout.trim() === "" : null;
  }
  const safety = await filterDriverCheck(options, entry.path);
  if (!safety.safe) return { ...base, ...counts, dirty: "unknown", dirtyReason: safety.reason, detachedUnreachable };
  const status = await git(options, entry.path, ["status", "--porcelain=v1", "-z", "--no-renames", "--ignore-submodules=all", "--untracked-files=normal"]);
  if (status.code !== 0) return { ...base, ...counts, dirty: "unknown", dirtyReason: "git status failed", detachedUnreachable };
  return { ...base, ...counts, dirty: status.stdout !== "", dirtyReason: null, detachedUnreachable };
}

// ---------------------------------------------------------------------------------------------
// Remove

const REMOVING_FILE = "asterweave-removing";
const CLAIM_STALE_MS = 120_000;

/** Exclusive claim file; a claim older than CLAIM_STALE_MS (crashed remover) is replaced. */
function claimRemoval(claim, fs, options) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(claim, `pid=${process.pid} at=${nowOf(options)}`, { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "EPERM" && error?.code !== "EBUSY") return false;
      try {
        if (Date.now() - fs.lstatSync(claim).mtimeMs <= CLAIM_STALE_MS) return false;
        fs.unlinkSync(claim);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * What `removeWorktree` would do, with every reason it would refuse. Changes nothing.
 * @param {string} worktreePath
 * @param {WorktreeOptions & {root?: string, keepBranch?: boolean}} [options]
 * @returns {Promise<{ok: boolean, path: string, branch: string|null, problems: Array<{code: string, message: string}>,
 *   wouldRun: string[]|null, state: Awaited<ReturnType<typeof inspectWorktree>>}>}
 */
export async function previewRemoval(worktreePath, { keepBranch = false, ...options } = {}) {
  const state = await inspectWorktree(worktreePath, options);
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (!state.registered) add("NOT_REGISTERED", "This path is not a registered worktree of the repository.");
  else {
    if (state.main) add("MAIN_WORKTREE", "This is the main work tree; it is never removed.");
    else if (!state.asterweave) add("NOT_ASTERWEAVE", "This worktree was not created by Asterweave; remove it with git yourself.");
    if (state.locked !== false) add("LOCKED", `The worktree is locked${typeof state.locked === "string" ? ` (${state.locked})` : ""}; unlock it with git first.`);
    if (!state.exists) add("MISSING", "The directory is missing; use `git worktree prune` yourself.");
    else if (state.dirty === true) add("DIRTY", "The worktree has uncommitted or untracked changes.");
    else if (state.dirty === "unknown") add("DIRTY_UNKNOWN", `Whether the worktree has changes cannot be determined safely (${state.dirtyReason}).`);
    if (state.exists) {
      if (!keepBranch && typeof state.ahead === "number" && state.ahead > 0) add("UNPUSHED", `The branch has ${state.ahead} commit(s) not on ${state.against === "upstream" ? "its upstream" : "the base it was created from"}. They stay on the branch (it is never deleted); pass keepBranch to acknowledge that.`);
      if (state.detachedUnreachable === true) add("DETACHED_COMMITS", "HEAD is detached at a commit no branch or tag contains; removing the worktree would lose it.");
    }
  }
  const ok = problems.length === 0;
  return { ok, path: state.path, branch: state.branch, problems, wouldRun: ok ? ["git", "worktree", "remove", state.path] : null, state };
}

/**
 * Remove one worktree created by Asterweave. Refuses (CliError WORKTREE_REMOVE_REFUSED, exit 1) on anything in
 * `previewRemoval().problems`. Never passes --force, never deletes a branch. `dryRun: true` only previews.
 * Aborting through `signal` before the git call leaves everything in place.
 * @param {string} worktreePath
 * @param {WorktreeOptions & {root?: string, keepBranch?: boolean, dryRun?: boolean}} [options]
 */
export async function removeWorktree(worktreePath, { dryRun = false, ...options } = {}) {
  const preview = await previewRemoval(worktreePath, options);
  if (dryRun) return { dryRun: true, removed: false, ...preview };
  if (!preview.ok) {
    const error = fail(`Refusing to remove the worktree: ${preview.problems.map((problem) => problem.message).join(" ")}`, "WORKTREE_REMOVE_REFUSED", { remediation: "Nothing was removed. Commit or discard the changes yourself, then retry." });
    error.problems = preview.problems.map((problem) => problem.code);
    throw error;
  }
  throwIfAborted(options);
  const ctx = await resolveWorktreeContext(options.root ?? preview.path, options);
  const mainPath = (await listWithContext(ctx)).main?.path ?? ctx.workspace;
  // Claim the removal: of two concurrent removals of one worktree only one proceeds. The claim file lives in git admin
  // directory, which `git worktree remove` deletes together with the worktree.
  const fs = fsOf(options);
  const admin = adminDirOf(ctx, preview.path, false);
  const claim = admin === null ? null : path.join(admin, REMOVING_FILE);
  if (claim === null) throw fail("The worktree git directory was not found.", "WORKTREE_REMOVE_FAILED");
  if (!claimRemoval(claim, fs, options)) throw fail("The worktree is already being removed by another process.", "WORKTREE_REMOVE_FAILED", { remediation: "Wait for it to finish, then run worktree list." });
  let result;
  try {
    const again = await previewRemoval(preview.path, options);
    if (!again.ok) throw Object.assign(fail(`Refusing to remove the worktree: ${again.problems.map((problem) => problem.message).join(" ")}`, "WORKTREE_REMOVE_REFUSED"), { problems: again.problems.map((problem) => problem.code) });
    throwIfAborted(options);
    result = await git(options, mainPath, ["worktree", "remove", preview.path]);
  } catch (error) {
    try {
      fs.unlinkSync(claim);
    } catch {
      // Already gone together with the worktree, or never created.
    }
    throw error;
  }
  if (result.code !== 0) {
    try {
      fs.unlinkSync(claim);
    } catch {
      // Best effort.
    }
    throw fail(`git worktree remove refused: ${firstLine(result.stderr) || `exit ${result.code}`}`, "WORKTREE_REMOVE_FAILED", { remediation: "Nothing was forced; resolve the reason above and retry." });
  }
  return { dryRun: false, removed: true, path: preview.path, branch: preview.branch, branchKept: true, problems: [] };
}
