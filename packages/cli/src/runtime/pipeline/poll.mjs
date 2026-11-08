// Pipeline poller. POLLING ONLY (no webhooks, no server), online only, and NO model call: this module (like everything in
// runtime/pipeline) never imports the Claude runner; a test enforces it.
//
//   backoffMs(attempt, opts)    pure: bounded exponential backoff with jitter (min 5 s, max 120 s)
//   nextDelay(input)            pure schedule: success => grows while nothing changes, failure => backoff, Retry-After / x-ratelimit-reset honoured
//   pollOnce(options)           ONE full read (pull request, then workflow runs + check runs of the PR head and, once merged, the merge commit),
//                               folded into the store as a "poll" event; a failure is recorded as a "poll.failed" event and returned, not thrown,
//                               except for authentication / not-found problems that polling can never fix
//   watchPipeline(options)      pollOnce in a loop until a terminal verdict, the wall-time cap, the attempt cap, an abort, or a rate limit that
//                               outlasts the wall-time cap
//
// Every poll reads the FULL state of GitHub (never "what changed since"), so the first poll after a gap (a restart, a laptop asleep) reconciles
// from scratch: `reconciled` is recorded on that event. Rate-limit exhaustion is not a failure: the state is `rate-limited` with `resumeAt`.
// Time, randomness, sleeping and the abort signal are injected.

import { CliError, EXIT } from "../../exit-codes.mjs";
import { ToolError } from "../tools/registry.mjs";
import { evaluate, isTerminalVerdict, normalizeCheck, normalizePull, normalizeRun, planPoll } from "./state.mjs";

export const MIN_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 120_000;
export const DEFAULT_INTERVAL_MS = 15_000;
export const DEFAULT_TIMEOUT_MS = 30 * 60_000;
export const MAX_TIMEOUT_MS = 24 * 3_600_000;
export const DEFAULT_MAX_ATTEMPTS = 1000;
/** A server-requested wait (Retry-After, x-ratelimit-reset) is honoured up to this long. */
export const MAX_SERVER_WAIT_MS = 3_600_000;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/** Bounded exponential backoff with jitter: always within [minMs, maxMs]. `attempt` 0 gives minMs. */
export function backoffMs(attempt, { minMs = MIN_DELAY_MS, maxMs = MAX_DELAY_MS, random = Math.random } = {}) {
  const ceiling = Math.min(maxMs, minMs * 2 ** Math.min(Math.max(0, attempt), 20));
  const jitter = 0.5 + 0.5 * clamp(random(), 0, 1);
  return clamp(Math.floor(ceiling * jitter), minMs, maxMs);
}

/**
 * The delay before the next poll.
 * @param {{outcome: 'ok'|'failed'|'rate-limited', unchanged?: number, failures?: number, intervalMs?: number, retryAfterMs?: number, resetAtMs?: number,
 *   nowMs: number, random?: () => number}} input
 * @returns {{delayMs: number, serverRequested: boolean}}
 */
export function nextDelay({ outcome, unchanged = 0, failures = 0, intervalMs = DEFAULT_INTERVAL_MS, retryAfterMs, resetAtMs, nowMs, random = Math.random }) {
  const minMs = clamp(intervalMs, MIN_DELAY_MS, MAX_DELAY_MS);
  const base = outcome === "ok" ? backoffMs(unchanged, { minMs, random }) : backoffMs(Math.max(0, failures - 1), { minMs: MIN_DELAY_MS, random });
  const requested = [retryAfterMs, resetAtMs === undefined || resetAtMs === null ? undefined : resetAtMs - nowMs].filter((value) => Number.isFinite(value) && value > 0);
  if (requested.length === 0) return { delayMs: base, serverRequested: false };
  const server = Math.min(MAX_SERVER_WAIT_MS, Math.max(...requested));
  return { delayMs: Math.max(base, server), serverRequested: true };
}

