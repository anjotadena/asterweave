// Secret redaction and email masking. The patterns mirror `redactText` in
// plugins/asterweave/scripts/handoff-state.mjs (copied, never imported); tests/redact-parity.test.mjs
// proves every shape it redacts is also redacted here. Differences from the plugin, by design:
//   - token-shaped values keep only their well-known prefix: `ghp_…`, `sk-ant-…`, `eyJ…`
//   - email addresses are masked (`an***@g***.com`) instead of replaced wholesale
//
// Every rule that starts a match inside a run of word characters carries a negative lookbehind for
// that run, so the engine never retries from the middle of a long token (linear time on huge logs).

const SECRET_KEY =
  "(?:[A-Za-z0-9]{1,40}[_.-]{1,3}){0,6}(?:password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|apikey|access[_-]?key|secret[_-]?key|secret[_-]?access[_-]?key|auth[_-]?token|access[_-]?token|refresh[_-]?token|token|sharedaccesskey|accountkey|private[_-]?key|signing[_-]?key|jwt[_-]?key|key|pat)";

// A replacement is a string with $1.. group references, or a function receiving the match array.
const REDACTIONS = [
  // Private key blocks first so bodies are not partially matched later; then orphaned halves.
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, "[redacted-private-key]"],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*$/g, "[redacted-private-key]"],
  [/^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g, "[redacted-private-key]"],
  [/(?<![A-Za-z0-9_])(gh[opurs]_)[A-Za-z0-9]{20,}/g, "$1…"],
  [/(?<![A-Za-z0-9_])(github_pat_)[A-Za-z0-9_]{20,}/g, "$1…"],
  [/(?<![A-Za-z0-9_])(glpat-)[A-Za-z0-9_-]{20,}/g, "$1…"],
  [/(?<![A-Za-z0-9_])(npm_)[A-Za-z0-9]{30,}/g, "$1…"],
  [/(?<![A-Za-z0-9_-])(xox[abposr]-)[A-Za-z0-9-]{10,}/g, "$1…"],
  [/(?<![A-Za-z0-9])((?:AKIA|ASIA))[0-9A-Z]{16}(?![A-Za-z0-9])/g, "$1…"],
  [/(?<![A-Za-z0-9_])(AIza)[0-9A-Za-z_-]{30,}/g, "$1…"],
  [/(?<![A-Za-z0-9_-])((?:sk|rk|pk)[-_](?:ant-|live_|test_)?)[A-Za-z0-9_-]{16,}/g, "$1…"],
  [/(?<![A-Za-z0-9_-])(eyJ)[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "$1…"],
  // Credential-shaped values only (a digit or base64 punctuation), so "Basic authentication" survives.
  [/(?<![A-Za-z0-9])(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/=-]*[0-9+/=])[A-Za-z0-9._~+/=-]{12,}/gi, "$1 …"],
  // Credentials embedded in URLs: scheme://user:password@host
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@]+@/gi, "$1[redacted]@"],
  // Key/value secrets in connection strings, env files, JSON, YAML, and CLI flags.
  [new RegExp(`(?<![A-Za-z0-9_.-])(${SECRET_KEY}\\s*(?:["']\\s*)?[:=]\\s*(?:["']\\s*)?)([^\\s;"'&]+)`, "gi"), "$1[redacted]"],
  [/(--(?:password|token|secret|api-key|pat)[= ])(\S+)/gi, "$1[redacted]"],
  // Personal email addresses (masked); the conventional SSH remote user `git@` is not personal data.
  [/(?<![A-Za-z0-9._%+-])(?!git@)[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, (match) => maskEmail(match[0])],
];

/**
 * Mask an email address: `anjo@gmail.com` -> `an***@g***.com`.
 * Non-email input becomes `***`.
 * @param {string} email
 */
