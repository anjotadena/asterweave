// Pipeline monitoring state: a PURE reducer (no I/O, no clock, no network). Two separate machines:
//
//   PR state        open | closed-unmerged | merged   (merged is sticky: a later "open" report never un-merges it)
//   check state     per REQUIRED key (a workflow file path or a check name; never a workflow name), for the stage "post-merge" (runs whose
//                   head_sha is the resulting target-branch commit) and, separately, "pre-merge" (runs on the PR head sha):
//                   waiting | running | passed | failed | cancelled | skipped | neutral | run-not-detected | missing-configuration
//
// Everything that comes from GitHub (names, paths, conclusions, urls) is attacker controlled: observations are rebuilt field by
// field (never spread), strings are sanitized, redacted and capped, and slot keys are prefixed so no key can be "__proto__".
//
// Observations are folded into SLOTS keyed by (target sha, workflow identity | check name). Rules:
//   - identical observation (runId, attempt, status, conclusion, updatedAt) => duplicate, counted, ignored
//   - older attempt / older updatedAt / a non-terminal report after a terminal one for the same attempt => out of order, counted, ignored
//   - a higher run_attempt (or a newer run of the same workflow) supersedes the slot; the old attempt is kept in a short history
//   - a slot is never deleted: a run that disappears from a later listing is not forgotten
//   - a sha that is neither the PR head nor the merge commit is foreign: counted, ignored
// Verdict: `closable` only when the PR is merged AND every required key (and every deployment key, when configured) has a PASSED
// (or policy-allowed skipped/neutral) latest attempt on the target commit. Absence is never success.

import { stringifyJson } from "../../json.mjs";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";

export const STATE_SCHEMA_VERSION = 1;
/** Workflow events that may be chosen as the post-merge trigger; the default is "push". */
export const TRIGGERS = Object.freeze(["push", "pull_request", "workflow_run", "merge_group"]);
export const DEFAULT_TRIGGER = "push";
export const DEFAULT_DETECTION_WINDOW_MS = 10 * 60_000;
const MAX_SLOTS = 500;
/** Slots per commit: the merge commit may use all 500, anything else (the PR head) at most half, so it can never starve the merge commit. */
const slotCap = (state, sha) => (state.target.sha !== null && sha === state.target.sha ? MAX_SLOTS : MAX_SLOTS / 2);
export const MAX_KEYS = 50;
const MAX_SEEN = 16;
const MAX_EVENT_BYTES = 800_000;
const MAX_LOST_KEYS = 100;
const MAX_SUPERSEDED = 5;
const SHA = /^[0-9a-f]{7,40}$/;
const WORST = ["failed", "cancelled", "running", "waiting", "skipped", "neutral", "passed"];

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Sanitized, redacted, capped text. Never throws. */
export function safeText(value, max = 200) {
  if (typeof value !== "string") return null;
  return redactText(sanitizeForTerminal(value)).text.slice(0, max);
}
const posInt = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);
const iso = (value) => {
  if (typeof value !== "string") return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
};
const sha = (value) => (typeof value === "string" && SHA.test(value.toLowerCase()) ? value.toLowerCase() : null);
// A link is kept only as an https URL on the configured GitHub host (when known); anything else is dropped.
const link = (value, host = null) => {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  if (host !== null) {
    try {
      if (new URL(value).host.toLowerCase() !== String(host).toLowerCase()) return null;
    } catch {
      return null;
    }
  }
  return safeText(value, 300);
};
const time = (value) => (value === null || value === undefined ? 0 : Date.parse(value) || 0);

// Normalizing observations ------------------------------------------------------------------------

/** One workflow run (GET actions/runs item) as a trusted-shape observation; null when it is unusable. */
export function normalizeRun(raw, host = null) {
  if (!isObject(raw)) return null;
  const id = posInt(raw.id);
  const headSha = sha(raw.head_sha);
  if (id === null || headSha === null) return null;
  return {
    source: "run",
    id,
    attempt: posInt(raw.run_attempt) ?? 1,
    name: safeText(raw.name, 200),
    path: safeText(raw.path, 300),
    workflowId: posInt(raw.workflow_id),
    appId: null,
    suiteId: posInt(raw.check_suite_id),
    status: safeText(raw.status, 40),
    conclusion: safeText(raw.conclusion, 40),
    event: safeText(raw.event, 40),
    headSha,
    headBranch: safeText(raw.head_branch, 120),
    htmlUrl: link(raw.html_url, host),
    createdAt: iso(raw.created_at),
    startedAt: iso(raw.run_started_at),
    updatedAt: iso(raw.updated_at),
  };
}

