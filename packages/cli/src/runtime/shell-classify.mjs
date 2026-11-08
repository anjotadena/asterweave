// Shell command classification for the Asterweave guard.
//
// `classifyShell(command, opts)` tokenizes a shell command (bash / PowerShell / cmd flavoured) with
// a quote-aware tokenizer and returns `{segments, findings, operations, mutating}`. It never decides
// allow / deny itself; guard.mjs maps each finding `code` to a decision.
//
// THIS IS A HEURISTIC, NOT A SANDBOX. The design principle is an ALLOW-LIST: the classifier may only ALLOW a
// command line whose every segment is a form it FULLY understands (a small set of read-only commands, read-only
// git subcommands, and the three policy operations `git commit -m`, `git push <remote> <branch>`, `gh pr create`,
// each with allow-listed flags and in-workspace, non-secret, non-protected path operands). Everything else
// -- wrappers, interpreters, build tools, unknown commands, unknown flags, redirection to files, command
// substitution, script blocks, heredocs, aliases -- is reported as UNPARSEABLE_COMMAND (supervised => approval,
// autonomous => deny), UNLESS the user's own policy.json lists the exact argv prefix in `allowCommands` (options.allowCommands;
// never taken from repository files). A long command (over MAX_COMMAND_CHARS), too many words or paths, or a blown
// time or file-system budget is refused outright (command-too-complex).
//
// Layers, strictest wins:
//   1. A FLOOR: the ten destructive patterns of the Claude Code plugin's hook-guard.mjs (re-implemented, not
//      imported: the CLI never imports plugins/) as a LINEAR scan over words, run on the raw text AND on the
//      de-escaped word stream, whatever the tokenizer says. There is NO environment-variable bypass.
//   2. Structural checks over tokens: git (global options, `-c`, push refspecs, branch deletion), recursive rm /
//      find -delete, inline interpreters, network, merge/publish/deploy. For a segment that is NOT understood they
//      also run on every later word that names a command of interest (`exec -a x git push ...`), so a wrapper never
//      hides a deny floor.
//   3. Path arguments are compared with the workspace root. NO file system or network call is made for text that
//      is not lexically inside the workspace root (UNC, \\?\, \\.\, device names, ~user, $ and % expansions are
//      decided by TEXT); inside the workspace a bounded realpath / lstat / readlink chain (which follows dangling links)
//      resolves the real target. Secrets, protected files (.git, .claude settings, .mcp.json) and the Asterweave user
//      directory are protected by name and location.
//
// Shell dialects: `posix` (bash, the Claude Code Bash tool EVEN ON WINDOWS), `powershell` (backtick escapes, backslash
// literal, no script blocks) and `cmd` (caret escapes, backslash literal, no ' quotes, no # comments). The dialect is chosen by the
// caller, separately from `platform`, which only selects PATH semantics. Without a dialect: posix on POSIX hosts, all
// three on win32 (findings are merged; a segment must be understood in EVERY dialect).

import { execFileSync } from "node:child_process";
import * as nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { resolveUserDir } from "../paths.mjs";
import { gitEnv } from "../repo.mjs";

/** Branches whose direct push needs approval unless configured otherwise. */
export const DEFAULT_BRANCHES = Object.freeze(["main", "master"]);

/** Longest command (in characters) the classifier looks at; longer ones are denied before any other work. */
export const MAX_COMMAND_CHARS = 64 * 1024;
/** The shell dialects the tokenizer understands. */
export const DIALECTS = Object.freeze(["posix", "powershell", "cmd"]);

const MAX_DEPTH = 3;
const MAX_WORDS = 4000;
const MAX_SEGMENTS = 2000;
const MAX_PATH_CHARS = 4096;
const MAX_PATH_CHECKS = 2000;
const MAX_FS_CALLS = 6000;
const MAX_LINK_HOPS = 32;
const MAX_SPECULATIVE_WORDS = 64;
const DEFAULT_BUDGET_MS = 3000;

/** A classification budget (time, file-system calls, link hops) ran out. NEVER swallowed: it becomes a deny (command-too-complex). */
class BudgetError extends Error {}

// ---------------------------------------------------------------------------------------------
// Floor: the plugin's ten destructive patterns (hook-guard.mjs BLOCKED_PATTERNS) as a linear word scan.
// The plugin uses regular expressions with nested unbounded `[^\n]*`, which are polynomial (a 5000-character
// line takes seconds, 10000 more than a minute); this scan visits every word once and keeps per-line state.

const FLOOR = Object.freeze([
  { id: "git-reset-hard", reason: "git reset --hard can destroy uncommitted work" },
  { id: "git-clean-force", reason: "git clean with force can delete untracked files" },
  { id: "git-bulk-checkout", reason: "bulk checkout/restore can discard user changes" },
  { id: "git-push-force", reason: "force-push requires an explicit manual operation" },
  { id: "rm-broad", reason: "broad recursive deletion is prohibited" },
  { id: "remove-item-broad", reason: "broad recursive PowerShell deletion is prohibited" },
  { id: "sql-destructive", reason: "destructive database operations require a separate approved runbook" },
  { id: "docker-prune-all", reason: "global Docker pruning can remove unrelated data" },
  { id: "kubectl-delete-namespace", reason: "namespace deletion is outside autonomous coding scope" },
  { id: "terraform-destroy", reason: "infrastructure destruction is outside autonomous coding scope" },
]);

const RULE_REASONS = Object.freeze(Object.fromEntries(FLOOR.map((entry) => [entry.id, entry.reason])));

const isWhite = (ch) => ch === " " || ch === "\t" || ch === "\f" || ch === "\v" || ch === " " || ch === "﻿" || (ch > "\u007f" && /\s/.test(ch));
const isNewline = (ch) => ch === "\n" || ch === "\r" || ch === " " || ch === " ";
const FLOOR_SEPARATORS = new Set([";", "&", "|", "(", ")", "<", ">", "'", '"', "`", "{", "}"]);
const isFloorBreak = (ch) => isWhite(ch) || isNewline(ch) || FLOOR_SEPARATORS.has(ch);

/** Words of `text` (quotes, operators and whitespace separate words) with line-start and end-of-command markers. */
function floorTokens(text) {
  const tokens = [];
  const n = text.length;
  let i = 0;
  let nl = false;
  while (i < n) {
    const ch = text[i];
    if (isNewline(ch)) {
      nl = true;
      i += 1;
      continue;
    }
    if (isFloorBreak(ch)) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n && !isFloorBreak(text[j])) j += 1;
    let k = j;
    while (k < n && (isWhite(text[k]) || text[k] === "'" || text[k] === '"')) k += 1;
    tokens.push({ t: text.slice(i, j).toLowerCase(), nl, op: k >= n || text[k] === ";" || text[k] === "&" || text[k] === "|" });
    nl = false;
    i = j;
  }
  return tokens;
}

const baseOf = (token) => token.slice(Math.max(token.lastIndexOf("/"), token.lastIndexOf("\\")) + 1).replace(/\.exe$/, "");
const BROAD_RM = new Set(["/", "~", ".", "..", "$home"]);

function hasRecursiveForce(flag) {
  if (!flag.startsWith("-")) return false;
  const r = flag.indexOf("r");
  const f = flag.indexOf("f");
  return r >= 0 && f >= 0 && (flag.lastIndexOf("f") > r || flag.lastIndexOf("r") > f);
}

/** Visit `text` once; calls `hit(ruleId)` for every floor pattern found. Linear in the length of `text`. */
function floorScan(text, hit) {
  const tokens = floorTokens(text);
  let pushLine = false;
  let riRecurse = false;
  let riForce = false;
  let riLine = false;
  let dockerLine = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const { t, nl } = tokens[i];
    if (nl) {
      pushLine = false;
      riLine = false;
      riRecurse = false;
      riForce = false;
      dockerLine = false;
    }
    const n1 = tokens[i + 1]?.t;
    const n2 = tokens[i + 2]?.t;
    if (pushLine && (t.startsWith("--force") || t === "-f")) hit("git-push-force");
    if (dockerLine && t.includes("-a")) hit("docker-prune-all");
    if (riLine) {
      if (t === "-r" || t === "-recurse" || t.startsWith("-r:") || t.startsWith("-recurse:")) riRecurse = true;
      else if (t === "-fo" || t === "-force" || t.startsWith("-fo:") || t.startsWith("-force:")) riForce = true;
      else if (riRecurse && riForce && (t.endsWith("\\") || t.endsWith("/") || t.endsWith("$home") || t.endsWith("$env:userprofile"))) hit("remove-item-broad");
    }
    const name = baseOf(t);
    if (name === "git") {
      if (n1 === "reset" && n2 !== undefined && n2.startsWith("--hard") && (n2.length === 6 || !/\w/.test(n2[6]))) hit("git-reset-hard");
      else if (n1 === "clean" && n2 !== undefined && n2.startsWith("-") && n2.includes("f")) hit("git-clean-force");
      else if (n1 === "checkout" || n1 === "restore") {
        let k = i + 2;
        if (tokens[k]?.t === "--") k += 1;
        if (tokens[k]?.t === "." && tokens[k].op) hit("git-bulk-checkout");
      } else if (n1 === "push") pushLine = true;
    } else if (name === "rm") {
      if (n1 !== undefined && hasRecursiveForce(n1) && n2 !== undefined && BROAD_RM.has(n2)) hit("rm-broad");
    } else if (name === "remove-item") riLine = true;
    else if (name === "docker") {
      if (n1 === "system" && n2 === "prune") dockerLine = true;
    } else if (name === "kubectl") {
      if (n1 === "delete" && n2 !== undefined && /^(?:namespace|ns)(?:\W|$)/.test(n2)) hit("kubectl-delete-namespace");
    } else if (name === "terraform") {
      if (n1 === "destroy") hit("terraform-destroy");
    }
    if ((t === "drop" && (n1 === "database" || n1 === "schema")) || (t === "truncate" && n1 === "table")) hit("sql-destructive");
  }
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
/** `$` followed by one of these starts an expansion the classifier does not follow ($1, $@, $?, $$, $[..] ...). */
const DOLLAR_SPECIAL = /[0-9@*#?!$\-[]/;
const DOLLAR_VAR_SOURCE = "\\$[A-Za-z0-9_{(@*#?!$\\-\\[]";

const PS_ESCAPES = Object.freeze({ n: "\n", r: "\r", t: "\t", 0: "\0", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" });
const psEscape = (ch) => PS_ESCAPES[ch] ?? ch;

/**
 * Decode an ANSI-C quoted string body (the text after `$'`). Returns the value, the index after the closing
 * quote and whether every escape was understood.
 */
function decodeAnsiC(text, start) {
  let out = "";
  let i = start;
  const n = text.length;
  let ok = true;
  let closed = false;
  while (i < n) {
    const c = text[i];
    if (c === "'") {
      closed = true;
      i += 1;
      break;
    }
    if (c !== "\\") {
      out += c;
      i += 1;
      continue;
    }
    const d = text[i + 1];
    if (d === undefined) {
      ok = false;
      i += 1;
      break;
    }
    i += 2;
    const hex = (max) => {
      let digits = "";
      while (digits.length < max && /[0-9a-fA-F]/.test(text[i] ?? "")) {
        digits += text[i];
        i += 1;
      }
      return digits;
    };
    if (d === "a") out += "\x07";
    else if (d === "b") out += "\b";
    else if (d === "e" || d === "E") out += "\x1b";
    else if (d === "f") out += "\f";
    else if (d === "n") out += "\n";
    else if (d === "r") out += "\r";
    else if (d === "t") out += "\t";
    else if (d === "v") out += "\v";
    else if (d === "\\" || d === "'" || d === '"' || d === "?") out += d;
    else if (d === "x" || d === "u" || d === "U") {
      const digits = hex(d === "x" ? 2 : d === "u" ? 4 : 8);
      const code = digits === "" ? NaN : Number.parseInt(digits, 16);
      if (Number.isNaN(code) || code > 0x10ffff || code === 0) {
        ok = false;
        if (digits === "") out += `\\${d}`;
      } else out += String.fromCodePoint(code);
    } else if (d >= "0" && d <= "7") {
      let digits = d;
      while (digits.length < 3 && text[i] >= "0" && text[i] <= "7") {
        digits += text[i];
        i += 1;
      }
      const code = Number.parseInt(digits, 8);
      if (code === 0) ok = false;
      else out += String.fromCharCode(code & 0xff);
    } else if (d === "c") {
      ok = false;
      i += 1;
    } else out += `\\${d}`;
  }
  if (!closed) ok = false;
  return { value: out, end: i, ok, closed };
}

/** PowerShell treats typographic quotes as quotes and en / em dashes (and the horizontal bar) as the parameter dash. */
function normalizePowerShell(text) {
  return text.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"').replace(/[–—―−]/g, "-");
}

/**
 * Split a command into segments of words. Quote-aware: single quotes are literal (PowerShell: `''` is a quote),
 * double quotes allow escapes, an unquoted backslash escapes the next character in `posix` and is literal elsewhere,
 * a backtick escapes in `powershell`, a caret in `cmd`. `$'..'` ANSI-C strings are DECODED and `$"..."` is parsed as
 * a double-quoted string, both reported as problems (never silently trusted). Operators `&& || ; | |& & ( ) newline`
 * end a segment; `<` `>` redirections are captured per segment (`2>&1` is a redirection, not a separator).
 * `$( )`, backticks, process substitution, heredocs, `$1`-style expansions, brace expansion, function definitions
 * and unbalanced quotes are reported in `problems` (the text is still tokenized).
 *
 * @param {string} command
 * @param {{platform?: string, dialect?: "posix"|"powershell"|"cmd"}} [options]  `dialect` defaults to posix, or cmd when `platform` is win32.
 * @returns {{segments: Array<{words: Array<{text: string, quoted: boolean}>, redirects: Array<{op: string, target: string}>, op: string|null, pipedInto: boolean}>, problems: string[]}}
 */
export function tokenize(command, { platform = process.platform, dialect } = {}) {
  const kind = dialect ?? (platform === "win32" ? "cmd" : "posix");
  if (!DIALECTS.includes(kind)) throw new TypeError(`unknown shell dialect '${String(kind)}'`);
  const posix = kind === "posix";
  const ps = kind === "powershell";
  const cmd = kind === "cmd";
  let text = String(command);
  if (ps) text = normalizePowerShell(text);
  const n = text.length;
  const segments = [];
  const problems = [];
  let words = [];
  let redirects = [];
  let current = null;
  let pending = null;
  let before = null; // operator that preceded the segment being built

  const newWord = () => ({ text: "", quoted: false });
  const flushWord = () => {
    if (current === null) return;
    if (pending !== null) {
      redirects.push({ op: pending, target: current.text });
      pending = null;
    } else {
      words.push(current);
    }
    current = null;
  };
  const endSegment = (op) => {
    flushWord();
    if (pending !== null) {
      problems.push("redirection without a target");
      pending = null;
    }
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects, op: before, pipedInto: before === "|" || before === "|&" });
    words = [];
    redirects = [];
    before = op;
  };
  const addProblem = (message) => {
    if (!problems.includes(message)) problems.push(message);
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (ch === "'" && !cmd) {
      current ??= newWord();
      current.quoted = true;
      let from = i + 1;
      let closed = false;
      for (;;) {
        const end = text.indexOf("'", from);
        if (end < 0) break;
        current.text += text.slice(from, end);
        if (ps && text[end + 1] === "'") {
          current.text += "'";
          from = end + 2;
          continue;
        }
        i = end + 1;
        closed = true;
        break;
      }
      if (!closed) {
        addProblem("unbalanced single quote");
        current.text += text.slice(from);
        i = n;
      }
      continue;
    }
    if (ch === '"') {
      current ??= newWord();
      current.quoted = true;
      i += 1;
      let closed = false;
      while (i < n) {
        const c = text[i];
        if (c === '"') {
          if (ps && text[i + 1] === '"') {
            current.text += '"';
            i += 2;
            continue;
          }
          closed = true;
          i += 1;
          break;
        }
        if (c === "\\") {
          const next = text[i + 1];
          // Backslash is an escape only in posix; in PowerShell and cmd it is a literal character and the quote ends the string.
          if (posix && (next === '"' || next === "\\" || next === "$" || next === "`")) {
            current.text += next;
            i += 2;
            continue;
          }
          if (posix && next === "\n") {
            i += 2;
            continue;
          }
          current.text += c;
          i += 1;
          continue;
        }
        if (ps && c === "`") {
          const next = text[i + 1];
          if (next === undefined) {
            current.text += c;
            i += 1;
          } else {
            if (next === "u") addProblem("PowerShell unicode escape");
            current.text += psEscape(next);
            i += 2;
          }
          continue;
        }
        if (c === "$") {
          const next = text[i + 1];
          if (next === "(") addProblem("command substitution $(...)");
          else if (posix && next !== undefined && DOLLAR_SPECIAL.test(next)) addProblem("unsupported $ expansion");
        }
        if (c === "`" && !ps) addProblem("backtick command substitution");
        current.text += c;
        i += 1;
      }
      if (!closed) addProblem("unbalanced double quote");
      continue;
    }
    if (ch === "\\" && posix) {
      const next = text[i + 1];
      if (next === undefined) {
        current ??= newWord();
        current.text += "\\";
        i += 1;
      } else if (next === "\n") {
        i += 2;
      } else if (next === "\r" && text[i + 2] === "\n") {
        i += 3;
      } else {
        current ??= newWord();
        current.text += next;
        current.quoted = true;
        i += 2;
      }
      continue;
    }
    if (ps && ch === "`") {
      const next = text[i + 1];
      if (next === undefined) {
        current ??= newWord();
        current.text += "`";
        i += 1;
      } else if (next === "\n") {
        i += 2;
      } else if (next === "\r" && text[i + 2] === "\n") {
        i += 3;
      } else {
        current ??= newWord();
        if (next === "u") addProblem("PowerShell unicode escape");
        current.text += psEscape(next);
        current.quoted = true;
        i += 2;
      }
      continue;
    }
    if (cmd && ch === "^") {
      const next = text[i + 1];
      if (next === undefined) i += 1;
      else {
        current ??= newWord();
        current.text += next;
        current.quoted = true;
        i += 2;
      }
      continue;
    }
    if (ch === "`") {
      addProblem("backtick command substitution");
      current ??= newWord();
      current.text += ch;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const next = text[i + 1];
      if (next === "'" && posix) {
        const decoded = decodeAnsiC(text, i + 2);
        current ??= newWord();
        current.quoted = true;
        current.text += decoded.value;
        addProblem("ANSI-C quoting $'...'");
        if (!decoded.ok) addProblem("ANSI-C quoting with an escape the guard cannot decode");
        i = decoded.end;
        continue;
      }
      if (next === '"' && posix) {
        addProblem('locale-translated string $"..."');
        i += 1;
        continue;
      }
      if ((next === "'" || next === '"') && !posix) addProblem("unsupported $ quote form");
      if (next === "(") {
        addProblem("command substitution $(...)");
        current ??= newWord();
        current.text += "$(";
        i += 2;
        continue;
      }
      if (posix && next !== undefined && DOLLAR_SPECIAL.test(next)) addProblem("unsupported $ expansion");
    }
    if (ch === "{" && posix && text[i - 1] !== "$") {
      const next = text[i + 1];
      if (next !== undefined && next !== "}" && !isWhite(next) && !isNewline(next)) addProblem("brace expansion");
    }
    if (ps && ch === "]" && text[i + 1] === ":" && text[i + 2] === ":") addProblem("static .NET member call");
    if (ps && (ch === "{" || ch === "}" || (ch === "@" && (text[i + 1] === "(" || text[i + 1] === "{")))) addProblem("PowerShell script block, hash literal or array expression");
    if (ch === "#" && current === null && !cmd) {
      while (i < n && text[i] !== "\n" && text[i] !== "\r") i += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v") {
      flushWord();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      endSegment(null);
      i += 1;
      continue;
    }
    if (ch === ";") {
      endSegment(";");
      i += 1;
      continue;
    }
    if (ch === "(" || ch === ")") {
      if (ch === "(" && posix) {
        let j = i + 1;
        while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
        if (text[j] === ")") addProblem("function definition or empty group");
      }
      endSegment(ch);
      i += 1;
      continue;
    }
    if (ch === "&") {
      if (text[i + 1] === "&") {
        endSegment("&&");
        i += 2;
        continue;
      }
      if (text[i + 1] === ">") {
        flushWord();
        let op = "&>";
        i += 2;
        if (text[i] === ">") {
          op = "&>>";
          i += 1;
        }
        pending = op;
        continue;
      }
      if (ps && current === null && words.length === 0) {
        let j = i + 1;
        while (j < n && (text[j] === " " || text[j] === "\t")) j += 1;
        if (j < n && "({$[".includes(text[j])) addProblem("call operator with a command that is not a literal");
      }
      if (ps) addProblem("PowerShell call or background operator");
      endSegment("&");
      i += 1;
      continue;
    }
    if (ch === "|") {
      if (text[i + 1] === "|") {
        endSegment("||");
        i += 2;
      } else if (text[i + 1] === "&") {
        endSegment("|&");
        i += 2;
      } else {
        endSegment("|");
        i += 1;
      }
      continue;
    }
    if (ch === ">" || ch === "<") {
      if (current !== null && !current.quoted && /^\d+$/.test(current.text)) current = null; // fd prefix: 2>
      flushWord();
      let op = ch;
      i += 1;
      if (ch === "<" && text[i] === "<") {
        op = text[i + 1] === "<" ? "<<<" : "<<";
        i += op.length - 1;
        addProblem(op === "<<<" ? "here-string" : "heredoc");
      } else if (ch === ">" && (text[i] === ">" || text[i] === "|")) {
        op = `>${text[i]}`;
        i += 1;
      } else if (text[i] === "&") {
        op = `${ch}&`;
        i += 1;
      }
      if (text[i] === "(") addProblem("process substitution");
      pending = op;
      continue;
    }
    current ??= newWord();
    current.text += ch;
    i += 1;
  }
  endSegment(null);
  return { segments, problems };
}

// ---------------------------------------------------------------------------------------------
// Tables

/** Lookup table without Object.prototype members (so a command named "constructor" resolves to nothing). */
function nullProto(table) {
  return Object.assign(Object.create(null), table);
}

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "csh", "tcsh"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "{", "}", "&"]);
// There is deliberately NO table of wrapper commands (sudo, env, exec, timeout, stdbuf, nice, ...) and of their value flags:
// a wrapper is simply not in the allow-list, so a segment that starts with one is never understood. The deny floors still
// look behind it (see DEEP_NAMES).
/** Commands that run another command or a script the classifier cannot see into. */
const DYNAMIC_COMMANDS = new Set([
  "start-process", "saps", "start", "invoke-command", "icm", "start-job", "start-threadjob", "new-object", "add-type", "invoke-item", "ii", "invoke-wmimethod", "invoke-cimmethod",
  "wsl", "su", "runas", "busybox", "watch", "parallel", "script", "flock", "unshare", "chroot", "nsenter", "strace", "ltrace", "alias", "function", "trap", "source", ".", "coproc",
]);
/** Interpreters whose inline-code flags run text the guard cannot follow. `leading` flags are only looked for before the script. */
const INLINE_INTERPRETERS = Object.freeze([
  { name: /^(?:node|nodejs|bun)$/, flag: /^(?:-[A-Za-z]*[ep][A-Za-z]*|--eval|--print|--input-type(?:=.*)?)$/, valueFlags: new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "-C", "--conditions"]) },
  { name: /^deno$/, flag: /^eval$/, valueFlags: new Set() },
  { name: /^(?:python[0-9.]*|py|pypy[0-9.]*)$/, flag: /^-[A-Za-z]*c[A-Za-z]*$/, valueFlags: new Set(["-W", "-X"]) },
  { name: /^perl[0-9.]*$/, flag: /^-[A-Za-z]*[eE][A-Za-z]*$/, valueFlags: new Set(["-I", "-M", "-m"]) },
  { name: /^(?:ruby[0-9.]*|jruby)$/, flag: /^-[A-Za-z]*e[A-Za-z]*$/, valueFlags: new Set(["-I", "-r"]) },
  { name: /^php[0-9.]*$/, flag: /^-[A-Za-z]*r[A-Za-z]*$/, valueFlags: new Set(["-d", "-c"]) },
  { name: /^(?:lua[0-9.]*|luajit|rscript|osascript|julia)$/, flag: /^(?:-[A-Za-z]*e[A-Za-z]*|--eval|-E)$/, valueFlags: new Set() },
]);
const REMOVERS = new Set(["rm", "rmdir", "del", "erase", "rd", "ri", "remove-item"]);
const CD_COMMANDS = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
/** Every command that changes the working directory of the shell. The guard never follows one (see DIRECTORY CHANGES in classifyShell). */
const CWD_COMMANDS = new Set([...CD_COMMANDS, "popd", "push-location", "pop-location"]);
const NETWORK_COMMANDS = new Set(["curl", "wget", "invoke-webrequest", "iwr", "invoke-restmethod", "irm", "nc", "ncat", "netcat", "telnet", "ssh", "scp", "sftp", "ftp"]);
const INSTALL_SUBCOMMANDS = nullProto({
  npm: new Set(["install", "i", "add", "ci", "update", "upgrade", "dlx", "exec", "x", "create", "init"]),
  pnpm: new Set(["install", "i", "add", "update", "upgrade", "up", "dlx", "exec", "create"]),
  yarn: new Set(["install", "add", "up", "upgrade", "dlx", "create", "global"]),
  bun: new Set(["install", "i", "add", "update", "x", "create"]),
  pip: new Set(["install", "download"]),
  pip3: new Set(["install", "download"]),
  pipx: new Set(["install", "run", "upgrade"]),
  uv: new Set(["add", "sync", "pip", "tool", "run"]),
  poetry: new Set(["install", "add", "update"]),
  cargo: new Set(["install", "add", "fetch", "update"]),
  go: new Set(["get", "install"]),
  gem: new Set(["install", "update"]),
  bundle: new Set(["install", "update", "add"]),
  composer: new Set(["install", "require", "update"]),
  nuget: new Set(["install", "restore"]),
  apt: new Set(["install", "upgrade", "update"]),
  "apt-get": new Set(["install", "upgrade", "update"]),
  yum: new Set(["install", "update", "upgrade"]),
  dnf: new Set(["install", "update", "upgrade"]),
  apk: new Set(["add", "update", "upgrade"]),
  pacman: new Set(["-s", "-sy", "-syu"]),
  brew: new Set(["install", "upgrade", "update"]),
  choco: new Set(["install", "upgrade"]),
  winget: new Set(["install", "upgrade"]),
  scoop: new Set(["install", "update"]),
  snap: new Set(["install", "refresh"]),
});
const ALWAYS_NETWORK_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
const PUBLISHERS = nullProto({
  npm: new Set(["publish", "unpublish", "deprecate", "dist-tag"]),
  pnpm: new Set(["publish"]),
  yarn: new Set(["publish", "npm"]),
  bun: new Set(["publish"]),
  cargo: new Set(["publish", "yank"]),
  gem: new Set(["push", "yank"]),
  twine: new Set(["upload"]),
  docker: new Set(["push"]),
  terraform: new Set(["apply", "import"]),
  tofu: new Set(["apply", "import"]),
  helm: new Set(["install", "upgrade", "uninstall", "rollback"]),
  kubectl: new Set(["apply", "delete", "rollout", "patch", "replace", "scale", "create"]),
});
const DEPLOYERS = new Set(["vercel", "netlify", "firebase", "fly", "flyctl", "heroku", "wrangler", "pulumi", "serverless", "sls", "cdk", "sam"]);
const DEPLOY_VERBS = new Set(["deploy", "up", "publish", "release"]);
const FILE_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "type", "ls", "dir", "cp", "mv", "rm", "rmdir", "del", "erase", "rd", "ri", "mkdir", "md", "touch", "tee", "chmod", "chown", "ln",
  "stat", "wc", "sort", "diff", "cmp", "source", ".", "cd", "pushd", "chdir", "set-location", "sl", "get-content", "gc", "set-content", "add-content", "get-childitem", "gci",
  "copy", "move", "copy-item", "move-item", "remove-item", "new-item", "out-file", "install", "truncate", "xcopy", "robocopy", "tee-object", "rename-item", "ren", "rename", "clear-content", "set-item",
]);
const WRITERS = new Set([
  "rm", "rmdir", "del", "erase", "rd", "ri", "cp", "mv", "mkdir", "md", "touch", "tee", "chmod", "chown", "ln", "set-content", "add-content", "copy", "move", "copy-item", "move-item",
  "remove-item", "new-item", "out-file", "install", "truncate", "xcopy", "robocopy", "tee-object", "rename-item", "ren", "rename", "clear-content", "set-item",
]);
/** Writers that create a path rather than change an existing one (so `mkdir .claude` is fine, `mv .claude x` is not). */
const CREATORS = new Set(["mkdir", "md", "touch", "new-item"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "rev-parse", "ls-files", "blame", "describe", "shortlog", "rev-list", "cat-file", "ls-tree", "grep"]);
const READ_BRANCH_FLAGS = /^(?:-a|-r|-v|-vv|-l|--(?:all|remotes|verbose|list|show-current|no-color|color|merged|no-merged|contains|no-contains)(?:=.*)?|--(?:format|sort)=.*)$/;
const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/stdin", "/dev/tty", "nul", "$null", "con"]);
const ENV_DUMPERS = new Set(["printenv"]);

