// Stable repository identity for memory.
//
// A repository ID must not depend on a folder name or a path, and must not silently merge or split repositories:
//   - With a remote, the ID is derived from the CANONICAL remote (`host/owner/name`: credentials, port, scheme, `.git`,
//     trailing slashes and query stripped; host lower-cased; the path lower-cased only for hosts known to ignore case). The
//     scp form and the https form of one remote are therefore the same repository, and two forks (different path) are not.
//   - Without a remote, the ID is random, persisted, and bound to the git common directory of that clone.
//   - Clones and worktrees map to a repository by `clone_key` (the git common directory, or the directory itself outside git).
//     All worktrees of one clone share a common directory, so they share an ID. Two clones of one remote share an ID too; two
//     different repositories that merely share a folder name never do (different key, different remote).
//   - A CHANGED remote on a known clone (including none -> some and some -> none) is NOT re-associated: an ambiguity row is
//     recorded and `ambiguous: true` is returned with the PREVIOUS binding. The caller must not capture while it is open.
//     `resolveAmbiguity` is the only way out: 'same' (the remote moved: keep the history, remember the new remote as an alias)
//     or 'new' (a different repository: bind this clone to the repository of the new remote, history stays with the old one).
//     'same' is refused when the new remote already belongs to another repository, so two repositories never merge.
//   - A clone WITHOUT a remote is also bound to an ANCHOR (readCloneAnchor): its root commit(s), `unborn` before the first
//     commit, or the folder's inode and birth time outside git. A different anchor at the same clone key (rm -rf + git init, a
//     reused folder) is the same kind of ambiguity as a changed remote. An unborn clone takes its first root commit without
//     ambiguity only while no memory is stored for its repository. Clones bound before anchors existed record theirs on next sight.

import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { runBinary } from "../../proc.mjs";
import { gitEnv } from "../../repo.mjs";
import { transaction } from "./db.mjs";

const CASE_INSENSITIVE_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org"]);
export const NO_REMOTE = "<none>";

/**
 * Canonical, credential-free form of a remote URL, or null when there is nothing usable.
 * `https://user:pw@GitHub.com:443/Acme/Widgets.git` and `git@github.com:acme/widgets` both give `github.com/acme/widgets`.
 * @param {unknown} url
 * @returns {string | null}
 */