export function maskEmail(email) {
  const text = String(email ?? "");
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return "***";
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local.slice(0, local.length > 2 ? 2 : 1)}***@${host.slice(0, 1)}***${tld}`;
}

/**
 * Reduce a token-shaped string to its prefix plus an ellipsis (`ghp_abc…` -> `ghp_…`). Strings with
 * no recognisable prefix become `…`.
 * @param {string} token
 */
export function maskToken(token) {
  const { text } = redactText(String(token ?? ""));
  return text === token ? "…" : text;
}

/**
 * Redact secrets and mask emails in a string. Non-strings pass through with count 0.
 * @param {unknown} value
 * @returns {{text: unknown, count: number}}
 */
export function redactText(value) {
  if (typeof value !== "string") return { text: value, count: 0 };
  let text = value;
  let count = 0;
  for (const [pattern, replacement] of REDACTIONS) {
    text = text.replace(pattern, (...match) => {
      count += 1;
      if (typeof replacement === "function") return replacement(match);
      return replacement.replace(/\$(\d)/g, (_, group) => match[Number(group)] ?? "");
    });
  }
  return { text, count };
}

/**
 * Redact every string inside a JSON-like value (new value; input is not mutated).
 * @template T
 * @param {T} value
 * @returns {{value: T, count: number}}
 */
export function redactDeep(value) {
  let count = 0;
  const visit = (node) => {
    if (typeof node === "string") {
      const result = redactText(node);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === "object") {
      return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, visit(child)]));
    }
    return node;
  };
  return { value: visit(value), count };
}

// Terminal-escape sanitising ------------------------------------------------------------------
//
// Text that comes from a repository, a config file, a remote URL or git/gh output is untrusted: a
// control sequence in it (OSC title/clipboard writes, CSI screen control, C1 controls) would be
// interpreted by the user's terminal. `sanitizeForTerminal` is the ONE place that neutralises it.
// Escape sequences are removed wholesale; any other control character becomes a visible `?`.
// Newline and tab survive. JSON output has its own writer (json.mjs: stringifyJson).
//
// Alternatives, in order: SGR colour (kept only on request); string sequences (OSC/DCS/SOS/PM/APC,
// 7-bit or 8-bit introducer) up to their terminator, which is BEL, ESC \ or the 8-bit ST (0x9c) --
// or a newline, which is never consumed, so an unterminated sequence can hide at most the rest of
// its own line; CSI; any other two-byte ESC sequence (never swallowing a newline); then single stray
// controls (C0 except \n \t, DEL, C1) and bidirectional / line-separator characters.
// A string sequence that ended without a terminator while more text follows leaves a visible `?`.
const TERMINAL_UNSAFE =
  /(\x1b\[[0-9;]*m)|((?:\x1b[\]PX^_]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c\n]*(\x07|\x1b\\|\x9c)?)|\x1b\[[0-?]*[ -/]*[@-~]?|\x1b[^\n]?|[\x00-\x08\x0b-\x1f\x7f-\x9f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * Make untrusted text safe to print to a terminal.
 * @param {unknown} text
 * @param {{allowSgr?: boolean}} [options]  `allowSgr` keeps `ESC[...m` colour codes (for text that already
 *   carries our own styling); everything else is neutralised either way.
 * @returns {string}
 */
export function sanitizeForTerminal(text, { allowSgr = false } = {}) {
  return neutralise(String(text ?? ""), allowSgr, false);
}

function neutralise(text, allowSgr, markTail) {
  return text.replace(TERMINAL_UNSAFE, (match, sgr, stringSequence, terminator, offset, whole) => {
    if (sgr !== undefined) return allowSgr ? match : "";
    if (stringSequence !== undefined) return terminator === undefined && (markTail || offset + match.length < whole.length) ? "?" : "";
    return match.startsWith("\x1b") ? "" : "?";
  });
}

/**
 * Sanitise a multi-line block one line at a time (each line is its own sink), so no sequence can
 * reach across a line boundary. Use for previews, prompts and reports built from several fields.
 * @param {string | string[]} lines  A block of text, or its lines.
 * @param {{allowSgr?: boolean}} [options]
 * @returns {string} the lines joined with `\n`
 */
export function sanitizeLines(lines, options) {
  const list = Array.isArray(lines) ? lines : String(lines ?? "").split("\n");
  // Each line is its own sink, so an unterminated string sequence ends its line and always leaves the `?` marker.
  return list.map((line) => neutralise(String(line ?? ""), options?.allowSgr === true, true)).join("\n");
}

/**
 * Quote one argument for a SUGGESTED shell command (remediation text); null means "do not embed this
 * value in a runnable command". The style follows the platform the suggestion will be run on.
 *
 * POSIX: path-safe characters stay bare; anything else is single quoted, with embedded single quotes
 * written as `'\''`. Single quotes are never expanded by sh/bash/zsh.
 *
 * win32: the suggestion may be pasted into cmd.exe OR PowerShell, and the only quoting both understand
 * is DOUBLE quotes (cmd does not treat single quotes as quotes at all). So a value made only of
 * path-safe characters stays bare (no comma: PowerShell reads it as an array operator); otherwise it is
 * wrapped in double quotes, which is safe in both shells unless the value holds a character that still
 * expands inside them (`$`, backtick for PowerShell; `%`, `!` for cmd), a double quote (a Windows file
 * name cannot hold one, so it signals foreign text; typographic double quotes count as well), a control
 * character, or ends in a backslash (it would escape the closing quote). Those values return null.
 * @param {unknown} value
 * @param {string} [platform]
 * @returns {string | null}
 */
export function quoteArg(value, platform = process.platform) {
  const text = String(value ?? "");
  if (platform !== "win32") {
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) && !text.startsWith("-") ? text : `'${text.replaceAll("'", "'\\''")}'`;
  }
  if (/^[A-Za-z0-9_@+=:.\/\\-]+$/.test(text) && !/^[-@]/.test(text)) return text;
  // eslint-disable-next-line no-control-regex
  if (/[$`%!"\u201c\u201d\u201e\u201f\u2033\uff02\x00-\x1f\x7f-\x9f]|\\$/.test(text)) return null;
  return `"${text}"`;
}

/**
 * Build the text of a suggested command around one untrusted value (usually a path). When the value
 * can be quoted for the platform's shells, the result is `prefix + quoted + suffix`. When it cannot
 * (see `quoteArg`), the value is NOT embedded: the command is shown with a `<path>` placeholder and the
 * value follows on its own line with the instruction to quote it for the user's shell.
 * @param {string} prefix
 * @param {unknown} value
 * @param {string} [suffix]
 * @param {string} [platform]
 * @returns {string}
 */
export function suggestCommand(prefix, value, suffix = "", platform = process.platform) {
  const quoted = quoteArg(value, platform);
  if (quoted !== null) return `${prefix}${quoted}${suffix}`;
  return `${prefix}<path>${suffix}
  where <path> is the following path (quote this path for your shell):
  ${String(value ?? "")}`;
}

const SECRET_NAME = /(?:password|passwd|secret|token|api[_.-]?key|apikey|private[_.-]?key|credential|auth)/i;

/**
 * True for config/environment key names that likely hold a secret (used to hide values in views).
 * @param {string} name
 */
export function isSecretKeyName(name) {
  return SECRET_NAME.test(String(name ?? ""));
}
