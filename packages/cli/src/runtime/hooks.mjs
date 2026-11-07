// User and repository hooks.
//
// Sources, in order: the user's `<userDir>/hooks.json` (`{ "v": 1, "hooks": [entry, ...] }`), then the
// `hooks` array of the repository's `.claude/asterweave.json` -- but only when the repository is TRUSTED
// (trust.mjs). Untrusted repository hooks are not loaded and are reported in `skipped`. The repository hooks are
// parsed from the very bytes the trust hash covers (no second read). Entries are deduplicated by id+event
// (the first one wins, so a repository can never override a user hook).
//
// Entry: { id, event, argv: [exe, ...args], kind: "validate" | "log", timeoutMs?: 1..30000 (default 10000),
//          onFailure?: "block" | "ignore" (default: block for validate, ignore for log) }
//
// Execution (runHooks): sequential in load order, one process per hook through proc.mjs `run`: no shell, an argv
// array, a minimal environment, the redacted payload `{v:1,event,runId,seq,...}` as JSON on stdin, output capped,
// a hard timeout. argv[0] must be a bare command name (resolved on PATH, never a shell shim) or an absolute path.
//
// Validate protocol:
//   exit 0                      pass. Optional stdout JSON object `{"decision":"deny"|"require-approval","reason":"..."}`
//                               tightens the decision ("allow" is ignored: a hook can never approve). Other stdout is logged only.
//   exit 2                      explicit veto: HOOK_BLOCKED (deny), whatever onFailure says.
//   any other exit, a signal, a timeout, a spawn error, malformed JSON verdict, or (repo hooks) a command the
//   guard refuses: a FAILURE; onFailure "block" => HOOK_FAILED (deny), "ignore" => no effect.
// `log` hooks observe only: their failures are recorded and never change the decision.
// A validate hook can only TIGHTEN the incoming decision (allow < require-approval < deny); it runs only for
// events where blocking is meaningful (BLOCKING_EVENTS) and is skipped once the decision is already blocking.

import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { resolveUserDir } from "../paths.mjs";
import { resolveBinary, run as runProcess } from "../proc.mjs";
import { isSecretKeyName, redactDeep, redactText } from "../redact.mjs";
import { parseJsonText, StoreError } from "../store.mjs";
import { safeTrustStatus } from "../trust.mjs";
import { evaluate, makeDecision, rank, shellQuote, stricter } from "./guard.mjs";

/** Hook event registry. `blocking: true` events accept `validate` hooks; the others are observe-only. */
export const HOOK_EVENTS = Object.freeze({
  "run.started": { blocking: false },
  "node.before-enter": { blocking: true },
  "tool.before": { blocking: true },
  "tool.after": { blocking: false },
  "node.completed": { blocking: false },
  "approval.requested": { blocking: false },
  "run.finished": { blocking: false },
});
export const BLOCKING_EVENTS = Object.freeze(Object.keys(HOOK_EVENTS).filter((name) => HOOK_EVENTS[name].blocking));

export const MAX_HOOK_TIMEOUT_MS = 30_000;
export const DEFAULT_HOOK_TIMEOUT_MS = 10_000;
const OUTPUT_CAP_BYTES = 64 * 1024;
const PAYLOAD_CAP_BYTES = 256 * 1024;
const RESULT_TEXT_CAP = 2048;

