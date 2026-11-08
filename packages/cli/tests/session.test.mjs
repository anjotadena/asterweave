import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { decodeKey } from "../src/tui/input.mjs";
import { createStyle, stripAnsi } from "../src/tui/render.mjs";
import { NOT_AVAILABLE, SIGN_IN_NOTE, buildBannerLines, renderComposer, renderSessionScreen, renderSignInScreen, wrapPlain } from "../src/tui/screens.mjs";
import { createSession, withTerminal } from "../src/tui/session.mjs";
import { SEQ, createTerminal } from "../src/tui/terminal.mjs";
import { TOKEN_SHAPED, FAKE_GH_TOKEN } from "./auth-helpers.mjs";
import { fakeTerminal, waitFor } from "./repo-fixture.mjs";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";
const plain = createStyle({ env: {}, isTTY: false });

/** A live session on fake TTY streams (plain style so frames are easy to read). */
function harness({ repo = "acme/widgets", columns = 100, rows = 30, banner = ["✓ Runner: Local"] } = {}) {
  const term = fakeTerminal({ columns, rows });
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  let session;
  const running = withTerminal({ terminal, stdin: term.stdin, proc, onInterrupt: () => session?.interrupt() }, ({ input }) => {
    session = createSession({ terminal, input, style: plain, version: "1.2.3", repo, branch: "main", banner });
    return session.run();
  });
  const frames = () => term.text().split(SEQ.clear).length - 1;
  const last = () => stripAnsi(term.text().split(SEQ.clear).at(-1));
  const settled = { done: false };
  running.then(() => { settled.done = true; }, () => { settled.done = true; });
  /** Write keys and wait until the redraws they cause have happened. */
  const send = async (keys, redraws = [...keys].length) => {
    const before = frames();
    term.stdin.write(keys);
    await waitFor(() => frames() >= before + redraws, { label: `${redraws} redraw(s) after ${JSON.stringify(keys)}` });
  };
  const ready = waitFor(() => frames() > 0, { label: "first frame" });
  return { term, terminal, proc, running, session: () => session, frames, last, send, ready, settled };
}

function assertRestored(term) {
  assert.deepEqual(term.stdin.rawCalls, [true, false], "raw mode entered once and restored once");
  assert.ok(term.text().includes(SEQ.showCursor) && term.text().includes(SEQ.altScreenOff));
}

// --- layout ---------------------------------------------------------------------------------------------

test("the frame shows header, banner, welcome, hint strip, footer and a persistent composer", async () => {
  const h = harness();
  await h.ready;
  const lines = h.last().split("\n");
  assert.equal(lines[0], "Asterweave v1.2.3 | acme/widgets (main)   /help · Esc to close");
  assert.ok(lines.includes("✓ Runner: Local"));
  assert.ok(lines.includes("Welcome to widgets. How can I help today?"));
  assert.ok(lines.includes("/commands show commands   /context usage   @context add context (e.g. @repo)"));
  assert.ok(lines.includes("/ @ select  Enter confirm  Esc close"));
  assert.equal(lines.at(-1), "> ▏");
  assert.equal(lines.length, 30, "fills the terminal rows exactly");
  h.term.stdin.write("/exit\r");
  assert.equal(await h.running, 0);
  assertRestored(h.term);
});

test("typing, Left, Backspace and editing in the middle of the composer", async () => {
  const h = harness();
  await h.ready;
  await h.send("helo");
  assert.equal(h.last().split("\n").at(-1), "> helo▏");
  await h.send(LEFT, 1);
  assert.equal(h.last().split("\n").at(-1), "> hel▏o");
  await h.send("l");
  assert.equal(h.last().split("\n").at(-1), "> hell▏o");
  await h.send(BACKSPACE, 1);
  await h.send(BACKSPACE, 1);
  assert.equal(h.last().split("\n").at(-1), "> he▏o");
  h.term.stdin.write("\x03");
  assert.equal(await h.running, 130);
});

// --- slash completion -------------------------------------------------------------------------------------

test("typing / opens the command list; typing narrows it by prefix; Esc closes it", async () => {
  const h = harness();
  await h.ready;
  await h.send("/");
  let screen = h.last();
  for (const name of ["/help", "/commands", "/sessions", "/usage", "/settings", "/context", "/exit"]) assert.ok(screen.includes(name), name);
  assert.match(screen, /^> \/help/m, "first entry selected");
  await h.send("s");
  screen = h.last();
  assert.ok(screen.includes("/sessions") && screen.includes("/settings"));
  assert.equal(screen.includes("/usage"), false);
  assert.equal(screen.includes("/exit"), false);
  await h.send("e");
  screen = h.last();
  assert.ok(screen.includes("/sessions") && screen.includes("/settings"), "/se matches both");
  await h.send("s");
  assert.equal(h.last().includes("/settings"), false, "/ses leaves only /sessions");
  assert.match(h.last(), /^> \/sessions/m);
  await h.send("\x1b", 1);
  assert.equal(h.last().includes("Commands"), false, "overlay closed");
  assert.equal(h.last().split("\n").at(-1), "> /ses▏", "typed text is kept");
  h.term.stdin.write("\x03");
  await h.running;
});