/** `git -c key=value` / `git config key value` keys that cannot run commands, redirect remotes or change what a push updates. */
const GIT_CONFIG_SAFE = /^(?:user\.(?:name|email)|core\.(?:quotepath|autocrlf|safecrlf|eol|longpaths|filemode|ignorecase|precomposeunicode|abbrev|whitespace)|color\.[a-z.-]+|advice\.[a-z]+|init\.defaultbranch|pull\.(?:rebase|ff)|fetch\.prune|diff\.(?:renames|algorithm|context)|log\.(?:abbrevcommit|date)|status\.(?:short|branch|showuntrackedfiles)|commit\.gpgsign)$/i;
/** Environment variables whose assignment changes what a program executes or loads. */
const DANGEROUS_ENV = /^(?:GIT_(?!(?:AUTHOR|COMMITTER)_(?:NAME|EMAIL|DATE)$|TERMINAL_PROMPT$|OPTIONAL_LOCKS$)|LD_|DYLD_|BASH_ENV$|ENV$|PAGER$|MANPAGER$|EDITOR$|VISUAL$|PROMPT_COMMAND$|SHELLOPTS$|BASHOPTS$|PS4$|IFS$|PATH$|CDPATH$|NODE_OPTIONS$|NODE_PATH$|PYTHON(?:STARTUP|PATH|HOME)$|PERL5?OPT$|PERL5LIB$|RUBYOPT$|RUBYLIB$|HOME$|XDG_CONFIG_HOME$|SSH_ASKPASS$|SSH_AUTH_SOCK$|ASTERWEAVE_|CLAUDE_PROJECT_DIR$)/i;

/** Basenames that hold secrets. `.env.example`-style templates are deliberately not secrets. */
const SECRET_BASENAME = new RegExp(
  [
    "^\\.env(?:\\..+)?$",
    "^\\.envrc$",
    "^\\.netrc$|^_netrc$",
    "^\\.npmrc$|^\\.pypirc$|^\\.pgpass$|^\\.htpasswd$|^\\.dockercfg$|^\\.git-credentials$",
    "^id_(?:rsa|dsa|ecdsa|ed25519)$",
    "^credentials(?:\\.json)?$",
    "^secrets?\\.(?:json|ya?ml|toml|env)$",
    "^service-account.*\\.json$",
    "\\.(?:pem|key|pfx|p12|ppk|keystore|jks)$",
  ].join("|"),
  "i",
);
const ENV_TEMPLATE = /^\.env\.(?:example|sample|template|dist|defaults|schema)$/i;
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".azure", ".kube", ".gcloud"]);
const HOME_SECRET_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", path.join(".config", "gh"), path.join(".config", "gcloud")];
/** Representative secret names a glob is tested against when the directory cannot be listed. */
const SECRET_SAMPLES = Object.freeze([
  ".env", ".env.local", ".env.production", ".envrc", ".netrc", ".npmrc", ".pypirc", ".pgpass", ".htpasswd", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  "credentials", "credentials.json", "secrets.json", "secret.yaml", "service-account.json", "server.pem", "tls.key", "cert.pfx", "cert.p12", "key.ppk", "store.keystore", "store.jks",
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".gcloud",
]);
const GLOB_CHARS = /[*?[]/;
const PLAIN_ABSOLUTE = /^\/[\w.@+-]+(?:\/[\w.@+-]*)*$/;
/** First components that make a plain absolute text a path to something on this machine (an unknown one such as /api/users is more likely a URL path or a pattern). */
const OS_ROOTS = new Set(["etc", "tmp", "usr", "var", "home", "root", "opt", "mnt", "proc", "sys", "dev", "bin", "sbin", "lib", "lib64", "srv", "boot", "run", "private", "Users", "Volumes", "media", "snap"]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9]|conin\$|conout\$)$/i;


// Repository hook mechanisms. `git commit` and `git push` (allowed forms) run the hooks the repository configures, and the agent can
// write files, so whatever configures or holds those hooks is protected like `.git/hooks`: hook-manager directories and configuration
// (husky, lefthook, pre-commit, plain `.githooks`), `.gitattributes`, and the directory named by `core.hooksPath` (read once per
// classification, see `hooksPathOf`). NOT protected: `package.json` (lint-staged / simple-git-hooks configuration lives there and stays an
// execution path: see docs/cli/policy-and-guards.md); a REAL dispatcher must run git with `-c core.hooksPath=<empty dir>`.
const HOOK_DIRS = new Set([".husky", ".githooks", ".git-hooks", ".lefthook", ".lefthook-local"]);
const HOOK_FILES = /^(?:\.?lefthook(?:-local)?\.(?:ya?ml|json|toml)|\.pre-commit-config\..+|\.gitattributes|\.lintstagedrc.*|lint-staged\.config\..+|\.huskyrc.*|\.overcommit\.ya?ml|\.simple-git-hooks\..+|simple-git-hooks\..+)$/;
/** Markers of a git directory (a bare repository): git accepts a directory as one when it holds a HEAD file, an `objects` and a `refs` directory. */
const GIT_DIR_MARKERS = Object.freeze(["head", "objects", "refs"]);
/** Entries of a git directory whose content decides what git runs (`hooks/*`) or where it goes (`config`, `packed-refs`). */
const GIT_DIR_CONTROL = new Set(["hooks", "config", "packed-refs"]);
/** Names git looks for in a hooks directory (used only when `core.hooksPath` is the workspace root itself, so the root is not wholly protected). */
const GIT_HOOK_NAMES = new Set([
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push",
  "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change",
]);

const isSecretName = (name) => SECRET_DIRS.has(name.toLowerCase()) || (!ENV_TEMPLATE.test(name) && SECRET_BASENAME.test(name));

/** Wildcard match (`*`, `?`, `[...]`) in O(pattern * name); no regular expression, so no backtracking blow-up. */
function globTest(pattern, name, fold, dotRule) {
  const a = fold ? pattern.toLowerCase() : pattern;
  const s = fold ? name.toLowerCase() : name;
  if (dotRule && s.startsWith(".") && !a.startsWith(".")) return false; // POSIX globs skip dotfiles unless the pattern names the dot
  let pi = 0;
  let si = 0;
  let star = -1;
  let mark = 0;
  const classAt = (at) => {
    // returns {matches(ch), next} for a bracket expression starting at a[at] === "[", or null when unclosed
    let k = at + 1;
    let negate = false;
    if (a[k] === "!" || a[k] === "^") {
      negate = true;
      k += 1;
    }
    const start = k;
    const items = [];
    for (; k < a.length; k += 1) {
      if (a[k] === "]" && k > start) return { next: k + 1, matches: (ch) => items.some(([lo, hi]) => ch >= lo && ch <= hi) !== negate };
      if (a[k + 1] === "-" && a[k + 2] !== undefined && a[k + 2] !== "]") {
        items.push([a[k], a[k + 2]]);
        k += 2;
      } else items.push([a[k], a[k]]);
    }
    return null;
  };
  while (si < s.length) {
    const c = a[pi];
    if (c === "*") {
      star = pi;
      mark = si;
      pi += 1;
      continue;
    }
    let advance = false;
    if (c === "?") {
      pi += 1;
      advance = true;
    } else if (c === "[") {
      const cls = classAt(pi);
      if (cls !== null && cls.matches(s[si])) {
        pi = cls.next;
        advance = true;
      } else if (cls === null && s[si] === "[") {
        pi += 1;
        advance = true;
      }
    } else if (c !== undefined && c === s[si]) {
      pi += 1;
      advance = true;
    }
    if (advance) {
      si += 1;
      continue;
    }
    if (star < 0) return false;
    mark += 1;
    si = mark;
    pi = star + 1;
  }
  while (a[pi] === "*") pi += 1;
  return pi === a.length;
}

// ---------------------------------------------------------------------------------------------
// The allow-list: command forms the classifier FULLY understands. Pure functions over the already de-escaped words of one
// segment. They answer `{ok: false}` for anything that is not exactly an allow-listed command with allow-listed flags;
// the caller turns that into UNPARSEABLE_COMMAND (unless the user's policy.json lists the command in `allowCommands`).

/** Does `arg` look like a flag in this spec/dialect? A leading `/` is a flag only for the Windows commands that use it. */
function flagLike(arg, spec, dialect) {
  if (arg.length < 2) return false;
  if (arg[0] === "-") return true;
  return spec.slash === true && dialect !== "posix" && /^\/[A-Za-z?]/.test(arg);
}

/**
 * Split `args` into flags (checked against the spec) and operands.
 * @returns {{operands: string[], values: string[], seen: Set<string>} | null} null when a flag is not allow-listed
 */
function parseOperands(args, spec, dialect) {
  const operands = [];
  const values = [];
  const seen = new Set();
  let afterDashes = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!afterDashes && arg === "--") {
      afterDashes = true;
      continue;
    }
    if (afterDashes || !flagLike(arg, spec, dialect)) {
      operands.push(arg);
      continue;
    }
    if (spec.valued?.has(arg)) {
      if (i + 1 >= args.length) return null;
      seen.add(arg);
      values.push(args[i + 1]);
      i += 1;
      continue;
    }
    if (spec.flags?.test(arg)) {
      seen.add(arg);
      continue;
    }
    return null;
  }
  return { operands, values, seen };
}

