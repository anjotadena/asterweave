// Pure rendering helpers: every function returns a string and never touches a stream.
// Color is optional through a `style` object (see createStyle); the default style is plain.

import { sanitizeForTerminal } from "../redact.mjs";

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Remove ANSI escape sequences. */
export const stripAnsi = (text) => String(text).replace(ANSI, "");

/** Printable width of a string (ANSI stripped; code points counted, no wide-char handling). */
export const visibleLength = (text) => [...stripAnsi(text)].length;

/**
 * Cut to `width` visible columns, adding `…` when shortened. ANSI sequences are preserved (and a
 * reset is appended if text was cut after any style was opened).
 */
export function truncate(text, width) {
  const input = String(text);
  if (width <= 0) return "";
  if (visibleLength(input) <= width) return input;
  let out = "";
  let visible = 0;
  let sawAnsi = false;
  for (const part of input.split(/(\x1b\[[0-9;?]*[A-Za-z])/)) {
    if (/^\x1b\[/.test(part)) { out += part; sawAnsi = true; continue; }
    for (const ch of part) {
      if (visible >= width - 1) return `${out}…${sawAnsi ? "\x1b[0m" : ""}`;
      out += ch;
      visible += 1;
    }
  }
  return out;
}

/**
 * Style helpers. Color is off when NO_COLOR is set (non-empty), when not a TTY, or mode is 'never';
 * mode 'always' forces color on unless NO_COLOR is set.
 * @param {{env?: Record<string,string|undefined>, isTTY?: boolean, mode?: 'auto'|'always'|'never'}} [options]
 */
export function createStyle({ env = process.env, isTTY = false, mode = "auto" } = {}) {
  const enabled = !(env.NO_COLOR !== undefined && env.NO_COLOR !== "") && mode !== "never" && (mode === "always" || Boolean(isTTY));
  const wrap = (open, close) => (text) => (enabled ? `\x1b[${open}m${text}\x1b[${close}m` : String(text));
  return {
    enabled,
    bold: wrap(1, 22), dim: wrap(2, 22), inverse: wrap(7, 27),
    red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39),
  };
}

const PLAIN = createStyle({ env: {}, isTTY: false });
const lines = (value) => (Array.isArray(value) ? value : String(value ?? "").split("\n"));

// Everything drawn on a terminal can include repository- or provider-controlled text (repo and branch
// names, accounts, warnings). Dynamic content is sanitised here, BEFORE our own style codes are applied;
// `frame` then runs a last pass that keeps only SGR colour codes. The terminal's own control sequences
// (terminal.mjs SEQ) are written outside this module and are never touched.
const clean = (text) => sanitizeForTerminal(text);
const cleanLine = (text) => sanitizeForTerminal(text, { allowSgr: true });

/**
 * Whole-frame layout: header, rule, body, rule, footer. Every line is truncated to `width`.
 * @param {{header?: string, body?: string|string[], footer?: string, width?: number}} parts
 */
export function frame({ header = "", body = [], footer = "", width = 80 } = {}) {
  const rule = "─".repeat(Math.max(1, width));
  const out = [];
  if (header) out.push(header, rule);
  out.push(...lines(body));
  if (footer) out.push(rule, footer);
  return out.map((line) => truncate(cleanLine(line), width)).join("\n");
}

/** Header line: `Asterweave vX | repo (branch)   /help · Esc to close`. */
export function renderHeader({ version, repo, branch, width = 80, style = PLAIN } = {}) {
  const where = repo ? ` | ${clean(repo)}${branch ? ` (${clean(branch)})` : ""}` : "";
  return truncate(`${style.bold(`Asterweave v${clean(version ?? "?")}`)}${where}   ${style.dim("/help · Esc to close")}`, width);
}

/**
 * Selectable list. The selected row is prefixed with `> ` (and inverted when color is on).
 * @param {{title?: string, items: Array<{label: string, hint?: string}>, selected?: number, width?: number, style?: typeof PLAIN}} options
 */
export function renderPicker({ title, items = [], selected = 0, width = 80, style = PLAIN } = {}) {
  const rows = items.map((item, index) => {
    const text = `${clean(item.label)}${item.hint ? `  ${style.dim(clean(item.hint))}` : ""}`;
    return index === selected ? `${style.cyan("> ")}${style.bold(text)}` : `  ${text}`;
  });
  return [...(title ? [style.bold(clean(title)), ""] : []), ...rows].map((line) => truncate(line, width)).join("\n");
}

/**
 * One-line key strip such as `Enter confirm  Esc close` (also for approval/permission prompts).
 * @param {{items: Array<{key: string, label: string}>, width?: number, style?: typeof PLAIN}} options
 */
export function renderStrip({ items = [], width = 80, style = PLAIN } = {}) {
  return truncate(items.map(({ key, label }) => `${style.bold(clean(key))} ${clean(label)}`).join("  "), width);
}

/**
 * Launch banner. Warnings (e.g. model sign-in missing) are non-blocking `!` lines.
 * @param {{account?: string, repo?: string, branch?: string, runner?: string, warnings?: string[], width?: number, style?: typeof PLAIN}} options
 */
export function renderBanner({ account, repo, branch, runner = "Local", warnings = [], width = 80, style = PLAIN } = {}) {
  const out = [];
  if (account) out.push(`${style.green("✓")} Signed in: GitHub (${clean(account)})`);
  if (repo) out.push(`${style.green("✓")} Repo: ${clean(repo)}${branch ? ` (${clean(branch)})` : ""}`);
  out.push(`${style.green("✓")} Runner: ${clean(runner)}`);
  for (const warning of warnings) out.push(`${style.yellow("!")} ${clean(warning)}`);
  out.push("", `${style.bold("Claude Code")} · ${clean(runner).toLowerCase()}`);
  return out.map((line) => truncate(line, width)).join("\n");
}