/** What a failed request means for the poller. */
export function classifyError(error, nowMs) {
  const code = typeof error?.code === "string" ? error.code : "ERROR";
  const status = Number.isSafeInteger(error?.status) ? error.status : null;
  const rateLimited = code === "GITHUB_RATE_LIMITED" || status === 429 || (status === 403 && Number.isFinite(error?.retryAfterMs));
  const retryAfterMs = Number.isFinite(error?.retryAfterMs) ? Math.max(0, error.retryAfterMs) : undefined;
  const resetAtMs = Number.isFinite(error?.rate?.resetAtMs) ? error.rate.resetAtMs : undefined;
  const fatal = code === "GITHUB_AUTH_MISSING" || status === 401 || (status === 403 && !rateLimited) || (status === 404 && code !== "TOOL_ABORTED");
  const aborted = code === "TOOL_ABORTED";
  let waitMs = retryAfterMs;
  if (rateLimited && waitMs === undefined && resetAtMs !== undefined) waitMs = Math.max(0, resetAtMs - nowMs);
  return { code, status, rateLimited, fatal, aborted, retryAfterMs, resetAtMs, waitMs, rate: error?.rate ?? null };
}

function fatalError(c) {
  if (c.code === "GITHUB_AUTH_MISSING" || c.status === 401) {
    return new CliError("GitHub rejected or lacks a credential.", { code: "PIPELINE_AUTH", exitCode: EXIT.AUTH, remediation: "Run: gh auth login --web -h github.com -s repo,read:org" });
  }
  if (c.status === 404) {
    return new CliError("The pull request was not found (or the credential cannot see the repository).", { code: "PIPELINE_PR_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Check the pull request number and --repo, and that the signed-in account can read the repository." });
  }
  return new CliError("GitHub refused the request (HTTP 403).", { code: "PIPELINE_FORBIDDEN", exitCode: EXIT.ERROR, remediation: "Check the token scopes (repo, read:org) and the repository access of the signed-in account." });
}

/** Re-throw a problem that polling can never fix (sign-in, missing pull request, forbidden) as its CliError; anything else is returned to the caller. */
export function rethrowFatal(error, nowMs) {
  if (error instanceof CliError) throw error;
  const c = classifyError(error, nowMs);
  if (c.aborted) throw new CliError("Interrupted.", { code: "INTERRUPTED", exitCode: EXIT.INTERRUPTED });
  if (c.fatal) throw fatalError(c);
}

/** Any GitHub failure as a CliError with fixed text (never the response body): fatal ones as above, the rest as PIPELINE_GITHUB_ERROR. */
export function asCliError(error, nowMs) {
  rethrowFatal(error, nowMs);
  const c = classifyError(error, nowMs);
  return new CliError(`GitHub could not be read (${c.code}).`, { code: "PIPELINE_GITHUB_ERROR", exitCode: EXIT.ERROR, remediation: c.rateLimited ? "The rate limit is exhausted; retry after it resets." : "Retry in a moment." });
}

async function gather({ client, owner, repo, pull, signal, host }) {
  const shas = [...new Set([pull.headSha, pull.merged ? pull.mergeCommitSha : null].filter((sha) => sha !== null))];
  const observations = [];
  let rate = null;
  let truncated = false;
  const listing = [];
  for (const sha of shas) {
    const before = truncated;
    truncated = false;
    const runs = await client.runs({ owner, repo, headSha: sha }, signal);
    for (const raw of runs.items) observations.push(normalizeRun(raw, host));
    rate = runs.rate ?? rate;
    truncated ||= runs.truncated;
    const checks = await client.checkRuns({ owner, repo, ref: sha }, signal);
    for (const raw of checks.items) observations.push(normalizeCheck(raw, host));
    rate = checks.rate ?? rate;
    truncated ||= checks.truncated;
    listing.push({ sha, complete: !truncated });
    truncated ||= before;
  }
  return { observations: observations.filter((obs) => obs !== null), rate, truncated, listing };
}

/**
 * One poll. Returns `{outcome: 'ok'|'failed'|'rate-limited'|'aborted', state, changed, ...}`.
 * @param {{session: object, client: object, repo: {owner: string, name: string}, prNumber: number, policy: object, nowMs: () => number,
 *   signal?: AbortSignal, reconciled?: boolean}} options
 */