/** One check run (GET commits/{ref}/check-runs item). */
export function normalizeCheck(raw, host = null) {
  if (!isObject(raw)) return null;
  const id = posInt(raw.id);
  const headSha = sha(raw.head_sha);
  const name = safeText(raw.name, 200);
  if (id === null || headSha === null || !name) return null;
  const startedAt = iso(raw.started_at);
  const completedAt = iso(raw.completed_at);
  return {
    source: "check",
    id,
    attempt: 1,
    name,
    path: null,
    workflowId: null,
    appId: posInt(isObject(raw.app) ? raw.app.id : null),
    suiteId: posInt(isObject(raw.check_suite) ? raw.check_suite.id : null),
    status: safeText(raw.status, 40),
    conclusion: safeText(raw.conclusion, 40),
    event: null,
    headSha,
    headBranch: null,
    htmlUrl: link(raw.html_url, host),
    createdAt: startedAt,
    startedAt,
    updatedAt: completedAt ?? startedAt,
  };
}

/** The pull request as the reducer needs it (GET pulls/{n}). */
export function normalizePull(raw) {
  if (!isObject(raw)) return null;
  const number = posInt(raw.number);
  if (number === null) return null;
  return {
    number,
    state: raw.state === "open" ? "open" : "closed",
    merged: raw.merged === true,
    mergedAt: iso(raw.merged_at),
    mergeCommitSha: sha(raw.merge_commit_sha),
    baseRef: safeText(isObject(raw.base) ? raw.base.ref : null, 120),
    headRef: safeText(isObject(raw.head) ? raw.head.ref : null, 120),
    headSha: sha(isObject(raw.head) ? raw.head.sha : null),
  };
}

/** Map GitHub's status/conclusion pair to a check state. Unknown values are never success. */
export function classify(status, conclusion) {
  if (status === "completed") {
    switch (conclusion) {
      case "success": return { state: "passed", reason: null };
      case "failure": case "timed_out": case "startup_failure": return { state: "failed", reason: `conclusion:${conclusion}` };
      case "cancelled": case "stale": return { state: "cancelled", reason: `conclusion:${conclusion}` };
      case "skipped": return { state: "skipped", reason: null };
      case "neutral": return { state: "neutral", reason: null };
      case "action_required": return { state: "failed", reason: "conclusion:action_required" };
      default: return { state: "failed", reason: "unknown-conclusion" };
    }
  }
  if (status === "in_progress") return { state: "running", reason: null };
  if (status === "queued" || status === "waiting" || status === "pending" || status === "requested") return { state: "waiting", reason: `status:${status}` };
  return { state: "waiting", reason: "unknown-status" };
}

// Policy -----------------------------------------------------------------------------------------

/**
 * Validate and canonicalize a policy `{required, allowSkipped, deployment, detectionWindowMs, trigger, pins}`.
 * @returns {{policy: object, problems: string[]}}
 */
export function normalizePolicy(raw) {
  const problems = [];
  const list = (name) => {
    const value = isObject(raw) ? raw[name] : undefined;
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      problems.push(`${name} must be an array of strings`);
      return [];
    }
    if (value.length > MAX_KEYS) problems.push(`${name} has more than ${MAX_KEYS} entries`);
    const out = [];
    for (const item of value.slice(0, MAX_KEYS)) {
      const text = typeof item === "string" ? safeText(item.trim(), 200) : null;
      if (!text) problems.push(`${name} entries must be non-empty strings`);
      else if (!out.includes(text)) out.push(text);
    }
    return out;
  };
  const windowRaw = isObject(raw) ? raw.detectionWindowMs : undefined;
  let detectionWindowMs = DEFAULT_DETECTION_WINDOW_MS;
  if (windowRaw !== undefined) {
    if (Number.isSafeInteger(windowRaw) && windowRaw >= 1000 && windowRaw <= 24 * 3_600_000) detectionWindowMs = windowRaw;
    else problems.push("detectionWindowMs must be an integer from 1000 to 86400000");
  }
  const triggerRaw = isObject(raw) ? raw.trigger : undefined;
  let trigger = null;
  if (triggerRaw !== undefined) {
    if (TRIGGERS.includes(triggerRaw)) trigger = triggerRaw;
    else problems.push(`trigger must be one of ${TRIGGERS.join(", ")}`);
  }
  // pins: a check name pinned to the GitHub App that must produce it (from branch protection `checks[].app_id`).
  const pins = [];
  const pinsRaw = isObject(raw) ? raw.pins : undefined;
  if (pinsRaw !== undefined) {
    if (!Array.isArray(pinsRaw)) problems.push("pins must be an array");
    else {
      for (const pin of pinsRaw.slice(0, MAX_KEYS)) {
        const key = isObject(pin) && typeof pin.key === "string" ? safeText(pin.key.trim(), 200) : null;
        if (key && posInt(pin.appId) !== null) {
          if (!pins.some((item) => item.key === key)) pins.push({ key, appId: pin.appId });
        } else problems.push("pins entries need a key and a positive integer appId");
      }
    }
  }
  return { policy: { required: list("required"), allowSkipped: list("allowSkipped"), deployment: list("deployment"), detectionWindowMs, trigger, pins }, problems };
}