test("Up/Down move the selection and wrap; Tab and Enter insert the selection without submitting", async () => {
  const h = harness();
  await h.ready;
  await h.send("/");
  await h.send(DOWN, 1);
  assert.match(h.last(), /^> \/commands/m);
  await h.send(UP, 1);
  await h.send(UP, 1);
  assert.match(h.last(), /^> \/exit/m, "wraps to the last entry");
  await h.send("\t", 1);
  assert.equal(h.last().split("\n").at(-1), "> /exit▏");
  assert.equal(h.last().includes("Commands"), false, "overlay closed after completion");
  assert.equal(h.settled.done, false, "completion alone does not run the command");
  h.term.stdin.write("\x03");
  assert.equal(await h.running, 130);
});

test("Enter completes a partial command, then runs it; /exit ends with 0", async () => {
  const h = harness();
  await h.ready;
  await h.send("/ex");
  await h.send("\r", 1);
  assert.equal(h.last().split("\n").at(-1), "> /exit▏");
  assert.equal(h.settled.done, false);
  h.term.stdin.write("\r");
  assert.equal(await h.running, 0);
  assertRestored(h.term);
});

test("/help and /commands print the command list into the transcript", async () => {
  const h = harness();
  await h.ready;
  for (const command of ["/help", "/commands"]) {
    await h.send(`${command}\r`, command.length + 1);
    const screen = h.last();
    assert.ok(screen.includes(`> ${command}`));
    assert.ok(screen.includes("Commands:") && screen.includes("/sessions") && screen.includes("/exit"));
  }
  h.term.stdin.write("\x04");
  assert.equal(await h.running, 0);
});

// --- @ context ---------------------------------------------------------------------------------------------

test("@ opens the context overlay with the connected repository and nothing else; Enter inserts the token", async () => {
  const h = harness();
  await h.ready;
  await h.send("see @");
  const screen = h.last();
  assert.match(screen, /^> @widgets {2}connected repository$/m);
  assert.equal(screen.split("\n").filter((line) => /^ {2}@|^> @/.test(line)).length, 1, "exactly one entry");
  await h.send("\r", 1);
  assert.equal(h.last().split("\n").at(-1), "> see @widgets ▏");
  assert.equal(h.last().includes("Context"), false);
  await h.send("@x");
  assert.equal(h.last().includes("Context"), false, "a non-matching prefix offers nothing");
  h.term.stdin.write("\x03");
  await h.running;
});

test("@ inside a word (an e-mail address) does not open the overlay", async () => {
  const h = harness();
  await h.ready;
  await h.send("a@");
  assert.equal(h.last().includes("Context"), false);
  h.term.stdin.write("\x03");
  await h.running;
});

// --- not available ------------------------------------------------------------------------------------------------

test("free text and stub commands print the not-available line; unknown slash commands are named", async () => {
  const h = harness();
  await h.ready;
  const tokenLike = FAKE_GH_TOKEN;
  for (const line of ["hello", "/sessions", "/settings", tokenLike]) {
    await h.send(`${line}\r`, [...line].length + 1);
    const screen = h.last();
    assert.ok(screen.slice(screen.lastIndexOf(`> ${line}`)).includes(NOT_AVAILABLE), line);
  }
  await h.send("/nope\r", 6);
  assert.ok(h.last().includes("Unknown command /nope. Type /help for the command list."));
  assert.equal(h.term.errText(), "", "nothing logged to stderr");
  assert.equal(h.session().transcript.filter((line) => line === NOT_AVAILABLE).length, 4);
  h.term.stdin.write("\x03");
  await h.running;
});

test("an empty line does nothing", async () => {
  const h = harness();
  await h.ready;
  await h.send("   \r");
  assert.deepEqual(h.session().transcript, []);
  h.term.stdin.write("\x03");
  await h.running;
});

// --- scrolling and resize -----------------------------------------------------------------------------------------

test("the transcript scrolls within the terminal rows and drops the oldest visible lines", async () => {
  const h = harness({ rows: 14 });
  await h.ready;
  for (let i = 0; i < 6; i += 1) await h.send(`msg${i}\r`, 5);
  const lines = h.last().split("\n");
  assert.equal(lines.length, 14);
  assert.ok(lines.some((line) => line.includes("> msg5")));
  assert.equal(lines.some((line) => line.includes("> msg0")), false, "oldest lines scrolled out");
  assert.equal(h.session().transcript.length, 12, "the full transcript is still in memory");
  assert.equal(lines.at(-1), "> ▏");
  h.term.stdin.write("\x03");
  await h.running;
});

