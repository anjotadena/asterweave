import assert from "node:assert/strict";
import test from "node:test";
import { createStyle, frame, renderBanner, renderHeader, renderPicker, renderStrip, stripAnsi, truncate, visibleLength } from "../src/tui/render.mjs";

test("stripAnsi, visibleLength and truncate ignore escape sequences", () => {
  const colored = "\x1b[31mhello\x1b[39m world";
  assert.equal(stripAnsi(colored), "hello world");
  assert.equal(visibleLength(colored), 11);
  assert.equal(truncate("hello world", 20), "hello world");
  assert.equal(truncate("hello world", 6), "hello…");
  assert.equal(truncate("abc", 0), "");
  const cut = truncate(colored, 4);
  assert.equal(stripAnsi(cut), "hel…");
  assert.ok(cut.endsWith("\x1b[0m"), "styles are reset after cutting");
  assert.equal(truncate(colored, 11), colored);
});

test("createStyle disables color for NO_COLOR, non-TTY, and mode never", () => {
  assert.equal(createStyle({ env: {}, isTTY: true }).enabled, true);
  assert.equal(createStyle({ env: { NO_COLOR: "1" }, isTTY: true }).enabled, false);
  assert.equal(createStyle({ env: { NO_COLOR: "1" }, isTTY: true, mode: "always" }).enabled, false);
  assert.equal(createStyle({ env: {}, isTTY: false }).enabled, false);
  assert.equal(createStyle({ env: {}, isTTY: true, mode: "never" }).enabled, false);
  assert.equal(createStyle({ env: {}, isTTY: false, mode: "always" }).enabled, true);
  assert.equal(createStyle({ env: { NO_COLOR: "" }, isTTY: true }).enabled, true);
  const on = createStyle({ env: {}, isTTY: true });
  assert.equal(on.green("x"), "\x1b[32mx\x1b[39m");
  assert.equal(createStyle({ env: {}, isTTY: false }).green("x"), "x");
});

test("frame lays out header, body, footer within the width", () => {
  const out = frame({ header: "H", body: ["one", "two"], footer: "F", width: 10 });
  assert.equal(out, ["H", "─".repeat(10), "one", "two", "─".repeat(10), "F"].join("\n"));
  assert.equal(frame({ body: "a\nb", width: 5 }), "a\nb");
  assert.ok(frame({ header: "x".repeat(50), width: 12 }).split("\n").every((line) => visibleLength(line) <= 12));
});

test("header and footer strings match the spec", () => {
  assert.equal(renderHeader({ version: "0.1.0", repo: "acme/app", branch: "main", width: 100 }), "Asterweave v0.1.0 | acme/app (main)   /help · Esc to close");
  assert.equal(renderStrip({ items: [{ key: "/ @", label: "select" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "close" }] }), "/ @ select  Enter confirm  Esc close");
});

test("picker highlights the selected row with '> '", () => {
  const out = renderPicker({ title: "Sign in", items: [{ label: "GitHub", hint: "recommended" }, { label: "Claude" }], selected: 1 });
  assert.deepEqual(out.split("\n"), ["Sign in", "", "  GitHub  recommended", "> Claude"]);
  assert.ok(!out.includes("\x1b"));
  const styled = renderPicker({ items: [{ label: "A" }], style: createStyle({ env: {}, isTTY: true }) });
  assert.match(styled, /^\x1b\[36m> /);
  assert.equal(renderPicker({ items: [] }), "");
});

test("banner shows sign-in, repo, runner, warnings, and the welcome line", () => {
  const out = renderBanner({ account: "anjo", repo: "acme/app", branch: "main", warnings: ["Model not signed in (run: claude auth login)"] });
  assert.deepEqual(out.split("\n"), [
    "✓ Signed in: GitHub (anjo)",
    "✓ Repo: acme/app (main)",
    "✓ Runner: Local",
    "! Model not signed in (run: claude auth login)",
    "",
    "Claude Code · local",
  ]);
  assert.ok(!renderBanner({ account: "a" }).includes("\x1b"), "plain style emits no escape bytes");
  assert.ok(renderBanner({ account: "a", style: createStyle({ env: {}, isTTY: true }) }).includes("\x1b[32m"));
});
