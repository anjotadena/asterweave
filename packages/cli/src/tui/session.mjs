// The working session: composer, slash/@ completion overlays and an in-memory transcript.
// Phase A has no agent loop: nothing the user types is sent anywhere, no process is spawned, and
// nothing is persisted. Typed text lives only in this module's memory and on the screen.

import { createInput } from "./input.mjs";
import { NOT_AVAILABLE, SLASH_COMMANDS, renderSessionScreen } from "./screens.mjs";

const TRANSCRIPT_LIMIT = 500;
const STUBS = new Set(["/sessions", "/usage", "/settings", "/context"]);

/**
 * Enter the terminal for the duration of `fn` and ALWAYS restore it: normal return, Ctrl+C, SIGINT,
 * closed input, thrown error. `fn` receives `{input, signal}`; `signal` aborts when SIGINT arrives
 * (the process-level handler restores the terminal first, then calls `onInterrupt` and aborts it),
 * which is what lets a picker resolve `{interrupted: true}` instead of waiting for a key that will
 * never be acted on. This is the ONE terminal lifecycle shared by the session, every picker
 * (sign-in, repository, branch, auth login) and the trust confirmation.
 *
 * @param {{terminal: any, stdin: any, proc?: any, onInterrupt?: () => void, enter?: object}} io
 *   `enter` overrides the options passed to `terminal.enter` (default: alternate screen).
 * @param {(tools: {input: ReturnType<typeof createInput>, signal: AbortSignal}) => Promise<T>} fn
 * @template T
 */
export async function withTerminal({ terminal, stdin, proc = process, onInterrupt, enter = { altScreen: true } }, fn) {
  const input = createInput({ stdin });
  const controller = new AbortController();
  const uninstall = terminal.installCleanup({
    proc,
    onInterrupt: () => {
      controller.abort();
      onInterrupt?.();
    },
  });
  try {
    terminal.enter(enter);
    return await fn({ input, signal: controller.signal });
  } finally {
    input.close();
    uninstall();
    terminal.restore();
    stdin.pause?.();
  }
}

/**
 * One-of-N picker on the entered terminal. `render(index, {columns, rows})` returns the frame.
 * Resolves `{index}`, `{done: true, cancelled: true}` (Esc) or `{done: true, interrupted: true}`
 * (Ctrl+C, closed input, or `signal` aborting because of SIGINT). Once settled, no later key can
 * confirm anything. A render error restores nothing itself but rejects, so the surrounding
 * `withTerminal` restores the terminal and the error surfaces as a normal failure (never an
 * uncaught exception).
 */
export function pickOne({ terminal, input, count, render, selected = 0, signal }) {
  return new Promise((resolve, reject) => {
    let index = Math.min(Math.max(selected, 0), count - 1);
    let settled = false;
    let offKey = () => {};
    let offResize = () => {};
    const onAbort = () => finish({ done: true, interrupted: true });
    const finish = (value, error) => {
      if (settled) return;
      settled = true;
      offKey();
      offResize();
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve(value);
    };
    const draw = () => {
      if (settled) return;
      try {
        terminal.draw(render(index, { columns: terminal.columns, rows: terminal.rows }));
      } catch (error) {
        finish(null, error);
      }
    };
    if (signal?.aborted) return finish({ done: true, interrupted: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    offKey = input.onKey((event) => {
      if (settled) return undefined;
      if (event.name === "up") index = (index - 1 + count) % count;
      else if (event.name === "down") index = (index + 1) % count;
      else if (event.name === "enter") return finish({ index });
      else if (event.name === "escape") return finish({ done: true, cancelled: true });
      else if (event.name === "ctrl-c" || event.name === "eof") return finish({ done: true, interrupted: true });
      else return undefined;
      draw();
      return undefined;
    });
    offResize = terminal.onResize(draw);
    draw();
  });
}

/**
 * Single-key yes/no question on the entered terminal. Resolves `{yes: true}` only for `y`/`Y`;
 * Enter, Esc, `n` and everything else is No (default No). Ctrl+C, closed input and SIGINT resolve
 * `{interrupted: true}`. Other keys are ignored.
 */
export function askYesNo({ input, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    let offKey = () => {};
    const finish = (value) => {
      if (settled) return;
      settled = true;
      offKey();
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ interrupted: true });
    if (signal?.aborted) return finish({ interrupted: true });
    signal?.addEventListener("abort", onAbort, { once: true });
    offKey = input.onKey((event) => {
      if (event.name === "ctrl-c" || event.name === "eof") return finish({ interrupted: true });
      if (event.name === "enter" || event.name === "escape") return finish({ yes: false });
      if (event.name === "char") {
        if (event.ch === "y" || event.ch === "Y") return finish({ yes: true });
        if (event.ch === "n" || event.ch === "N") return finish({ yes: false });
      }
      return undefined;
    });
  });
}

const commandLines = () => [
  "Commands:",
  ...SLASH_COMMANDS.map(({ name, hint }) => `  ${name.padEnd(10)} ${hint}`),
  "Type @ to add context (e.g. @repo).",
];

/**
 * @param {{
 *   terminal: any, input: ReturnType<typeof createInput>, style?: object, version?: string,
 *   repo?: string, branch?: string, banner?: string[],
 * }} options
 *   `repo` is `owner/name`; the `@` overlay offers `@name` and nothing else.
 * @returns {{run(): Promise<number>, interrupt(): void, transcript: string[]}}
 *   `run` resolves 0 for /exit, Ctrl-D or a closed input, 130 for Ctrl+C; it rejects if rendering
 *   or key handling throws (the caller's `finally` restores the terminal).
 */
