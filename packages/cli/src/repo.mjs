// Repository connection: list GitHub repositories (gh), inspect an EXISTING local clone (git, read
// only), and persist the connection as repo.json in the user directory.
//
// Safety rules: no shell and argument arrays only (via proc.mjs); never clone, fetch, check out,
// switch branches, or clean anything.
//
// The clone is UNTRUSTED input. What is actually guaranteed:
//   - Only git commands that read refs, config and the object-less repository layout run here
//     (`rev-parse`, `branch`, `symbolic-ref`, `remote get-url`). No command that hashes work-tree
//     content (`status`, `diff`, `add`, `update-index`, `ls-files -m`, `stash`) is run anywhere in
//     this package, because those execute `filter.<name>.clean/process` drivers configured in the
//     clone's .git/config. For the same reason the work-tree state is reported as `dirty: null`
//     (unknown), never computed.
//   - git gets a minimal environment (see gitEnv): no inherited tokens, no GIT_* variables, no prompts.
//   - Defence in depth: fsmonitor and hooks are disabled, `ext::` transports are refused, no pager.
//     These are NOT what makes the above safe; not running content-hashing commands is.
// Remote URLs may embed credentials: they are parsed and sanitised here and the raw value is never
// returned, logged, thrown, or stored.

import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "./exit-codes.mjs";
import { resolveUserDir, userFilePath } from "./paths.mjs";
import { runBinary } from "./proc.mjs";
import { redactText, sanitizeForTerminal, suggestCommand } from "./redact.mjs";
import { readJson, StoreError, writeJsonAtomic } from "./store.mjs";
import { safeTrustStatus } from "./trust.mjs";

const OWNER = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const NAME = /^[A-Za-z0-9._-]+$/;
const GITHUB_HOSTS = new Set(["github.com", "www.github.com", "ssh.github.com"]);
const SCHEMES = new Set(["https", "http", "ssh", "git", "git+ssh", "ssh+git"]);

/**
 * @typedef {object} RepoOptions
 * @property {Record<string,string|undefined>} [env]
 * @property {Function} [spawn]      child_process.spawn-compatible (injectable).
 * @property {(file: string) => boolean} [exists]  Executable existence check for PATH lookup (tests).
 * @property {string} [platform]
 * @property {() => string} [homedir]
 * @property {() => string} [now]    ISO timestamp provider (tests).
 * @property {typeof nodeFs} [fs]
 * @property {number} [timeoutMs]
 */

// ---------------------------------------------------------------------------------------------
// Remote URL handling

/**
 * Parse a GitHub remote URL (https, http, ssh://, git://, scp-like `git@github.com:o/n`), with or
 * without `.git`. The host compare is case-insensitive. Embedded credentials are ignored (never
 * returned). Returns null for anything that is not a recognisable github.com repository.
 * @param {unknown} url
 * @returns {{host: string, owner: string, name: string, nameWithOwner: string} | null}
 */
export function parseGithubRemote(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  if (!text || /\s/.test(text)) return null;
  let host;
  let pathname;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (scheme) {
    if (!SCHEMES.has(scheme[1].toLowerCase())) return null;
    const slash = scheme[2].indexOf("/");
    if (slash < 0) return null;
    const authority = scheme[2].slice(0, slash);
    pathname = scheme[2].slice(slash + 1);
    host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
  } else {
    // Hosts of 2+ characters, so a Windows drive path such as `C:\work` is never read as scp-like.
    const scp = /^(?:[^@:/\\]+@)?([^@:/\\]{2,}):(?![/\\])(.+)$/.exec(text);
    if (!scp) return null;
    [, host, pathname] = scp;
  }
  host = host.toLowerCase();
  if (!GITHUB_HOSTS.has(host)) return null;
  const segments = pathname.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\.git$/i, "").split("/");
  if (segments.length !== 2) return null;
  const [owner, name] = segments;
  if (!OWNER.test(owner) || !NAME.test(name) || name === "." || name === "..") return null;
  return { host, owner, name, nameWithOwner: `${owner}/${name}` };
}

/** Remove credentials (userinfo) and query/fragment from a remote URL so it is safe to print. */
export function sanitizeRemoteUrl(url) {
  const text = String(url ?? "").trim();
  const scheme = /^([a-z][a-z0-9+.-]*:\/\/)([^/]*)(.*)$/i.exec(text);
  if (scheme) {
    const authority = scheme[2].slice(scheme[2].lastIndexOf("@") + 1);
    return `${scheme[1]}${authority}${scheme[3].replace(/[?#].*$/, "")}`;
  }
  const scp = /^(?:[^@:/\\]+@)?([^@:/\\]{2,}:(?![/\\]).+)$/.exec(text);
  return scp ? scp[1] : "<unrecognized remote>";
}

