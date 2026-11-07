// Cross-check of the work tree root that `git rev-parse --show-toplevel` reports.
//
// `--show-toplevel` follows `core.worktree` from .git/config, and that file travels with an archived or cloned
// repository: a hostile one can point the work tree at a PARENT directory and thereby widen the guard's workspace
// root (every path under the parent would count as "inside the workspace"). So the reported root is only trusted
// when it is consistent with the repository itself:
//   1. the current directory lies inside it, and
//   2. its `.git` is either the git common directory itself (an ordinary clone), or a `.git` FILE ("gitdir: ...")
//      that points back at the common directory (separate git dir, submodule) or into <common>/worktrees/ (a linked
//      worktree). A parent directory that has no such link is refused.
// All paths are expected to be real paths already (realpath.native); comparison is case-insensitive on win32.
//
// src/repo.mjs (the trust/repo commands) still uses --show-toplevel as is; it should call this helper too (follow-up).

import * as nodeFs from "node:fs";
import path from "node:path";

const MAX_GITFILE_BYTES = 4096;

function inside(child, parent, fold) {
  const relative = path.relative(fold(parent), fold(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * @param {{cwd: string, toplevel: string, commonDir: string, platform?: string, fs?: typeof nodeFs}} input
 * @returns {string | null}  null when the root is consistent, otherwise why it is not
 */
export function worktreeRootProblem({ cwd, toplevel, commonDir, platform = process.platform, fs = nodeFs }) {
  const fold = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value));
  if (!inside(cwd, toplevel, fold)) return "the current directory is not inside the work tree git reports";
  const real = (value) => {
    try {
      return fs.realpathSync.native(value);
    } catch {
      return path.resolve(value);
    }
  };
  const entry = path.join(toplevel, ".git");
  let stat;
  try {
    stat = fs.statSync(entry);
  } catch {
    return "the work tree git reports has no .git of its own (core.worktree may point somewhere else)";
  }
  if (stat.isDirectory()) {
    return fold(real(entry)) === fold(commonDir) ? null : "the .git of the work tree git reports is a different repository";
  }
  if (!stat.isFile() || stat.size > MAX_GITFILE_BYTES) return "the .git entry of the work tree git reports is not usable";
  let text;
  try {
    text = fs.readFileSync(entry, "utf8");
  } catch {
    return "the .git file of the work tree git reports cannot be read";
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (!match) return "the .git file of the work tree git reports has no gitdir";
  const target = real(path.resolve(toplevel, match[1]));
  if (fold(target) === fold(commonDir) || inside(target, path.join(commonDir, "worktrees"), fold)) return null;
  return "the .git file of the work tree git reports points at a different repository";
}