// No recursive listing (-R / --recursive): it walks every sub-directory, links included, far beyond the operand the guard checked.
const LS_FLAGS = /^(?:-[1aAdFhHlLrStx]+|--(?:all|almost-all|human-readable|classify|directory|reverse|color(?:=(?:auto|always|never))?))$/;
// cmd `dir`: only the bare format switch `/b` (names only). `/s` recurses, `/a`, `/o`, `/q` ... list more than the operand the guard checked.
const WIN_DIR_FLAGS = /^\/[bB]$/;

/** Read-only commands of the posix / cmd world. `paths`: how operands are used ("all" = every operand is a file, "pattern" = first is a pattern). */
const READ_SPECS = nullProto({
  ls: { flags: LS_FLAGS, paths: "all" },
  dir: { flags: new RegExp(`(?:${LS_FLAGS.source})|(?:${WIN_DIR_FLAGS.source})`), slash: true, paths: "all" },
  cat: { flags: /^-[AbEnstTv]+$/, paths: "all", stdin: true },
  type: { flags: /^$/, paths: "all" },
  head: { flags: /^-(?:[qv]+|\d+|[nc]\d+)$/, valued: new Set(["-n", "-c"]), paths: "all", stdin: true },
  tail: { flags: /^-(?:[qv]+|\d+|[nc]\d+)$/, valued: new Set(["-n", "-c"]), paths: "all", stdin: true },
  wc: { flags: /^-[lwcmL]+$/, paths: "all", stdin: true },
  grep: { flags: /^(?:-[ivnclLwxEFHhoqsIa]+|-[ABCm]\d+)$/, valued: new Set(["-e", "-m", "-A", "-B", "-C"]), paths: "pattern", stdin: true },
  // There is deliberately NO `findstr`: `/f:file`, `/g:file` and `/d:dirs` read file NAMES or search strings from a file, and Git Bash rewrites `//f:x` to `/f:x`,
  // so the operands the guard checked are not the files the command reads. Unknown commands are asked about.
});

/** PowerShell parameters every cmdlet has; only used to detect an ambiguous abbreviation, never allowed. */
const PS_COMMON = ["verbose", "debug", "erroraction", "warningaction", "informationaction", "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable", "whatif", "confirm", "progressaction"];

/** `params`: every parameter of the cmdlet (v = takes a value, s = switch); `allowed`: the ones the guard understands. */
const PS_CMDLETS = nullProto({
  "get-childitem": {
    aliases: ["gci", "ls", "dir"], positional: ["path"], pathParams: ["path", "literalpath"],
    params: { path: "v", literalpath: "v", filter: "v", include: "v", exclude: "v", recurse: "s", depth: "v", force: "s", name: "s", attributes: "v", directory: "s", file: "s", hidden: "s", readonly: "s", system: "s", followsymlink: "s", usetransaction: "s" },
    // -Recurse / -Depth walk every sub-directory (junctions and links included) and -Force lists hidden and system items: unbounded or hidden
    // listings are not understood (they ask), only the directory the guard checked is listed.
    allowed: ["path", "literalpath", "filter", "include", "exclude", "name", "directory", "file"],
  },
  "get-content": {
    aliases: ["gc", "cat", "type"], positional: ["path"], pathParams: ["path", "literalpath"],
    params: { path: "v", literalpath: "v", readcount: "v", totalcount: "v", tail: "v", wait: "s", encoding: "v", delimiter: "v", raw: "s", filter: "v", include: "v", exclude: "v", force: "s", credential: "v", stream: "v", asbytestream: "s", head: "v", first: "v", last: "v", usetransaction: "s" },
    allowed: ["path", "literalpath", "totalcount", "tail", "head", "first", "last", "raw", "encoding"],
  },
  "select-string": {
    aliases: ["sls"], positional: ["pattern", "path"], pathParams: ["path", "literalpath"],
    params: { pattern: "v", path: "v", literalpath: "v", simplematch: "s", casesensitive: "s", context: "v", list: "s", quiet: "s", notmatch: "s", encoding: "v", inputobject: "v", allmatches: "s", include: "v", exclude: "v", culture: "v", raw: "s", noemphasis: "s" },
    allowed: ["pattern", "path", "literalpath", "simplematch", "casesensitive", "context", "list", "quiet", "notmatch", "encoding", "allmatches"],
  },
  "get-location": { aliases: ["gl", "pwd"], positional: [], pathParams: [], params: { psprovider: "v", psdrive: "v", stack: "s", stackname: "v", usetransaction: "s" }, allowed: [] },
  "get-item": {
    aliases: ["gi"], positional: ["path"], pathParams: ["path", "literalpath"],
    params: { path: "v", literalpath: "v", filter: "v", include: "v", exclude: "v", force: "s", credential: "v", stream: "v", usetransaction: "s" },
    allowed: ["path", "literalpath"],
  },
  "test-path": {
    aliases: [], positional: ["path"], pathParams: ["path", "literalpath"],
    params: { path: "v", literalpath: "v", filter: "v", include: "v", exclude: "v", pathtype: "v", isvalid: "s", credential: "v", olderthan: "v", newerthan: "v", usetransaction: "s" },
    allowed: ["path", "literalpath", "pathtype"],
  },
  "write-output": { aliases: ["echo", "write"], positional: [], rest: true, pathParams: [], params: { inputobject: "v", noenumerate: "s" }, allowed: ["inputobject", "noenumerate"] },
  "set-location": {
    aliases: ["sl", "cd", "chdir"], positional: ["path"], pathParams: ["path", "literalpath"],
    params: { path: "v", literalpath: "v", passthru: "s", stackname: "v", usetransaction: "s" },
    allowed: ["path", "literalpath"],
  },
});
const PS_ALIASES = nullProto({});
for (const [cmdlet, spec] of Object.entries(PS_CMDLETS)) {
  PS_ALIASES[cmdlet] = cmdlet;
  for (const alias of spec.aliases) PS_ALIASES[alias] = cmdlet;
}

/** Names that mean one thing in a posix / cmd shell and another in PowerShell: the dialect decides which parser applies. */
const SHARED_NAMES = new Set(["ls", "dir", "cat", "type", "echo", "pwd", "cd", "chdir"]);

function resolvePsParameter(spec, name) {
  const all = [...Object.keys(spec.params), ...PS_COMMON];
  if (all.includes(name)) return name;
  const candidates = all.filter((entry) => entry.startsWith(name));
  return candidates.length === 1 ? candidates[0] : null;
}

/** A PowerShell cmdlet with allow-listed parameters (unique abbreviations only). Returns the file operands or null. */
function parsePowerShell(cmdlet, args) {
  const spec = PS_CMDLETS[cmdlet];
  const allowed = new Set(spec.allowed);
  const paths = [];
  const named = new Set();
  const operands = [];
  const addPaths = (value) => {
    for (const part of value.split(",")) if (part !== "") paths.push(part);
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const match = /^-([A-Za-z]+)(?::(.*))?$/.exec(arg);
    if (match === null) {
      if (arg.length > 1 && arg[0] === "-") return null;
      operands.push(arg);
      continue;
    }
    const key = resolvePsParameter(spec, match[1].toLowerCase());
    if (key === null || !allowed.has(key)) return null;
    named.add(key);
    if (spec.params[key] === "v") {
      let value = match[2];
      if (value === undefined) {
        value = args[i + 1];
        i += 1;
        if (value === undefined) return null;
      }
      if (spec.pathParams.includes(key)) addPaths(value);
    } else if (match[2] !== undefined) return null;
  }
  for (let j = 0; j < operands.length; j += 1) {
    const bound = spec.positional[j];
    if (bound === undefined) {
      if (spec.rest === true) continue;
      return null;
    }
    if (named.has(bound)) return null;
    if (spec.pathParams.includes(bound)) addPaths(operands[j]);
  }
  return { paths };
}

const GIT_DIFF_FLAGS = /^(?:--(?:oneline|stat|shortstat|numstat|name-only|name-status|summary|no-color|graph|decorate|no-decorate|cached|staged|patch|no-patch|abbrev-commit|no-merges|merges|all|branches|first-parent|follow|reverse|date-order|topo-order|full-history|minimal|ignore-all-space|ignore-space-change|exit-code|quiet|check|no-ext-diff|no-textconv|raw|compact-summary|root)|--(?:color|word-diff|decorate|abbrev|find-renames|diff-algorithm)(?:=[A-Za-z0-9-]*)?|--(?:max-count|unified|since|until|after|before|author|committer|grep|format|pretty|date|diff-filter|stat-width)=[^\s]*|-(?:[pswbuz]+|\d+|n\d+|U\d+|M\d*|C\d*|S.+|G.+))$/;
const GIT_REF = /^[\w.\/@^~:+,=#*?-]+$/;

/** One read-only git subcommand: allow-listed flags, ref/path operands only. */
const GIT_READ = nullProto({
  status: { flags: /^(?:-[sbzv]+|-u(?:no|normal|all)?|--(?:short|branch|porcelain(?:=v[12])?|long|verbose|null|ahead-behind|no-ahead-behind|untracked-files(?:=(?:no|normal|all))?))$/ },
  log: { flags: GIT_DIFF_FLAGS, valued: new Set(["-n"]) },
  diff: { flags: GIT_DIFF_FLAGS, valued: new Set(["-n"]) },
  show: { flags: GIT_DIFF_FLAGS, valued: new Set(["-n"]) },
  "rev-parse": { flags: /^--(?:short(?:=\d+)?|abbrev-ref(?:=\w+)?|show-toplevel|git-dir|absolute-git-dir|git-common-dir|is-inside-work-tree|is-inside-git-dir|is-bare-repository|verify|quiet|symbolic-full-name|symbolic|show-prefix|show-cdup|sq|revs-only|no-revs|flags|no-flags)$/ },
  "ls-files": { flags: /^(?:-[cdmosuzkt]+|--(?:cached|deleted|modified|others|stage|unmerged|killed|exclude-standard|full-name|error-unmatch|directory|no-empty-directory|eol|deduplicate|abbrev(?:=\d+)?))$/ },
  blame: { flags: /^(?:-[lsweptbcfn]+|--(?:porcelain|line-porcelain|incremental|show-email|show-name|show-number|root|first-parent|minimal|abbrev=\d+))$/, valued: new Set(["-L"]) },
  describe: { flags: /^--(?:tags|always|long|dirty|all|first-parent|abbrev=\d+|candidates=\d+|exact-match|contains)$/ },
});
const GIT_COMMIT_VALUE_FLAGS = new Set(["-m", "-am"]);

/**
 * Understood forms of `git`. `args` start at the SUBCOMMAND: global options (-C, -c, --git-dir ...) are never understood.
 * `remoteOk(name)` answers whether `name` is a remote CONFIGURED in the verified workspace repository (and not also the name of something in the
 * workspace): git treats any other word as a path and runs the receive-pack hooks of the repository found there.
 * `hooksOk()` answers whether the meaning of `core.hooksPath` is known (commit and push run hooks).
 */
function understoodGit(args, { remoteOk = () => false, hooksOk = () => true } = {}) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === undefined || sub.startsWith("-")) return { ok: false };
  if (sub === "commit") {
    let messages = 0;
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (GIT_COMMIT_VALUE_FLAGS.has(arg)) {
        if (i + 1 >= rest.length) return { ok: false };
        messages += 1;
        i += 1;
      } else if (arg.startsWith("--message=")) messages += 1;
      else if (arg !== "-a" && arg !== "--all") return { ok: false };
    }
    // A commit runs the hooks: it is only understood when the meaning of core.hooksPath is known (hooksOk).
    return messages > 0 && hooksOk() ? { ok: true, readOnly: false, refs: [] } : { ok: false };
  }
  if (sub === "push") {
    const operands = rest.filter((arg) => arg !== "-u" && arg !== "--set-upstream");
    if (rest.some((arg) => arg.startsWith("-") && arg !== "-u" && arg !== "--set-upstream")) return { ok: false };
    const [remote, branch] = operands;
    const shaped = operands.length === 2 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) && (branch === "HEAD" || (/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes("..") && !branch.startsWith("refs/") && !branch.startsWith("tags/")));
    // The remote must be a configured one: `git push x feat` with an unconfigured `x` is a push to the local path `x`, which runs that repository's hooks.
    return shaped && remoteOk(remote) && hooksOk() ? { ok: true, readOnly: false, refs: [] } : { ok: false };
  }
  if (sub === "branch") {
    const listing = rest.some((arg) => arg === "--list" || arg === "-l");
    const parsed = parseOperands(rest, { flags: /^(?:-[avrl]+|-vv|--(?:all|remotes|verbose|list|show-current|no-color|color(?:=(?:always|never|auto))?|ignore-case))$/, valued: new Set(["--contains", "--merged", "--no-merged", "--points-at"]) }, "posix");
    if (parsed === null || parsed.operands.some((operand) => !GIT_REF.test(operand))) return { ok: false };
    return parsed.operands.length > 0 && !listing ? { ok: false } : { ok: true, readOnly: true, refs: [...parsed.operands, ...parsed.values] };
  }
  if (sub === "tag") {
    const listing = rest[0] === "--list" || rest[0] === "-l";
    if (rest.length === 0) return { ok: true, readOnly: true, refs: [] };
    return listing && rest.slice(1).every((arg) => GIT_REF.test(arg) && !arg.startsWith("-")) ? { ok: true, readOnly: true, refs: rest.slice(1) } : { ok: false };
  }
  if (sub === "remote") {
    if (rest.length === 0 || (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose"))) return { ok: true, readOnly: true, refs: [] };
    return rest.length === 2 && rest[0] === "get-url" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(rest[1]) ? { ok: true, readOnly: true, refs: [] } : { ok: false };
  }
  if (sub === "config") {
    // Only `git config [--local|--global] --get|--get-all <key>` for a key of the small GIT_CONFIG_SAFE list (user.name, user.email, core.autocrlf ...).
    // Every other key, scope flag (--system, --file, --worktree, --show-origin ...) and listing form (--get-regexp, --list) is asked about: a deny-list of
    // secret-looking keys is never complete (sendemail.smtppass, http.proxy, http.extraheader and core.sshcommand can all hold credentials).
    // (`git remote -v` and `remote get-url` print remote URLs, which can embed credentials, and stay allowed: see the residual risks in the docs.)
    const scopes = rest.filter((arg) => arg === "--local" || arg === "--global");
    const others = rest.filter((arg) => arg !== "--local" && arg !== "--global");
    const good = scopes.length <= 1 && others.length === 2 && (others[0] === "--get" || others[0] === "--get-all") && GIT_CONFIG_SAFE.test(others[1]);
    return good ? { ok: true, readOnly: true, refs: [] } : { ok: false };
  }
  const spec = GIT_READ[sub];
  if (spec === undefined) return { ok: false };
  const parsed = parseOperands(rest, spec, "posix");
  if (parsed === null || parsed.operands.some((operand) => !GIT_REF.test(operand) || operand.startsWith("-"))) return { ok: false };
  return { ok: true, readOnly: true, refs: parsed.operands };
}

// Only the text of the pull request and its base branch. NOT allowed (asked about): --head / -H (opens the PR from any branch or fork), --repo / -R, --web,
// --template, --body-file / -F (read a file), and labels, reviewers, assignees, milestones and projects.
const GH_PR_CREATE_VALUED = new Set(["--title", "-t", "--body", "-b", "--base", "-B"]);
const GH_PR_CREATE_SWITCHES = new Set(["--draft", "-d", "--fill", "-f", "--fill-first", "--dry-run"]);

function understoodGh(args) {
  if (args[0] !== "pr" || args[1] !== "create") return { ok: false };
  const rest = args.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (GH_PR_CREATE_VALUED.has(arg)) {
      if (i + 1 >= rest.length) return { ok: false };
      i += 1;
    } else if (!GH_PR_CREATE_SWITCHES.has(arg) && !/^--(?:title|body|base)=/.test(arg)) return { ok: false };
  }
  return { ok: true, readOnly: false, refs: [] };
}

/**
 * Is this command a form the classifier fully understands?
 * @param {string} key  the command word, lower-cased, exactly as typed (no path, no extension)
 * @param {string[]} args @param {{dialect: string, pipedInto: boolean}} context
 * @returns {{ok: false} | {ok: true, readOnly: boolean, paths: string[], refs: string[], pattern?: string[]}}
 */
function understoodForm(key, args, { dialect, pipedInto, remoteOk, hooksOk, cwdOk = () => true, cdOk = () => false }) {
  if (args.some((arg) => hasVariable(arg) || (dialect === "powershell" && /^@\w/.test(arg)))) return { ok: false };
  if (key === "git") {
    const git = understoodGit(args, { remoteOk, hooksOk });
    // cwdOk(): the workspace root is a repository git can be run in and git discovery from the working directory reaches it (N1 / F5, see gitProblem).
    return git.ok && cwdOk() ? { ...git, paths: [] } : { ok: false };
  }
  if (key === "gh") {
    const gh = understoodGh(args);
    return gh.ok && cwdOk() ? { ...gh, paths: [] } : { ok: false }; // gh runs git in the working directory: the same rule
  }
  const cmdlet = PS_ALIASES[key];
  if (cmdlet !== undefined && (dialect === "powershell" || !SHARED_NAMES.has(key))) {
    const parsed = parsePowerShell(cmdlet, args);
    if (parsed === null) return { ok: false };
    // Get-Content needs a path; Select-String may read the pipeline.
    if ((cmdlet === "get-content" || cmdlet === "select-string") && parsed.paths.length === 0 && !(cmdlet === "select-string" && pipedInto)) return { ok: false };
    // A directory change is understood only as a LONE command with a plain in-workspace operand (cdOk, see cdOperandProblem): `cd -`, wildcards, CDPATH ...
    if (cmdlet === "set-location" && (parsed.paths.length !== 1 || !cdOk(parsed.paths[0]))) return { ok: false };
    return { ok: true, readOnly: cmdlet !== "set-location", paths: parsed.paths, refs: [], cd: cmdlet === "set-location", ps: true };
  }
  if (key === "pwd") return args.length === 0 || (args.length === 1 && /^-[LP]$/.test(args[0])) ? { ok: true, readOnly: true, paths: [], refs: [] } : { ok: false };
  if (key === "echo") return { ok: true, readOnly: true, paths: [], refs: [] };
  if (key === "cd" || key === "chdir") {
    const parsed = parseOperands(args, { flags: /^$/ }, dialect);
    return parsed !== null && parsed.operands.length === 1 && cdOk(parsed.operands[0]) ? { ok: true, readOnly: false, paths: parsed.operands, refs: [], cd: true } : { ok: false };
  }
  const spec = READ_SPECS[key];
  if (spec === undefined) return { ok: false };
  const parsed = parseOperands(args, spec, dialect);
  if (parsed === null) return { ok: false };
  let operands = parsed.operands;
  const pattern = [];
  if (spec.paths === "pattern") {
    const explicit = parsed.seen.has("-e");
    if (!explicit) {
      if (operands.length === 0) return { ok: false };
      pattern.push(operands[0]);
      operands = operands.slice(1);
    }
  }
  if (operands.length === 0 && spec.stdin === true && !pipedInto) return { ok: false };
  if (key === "type" && operands.length === 0) return { ok: false };
  return { ok: true, readOnly: true, paths: operands, refs: [], pattern };
}

