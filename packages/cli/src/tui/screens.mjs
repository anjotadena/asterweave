// Pure screen builders for the launch flow (sign-in screen and the working-session frame).
// Every function returns a string and never touches a stream or the process.

import { frame, renderBanner, renderHeader, renderPicker, renderStrip, truncate } from "./render.mjs";

export const NOT_AVAILABLE = "Not available in this build (agent sessions arrive in a later phase).";
export const SIGN_IN_TITLE = "Sign in to continue.";
export const SIGN_IN_PROMPT = "? Choose a provider:";
export const SIGN_IN_NOTE = "A browser will open to authorize Asterweave. After approval, return here to continue.";
export const HINT_LINE = "/commands show commands   @context add context (e.g. @repo)";

/** Sign-in choices. GitHub is first because it is required to launch. */
export const SIGN_IN_PROVIDERS = Object.freeze([
  Object.freeze({ id: "github", label: "GitHub (recommended)" }),
  Object.freeze({ id: "browser", label: "Browser sign-in" }),
]);

/** Slash commands offered by the composer completion list. */
export const SLASH_COMMANDS = Object.freeze([
  Object.freeze({ name: "/help", hint: "show the command list" }),
  Object.freeze({ name: "/commands", hint: "show the command list" }),
  Object.freeze({ name: "/sessions", hint: "browse sessions" }),
  Object.freeze({ name: "/usage", hint: "show usage" }),
  Object.freeze({ name: "/settings", hint: "open settings" }),
  Object.freeze({ name: "/context", hint: "add context (@)" }),
  Object.freeze({ name: "/exit", hint: "leave Asterweave" }),
]);

/**
 * Wrap plain text to `width` columns (code points): at spaces where possible, hard-split for words
 * longer than a line. Always returns at least one line.
 */
export function wrapPlain(text, width) {
  const size = Math.max(1, width);
  if ([...String(text)].length <= size) return [String(text)];
  const out = [];
  let line = "";
  const flush = () => { out.push(line); line = ""; };
  for (const word of String(text).split(" ")) {
    let rest = [...word];
    if (line && [...line].length + 1 + rest.length <= size) { line += ` ${word}`; continue; }
    if (line) flush();
    while (rest.length > size) { out.push(rest.slice(0, size).join("")); rest = rest.slice(size); }
    line = rest.join("");
  }
  flush();
  return out;
}

const wrapAll = (text, width) => wrapPlain(text, width);

/**
 * Screen 01: `Sign in to continue.` with the provider picker and the browser note.
 * @param {{version?: string, index?: number, notice?: string, width?: number, style?: object}} options
 */
export function renderSignInScreen({ version, index = 0, notice = "", width = 80, style } = {}) {
  const body = [
    "",
    style ? style.bold(SIGN_IN_TITLE) : SIGN_IN_TITLE,
    ...(notice ? ["", ...wrapAll(notice, width)] : []),
    "",
    renderPicker({ title: SIGN_IN_PROMPT, items: SIGN_IN_PROVIDERS.map(({ label }) => ({ label })), selected: index, width, style }),
    "",
    ...wrapAll(SIGN_IN_NOTE, width).map((line) => (style ? style.dim(line) : line)),
  ];
  return frame({
    header: `${style ? style.bold(`Asterweave v${version ?? "?"}`) : `Asterweave v${version ?? "?"}`}   Sign in`,
    body,
    footer: renderStrip({ items: [{ key: "Up/Down", label: "move" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }], width, style }),
    width,
  });
}

/**
 * Launch banner lines: renderBanner's lines plus the model-provider and account-plane lines and
 * the (wrapped) warnings, placed right after the runner line.
 * @param {{account?: string, repo?: string, branch?: string, model?: {ok: boolean, authMethod?: string|null}, warnings?: string[], width?: number, style?: object}} options
 * @returns {string[]}
 */