/** `completion.requiredChecks` problems; shared by the adapter validation in config.mjs and the loader in required.mjs. */
export function validateRequiredChecks(value, where = "completion.requiredChecks") {
  if (!Array.isArray(value)) return [`${where} must be an array of strings`];
  const problems = [];
  if (value.length > MAX_KEYS) problems.push(`${where} has more than ${MAX_KEYS} entries`);
  value.slice(0, MAX_KEYS).forEach((item, index) => {
    if (typeof item !== "string" || item.trim() === "" || item.length > 200) problems.push(`${where}[${index}] must be a non-empty string of at most 200 characters`);
  });
  return problems;
}

/** Union of required-check sources, in documented precedence order, deduplicated. */
export function unionRequired(...lists) {
  const out = [];
  for (const list of lists) for (const item of list ?? []) if (!out.includes(item) && out.length < MAX_KEYS) out.push(item);
  return out;
}

// State ------------------------------------------------------------------------------------------

export function initialState({ repo, prNumber, host = "github.com", now }) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    repo,
    host,
    prNumber,
    pr: { state: "open", headSha: null, headRef: null, baseBranch: null, mergedAt: null, mergeObservedAt: null, mergeCommitSha: null },
    target: { sha: null, branch: null },
    slots: {},
    suites: {},
    listing: {},
    lost: {},
    counters: { observed: 0, duplicates: 0, outOfOrder: 0, foreign: 0, superseded: 0, dropped: 0 },
    poll: { count: 0, reconciledAt: null, lastPolledAt: null, lastSuccessAt: null, status: "idle", resumeAt: null, consecutiveErrors: 0, lastError: null, rateLimit: null },
    links: { runId: null, sessionId: null },
    policy: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Fold a normalized pull request into the state (mutates `state`). */
function applyPullInPlace(state, pull, now) {
  if (pull === null || pull.number !== state.prNumber) return;
  const pr = state.pr;
  if (pull.headSha) pr.headSha = pull.headSha;
  if (pull.headRef) pr.headRef = pull.headRef;
  if (pull.baseRef) pr.baseBranch = pull.baseRef;
  if (pull.merged || pr.state === "merged") {
    if (pr.state !== "merged") pr.mergeObservedAt = now;
    pr.state = "merged";
    pr.mergedAt = pull.mergedAt ?? pr.mergedAt;
    pr.mergeCommitSha = pull.mergeCommitSha ?? pr.mergeCommitSha;
    state.target = { sha: pr.mergeCommitSha, branch: pr.baseBranch };
  } else {
    pr.state = pull.state === "open" ? "open" : "closed-unmerged";
  }
}

/** Pure: the state after a pull request observation. */
export function applyPull(state, pull, now) {
  const next = structuredClone(state);
  applyPullInPlace(next, pull, now);
  next.updatedAt = now;
  return next;
}

// A run is identified by (workflow, event); a check run by (app, check suite, name). All GitHub Actions jobs share one app, so the SUITE is what
// keeps two workflows apart. With neither app nor suite the check run stands alone (never superseded). Supersession happens only inside one
// identity (a later check run of the same app and suite); distinct identities are combined worst-of when evaluating. At evaluation time the check
// suites of a known workflow run are grouped by (workflow, event, run id), and a higher run_attempt supersedes the older attempts' checks there.
const identityOf = (obs) => (obs.source === "run" ? `wf:${obs.workflowId ?? ""}:${obs.path ?? obs.name ?? ""}:${obs.event ?? ""}` : (obs.appId || obs.suiteId ? `check:${obs.appId ? `a${obs.appId}` : "x"}:${obs.suiteId ? `s${obs.suiteId}` : "x"}:${obs.name}` : `check:unknown${obs.id}:${obs.name}`));
const fingerprintOf = (obs) => `${obs.source}|${obs.id}|${obs.attempt}|${obs.status}|${obs.conclusion}|${obs.updatedAt}`;
const statusRank = (status) => (status === "completed" ? 2 : status === "in_progress" ? 1 : 0);

/** > 0 when `obs` is newer than the slot's current observation, < 0 when older, 0 when indistinguishable. */
function compareToSlot(slot, obs) {
  if (slot.source === obs.source && slot.runId === obs.id) {
    if (obs.attempt !== slot.attempt) return obs.attempt - slot.attempt;
    if (slot.status === "completed" && obs.status !== "completed") return -1; // terminal is sticky within one attempt
    const delta = time(obs.updatedAt) - time(slot.updatedAt);
    return delta !== 0 ? delta : statusRank(obs.status) - statusRank(slot.status);
  }
  const delta = time(obs.startedAt ?? obs.createdAt) - time(slot.runStartedAt);
  return delta !== 0 ? delta : obs.id - slot.runId;
}

// An identity that was dropped earlier (state.lost) is healed only when a later poll RECORDS that identity - never by its absence.
function applyObservationInPlace(state, obs, now, policy) {
  const outcome = applyObservationCore(state, obs, now, policy);
  const lost = state.lost?.[obs.headSha];
  if (lost !== undefined && (outcome === "applied" || outcome === "duplicate" || outcome === "out-of-order")) {
    delete lost[`s|${obs.headSha}|${identityOf(obs)}`];
    if (Object.keys(lost).length === 0) delete state.lost[obs.headSha];
  }
  return outcome;
}

