// Run ONE headless `claude` turn as a supervised child process and return a TurnResult.
//
// NO live model call is ever made by this repository's tests: they use tests/fixtures/fake-claude.mjs. The flags, the stream
// shapes and the failure wording are UNVERIFIED against a real claude (see argv.mjs, stream.mjs, classify.mjs).
//
// Guarantees:
//   - the prompt goes to the child's STDIN (never argv); the environment is the allow-list of env.mjs; shell:false;
//   - the promise settles exactly once and never waits on the child's cooperation: a deadline, an AbortSignal, the output
//     cap, a malformed-line flood or a missing `close` event all end in a kill of the whole process TREE
//     (taskkill /T /F on Windows, a process-group SIGKILL elsewhere) and a bounded wait;
//   - on POSIX the group is also reaped after a normal exit (a grandchild must not outlive the turn). On Windows a
//     grandchild that outlives a child that exited by itself cannot be found by taskkill any more: that is a documented limit;
//   - stderr is kept only as a bounded, redacted, sanitized tail; stdout is parsed by the tolerant stream parser.

import { spawn as nodeSpawn } from "node:child_process";
import { resolveBinary } from "../../proc.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { killProcessTree } from "../tools/mcp-client.mjs";
import { buildClaudeArgv, ClaudeArgError, isAbsolutePath, MIN_CLAUDE_VERSION, parseVersion, versionAtLeast } from "./argv.mjs";
import { classifyFailure, describeFailure, isRetryable } from "./classify.mjs";
import { buildClaudeEnv } from "./env.mjs";
import { createStreamParser } from "./stream.mjs";

export const RUN_LIMITS = Object.freeze({
  maxPromptBytes: 4 * 1024 * 1024, defaultMaxOutputBytes: 16 * 1024 * 1024, defaultDeadlineMs: 15 * 60_000, maxDeadlineMs: 24 * 60 * 60_000,
  stderrTailBytes: 8 * 1024, versionTimeoutMs: 10_000, killGraceMs: 3000, exitGraceMs: 1500, maxMalformedLines: 1000,
});

const sanitize = (value, max) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, max);
const nullUsage = () => ({ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null });

function turnResult(overrides = {}) {
  return { ok: false, providerSessionId: null, model: null, usage: nullUsage(), toolEvents: [], resultText: "", costUsd: null, error: null, exitCode: null, killed: false, malformedLines: 0, stderrTail: "", ...overrides };
}

function failure(failureClass, detail, overrides = {}) {
  const described = describeFailure(failureClass);
  return turnResult({ ...overrides, error: { class: failureClass, message: detail ? `${described.message}: ${sanitize(detail, 300)}` : described.message, remediation: described.remediation, retryable: isRetryable(failureClass) } });
}

/** Run `claude --version` (bounded, own deadline, tree kill). @returns {Promise<{output: string, error: object|null, code: number|null, timedOut: boolean}>} */
function probeVersion({ command, prefix, spawn, env, cwd, platform, signal, killTree }) {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let timedOut = false;
    let error = null;
    let child;
    const timers = [];
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ output, error, code, timedOut });
    };
    const terminate = () => {
      try { killTree(child); } catch { /* gone */ }
      timers.push(setTimeout(() => finish(null), 1000));
    };
    function onAbort() { error ??= Object.assign(new Error("aborted"), { code: "ABORTED" }); terminate(); }
    try {
      child = spawn(command, [...prefix, "--version"], { cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (spawnError) {
      error = spawnError;
      finish(null);
      return;
    }
    signal?.addEventListener?.("abort", onAbort, { once: true });
    timers.push(setTimeout(() => { timedOut = true; terminate(); }, RUN_LIMITS.versionTimeoutMs));
    child.stdout?.on("data", (chunk) => { if (output.length < 4096) output += Buffer.from(chunk).toString("utf8").slice(0, 4096 - output.length); });
    child.stdout?.on("error", () => {});
    child.stderr?.on("data", () => {});
    child.stderr?.on("error", () => {});
    child.on("error", (spawnError) => { error = spawnError; if (!child.pid) finish(null); });
    child.on("close", (code) => finish(code ?? null));
  });
}

/**
 * Resolve the claude binary (or take `claudePath`) and check its version (`claude --version`, skipped when `claudeVersion` is given).
 * Never throws. @returns {Promise<{ok: true, command: string, prefix: string[], version: number[]} | {ok: false, failure: {class: string, detail: string}}>}
 */