/** A hooks file or the repository's `hooks` key is invalid (exit 5). */
export class HooksError extends CliError {
  /** @param {string} message @param {{file?: string, issues?: string[], cause?: unknown}} [details] */
  constructor(message, { file, issues, cause } = {}) {
    super(message, { code: "HOOKS_INVALID", exitCode: EXIT.CONFIG, remediation: file ? `Fix ${file}.` : "Fix the hooks configuration.", cause });
    this.file = file;
    this.issues = issues ?? [];
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Validate hook entries. Pure; used by the loader and by config.mjs for `.claude/asterweave.json`.
 * @param {unknown} entries
 * @param {string} [where]
 * @returns {string[]} problems
 */
export function validateHookEntries(entries, where = "hooks") {
  if (!Array.isArray(entries)) return [`${where} must be an array`];
  const issues = [];
  entries.forEach((entry, index) => {
    const at = `${where}[${index}]`;
    if (!isObject(entry)) return void issues.push(`${at} must be an object`);
    for (const key of Object.keys(entry)) if (!["id", "event", "argv", "kind", "timeoutMs", "onFailure"].includes(key)) issues.push(`${at}.${key} is not a known property`);
    if (typeof entry.id !== "string" || !ID.test(entry.id)) issues.push(`${at}.id must match ${ID}`);
    if (typeof entry.event !== "string" || !Object.hasOwn(HOOK_EVENTS, entry.event)) issues.push(`${at}.event must be one of ${Object.keys(HOOK_EVENTS).join(", ")}`);
    if (entry.kind !== "validate" && entry.kind !== "log") issues.push(`${at}.kind must be 'validate' or 'log'`);
    else if (entry.kind === "validate" && Object.hasOwn(HOOK_EVENTS, entry.event) && !HOOK_EVENTS[entry.event].blocking) {
      issues.push(`${at}: 'validate' hooks are only allowed on ${BLOCKING_EVENTS.join(", ")}; '${entry.event}' is observe-only (use kind 'log')`);
    }
    if (!Array.isArray(entry.argv) || entry.argv.length === 0 || entry.argv.length > 64) issues.push(`${at}.argv must be an array of 1 to 64 strings`);
    else {
      entry.argv.forEach((part, partIndex) => {
        if (typeof part !== "string" || part.length > 4096 || part.includes("\0") || (partIndex === 0 && part.trim() === "")) issues.push(`${at}.argv[${partIndex}] must be a string without NUL (first one non-blank, at most 4096 characters)`);
      });
    }
    if (entry.timeoutMs !== undefined && (!Number.isInteger(entry.timeoutMs) || entry.timeoutMs < 1 || entry.timeoutMs > MAX_HOOK_TIMEOUT_MS)) issues.push(`${at}.timeoutMs must be an integer between 1 and ${MAX_HOOK_TIMEOUT_MS}`);
    if (entry.onFailure !== undefined && entry.onFailure !== "block" && entry.onFailure !== "ignore") issues.push(`${at}.onFailure must be 'block' or 'ignore'`);
  });
  const ids = new Set();
  entries.forEach((entry, index) => {
    if (!isObject(entry) || typeof entry.id !== "string") return;
    const key = `${entry.id}\0${entry.event}`;
    if (ids.has(key)) issues.push(`${where}[${index}]: duplicate id '${entry.id}' for event '${entry.event}'`);
    ids.add(key);
  });
  return issues;
}

function normalize(entry, source) {
  return {
    id: entry.id,
    event: entry.event,
    argv: [...entry.argv],
    kind: entry.kind,
    timeoutMs: entry.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    onFailure: entry.onFailure ?? (entry.kind === "validate" ? "block" : "ignore"),
    source,
  };
}

/** Absolute path of the user hooks file. */
export function userHooksFilePath(options = {}) {
  const platform = options.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), "hooks.json");
}

function readUserHooks(file, fs) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw new HooksError(`Cannot read ${file}: ${error?.message ?? error}`, { file, cause: error });
  }
  let data;
  try {
    data = parseJsonText(text, file, null);
  } catch (error) {
    if (error instanceof StoreError) throw new HooksError(`${file} is not valid JSON.`, { file, cause: error });
    throw error;
  }
  if (data === null) return [];
  const issues = [];
  if (!isObject(data)) issues.push("the file must contain a JSON object");
  else {
    for (const key of Object.keys(data)) if (key !== "v" && key !== "hooks") issues.push(`unknown property '${key}'`);
    if (data.v !== 1) issues.push("v must be 1");
    issues.push(...validateHookEntries(data.hooks));
  }
  if (issues.length > 0) throw new HooksError(`${file} is invalid: ${issues.slice(0, 5).join("; ")}.`, { file, issues });
  return data.hooks;
}