// ---------------------------------------------------------------------------------------------
// Process helpers

/** Variables git needs to find itself, the user's global config and a temp dir. Matched case-insensitively. */
const GIT_ENV_ALLOW = new Set(["path", "home", "userprofile", "homedrive", "homepath", "systemroot", "windir", "temp", "tmp", "tmpdir", "lang", "xdg_config_home"]);

/**
 * Minimal environment for git: an allow-list, never the parent environment. Secrets (GH_TOKEN,
 * GITHUB_TOKEN, ANTHROPIC_*, *_KEY, ...) and every inherited GIT_* variable (GIT_DIR, GIT_SSH_COMMAND,
 * GIT_EXTERNAL_DIFF, ...) are dropped by construction.
 */
export function gitEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (typeof value === "string" && GIT_ENV_ALLOW.has(key.toLowerCase())) out[key] = value;
  }
  return { ...out, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
}

/** Variables that would redirect `gh` to another host or repository (matched case-insensitively). */
const GH_ENV_DROP = new Set(["gh_host", "gh_repo", "gh_enterprise_token", "github_enterprise_token"]);

/**
 * Environment for `gh repo list`: the parent environment (gh needs PATH, HOME/APPDATA, proxies, and may rely
 * on GH_TOKEN / GITHUB_TOKEN / GH_CONFIG_DIR) minus the variables that redirect it, with the host pinned to
 * github.com: GH_HOST or GH_REPO in the parent shell must not point the listing at another instance.
 */
export function ghEnv(env) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? process.env)) {
    if (typeof value === "string" && !GH_ENV_DROP.has(key.toLowerCase())) out[key] = value;
  }
  return { ...out, GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
}

/** Flags prepended to every git call (see the header comment for what they do and do not guarantee). */
function gitPrefix(platform) {
  return [
    "--no-pager",
    "--no-optional-locks",
    "-c", "core.fsmonitor=false",
    "-c", `core.hooksPath=${(platform ?? process.platform) === "win32" ? "NUL" : "/dev/null"}`,
    "-c", "protocol.ext.allow=never",
    "-c", "core.sshCommand=",
  ];
}

function binaryMissing(result) {
  return ["NOT_FOUND", "SHELL_SHIM_ONLY", "ENOENT"].includes(result.error?.code);
}

async function git(args, cwd, options) {
  const result = await runBinary("git", [...gitPrefix(options.platform), ...args], {
    cwd,
    env: gitEnv(options.env),
    spawn: options.spawn,
    exists: options.exists,
    platform: options.platform,
    timeoutMs: options.timeoutMs,
  });
  if (binaryMissing(result)) {
    throw new CliError("git was not found.", { code: "GIT_NOT_INSTALLED", exitCode: EXIT.ERROR, remediation: "Install git (https://git-scm.com/) and make sure it is on PATH." });
  }
  if (result.error) {
    throw new CliError(`git ${args[0]} failed: ${result.error.code === "ETIMEDOUT" ? "timed out" : "could not run"}.`, { code: "GIT_FAILED", exitCode: EXIT.ERROR });
  }
  return result;
}

// git/gh stderr is outside our control: redact secrets and neutralise terminal control sequences.
const firstLine = (text) => sanitizeForTerminal(redactText(String(text ?? "").trim().split(/\r?\n/)[0] ?? "").text).slice(0, 200);

function userDir(options) {
  return resolveUserDir({ env: options.env ?? process.env, platform: options.platform, homedir: options.homedir });
}

/** Absolute path of repo.json. */
export function repoFilePath(options = {}) {
  return userFilePath("repo", { env: options.env ?? process.env, platform: options.platform, homedir: options.homedir });
}

// ---------------------------------------------------------------------------------------------
// gh: repository list