export function canonicalRemote(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  if (text === "" || /[\s\x00-\x1f]/.test(text) || text === "<unrecognized remote>") return null;
  let host = "";
  let pathname;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(text);
  if (scheme) {
    const rest = scheme[2];
    if (scheme[1].toLowerCase() === "file") {
      host = "file";
      pathname = rest.replace(/^\/+(?=[A-Za-z]:)/, "");
    } else {
      const slash = rest.indexOf("/");
      const authority = slash < 0 ? rest : rest.slice(0, slash);
      pathname = slash < 0 ? "" : rest.slice(slash + 1);
      host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "").toLowerCase();
    }
  } else if (/^([A-Za-z]:[\\/]|\/|\\\\)/.test(text)) {
    host = "file"; // a local path used as a remote (a bare repository, a fixture)
    pathname = text.replace(/\\/g, "/").replace(/^\/+/, "");
  } else {
    const scp = /^(?:[^@:/\\]+@)?([^@:/\\]{2,}):(?![/\\])(.+)$/.exec(text);
    if (!scp) return null;
    host = scp[1].toLowerCase();
    pathname = scp[2];
  }
  pathname = pathname.replace(/[?#].*$/, "").replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  if (host === "" || pathname === "" || pathname.split("/").some((part) => part === "..")) return null;
  if (CASE_INSENSITIVE_HOSTS.has(host) || host === "file") pathname = pathname.toLowerCase();
  return `${host}/${pathname}`;
}

/** `r_` plus 24 hex characters of the canonical remote's hash. Deterministic: the same remote is the same ID on every machine. */
export function repoIdForRemote(canonical) {
  return `r_${createHash("sha256").update(`remote:${canonical}`).digest("hex").slice(0, 24)}`;
}

const randomRepoId = () => `r_${randomBytes(12).toString("hex")}`;

function findRepoByRemote(db, canonical) {
  const direct = db.prepare("SELECT id FROM repos WHERE remote_canonical = ?").get(canonical);
  if (direct) return direct.id;
  return db.prepare("SELECT repo_id FROM repo_aliases WHERE alias = ?").get(canonical)?.repo_id ?? null;
}

function createRepo(db, canonical, at) {
  const id = canonical ? repoIdForRemote(canonical) : randomRepoId();
  db.prepare("INSERT INTO repos (id, kind, remote_canonical, created_at) VALUES (?, ?, ?, ?)").run(id, canonical ? "remote" : "local", canonical, at);
  return id;
}

/** True when `observed` (a canonical remote or NO_REMOTE) is what this repository is already known by. */
function accepts(db, repo, observed) {
  if ((repo.remote_canonical ?? NO_REMOTE) === observed) return true;
  return db.prepare("SELECT 1 FROM repo_aliases WHERE repo_id = ? AND alias = ?").get(repo.id, observed) !== undefined;
}

const ANCHOR_TIMEOUT_MS = 10_000;
const ANCHOR_ROOTS_MAX = 16;
const ANCHOR_OUTPUT_MAX = 64 * 1024;
const gitFlags = (platform) => ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand="];

/**
 * The intrinsic anchor of a clone (see the header). Read-only, bounded (timeout, output cap, at most 16 roots), no shell, the
 * hardened git flags and environment. Roots are read from HEAD and every local branch, which all worktrees of a clone share.
 * @param {{workspace: string, git: boolean}} repo
 * @param {{env?: object, spawn?: Function, exists?: Function, platform?: string, timeoutMs?: number, fs?: typeof nodeFs,
 *   runGit?: (args: string[]) => Promise<{code: number|null, stdout: string, stderr: string, error?: object, timedOut?: boolean}>}} [options]
 * @returns {Promise<{ok: true, anchor: string} | {ok: false, reason: string}>}  not ok: the anchor is unknown for now (never "different")
 */
export async function readCloneAnchor(repo, options = {}) {
  if (!repo?.git) {
    try {
      const stat = (options.fs ?? nodeFs).statSync(repo.workspace, { bigint: true });
      return { ok: true, anchor: `dir:${stat.ino}:${stat.birthtimeMs}` };
    } catch (error) {
      return { ok: false, reason: `the folder could not be inspected (${error?.code ?? "error"})` };
    }
  }
  const platform = options.platform ?? process.platform;
  const runGit = options.runGit ?? ((args) => runBinary("git", [...gitFlags(platform), ...args], {
    cwd: repo.workspace, env: gitEnv(options.env ?? process.env), spawn: options.spawn, exists: options.exists, platform, timeoutMs: options.timeoutMs ?? ANCHOR_TIMEOUT_MS, maxOutputBytes: ANCHOR_OUTPUT_MAX,
  }));
  let result;
  try {
    result = await runGit(["rev-list", "--max-parents=0", "HEAD", "--branches", "--"]);
  } catch {
    return { ok: false, reason: "git could not run" };
  }
  if (result?.error || result?.timedOut) return { ok: false, reason: result.timedOut ? "git timed out" : "git could not run" };
  if (result.code === 0) {
    const roots = [...new Set(String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[0-9a-f]{40,64}$/.test(line)))].sort().slice(0, ANCHOR_ROOTS_MAX);
    return roots.length > 0 ? { ok: true, anchor: `git:${roots.join(",")}` } : { ok: false, reason: "git listed no root commit" };
  }
  if (/ambiguous argument 'HEAD'|unknown revision|bad revision 'HEAD'/i.test(String(result.stderr ?? ""))) return { ok: true, anchor: "unborn" };
  return { ok: false, reason: `git rev-list failed (exit ${result.code})` };
}

