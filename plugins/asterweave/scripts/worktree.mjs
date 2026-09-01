#!/usr/bin/env node

// Read-only inspection and safe cleanup of Git worktrees created for
// `/asterweave:complete-project` module workers. Worker worktrees are created by the Agent
// tool's `isolation: "worktree"` option (harness-managed), not by this script; this script gives
// the parent orchestrator visibility into them for resume ("reuse existing worktrees when safely
// resumable") and a safe removal path for post-integration cleanup (Phase 23/27). It never
// creates a worktree and never removes one that still has uncommitted changes unless --force is
// passed explicitly.

import { spawnSync } from "node:child_process";

function git(args, cwd = process.cwd()) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout;
}

/** Parses `git worktree list --porcelain` into structured records. */
export function listWorktrees(cwd = process.cwd()) {
  const output = git(["worktree", "list", "--porcelain"], cwd);
  const entries = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), head: null, branch: null, bare: false, locked: false, prunable: false };
      entries.push(current);
    } else if (!current) {
      continue;
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line.startsWith("locked")) {
      current.locked = true;
    } else if (line.startsWith("prunable")) {
      current.prunable = true;
    }
  }
  return entries;
}

/** True when a worktree at `path` still exists and matches Git's own worktree list. Used to
 * detect a worker's recorded worktree going stale (deleted outside Asterweave) before resuming. */
export function worktreeExists(path, cwd = process.cwd()) {
  return listWorktrees(cwd).some((entry) => resolveSame(entry.path, path));
}

function resolveSame(a, b) {
  return a.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === b.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** Refuses to remove a worktree with uncommitted changes unless `force` is set — the same
 * preserve-user-work discipline as the rest of Asterweave's Git safety policy. */
export function removeWorktree(path, { force = false, cwd = process.cwd() } = {}) {
  if (!worktreeExists(path, cwd)) throw new Error(`No worktree at '${path}'.`);
  if (!force) {
    const status = spawnSync("git", ["-C", path, "status", "--porcelain"], { encoding: "utf8" });
    if (status.status !== 0) throw new Error(`Unable to check status of worktree '${path}': ${status.stderr?.trim()}`);
    if (status.stdout.trim()) {
      throw new Error(`Worktree '${path}' has uncommitted changes; commit/push it or pass --force to discard.`);
    }
  }
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  git(args, cwd);
  return { removed: path };
}

function parseOptions(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = value;
      index += 1;
    }
  }
  return { positional, options };
}

function usage() {
  console.error(`Usage:
  worktree.mjs list
  worktree.mjs remove <path> [--force]`);
}

export function runCli(argv = process.argv.slice(2), cwd = process.cwd()) {
  const [command, ...rest] = argv;
  const { positional, options } = parseOptions(rest);
  let result;
  switch (command) {
    case "list":
      result = listWorktrees(cwd);
      break;
    case "remove":
      result = removeWorktree(positional[0], { force: Boolean(options.force), cwd });
      break;
    default:
      usage();
      return 2;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(`Asterweave worktree error: ${error.message}`);
    process.exitCode = 1;
  }
}