function mapGhFailure(result) {
  if (result.error && binaryMissing(result)) {
    const shim = result.error.code === "SHELL_SHIM_ONLY";
    return new CliError(shim ? "GitHub CLI (gh) is only available as a shell shim." : "GitHub CLI (gh) is not installed.", {
      code: shim ? "GH_SHELL_SHIM_ONLY" : "GH_NOT_INSTALLED",
      exitCode: EXIT.ERROR,
      remediation: shim ? "Install the native gh build; a .cmd shim cannot be run without a shell." : "Install GitHub CLI from https://cli.github.com/ and run `gh auth login --web -h github.com`.",
    });
  }
  if (result.error) {
    return new CliError(`gh could not list repositories (${result.error.code === "ETIMEDOUT" ? "timed out" : "could not run"}).`, { code: "GH_REPO_LIST_FAILED", exitCode: EXIT.ERROR, remediation: "Retry, or pass --repo owner/name." });
  }
  if (/auth|log ?in|token|credential|\b401\b|not logged/i.test(result.stderr ?? "")) {
    return new CliError("GitHub CLI is not authenticated.", { code: "GH_NOT_AUTHENTICATED", exitCode: EXIT.AUTH, remediation: "Run: gh auth login --web -h github.com" });
  }
  return new CliError(`gh repo list failed (exit ${result.code}): ${firstLine(result.stderr) || "no error output"}`, { code: "GH_REPO_LIST_FAILED", exitCode: EXIT.ERROR, remediation: "Run `gh auth status`, or pass --repo owner/name." });
}

/**
 * List the signed-in user's repositories via `gh repo list`.
 * @param {RepoOptions & {limit?: number}} [options]
 * @returns {Promise<Array<{nameWithOwner: string, defaultBranch: string|null}>>}
 */
export async function listRepositories(options = {}) {
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 1000) : 100;
  const cwd = userDir(options);
  try {
    (options.fs ?? nodeFs).mkdirSync(cwd, { recursive: true });
  } catch {
    // A missing cwd would look like a missing binary; the run below reports whatever happens.
  }
  const result = await runBinary("gh", ["repo", "list", "--json", "nameWithOwner,defaultBranchRef", "--limit", String(limit)], {
    cwd,
    env: ghEnv(options.env),
    spawn: options.spawn,
    exists: options.exists,
    platform: options.platform,
    timeoutMs: options.timeoutMs,
  });
  if (result.error || result.code !== 0) throw mapGhFailure(result);
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CliError("gh returned output that is not valid JSON.", { code: "GH_OUTPUT_UNPARSEABLE", exitCode: EXIT.ERROR, remediation: "Upgrade GitHub CLI, or pass --repo owner/name." });
  }
  if (!Array.isArray(parsed)) throw new CliError("gh returned an unexpected repository list shape.", { code: "GH_OUTPUT_UNPARSEABLE", exitCode: EXIT.ERROR, remediation: "Upgrade GitHub CLI, or pass --repo owner/name." });
  return parsed
    .filter((item) => item && typeof item.nameWithOwner === "string" && isRepositoryName(item.nameWithOwner))
    .map((item) => ({ nameWithOwner: item.nameWithOwner, defaultBranch: typeof item.defaultBranchRef?.name === "string" ? item.defaultBranchRef.name : null }));
}

/** True for a well-formed `owner/name`. */
export function isRepositoryName(value) {
  if (typeof value !== "string") return false;
  const parts = value.split("/");
  return parts.length === 2 && OWNER.test(parts[0]) && NAME.test(parts[1]) && parts[1] !== "." && parts[1] !== "..";
}

// ---------------------------------------------------------------------------------------------
// git: read-only inspection

/**
 * Local and `origin/` branches of a clone, de-duplicated (`origin/x` and `x` collapse to `x`),
 * `origin/HEAD` dropped, default branch first. Read only.
 * @param {string} repoPath
 * @param {RepoOptions & {defaultBranch?: string|null}} [options]
 * @returns {Promise<string[]>}
 */
export async function listBranches(repoPath, options = {}) {
  const result = await git(["branch", "-a", "--format=%(refname:short)"], repoPath, options);
  if (result.code !== 0) {
    throw new CliError(`Could not list branches in ${repoPath}: ${firstLine(result.stderr) || `git exit ${result.code}`}`, { code: "REPO_BRANCHES_FAILED", exitCode: EXIT.ERROR });
  }
  const seen = new Set();
  for (const raw of result.stdout.split(/\r?\n/)) {
    const name = raw.trim();
    if (!name || name.startsWith("(") || name === "HEAD" || name === "origin" || name === "origin/HEAD") continue;
    seen.add(name.startsWith("origin/") ? name.slice("origin/".length) : name);
  }
  let preferred = options.defaultBranch ?? null;
  if (!preferred) {
    const head = await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], repoPath, options);
    if (head.code === 0 && head.stdout.trim().startsWith("origin/")) preferred = head.stdout.trim().slice("origin/".length);
  }
  if (!preferred || !seen.has(preferred)) preferred = ["main", "master"].find((candidate) => seen.has(candidate)) ?? null;
  const rest = [...seen].filter((name) => name !== preferred);
  return preferred ? [preferred, ...rest] : rest;
}

