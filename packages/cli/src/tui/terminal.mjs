// Terminal lifecycle: raw mode, cursor, alternate screen, resize, and guaranteed restoration.
// Fully injectable (stdin, stdout, env, process) so tests never touch the real terminal and
// nothing is written unless the terminal is interactive and has been entered.

export const ESC = "\x1b";
export const SEQ = Object.freeze({
  showCursor: `${ESC}[?25h`,
  hideCursor: `${ESC}[?25l`,
  altScreenOn: `${ESC}[?1049h`,
  altScreenOff: `${ESC}[?1049l`,
  pasteOn: `${ESC}[?2004h`,
  pasteOff: `${ESC}[?2004l`,
  clear: `${ESC}[H${ESC}[2J`,
});

/**
 * @param {{stdin: any, stdout: any, env?: Record<string,string|undefined>}} io
 * @returns {{
 *   isInteractive: boolean, columns: number, rows: number, entered: boolean,
 *   enter(options?: {altScreen?: boolean, hideCursor?: boolean, bracketedPaste?: boolean}): boolean,
 *   restore(): void,
 *   draw(frame: string): void,
 *   write(text: string): void,
 *   onResize(listener: (size: {columns: number, rows: number}) => void): () => void,
 *   installCleanup(options?: {proc?: any, onInterrupt?: () => void}): () => void,
 * }}
 */
export function createTerminal({ stdin, stdout, env = process.env } = {}) {
  let entered = false;
  const interactive = Boolean(stdin?.isTTY && stdout?.isTTY && env.TERM !== "dumb");
  const size = () => ({ columns: stdout?.columns > 0 ? stdout.columns : 80, rows: stdout?.rows > 0 ? stdout.rows : 24 });
  const write = (text) => stdout.write(text);

  const terminal = {
    get isInteractive() { return interactive; },
    get entered() { return entered; },
    get columns() { return size().columns; },
    get rows() { return size().rows; },

    /** Enter raw mode (interactive terminals only). Returns whether anything was entered. */
    enter({ altScreen = false, hideCursor = true, bracketedPaste = false } = {}) {
      if (!interactive || entered) return false;
      entered = true;
      stdin.setRawMode?.(true);
      stdin.resume?.();
      write(`${altScreen ? SEQ.altScreenOn : ""}${hideCursor ? SEQ.hideCursor : ""}${bracketedPaste ? SEQ.pasteOn : ""}`);
      return true;
    },

    /** Undo everything `enter` did. Idempotent; emits nothing unless currently entered. */
    restore() {
      if (!entered) return;
      entered = false;
      try { stdin.setRawMode?.(false); } catch { /* stream already gone */ }
      try { write(`${SEQ.pasteOff}${SEQ.showCursor}${SEQ.altScreenOff}`); } catch { /* stream already gone */ }
    },

    /** Replace the screen with a whole frame (interactive only). */
    draw(frame) {
      if (interactive && entered) write(`${SEQ.clear}${frame}`);
    },

    write,

    /** Subscribe to terminal resizes. Returns an unsubscribe function. */
    onResize(listener) {
      const handler = () => listener(size());
      stdout.on?.("resize", handler);
      return () => stdout.removeListener?.("resize", handler);
    },

    /**
     * Restore the terminal on SIGINT, process exit, and uncaught exceptions. SIGINT sets exitCode 130
     * and calls `onInterrupt` (the listener suppresses Node's default termination). For uncaught
     * errors it uses `uncaughtExceptionMonitor`, which observes the error WITHOUT handling it: the
     * terminal is restored, then Node's default handling prints the error and exits with code 1 (the
     * documented generic error code; a handler that rethrows would exit 7). Returns an uninstall function.
     */
    installCleanup({ proc = process, onInterrupt } = {}) {
      const onSigint = () => {
        terminal.restore();
        proc.exitCode = 130;
        try { onInterrupt?.(); } catch { /* the terminal is already restored; never throw out of a signal handler */ }
      };
      const onExit = () => terminal.restore();
      const onError = () => { terminal.restore(); };
      proc.on("SIGINT", onSigint);
      proc.on("exit", onExit);
      proc.on("uncaughtExceptionMonitor", onError);
      function uninstall() {
        proc.removeListener("SIGINT", onSigint);
        proc.removeListener("exit", onExit);
        proc.removeListener("uncaughtExceptionMonitor", onError);
      }
      return uninstall;
    },
  };
  return terminal;
}