/**
 * Load the hooks that apply.
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, homedir?: () => string, fs?: typeof nodeFs,
 *   userFile?: string, repoPath?: string, trust?: object}} [options]  `trust` is forwarded to the trust lookup (trustFile, ...).
 * @returns {{hooks: Array<ReturnType<typeof normalize>>, skipped: Array<{source: string, reason: string, id?: string, event?: string, detail?: string}>}}
 * @throws {HooksError} a malformed hooks file, or a trusted repository whose `hooks` key is invalid (exit 5)
 */
export function loadHooks(options = {}) {
  const fs = options.fs ?? nodeFs;
  const env = options.env ?? process.env;
  const skipped = [];
  const loaded = [];
  const userFile = options.userFile ?? userHooksFilePath({ env, platform: options.platform, homedir: options.homedir });
  for (const entry of readUserHooks(userFile, fs)) loaded.push(normalize(entry, "user"));

  if (options.repoPath) {
    let status;
    try {
      status = safeTrustStatus(options.repoPath, { env, platform: options.platform, homedir: options.homedir, fs, ...options.trust });
    } catch (error) {
      if (!(error instanceof CliError)) throw error;
      skipped.push({ source: "repo", reason: "REPO_UNREADABLE", detail: error.message });
      status = null;
    }
    if (status !== null) {
      const adapterFile = path.join(status.realpath, ".claude", "asterweave.json");
      const bytes = status.adapter?.state === "present" ? status.adapter.bytes : null;
      if (!status.trusted) {
        let declared = null;
        try {
          const peek = bytes === null ? null : parseJsonText(bytes.toString("utf8"), adapterFile, null);
          if (Array.isArray(peek?.hooks)) declared = peek.hooks.length;
        } catch {
          declared = null;
        }
        if (declared !== null && declared > 0) skipped.push({ source: "repo", reason: "UNTRUSTED", detail: `${declared} repository hook(s) not loaded: ${status.reason}` });
      } else if (bytes !== null) {
        let data;
        try {
          data = parseJsonText(bytes.toString("utf8"), adapterFile, null);
        } catch (error) {
          if (error instanceof StoreError) throw new HooksError(`${adapterFile} is not valid JSON.`, { file: adapterFile, cause: error });
          throw error;
        }
        if (isObject(data) && data.hooks !== undefined) {
          const issues = validateHookEntries(data.hooks, "hooks");
          if (issues.length > 0) throw new HooksError(`${adapterFile} has invalid hooks: ${issues.slice(0, 5).join("; ")}.`, { file: adapterFile, issues });
          for (const entry of data.hooks) loaded.push(normalize(entry, "repo"));
        }
      }
    }
  }

  const hooks = [];
  const seen = new Set();
  for (const hook of loaded) {
    const key = `${hook.id}\0${hook.event}`;
    if (seen.has(key)) {
      skipped.push({ source: hook.source, reason: "DUPLICATE", id: hook.id, event: hook.event });
      continue;
    }
    seen.add(key);
    hooks.push(hook);
  }
  return { hooks, skipped };
}

// ---------------------------------------------------------------------------------------------
// Execution

function envLookup(env, key, platform) {
  if (platform !== "win32") return env[key] === undefined ? undefined : [key, env[key]];
  const actual = Object.keys(env).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return actual === undefined ? undefined : [actual, env[actual]];
}

/** The only environment a hook sees: enough to start a program, nothing that looks like a credential. */
export function minimalHookEnv(env = process.env, platform = process.platform, extra = {}) {
  const out = {};
  for (const key of ["PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "LANG", "LC_ALL"]) {
    const found = envLookup(env, key, platform);
    if (found && typeof found[1] === "string") out[found[0]] = found[1];
  }
  return { ...out, ...extra };
}

function scrubKeys(value) {
  if (Array.isArray(value)) return value.map(scrubKeys);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, isSecretKeyName(key) && typeof child !== "object" ? "[redacted]" : scrubKeys(child)]));
  return value;
}