export async function checkClaude(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const hostEnv = opts.env ?? process.env;
  const killTree = opts.killTree ?? ((child) => killProcessTree(child, { platform, env: hostEnv }));
  const refuse = (failureClass, detail) => ({ ok: false, failure: { class: failureClass, detail } });
  let command = opts.claudePath;
  if (command === undefined) {
    const resolved = resolveBinary("claude", { env: hostEnv, platform, ...(opts.exists ? { exists: opts.exists } : {}) });
    if (!resolved.path) return refuse("not-installed", resolved.reason === "SHELL_SHIM_ONLY" ? "claude is only available as a shell shim (.cmd/.bat), which is never run through a shell" : "claude was not found on PATH");
    command = resolved.path;
  } else if (typeof command !== "string" || !isAbsolutePath(command, platform)) return refuse("invalid-request", "claudePath must be an absolute path");
  const prefix = opts.claudeArgs ?? [];
  let version = opts.claudeVersion === undefined ? null : parseVersion(opts.claudeVersion);
  if (opts.claudeVersion === undefined) {
    const cwd = opts.cwd ?? process.cwd();
    const probe = await probeVersion({ command, prefix, spawn, env: buildClaudeEnv(hostEnv, { platform }), cwd, platform, signal: opts.signal, killTree });
    if (opts.signal?.aborted) return refuse("killed", "");
    if (probe.error) return refuse(probe.error.code === "ENOENT" || probe.error.code === "EACCES" ? "not-installed" : "crashed", `claude --version could not run (${sanitize(probe.error.code ?? probe.error.message, 60)})`);
    if (probe.timedOut || probe.code !== 0) return refuse("crashed", probe.timedOut ? "claude --version did not finish" : `claude --version exited with ${probe.code}`);
    version = parseVersion(probe.output);
  }
  if (!versionAtLeast(version)) return refuse("version-unsupported", version ? `found ${version.join(".")}, need at least ${MIN_CLAUDE_VERSION}` : "the version could not be read");
  return { ok: true, command, prefix, version };
}

/**
 * @typedef {object} TurnOptions
 * @property {string} prompt  Delivered on stdin.
 * @property {string} cwd
 * @property {number} [deadlineMs]
 * @property {number} [maxOutputBytes]
 * @property {AbortSignal} [signal]
 * @property {string} [claudePath]  Absolute path of the executable (default: `claude` resolved on PATH).
 * @property {string[]} [claudeArgs]  Arguments placed BEFORE the generated ones (test seam: `[fakeClaudeScript]` with claudePath = node).
 * @property {string} [claudeVersion]  A version string already verified by the caller: skips the `--version` probe.
 * Other options: sessionId, resume, fork, model, effort, permissionMode, allowedTools, appendSystemPrompt, settingsPath,
 * mcpConfigPath, strictMcp (see argv.mjs); extraEnv (env.mjs); spawn, env, platform, now, exists, killTree, onEvent;
 * killGraceMs, exitGraceMs, streamLimits, maxMalformedLines (tuning/test seams).
 */

