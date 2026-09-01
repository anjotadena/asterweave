// Minimal, dependency-free glob matching shared by completion-state.mjs (ownership-overlap
// validation) and completion-guard.mjs (the write-boundary hook). Supports `**` (any depth,
// including zero segments), `*` (single path segment), and `?` (single character). No external
// package is introduced; this repository intentionally ships zero npm dependencies.

export function normalizePath(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

const REGEXP_SPECIAL = new Set(["\\", "^", "$", ".", "|", "+", "(", ")", "[", "]", "{", "}"]);

export function globToRegExp(glob) {
  const pattern = normalizePath(glob);
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === "*" && pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") index += 1;
      source += ".*";
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (REGEXP_SPECIAL.has(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  source += "$";
  return new RegExp(source);
}

export function matchesGlob(glob, path) {
  return globToRegExp(glob).test(normalizePath(path));
}

export function matchesAny(globs, path) {
  return (globs || []).some((glob) => matchesGlob(glob, path));
}

/** The literal path segment prefix before the first wildcard, used to detect ownership overlap. */
export function staticPrefix(glob) {
  const pattern = normalizePath(glob);
  const wildcardIndex = pattern.search(/[*?]/);
  const prefix = wildcardIndex === -1 ? pattern : pattern.slice(0, wildcardIndex);
  return prefix.replace(/\/+$/, "");
}

/** True when neither glob's static prefix can be ruled out as unrelated to the other (one is an
 * ancestor path of, or equal to, the other). This is a conservative heuristic, not full glob
 * intersection: it is meant to catch real ownership collisions (`src/Finance/**` vs
 * `src/Finance/Ledger.cs`), not to prove disjointness of arbitrary patterns. */
export function prefixesOverlap(globA, globB) {
  const a = staticPrefix(globA).split("/").filter(Boolean);
  const b = staticPrefix(globB).split("/").filter(Boolean);
  const shorter = Math.min(a.length, b.length);
  for (let index = 0; index < shorter; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

/** Returns the first overlapping pair found between two glob lists, or null. */
export function findOverlap(globsA, globsB) {
  for (const a of globsA || []) {
    for (const b of globsB || []) {
      if (prefixesOverlap(a, b)) return { a, b };
    }
  }
  return null;
}
