// Bounded, read-only facts about a workspace for checkpoints and resume validation: branch, HEAD, a fingerprint of the changed
// files, and a worktree identity. Never reads the repository's content: only `git rev-parse`, `git symbolic-ref` and
// `git status --porcelain=v1 -z` (output capped). Runs with the hardened git flags of commands/run.mjs (no pager, no optional
// locks, no fsmonitor, no hooks). Anything that cannot be determined is `null` and the probe says it is not verifiable; a caller
// must then treat a stored claim as UNVERIFIED, never as still true.

import { createHash } from "node:crypto";
import { runBinary } from "../../proc.mjs";
import { gitEnv } from "../../repo.mjs";

export const PORCELAIN_MAX_BYTES = 256 * 1024;
const PROBE_TIMEOUT_MS = 10_000;

function gitFlags(platform) {
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand="];
}

/** The default git runner: resolves to stdout, or null on any failure / truncation. */
function defaultGit(options) {
  const platform = options.platform ?? process.platform;
  return async (cwd, args, { maxOutputBytes } = {}) => {
    const result = await runBinary("git", [...gitFlags(platform), ...args], {
      cwd, env: gitEnv(options.env ?? process.env), spawn: options.spawn, exists: options.exists, platform, timeoutMs: options.timeoutMs ?? PROBE_TIMEOUT_MS,
      ...(maxOutputBytes ? { maxOutputBytes } : {}),
    });
    if (result.error || result.code !== 0 || result.truncated) return null;
    return result.stdout;
  };
}

const sha = (text) => createHash("sha256").update(text).digest("hex");

/** Worktree identity: a hash of the work tree root (case-folded on win32). Content-free and stable for one checkout. */
export function worktreeIdOf(root, platform = process.platform) {
  if (typeof root !== "string" || root === "") return null;
  const folded = platform === "win32" ? root.replace(/\\/g, "/").toLowerCase() : root;
  return `wt_${sha(`worktree:${folded}`).slice(0, 16)}`;
}

/**
 * @param {string} cwd  the work tree root
 * @param {{env?: object, spawn?: Function, exists?: Function, platform?: string, timeoutMs?: number,
 *   git?: (cwd: string, args: string[], opts?: {maxOutputBytes?: number}) => Promise<string|null>}} [options]
 * @returns {Promise<{verifiable: boolean, branch: string|null, head: string|null, fingerprint: string|null, worktreeId: string|null, dirtyCount: number|null}>}
 */
export async function probeWorkspace(cwd, options = {}) {
  const git = options.git ?? defaultGit(options);
  const platform = options.platform ?? process.platform;
  let head = null;
  let branch = null;
  let porcelain = null;
  try {
    head = (await git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]))?.trim() || null;
    branch = (await git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]))?.trim() || null;
    porcelain = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], { maxOutputBytes: PORCELAIN_MAX_BYTES });
  } catch {
    porcelain = null;
  }
  const verifiable = head !== null && porcelain !== null;
  const fingerprint = verifiable ? `fp1:${sha(`${head}\u0000${porcelain}`).slice(0, 32)}` : null;
  const dirtyCount = porcelain === null ? null : porcelain.split("\u0000").filter((entry) => entry.length > 3).length;
  return { verifiable, branch, head, fingerprint, worktreeId: worktreeIdOf(cwd, platform), dirtyCount };
}
