// Pure builder of the `claude` command line for ONE headless turn.
//
// Everything here is UNVERIFIED against a live `claude`: the flag names come from the spec, not from running the binary.
// Rules: the prompt is NEVER part of argv (it goes to stdin: no secrets or long text in a process listing); every value is
// validated; a value that starts with '-' is refused (it could be read as a flag); no shell is involved anywhere.

import path from "node:path";
import { EFFORTS, MODEL_ID_PATTERN } from "../routing.mjs";

/** Conservative guess, not a documented requirement: older versions may lack some flags used here. */
export const MIN_CLAUDE_VERSION = "2.1.0";
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PROVIDER_SESSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_():* ./-]{1,120}$/;
/** `bypassPermissions` (and anything unknown) is deliberately absent. */
export const PERMISSION_MODES = Object.freeze(["default", "acceptEdits", "plan"]);
export const MAX_ALLOWED_TOOLS = 50;
export const MAX_APPEND_PROMPT_CHARS = 4000;

export class ClaudeArgError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeArgError";
    this.code = "INVALID_ARGUMENT";
  }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function text(name, value, { max = 4096 } = {}) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new ClaudeArgError(`${name} must be a non-empty string of at most ${max} characters`);
  if (CONTROL.test(value)) throw new ClaudeArgError(`${name} contains a control character`);
  if (value.startsWith("-")) throw new ClaudeArgError(`${name} must not start with '-'`);
  return value;
}

/** Absolute for the platform; on Windows a drive or UNC path (a rooted `\x` without a drive depends on the current drive). */
export function isAbsolutePath(value, platform = process.platform) {
  return platform === "win32" ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(value) : path.posix.isAbsolute(value);
}

function absolutePath(name, value, platform) {
  text(name, value, { max: 1024 });
  if (!isAbsolutePath(value, platform)) throw new ClaudeArgError(`${name} must be an absolute path`);
  return value;
}

/**
 * @param {object} options  See runClaudeTurn; `prompt` is NOT used here.
 * @param {{platform?: string}} [context]
 * @returns {string[]}
 */
export function buildClaudeArgv(options = {}, { platform = process.platform } = {}) {
  const argv = ["-p", "--output-format", "stream-json", "--verbose"];
  const { sessionId, resume, fork = false, model, effort, permissionMode = "default", allowedTools, appendSystemPrompt, settingsPath, mcpConfigPath, strictMcp = false } = options;

  if (fork && !resume) throw new ClaudeArgError("fork needs a session to resume");
  if (sessionId !== undefined && sessionId !== null) {
    if (typeof sessionId !== "string" || !UUID_PATTERN.test(sessionId)) throw new ClaudeArgError("sessionId must be a UUID");
    if (resume && !fork) throw new ClaudeArgError("sessionId and resume cannot be combined unless the session is forked");
    argv.push("--session-id", sessionId);
  }
  if (resume !== undefined && resume !== null) {
    if (typeof resume !== "string" || !PROVIDER_SESSION_PATTERN.test(resume)) throw new ClaudeArgError("resume must be a provider session id (letters, digits, '_' and '-', 8 to 128 characters)");
    argv.push("--resume", resume);
    if (fork) argv.push("--fork-session");
  }
  if (model !== undefined && model !== null) {
    if (typeof model !== "string" || !MODEL_ID_PATTERN.test(model)) throw new ClaudeArgError("model is not a valid model id");
    argv.push("--model", model);
  }
  if (effort !== undefined && effort !== null) {
    if (!EFFORTS.includes(effort)) throw new ClaudeArgError(`effort must be one of ${EFFORTS.join(", ")}`);
    argv.push("--effort", effort);
  }
  if (!PERMISSION_MODES.includes(permissionMode)) throw new ClaudeArgError(`permissionMode must be one of ${PERMISSION_MODES.join(", ")}`);
  argv.push("--permission-mode", permissionMode);
  if (allowedTools !== undefined && allowedTools !== null) {
    if (!Array.isArray(allowedTools) || allowedTools.length > MAX_ALLOWED_TOOLS) throw new ClaudeArgError(`allowedTools must be a list of at most ${MAX_ALLOWED_TOOLS} tool names`);
    for (const tool of allowedTools) {
      if (typeof tool !== "string" || !TOOL_NAME_PATTERN.test(tool) || tool.startsWith("-") || tool !== tool.trim()) throw new ClaudeArgError("allowedTools holds an invalid tool name");
    }
    if (allowedTools.length > 0) argv.push("--allowedTools", allowedTools.join(","));
  }
  if (settingsPath !== undefined && settingsPath !== null) argv.push("--settings", absolutePath("settingsPath", settingsPath, platform));
  if (mcpConfigPath !== undefined && mcpConfigPath !== null) {
    argv.push("--mcp-config", absolutePath("mcpConfigPath", mcpConfigPath, platform));
    if (strictMcp) argv.push("--strict-mcp-config");
  } else if (strictMcp) throw new ClaudeArgError("strictMcp needs mcpConfigPath");
  if (appendSystemPrompt !== undefined && appendSystemPrompt !== null) argv.push("--append-system-prompt", text("appendSystemPrompt", appendSystemPrompt, { max: MAX_APPEND_PROMPT_CHARS }));
  return argv;
}

/** Parse the first `x.y.z` of `claude --version` output; null when there is none. */
export function parseVersion(output) {
  const match = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(String(output ?? "").slice(0, 200));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** true when `version` (array from parseVersion) is at least `minimum` (a "x.y.z" string). */
export function versionAtLeast(version, minimum = MIN_CLAUDE_VERSION) {
  const wanted = parseVersion(minimum);
  if (!version || !wanted) return false;
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== wanted[index]) return version[index] > wanted[index];
  }
  return true;
}
