// Key decoding on top of readline's emitKeypressEvents, with an injectable input stream.
// Normalised events: {name: 'up'|'down'|'left'|'right'|'enter'|'escape'|'ctrl-c'|'backspace'|'tab'|
// 'delete'|'char'|'eof', ch?: string}. Ctrl+C is always surfaced as an event (raw mode swallows
// the signal), and stream end/close become a single `eof`. Ctrl+D is also reported as `eof`.

import { emitKeypressEvents } from "node:readline";

const NAMED = { up: "up", down: "down", left: "left", right: "right", return: "enter", enter: "enter", escape: "escape", backspace: "backspace", tab: "tab", delete: "delete" };

/**
 * Convert a readline keypress into a normalised event, or null to ignore it.
 * @param {string|undefined} str
 * @param {{name?: string, ctrl?: boolean, meta?: boolean, sequence?: string}|undefined} key
 */
export function decodeKey(str, key = {}) {
  if ((key?.ctrl && key.name === "c") || str === "\x03") return { name: "ctrl-c" };
  if ((key?.ctrl && key.name === "d") || str === "\x04") return { name: "eof" };
  const named = NAMED[key?.name];
  if (named) return { name: named };
  const text = str ?? key?.sequence;
  if (typeof text === "string" && text.length > 0 && !key?.ctrl && !key?.meta && !/[\x00-\x1f\x7f]/.test(text)) return { name: "char", ch: text };
  return null;
}

/**
 * @param {{stdin: any, escapeCodeTimeout?: number}} options
 *   `escapeCodeTimeout` (ms) is how long readline waits to tell a lone Esc from an escape sequence.
 * @returns {{onKey(listener: (event: {name: string, ch?: string}) => void): () => void, close(): void}}
 */
export function createInput({ stdin, escapeCodeTimeout = 50 } = {}) {
  const listeners = new Set();
  let closed = false;
  const emit = (event) => { for (const listener of [...listeners]) listener(event); };
  const onKeypress = (str, key) => { const event = decodeKey(str, key); if (event) emit(event); };
  const onEnd = () => { if (!closed) { closed = true; emit({ name: "eof" }); } };

  emitKeypressEvents(stdin, { escapeCodeTimeout });
  stdin.on("keypress", onKeypress);
  stdin.on("end", onEnd);
  stdin.on("close", onEnd);

  return {
    onKey(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Detach from the stream (does not close it). */
    close() {
      closed = true;
      listeners.clear();
      stdin.removeListener("keypress", onKeypress);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
    },
  };
}