test("resize re-renders at the new size", async () => {
  const h = harness();
  await h.ready;
  await h.send("some text");
  const before = h.frames();
  h.term.stdout.columns = 30;
  h.term.stdout.rows = 12;
  h.term.stdout.emit("resize");
  await waitFor(() => h.frames() > before);
  const lines = h.last().split("\n");
  assert.equal(lines.length, 12);
  for (const line of lines) assert.ok([...line].length <= 30, line);
  assert.ok(lines.at(-1).startsWith("> "));
  h.term.stdin.write("\x03");
  await h.running;
  assert.equal(h.term.stdout.listenerCount("resize"), 0, "resize listener removed");
});

// --- exits and restoration ---------------------------------------------------------------------------------------------

test("Ctrl+C -> 130, Ctrl+D -> 0, stream end -> 0, SIGINT -> 130 (each restores the terminal)", async () => {
  for (const [how, expected] of [["ctrl-c", 130], ["ctrl-d", 0], ["end", 0], ["sigint", 130]]) {
    const h = harness();
    await h.ready;
    if (how === "ctrl-c") h.term.stdin.write("\x03");
    else if (how === "ctrl-d") h.term.stdin.write("\x04");
    else if (how === "end") h.term.stdin.end();
    else h.proc.emit("SIGINT");
    assert.equal(await h.running, expected, how);
    assertRestored(h.term);
    assert.equal(h.proc.listenerCount("SIGINT") + h.proc.listenerCount("exit") + h.proc.listenerCount("uncaughtExceptionMonitor"), 0, `${how}: process listeners removed`);
  }
});

test("a thrown error inside the loop rejects and the terminal is still restored", async () => {
  const h = harness();
  await h.ready;
  const realDraw = h.terminal.draw;
  h.terminal.draw = () => { throw new Error("draw failed"); };
  const outcome = assert.rejects(h.running, /draw failed/);
  h.term.stdin.write("x");
  await outcome;
  assertRestored(h.term);
  h.terminal.draw = realDraw;
  assert.equal(h.term.stdin.listenerCount("keypress"), 0, "input detached");
});

test("Ctrl-D decodes to its own ctrl-d event (stream end alone is eof)", () => {
  assert.deepEqual(decodeKey("\x04", { ctrl: true, name: "d" }), { name: "ctrl-d" });
  assert.deepEqual(decodeKey("\x04", undefined), { name: "ctrl-d" });
});

// --- pure screens -------------------------------------------------------------------------------------------------

test("sign-in screen matches the reference: title, provider picker, browser note", () => {
  const screen = stripAnsi(renderSignInScreen({ version: "1.2.3", index: 1, width: 100, style: plain }));
  assert.ok(screen.includes("Sign in to continue."));
  assert.match(screen, /^\? Choose a provider:$/m);
  assert.match(screen, /^ {2}GitHub \(recommended\)$/m);
  assert.match(screen, /^> Browser sign-in$/m);
  assert.ok(screen.includes(SIGN_IN_NOTE));
  assert.ok(screen.includes("Esc cancel"));
  const narrow = stripAnsi(renderSignInScreen({ width: 60, style: plain }));
  for (const line of narrow.split("\n")) assert.ok([...line].length <= 60, line);
  assert.ok(narrow.includes("A browser will open to authorize Asterweave."), "the note wraps instead of truncating");
});

test("banner lines add the model and account-plane lines after the runner line", () => {
  const lines = buildBannerLines({ account: "octo-dev", repo: "acme/widgets", branch: "main", model: { ok: true, authMethod: "claude.ai" }, warnings: ["Model provider: x"], style: plain });
  assert.deepEqual(lines.slice(0, 5), [
    "✓ Signed in: GitHub (octo-dev)",
    "✓ Repo: acme/widgets (main)",
    "✓ Runner: Local",
    "✓ Model: Claude Code · claude.ai",
    "Asterweave account: unavailable (local session)",
  ]);
  assert.ok(lines.includes("! Model provider: x"));
  assert.ok(lines.includes("Claude Code · local"));
  const missing = buildBannerLines({ account: "a", model: { ok: false }, style: plain });
  assert.equal(missing.some((line) => line.includes("✓ Model")), false);
});

test("composer scrolls horizontally to keep the cursor visible; wrapPlain wraps at spaces", () => {
  const buffer = [...("x".repeat(50) + "END")];
  const line = renderComposer({ buffer, cursor: buffer.length, width: 20, style: plain });
  assert.ok([...line].length <= 20 && line.endsWith("END▏"));
  assert.deepEqual(wrapPlain("aaa bbb ccc", 7), ["aaa bbb", "ccc"]);
  assert.deepEqual(wrapPlain("abcdefghij", 4), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapPlain("  indented", 40), ["  indented"]);
});

test("session screen output has no token-shaped strings and tolerates tiny terminals", () => {
  const screen = renderSessionScreen({ version: "1", repo: "a/b", branch: "m", banner: ["x"], transcript: ["> hi", NOT_AVAILABLE], width: 10, rows: 3, style: plain });
  assert.doesNotMatch(screen, TOKEN_SHAPED);
  assert.ok(screen.split("\n").length >= 1);
});