/**
 * Does `words` start with one of the user's `allowCommands` argv prefixes (exact, case-sensitive word comparison)?
 *
 * OPTION RULE: after the listed prefix, no further word may start with `-` (an option such as `npm test --script-shell=calc.exe`,
 * `node --test --import data:...`, `npm test --prefix=...` changes what the listed program runs or loads), unless that exact option is
 * part of the listed prefix itself. Positional words are fine (the path / secret floors still apply to them). A bare `--` ends the
 * options: what follows is passed on to the program's own script (`npm test -- --watch=false`, `cargo test -- --nocapture`) and is
 * not read as an option of the listed program.
 */
function matchesAllowCommand(words, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((pattern) => {
    if (!Array.isArray(pattern) || pattern.length === 0 || pattern.length > words.length) return false;
    if (!pattern.every((part, index) => typeof part === "string" && words[index] === part)) return false;
    for (let at = pattern.length; at < words.length; at += 1) {
      if (words[at] === "--") break;
      if (words[at].startsWith("-")) return false;
    }
    return true;
  });
}

/** Names whose analyzers can find a deny floor; they are also run on later words of a segment that is NOT understood (`exec -a x git push ...`). */
const DEEP_NAMES = new Set([
  "git", "gh", "find", "dd", "sed", "docker", "kubectl", "terraform", "tofu", "az", "gcloud", "aws", "dotnet", "asterweave",
  ...REMOVERS, ...WRITERS, ...NETWORK_COMMANDS, ...ALWAYS_NETWORK_RUNNERS, ...DEPLOYERS, ...Object.keys(PUBLISHERS), ...Object.keys(INSTALL_SUBCOMMANDS),
]);

// ---------------------------------------------------------------------------------------------
// Path resolution helpers

function defaultRealpath(platform) {
  return platform === process.platform ? (value) => (nodeFs.realpathSync.native ?? nodeFs.realpathSync)(value) : (value) => value;
}

/**
 * Path helpers. The one rule that matters: NOTHING touches the file system (or the network, which on Windows is the same
 * call for a UNC path) for text that is not lexically inside one of the workspace roots registered with `setRoots`.
 * Such text is decided by TEXT alone (it is outside the workspace). Inside the roots, a path is resolved with realpath of
 * its nearest existing ancestor and, when that fails, by following a symbolic link even when it dangles (lstat + readlink).
 * Every file-system call goes through the caller's counted wrappers, and a BudgetError is never swallowed here.
 */
function createPathTools({ platform, realpath, lstat, readlink, homedir }) {
  const win = platform === "win32";
  const p = win ? path.win32 : path.posix;
  const home = typeof homedir === "function" ? homedir() : homedir ?? osHomedir();
  const cache = new Map();
  const links = new Map();
  let roots = [];
  const fold = (value) => (win ? value.toLowerCase() : value);
  const inside = (root, target) => {
    const relative = p.relative(fold(root), fold(target));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
  };
  const eligible = (absolute) => roots.some((root) => inside(root, absolute));
  const rawReal = (value) => {
    if (cache.has(value)) return cache.get(value);
    let result;
    try {
      result = realpath(value);
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      result = null;
    }
    cache.set(value, result);
    return result;
  };
  /** The target text of a symbolic link (also a dangling one), or null when `value` is not a link or does not exist. */
  const linkTarget = (value) => {
    if (links.has(value)) return links.get(value);
    let result = null;
    try {
      const stat = lstat(value);
      if (stat?.isSymbolicLink?.() === true) result = String(readlink(value));
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      result = null;
    }
    links.set(value, result);
    return result;
  };
  /** realpath of a path that is lexically inside the workspace roots; `null` for anything else (no file-system call is made). */
  const tryReal = (value) => (eligible(value) ? rawReal(value) : null);
  /**
   * Real location of `absolute`: realpath of the nearest existing ancestor plus the remaining (not yet existing) tail, following
   * a dangling link at any level. Text outside the roots is returned as it is (lexical) without any file-system call, unless `trusted`
   * (the workspace root, the user directory and the home directory come from the caller, not from the command).
   */
  const realResolve = (absolute, { trusted = false, hops = 0 } = {}) => {
    let current = absolute;
    const tail = [];
    for (;;) {
      if (!trusted && !eligible(current)) return tail.length > 0 ? p.join(current, ...tail.reverse()) : current;
      const real = rawReal(current);
      if (real !== null) return tail.length > 0 ? p.join(real, ...tail.reverse()) : real;
      const target = trusted ? null : linkTarget(current);
      if (target !== null) {
        if (hops >= MAX_LINK_HOPS) throw new BudgetError("too many symbolic links");
        const base = realResolve(p.resolve(p.dirname(current), target), { trusted, hops: hops + 1 });
        return tail.length > 0 ? p.join(base, ...tail.reverse()) : base;
      }
      const parent = p.dirname(current);
      if (parent === current) return absolute;
      tail.push(p.basename(current));
      current = parent;
    }
  };
  const trimSeparators = (value) => {
    let end = value.length;
    while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;
    return value.slice(0, end);
  };
  const same = (a, b) => fold(trimSeparators(p.normalize(a))) === fold(trimSeparators(p.normalize(b)));
  const HOME_VAR = /^(?:\$\{?HOME\}?|\$\{?USERPROFILE\}?|\$env:(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)(?=$|[\\/])/i;
  const ANY_VAR = new RegExp(`${DOLLAR_VAR_SOURCE}|%[A-Za-z_][A-Za-z0-9_]*%|\\$env:`);
  /**
   * Expand `~` and the home variables; unresolved when the text contains another variable or `~user`.
   * @returns {{path: string} | {unresolved: string}}
   */
  const expand = (text, cwd, { literal = false } = {}) => {
    if (literal) return { path: p.resolve(cwd, text) }; // a tool path: `$`, `%` and `~` are ordinary characters
    let value = text;
    if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) value = home + value.slice(1);
    else if (value.startsWith("~")) return { unresolved: "~user" };
    else {
      const match = HOME_VAR.exec(value);
      if (match) value = home + value.slice(match[0].length);
    }
    if (ANY_VAR.test(value)) return { unresolved: "variable" };
    return { path: p.resolve(cwd, value) };
  };
  return { p, win, home, tryReal, realResolve, inside, same, expand, fold, eligible, setRoots: (list) => { roots = list; } };
}

// ---------------------------------------------------------------------------------------------
// Classification

/**
 * Run git without a shell and with the same hardening as src/repo.mjs: minimal environment (no GIT_* variables, no
 * tokens), no optional locks, no fsmonitor, no hooks, no pager, no `ext::` transport. Throws on failure.
 * @param {string[]} args @param {string} directory
 * `readConfig: true` leaves out the `core.hooksPath` override (it would hide the very value `git config --get core.hooksPath` is asked for);
 * it is only for config-only reads, which never run a hook.
 * `safe.bareRepository=explicit` is always set: git then refuses to use a bare-repository-shaped directory (HEAD, objects/, refs/, config) that it
 * merely FOUND while looking for a repository, and a hostile repository can commit one (`evil/HEAD`, `evil/config` ...: its `core.fsmonitor`,
 * hooks, `diff.external` and remote URLs would otherwise be used by a git run with `evil/` as its working directory).
 * `ceiling` (a directory) becomes GIT_CEILING_DIRECTORIES: discovery never looks at that directory or above, so a directory that is not itself a repository
 * cannot be resolved to a repository in one of its parents. The classifier passes the PARENT of the verified workspace root.
 * @param {{env?: Record<string,string|undefined>, platform?: string, timeoutMs?: number, readConfig?: boolean, ceiling?: string}} [options]
 * @returns {string} trimmed stdout
 */
export function runGitSync(args, directory, { env, platform = process.platform, timeoutMs = 3000, readConfig = false, ceiling } = {}) {
  const hardened = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", ...(readConfig ? [] : ["-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`]), "-c", "protocol.ext.allow=never", "-c", "core.sshCommand=", "-c", "safe.bareRepository=explicit"];
  const environment = gitEnv(env ?? process.env);
  if (typeof ceiling === "string" && ceiling !== "") environment.GIT_CEILING_DIRECTORIES = ceiling;
  return execFileSync("git", [...hardened, ...args], { cwd: directory, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "ignore"], windowsHide: true, env: environment }).trim();
}

/** The parent of a verified workspace root (for GIT_CEILING_DIRECTORIES), or undefined when the root has no parent (a file-system root). */
function ceilingOf(root) {
  const parent = path.dirname(root);
  return parent === root ? undefined : parent;
}

/**
 * Current branch of the repository at `directory` (synchronous, no shell). null when unknown/detached.
 * @param {string} directory
 * @returns {string|null}
 */
export function currentBranch(directory) {
  try {
    return runGitSync(["symbolic-ref", "--short", "-q", "HEAD"], directory) || null;
  } catch {
    return null;
  }
}

const baseName = (word) => word.split(/[\\/]/).pop().toLowerCase();
const CLAUDE_NAMES = new Set(["claude", "claude-code"]);
/** Verbs that change MCP / plugin configuration (a deny floor; read-only verbs are absent on purpose). */
const CONFIG_MUTATIONS = Object.freeze({
  asterweave: { mcp: new Set(["add", "remove"]), plugin: new Set(["install", "uninstall", "enable", "disable"]) },
  claude: {
    mcp: new Set(["add", "remove", "rm", "add-json", "add-from-claude-desktop", "reset-project-choices"]),
    plugin: new Set(["install", "i", "uninstall", "remove", "rm", "enable", "disable", "update", "prune", "marketplace"]),
  },
});
/** Options of asterweave / claude that take a value: that value is not a verb (used only to FIND the area word). */
const VALUE_OPTIONS = new Set(["path", "scope", "source", "approve", "transport", "env", "header", "config", "s", "t", "e", "h", "model", "mcp-config", "settings"]);
/** `node .../node_modules/@anthropic-ai/claude-code/cli.js` IS claude. */
const CLAUDE_CLI_PATH = /(?:^|[\/])claude-code[\/]cli.m?js$/i;
const isClaudeWord = (word) => CLAUDE_NAMES.has(commandName(word)) || CLAUDE_CLI_PATH.test(word);
/** Words split on , and ; too (PowerShell `-ArgumentList 'mcp','add'`), lower case. */
const splitWords = (list) => list.flatMap((word) => (word.startsWith("-") ? [word] : word.toLowerCase().split(/[,;]+/).filter(Boolean)));
/** Words without options (option values of the known value options dropped): only to ask whether an area word is present. */
const plainWords = (list) => {
  const out = [];
  const words = splitWords(list);
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].startsWith("-")) { if (!words[i].includes("=") && VALUE_OPTIONS.has(words[i].replace(/^-+/, "").toLowerCase())) i += 1; continue; }
    out.push(words[i]);
  }
  return out;
};
const UNRESOLVED_WORD = /[$%*?[`]/;
/**
 * Does `list` (the words after asterweave / claude) run a mutating verb of one of the areas? The area is the first area word (known value
 * options are skipped while looking for it). After it, options are skipped together with the one word that may be their value; the first
 * other word decides: a mutating verb, or a word that cannot be resolved (variable, glob: `mcp $V`, `mcp ad*`) is a mutation; a plain
 * word that is not a verb (`mcp test add`, `mcp x add`) is not.
 */
