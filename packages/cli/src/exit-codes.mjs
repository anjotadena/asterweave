// Process exit codes and the shared typed error used by every CLI module.

/** Documented exit codes. Keep in sync with website/docs/cli/exit-codes.md. */
export const EXIT = Object.freeze({
  OK: 0,
  ERROR: 1, // runtime error, or any doctor FAIL
  USAGE: 2, // bad arguments, unknown command, or a TTY is required
  AUTH: 3, // authentication required or invalid
  TRUST: 4, // repository trust required
  CONFIG: 5, // configuration invalid
  INTERRUPTED: 130, // SIGINT / Ctrl+C / closed input stream
});

/**
 * Typed CLI error. `code` is a stable machine-readable identifier (for `--json` output),
 * `exitCode` is what `runCli` should return, `remediation` is a human next step (optional).
 */
export class CliError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, exitCode?: number, remediation?: string, cause?: unknown}} [options]
   */
  constructor(message, { code = "ERROR", exitCode = EXIT.ERROR, remediation = undefined, cause = undefined } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.code = code;
    this.exitCode = exitCode;
    this.remediation = remediation;
  }

  /** Shape used for `{ok:false,error:...}` JSON output. */
  toJSON() {
    return { code: this.code, message: this.message, remediation: this.remediation ?? null };
  }
}

/** Bad command-line usage (exit 2). */
export class UsageError extends CliError {
  constructor(message, options = {}) {
    super(message, { code: "USAGE", exitCode: EXIT.USAGE, ...options });
  }
}