export function buildBannerLines({ account, repo, branch, model, warnings = [], width = 80, style } = {}) {
  const lines = renderBanner({ account, repo, branch, runner: "Local", width, style }).split("\n");
  const extra = [];
  const ok = style ? style.green("✓") : "✓";
  if (model?.ok) extra.push(`${ok} Model: Claude Code${model.authMethod ? ` · ${model.authMethod}` : ""}`);
  extra.push(style ? style.dim("Asterweave account: unavailable (local session)") : "Asterweave account: unavailable (local session)");
  // Warnings are wrapped (not truncated) so a long path in a remediation stays readable.
  for (const warning of warnings) {
    wrapPlain(warning, Math.max(10, width - 2)).forEach((part, index) => extra.push(index === 0 ? `${style ? style.yellow("!") : "!"} ${part}` : `  ${part}`));
  }
  const runner = lines.findIndex((line) => line.includes("Runner:"));
  lines.splice(runner < 0 ? lines.length : runner + 1, 0, ...extra);
  return lines.map((line) => truncate(line, width));
}

/** `> text` composer line with a cursor, scrolled horizontally so the cursor stays visible. */
export function renderComposer({ buffer, cursor, width = 80, style }) {
  const room = Math.max(1, width - 3);
  let start = 0;
  if (buffer.length + 1 > room) start = Math.min(Math.max(0, cursor - room + 1), buffer.length + 1 - room);
  const shown = buffer.slice(start, start + room);
  const at = cursor - start;
  const before = shown.slice(0, at).join("");
  const under = shown[at];
  const after = shown.slice(at + 1).join("");
  const caret = style?.enabled ? style.inverse(under ?? " ") : `▏${under ?? ""}`;
  return `${style ? style.cyan("> ") : "> "}${before}${caret}${after}`;
}

const FIXED_ROWS = 6; // header, rule, rule, hint, footer, composer

/**
 * The working-session frame: header, scrolling area (banner, welcome, transcript), optional
 * completion overlay, then hint strip, footer strip and the persistent composer.
 * @param {{
 *   version?: string, repo?: string, branch?: string, banner?: string[], welcome?: string, transcript?: string[],
 *   overlay?: {title: string, items: Array<{label: string, hint?: string}>, index: number} | null,
 *   buffer?: string[], cursor?: number, width?: number, rows?: number, style?: object,
 * }} options
 */
export function renderSessionScreen({ version, repo, branch, banner = [], welcome = "", transcript = [], overlay = null, buffer = [], cursor = 0, width = 80, rows = 24, style } = {}) {
  const overlayLines = overlay ? overlayBlock(overlay, width, style).split("\n") : [];
  const scrollHeight = Math.max(1, rows - FIXED_ROWS - overlayLines.length);
  const content = [
    ...banner.map((line) => truncate(line, width)),
    "",
    welcome ? (style ? style.bold(welcome) : welcome) : "",
    ...transcript.flatMap((line) => wrapAll(line, width)),
  ];
  const visible = content.slice(-scrollHeight);
  while (visible.length < scrollHeight) visible.push("");
  const rule = "─".repeat(Math.max(1, width));
  return frame({
    header: renderHeader({ version, repo, branch, width, style }),
    body: [
      ...visible,
      ...overlayLines,
      rule,
      style ? style.dim(HINT_LINE) : HINT_LINE,
      renderStrip({ items: [{ key: "/ @", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "close" }], width, style }),
      renderComposer({ buffer, cursor, width, style }),
    ],
    width,
  });
}

const OVERLAY_ROWS = 8;

/** Completion list (at most OVERLAY_ROWS items, scrolled around the selection). */
function overlayBlock({ title, items, index }, width, style) {
  let start = 0;
  if (items.length > OVERLAY_ROWS) start = Math.min(Math.max(index - Math.floor(OVERLAY_ROWS / 2), 0), items.length - OVERLAY_ROWS);
  return renderPicker({ title, items: items.slice(start, start + OVERLAY_ROWS), selected: index - start, width, style });
}