/**
 * When this repository's content began, for the importer's time cutoff: a transcript record written before the repository existed
 * cannot belong to it, even when its cwd is the same path today (a folder reused for another repository). Git: the earliest author or
 * committer time of any root commit (author time survives rebases and imported history, so this errs towards accepting). Not a git
 * repository: the folder's birth time. Read-only, bounded, no shell, hardened flags. null = unknown (the caller applies no cutoff and
 * says so); an unborn repository has no commit yet, so its folder's birth time is used.
 * @param {{workspace: string, git: boolean}} repo
 * @param {Parameters<typeof readCloneAnchor>[1]} [options]
 * @returns {Promise<{at: string|null, source: 'root-commit'|'folder'|'unknown', reason?: string}>}
 */
export async function readRepositoryBirth(repo, options = {}) {
  const folderBirth = () => {
    try {
      const ms = Number((options.fs ?? nodeFs).statSync(repo.workspace).birthtimeMs);
      return Number.isFinite(ms) && ms > 0 ? { at: new Date(ms).toISOString(), source: "folder" } : { at: null, source: "unknown", reason: "the folder has no birth time" };
    } catch (error) {
      return { at: null, source: "unknown", reason: `the folder could not be inspected (${error?.code ?? "error"})` };
    }
  };
  if (!repo?.git) return folderBirth();
  const platform = options.platform ?? process.platform;
  const runGit = options.runGit ?? ((args) => runBinary("git", [...gitFlags(platform), ...args], {
    cwd: repo.workspace, env: gitEnv(options.env ?? process.env), spawn: options.spawn, exists: options.exists, platform, timeoutMs: options.timeoutMs ?? ANCHOR_TIMEOUT_MS, maxOutputBytes: ANCHOR_OUTPUT_MAX,
  }));
  let result;
  try {
    result = await runGit(["log", "--max-parents=0", "--format=%at %ct", "HEAD", "--branches", "--"]);
  } catch {
    return { at: null, source: "unknown", reason: "git could not run" };
  }
  if (result?.error || result?.timedOut) return { at: null, source: "unknown", reason: result.timedOut ? "git timed out" : "git could not run" };
  if (result.code !== 0) {
    if (/ambiguous argument 'HEAD'|unknown revision|bad revision 'HEAD'|does not have any commits/i.test(String(result.stderr ?? ""))) return folderBirth();
    return { at: null, source: "unknown", reason: `git log failed (exit ${result.code})` };
  }
  const seconds = String(result.stdout ?? "").split(/\s+/).filter((word) => /^\d{1,12}$/.test(word)).map(Number).filter((n) => n > 0);
  if (seconds.length === 0) return { at: null, source: "unknown", reason: "git listed no root commit time" };
  return { at: new Date(Math.min(...seconds) * 1000).toISOString(), source: "root-commit" };
}

/** 'skip' (nothing observed), 'record' (store the observed anchor), 'same', 'unborn-born' (first commit) or 'mismatch'. Pure. */
export function compareAnchors(stored, observed) {
  if (typeof observed !== "string" || observed === "") return "skip";
  if (typeof stored !== "string" || stored === "") return "record";
  if (stored === observed) return "same";
  const roots = (anchor) => (anchor.startsWith("git:") ? anchor.slice(4).split(",").filter(Boolean) : null);
  const before = roots(stored);
  const now = roots(observed);
  // A merge of unrelated history adds a root and a rewrite may drop one: one shared root is still the same repository.
  if (before && now) return now.some((sha) => before.includes(sha)) ? "record" : "mismatch";
  if (stored === "unborn" && now) return "unborn-born";
  return "mismatch";
}

function hasMemory(db, repoId) {
  return db.prepare("SELECT 1 FROM sessions WHERE repo_id = ? UNION ALL SELECT 1 FROM memory_items WHERE repo_id = ? LIMIT 1").get(repoId, repoId) !== undefined;
}

/**
 * @typedef {object} RepoIdentity
 * @property {'ok'|'created'|'ambiguous'|'unmapped'} status
 * @property {string | null} repoId   the binding in force (the PREVIOUS one while ambiguous); null when unmapped
 * @property {boolean} ambiguous
 * @property {string | null} remote   canonical remote observed now, null when none
 * @property {{id: number, observed: string, detectedAt: string} | null} ambiguity
 */