function runsConfigMutation(list, table) {
  const words = splitWords(list);
  let at = -1;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].startsWith("-")) { if (!words[i].includes("=") && VALUE_OPTIONS.has(words[i].replace(/^-+/, "").toLowerCase())) i += 1; continue; }
    if (Object.hasOwn(table, words[i])) { at = i; break; }
  }
  if (at < 0) return false;
  const verbs = table[words[at]];
  let afterOption = false;
  for (let i = at + 1; i < words.length; i += 1) {
    const word = words[i];
    if (word.startsWith("-")) { afterOption = !word.includes("="); continue; }
    if (verbs.has(word) || UNRESOLVED_WORD.test(word)) return true;
    if (!afterOption) return false;
    afterOption = false;
  }
  return false;
}
const AREAS = ["mcp", "plugin", "plugins"];
const TABLES = Object.freeze({
  asterweave: { mcp: CONFIG_MUTATIONS.asterweave.mcp, plugin: CONFIG_MUTATIONS.asterweave.plugin },
  claude: { mcp: CONFIG_MUTATIONS.claude.mcp, plugin: CONFIG_MUTATIONS.claude.plugin, plugins: CONFIG_MUTATIONS.claude.plugin },
});
const READ_ONLY_VERBS = new Set(["list", "get", "inspect", "validate", "test", "status", "help", "show"]);
/** A line whose command word cannot be resolved (variable, Invoke-Expression, eval) that still has an mcp/plugin area followed by anything but a read-only verb. */
export function unresolvedConfigMutation(text) {
  const tokens = String(text).toLowerCase().split(/[\s'"`+()&|;,{}]+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i += 1) {
    if (!AREAS.includes(tokens[i])) continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].startsWith("-")) j += 1;
    if (j >= tokens.length) continue;
    if (!READ_ONLY_VERBS.has(tokens[j])) return true;
  }
  return false;
}
const UNRESOLVED_COMMAND_RULES = new Set(["command-variable", "invoke-expression", "eval"]);
const ALL_VERBS = new Set([...CONFIG_MUTATIONS.asterweave.mcp, ...CONFIG_MUTATIONS.asterweave.plugin, ...CONFIG_MUTATIONS.claude.mcp, ...CONFIG_MUTATIONS.claude.plugin].filter((verb) => verb !== "i"));
/** A line the classifier could not follow that still NAMES claude (or asterweave), an mcp/plugin area and a mutating verb. */
export function namesConfigMutation(text) {
  const lower = String(text).toLowerCase();
  if (!/claude|asterweave/.test(lower)) return false;
  const words = lower.split(/[^a-z0-9-]+/).filter(Boolean);
  return AREAS.some((area) => words.includes(area)) && words.some((word) => ALL_VERBS.has(word));
}
const commandName = (word) => baseName(word).replace(/\.(?:exe|cmd|bat|com|ps1|mjs|cjs|js)$/, "");
const VARIABLE_PATTERN = new RegExp(`${DOLLAR_VAR_SOURCE}|%[A-Za-z_][A-Za-z0-9_]*%`);
const DOLLAR_PATTERN = new RegExp(DOLLAR_VAR_SOURCE);
const hasVariable = (value) => VARIABLE_PATTERN.test(value);
const hasDollarVariable = (value) => DOLLAR_PATTERN.test(value);
/** A push destination git would resolve in a way the classifier does not model. */
const UNSAFE_REF = /[\s$`'"{}\\^~?[\]%\u0000-\u001f]|@\{|\.\./;

/**
 * @typedef {object} Finding
 * @property {string} code        One of FINDING_CODES.
 * @property {string} ruleId      Stable machine id of the rule.
 * @property {string} detail      Human reason (never echoes the whole command).
 * @property {string} [operation] For approvable findings: the operation name used in an approval scope.
 * @property {boolean} [hard]     Unparseable AND not approvable: denied in every mode (an oversized command).
 */

/**
 * Classify a shell command.
 *
 * @param {string} command
 * @param {{cwd?: string, workspaceRoot?: string, platform?: string, dialect?: string | string[], branchOf?: (directory: string) => string|null,
 *   defaultBranches?: string[], homedir?: string | (() => string), userDir?: string, env?: Record<string,string|undefined>,
 *   hooksPathOf?: (directory: string) => string|null,
 *   realpath?: (value: string) => string, readdir?: (directory: string) => string[], lstat?: (value: string) => {isSymbolicLink(): boolean},
 *   readlink?: (value: string) => string, allowCommands?: string[][], asPath?: "read"|"write", maxCommandChars?: number, budgetMs?: number}} [options]
 *   `platform` selects win32 vs posix PATH semantics (not the host's); `dialect` selects the shell syntax (see the
 *   file comment); `realpath` defaults to the native realpath when `platform` is the host platform and to the identity
 *   function otherwise (`lstat` / `readlink` likewise); `allowCommands` is the user's own list of argv prefixes (policy.json, never
 *   a repository file) that count as understood; `asPath` classifies `command` as ONE tool path (no shell syntax, no expansion);
 *   `maxCommandChars` can only lower MAX_COMMAND_CHARS; `budgetMs` bounds the whole call, as do MAX_FS_CALLS file-system
 *   calls (every realpath / lstat / readlink / readdir counts); when either runs out the command is refused (command-too-complex).
 * @returns {{segments: Array<{command: string|null, argv: string[], op: string|null}>, findings: Finding[],
 *   operations: Array<{name: string, target?: string}>, mutating: boolean}}
 */
export function classifyShell(command, options = {}) {
  const platform = options.platform ?? process.platform;
  const findings = [];
  const operations = [];
  const segmentsOut = [];
  let mutating = false;
  const seen = new Set();
  const add = (code, ruleId, detail, extra = {}) => {
    const key = `${code}|${ruleId}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, ruleId, detail, ...extra });
  };
  const unparseable = (detail, ruleId = "unparseable-command", hard = false) => add("UNPARSEABLE_COMMAND", ruleId, detail, { operation: "unparseable-command", ...(hard ? { hard: true } : {}) });

  if (typeof command !== "string") {
    unparseable("the command is not a string", "command-not-string");
    return { segments: [], findings, operations, mutating: true };
  }
  const cap = Number.isInteger(options.maxCommandChars) && options.maxCommandChars > 0 ? Math.min(options.maxCommandChars, MAX_COMMAND_CHARS) : MAX_COMMAND_CHARS;
  if (command.length > cap) {
    unparseable(`the command is ${command.length} characters long; the guard reads at most ${cap}`, "command-too-long", true);
    return { segments: [], findings, operations, mutating: true };
  }

  const dialects = [...new Set(Array.isArray(options.dialect) ? options.dialect : options.dialect === undefined ? (platform === "win32" ? ["cmd", "posix", "powershell"] : ["posix"]) : [options.dialect])];
  if (dialects.length === 0 || dialects.some((entry) => !DIALECTS.includes(entry))) throw new TypeError("unknown shell dialect");

  const cwd = options.cwd ?? process.cwd();
  const workspaceRoot = options.workspaceRoot ?? cwd;
  const budgetMs = Number.isFinite(options.budgetMs) && options.budgetMs > 0 ? options.budgetMs : DEFAULT_BUDGET_MS;
  const deadline = performance.now() + budgetMs; // monotonic: a wall-clock jump can neither extend nor cut the budget
  const tick = () => {
    if (performance.now() > deadline) throw new BudgetError("the shell classification time budget was exceeded");
  };
  let fsCalls = 0;
  /** EVERY file-system call (realpath, lstat, readlink, readdir) is counted and checks the deadline. */
  const spend = () => {
    fsCalls += 1;
    if (fsCalls > MAX_FS_CALLS) throw new BudgetError("the shell classification file-system budget was exceeded");
    tick();
  };
  const onHost = platform === process.platform;
  const baseRealpath = options.realpath ?? defaultRealpath(platform);
  const baseLstat = options.lstat ?? (onHost ? (value) => nodeFs.lstatSync(value) : null);
  const baseReadlink = options.readlink ?? (onHost ? (value) => nodeFs.readlinkSync(value) : null);
  const realpath = (value) => {
    spend();
    return baseRealpath(value);
  };
  const lstat = (value) => {
    if (baseLstat === null) return null;
    spend();
    return baseLstat(value);
  };
  const readlink = (value) => {
    spend();
    return baseReadlink(value);
  };
  const tools = createPathTools({ platform, realpath, lstat, readlink, homedir: options.homedir });
  const { p } = tools;
  const baseReaddir = options.readdir ?? (onHost ? (directory) => nodeFs.readdirSync(directory) : null);
  const readdir = baseReaddir === null ? null : (directory) => {
    spend();
    return baseReaddir(directory);
  };
  const allowCommands = options.allowCommands;
  const defaultBranches = new Set((options.defaultBranches ?? DEFAULT_BRANCHES).map((name) => String(name).toLowerCase()));
  const userDir = options.userDir ?? resolveUserDir({ env: options.env ?? process.env, platform, homedir: () => tools.home });
  // The workspace root, the user directory and the home directory come from the caller, not from the command text: they are resolved (trusted)
  // before any command text is looked at. Command text is then only ever resolved when it is lexically inside the workspace root.
  const trusted = (value) => tools.realResolve(p.resolve(value), { trusted: true });
  const userDirLexical = p.resolve(userDir);
  const homeSecretLexical = HOME_SECRET_DIRS.map((entry) => p.join(tools.home, entry));
  const rootLexical = p.resolve(cwd, workspaceRoot);
  let userDirReal;
  let runsDirReal;
  let homeSecretRoots;
  let rootReal;
  try {
    userDirReal = trusted(userDirLexical);
    runsDirReal = p.join(userDirReal, "runs");
    homeSecretRoots = homeSecretLexical.map(trusted);
    rootReal = tools.realResolve(rootLexical, { trusted: true });
  } catch (error) {
    // Resolving the trusted roots spends the same budget as everything else: running out of it here is a refusal (command-too-complex), not an internal failure.
    if (!(error instanceof BudgetError)) throw error;
    unparseable(`${error.message}; the command is too complex for the guard to review, so it is refused in every mode`, "command-too-complex", true);
    return { segments: [], findings, operations, mutating: true };
  }
  tools.setRoots([...new Set([rootLexical, rootReal])]);
  /** Current branch of the repository at the VERIFIED workspace root, from the injected `branchOf` or a hardened git run inside the time budget. */
  const branchOf = options.branchOf ?? (onHost ? (directory) => {
    spend();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 50) throw new BudgetError("the shell classification time budget was exceeded");
    try {
      return runGitSync(["symbolic-ref", "--short", "-q", "HEAD"], directory, { timeoutMs: Math.min(3000, remaining), ceiling: ceilingOf(directory) }) || null;
    } catch {
      return null;
    }
  } : () => null);
  /**
   * The raw `core.hooksPath` of the repository at the VERIFIED workspace root (a config-only read: no work-tree hashing command, nothing that
   * runs a hook), from the injected `hooksPathOf` or a hardened `git config --get` inside the time budget. null when unset or unreadable, `false`
   * when the root is NOT the top of its working tree (a relative `core.hooksPath` is relative to that top, so its meaning is unknown and
   * a commit or push is not understood). It is read at most once per classification, when a write to a path inside the workspace has to be
   * judged and when a commit or push is looked at.
   * FAIL-OPEN, unlike `remotesOf` (fail-closed): an unreadable hooks path only means one more directory is not protected from WRITES (and a failing
   * git cannot commit either), while an unreadable remote list would let `git push <word>` through, a push to a local path that runs its hooks.
   * It runs with the hardening of `runGitSync` (`safe.bareRepository=explicit`, no fsmonitor, no pager; a config-only read runs no hook). The
   * `config --get` read also passes GIT_CEILING_DIRECTORIES (the parent of the root); the `rev-parse --show-cdup` read deliberately passes NO ceiling (a
   * parent repository must be FOUND to show that the root is not the top of its working tree). It stays safe without one because
   * `safe.bareRepository=explicit` stops git from taking a bare-repository-shaped directory for a repository, and the read only prints a path.
   * `git config --get` reads every scope, so a global `core.hooksPath` is seen.
   */
  const hooksPathOf = options.hooksPathOf ?? (onHost ? (directory) => {
    spend();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 50) throw new BudgetError("the shell classification time budget was exceeded");
    const read = (args, ceiling = ceilingOf(directory)) => {
      const left = Math.floor(deadline - performance.now());
      if (left < 50) throw new BudgetError("the shell classification time budget was exceeded");
      return runGitSync(args, directory, { timeoutMs: Math.min(3000, left), readConfig: true, ceiling });
    };
    try {
      if (read(["rev-parse", "--show-cdup"], null) !== "") return false; // no ceiling here (a parent repository must be FOUND to show the root is not the top of the working tree); a relative path would not mean what we resolve it to
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      if (error?.killed === true || error?.code === "ETIMEDOUT") throw new BudgetError("the shell classification time budget was exceeded");
      // not a repository / no git: nothing is configured (the read below says the same)
    }
    try {
      return read(["config", "--get", "core.hooksPath"]) || null;
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      if (error?.killed === true || error?.code === "ETIMEDOUT") throw new BudgetError("the shell classification time budget was exceeded");
      return null; // exit 1 = not set; no git, or not a repository, = nothing configured
    }
  } : () => null);
  /**
   * Names of the remotes configured in the repository at the VERIFIED workspace root, from the injected `remotesOf` or a hardened config-only git
   * read (`git config --name-only --get-regexp ^remote\.`: no hook can run) inside the time budget. null when unknown (then no push is understood:
   * FAIL-CLOSED, see `hooksPathOf`). It uses `safe.bareRepository=explicit` and passes GIT_CEILING_DIRECTORIES (the parent of the root; the show-cdup read of
   * `hooksPathOf` does not); it reads the root repository's configuration and the user's global one, never the configuration of an embedded directory.
   */
  const remotesOf = options.remotesOf ?? (onHost ? (directory) => {
    spend();
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 50) throw new BudgetError("the shell classification time budget was exceeded");
    try {
      const output = runGitSync(["config", "--name-only", "--get-regexp", "^remote\\."], directory, { timeoutMs: Math.min(3000, remaining), readConfig: true, ceiling: ceilingOf(directory) });
      return output.split(/\r?\n/).map((line) => /^remote\.(.+)\.[^.]+$/.exec(line.trim())?.[1]).filter((name) => typeof name === "string");
    } catch (error) {
      if (error?.killed === true || error?.code === "ETIMEDOUT") throw new BudgetError("the shell classification time budget was exceeded");
      return error?.status === 1 ? [] : null; // exit 1 = no remote configured; no git, or not a repository, = unknown
    }
  } : () => null);

  const destructive =(ruleId, detail = RULE_REASONS[ruleId]) => add("DESTRUCTIVE_COMMAND", ruleId, detail);
  const noteOperation = (name, target) => {
    if (!operations.some((entry) => entry.name === name && entry.target === target)) operations.push(target === undefined ? { name } : { name, target });
  };

  // DIRECTORY CHANGES. The guard NEVER follows a directory change: `state.cwd` is the hook payload's working directory for the whole classification and no
  // cd / chdir / Set-Location / sl / pushd / popd / Push-Location / Pop-Location moves it. The directory a later command really runs in cannot be predicted
  // (a failing cd leaves the shell where it was, a wildcard operand expands to whatever matches, Windows drops a trailing dot or space, CDPATH and bash's
  // physical fallback pick other directories), so a command line that changes directory AND runs anything else is not understood at all
  // (cwd-change-with-other-commands), and a LONE cd is understood only for a plain in-workspace operand (cdOperandProblem).
  const state = { cwd: p.resolve(cwd), patternArgs: new Set(), understood: false };
  let commandCount = 0; // commands (segments with a command word) seen in the current reading of the command line
  let cwdChangeSeen = false;
  const depthBox = { depth: 0, dialect: dialects[0] };
  let pathChecks = 0;
  let globUnverified = false;
  const listings = new Map();

  // ---- paths ----

  /** Entries of a directory (cached, bounded) or null when it cannot be listed. */
  function listDirectory(directoryText) {
    if (readdir === null) return null;
    const expanded = tools.expand(directoryText === "" ? "." : directoryText, state.cwd);
    if ("unresolved" in expanded) return null;
    const real = tools.tryReal(expanded.path);
    if (real === null) return null;
    if (listings.has(real)) return listings.get(real);
    let names = null;
    try {
      const entries = readdir(real);
      names = Array.isArray(entries) && entries.length <= 20000 ? entries.map(String) : null;
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      names = null;
    }
    listings.set(real, names);
    return names;
  }

  /**
   * Name of a secret the glob `component` can match (real directory listing first, representative names otherwise), or null.
   * A pattern made only of wildcards (`*`, `?`) is matched against the real listing when there is one; when the directory cannot
   * be listed it is `globUnverified`, which keeps the command out of the understood set (it may expand to a secret).
   */
  function globSecretMatch(component, directoryText) {
    const wildcardOnly = !/[^*?]/.test(component);
    const names = listDirectory(directoryText);
    if (names !== null) return names.find((name) => globTest(component, name, tools.win, !tools.win) && isSecretName(name)) ?? null;
    if (wildcardOnly) {
      globUnverified = true;
      return null;
    }
    if (!/[^*?[\]!^-]/.test(component)) return null;
    return SECRET_SAMPLES.find((name) => globTest(component, name, tools.win, !tools.win)) ?? null;
  }

  /** Windows ignores trailing dots and spaces and treats `name:stream` as `name`. */
  function normalizePart(part, index) {
    if (!tools.win) return part;
    let value = part;
    if (!(index === 0 && /^[A-Za-z]:$/.test(value))) {
      const colon = value.indexOf(":");
      if (colon > 0) value = value.slice(0, colon);
    }
    let end = value.length;
    while (end > 0 && (value[end - 1] === "." || value[end - 1] === " ")) end -= 1;
    return end === 0 ? part : value.slice(0, end);
  }

  function checkSecretName(text) {
    if (text.length > MAX_PATH_CHARS) return undefined;
    const value = text.replace(/\\/g, "/");
    const rawParts = value.split("/").filter(Boolean);
    const parts = rawParts.map(normalizePart);
    const last = parts.length > 0 ? parts[parts.length - 1] : "";
    if (parts.some((part) => SECRET_DIRS.has(part.toLowerCase()))) return add("SECRET_ACCESS", "secret-dir", "touches a credentials directory");
    if (/(?:^|\/)\.docker\/config\.json$/i.test(value)) return add("SECRET_ACCESS", "secret-file", "touches a container-registry credentials file");
    for (let at = 0; at < rawParts.length; at += 1) {
      if (!GLOB_CHARS.test(rawParts[at])) continue;
      const prefix = (value.startsWith("/") ? "/" : "") + rawParts.slice(0, at).join("/");
      if (globSecretMatch(rawParts[at], prefix) !== null) return add("SECRET_ACCESS", "secret-glob", "a wildcard in the path can match a file that commonly holds secrets");
    }
    if (/^credentials$/i.test(last) && parts.length < 2) return undefined;
    if (!ENV_TEMPLATE.test(last) && SECRET_BASENAME.test(last)) return add("SECRET_ACCESS", "secret-file", "touches a file that commonly holds secrets");
    return undefined;
  }

  /**
   * Can the wildcard component `part` (already lower-cased) match `name`? A POSIX shell never lets a leading `*` or `?` match a leading dot, so
   * `*` cannot expand to `.git` in the posix dialect; PowerShell and cmd wildcards can. A component without wildcard characters never "can match".
   */
  const globCanMatch = (part, name) => GLOB_CHARS.test(part) && globTest(part, name, tools.win, depthBox.dialect === "posix" && /^[*?]/.test(part));

  /** Name of the protected location when a write to `relativeParts` (relative to the workspace root) must be refused. */
  function protectedMatch(relativeParts, creates) {
    const lower = relativeParts.map((part, index) => normalizePart(part, index + 1).toLowerCase());
    for (let k = 0; k < lower.length; k += 1) {
      const part = lower[k];
      if (part === ".git" || (tools.win && /^git~\d+$/.test(part)) || (/^[.[]/.test(part) && globCanMatch(part, ".git"))) return ".git";
      if (part === ".mcp.json") return ".mcp.json";
      if (HOOK_DIRS.has(part)) return part;
      if (part === ".claude" || (tools.win && /^claude~\d+$/.test(part))) {
        const next = lower[k + 1];
        if (next === undefined) {
          if (!creates) return ".claude";
        } else if (/^settings.*\.json$/.test(next)) return ".claude/settings";
        else if (next === "asterweave.json") return ".claude/asterweave.json";
        else if (next === "hooks") return ".claude/hooks";
      }
    }
    const last = lower[lower.length - 1];
    if (last !== undefined && HOOK_FILES.test(last)) return last;
    return null;
  }

  /** Lower-cased, Windows-normalized components of a path relative to the workspace root. */
  const foldParts = (parts) => parts.map((part, index) => normalizePart(part, index + 1).toLowerCase());

  /** `core.hooksPath` as workspace-relative components (`[]` = the root itself), or null when unset, unreadable or outside the workspace. Cached. */
  let hooksParts;
  let hooksRaw; // undefined = not read yet; else what hooksPathOf answered (string, null = unset / unreadable, false = the root is not the top of its working tree)
  /** The raw answer of `hooksPathOf` for the verified root, read once. An unreadable answer is "unset" (fail-open, see hooksPathOf). */
  function readHooksPath() {
    if (hooksRaw !== undefined) return hooksRaw;
    hooksRaw = null;
    try {
      hooksRaw = hooksPathOf(rootReal);
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      hooksRaw = null;
    }
    return hooksRaw;
  }
  /**
   * Is the meaning of `core.hooksPath` known? A relative value is relative to the top of the working tree, and it is resolved here against the verified
   * root: that is only right when the root IS that top. When it is not (`false`), a commit or push (which run the hooks) is not an understood form.
   */
  const hooksPathKnown = () => readHooksPath() !== false;
  function configuredHooksParts() {
    if (hooksParts !== undefined) return hooksParts;
    hooksParts = null;
    const value = readHooksPath();
    if (typeof value !== "string") return hooksParts;
    const text = value.trim();
    if (text === "" || text.length > MAX_PATH_CHARS) return hooksParts;
    // git expands a leading `~/`; it expands nothing else ($ and % are ordinary characters in a configuration value).
    const absolute = text === "~" || text.startsWith("~/") || text.startsWith("~\\") ? p.resolve(tools.home, text.slice(2)) : text.startsWith("~") ? null : p.resolve(rootReal, text);
    if (absolute === null) return hooksParts;
    const resolved = tools.realResolve(absolute);
    if (!tools.inside(rootReal, resolved)) return hooksParts; // a hooks directory outside the workspace cannot be written to anyway
    hooksParts = foldParts(p.relative(rootReal, resolved).split(/[\\/]/).filter(Boolean));
    return hooksParts;
  }

  /** Is a write to `relativeParts` a write into the directory `core.hooksPath` names (all of it, or only hook-named files when that is the root)? */
  function inConfiguredHooksDirectory(relativeParts) {
    const dir = configuredHooksParts();
    if (dir === null) return false;
    const parts = foldParts(relativeParts);
    if (dir.length > parts.length || !dir.every((part, index) => parts[index] === part)) return false;
    return dir.length > 0 || (parts.length === 1 && GIT_HOOK_NAMES.has(parts[0]));
  }

  /**
   * Does a READ of `relativeParts` show the repository configuration (`.git/config`, which holds remote URLs that can embed credentials)?
   * Wildcard components are judged by what they CAN match: `.gi*`, `.[g]it` and `.*` can be `.git`, and `co?fig`, `c*` and `*` can be `config`.
   */
  function readsGitConfig(relativeParts) {
    const lower = foldParts(relativeParts);
    for (let at = 0; at < lower.length; at += 1) {
      if (lower[at] !== ".git" && !globCanMatch(lower[at], ".git")) continue;
      for (let next = at + 1; next < lower.length; next += 1) {
        const part = lower[next];
        if (part === "config" || part === "config.worktree" || globCanMatch(part, "config") || globCanMatch(part, "config.worktree")) return true;
      }
    }
    return false;
  }

  const existence = new Map();
  /** Does anything (file, directory, link) exist at `absolute`? A budgeted lstat; no lstat available (an injected platform) counts as "no", an unreadable answer as "yes". */
  function nodeExists(absolute) {
    if (existence.has(absolute)) return existence.get(absolute);
    let found;
    try {
      const stat = lstat(absolute);
      found = stat !== null && stat !== undefined;
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      found = error?.code !== "ENOENT" && error?.code !== "ENOTDIR";
    }
    existence.set(absolute, found);
    return found;
  }

  /**
   * Is a write to `relativeParts` a write into something that looks like a git directory (a bare repository)? `git push <path>` runs the hooks of
   * the repository found there, and plain file writes can build one: HEAD, `objects/`, `refs/`, `config`, `hooks/<name>`. A file called HEAD and a
   * hook-named file in a directory called `hooks` are refused by name (git accepts no directory without a HEAD file, so none can be completed by
   * writes); the rest by what already sits beside it: a `hooks`,
   * `config` or `packed-refs` entry next to a HEAD file, and the last of `objects`, `refs` (and a HEAD below another HEAD) next to the others.
   * Returns a description or null.
   */
  function gitDirectoryWrite(relativeParts) {
    const parts = foldParts(relativeParts);
    const last = parts.length - 1;
    if (last < 0) return null;
    // HEAD is compared case-insensitively on EVERY platform: Windows and macOS (APFS) file systems are case-insensitive, and the path may be written
    // from a host where `head` and `HEAD` are the same file. The price is a false positive on a file literally named `head` (or `Head`) on a
    // case-sensitive file system: the write is refused as a "file named HEAD" (documented in policy-and-guards.md).
    const isHead = (index) => parts[index] === "head";
    if (isHead(last)) return "a file named HEAD, the marker of a git directory";
    if (last >= 1 && parts[last - 1] === "hooks" && GIT_HOOK_NAMES.has(parts[last])) return "a git hook script";
    const sibling = (index, name) => nodeExists(p.join(rootReal, ...relativeParts.slice(0, index), name === "head" && !tools.win ? "HEAD" : name));
    for (let index = 0; index <= last; index += 1) {
      const part = parts[index];
      if (GIT_DIR_CONTROL.has(part)) {
        if (sibling(index, "head")) return "a directory that holds a git HEAD file (a git directory: hooks and configuration decide what git runs)";
      } else if (GIT_DIR_MARKERS.includes(part) && part !== "head") {
        if (GIT_DIR_MARKERS.filter((marker) => marker !== part).every((marker) => sibling(index, marker))) return "a git directory (HEAD, objects and refs)";
      } else if (isHead(index) && index < last) {
        if (sibling(index, "objects") && sibling(index, "refs")) return "a git directory (HEAD, objects and refs)";
      }
    }
    return null;
  }

  /**
   * Colons in a path OPERAND. PowerShell reads `env:X`, `HKCU:\Software`, `Cert:\`, `FileSystem::C:\x`, `FileSystem::\\host\share` (an SMB
   * connection) and `Microsoft.PowerShell.Core\FileSystem::...` as provider paths, and `C:x` as relative to another drive's current
   * directory; none of them is a file below the workspace. Only a fully qualified drive root (`X:\` or `X:/`, one ASCII letter) may carry a
   * colon, and then no other. Returns "provider" (a provider or multi-letter drive, or `::`), "colon" (drive-relative, stream or other), or null.
   * A provider or multi-letter drive is refused whatever the shell (the guard cannot know which one reads the text). A drive-relative path
   * (`C:`, `C:x`) is only refused where PowerShell reads it (the PowerShell dialect, or a PowerShell cmdlet in any dialect): a POSIX / cmd
   * reading of a backslash path (`C:\work\repo\a.txt` is `C:workrepoa.txt` to Git Bash) is relative to the shell's own working directory,
   * which is the workspace, and resolves lexically like any other relative path.
   */
  function colonProblem(text) {
    if (!text.includes(":")) return null;
    const rest = /^[A-Za-z]:[\\/]/.test(text) ? text.slice(2) : text;
    if (!rest.includes(":")) return null;
    return text.includes("::") || /^[^\\/:]{2,}:/.test(text) ? "provider" : "colon";
  }

  /** Report a colon problem in an operand; true when the operand is refused. Provider paths are a deny where a provider can exist (PowerShell, Windows), a question elsewhere. */
  function refuseColon(text, label, { ps = false } = {}) {
    const problem = colonProblem(text);
    if (problem === null) return false;
    if (problem === "colon" && !ps && depthBox.dialect !== "powershell") return false;
    if (problem === "provider" && (depthBox.dialect === "powershell" || tools.win)) {
      add("PATH_OUTSIDE_WORKSPACE", "path-provider", `${label} is a provider, drive or stream qualified path (env:, HKCU:, FileSystem::, C:x ...), not a file below the workspace`);
    } else unparseable(`${label} contains a colon the guard cannot place (a PowerShell provider or drive, a drive-relative path, or a stream)`, "path-colon");
    return true;
  }

  /** Check one path-like argument. `writer` tells whether the command writes to it. */
  function checkPath(text, { writer, strict, label, creates = false, literal = false, flagValue = false }) {
    pathChecks += 1;
    tick();
    if (pathChecks > MAX_PATH_CHECKS || text.length > MAX_PATH_CHARS) {
      unparseable(`${label} is too long, or the command names too many paths`, "path-budget", true);
      return;
    }
    // A tool path (Write / Edit / Read) on Windows: a leading provider or multi-letter drive (`env:X`, `FileSystem::C:\x`, `HKCU:\`) or a
    // drive-relative path (`C:x`) is not a file below the workspace whatever tool reads it. (NTFS stream spellings AFTER a drive root or
    // below the workspace are not refused here: they are normalized and judged by the protected-path and secret checks.)
    if (literal && tools.win && (/^[^\\/:]{2,}:/.test(text) || /^[A-Za-z]:(?![\\/])/.test(text))) {
      add("PATH_OUTSIDE_WORKSPACE", "path-provider", `${label} is a provider, drive or stream qualified path, not a file below the workspace`);
      return;
    }
    const expanded = tools.expand(text, state.cwd, { literal });
    if ("unresolved" in expanded) {
      if (strict || /^[$%~]/.test(text)) unparseable(`${label} contains a ${expanded.unresolved} that cannot be resolved`, "path-unresolved");
      return;
    }
    const absolute = expanded.path;
    // Windows device names (CON, AUX, COM1 ...) are not files: never handed to the file system, never understood.
    if (tools.win && absolute.split(/[\\/]/).some((part) => WINDOWS_DEVICE.test(part.replace(/[. ]+$/, "").replace(/:.*$/, "")))) {
      unparseable(`${label} names a Windows device`, "path-device");
      return;
    }
    // Lenient mode (commands that mostly take non-path arguments): a posix-absolute-looking text inside the workspace that names nothing on disk
    // is not a file access. Outside the workspace nothing is looked up: only a plain absolute path under an operating-system root counts as a path
    // (and is judged below). Any other absolute-looking text is a regex or URL path ONLY when it is the value of a `--flag=value` (`--grep=/re/`);
    // as an operand it may be a path the guard cannot place (`/c/Users/x` is a Windows path to Git Bash, `/data/x` a real one on Linux): asked about.
    if (!strict && text.startsWith("/")) {
      if (tools.eligible(absolute)) {
        if (tools.tryReal(absolute) === null && tools.tryReal(p.dirname(absolute)) === null) return;
      } else if (!PLAIN_ABSOLUTE.test(text) || !OS_ROOTS.has(text.split("/")[1])) {
        if (!flagValue) unparseable(`${label} is an absolute path the guard cannot place`, "path-absolute-unplaced");
        return;
      }
    }
    const resolved = tools.realResolve(absolute);
    if (tools.inside(runsDirReal, resolved) || tools.inside(p.join(userDirLexical, "runs"), resolved)) {
      if (writer) add("APPROVAL_SELF_GRANT", "runs-dir-write", "writes under the Asterweave runs directory; approvals only come from a terminal or CLI flags");
      else add("SECRET_ACCESS", "userdir-access", "touches the Asterweave user directory");
      return;
    }
    if (tools.inside(userDirReal, resolved) || tools.inside(userDirLexical, resolved)) {
      add("SECRET_ACCESS", "userdir-access", "touches the Asterweave user directory");
      return;
    }
    if (homeSecretRoots.some((entry) => tools.inside(entry, resolved)) || homeSecretLexical.some((entry) => tools.inside(entry, resolved))) {
      add("SECRET_ACCESS", "home-secret-dir", "touches a credentials directory in the home directory");
      return;
    }
    if (!tools.inside(rootReal, resolved)) {
      add("PATH_OUTSIDE_WORKSPACE", "path-outside-workspace", `${label} resolves outside the workspace`);
      return;
    }
    const relativeParts = p.relative(rootReal, resolved).split(/[\\/]/).filter(Boolean);
    if (writer) {
      const hit = protectedMatch(relativeParts, creates) ?? (inConfiguredHooksDirectory(relativeParts) ? "the core.hooksPath directory" : null) ?? gitDirectoryWrite(relativeParts);
      if (hit !== null) add("PROTECTED_PATH", "protected-path", `writes to ${hit}, which controls repository behaviour, hooks or the agent's own settings`);
    } else if (readsGitConfig(relativeParts)) {
      unparseable("reads .git/config, which can hold credentials embedded in remote URLs", "git-config-read");
    }
    // The real path can reveal a secret behind a link or a short name (`ln -s .env x`, `ID_RSA~1`).
    if (relativeParts.length > 0) checkSecretName(relativeParts.join("/"));
  }

  const isPathLike = (value) => {
    if (platform === "win32") {
      if (/^(?:[\\/]|~|[A-Za-z]:[\\/]|\\\\)/.test(value)) return true;
    } else if (/^[/~]/.test(value)) return true;
    if (/^\.{1,2}(?:[\\/]|$)/.test(value) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value)) return true;
    return /^(?:\$\{?(?:HOME|USERPROFILE)|\$env:|%[A-Za-z]+%)/i.test(value);
  };

  /**
   * Path-ish candidates among `args` (flag values after `=` included; bare words only when strict), as `{text, flagValue}`. For an UNDERSTOOD form the
   * operands are not looked at here: they are file or revision operands that understoodForm returned and that are checked strictly one by one.
   */
  function pathCandidates(args, strict) {
    const out = [];
    let afterDoubleDash = false;
    for (const arg of args) {
      if (arg === "--" && !afterDoubleDash) {
        afterDoubleDash = true;
        continue;
      }
      if (state.patternArgs.has(arg)) continue; // the pattern of an understood grep is not a file
      let candidate = arg;
      let flagValue = false;
      if (!afterDoubleDash && arg.startsWith("-") && arg.length > 1) {
        const equals = arg.indexOf("=");
        if (equals <= 0) continue;
        candidate = arg.slice(equals + 1);
        flagValue = true;
      }
      if (state.understood && !flagValue) continue;
      if (candidate === "" || /^\/[A-Za-z?]$/.test(candidate) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(candidate) || SAFE_DEVICES.has(candidate.toLowerCase())) continue;
      if (strict || isPathLike(candidate)) out.push({ text: candidate, flagValue });
    }
    return out;
  }

  // ---- command analyzers ----

  const BULK_TARGETS = new Set([".", "./", ".\\", ":/", ":/.", "*", "./*", ".\\*"]);

  /** Branch of the repository at the verified workspace root (never a directory taken from the command). */
  function branchFor() {
    try {
      const value = branchOf(rootReal);
      return typeof value === "string" && value !== "" ? value : null;
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      return null;
    }
  }

  const isDefaultBranch = (name) => defaultBranches.has(String(name).toLowerCase());

  /** `git config`: reads are fine; writes only for harmless keys in the repository's own scope. Returns true when read-only. */
  function analyzeGitConfig(rest) {
    const positional = rest.filter((arg) => !arg.startsWith("-"));
    const scoped = rest.some((arg) => /^--(?:global|system|file|worktree|blob)(?:=.*)?$/.test(arg) || arg === "-f");
    const writeFlag = rest.some((arg) => /^--(?:add|unset|unset-all|replace-all|rename-section|remove-section|edit|set)$/.test(arg) || arg === "-e");
    const readFlag = rest.some((arg) => /^(?:--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?|--list|-l|--show-origin|--show-scope|--name-only)$/.test(arg));
    const writes = writeFlag || (!readFlag && positional.length >= 2);
    if (!writes) return true;
    const key = positional[0] ?? "";
    if (scoped || !GIT_CONFIG_SAFE.test(key)) {
      add("PROTECTED_PATH", "git-config-write", "git config would change git configuration that can run commands, redirect remotes or change what a push updates");
    }
    return false;
  }

  function analyzeGit(args, segmentInfo) {
    let directory = state.cwd;
    let index = 0;
    if (args.some((arg) => hasDollarVariable(arg))) unparseable("a git argument contains a variable that cannot be resolved", "git-variable-argument");
    while (index < args.length) {
      const token = args[index];
      if (token === "-C") {
        const value = args[index + 1];
        if (value === undefined) break;
        checkPath(value, { writer: false, strict: true, label: "git -C path" });
        const resolved = tools.expand(value, directory);
        if (!("unresolved" in resolved)) directory = resolved.path;
        index += 2;
        continue;
      }
      if (token === "-c") {
        const pair = args[index + 1];
        const key = (pair ?? "").split("=")[0];
        if (pair === undefined || !GIT_CONFIG_SAFE.test(key)) unparseable("git -c sets a configuration key outside the harmless allow-list; it can run commands or redirect a push", "git-config-exec");
        index += 2;
        continue;
      }
      if (token === "--config-env" || token.startsWith("--config-env=")) {
        unparseable("git --config-env reads configuration from the environment", "git-config-exec");
        index += token === "--config-env" ? 2 : 1;
        continue;
      }
      if (token === "--exec-path" || token.startsWith("--exec-path=")) {
        unparseable("git --exec-path replaces the git programs that run", "git-exec-path");
        index += 1;
        continue;
      }
      if (["--git-dir", "--work-tree", "--namespace", "--super-prefix"].includes(token)) {
        if (token !== "--namespace" && args[index + 1] !== undefined) checkPath(args[index + 1], { writer: false, strict: true, label: `git ${token} path` });
        index += 2;
        continue;
      }
      if (token.startsWith("--git-dir=") || token.startsWith("--work-tree=")) {
        checkPath(token.slice(token.indexOf("=") + 1), { writer: false, strict: true, label: "git directory option" });
        index += 1;
        continue;
      }
      if (token.startsWith("-")) {
        index += 1;
        continue;
      }
      break;
    }
    const sub = (args[index] ?? "").toLowerCase();
    const rest = args.slice(index + 1);
    segmentInfo.gitSub = sub;
    segmentInfo.gitReadOnly = READ_ONLY_GIT.has(sub);
    for (const arg of rest) {
      const name = arg.startsWith("--") ? arg.slice(2).split("=")[0].toLowerCase() : "";
      if (name !== "" && ((name.length >= 3 && "upload-pack".startsWith(name)) || (name.length >= 3 && "receive-pack".startsWith(name)))) unparseable("a git option names a program to run", "git-exec-option");
    }
    switch (sub) {
      case "reset":
        if (rest.some((arg) => /^--ha(?:rd?)?$/i.test(arg))) destructive("git-reset-hard");
        break;
      case "clean":
        if (rest.some((arg) => /^-[A-Za-z]*f[A-Za-z]*$/.test(arg) || /^--f(?:o(?:r(?:ce?)?)?)?$/i.test(arg))) destructive("git-clean-force");
        break;
      case "checkout":
      case "switch":
      case "restore": {
        const staged = rest.some((arg) => arg === "--staged" || arg === "-S");
        const worktree = rest.some((arg) => arg === "--worktree" || arg === "-W");
        const bulk = rest.some((arg) => BULK_TARGETS.has(arg));
        if (bulk && !(sub === "restore" && staged && !worktree)) destructive("git-bulk-checkout");
        if (sub !== "restore" && rest.some((arg) => arg === "-f" || /^--f(?:o(?:r(?:ce?)?)?)?$/i.test(arg) || arg === "--discard-changes")) {
          destructive("git-checkout-force", "forced checkout discards local changes");
        }
        const resetAt = rest.findIndex((arg) => arg === "-B" || arg === "-C");
        if (sub !== "restore" && resetAt >= 0 && isDefaultBranch(rest[resetAt + 1] ?? "")) destructive("git-reset-default-branch", "this moves the default branch to another commit");
        break;
      }
      case "branch": {
        const names = rest.filter((arg) => !arg.startsWith("-"));
        const deleting = rest.some((arg) => /^-[A-Za-z]*[dD][A-Za-z]*$/.test(arg) || arg === "--delete");
        const moving = rest.some((arg) => /^-[A-Za-z]*[fmMcC][A-Za-z]*$/.test(arg) || arg === "--force" || arg === "--move" || arg === "--copy");
        if ((deleting || moving) && names.some(isDefaultBranch)) destructive("git-modify-default-branch", "this deletes or moves the default branch");
        segmentInfo.gitReadOnly = rest.every((arg) => READ_BRANCH_FLAGS.test(arg));
        break;
      }
      case "update-ref":
        if (rest.some((arg) => arg === "-d") && rest.some((arg) => /^refs\/heads\//i.test(arg) && isDefaultBranch(arg.slice("refs/heads/".length)))) destructive("git-delete-default-branch", "this deletes the default branch");
        break;
      case "stash":
        if (rest[0] === "clear") destructive("git-stash-clear", "git stash clear drops every stash and cannot be undone");
        segmentInfo.gitReadOnly = rest[0] === "list" || rest[0] === "show";
        break;
      case "tag":
        segmentInfo.gitReadOnly = rest.length === 0 || rest[0] === "-l" || rest[0] === "--list";
        break;
      case "remote":
        segmentInfo.gitReadOnly = rest.length === 0 || ["-v", "--verbose", "show", "get-url"].includes(rest[0]);
        if (["add", "set-url", "rename", "set-branches"].includes(rest[0])) add("NETWORK_EGRESS", "git-remote-change", "changing a remote changes where fetches and pushes go", { operation: "network-egress" });
        break;
      case "config":
        segmentInfo.gitReadOnly = analyzeGitConfig(rest);
        break;
      case "rebase":
        if (rest.some((arg) => arg === "-x" || arg === "--exec" || arg.startsWith("--exec="))) unparseable("git rebase --exec runs a command", "git-rebase-exec");
        break;
      case "bisect":
        if (rest[0] === "run") unparseable("git bisect run executes a command", "git-bisect-run");
        break;
      case "submodule":
        if (rest.includes("foreach")) unparseable("git submodule foreach executes a command", "git-submodule-foreach");
        break;
      case "filter-branch":
      case "difftool":
      case "mergetool":
      case "daemon":
      case "instaweb":
        unparseable(`git ${sub} runs programs or rewrites history in ways the guard cannot follow`, "git-subcommand-exec");
        break;
      case "push":
        analyzePush(rest, directory);
        break;
      case "merge":
        if (!rest.some((arg) => ["--abort", "--quit", "--continue"].includes(arg))) add("OUT_OF_POLICY_OPERATION", "git-merge", "git merge lands changes outside the reviewed pull request flow", { operation: "merge" });
        break;
      case "commit":
        noteOperation("commit");
        break;
      case "clone":
        add("NETWORK_EGRESS", "git-clone", "git clone fetches from the network", { operation: "network-egress" });
        break;
      default:
        break;
    }
  }

  function analyzePush(rest, directory) {
    const valueOptions = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--upload-pack"]);
    let force = false;
    let all = false;
    let deleting = false;
    let tags = false;
    let repoGiven = false;
    let afterDoubleDash = false;
    const positional = [];
    const runsProgram = () => unparseable("git push --receive-pack / --exec runs a program", "git-push-exec");
    for (let j = 0; j < rest.length; j += 1) {
      const token = rest[j];
      if (afterDoubleDash || !token.startsWith("-") || token === "-") {
        positional.push(token);
        continue;
      }
      if (token === "--") {
        afterDoubleDash = true;
        continue;
      }
      if (valueOptions.has(token)) {
        if (token === "--repo") repoGiven = true;
        if (token === "--receive-pack" || token === "--exec" || token === "--upload-pack") runsProgram();
        j += 1;
        continue;
      }
      if (token.startsWith("--")) {
        const name = token.slice(2).split("=")[0].toLowerCase();
        if (name.length >= 3 && "repo".startsWith(name)) repoGiven = true;
        else if ((name.length >= 3 && "receive-pack".startsWith(name)) || (name.length >= 2 && "exec".startsWith(name)) || (name.length >= 3 && "upload-pack".startsWith(name))) runsProgram();
        else if (/^for(?:c(?:e(?:-.*)?)?)?$/.test(name)) force = true;
        else if (name.length >= 2 && ("all".startsWith(name) || "mirror".startsWith(name))) all = true;
        else if (name.length >= 2 && "delete".startsWith(name)) deleting = true;
        else if (name.length >= 2 && "tags".startsWith(name)) tags = true;
        continue;
      }
      if (/^-[A-Za-z]+$/.test(token)) {
        const flags = token.slice(1);
        if (flags.includes("f")) force = true;
        if (flags.includes("d")) deleting = true;
      }
    }
    const remoteName = repoGiven ? undefined : positional[0];
    if (remoteName !== undefined && /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|[^\s/:]+@[^\s/]+:|ext::|\.{0,2}[\\/]|[A-Za-z]:[\\/])/.test(remoteName)) {
      add("NETWORK_EGRESS", "git-push-url", "pushing to a URL or path instead of a configured remote", { operation: "network-egress" });
    }
    const refspecs = repoGiven ? positional : positional.slice(1);
    if (refspecs.some((spec) => spec.startsWith("+"))) force = true;
    if (force) destructive("git-push-force");
    if (all) {
      add("DEFAULT_BRANCH_PUSH", "git-push-all", "pushing every branch can land work on the default branch without a pull request", { operation: "default-branch-push" });
      return;
    }
    const resolveName = (name) => {
      if (name === "HEAD" || name === "@") return branchFor(directory);
      return name;
    };
    const targets = [];
    let unknownBranch = false;
    if (refspecs.length === 0) {
      if (tags && !deleting) return;
      const branch = branchFor(directory);
      if (branch === null) unknownBranch = true;
      else targets.push(branch);
    } else {
      for (const raw of refspecs) {
        const spec = raw.replace(/^\+/, "");
        const colon = spec.indexOf(":");
        if (UNSAFE_REF.test(spec) || (colon >= 0 && spec.indexOf(":", colon + 1) >= 0)) {
          unparseable("a push refspec uses syntax the guard cannot resolve to a branch name", "git-push-refspec-syntax");
          continue;
        }
        let destination = colon >= 0 ? spec.slice(colon + 1) : spec;
        if (destination === "") destination = colon >= 0 ? spec.slice(0, colon) : spec;
        if (/^refs\/tags\//i.test(destination)) continue;
        if (/^refs\/heads\//i.test(destination)) destination = destination.slice("refs/heads/".length);
        else if (/^(?:refs|heads|tags|remotes)\//i.test(destination)) {
          unparseable("a push destination names a ref namespace the guard does not model (git may resolve it to a branch)", "git-push-refspec-namespace");
          continue;
        }
        if (destination.includes("*")) {
          add("DEFAULT_BRANCH_PUSH", "git-push-glob", "a wildcard refspec can update the default branch", { operation: "default-branch-push" });
          continue;
        }
        const resolved = resolveName(destination);
        if (resolved === null) unknownBranch = true;
        else targets.push(resolved);
      }
    }
    if (unknownBranch) {
      add("DEFAULT_BRANCH_PUSH", "git-push-unknown-branch", "cannot tell which branch this push updates (detached HEAD or unknown branch)", { operation: "default-branch-push" });
    }
    for (const name of targets) {
      if (isDefaultBranch(name)) {
        add("DEFAULT_BRANCH_PUSH", "git-push-default-branch", deleting ? `this deletes the default branch '${name}'` : `this pushes directly to '${name}' instead of landing through a pull request`, { operation: "default-branch-push" });
      } else if (!deleting) {
        noteOperation("push-branch", name);
      }
    }
  }

  function removeFlags(args) {
    let recursive = false;
    let force = false;
    for (const token of args) {
      if (token === "--") break;
      const lower = token.toLowerCase().replace(/:.*$/, "");
      if (/^\/s$/.test(lower)) recursive = true;
      if (/^\/[fq]$/.test(lower)) force = true;
      if (lower.startsWith("--")) {
        // GNU long options may be abbreviated to any unambiguous prefix: --recur, --forc, --r, --f.
        const name = lower.slice(2).split("=")[0];
        if (name.length >= 1 && "recursive".startsWith(name)) recursive = true;
        if (name.length >= 1 && "force".startsWith(name)) force = true;
        continue;
      }
      if (!lower.startsWith("-") || lower.length < 2) continue;
      const letters = lower.slice(1);
      if (letters.length <= 3 || /^[rfivdxpw]+$/.test(letters)) {
        if (/^[a-z]+$/.test(letters)) {
          if (letters.includes("r")) recursive = true;
          if (letters.includes("f")) force = true;
        }
      }
      if (letters.length > 1 && "recurse".startsWith(letters)) recursive = true;
      if (letters.length > 1 && letters.startsWith("fo") && "force".startsWith(letters)) force = true;
    }
    return { recursive, force };
  }

  const GLOB = /[*?[]/;
  const BROAD_TEXT = new Set(["/", "~", "~/", ".", "..", "./", "../", "*", "./*", "/*", "~/*", ".*", "\\", ".\\", "..\\", ".\\*", "$home", "${home}", "$env:userprofile", "%userprofile%", "$home/", "${home}/"]);

  function analyzeRemove(name, args, segmentInfo) {
    const { recursive } = removeFlags(args);
    const targets = [];
    let afterDoubleDash = false;
    for (const token of args) {
      if (token === "--" && !afterDoubleDash) {
        afterDoubleDash = true;
        continue;
      }
      // PowerShell `-Path:value` / `-LiteralPath:value` (any unique abbreviation) names a target.
      const named = !afterDoubleDash ? /^-([A-Za-z]+):(.*)$/.exec(token) : null;
      if (named !== null && (["path", "literalpath"].some((full) => full.startsWith(named[1].toLowerCase())))) {
        targets.push(named[2]);
        continue;
      }
      if (!afterDoubleDash && token.startsWith("-") && token.length > 1) continue;
      if (/^\/[A-Za-z?]$/.test(token)) continue;
      targets.push(token);
    }
    if (!recursive) return;
    // `Get-ChildItem | Remove-Item -Recurse`: the targets come from the previous command and cannot be seen.
    if (targets.length === 0 && segmentInfo?.pipedInto === true) destructive("remove-item-pipeline", "recursive delete of whatever the previous command in the pipeline produces");
    for (const target of targets) {
      const lower = target.toLowerCase();
      if (BROAD_TEXT.has(lower) || /^[A-Za-z]:[\\/]?$/.test(target) || /[\\/]\.\.?$/.test(target)) {
        destructive(name === "remove-item" || name === "ri" ? "remove-item-broad" : "rm-broad");
        continue;
      }
      if (hasVariable(target) && !/^(?:\$\{?(?:HOME|USERPROFILE)|\$env:(?:HOME|USERPROFILE)|%(?:HOME|USERPROFILE)%)/i.test(target)) {
        destructive("rm-unresolved-target", "recursive delete of a target that contains an unresolved variable");
        continue;
      }
      // A glob is resolved by its leading directory part. Only a match-everything last component (`*`, `.*`)
      // counts as "the contents of that directory"; `*.log` removes some files, not the directory.
      let probe = target;
      let matchesAll = false;
      if (GLOB.test(target)) {
        const parts = target.split(/[\\/]/);
        const first = parts.findIndex((part) => GLOB.test(part));
        matchesAll = first === parts.length - 1 && (parts[first] === "*" || parts[first] === ".*");
        probe = parts.slice(0, first).join("/");
        if (probe === "" && /^[\\/]/.test(target)) probe = "/";
        if (probe === "") probe = ".";
      }
      const expanded = tools.expand(probe, state.cwd);
      if ("unresolved" in expanded) {
        destructive("rm-unresolved-target", "recursive delete of a target that cannot be resolved");
        continue;
      }
      const resolved = tools.realResolve(expanded.path);
      if (!tools.inside(rootReal, resolved)) destructive("rm-outside-workspace", "recursive delete outside the workspace");
      else if (tools.same(resolved, rootReal) && (matchesAll || !GLOB.test(target))) destructive("rm-workspace-root", "recursive delete of the workspace root");
    }
  }

  const FIND_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-newer", "-mtime", "-mmin", "-ctime", "-cmin", "-atime", "-amin", "-size", "-user", "-group", "-perm", "-samefile", "-inum"]);
  const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

  /** `find ... -delete` and `find ... -exec cmd {} +`: the start paths are what gets deleted or handed to the command. */
  function analyzeFind(args, segmentInfo) {
    let k = 0;
    while (k < args.length && ["-H", "-L", "-P"].includes(args[k])) k += 1;
    const starts = [];
    while (k < args.length && !args[k].startsWith("-") && args[k] !== "(" && args[k] !== "!") {
      starts.push(args[k]);
      k += 1;
    }
    const expressions = args.slice(k);
    const deleting = expressions.includes("-delete");
    const execAt = expressions.findIndex((arg) => FIND_EXEC.has(arg));
    const roots = starts.length > 0 ? starts : ["."];
    const filtered = expressions.some((arg) => FIND_FILTERS.has(arg));
    if (deleting || execAt >= 0) {
      for (const start of roots) {
        checkPath(start, { writer: true, strict: true, label: "a find start path" });
        const expanded = tools.expand(start, state.cwd);
        if ("unresolved" in expanded) {
          destructive("find-unresolved-start", "find -delete or -exec on a start path that cannot be resolved");
          continue;
        }
        const resolved = tools.realResolve(expanded.path);
        if (!tools.inside(rootReal, resolved)) destructive("find-outside-workspace", "find -delete or -exec acting on a path outside the workspace");
        else if (tools.same(resolved, rootReal) && !filtered) destructive("find-workspace-root", "find -delete or -exec over the whole workspace without a name or time filter");
      }
    }
    if (deleting) segmentInfo.deleting = true;
    if (execAt >= 0) {
      let end = expressions.findIndex((arg, at) => at > execAt && (arg === ";" || arg === "+"));
      if (end < 0) end = expressions.length;
      const inner = expressions.slice(execAt + 1, end);
      for (const start of roots) analyzeWords(inner.map((word) => word.split("{}").join(start)), { op: null, pipedInto: false });
    }
  }

  /** Files a `sed -i` edits: every operand but the script. */
  function sedFiles(args) {
    const files = [];
    let scriptSeen = false;
    for (let j = 0; j < args.length; j += 1) {
      const arg = args[j];
      if (arg === "-e" || arg === "-f" || arg === "--expression" || arg === "--file") {
        scriptSeen = true;
        j += 1;
      } else if (arg.startsWith("-")) continue;
      else if (!scriptSeen) scriptSeen = true;
      else files.push(arg);
    }
    return files;
  }

  /** Flag that makes an interpreter run text from the command line (`node -e`, `python -c`, `deno eval`...), or null. */
  function inlineInterpreterFlag(name, args) {
    const entry = INLINE_INTERPRETERS.find((candidate) => candidate.name.test(name));
    if (entry === undefined) return null;
    for (let j = 0; j < args.length; j += 1) {
      const arg = args[j];
      if (arg === "-") return "-";
      if (entry.flag.test(arg)) return arg;
      if (entry.name.test("deno")) return null;
      if (!arg.startsWith("-")) return null;
      if (entry.valueFlags.has(arg)) j += 1;
    }
    return null;
  }

  function runInline(text, label, ruleId, dialect = depthBox.dialect) {
    mutating = true;
    unparseable(`${label} runs a command string the guard cannot follow`, ruleId);
    analyzeString(text, depthBox.depth + 1, dialect);
  }

  function decodePowerShell(value) {
    try {
      return Buffer.from(value, "base64").toString("utf16le");
    } catch {
      return "";
    }
  }

  /** Analyze the words of one command (after wrappers). */
  function analyzeCommand(name, rawWord, args, segmentInfo) {
    if (hasVariable(rawWord) && !rawWord.includes("/") && !rawWord.includes("\\")) {
      unparseable("the command name is a variable", "command-variable");
      return;
    }
    if (DYNAMIC_COMMANDS.has(name)) {
      mutating = true;
      unparseable(`${name} runs a program or script the guard cannot follow`, `dynamic-${name.replace(/[^a-z0-9]+/g, "-")}`);
    }
    const inline = inlineInterpreterFlag(name, args);
    if (inline !== null) {
      mutating = true;
      unparseable(`${name} ${inline} runs code the guard cannot follow`, "inline-interpreter");
    }
    if (name === "git") analyzeGit(args, segmentInfo);
    if (REMOVERS.has(name)) analyzeRemove(name, args, segmentInfo);
    if (SHELLS.has(name)) {
      const flagIndex = args.findIndex((arg) => /^-[A-Za-z]*c[A-Za-z]*$/.test(arg));
      if (flagIndex >= 0) {
        runInline(args[flagIndex + 1] ?? "", `${name} -c`, "shell-inline", "posix");
        return;
      }
      if (segmentInfo.pipedInto && args.every((arg) => arg.startsWith("-"))) unparseable(`output is piped into ${name}`, "pipe-to-shell");
    }
    if (name === "cmd") {
      const flagIndex = args.findIndex((arg) => /^\/[ck]$/i.test(arg));
      if (flagIndex >= 0) {
        runInline(args.slice(flagIndex + 1).join(" "), "cmd /c", "cmd-inline", "cmd");
        return;
      }
    }
    if (POWERSHELLS.has(name)) {
      const encodedIndex = args.findIndex((arg) => /^-e(?:c|nc|ncodedcommand)?$/i.test(arg) || /^-encodedcommand$/i.test(arg));
      if (encodedIndex >= 0) {
        runInline(decodePowerShell(args[encodedIndex + 1] ?? ""), "powershell -EncodedCommand", "powershell-encoded", "powershell");
        return;
      }
      const commandIndex = args.findIndex((arg) => /^-c(?:o(?:m(?:m(?:a(?:nd?)?)?)?)?)?$/i.test(arg));
      if (commandIndex >= 0) {
        runInline(args.slice(commandIndex + 1).join(" "), "powershell -Command", "powershell-inline", "powershell");
        return;
      }
      if (segmentInfo.pipedInto && args.every((arg) => arg.startsWith("-"))) unparseable(`output is piped into ${name}`, "pipe-to-shell");
    }
    if (name === "eval") {
      runInline(args.join(" "), "eval", "eval");
      return;
    }
    if (name === "iex" || name === "invoke-expression") {
      runInline(args.join(" "), name, "invoke-expression", "powershell");
      return;
    }
    if (name === "find") analyzeFind(args, segmentInfo);
    if (name === "docker" && args[0] === "system" && args[1] === "prune" && args.some((arg) => arg === "--all" || /^-[A-Za-z]*a[A-Za-z]*$/.test(arg))) destructive("docker-prune-all");
    if (name === "kubectl") {
      const del = args.indexOf("delete");
      if (del >= 0 && args.slice(del + 1).some((arg) => /^(?:namespaces?|ns)(?:\/.*)?$/i.test(arg))) destructive("kubectl-delete-namespace");
    }
    if ((name === "terraform" || name === "tofu") && (args.includes("destroy") || args.some((arg) => /^-destroy$/i.test(arg)))) destructive("terraform-destroy");
    if (name === "gh") {
      const [area, verb] = args.filter((arg) => !arg.startsWith("-"));
      if (area === "pr" && verb === "merge") add("OUT_OF_POLICY_OPERATION", "gh-pr-merge", "merging a pull request needs explicit approval", { operation: "merge" });
      else if (area === "pr" && verb === "create") noteOperation("open-pr");
      else if (area === "release" && ["create", "upload", "delete", "edit"].includes(verb)) add("OUT_OF_POLICY_OPERATION", "gh-release", "publishing a release needs explicit approval", { operation: "publish" });
      else if (area === "repo" && verb === "delete") destructive("gh-repo-delete", "deleting a repository is prohibited");
    }
    const sub = args.find((arg) => !arg.startsWith("-"))?.toLowerCase();
    if (PUBLISHERS[name]?.has(sub) && !(name === "terraform" && args.includes("-destroy"))) {
      add("OUT_OF_POLICY_OPERATION", `${name}-${sub}`, `${name} ${sub} changes shared or deployed state and needs explicit approval`, { operation: name === "terraform" || name === "tofu" || name === "kubectl" || name === "helm" ? "deploy" : "publish" });
    }
    if (DEPLOYERS.has(name) && (sub === undefined ? args.includes("--prod") : DEPLOY_VERBS.has(sub))) {
      add("OUT_OF_POLICY_OPERATION", `${name}-deploy`, `${name} deploys to a live environment and needs explicit approval`, { operation: "deploy" });
    }
    if ((name === "az" || name === "gcloud" || name === "aws") && args.some((arg) => DEPLOY_VERBS.has(arg.toLowerCase()) && arg.toLowerCase() === "deploy")) {
      add("OUT_OF_POLICY_OPERATION", `${name}-deploy`, `${name} deploy changes a live environment and needs explicit approval`, { operation: "deploy" });
    }
    if (name === "dotnet" && args.map((arg) => arg.toLowerCase()).join(" ").includes("nuget push")) {
      add("OUT_OF_POLICY_OPERATION", "dotnet-nuget-push", "publishing a package needs explicit approval", { operation: "publish" });
    }
    if (NETWORK_COMMANDS.has(name)) add("NETWORK_EGRESS", `network-${name}`, `${name} talks to the network`, { operation: "network-egress" });
    if (ALWAYS_NETWORK_RUNNERS.has(name)) add("NETWORK_EGRESS", `network-${name}`, `${name} downloads and runs packages from the network`, { operation: "network-egress" });
    if (INSTALL_SUBCOMMANDS[name]?.has(sub ?? "")) add("NETWORK_EGRESS", `install-${name}`, `${name} ${sub} downloads packages from the network`, { operation: "network-egress" });
    if ((name === "python" || name === "python3" || name === "py") && args[0] === "-m" && args[1] === "pip" && ["install", "download"].includes((args[2] ?? "").toLowerCase())) {
      add("NETWORK_EGRESS", "install-pip", "pip install downloads packages from the network", { operation: "network-egress" });
    }
    if (name === "dotnet" && ((sub === "add" && args.includes("package")) || sub === "restore")) add("NETWORK_EGRESS", "install-dotnet", "dotnet restores packages from the network", { operation: "network-egress" });
    if (ENV_DUMPERS.has(name) || (name === "env" && args.length === 0) || (name === "set" && args.length === 0) || ((name === "export" || name === "declare" || name === "typeset") && args.length === 1 && args[0] === "-p")) {
      add("SECRET_ACCESS", "env-dump", "prints the process environment, which can hold secrets");
    }
    if (["export", "declare", "typeset", "readonly", "local", "set-item"].includes(name)) {
      for (const arg of args) if (ASSIGNMENT.test(arg)) checkAssignment(arg);
    }
    // `asterweave run approve` / `node .../asterweave.mjs run approve`: only a person at a terminal may approve.
    const words = [rawWord, ...args];
    const cli = words.findIndex((word) => commandName(word) === "asterweave");
    if (cli >= 0) {
      const plain = words.slice(cli + 1).filter((word) => !word.startsWith("-")).map((word) => word.toLowerCase());
      const run = plain.indexOf("run");
      if (run >= 0 && plain.slice(run + 1).includes("approve")) add("APPROVAL_SELF_GRANT", "run-approve", "approvals can only be granted by a person (terminal prompt or CLI flags), never by the run itself");
      // `asterweave mcp test <server> --approve <hash>` records an MCP approval the same way.
      const mcp = plain.indexOf("mcp");
      if (mcp >= 0 && plain.slice(mcp + 1).includes("test") && words.slice(cli + 1).some((word) => /^--approve(=|$)/i.test(word))) add("APPROVAL_SELF_GRANT", "mcp-approve", "MCP approvals can only be granted by a person (terminal prompt or CLI flags), never by the run itself");
    }
    // Executable configuration (MCP servers, plugins) is changed by a person, whichever door is used: `asterweave mcp|plugin ...` or `claude mcp|plugin ...` directly.
    // Words after the area are matched ANYWHERE (an option value such as `--path x add` must not hide the verb); read-only verbs (list, inspect, validate, test, get) stay allowed.
    const viaXargs = name === "xargs"; // the verb arrives on stdin: any mcp/plugin area is refused whatever the visible verb
    if (cli >= 0) {
      const plainAw = plainWords(words.slice(cli + 1));
      if (viaXargs && AREAS.some((area) => plainAw.includes(area))) add("APPROVAL_SELF_GRANT", "config-mutation", "xargs feeds the verb of an asterweave mcp/plugin command: only a person changes executable configuration");
      if (runsConfigMutation(words.slice(cli + 1), TABLES.asterweave)) add("APPROVAL_SELF_GRANT", "config-mutation", "MCP servers and plugins are executable configuration: only a person changes them (asterweave mcp add|remove, plugin install|uninstall|enable|disable), never the run itself");
    }
    const claudeAt = words.findIndex(isClaudeWord);
    if (claudeAt >= 0) {
      const plainCl = plainWords(words.slice(claudeAt + 1));
      if (viaXargs && AREAS.some((area) => plainCl.includes(area))) add("APPROVAL_SELF_GRANT", "config-mutation", "xargs feeds the verb of a claude mcp/plugin command: only a person changes executable configuration");
      if (runsConfigMutation(words.slice(claudeAt + 1), TABLES.claude)) add("APPROVAL_SELF_GRANT", "config-mutation", "claude mcp/plugin changes alter executable configuration: only a person makes them, never the run itself");
    }
    // Path arguments.
    const inPlace = name === "sed" && args.some((arg) => /^-[A-Za-z]*i/.test(arg) || arg.startsWith("--in-place"));
    const writer = WRITERS.has(name) || inPlace || segmentInfo.deleting === true;
    const strict = FILE_COMMANDS.has(name);
    const creates = CREATORS.has(name);
    if (inPlace) {
      for (const file of sedFiles(args)) checkPath(file, { writer: true, strict: true, label: "a sed -i target" });
    }
    if (name === "dd") {
      for (const arg of args) {
        const match = /^(if|of)=(.*)$/.exec(arg);
        if (match) checkPath(match[2], { writer: match[1] === "of", strict: true, label: "a dd operand" });
      }
    }
    for (const candidate of pathCandidates(args, strict)) checkPath(candidate.text, { writer, strict, label: "an argument", creates, flagValue: candidate.flagValue });
    // A cd without a target goes home. The directory change itself is never followed (see DIRECTORY CHANGES); a lone, plain cd is judged by cdOperandProblem.
    if (CD_COMMANDS.has(name)) {
      const target = cdTarget(args);
      if (target === undefined) checkPath("~", { writer: false, strict: true, label: "cd without a target" });
      // A provider / drive qualified target (`env:`, `FileSystem::C:\`, `C:`) keeps its refusal (a deny where PowerShell can read it) although such a cd is never understood.
      else refuseColon(target, "a file argument", { ps: name === "sl" || name === "set-location" });
    }
    for (const arg of args) checkSecretName(arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg);
  }

  /** The directory operand of a cd / Set-Location: the first non-option word, or the value of `-Path` / `-LiteralPath` (any unique abbreviation, `-Path:x` too). */
  function cdTarget(args) {
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      const named = /^-([A-Za-z]+)(?::(.*))?$/.exec(arg);
      if (named !== null && ["path", "literalpath"].some((full) => full.startsWith(named[1].toLowerCase()))) return named[2] !== undefined ? named[2] : args[i + 1];
      if (!arg.startsWith("-") || arg === "-") return arg;
    }
    return undefined;
  }

  function checkAssignment(token) {
    const name = token.slice(0, token.indexOf("="));
    if (DANGEROUS_ENV.test(name)) unparseable(`setting ${name} changes what programs execute or load`, "env-assignment");
  }

  let notListedReported = false;

  /**
   * N1 -- EMBEDDED REPOSITORIES. `git` (and `gh`, which runs git) discovers its repository from the working directory by walking UP until a directory is a
   * repository: `.git`, or a directory that merely LOOKS like a git directory (HEAD + objects/ + refs/, or HEAD + commondir, `safe.bareRepository`
   * defaults to `all`). A hostile repository can COMMIT such a directory (`evil/HEAD`, `evil/config`, `evil/objects/*`, `evil/refs/*`), and git run from inside
   * it then uses `evil/config` (`core.fsmonitor`, `diff.external`, hooks, remote URLs...): attacker code. So git is understood only when its discovery
   * from the working directory (the hook payload cwd: the guard never follows a cd) ends at `<root>/.git` -- the repository the guard verified
   * and whose remotes it read -- and no directory on the way (the root excluded) holds an entry that makes git stop earlier. A lone `cd` is judged by the
   * same walk on its target, because the next command is run from the directory it leaves the shell in.
   */
  const EMBEDDED_REPO_ENTRIES = Object.freeze([".git", "HEAD", "commondir"]);
  const embeddedWalk = new Map();
  /** Why git run from `directoryText` is NOT understood (a sentence), or null when its discovery reaches the verified root. */
  function embeddedProblem(directoryText) {
    const real = tools.realResolve(directoryText);
    if (!tools.inside(rootReal, real)) return "the working directory is outside the workspace root";
    if (embeddedWalk.has(real)) return embeddedWalk.get(real);
    let problem = null;
    let directory = real;
    while (problem === null && !tools.same(directory, rootReal)) {
      const found = EMBEDDED_REPO_ENTRIES.find((name) => nodeExists(p.join(directory, name)));
      if (found !== undefined) problem = `the working directory is, or is inside, a directory with its own '${found}' entry, which git would use as the repository instead of the workspace repository`;
      else if (nodeExists(p.join(directory, "objects")) && nodeExists(p.join(directory, "refs"))) problem = "the working directory is, or is inside, a directory that holds 'objects' and 'refs' entries, which git can take for a repository";
      else {
        const parent = p.dirname(directory);
        if (parent === directory) problem = "the working directory is outside the workspace root";
        else directory = parent;
      }
    }
    embeddedWalk.set(real, problem);
    return problem;
  }

  /**
   * F5 -- why NO git or gh form (read, commit, push, pr create) is understood, or null. The guard verified (remotes, hooks path, branch) the repository at
   * `<root>/.git`, so that entry (a directory, or the file of a linked worktree) must exist: a root without one (a bare repository's own directory, a
   * directory with HEAD + objects + refs or HEAD + commondir, a plain directory whose repository is above it) is not a repository the guard knows. The
   * root must also be the top of its working tree (hooksPathOf !== false), and the payload working directory must reach the root's own repository.
   */
  function gitProblem() {
    if (!nodeExists(p.join(rootReal, ".git"))) {
      const bare = nodeExists(p.join(rootReal, "HEAD")) && ((nodeExists(p.join(rootReal, "objects")) && nodeExists(p.join(rootReal, "refs"))) || nodeExists(p.join(rootReal, "commondir")));
      return bare ? "the workspace root has no '.git' entry and itself looks like a bare repository (HEAD with objects/refs, or commondir)" : "the workspace root has no '.git' entry";
    }
    if (!hooksPathKnown()) return "the workspace root is not the top of its git working tree";
    return embeddedProblem(state.cwd);
  }

  const CD_PLAIN = /^(?:[A-Za-z]:[\\/])?[\p{L}\p{N}_@. \\/-]+$/u;
  /**
   * Why a LONE `cd` / `Set-Location` to `operand` is not understood, as `{ruleId, detail}`, or null. Only a plain in-workspace directory is: no wildcard
   * (`* ? [`, a PowerShell backtick), no `~`, `$`, `%`, quote, colon (provider / drive qualified) or `-`; no component ending in a dot or space (Windows
   * drops them, so the real directory is another one); no `name/..` (bash falls back to the physical directory); in the posix reading no CDPATH-sensitive
   * spelling (a relative operand that does not start with ./ or ../ is the directory it names only when it exists here as a real directory); and the target
   * is no embedded repository. The operand is judged against the payload working directory, which no earlier command can have changed.
   */
  function cdOperandProblem(operand) {
    const plain = (detail) => ({ ruleId: "cd-operand-not-plain", detail });
    if (!CD_PLAIN.test(operand) || operand.trim() === "" || operand.startsWith("-")) return plain("the directory operand is not a plain path (wildcards, ~, $, %, quotes, escapes, '-' and provider or drive qualified forms are resolved by the shell in ways the guard cannot predict)");
    const parts = operand.split(/[\\/]/).filter((part) => part !== "");
    let named = false;
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") {
        if (named) return plain("the directory operand goes up from a named directory (bash falls back to the physical parent when it differs)");
        continue;
      }
      if (/[. ]$/.test(part)) return plain("a component of the directory operand ends in a dot or a space, which Windows drops");
      named = true;
    }
    const expanded = tools.expand(operand, state.cwd);
    if ("unresolved" in expanded) return plain("the directory operand cannot be resolved");
    if (depthBox.dialect === "posix" && !/^[\\/]/.test(operand) && !/^[A-Za-z]:[\\/]/.test(operand) && parts[0] !== "." && parts[0] !== "..") {
      const cdpath = (options.env ?? process.env).CDPATH;
      if (typeof cdpath === "string" && cdpath !== "") return plain("CDPATH is set, so a relative directory not starting with ./ or ../ may be found in another directory");
      if (!isDirectoryNode(expanded.path)) return plain("the directory does not exist here as a real directory, so CDPATH could resolve the operand elsewhere (write ./name)");
    }
    const embedded = embeddedProblem(expanded.path);
    return embedded === null ? null : { ruleId: "git-embedded-repository", detail: embedded.replace(/^the working directory/, "the directory") };
  }

  /** Is `absolute` a real directory (not a link)? A budgeted lstat; a result without isDirectory() counts as a directory. */
  function isDirectoryNode(absolute) {
    try {
      const stat = lstat(absolute);
      return stat !== null && stat !== undefined && (typeof stat.isDirectory !== "function" || stat.isDirectory());
    } catch (error) {
      if (error instanceof BudgetError) throw error;
      return false;
    }
  }

  let remoteNames; // undefined = not read yet; null = unknown; else a Set of configured remote names
  /**
   * May `git push <name> ...` be an understood form? Only when `name` is a remote configured in the repository at the verified workspace root
   * (read once per classification) AND nothing of that name sits in the workspace or the working directory: git treats any other word as a
   * local path and runs the receive-pack hooks of the repository there, and the agent can create one with plain file writes.
   */
  function remoteIsConfigured(name) {
    if (remoteNames === undefined) {
      let names = null;
      try {
        names = remotesOf(rootReal);
      } catch (error) {
        if (error instanceof BudgetError) throw error;
      }
      remoteNames = Array.isArray(names) ? new Set(names.filter((entry) => typeof entry === "string")) : null;
    }
    if (remoteNames === null || !remoteNames.has(name)) return false;
    return ![rootReal, state.cwd].some((directory) => nodeExists(p.join(directory, name)));
  }

  /**
   * Analyze the words of one command. The segment is ALLOWED only when it is a form the allow-list understands (or the user's
   * `allowCommands` lists it); otherwise it is UNPARSEABLE_COMMAND. The deny floors run either way, and for a segment that is not
   * understood they also look at every later word that names a command of interest (`exec -a x git push ...`).
   */
  function analyzeWords(words, segmentInfo) {
    tick();
    globUnverified = false;
    let k = 0;
    let shellSyntax = false; // VAR=x prefixes and keywords (if, then, !, {, ...) make the segment more than one plain command
    while (k < words.length) {
      const token = words[k];
      if (ASSIGNMENT.test(token)) {
        checkAssignment(token);
        shellSyntax = true;
        k += 1;
        continue;
      }
      if (KEYWORDS.has(token.toLowerCase())) {
        shellSyntax = true;
        k += 1;
        continue;
      }
      break;
    }
    const reportNotListed = (name) => {
      mutating = true;
      if (notListedReported) return;
      notListedReported = true;
      unparseable(`'${String(name).replace(/[^\w.:-]/g, "?").slice(0, 40)}' is not a command line the guard fully understands; only a short list of read-only commands and the commit, push-branch and open-pr operations are allowed without approval`, "not-allow-listed");
    };
    if (k >= words.length) {
      // A segment with no command word. Assignments / keywords only (`FOO=bar`, `then`), or a redirection with no command (`> src/a.js` truncates or
      // creates a file, `< f`, `2>&1`), or a segment inside a subshell / `|&`, is shell syntax that does something: never an understood form.
      // A segment that is nothing at all (empty text, whitespace, a comment, `;;`, a lone operator) does not reach this function: no command
      // runs, so there is nothing to allow or refuse.
      if (shellSyntax || segmentInfo.plain === false || segmentInfo.redirected === true) reportNotListed(segmentInfo.redirected === true ? "redirection" : "shell syntax");
      return;
    }
    const rawWord = words[k];
    const name = commandName(rawWord);
    const argv = words.slice(k);
    const info = { ...segmentInfo, gitSub: undefined, gitReadOnly: undefined };
    segmentsOut.push({ command: name, argv, op: segmentInfo.op });
    let listed = false;
    let cwdProblem = null;
    let cdProblem = null;
    let form = { ok: false };
    commandCount += 1;
    if (CWD_COMMANDS.has(name)) cwdChangeSeen = true;
    if (!shellSyntax && segmentInfo.plain !== false) {
      listed = matchesAllowCommand(words, allowCommands);
      if (!listed && /^[A-Za-z][A-Za-z0-9-]*$/.test(rawWord)) {
        form = understoodForm(rawWord.toLowerCase(), argv.slice(1), {
          dialect: depthBox.dialect, pipedInto: segmentInfo.pipedInto === true, remoteOk: remoteIsConfigured, hooksOk: hooksPathKnown,
          cwdOk: () => {
            cwdProblem = gitProblem();
            return cwdProblem === null;
          },
          cdOk: (operand) => {
            cdProblem = cdOperandProblem(operand);
            return cdProblem === null;
          },
        });
        if (cwdProblem !== null) unparseable(`${cwdProblem}; a git or gh command line is only understood when the workspace root is a repository and git finds it from where it runs`, "git-embedded-repository");
        if (cdProblem !== null) unparseable(`${cdProblem.detail}; a cd is only understood alone, with a plain existing directory of the workspace`, cdProblem.ruleId);
      }
    }
    state.patternArgs = new Set(form.ok ? form.pattern ?? [] : []);
    state.understood = form.ok;
    analyzeCommand(name, rawWord, argv.slice(1), info);
    state.patternArgs = new Set();
    state.understood = false;

    let understood = false;
    let readOnly = false;
    if (!shellSyntax && segmentInfo.plain !== false) {
      if (listed) {
        understood = true;
      } else {
        if (form.ok) {
          let refused = false;
          for (const operand of form.paths) {
            // Provider / drive qualified operands (`env:X`, `FileSystem::C:\x`, `C:x`) are refused first; the path checks still run, so a secret
            // or protected name in the same operand keeps its own (deny) verdict.
            if (refuseColon(operand, "a file argument", { ps: form.ps === true })) refused = true;
            checkPath(operand, { writer: false, strict: true, label: "a file argument" });
          }
          for (const ref of form.refs) {
            checkSecretName(ref.includes(":") ? ref.slice(ref.lastIndexOf(":") + 1) : ref);
            // Every git operand is checked as a path too (strictly): a revision and a file look alike, and `git diff /abs/a b`, `git blame /abs/x`
            // and `git ls-files /abs` read files outside the repository. Only `--flag=value` text (`--grep=/re/`) is judged leniently.
            checkPath(ref, { writer: false, strict: true, label: "a git argument" });
          }
          understood = !globUnverified && !refused;
          readOnly = form.readOnly;
        }
      }
    }
    if (!understood) {
      reportNotListed(name);
      const limit = Math.min(argv.length, MAX_SPECULATIVE_WORDS);
      for (let j = 1; j < limit; j += 1) {
        const inner = commandName(argv[j]);
        if (DEEP_NAMES.has(inner)) analyzeCommand(inner, argv[j], argv.slice(j + 1), { ...info, gitSub: undefined, gitReadOnly: undefined });
      }
    } else if (!readOnly) mutating = true;
  }

  function analyzeString(text, depth, dialect) {
    if (depth > MAX_DEPTH) {
      unparseable("commands are nested too deeply", "nested-too-deep");
      return;
    }
    tick();
    const previous = { depth: depthBox.depth, dialect: depthBox.dialect };
    depthBox.depth = depth;
    depthBox.dialect = dialect;
    floorScan(dialect === "powershell" ? normalizePowerShell(text) : text, (id) => destructive(id));
    const tokens = tokenize(text, { platform, dialect });
    for (const problem of tokens.problems) unparseable(problem, `unparseable-${problem.replace(/[^a-z]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}`);
    const wordCount = tokens.segments.reduce((total, segment) => total + segment.words.length, 0);
    if (wordCount > MAX_WORDS || tokens.segments.length > MAX_SEGMENTS) {
      unparseable("the command has too many words or commands for the guard to follow", "command-too-complex", true);
    } else {
      // The same patterns on the de-escaped word stream: `g\it re\set --hard` is `git reset --hard` to the shell.
      floorScan(tokens.segments.map((segment) => segment.words.map((word) => word.text).join(" ")).join("\n"), (id) => destructive(id));
      for (const segment of tokens.segments) {
        const words = segment.words.map((word) => word.text);
        let plain = !["(", ")", "|&"].includes(segment.op);
        for (const redirect of segment.redirects) {
          const target = redirect.target;
          if (redirect.op.endsWith("&") && /^(?:\d+|-)$/.test(target)) continue; // 2>&1
          if (SAFE_DEVICES.has(target.toLowerCase()) && (!redirect.op.startsWith("<") || redirect.op === "<")) continue;
          plain = false; // a redirection to or from a file is never an understood form
          if (!redirect.op.startsWith("<") || redirect.op === "<") {
            const writes = redirect.op.startsWith(">") || redirect.op.startsWith("&>");
            if (writes) mutating = true;
            checkPath(target, { writer: writes, strict: true, label: "a redirection target", creates: false });
            checkSecretName(target);
          }
        }
        analyzeWords(words, { op: segment.op, pipedInto: segment.pipedInto, plain, redirected: segment.redirects.length > 0 });
      }
    }
    depthBox.depth = previous.depth;
    depthBox.dialect = previous.dialect;
  }

  try {
    if (typeof options.asPath === "string") {
      // A tool path (Write / Edit / Read): one path, never shell syntax. No `$`, `%` or `~` expansion; Windows stream, 8.3, trailing dot
      // and space forms are normalized by the protected-path check. A bad path (control characters) is refused by the caller.
      const writes = options.asPath === "write";
      if (writes) mutating = true;
      checkPath(command, { writer: writes, strict: true, label: "the file path", creates: false, literal: true });
      checkSecretName(command);
    } else {
      for (const dialect of dialects) {
        commandCount = 0;
        cwdChangeSeen = false;
        analyzeString(command, 0, dialect);
        // A reading of the line that changes directory together with another command is not understood: where that command runs cannot be predicted.
        if (cwdChangeSeen && commandCount > 1) {
          mutating = true;
          unparseable("a directory change (cd, Set-Location, pushd ...) is combined with other commands; the guard does not follow directory changes, so the directory they run in is unknown", "cwd-change-with-other-commands");
        }
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetError)) throw error;
    unparseable(`${error.message}; the command is too complex for the guard to review, so it is refused in every mode`, "command-too-complex", true);
  }
  // A line the classifier could not resolve (a variable or substitution as the command word, ...) that still names claude, an area and a mutating verb.
  if (typeof options.asPath !== "string" && findings.some((finding) => finding.code === "UNPARSEABLE_COMMAND" && finding.ruleId !== "not-allow-listed") && !findings.some((finding) => finding.ruleId === "config-mutation") && namesConfigMutation(command)) {
    add("APPROVAL_SELF_GRANT", "config-mutation", "the line names claude/asterweave, an mcp or plugin area and a mutating verb but cannot be followed; only a person changes executable configuration");
  } else if (typeof options.asPath !== "string" && findings.some((finding) => UNRESOLVED_COMMAND_RULES.has(finding.ruleId)) && !findings.some((finding) => finding.ruleId === "config-mutation") && unresolvedConfigMutation(command)) {
    add("APPROVAL_SELF_GRANT", "config-mutation", "the command word cannot be resolved (a variable, Invoke-Expression, eval) and the line has an mcp or plugin area followed by something other than a read-only verb; only a person changes executable configuration");
  }
  return { segments: segmentsOut, findings, operations, mutating };
}