/**
 * The `origin` remote of a clone. Returns null when there is no origin. `url` is credential-free
 * and safe to print; `github` is the parsed repository, or null when origin is not on github.com.
 * @returns {Promise<{url: string, github: ReturnType<typeof parseGithubRemote>} | null>}
 */
export async function readOrigin(repoPath, options = {}) {
  const result = await git(["remote", "get-url", "origin"], repoPath, options);
  const raw = result.stdout.trim();
  if (result.code !== 0 || !raw) return null;
  return { url: sanitizeRemoteUrl(raw), github: parseGithubRemote(raw) };
}

/**
 * Origin of the clone at `inputPath`, resolved from its work-tree root. Never throws: a path that is
 * missing, not a work tree, has no origin, or where git cannot run yields null (callers then fall
 * back to listing repositories).
 * @returns {Promise<{root: string, origin: NonNullable<Awaited<ReturnType<typeof readOrigin>>>} | null>}
 */
export async function resolveCloneOrigin(inputPath, options = {}) {
  try {
    const root = await resolveWorkTree(inputPath, options);
    const origin = await readOrigin(root, options);
    return origin ? { root, origin } : null;
  } catch {
    return null;
  }
}

async function currentBranchOf(repoPath, options) {
  const result = await git(["rev-parse", "--abbrev-ref", "HEAD"], repoPath, options);
  const name = result.stdout.trim();
  return result.code === 0 && name && name !== "HEAD" ? name : null;
}

function realpathOf(target, fs) {
  return (fs.realpathSync.native ?? fs.realpathSync)(path.resolve(target));
}

/** Resolve an existing clone's work-tree root. Throws CliError when it is not a work tree. */
async function resolveWorkTree(inputPath, options) {
  const fs = options.fs ?? nodeFs;
  let real;
  try {
    real = realpathOf(inputPath, fs);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new CliError(`Repository path does not exist or is not a directory: ${inputPath}`, { code: "REPO_PATH_INVALID", exitCode: EXIT.ERROR, remediation: "Pass an existing local clone with --path." });
  }
  const result = await git(["rev-parse", "--is-inside-work-tree", "--show-toplevel"], real, options);
  const [flag, top] = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (result.code !== 0 || flag !== "true" || !top) {
    const unsafe = /dubious ownership/i.test(result.stderr);
    throw new CliError(`${real} is not a git work tree${unsafe ? " that git considers safe" : ""}.`, {
      code: "REPO_NOT_GIT",
      exitCode: EXIT.ERROR,
      remediation: unsafe ? suggestCommand("Review the directory, then run: git config --global --add safe.directory ", real) : "Pass an existing local clone with --path (Asterweave never clones).",
    });
  }
  try {
    return realpathOf(top, fs);
  } catch {
    return real;
  }
}

// ---------------------------------------------------------------------------------------------
// Connection record

/** @returns {{repository: string, branch: string, path: string, runner: 'local', connectedAt: string} | null} */
function readRecord(options) {
  const file = repoFilePath(options);
  const record = readJson(file, { fallback: null, fs: options.fs });
  if (record === null) return null;
  if (!record || typeof record !== "object" || Array.isArray(record) || !isRepositoryName(record.repository) || typeof record.branch !== "string" || !record.branch || typeof record.path !== "string" || !record.path) {
    throw new CliError(`${file} does not contain a valid repository connection.`, { code: "REPO_RECORD_INVALID", exitCode: EXIT.ERROR, remediation: "Run `asterweave repo connect` again." });
  }
  return { repository: record.repository, branch: record.branch, path: record.path, runner: "local", connectedAt: typeof record.connectedAt === "string" ? record.connectedAt : null };
}

/**
 * Connect an existing local clone to a repository and persist repo.json. Reads only: never clones,
 * fetches, checks out or modifies the clone, and never cleans a dirty work tree.
 *
 * @param {RepoOptions & {repository: string, branch: string, path: string}} input
 * @returns {Promise<{ok: true, repository: string, branch: string, path: string, runner: 'local', connectedAt: string, dirty: null}>}
 *   `dirty` is always `null` (unknown): the work tree is never hashed.
 */
