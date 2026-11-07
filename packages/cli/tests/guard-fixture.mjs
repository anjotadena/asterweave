// Test fixture: `evaluate` and `classifyShell` of the guard with a virtual `<workspaceRoot>/.git` entry.
//
// Since round 6 EVERY git or gh form (read, commit, push, gh pr create) is understood only when the workspace root has a `.git` entry (the repository the guard
// verified). The many injected-platform contexts of the guard tests have no file system behind them, so these wrappers report `<root>/.git` as present when the
// context's own `lstat` (an injected one, or the host's) says nothing is there. A context can opt out with `rootGit: false` (a root WITHOUT a repository).
// Everything else (every other path, every other option) is passed through unchanged.

import { lstatSync } from "node:fs";
import { evaluate as realEvaluate } from "../src/runtime/guard.mjs";
import { classifyShell as realClassifyShell } from "../src/runtime/shell-classify.mjs";

export * from "../src/runtime/guard.mjs";

const normalize = (value) => String(value).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });

/** The context with an `lstat` that also answers for `<workspaceRoot>/.git`. */
export function withRootGit(context) {
  if (context === null || typeof context !== "object" || typeof context.workspaceRoot !== "string" || context.rootGit === false) return context;
  const inner = context.lstat ?? (context.platform === undefined || context.platform === process.platform ? (value) => lstatSync(value) : () => { throw missing(); });
  const dotGit = `${normalize(context.workspaceRoot)}/.git`;
  const virtual = () => ({ isSymbolicLink: () => false, isDirectory: () => true });
  const lstat = (value) => {
    try {
      const found = inner(value);
      return found === null || found === undefined ? (normalize(value) === dotGit ? virtual() : found) : found;
    } catch (error) {
      if (normalize(value) === dotGit && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return virtual();
      throw error;
    }
  };
  return { ...context, lstat };
}

export const evaluate = (action, context) => realEvaluate(action, withRootGit(context));
export const classifyShell = (command, options) => realClassifyShell(command, withRootGit(options));

/** An `lstat` that reports exactly `paths` as real directories (case and slash insensitive) and everything else as missing. */
export function presentDirectories(...paths) {
  const known = new Set(paths.map(normalize));
  return (value) => {
    if (known.has(normalize(value))) return { isSymbolicLink: () => false, isDirectory: () => true };
    throw missing();
  };
}
