// The one shared argument parser. Supports `--key value`, `--key=value`, `--flag`, `--`
// (end of options), positionals, and the short flags `-h` and `-v` only.

import { UsageError } from "./exit-codes.mjs";

const SHORT_FLAGS = { h: "help", v: "version" };

/**
 * Parse argv (already stripped of the node binary and script path).
 *
 * `boolean` lists option names that never take a value, so `--json status` keeps `status` as a
 * positional. Any other `--key` without `=` consumes the next token unless that token starts
 * with `--` (or there is none), in which case it becomes `true`. A repeated option keeps the
 * last value. `--no-<name>` for a declared boolean sets `<name>` to false.
 *
 * @param {string[]} argv
 * @param {{boolean?: string[]}} [spec]
 * @returns {{positionals: string[], options: Record<string, string|boolean>, rest: string[]}}
 *   `rest` holds everything after a bare `--`.
 */
export function parseArgs(argv, { boolean = [] } = {}) {
  const booleans = new Set(boolean);
  const positionals = [];
  const options = Object.create(null);
  let rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--") {
      rest = argv.slice(index + 1).map(String);
      break;
    }
    if (token.startsWith("--") && token.length > 2) {
      const body = token.slice(2);
      const equals = body.indexOf("=");
      if (equals === 0) throw new UsageError(`Malformed option '${token}'.`);
      if (equals > 0) {
        const key = body.slice(0, equals);
        options[key] = booleans.has(key) ? parseBooleanValue(key, body.slice(equals + 1)) : body.slice(equals + 1);
        continue;
      }
      if (body.startsWith("no-") && booleans.has(body.slice(3))) {
        options[body.slice(3)] = false;
        continue;
      }
      if (booleans.has(body)) {
        options[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || String(next).startsWith("--")) {
        options[body] = true;
      } else {
        options[body] = String(next);
        index += 1;
      }
      continue;
    }
    if (/^-[A-Za-z]$/.test(token)) {
      const long = SHORT_FLAGS[token[1]];
      if (!long) throw new UsageError(`Unknown option '${token}'. Only -h and -v are supported as short flags.`);
      options[long] = true;
      continue;
    }
    positionals.push(token);
  }
  return { positionals, options, rest };
}

function parseBooleanValue(key, value) {
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new UsageError(`Option --${key} expects true or false, got '${value}'.`);
}