export async function connectRepository({ repository, branch, path: repoPath, ...options } = {}) {
  if (!isRepositoryName(repository)) {
    throw new CliError(`'${repository}' is not a repository in owner/name form.`, { code: "REPO_INVALID", exitCode: EXIT.USAGE, remediation: "Pass --repo owner/name." });
  }
  if (typeof branch !== "string" || !branch.trim() || branch.startsWith("-") || /[\s\x00-\x1f]/.test(branch)) {
    throw new CliError(`'${branch}' is not a valid branch name.`, { code: "REPO_BRANCH_INVALID", exitCode: EXIT.USAGE, remediation: "Pass --branch with an existing branch name." });
  }
  if (typeof repoPath !== "string" || !repoPath) {
    throw new CliError("A repository path is required.", { code: "REPO_PATH_INVALID", exitCode: EXIT.USAGE, remediation: "Pass --path to an existing local clone." });
  }

  const root = await resolveWorkTree(repoPath, options);

  const origin = await readOrigin(root, options);
  if (!origin) {
    throw new CliError(`${root} has no 'origin' remote.`, { code: "REPO_NO_ORIGIN", exitCode: EXIT.ERROR, remediation: suggestCommand("Add one with: git -C ", root, ` remote add origin https://github.com/${repository}.git`) });
  }
  if (!origin.github || origin.github.nameWithOwner.toLowerCase() !== repository.toLowerCase()) {
    throw new CliError(`The 'origin' remote of ${root} is ${origin.github ? origin.github.nameWithOwner : origin.url}, not ${repository}.`, {
      code: "REPO_ORIGIN_MISMATCH",
      exitCode: EXIT.ERROR,
      remediation: `Pass the clone of ${repository} with --path, or choose the repository that matches this clone.`,
    });
  }

  const branches = await listBranches(root, options);
  if (!branches.includes(branch)) {
    throw new CliError(`Branch '${branch}' was not found locally or on origin in ${root}.`, {
      code: "REPO_BRANCH_NOT_FOUND",
      exitCode: EXIT.ERROR,
      remediation: `Known branches: ${branches.slice(0, 10).join(", ") || "none"}. Run \`git fetch\` yourself if the branch is new; Asterweave never fetches.`,
    });
  }

  const record = { repository, branch, path: root, runner: "local", connectedAt: (options.now ?? (() => new Date().toISOString()))() };
  writeJsonAtomic(repoFilePath(options), record, options.fs ? { fs: options.fs } : undefined);
  return { ok: true, ...record, dirty: null };
}

/**
 * Current connection state. Never throws for a missing record, a vanished path, or an unreadable /
 * invalid repo.json (that is reported as `connected: false` with a `warning`; the file is never
 * rewritten by a read, `repo connect` replaces it). A trust.json that cannot be read makes the clone
 * untrusted (`trust.warning`).
 *
 * @param {RepoOptions} [options]
 * @returns {Promise<{ok: boolean, connected: boolean, problem?: string, repository?: string, branch?: string,
 *   currentBranch?: string|null, path?: string, runner?: 'local', connectedAt?: string|null, dirty?: null,
 *   trust?: {trusted: boolean, reason: string}}>}
 */
export async function repoStatus(options = {}) {
  let record;
  try {
    record = readRecord(options);
  } catch (error) {
    if (!(error instanceof StoreError) && error?.code !== "REPO_RECORD_INVALID") throw error;
    return { ok: true, connected: false, warning: `The saved repository connection (${path.basename(repoFilePath(options))}) is unreadable or invalid and is treated as not connected; run \`asterweave repo connect\` to replace it.` };
  }
  if (!record) return { ok: true, connected: false };
  const base = { connected: true, repository: record.repository, branch: record.branch, path: record.path, runner: record.runner, connectedAt: record.connectedAt };
  const fs = options.fs ?? nodeFs;
  let real;
  try {
    real = realpathOf(record.path, fs);
    if (!fs.statSync(real).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, ...base, problem: "REPO_PATH_MISSING", currentBranch: null, dirty: null, trust: null };
  }
  const inside = await git(["rev-parse", "--is-inside-work-tree"], real, options);
  if (inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { ok: false, ...base, problem: "REPO_NOT_GIT", currentBranch: null, dirty: null, trust: null };
  }
  const currentBranch = await currentBranchOf(real, options);
  const trust = safeTrustStatus(real, { env: options.env ?? process.env, platform: options.platform, homedir: options.homedir, fs: options.fs });
  // `dirty` is always null (unknown): computing it needs `git status`, which runs repository-configured
  // clean/process filter drivers (see the header comment).
  return { ok: true, ...base, currentBranch, dirty: null, trust: { trusted: trust.trusted, reason: trust.reason, ...(trust.warning ? { warning: trust.warning } : {}) } };
}