/** The JSON a hook reads on stdin: `{v:1,event,runId,seq,...payload}` with secrets redacted and size bounded. */
export function hookPayload(event, payload = {}, { runId = null, seq = null } = {}) {
  const base = { v: 1, event, runId, seq };
  const body = redactDeep(scrubKeys({ ...payload, ...base })).value;
  let text = stringifyJson(body);
  if (Buffer.byteLength(text) > PAYLOAD_CAP_BYTES) text = stringifyJson({ ...base, truncated: true });
  return text;
}

const cap = (text) => {
  const redacted = redactText(String(text ?? "")).text;
  return redacted.length > RESULT_TEXT_CAP ? `${redacted.slice(0, RESULT_TEXT_CAP)}...` : redacted;
};

function resolveExecutable(argv0, { env, platform, resolve }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (p.isAbsolute(argv0)) return { exe: argv0 };
  if (/[\\/]/.test(argv0)) return { error: "ARGV0_RELATIVE", message: "argv[0] must be a bare command name or an absolute path" };
  const resolution = resolve(argv0, { env, platform });
  if (resolution.path) return { exe: resolution.path };
  return { error: resolution.reason ?? "NOT_FOUND", message: `${argv0}: ${resolution.reason === "SHELL_SHIM_ONLY" ? "only a shell shim was found" : "not found on PATH"}` };
}

function parseVerdict(stdout) {
  const text = stdout.trim();
  if (!text.startsWith("{")) return { verdict: null };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: "malformed JSON verdict" };
  }
  if (!isObject(value) || typeof value.decision !== "string") return { error: "verdict has no decision" };
  const name = value.decision.toLowerCase();
  if (name === "allow") return { verdict: { decision: "allow" } };
  if (name === "deny") return { verdict: { decision: "deny", reason: typeof value.reason === "string" ? value.reason : "" } };
  if (name === "require-approval" || name === "ask") return { verdict: { decision: "require-approval", reason: typeof value.reason === "string" ? value.reason : "" } };
  return { error: `unknown verdict '${name}'` };
}

/**
 * Run every hook registered for `event`.
 *
 * @param {string} event  A key of HOOK_EVENTS.
 * @param {object} payload  Event data (redacted before it reaches a hook).
 * @param {object} options
 * @param {Array} options.hooks  From loadHooks.
 * @param {object} [options.decision]  The decision so far (default allow). Validate hooks can only make it stricter.
 * @param {string|null} [options.runId] @param {number|null} [options.seq]
 * @param {string} [options.cwd]  Working directory of the hook processes.
 * @param {object} [options.env] @param {string} [options.platform]
 * @param {object} [options.guardCtx]  When given, REPOSITORY hooks' commands are first evaluated by the guard
 *   (hook side effects go through the same guards); a non-allow decision means the hook does not run (a failure).
 * @param {Function} [options.run]  proc.run seam. @param {Function} [options.resolve]  resolveBinary seam.
 * @param {number} [options.killGraceMs]
 * @returns {Promise<{results: Array<object>, decision: object}>}
 */