export async function pollOnce({ session, client, repo, prNumber, policy, nowMs, signal, reconciled = false }) {
  const stamp = () => new Date(nowMs()).toISOString();
  try {
    const raw = await client.pull({ owner: repo.owner, repo: repo.name, number: prNumber }, signal);
    const pull = normalizePull(raw.body);
    if (pull === null || pull.number !== prNumber) throw new ToolError("GITHUB_BAD_RESPONSE", "GitHub returned an unusable pull request");
    const { observations, rate, truncated, listing } = await gather({ client, owner: repo.owner, repo: repo.name, pull, signal, host: session.state.host });
    const { event } = planPoll(session.state, { pull, observations, rate: rate ?? raw.rate, reconciled, listing }, { now: stamp(), policy });
    const changed = event.observations.length > 0 || session.state.pr.state !== (pull.merged ? "merged" : pull.state === "open" ? "open" : "closed-unmerged") || session.state.pr.headSha !== pull.headSha;
    const state = session.append(truncated ? { ...event, truncated: true } : event);
    return { outcome: "ok", state, changed, rate: state.poll.rateLimit };
  } catch (error) {
    const c = classifyError(error, nowMs());
    if (c.aborted || signal?.aborted) return { outcome: "aborted", state: session.state, changed: false };
    if (c.fatal) throw fatalError(c);
    const resumeAt = c.waitMs !== undefined ? new Date(nowMs() + c.waitMs).toISOString() : null;
    let state = session.state;
    try {
      state = session.append({ type: "poll.failed", code: c.code, rateLimited: c.rateLimited, resumeAt: c.rateLimited ? resumeAt : null, rate: c.rate ? { remaining: c.rate.remaining, limit: c.rate.limit, resetAt: c.rate.resetAtMs ? new Date(c.rate.resetAtMs).toISOString() : null, observedAt: stamp() } : undefined });
    } catch {
      // The failure could not be recorded (lost lock, disk): the watch carries on with what it knows rather than dying here.
    }
    return { outcome: c.rateLimited ? "rate-limited" : "failed", state, changed: false, code: c.code, waitMs: c.waitMs, resetAtMs: c.resetAtMs };
  }
}

/**
 * Poll until a terminal verdict, the wall-time cap, the attempt cap, an abort, or a rate limit that outlasts the cap.
 * @returns {Promise<{status: 'terminal'|'unavailable'|'timeout'|'attempts'|'aborted'|'rate-limited', verdict: object, state: object, attempts: number, resumeAt?: string}>}
 */
export async function watchPipeline({ session, client, repo, prNumber, policy, nowMs = Date.now, sleep, signal, random = Math.random, intervalMs = DEFAULT_INTERVAL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, maxAttempts = DEFAULT_MAX_ATTEMPTS, onPoll }) {
  if (typeof sleep !== "function") throw new TypeError("watchPipeline needs a sleep(ms, signal) function");
  const wallMs = clamp(timeoutMs, 1, MAX_TIMEOUT_MS);
  const started = nowMs();
  let attempts = 0;
  let unchanged = 0;
  let failures = 0;
  const verdictOf = () => evaluate(session.state, policy, nowMs());
  const done = (status, extra = {}) => ({ status, verdict: verdictOf(), state: session.state, attempts, ...extra });
  for (;;) {
    if (signal?.aborted) return done("aborted");
    attempts += 1;
    const result = await pollOnce({ session, client, repo, prNumber, policy, nowMs, signal, reconciled: attempts === 1 });
    if (result.outcome === "aborted") return done("aborted");
    unchanged = result.outcome === "ok" && !result.changed ? unchanged + 1 : 0;
    failures = result.outcome === "ok" ? 0 : failures + 1;
    const verdict = verdictOf();
    onPoll?.({ attempt: attempts, result, verdict });
    if (result.outcome === "ok" && isTerminalVerdict(verdict.verdict)) return done("terminal");
    // Everything else is satisfied but a required-check source could not be read: polling again cannot help.
    if (result.outcome === "ok" && verdict.unavailable !== null && verdict.blockers.length === 1) return done("unavailable");
    const remaining = wallMs - (nowMs() - started);
    if (remaining <= 0) return done("timeout");
    if (attempts >= maxAttempts) return done("attempts");
    const rate = result.rate ?? session.state.poll.rateLimit;
    const exhausted = result.outcome === "ok" && rate && rate.remaining === 0 && rate.resetAt ? Date.parse(rate.resetAt) : undefined;
    const { delayMs, serverRequested } = nextDelay({ outcome: result.outcome === "rate-limited" ? "rate-limited" : result.outcome, unchanged, failures, intervalMs, retryAfterMs: result.waitMs, resetAtMs: exhausted ?? result.resetAtMs, nowMs: nowMs(), random });
    if (serverRequested && delayMs > remaining) {
      const resumeAt = new Date(nowMs() + delayMs).toISOString();
      return done("rate-limited", { resumeAt });
    }
    await sleep(Math.min(delayMs, remaining), signal);
  }
}