/** @param {TurnOptions} opts  @returns {Promise<object>} TurnResult */
export async function runClaudeTurn(opts = {}) {
  const platform = opts.platform ?? process.platform;
  const spawn = opts.spawn ?? nodeSpawn;
  const hostEnv = opts.env ?? process.env;
  const now = opts.now ?? Date.now;
  const killTree = opts.killTree ?? ((child) => killProcessTree(child, { platform, env: hostEnv }));
  const startedAt = now();

  if (typeof opts.prompt !== "string" || opts.prompt.length === 0 || Buffer.byteLength(opts.prompt) > RUN_LIMITS.maxPromptBytes) return failure("invalid-request", "the prompt must be a non-empty string of at most 4 MiB");
  if (typeof opts.cwd !== "string" || !isAbsolutePath(opts.cwd, platform)) return failure("invalid-request", "cwd must be an absolute path");
  const deadlineMs = opts.deadlineMs ?? RUN_LIMITS.defaultDeadlineMs;
  const maxOutputBytes = opts.maxOutputBytes ?? RUN_LIMITS.defaultMaxOutputBytes;
  if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > RUN_LIMITS.maxDeadlineMs) return failure("invalid-request", "deadlineMs must be an integer from 1 to 86400000");
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 1024) return failure("invalid-request", "maxOutputBytes must be an integer of at least 1024");
  if (opts.claudeArgs !== undefined && (!Array.isArray(opts.claudeArgs) || opts.claudeArgs.some((arg) => typeof arg !== "string"))) return failure("invalid-request", "claudeArgs must be a list of strings");

  let argv;
  let env;
  try {
    argv = buildClaudeArgv(opts, { platform });
    env = buildClaudeEnv(hostEnv, { extraEnv: opts.extraEnv ?? {}, platform });
  } catch (error) {
    if (error instanceof ClaudeArgError || error instanceof TypeError) return failure("invalid-request", error.message);
    throw error;
  }
  if (opts.signal?.aborted) return failure("killed", null, { killed: true });

  // --- binary and version ---------------------------------------------------------------------------------------
  const checked = await checkClaude({ ...opts, platform, spawn, env: hostEnv, killTree });
  if (!checked.ok) return failure(checked.failure.class, checked.failure.detail, checked.failure.class === "killed" ? { killed: true } : {});
  const { command, prefix, version } = checked;

  // --- the turn ---------------------------------------------------------------------------------------------------
  const killGraceMs = opts.killGraceMs ?? RUN_LIMITS.killGraceMs;
  const exitGraceMs = opts.exitGraceMs ?? RUN_LIMITS.exitGraceMs;
  const maxMalformed = opts.maxMalformedLines ?? RUN_LIMITS.maxMalformedLines;
  const parser = createStreamParser({ limits: opts.streamLimits, onEvent: opts.onEvent, now });

  const raw = await new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let timedOut = false;
    let aborted = false;
    let outputLimit = false;
    let protocolViolation = false;
    let spawnError = null;
    let exitCode = null;
    let signalName = null;
    let outputBytes = 0;
    let stderrTail = Buffer.alloc(0);
    let child;
    const timers = [];

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      opts.signal?.removeEventListener?.("abort", onAbort);
      if (!stopping && platform !== "win32" && child?.pid) { try { killTree(child); } catch { /* gone */ } } // reap a grandchild of a child that exited by itself
      for (const stream of [child?.stdout, child?.stderr, child?.stdin]) { try { stream?.destroy?.(); } catch { /* closed */ } }
      resolve({ timedOut, aborted, outputLimit, protocolViolation, spawnError, exitCode, signalName, stderrTail: stderrTail.toString("utf8") });
    };
    const terminate = () => {
      if (settled || stopping) return;
      stopping = true;
      try { killTree(child); } catch { /* gone */ }
      timers.push(setTimeout(finish, killGraceMs)); // never wait for a close that may not come
    };
    function onAbort() { aborted = true; terminate(); }

    try {
      child = spawn(command, [...prefix, ...argv], { cwd: opts.cwd, env, shell: false, windowsHide: true, detached: platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      spawnError = error;
      finish();
      return;
    }
    opts.signal?.addEventListener?.("abort", onAbort, { once: true });
    timers.push(setTimeout(() => { timedOut = true; terminate(); }, deadlineMs));

    child.stdout?.on("data", (chunk) => {
      if (settled || stopping) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { outputLimit = true; terminate(); return; }
      parser.push(chunk);
      if (parser.malformedLines > maxMalformed) { protocolViolation = true; terminate(); }
    });
    child.stderr?.on("data", (chunk) => {
      if (settled || stopping) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) { outputLimit = true; terminate(); return; }
      stderrTail = Buffer.concat([stderrTail, chunk]);
      if (stderrTail.length > RUN_LIMITS.stderrTailBytes) stderrTail = stderrTail.subarray(stderrTail.length - RUN_LIMITS.stderrTailBytes);
    });
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    child.stdin?.on?.("error", () => {}); // EPIPE: the child never read (or stopped reading) its input
    child.on("error", (error) => {
      spawnError ??= error;
      if (!child.pid) finish();
    });
    child.on("exit", (code, signal) => {
      exitCode = code ?? null;
      signalName = signal ?? null;
      if (!settled && !stopping) timers.push(setTimeout(finish, exitGraceMs)); // a lingering grandchild may hold the pipes open
    });
    child.on("close", (code, signal) => {
      exitCode ??= code ?? null;
      signalName ??= signal ?? null;
      finish();
    });

    try {
      child.stdin.end(Buffer.from(opts.prompt, "utf8"));
    } catch {
      /* the error handler above sees EPIPE; the deadline still bounds the turn */
    }
  });

  // --- result -----------------------------------------------------------------------------------------------------
  const parsed = parser.finish();
  const stderrTail = sanitize(raw.stderrTail, RUN_LIMITS.stderrTailBytes);
  const killed = raw.timedOut || raw.aborted || raw.outputLimit || raw.protocolViolation;
  const ok = !raw.spawnError && !killed && raw.exitCode === 0 && parsed.resultSeen && !parsed.resultIsError;
  const base = {
    claudeVersion: version.join("."), providerSessionId: parsed.providerSessionId, model: parsed.model, usage: parsed.usage, toolEvents: parsed.toolEvents,
    resultText: parsed.resultText, costUsd: parsed.costUsd, exitCode: raw.exitCode, killed, malformedLines: parsed.malformedLines, stderrTail,
    toolEventsDropped: parsed.toolEventsDropped, toolResults: parsed.toolResults, durationMs: Math.max(0, now() - startedAt),
  };
  if (ok) return turnResult({ ...base, ok: true });
  const classified = classifyFailure({
    exitCode: raw.exitCode, signal: raw.signalName, stderrTail, result: parsed.resultIsError ? { text: parsed.resultText, isError: true } : null,
    spawnError: raw.spawnError, timedOut: raw.timedOut, aborted: raw.aborted, outputLimit: raw.outputLimit, protocolViolation: raw.protocolViolation,
  });
  const described = describeFailure(classified.class);
  const detail = raw.exitCode === null ? "" : ` (exit ${raw.exitCode})`;
  return turnResult({ ...base, error: { class: classified.class, message: `${described.message}${detail}`, remediation: described.remediation, retryable: classified.retryable } });
}