export async function runHooks(event, payload, options = {}) {
  const { hooks = [], runId = null, seq = null, cwd, env = process.env, platform = process.platform, guardCtx, killGraceMs, run = runProcess, resolve = resolveBinary } = options;
  let decision = options.decision ?? makeDecision("allow", "ALLOWED", "allow", { message: "no hook objected" });
  const results = [];
  if (!Object.hasOwn(HOOK_EVENTS, event)) throw new TypeError(`Unknown hook event '${event}'.`);
  const input = hookPayload(event, payload, { runId, seq });
  for (const hook of hooks.filter((entry) => entry.event === event)) {
    const record = { id: hook.id, event, source: hook.source, kind: hook.kind, status: "ok", code: null, signal: null, durationMs: 0, effect: "none", reason: null, stdout: "", stderr: "", truncated: false };
    results.push(record);
    const validating = hook.kind === "validate" && HOOK_EVENTS[event].blocking;
    if (validating && rank(decision) >= 2) {
      record.status = "skipped";
      record.reason = "the decision is already blocking";
      continue;
    }
    const fail = (status, reason) => {
      record.status = status;
      record.reason = reason;
      if (validating && hook.onFailure === "block") {
        record.effect = "blocked";
        decision = stricter(decision, makeDecision("deny", "HOOK_FAILED", `hook:${hook.id}`, { message: `hook '${hook.id}' failed (${reason}) and its failure policy is block`, hook: hook.id }));
      } else record.effect = "ignored";
    };
    if (hook.source === "repo" && guardCtx) {
      // The command line is built with POSIX quoting, so it is always classified as posix whatever the platform.
      const verdict = evaluate({ type: "tool", tool: { name: "shell", input: { command: hook.argv.map(shellQuote).join(" ") } } }, { ...guardCtx, dialect: "posix" });
      if (verdict.decision !== "allow") {
        fail("denied", `the guard refused the hook command (${verdict.reason})`);
        continue;
      }
    }
    const target = resolveExecutable(hook.argv[0], { env, platform, resolve });
    if (target.error) {
      fail("error", target.message);
      continue;
    }
    const started = Date.now();
    const result = await run(target.exe, hook.argv.slice(1), {
      cwd,
      env: minimalHookEnv(env, platform, { ASTERWEAVE_HOOK_EVENT: event, ASTERWEAVE_HOOK_ID: hook.id, ...(runId ? { ASTERWEAVE_RUN_ID: String(runId) } : {}) }),
      timeoutMs: hook.timeoutMs,
      input,
      maxOutputBytes: OUTPUT_CAP_BYTES,
      ...(killGraceMs === undefined ? {} : { killGraceMs }),
    });
    record.durationMs = Date.now() - started;
    record.code = result.code;
    record.signal = result.signal;
    record.stdout = cap(result.stdout);
    record.stderr = cap(result.stderr);
    record.truncated = result.truncated === true;
    if (result.timedOut || result.error?.code === "ETIMEDOUT") {
      fail("timeout", `timed out after ${hook.timeoutMs}ms`);
      continue;
    }
    if (result.error) {
      fail("error", result.error.message ?? String(result.error));
      continue;
    }
    if (result.signal) {
      fail("failed", `terminated by ${result.signal}`);
      continue;
    }
    if (validating && result.code === 2) {
      record.status = "blocked";
      record.reason = "the hook vetoed (exit 2)";
      record.effect = "blocked";
      decision = stricter(decision, makeDecision("deny", "HOOK_BLOCKED", `hook:${hook.id}`, { message: `hook '${hook.id}' blocked this: ${record.stderr.trim() || record.stdout.trim() || "exit 2"}`.slice(0, 500), hook: hook.id }));
      continue;
    }
    if (result.code !== 0) {
      fail("failed", `exit code ${result.code}`);
      continue;
    }
    if (validating) {
      const parsed = parseVerdict(result.stdout);
      if (parsed.error) {
        fail("failed", parsed.error);
        continue;
      }
      if (parsed.verdict && parsed.verdict.decision !== "allow") {
        record.status = "blocked";
        record.reason = parsed.verdict.reason || `the hook answered ${parsed.verdict.decision}`;
        record.effect = "blocked";
        decision = stricter(decision, makeDecision(parsed.verdict.decision, "HOOK_BLOCKED", `hook:${hook.id}`, { message: `hook '${hook.id}': ${cap(record.reason)}`, hook: hook.id }));
      }
    }
  }
  return { results, decision };
}