/**
 * Find (and, with `create`, record) the repository identity of a clone or directory.
 * @param {import('./db.mjs').Memory} mem
 * @param {{cloneKey: string, kind?: 'git-common-dir'|'directory', remote?: string | null}} input
 *   `remote` may be any URL form; credentials are dropped by canonicalisation and never stored.
 * @param {{create?: boolean}} [options]  create:false never writes (read commands); an unknown clone is then `unmapped`.
 * @returns {RepoIdentity}
 */
export function resolveRepoIdentity(mem, input, { create = true } = {}) {
  const { db } = mem;
  const cloneKey = String(input.cloneKey);
  const kind = input.kind === "directory" ? "directory" : "git-common-dir";
  const remote = canonicalRemote(input.remote ?? null);
  const observed = remote ?? NO_REMOTE;
  const anchor = typeof input.anchor === "string" && input.anchor !== "" ? input.anchor.slice(0, 2000) : null;
  const at = mem.now();

  const clone = db.prepare("SELECT repo_id, anchor FROM repo_clones WHERE clone_key = ?").get(cloneKey);
  if (clone) {
    const repo = db.prepare("SELECT id, remote_canonical FROM repos WHERE id = ?").get(clone.repo_id);
    let observedAnchor = null;
    if (accepts(db, repo, observed)) {
      // Only a clone without a remote is identified by its anchor: with a remote, the remote IS the identity.
      let verdict = observed === NO_REMOTE ? compareAnchors(clone.anchor, anchor) : "skip";
      if (verdict === "unborn-born") verdict = hasMemory(db, repo.id) ? "mismatch" : "record";
      if (verdict !== "mismatch") {
        if (create && verdict === "record") db.prepare("UPDATE repo_clones SET last_seen_at = ?, anchor = ? WHERE clone_key = ?").run(at, anchor, cloneKey);
        else if (create) db.prepare("UPDATE repo_clones SET last_seen_at = ? WHERE clone_key = ?").run(at, cloneKey);
        return { status: "ok", repoId: repo.id, ambiguous: false, remote, ambiguity: null };
      }
      observedAnchor = anchor;
    }
    let open = db.prepare("SELECT id, observed, detected_at FROM repo_ambiguities WHERE clone_key = ? AND observed = ? AND observed_anchor IS ? AND resolved_at IS NULL").get(cloneKey, observed, observedAnchor);
    if (!open && create) {
      const info = db.prepare("INSERT INTO repo_ambiguities (clone_key, repo_id, observed, observed_anchor, detected_at) VALUES (?, ?, ?, ?, ?)").run(cloneKey, repo.id, observed, observedAnchor, at);
      open = { id: Number(info.lastInsertRowid), observed, detected_at: at };
    }
    return {
      status: "ambiguous",
      repoId: repo.id,
      ambiguous: true,
      reason: observedAnchor ? "history" : "remote",
      remote,
      ambiguity: open ? { id: Number(open.id), observed: open.observed, detectedAt: open.detected_at } : { id: 0, observed, detectedAt: at },
    };
  }

  if (!create) return { status: "unmapped", repoId: null, ambiguous: false, remote, ambiguity: null };
  return transaction(mem, () => {
    let repoId = remote ? findRepoByRemote(db, remote) : null;
    let created = false;
    if (!repoId) {
      repoId = createRepo(db, remote, at);
      created = true;
    }
    db.prepare("INSERT INTO repo_clones (clone_key, repo_id, kind, first_seen_at, last_seen_at, anchor) VALUES (?, ?, ?, ?, ?, ?)").run(cloneKey, repoId, kind, at, at, anchor);
    return { status: created ? "created" : "ok", repoId, ambiguous: false, remote, ambiguity: null };
  });
}