function applyObservationCore(state, obs, now, policy) {
  const known = obs.headSha === state.pr.headSha || (state.target.sha !== null && obs.headSha === state.target.sha);
  if (!known) {
    state.counters.foreign += 1;
    return "foreign";
  }
  // Only the configured workflow event (default "push") counts for the post-merge commit - also when that commit equals the PR head sha.
  // The check suite -> workflow run map is kept for EVERY observed run (whatever its event); check runs are judged against the CURRENT map when
  // the verdict is computed (settle), never once at apply time, so a run that is listed in a later poll still invalidates earlier check runs.
  const trigger = policy?.trigger ?? DEFAULT_TRIGGER;
  if (state.suites === undefined) state.suites = {};
  if (obs.source === "run" && obs.suiteId !== null && obs.event) {
    const suiteKey = `${obs.headSha}|${obs.suiteId}`;
    if (state.suites[suiteKey] === undefined && Object.keys(state.suites).length < MAX_SLOTS) state.suites[suiteKey] = { event: obs.event, wf: identityOf(obs), runId: obs.id, attempt: obs.attempt };
  }
  if (state.target.sha !== null && obs.headSha === state.target.sha && obs.source === "run" && obs.event !== trigger) {
    state.counters.foreign += 1;
    return "foreign";
  }
  state.counters.observed += 1;
  const key = `s|${obs.headSha}|${identityOf(obs)}`;
  const slot = state.slots[key];
  const fingerprint = fingerprintOf(obs);
  const classified = classify(obs.status, obs.conclusion);
  const fresh = () => ({
    key,
    sha: obs.headSha,
    source: obs.source,
    name: obs.name,
    path: obs.path,
    workflowId: obs.workflowId,
    appId: obs.appId ?? null,
    suiteId: obs.suiteId ?? null,
    runId: obs.id,
    attempt: obs.attempt,
    status: obs.status,
    conclusion: obs.conclusion,
    state: classified.state,
    reason: classified.reason,
    event: obs.event,
    htmlUrl: obs.htmlUrl,
    runStartedAt: obs.startedAt ?? obs.createdAt,
    completedAt: obs.status === "completed" ? obs.updatedAt : null,
    updatedAt: obs.updatedAt,
    observedAt: now,
    superseded: [],
    seen: [fingerprint],
  });
  if (slot === undefined) {
    const prefix = `s|${obs.headSha}|`;
    if (Object.keys(state.slots).filter((existing) => existing.startsWith(prefix)).length >= slotCap(state, obs.headSha)) {
      state.counters.dropped += 1;
      return "dropped";
    }
    state.slots[key] = fresh();
    return "applied";
  }
  if (slot.seen.includes(fingerprint)) {
    state.counters.duplicates += 1;
    return "duplicate";
  }
  if (compareToSlot(slot, obs) <= 0) {
    state.counters.outOfOrder += 1;
    slot.seen = [...slot.seen, fingerprint].slice(-MAX_SEEN);
    return "out-of-order";
  }
  const replaced = fresh();
  const higherAttempt = slot.runId !== obs.id || obs.attempt > slot.attempt;
  if (higherAttempt) {
    replaced.superseded = [...slot.superseded, { runId: slot.runId, attempt: slot.attempt, conclusion: slot.conclusion }].slice(-MAX_SUPERSEDED);
    state.counters.superseded += 1;
  } else {
    replaced.superseded = slot.superseded;
  }
  replaced.seen = [...slot.seen, fingerprint].slice(-MAX_SEEN);
  state.slots[key] = replaced;
  return "applied";
}

/**
 * Fold normalized observations (runs and checks) into the state. Pure: returns `{state, outcomes}`; the input is untouched.
 * @param {object} state
 * @param {object[]} observations  Results of normalizeRun / normalizeCheck (nulls are skipped).
 * @param {{now: string, policy?: object}} options
 */
export function applyObservations(state, observations, { now, policy } = {}) {
  const next = structuredClone(state);
  const outcomes = [];
  for (const obs of observations) if (obs) outcomes.push(applyObservationInPlace(next, obs, now, policy));
  next.updatedAt = now;
  return { state: next, outcomes };
}

// Events: the store keeps the state as a fold of these records (event-first). Observations inside a "poll" event are the ones the
// reducer APPLIED (duplicates and stale reports are summarized in `ignored`), which keeps the log small and the replay exact.
//
//   init        { repo, host, prNumber }
//   poll        { pull: normalized|null, observations: [normalized], ignored: {duplicates,outOfOrder,foreign,dropped}, trigger, rate, reconciled, listing: [{sha, complete, dropped}] }
//   poll.failed { code, rateLimited, resumeAt, rate }
//   policy      { policy: {required, allowSkipped, deployment, detectionWindowMs, trigger, pins}, sources: [{source, used, count, note?}], incomplete? }
//   link        { runId?, sessionId? }
//   checkpoint  { state }          (first record of a rotated log)

const isNormalizedObservation = (obs) => isObject(obs) && (obs.source === "run" || obs.source === "check") && Number.isSafeInteger(obs.id) && typeof obs.headSha === "string" && SHA.test(obs.headSha);

