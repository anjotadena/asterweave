// CLI dispatcher. Table-driven: commands register themselves in a `commands` Map via
// `registerCommand`, and `runCli` returns the process exit code (it never calls process.exit).

import { readFileSync } from "node:fs";
import { parseArgs } from "./args.mjs";
import { CliError, EXIT, UsageError } from "./exit-codes.mjs";
import { stringifyJson } from "./json.mjs";
import { redactText, sanitizeForTerminal } from "./redact.mjs";
import { registerAllCommands } from "./commands/index.mjs";
import { EXIT_CODES_TEXT } from "./commands/help.mjs";

/**
 * @typedef {object} CommandContext
 * @property {string} name            Registered command name that was invoked.
 * @property {string[]} positionals   Non-option arguments after the command name.
 * @property {Record<string,string|boolean>} options  Parsed `--key[=value]` options.
 * @property {string[]} rest          Arguments after a bare `--`.
 * @property {string[]} argv          Raw arguments after the command name.
 * @property {NodeJS.ReadableStream} stdin
 * @property {NodeJS.WritableStream} stdout
 * @property {NodeJS.WritableStream} stderr
 * @property {Record<string,string|undefined>} env
 * @property {string} cwd
 * @property {Function} spawn         child_process.spawn-compatible function (injectable).
 * @property {string} version
 */

/**
 * @typedef {object} CommandDefinition
 * @property {(ctx: CommandContext) => number | void | Promise<number | void>} handler  Returns an exit code (default 0).
 * @property {string} [summary]       One-line description shown by `help`.
 * @property {string[]} [boolean]     Option names that never take a value (see parseArgs).
 * @property {string[]} [options]     Every option name the command accepts (without `--`); an option outside
 *                                    this list (and the global `help`/`version`) is a usage error. When omitted
 *                                    the command does not validate option names.
 */

/** Registry of commands. Keys are command names. */
export const commands = new Map();

/**
 * Register (or replace) a command.
 * @param {string} name
 * @param {CommandDefinition['handler']} handler
 * @param {{summary?: string, boolean?: string[], options?: string[]}} [meta]
 */
export function registerCommand(name, handler, meta = {}) {
  commands.set(name, { handler, summary: meta.summary ?? "", boolean: meta.boolean ?? [], options: meta.options });
}

// The default registry carries every Phase A command (help, launch, doctor, repo, auth, config, trust).
// Tests that want an isolated registry pass their own Map via runCli's third argument.
registerAllCommands(commands);

