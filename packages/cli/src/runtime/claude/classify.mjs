// Pure failure classification of a finished (or refused) claude turn.
//
// The patterns are conservative wording heuristics over BOUNDED, sanitized stderr/result text; the real wording of claude's
// errors is UNVERIFIED. The classes line up with routing.mjs: `rate-limit`, `overloaded`, `timeout` and `5xx` are the
// transient classes `nextRoute` falls back on; `auth`, `invalid-request` never do; everything else is "unknown" to routing.
// (`policy` here is what routing calls non-transient `policy-denied`; routing only inspects the TRANSIENT list.)

import { redactText, sanitizeForTerminal } from "../../redact.mjs";

export const FAILURE_CLASSES = Object.freeze(["rate-limit", "overloaded", "5xx", "timeout", "auth", "offline", "not-installed", "version-unsupported", "invalid-request", "output-limit", "killed", "crashed", "policy", "unknown"]);
const RETRYABLE = new Set(["rate-limit", "overloaded", "5xx", "timeout", "offline"]);
const MAX_TEXT = 8 * 1024;

/** Whether a failure class is worth retrying (same or fallback model). */
export const isRetryable = (failureClass) => RETRYABLE.has(failureClass);

// Order matters: PERMANENT classes first (a retry or a fallback model re-runs the whole turn and its tools), then the transient ones.
// Bare status numbers ("500 tests") never count: a code must follow an API/HTTP/status marker.
const CODE = (codes) => new RegExp(`(?:api error|http|status(?: code)?|error code|\\bcode)\\s*[:=(]?\\s*(?:${codes})\\b`, "i");
const RULES = [
  ["policy", /blocked by (?:a |the )?(?:pre-?tool-?use )?hook|denied by (?:policy|a hook|the hook)|permission (?:was |has been )?denied|hook[^\n]{0,40}time[sd]? ?out/i],
  ["auth", new RegExp(`${CODE("401").source}|unauthori[sz]ed|invalid[ _-]?(?:x-)?api[ _-]?key|authentication[ _-]?(?:error|failed|required)|not logged in|please (?:run )?\\/?login|oauth token (?:has )?(?:expired|revoked)|credentials? (?:are |is )?(?:invalid|missing|expired)`, "i")],
  ["invalid-request", new RegExp(`${CODE("400|422").source}|invalid[ _-]request|invalid_request_error|unknown (?:option|argument|flag)|unrecognized (?:option|argument)|invalid (?:model|value)|prompt is too long|context[ _-]?(?:length|window)`, "i")],
  ["rate-limit", new RegExp(`${CODE("429").source}|rate[ _-]?limit|too many requests|usage limit reached|quota exceeded`, "i")],
  ["overloaded", new RegExp(`${CODE("529").source}|overloaded_error|api is overloaded|model is overloaded`, "i")],
  ["5xx", new RegExp(`${CODE("500|502|503|504").source}|internal server error|bad gateway|service unavailable|gateway time-?out`, "i")],
  ["timeout", /\bETIMEDOUT\b|(?:request|connection|api)[^.\n]{0,40}time[sd]? ?out/i],
  ["offline", /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ENETUNREACH|network is unreachable|getaddrinfo|fetch failed|socket hang up|unable to connect|connection (?:refused|reset|error)/i],
];

const MESSAGES = {
  "rate-limit": ["claude reported a rate limit", "Wait and retry, or fall back to another model."],
  overloaded: ["the model service is overloaded", "Retry later, or fall back to another model."],
  "5xx": ["the model service returned a server error", "Retry later, or fall back to another model."],
  timeout: ["the claude turn timed out", "Raise the deadline or retry; a fallback model may help."],
  auth: ["claude is not authenticated", "Log in with claude itself (claude auth login or /login inside claude); Asterweave does not hold provider credentials."],
  offline: ["claude could not reach the network", "Check the connection and proxy settings, then retry."],
  "not-installed": ["claude is not installed or not on PATH", "Install Claude Code and make sure `claude` is a native executable on PATH."],
  "version-unsupported": ["the installed claude is too old (or its version is unknown)", "Update Claude Code. The minimum version (2.1.0) is a conservative guess, not a documented requirement."],
  "invalid-request": ["claude rejected the request", "Check the model, effort and tool options; a fallback does not help."],
  "output-limit": ["claude produced more output than allowed and was stopped", "Raise the output limit or narrow the task."],
  killed: ["the claude turn was cancelled", "Run again when ready."],
  crashed: ["claude exited abnormally", "Run claude by hand in the same directory to see why."],
  policy: ["a policy or hook blocked the turn", "Review the policy; this needs a human decision."],
  unknown: ["the claude turn failed for an unrecognized reason", "Check stderr_tail; run claude by hand to reproduce."],
};

/** Stable message and remediation of a class (no child output in them). */
export function describeFailure(failureClass) {
  const [message, remediation] = MESSAGES[failureClass] ?? MESSAGES.unknown;
  return { message, remediation };
}

const bounded = (value) => redactText(sanitizeForTerminal(String(value ?? "").slice(-MAX_TEXT))).text;

/**
 * @param {{exitCode?: number|null, signal?: string|null, stderrTail?: string, result?: string|{text?: string, isError?: boolean}|null,
 *   spawnError?: {code?: string}|null, timedOut?: boolean, aborted?: boolean, outputLimit?: boolean, protocolViolation?: boolean}} input
 * @returns {{class: string, retryable: boolean}}
 */
export function classifyFailure({ exitCode = null, signal = null, stderrTail = "", result = null, spawnError = null, timedOut = false, aborted = false, outputLimit = false, protocolViolation = false } = {}) {
  const done = (failureClass) => ({ class: failureClass, retryable: RETRYABLE.has(failureClass) });
  if (spawnError) return done(spawnError.code === "ENOENT" || spawnError.code === "EACCES" || spawnError.code === "NOT_FOUND" || spawnError.code === "SHELL_SHIM_ONLY" ? "not-installed" : "crashed");
  if (aborted) return done("killed");
  if (timedOut) return done("timeout");
  if (outputLimit) return done("output-limit");
  if (protocolViolation) return done("crashed");
  const resultText = typeof result === "string" ? result : result?.text ?? "";
  const text = `${bounded(stderrTail)}\n${bounded(resultText)}`;
  for (const [failureClass, pattern] of RULES) if (pattern.test(text)) return done(failureClass);
  if (signal) return done("crashed");
  if (typeof exitCode === "number" && (exitCode < 0 || exitCode >= 126)) return done("crashed");
  return done("unknown");
}