/** Numbers only: the rate-limit info that is stored. */
export function normalizeRate(rate) {
  if (!isObject(rate)) return null;
  const n = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  const stamp = (ms) => (Number.isSafeInteger(ms) && ms > 0 ? new Date(ms).toISOString() : null);
  return { remaining: n(rate.remaining), limit: n(rate.limit), resetAt: stamp(rate.resetAtMs), observedAt: stamp(rate.observedAtMs) };
}

/**
 * Plan one poll: run the reducer to learn which observations apply, and return the "poll" event that, folded, yields the same state.
 * @returns {{event: object, state: object}}
 */
export function planPoll(state, { pull = null, observations = [], rate = null, reconciled = false, listing = [] }, { now, policy, maxEventBytes = MAX_EVENT_BYTES } = {}) {
  const trigger = policy?.trigger ?? null;
  const afterPull = pull ? applyPull(state, pull, now) : structuredClone(state);
  const folded = applyObservations(afterPull, observations, { now, policy });
  const applied = [];
  const ignored = { duplicates: 0, outOfOrder: 0, foreign: 0, dropped: 0 };
  // Observations that were NOT recorded (slot cap, size trim) per commit: an unrecorded observation could be the failing one, so the listing of
  // that commit is then reported incomplete (never closable) until a later poll records everything.
  const lost = new Map();
  const lostKeys = [];
  const lose = (obs) => {
    lost.set(obs.headSha, (lost.get(obs.headSha) ?? 0) + 1);
    if (lostKeys.length < MAX_LOST_KEYS) lostKeys.push({ sha: obs.headSha, key: `s|${obs.headSha}|${identityOf(obs)}` });
    else if (!lostKeys.some((item) => item.key === "overflow" && item.sha === obs.headSha)) lostKeys.push({ sha: obs.headSha, key: "overflow" });
  };
  let index = 0;
  for (const obs of observations) {
    if (!obs) continue;
    const outcome = folded.outcomes[index++];
    if (outcome === "applied") applied.push(obs);
    else if (outcome === "duplicate") ignored.duplicates += 1;
    else if (outcome === "out-of-order") ignored.outOfOrder += 1;
    // A refused run of another event is still recorded (it is counted as foreign when folded): its check suite must stay known so that check
    // runs of that suite are never taken for push checks, now or after a replay.
    else if (outcome === "foreign" && obs.source === "run" && obs.suiteId !== null && obs.event) applied.push(obs);
    else if (outcome === "foreign") ignored.foreign += 1;
    else if (outcome === "dropped") {
      ignored.dropped += 1;
      lose(obs);
    }
  }
  const event = { type: "poll", at: now, pull, observations: applied, ignored, trigger, rate: normalizeRate(rate), reconciled, listing: [] };
  // Only the two commits that matter (the PR head and the merge commit) are tracked, whatever order or extras the caller lists.
  const known = new Set([folded.state.pr.headSha, folded.state.target.sha].filter((sha) => sha !== null));
  const listed = listing.filter((item) => SHA.test(String(item?.sha)) && known.has(item.sha)).slice(0, 2).map((item) => ({ sha: item.sha, complete: item.complete === true }));
  const target = folded.state.target.sha;
  // A poll event must stay far below the store's per-event cap. When it is too big, observations are removed - those of the pull request head
  // first, the merge commit's last, oldest first - and every commit that lost one is reported incomplete in this very event.
  const size = () => Buffer.byteLength(stringifyJson({ ...event, listing: finish(), lost: lostKeys }));
  const finish = () => {
    const rows = listed.map((item) => ({ ...item, complete: item.complete && !lost.has(item.sha), dropped: lost.get(item.sha) ?? 0 }));
    for (const [sha, count] of lost) if (!rows.some((row) => row.sha === sha) && rows.length < 2) rows.push({ sha, complete: false, dropped: count });
    return rows;
  };
  while (event.observations.length > 0 && size() > maxEventBytes) {
    const order = [...event.observations.keys()].sort((a, b) => Number(event.observations[a].headSha === target) - Number(event.observations[b].headSha === target) || a - b);
    const cut = new Set(order.slice(0, Math.max(1, Math.floor(event.observations.length / 2))));
    for (const index2 of cut) lose(event.observations[index2]);
    event.ignored = { ...event.ignored, dropped: event.ignored.dropped + cut.size };
    event.observations = event.observations.filter((_, position) => !cut.has(position));
    event.trimmed = true;
  }
  event.listing = finish();
  if (lostKeys.length > 0) event.lost = lostKeys;
  return { event, state: foldEvent(state, event) };
}