/** Version from packages/cli/package.json. */
export function readVersion() {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Usage text listing the commands in `registry`.
 * @param {Map<string, CommandDefinition>} [registry]
 */
export function usageText(registry = commands) {
  const lines = ["Usage: asterweave <command> [options]", "", "Commands:"];
  const rows = [["help [command]", "Show this help"], ...[...registry.entries()].filter(([name]) => name !== "help").map(([name, def]) => [name, def.summary])];
  const width = Math.max(...rows.map(([name]) => name.length));
  for (const [name, summary] of rows) lines.push(`  ${name.padEnd(width)}  ${summary}`.trimEnd());
  lines.push("", "Options:", "  -h, --help     Show help", "  -v, --version  Print the version");
  if (registry.has("launch")) lines.push("", "Run `asterweave` with no command to start the interactive session.");
  return `${lines.join("\n")}\n`;
}

/** Full help: usage plus the stable exit-code table. */
export function helpText(registry = commands) {
  return `${usageText(registry)}\n${EXIT_CODES_TEXT}`;
}

function write(stream, text) {
  stream.write(text);
}

/**
 * Run the CLI.
 *
 * @param {string[]} argv  Arguments without the node binary and script path.
 * @param {{stdin?: any, stdout?: any, stderr?: any, env?: any, cwd?: string, spawn?: Function,
 *   exists?: Function, platform?: string, homedir?: Function, fs?: any, now?: Function, timeoutMs?: number, proc?: any, signal?: AbortSignal}} [io]
 *   The trailing fields are test seams forwarded to command handlers.
 * @param {{commands?: Map<string, CommandDefinition>}} [overrides]  Replace the registry (tests).
 * @returns {Promise<number>} Exit code.
 */
export async function runCli(argv = [], io = {}, { commands: registry = commands } = {}) {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const context = {
    stdin: io.stdin ?? process.stdin,
    stdout,
    stderr,
    env: io.env ?? process.env,
    cwd: io.cwd ?? process.cwd(),
    spawn: io.spawn,
    version: readVersion(),
    registry,
    usage: helpText(registry),
  };
  // Programmatic test seams (bin/asterweave.mjs never sets them); forwarded only when provided.
  for (const key of ["exists", "platform", "homedir", "fs", "now", "timeoutMs", "proc", "signal"]) if (io[key] !== undefined) context[key] = io[key];
  const [first, ...remaining] = argv;
  let asJson = false;
  let area = "CLI";
  try {
    if (first === "--version" || first === "-v") {
      write(stdout, `${context.version}\n`);
      return EXIT.OK;
    }
    // A bare `asterweave` runs the registered "launch" command; without one (isolated test
    // registries) it prints the usage text.
    const bare = first === undefined;
    if ((bare && !registry.has("launch")) || first === "--help" || first === "-h" || (first === "help" && !registry.has("help"))) {
      const target = first === "help" ? remaining.find((token) => !token.startsWith("-")) : undefined;
      if (target !== undefined) {
        const definition = registry.get(target);
        if (!definition) throw new UsageError(`Unknown command '${sanitizeForTerminal(target)}'.`, { remediation: "Run `asterweave help` for the command list." });
        write(stdout, definition.helpText ?? `asterweave ${target}${definition.summary ? ` - ${definition.summary}` : ""}\n`);
        return EXIT.OK;
      }
      write(stdout, helpText(registry));
      return EXIT.OK;
    }
    const name = bare ? "launch" : first;
    const definition = registry.get(name);
    if (!definition) {
      write(stderr, `Asterweave CLI error: unknown command '${sanitizeForTerminal(first)}'.\n\n${usageText(registry)}`);
      return EXIT.USAGE;
    }
    area = name;
    const parsed = parseArgs(remaining, { boolean: [...definition.boolean, "help", "version"] });
    asJson = parsed.options.json === true;
    if (parsed.options.help === true) {
      write(stdout, definition.helpText ?? `asterweave ${name}${definition.summary ? ` - ${definition.summary}` : ""}\n`);
      return EXIT.OK;
    }
    rejectUnknownOptions(name, definition, parsed.options);
    const result = await definition.handler({ ...context, name, argv: remaining, ...parsed });
    return Number.isInteger(result) ? result : EXIT.OK;
  } catch (error) {
    return reportError(error, { stdout, stderr, asJson, area });
  }
}

/** Global flags every command accepts (parseArgs maps -h/-v to these). */
const GLOBAL_OPTIONS = new Set(["help", "version"]);

/**
 * A command that declares its accepted `options` rejects anything else (exit 2) before any handler
 * code runs, so a typo such as `--jsno` can never silently turn into "no flag".
 */
function rejectUnknownOptions(name, definition, options) {
  if (!Array.isArray(definition.options)) return;
  const unknown = Object.keys(options).find((key) => !GLOBAL_OPTIONS.has(key) && !definition.options.includes(key));
  if (unknown === undefined) return;
  throw new UsageError(`Unknown option '--${sanitizeForTerminal(unknown)}' for 'asterweave ${name}'.`, {
    remediation: `Run \`asterweave help ${name}\` to see the accepted options.`,
  });
}

function reportError(error, { stdout, stderr, asJson, area }) {
  const known = error instanceof CliError;
  const message = redactText(known ? error.message : `Unexpected failure: ${error?.message ?? error}`).text;
  const exitCode = known ? error.exitCode : EXIT.ERROR;
  if (asJson) {
    const code = known ? error.code : "UNEXPECTED";
    write(stdout, `${stringifyJson({ ok: false, error: { code, message, remediation: known ? error.remediation ?? null : null } })}\n`);
  } else {
    // Messages can embed repository/config-controlled text (paths, branch names, git stderr): strip
    // terminal control sequences before anything reaches the user's terminal. JSON mode needs no
    // such step (stringifyJson escapes control characters).
    write(stderr, `Asterweave ${sanitizeForTerminal(area)} error: ${sanitizeForTerminal(message)}\n`);
    if (known && error.remediation) write(stderr, `${sanitizeForTerminal(redactText(error.remediation).text)}\n`);
  }
  return exitCode;
}