/** Open ambiguities, optionally of one clone. */
export function listAmbiguities(mem, cloneKey) {
  const rows = cloneKey === undefined
    ? mem.db.prepare("SELECT id, clone_key, repo_id, observed, observed_anchor, detected_at FROM repo_ambiguities WHERE resolved_at IS NULL ORDER BY id").all()
    : mem.db.prepare("SELECT id, clone_key, repo_id, observed, observed_anchor, detected_at FROM repo_ambiguities WHERE resolved_at IS NULL AND clone_key = ? ORDER BY id").all(String(cloneKey));
  return rows.map((row) => ({ id: Number(row.id), cloneKey: row.clone_key, repoId: row.repo_id, observed: row.observed, kind: row.observed_anchor ? "history" : "remote", detectedAt: row.detected_at }));
}

/**
 * Settle the open ambiguity of a clone: the only way a changed remote changes the binding.
 * @param {import('./db.mjs').Memory} mem
 * @param {string} cloneKey
 * @param {'same'|'new'} decision
 * @returns {{ok: true, decision: string, repoId: string, previousRepoId: string, observed: string} | {ok: false, code: string, message: string}}
 */
export function resolveAmbiguity(mem, cloneKey, decision) {
  const { db } = mem;
  if (decision !== "same" && decision !== "new") return { ok: false, code: "USAGE", message: "The decision must be 'same' or 'new'." };
  const key = String(cloneKey);
  return transaction(mem, () => {
    const open = db.prepare("SELECT id, repo_id, observed, observed_anchor FROM repo_ambiguities WHERE clone_key = ? AND resolved_at IS NULL ORDER BY id DESC").get(key);
    if (!open) return { ok: false, code: "REPO_NO_AMBIGUITY", message: "This clone has no open repository ambiguity." };
    const at = mem.now();
    const observed = open.observed;
    const canonical = observed === NO_REMOTE ? null : observed;
    let repoId = open.repo_id;
    const anchored = typeof open.observed_anchor === "string" && open.observed_anchor !== "";
    if (decision === "same" && anchored) {
      // a history ambiguity (e.g. rewritten history): the remote did not change, so there is no alias to add
    } else if (decision === "same") {
      const owner = canonical ? findRepoByRemote(db, canonical) : null;
      if (owner && owner !== open.repo_id) {
        return { ok: false, code: "REPO_ALIAS_CONFLICT", message: "That remote already belongs to another repository, which is never merged with this one. Resolve as 'new' to bind this clone to it." };
      }
      db.prepare("INSERT OR IGNORE INTO repo_aliases (alias, repo_id, added_at, reason) VALUES (?, ?, ?, 'resolved as the same repository')").run(observed, open.repo_id, at);
    } else {
      repoId = (canonical ? findRepoByRemote(db, canonical) : null) ?? createRepo(db, canonical, at);
      db.prepare("UPDATE repo_clones SET repo_id = ?, last_seen_at = ? WHERE clone_key = ?").run(repoId, at, key);
    }
    if (anchored) db.prepare("UPDATE repo_clones SET anchor = ?, last_seen_at = ? WHERE clone_key = ?").run(open.observed_anchor, at, key);
    db.prepare("UPDATE repo_ambiguities SET resolved_at = ?, resolution = ? WHERE id = ?").run(at, decision, open.id);
    return { ok: true, decision, repoId, previousRepoId: open.repo_id, observed };
  });
}

/** What is known about a repository id (for `memory repo`): its basis, aliases and the clones bound to it. */
export function describeRepo(mem, repoId) {
  const repo = mem.db.prepare("SELECT id, kind, remote_canonical, created_at FROM repos WHERE id = ?").get(repoId);
  if (!repo) return null;
  const aliases = mem.db.prepare("SELECT alias FROM repo_aliases WHERE repo_id = ? ORDER BY alias").all(repoId).map((row) => row.alias);
  const clones = Number(mem.db.prepare("SELECT COUNT(*) AS n FROM repo_clones WHERE repo_id = ?").get(repoId).n);
  return { id: repo.id, kind: repo.kind, remote: repo.remote_canonical, aliases, clones, createdAt: repo.created_at };
}