function foldInPlace(state, event) {
  const at = typeof event.at === "string" ? event.at : state.updatedAt;
  switch (event.type) {
    case "poll": {
      if (isObject(event.pull)) applyPullInPlace(state, event.pull, at);
      const policy = { trigger: TRIGGERS.includes(event.trigger) ? event.trigger : null };
      for (const obs of Array.isArray(event.observations) ? event.observations : []) if (isNormalizedObservation(obs)) applyObservationInPlace(state, obs, at, policy);
      for (const item of Array.isArray(event.listing) ? event.listing.slice(0, 2) : []) {
        if (isObject(item) && typeof item.sha === "string" && SHA.test(item.sha)) {
          if (state.listing === undefined) state.listing = {};
          state.listing[item.sha] = { complete: item.complete === true, dropped: Number.isSafeInteger(item.dropped) && item.dropped > 0 ? item.dropped : 0 };
        }
      }
      for (const item of Array.isArray(event.lost) ? event.lost.slice(0, MAX_LOST_KEYS * 2) : []) {
        if (isObject(item) && typeof item.sha === "string" && SHA.test(item.sha) && typeof item.key === "string" && item.key.length <= 600) {
          if (state.lost === undefined) state.lost = {};
          state.lost[item.sha] ??= {};
          if (Object.keys(state.lost[item.sha]).length < MAX_LOST_KEYS + 1) state.lost[item.sha][item.key] = true;
        }
      }
      const ignored = isObject(event.ignored) ? event.ignored : {};
      for (const [from, to] of [["duplicates", "duplicates"], ["outOfOrder", "outOfOrder"], ["foreign", "foreign"], ["dropped", "dropped"]]) {
        if (Number.isSafeInteger(ignored[from]) && ignored[from] > 0) state.counters[to] += ignored[from];
      }
      Object.assign(state.poll, { count: state.poll.count + 1, lastPolledAt: at, lastSuccessAt: at, status: "ok", resumeAt: null, consecutiveErrors: 0, lastError: null, rateLimit: normalizeRate0(event.rate), reconciledAt: event.reconciled === true ? at : state.poll.reconciledAt ?? null });
      break;
    }
    case "poll.failed":
      Object.assign(state.poll, { lastPolledAt: at, status: event.rateLimited === true ? "rate-limited" : "error", resumeAt: typeof event.resumeAt === "string" ? event.resumeAt : null, consecutiveErrors: state.poll.consecutiveErrors + 1, lastError: { code: safeText(event.code, 60) ?? "ERROR", at }, rateLimit: event.rate === undefined ? state.poll.rateLimit : normalizeRate0(event.rate) });
      break;
    case "policy":
      if (isObject(event.policy)) state.policy = { ...normalizePolicy(event.policy).policy, sources: (Array.isArray(event.sources) ? event.sources : []).slice(0, 10).map((item) => ({ source: safeText(item?.source, 40), used: item?.used === true, count: Number.isSafeInteger(item?.count) ? item.count : 0, note: safeText(item?.note, 80), ...(Array.isArray(item?.contexts) ? { contexts: item.contexts.slice(0, MAX_KEYS).map((context) => safeText(context, 200)).filter(Boolean) } : {}) })), incomplete: typeof event.incomplete === "string" && event.incomplete !== "" ? safeText(event.incomplete, 80) : null, recordedAt: at };
      break;
    case "link":
      if (typeof event.runId === "string") state.links.runId = safeText(event.runId, 64);
      if (typeof event.sessionId === "string") state.links.sessionId = safeText(event.sessionId, 64);
      break;
    default:
      break;
  }
  state.updatedAt = at;
}

// Stored rate info has already been normalized (resetAt is an ISO string); keep only its known fields.
function normalizeRate0(rate) {
  if (!isObject(rate)) return null;
  const n = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
  return { remaining: n(rate.remaining), limit: n(rate.limit), resetAt: iso(rate.resetAt), observedAt: iso(rate.observedAt) };
}

/** Pure: the state after one event. */
export function foldEvent(state, event) {
  const next = structuredClone(state);
  foldInPlace(next, event);
  return next;
}

/** Fold a list of events onto `base` (null = start from an "init" or "checkpoint" event). Returns null when there is nothing to fold. */
export function foldEvents(base, events) {
  let state = base === null ? null : structuredClone(base);
  for (const event of events) {
    if (event.type === "init") {
      state = initialState({ repo: event.repo, prNumber: event.prNumber, host: event.host ?? "github.com", now: event.at });
    } else if (event.type === "checkpoint" && isObject(event.state)) {
      state = structuredClone(event.state);
    } else if (state !== null) {
      foldInPlace(state, event);
    }
  }
  return state;
}

// Evaluation -------------------------------------------------------------------------------------

const baseName = (path) => (typeof path === "string" ? path.split("/").pop() : null);
/** A key that names a workflow FILE: it contains "/" or ends in .yml / .yaml. A bare file name means .github/workflows/<name>. */
export const isPathKey = (key) => key.includes("/") || /\.ya?ml$/i.test(key);
export const workflowPath = (key) => (key.includes("/") ? key : `.github/workflows/${key}`);
/**
 * Strict key match. A path key matches ONLY the exact workflow path of a workflow run. A bare key matches check runs by name only: a workflow
 * is never matched by its (attacker-chosen) name, because any workflow file can call itself "CI". The pinned GitHub App, when given, must produce it.
 */
