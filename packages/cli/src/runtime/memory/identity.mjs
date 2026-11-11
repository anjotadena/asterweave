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

import { createHash, randomBytes } from "node:crypto";
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
  const at = mem.now();

  const clone = db.prepare("SELECT repo_id FROM repo_clones WHERE clone_key = ?").get(cloneKey);
  if (clone) {
    const repo = db.prepare("SELECT id, remote_canonical FROM repos WHERE id = ?").get(clone.repo_id);
    if (accepts(db, repo, observed)) {
      if (create) db.prepare("UPDATE repo_clones SET last_seen_at = ? WHERE clone_key = ?").run(at, cloneKey);
      return { status: "ok", repoId: repo.id, ambiguous: false, remote, ambiguity: null };
    }
    let open = db.prepare("SELECT id, observed, detected_at FROM repo_ambiguities WHERE clone_key = ? AND observed = ? AND resolved_at IS NULL").get(cloneKey, observed);
    if (!open && create) {
      const info = db.prepare("INSERT INTO repo_ambiguities (clone_key, repo_id, observed, detected_at) VALUES (?, ?, ?, ?)").run(cloneKey, repo.id, observed, at);
      open = { id: Number(info.lastInsertRowid), observed, detected_at: at };
    }
    return {
      status: "ambiguous",
      repoId: repo.id,
      ambiguous: true,
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
    db.prepare("INSERT INTO repo_clones (clone_key, repo_id, kind, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run(cloneKey, repoId, kind, at, at);
    return { status: created ? "created" : "ok", repoId, ambiguous: false, remote, ambiguity: null };
  });
}

/** Open ambiguities, optionally of one clone. */
export function listAmbiguities(mem, cloneKey) {
  const rows = cloneKey === undefined
    ? mem.db.prepare("SELECT id, clone_key, repo_id, observed, detected_at FROM repo_ambiguities WHERE resolved_at IS NULL ORDER BY id").all()
    : mem.db.prepare("SELECT id, clone_key, repo_id, observed, detected_at FROM repo_ambiguities WHERE resolved_at IS NULL AND clone_key = ? ORDER BY id").all(String(cloneKey));
  return rows.map((row) => ({ id: Number(row.id), cloneKey: row.clone_key, repoId: row.repo_id, observed: row.observed, detectedAt: row.detected_at }));
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
    const open = db.prepare("SELECT id, repo_id, observed FROM repo_ambiguities WHERE clone_key = ? AND resolved_at IS NULL ORDER BY id DESC").get(key);
    if (!open) return { ok: false, code: "REPO_NO_AMBIGUITY", message: "This clone has no open repository ambiguity." };
    const at = mem.now();
    const observed = open.observed;
    const canonical = observed === NO_REMOTE ? null : observed;
    let repoId = open.repo_id;
    if (decision === "same") {
      const owner = canonical ? findRepoByRemote(db, canonical) : null;
      if (owner && owner !== open.repo_id) {
        return { ok: false, code: "REPO_ALIAS_CONFLICT", message: "That remote already belongs to another repository, which is never merged with this one. Resolve as 'new' to bind this clone to it." };
      }
      db.prepare("INSERT OR IGNORE INTO repo_aliases (alias, repo_id, added_at, reason) VALUES (?, ?, ?, 'resolved as the same repository')").run(observed, open.repo_id, at);
    } else {
      repoId = (canonical ? findRepoByRemote(db, canonical) : null) ?? createRepo(db, canonical, at);
      db.prepare("UPDATE repo_clones SET repo_id = ?, last_seen_at = ? WHERE clone_key = ?").run(repoId, at, key);
    }
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