export function createSession({ terminal, input, style, version, repo, branch, banner = [] }) {
  const repoName = repo ? repo.split("/").pop() : "";
  const contextItems = repoName ? [{ name: `@${repoName}`, hint: "connected repository" }] : [];
  const transcript = [];
  let buffer = [];
  let cursor = 0;
  let overlay = null; // {kind: 'slash'|'at', items: [{name, hint}], index, start}
  let stop = () => {};

  const push = (...lines) => {
    transcript.push(...lines);
    if (transcript.length > TRANSCRIPT_LIMIT) transcript.splice(0, transcript.length - TRANSCRIPT_LIMIT);
  };

  const refreshOverlay = () => {
    const before = buffer.slice(0, cursor).join("");
    let next = null;
    if (/^\/\S*$/.test(buffer.join(""))) {
      const prefix = buffer.join("").toLowerCase();
      next = { kind: "slash", start: 0, items: SLASH_COMMANDS.filter(({ name }) => name.startsWith(prefix)) };
    } else {
      const token = /(?:^|\s)(@\S*)$/.exec(before);
      if (token) {
        const prefix = token[1].toLowerCase();
        next = { kind: "at", start: cursor - token[1].length, items: contextItems.filter(({ name }) => name.toLowerCase().startsWith(prefix)) };
      }
    }
    overlay = next && next.items.length > 0 ? { ...next, index: 0 } : null;
  };

  const insert = (text) => {
    const chars = [...text];
    buffer.splice(cursor, 0, ...chars);
    cursor += chars.length;
    refreshOverlay();
  };

  const complete = () => {
    const item = overlay.items[overlay.index];
    const replacement = [...(overlay.kind === "at" ? `${item.name} ` : item.name)];
    buffer.splice(overlay.start, cursor - overlay.start, ...replacement);
    cursor = overlay.start + replacement.length;
    overlay = null;
  };

  /** Run the composer line. Returns an exit code when the session should end. */
  const submit = () => {
    const line = buffer.join("").trim();
    buffer = [];
    cursor = 0;
    overlay = null;
    if (!line) return undefined;
    push(`> ${line}`);
    if (!line.startsWith("/")) {
      push(NOT_AVAILABLE);
      return undefined;
    }
    const word = line.split(/\s+/)[0].toLowerCase();
    if (word === "/exit") return 0;
    if (word === "/help" || word === "/commands") push(...commandLines());
    else if (STUBS.has(word)) push(NOT_AVAILABLE);
    else push(`Unknown command ${word}. Type /help for the command list.`);
    return undefined;
  };

  /** Handle one key. Returns an exit code when the session should end, else undefined. */
  const handleKey = (event) => {
    switch (event.name) {
      case "ctrl-c": return 130;
      case "eof": return 0;
      case "escape": overlay = null; return undefined;
      case "up":
      case "down":
        if (overlay) overlay.index = (overlay.index + (event.name === "up" ? -1 : 1) + overlay.items.length) % overlay.items.length;
        return undefined;
      case "tab":
        if (overlay) complete();
        return undefined;
      case "enter":
        if (overlay && !(overlay.kind === "slash" && buffer.join("").toLowerCase() === overlay.items[overlay.index].name)) {
          complete();
          return undefined;
        }
        return submit();
      case "left": cursor = Math.max(0, cursor - 1); refreshOverlay(); return undefined;
      case "right": cursor = Math.min(buffer.length, cursor + 1); refreshOverlay(); return undefined;
      case "backspace":
        if (cursor > 0) { buffer.splice(cursor - 1, 1); cursor -= 1; }
        refreshOverlay();
        return undefined;
      case "delete":
        buffer.splice(cursor, 1);
        refreshOverlay();
        return undefined;
      case "char": insert(event.ch); return undefined;
      default: return undefined;
    }
  };

  const draw = () => {
    terminal.draw(renderSessionScreen({
      version, repo, branch, banner,
      welcome: repoName ? `Welcome to ${repoName}. How can I help today?` : "Welcome. How can I help today?",
      transcript,
      overlay: overlay && {
        title: overlay.kind === "slash" ? "Commands" : "Context",
        items: overlay.items.map(({ name, hint }) => ({ label: name, hint })),
        index: overlay.index,
      },
      buffer, cursor, width: terminal.columns, rows: terminal.rows, style,
    }));
  };

  return {
    transcript,
    interrupt: () => stop(130),
    run() {
      return new Promise((resolve, reject) => {
        let settled = false;
        let offKey = () => {};
        let offResize = () => {};
        const settle = (code, error) => {
          if (settled) return;
          settled = true;
          offKey();
          offResize();
          if (error) reject(error);
          else resolve(code);
        };
        stop = (code) => settle(code);
        const guarded = (fn) => (...args) => {
          try {
            fn(...args);
          } catch (error) {
            settle(undefined, error);
          }
        };
        offKey = input.onKey(guarded((event) => {
          const code = handleKey(event);
          if (code !== undefined) settle(code);
          else draw();
        }));
        offResize = terminal.onResize(guarded(draw));
        guarded(draw)();
      });
    },
  };
}