export const matches = (key, slot, pin = null) => {
  if (isPathKey(key)) return slot.source === "run" && slot.path === workflowPath(key);
  return slot.source === "check" && slot.name === key && (pin === null || slot.appId === pin);
};
/** Lenient match for human filters (diagnose --check): path, base name, workflow name or check name. */
export const matchesLoose = (key, slot) => slot.path === key || baseName(slot.path) === key || slot.name === key;

function worstOf(states) {
  for (const candidate of WORST) if (states.includes(candidate)) return candidate;
  return "waiting";
}

/**
 * Decide which matched slots count, from the CURRENT suite map (post-merge only):
 *  - a check run whose suite belongs to a known workflow run counts only when that run's event is the trigger (default push);
 *  - a check run whose suite no listed run owns is a non-workflow producer ONLY when the run listing of that sha was complete; otherwise it does
 *    not count (`unknown`);
 *  - among check runs of the same workflow run (workflow + event + run id) the highest run_attempt supersedes older attempts; nothing supersedes
 *    across workflows or runs.
 */
function settle(state, matched, stage, policy, sha) {
  if (stage !== "post-merge") return { counted: matched, unknown: [] };
  const trigger = policy.trigger ?? DEFAULT_TRIGGER;
  const incomplete = state.listing?.[sha]?.complete === false;
  const infoOf = (slot) => (slot.suiteId === null || slot.suiteId === undefined ? undefined : state.suites?.[`${sha}|${slot.suiteId}`]);
  const counted = [];
  const unknown = [];
  // When the merge commit IS the PR head, observations made before the merge (pull_request runs, their checks, third-party checks) sit on the
  // same sha: an unattributed check suite is then unknown whatever the listing says.
  const sameAsHead = sha === state.pr.headSha;
  for (const slot of matched) {
    if (slot.source === "run") {
      if (slot.event === trigger) counted.push(slot); // a run of any other event never counts for the merge commit
    } else if (slot.suiteId === null || slot.suiteId === undefined) counted.push(slot);
    else {
      const info = infoOf(slot);
      if (info === undefined) (incomplete || sameAsHead ? unknown : counted).push(slot);
      else if (info.event === trigger) counted.push(slot);
    }
  }
  const groupOf = (slot) => {
    const info = slot.source === "check" ? infoOf(slot) : undefined;
    return info === undefined ? null : `${info.wf}|${info.runId}|${slot.name}`;
  };
  const best = new Map();
  for (const slot of counted) {
    const group = groupOf(slot);
    if (group !== null) best.set(group, Math.max(best.get(group) ?? 0, infoOf(slot).attempt));
  }
  return { counted: counted.filter((slot) => groupOf(slot) === null || infoOf(slot).attempt === best.get(groupOf(slot))), unknown };
}

function evaluateKey(state, key, role, stage, policy, nowMs) {
  const targetSha = stage === "post-merge" ? state.target.sha : state.pr.headSha;
  const base = { key, role, stage, state: "waiting", reason: null, satisfied: false, runId: null, attempt: null, conclusion: null, url: null, updatedAt: null, workflow: null };
  if (stage === "post-merge" && state.pr.state !== "merged") return { ...base, reason: "pr-not-merged" };
  if (targetSha === null) {
    const since = Date.parse(state.pr.mergedAt ?? state.pr.mergeObservedAt ?? "") || nowMs;
    return nowMs - since > policy.detectionWindowMs ? { ...base, state: "run-not-detected", reason: "merge-commit-unknown" } : { ...base, reason: "merge-commit-unknown" };
  }
  const pin = (policy.pins ?? []).find((item) => item.key === key)?.appId ?? null;
  const onSha = Object.values(state.slots).filter((slot) => slot.sha === targetSha);
  const { counted: slots, unknown } = settle(state, onSha.filter((slot) => matches(key, slot, pin)), stage, policy, targetSha);
  if (slots.length === 0) {
    if (unknown.length > 0) return { ...base, reason: "suite-event-unknown", remediation: "A check run belongs to a check suite whose workflow run was not listed completely; it does not count until the suite is known." };
    if (stage === "pre-merge") return { ...base, reason: "no-run-yet" };
    const since = Date.parse(state.pr.mergedAt ?? state.pr.mergeObservedAt ?? "") || nowMs;
    const expired = nowMs - since > policy.detectionWindowMs;
    // A bare key that only a workflow NAME would match is ambiguous, never satisfied: any workflow file can call itself anything.
    const named = isPathKey(key) ? [] : [...new Set(onSha.filter((slot) => slot.source === "run" && slot.name === key).map((slot) => slot.path ?? slot.name))];
    if (named.length > 0) return { ...base, state: expired ? "ambiguous-key" : "waiting", reason: `name-matches-workflow-only:${named.slice(0, 3).join(",")}`, remediation: `List the workflow file (for example .github/workflows/<file>.yml) instead of the name ${key}, or the exact check name.` };
    return expired ? { ...base, state: "run-not-detected", reason: "no-run-for-target-commit" } : { ...base, reason: "no-run-yet" };
  }
  const worst = worstOf(slots.map((slot) => slot.state));
  const pick = slots.find((slot) => slot.state === worst);
  const allowed = (worst === "skipped" || worst === "neutral") && policy.allowSkipped.includes(key);
  return { ...base, state: worst, reason: pick.reason ?? (allowed ? "allowed-by-policy" : null), satisfied: worst === "passed" || allowed, runId: pick.runId, attempt: pick.attempt, conclusion: pick.conclusion, url: pick.htmlUrl, updatedAt: pick.updatedAt, workflow: pick.path ?? pick.name };
}

