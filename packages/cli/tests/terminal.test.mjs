import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import test from "node:test";
import { createInput } from "../src/tui/input.mjs";
import { createTerminal, SEQ } from "../src/tui/terminal.mjs";

function fakeStreams({ tty = true, columns = 100, rows = 30 } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty, rawCalls: [], setRawMode(value) { this.rawCalls.push(value); } });
  const out = [];
  const stdout = Object.assign(new EventEmitter(), { isTTY: tty, columns, rows, write: (text) => out.push(text) });
  return { stdin, stdout, out, text: () => out.join("") };
}

test("interactive terminals enter raw mode and hide the cursor; restore undoes it", () => {
  const s = fakeStreams();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: { TERM: "xterm" } });
  assert.equal(terminal.isInteractive, true);
  assert.equal(terminal.enter({ altScreen: true }), true);
  assert.deepEqual(s.stdin.rawCalls, [true]);
  assert.equal(s.text(), `${SEQ.altScreenOn}${SEQ.hideCursor}`);
  terminal.restore();
  assert.deepEqual(s.stdin.rawCalls, [true, false]);
  const tail = s.text().slice(`${SEQ.altScreenOn}${SEQ.hideCursor}`.length);
  assert.equal(tail, `${SEQ.pasteOff}${SEQ.showCursor}${SEQ.altScreenOff}`);
  assert.ok(tail.includes("\x1b[?25h") && tail.includes("\x1b[?1049l") && tail.includes("\x1b[?2004l"));
});

test("restore is idempotent and silent when never entered", () => {
  const s = fakeStreams();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  terminal.restore();
  assert.equal(s.text(), "");
  assert.deepEqual(s.stdin.rawCalls, []);
  terminal.enter();
  terminal.enter(); // second enter is a no-op
  assert.deepEqual(s.stdin.rawCalls, [true]);
  terminal.restore();
  const once = s.text();
  terminal.restore();
  terminal.restore();
  assert.equal(s.text(), once);
  assert.deepEqual(s.stdin.rawCalls, [true, false]);
  assert.equal(terminal.entered, false);
});

test("non-interactive streams get no escape bytes and no raw mode", () => {
  for (const options of [{ tty: false }]) {
    const s = fakeStreams(options);
    const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
    assert.equal(terminal.isInteractive, false);
    assert.equal(terminal.enter({ altScreen: true, bracketedPaste: true }), false);
    terminal.draw("frame");
    terminal.restore();
    assert.equal(s.text(), "");
    assert.deepEqual(s.stdin.rawCalls, []);
  }
  const dumb = fakeStreams();
  assert.equal(createTerminal({ stdin: dumb.stdin, stdout: dumb.stdout, env: { TERM: "dumb" } }).isInteractive, false);
});

test("size falls back to 80x24 and resize notifies subscribers until unsubscribed", () => {
  const s = fakeStreams({ columns: 0 });
  s.stdout.rows = undefined;
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  assert.deepEqual([terminal.columns, terminal.rows], [80, 24]);
  const sizes = [];
  const off = terminal.onResize((size) => sizes.push(size));
  s.stdout.columns = 120;
  s.stdout.rows = 40;
  s.stdout.emit("resize");
  assert.deepEqual(sizes, [{ columns: 120, rows: 40 }]);
  off();
  s.stdout.emit("resize");
  assert.equal(sizes.length, 1);
  assert.equal(s.stdout.listenerCount("resize"), 0);
});

test("draw clears and paints only while entered", () => {
  const s = fakeStreams();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  terminal.draw("early");
  assert.equal(s.text(), "");
  terminal.enter({ hideCursor: false });
  terminal.draw("hello");
  assert.equal(s.text(), `${SEQ.clear}hello`);
});

test("cleanup restores on process exit and on an uncaught exception, and uninstalls cleanly", () => {
  const s = fakeStreams();
  const proc = new EventEmitter();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  const uninstall = terminal.installCleanup({ proc });
  // A MONITOR, not a handler: registering an `uncaughtException` handler (that rethrows) turned every
  // crash into exit code 7; the monitor only observes, so Node's default handling prints the error
  // and exits 1.
  assert.deepEqual(["SIGINT", "exit", "uncaughtExceptionMonitor"].map((name) => proc.listenerCount(name)), [1, 1, 1]);
  assert.equal(proc.listenerCount("uncaughtException"), 0, "no uncaughtException handler is installed");

  terminal.enter();
  proc.emit("exit", 0);
  assert.equal(terminal.entered, false);
  assert.ok(s.text().endsWith(SEQ.altScreenOff));

  terminal.enter();
  const boom = new Error("boom");
  assert.doesNotThrow(() => proc.emit("uncaughtExceptionMonitor", boom, "uncaughtException"), "the monitor never rethrows");
  assert.equal(terminal.entered, false, "the crash still restores the terminal");
  assert.equal(proc.listenerCount("uncaughtExceptionMonitor"), 1, "the monitor stays until uninstalled");

  uninstall();
  assert.deepEqual(["SIGINT", "exit", "uncaughtExceptionMonitor"].map((name) => proc.listenerCount(name)), [0, 0, 0]);
});

test("an uncaught error in a real process exits 1 (not 7) after the terminal is restored", () => {
  const script = [
    `import { createTerminal } from ${JSON.stringify(new URL("../src/tui/terminal.mjs", import.meta.url).href)};`,
    "const stdin = { isTTY: true, setRawMode() {}, resume() {} };",
    "const stdout = { isTTY: true, columns: 80, rows: 24, write: (text) => process.stderr.write('OUT:' + JSON.stringify(text) + '\\n') };",
    "const terminal = createTerminal({ stdin, stdout, env: {} });",
    "terminal.installCleanup();",
    "terminal.enter({ altScreen: true });",
    "setTimeout(() => { throw new Error('kaboom'); }, 5);",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /kaboom/, "Node's default handling still prints the error");
  assert.ok(result.stderr.includes(JSON.stringify(SEQ.altScreenOff).slice(1, -1)), "the terminal was restored");
});

test("SIGINT restores, sets exit code 130, and notifies", () => {
  const s = fakeStreams();
  const proc = new EventEmitter();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  let interrupted = 0;
  const uninstall = terminal.installCleanup({ proc, onInterrupt: () => { interrupted += 1; } });
  terminal.enter();
  proc.emit("SIGINT");
  assert.equal(proc.exitCode, 130);
  assert.equal(interrupted, 1);
  assert.equal(terminal.entered, false);
  uninstall();
});

test("Ctrl+C arriving as a key in raw mode ends the session and restores the terminal", async () => {
  const s = fakeStreams();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  const input = createInput({ stdin: s.stdin });
  terminal.enter();
  const done = new Promise((resolve) => input.onKey((event) => event.name === "ctrl-c" && resolve("interrupted")));
  s.stdin.write("\x03");
  assert.equal(await done, "interrupted");
  terminal.restore();
  assert.equal(terminal.entered, false);
  assert.ok(s.text().includes("\x1b[?25h"));
  input.close();
});

test("a thrown error inside a try/finally session still restores", () => {
  const s = fakeStreams();
  const terminal = createTerminal({ stdin: s.stdin, stdout: s.stdout, env: {} });
  assert.throws(() => {
    terminal.enter({ altScreen: true });
    try { throw new Error("render failed"); } finally { terminal.restore(); }
  }, /render failed/);
  assert.equal(terminal.entered, false);
  assert.deepEqual(s.stdin.rawCalls, [true, false]);
});