const MISSING_REMEDIATION = "Configure required checks: add `completion.requiredChecks` to the trusted repository adapter (.claude/asterweave.json), or list them under repos.<owner/name>.required in pipeline.json in the Asterweave user directory, or enable required status checks in the branch protection of the base branch.";

/**
 * The verdict for the current state. `now` is epoch milliseconds. Pure.
 * @returns {{verdict: string, closable: boolean, pr: object, target: object, keys: object[], preMerge: object[], blockers: object[], counters: object}}
 */
export function evaluate(state, policyInput, nowMs) {
  const policy = { required: [], allowSkipped: [], deployment: [], detectionWindowMs: DEFAULT_DETECTION_WINDOW_MS, trigger: null, pins: [], ...policyInput };
  // `unavailable` (not stored): a required-check source could not be read this time, so the set may be incomplete. Never closable then.
  // The runs / check runs listing of the target commit was cut off (page cap): what is missing could be a failure, so never closable.
  // Observations dropped (slot cap, size trim) on the target commit count the same way: the missing one may be the failure.
  // A missing listing record for the target commit is incomplete too (fail closed). Identities that were dropped and not recorded again block as well.
  const gap = state.target.sha !== null ? state.listing?.[state.target.sha] : undefined;
  const lostHere = state.target.sha !== null && Object.keys(state.lost?.[state.target.sha] ?? {}).length > 0;
  const listingIncomplete = state.target.sha === null ? null : gap === undefined ? "listing-unknown" : gap.complete === false || lostHere ? (gap.dropped > 0 || lostHere ? "observations-dropped" : "listing-incomplete") : null;
  const unavailable = (typeof policyInput?.unavailable === "string" && policyInput.unavailable !== "" ? policyInput.unavailable : null) ?? listingIncomplete;
  const keys = [...policy.required.map((key) => evaluateKey(state, key, "required", "post-merge", policy, nowMs)), ...policy.deployment.filter((key) => !policy.required.includes(key)).map((key) => evaluateKey(state, key, "deployment", "post-merge", policy, nowMs))];
  const preMerge = policy.required.map((key) => evaluateKey(state, key, "required", "pre-merge", policy, nowMs));
  const blockers = [];
  let verdict;
  if (state.pr.state === "closed-unmerged") {
    verdict = "closed-unmerged";
    blockers.push({ key: "pr", state: "closed-unmerged", reason: "the pull request was closed without merging" });
  } else if (policy.required.length === 0) {
    verdict = "missing-configuration";
    blockers.push({ key: "*", state: "missing-configuration", reason: "no required checks are configured for this repository", remediation: MISSING_REMEDIATION });
  } else if (state.pr.state !== "merged") {
    verdict = "waiting";
    blockers.push({ key: "pr", state: "waiting", reason: "the pull request is not merged yet" });
  } else {
    const present = keys.map((entry) => entry.state);
    verdict = present.includes("failed") ? "failed" : present.includes("cancelled") ? "cancelled" : present.includes("ambiguous-key") ? "ambiguous-key" : keys.some((entry) => !entry.satisfied && (entry.state === "skipped" || entry.state === "neutral")) ? "not-passed" : present.includes("run-not-detected") ? "run-not-detected" : keys.every((entry) => entry.satisfied) ? "closable" : "waiting";
    for (const entry of keys) if (!entry.satisfied) blockers.push({ key: entry.key, state: entry.state, reason: entry.reason ?? entry.state, ...(entry.remediation ? { remediation: entry.remediation } : {}) });
  }
  if (unavailable !== null && state.pr.state !== "closed-unmerged" && (verdict === "closable" || verdict === "missing-configuration" || verdict === "waiting")) {
    verdict = "waiting";
    blockers.push({ key: "*", state: "waiting", reason: "required-checks-unavailable", remediation: `A required-check source could not be read (${unavailable}); the set of required checks may be incomplete. Retry; nothing is closable until it can be read.` });
  }
  return {
    verdict,
    closable: verdict === "closable",
    unavailable,
    pr: { state: state.pr.state, headSha: state.pr.headSha, baseBranch: state.pr.baseBranch, mergedAt: state.pr.mergedAt, mergeCommitSha: state.pr.mergeCommitSha },
    target: { ...state.target },
    keys,
    preMerge,
    blockers,
    counters: { ...state.counters },
  };
}

/** Verdicts after which `watch` stops (everything except waiting). */
export const isTerminalVerdict = (verdict) => verdict !== "waiting";
