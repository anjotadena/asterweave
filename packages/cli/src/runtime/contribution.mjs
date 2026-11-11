// Per-run contribution state: the recorded authorization scope, the selected task, structured findings, a remote-write
// journal and a task claim. Stored next to the run ledger as `contribution.json`; the ledger (events.jsonl) stays the
// source of truth for stages, evidence and attempts, and this file only adds what the ledger has no place for.
//
// Nothing here talks to a remote. The journal makes a remote write SAFE TO RETRY for whoever performs it:
//   begin(op, target)  -> proceed | duplicate (already recorded) | reconcile (an earlier attempt may have landed)
//   record(key, id)    -> the remote id, stored the moment the write succeeds
//   uncertain(key)     -> the response was lost: the next begin() answers `reconcile`, never `proceed`
//   reconcile(key,...) -> look the object up on the remote, then record it or release the key
// Authorization: `discovery` and `implement` allow no remote write at all; `publish` allows only the exact
// {operation, target} pairs the user named. Merge, deploy and force push are never authorizable here.

import { createHash } from "node:crypto";
import nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { redactText, sanitizeForTerminal } from "../redact.mjs";
import { readJson, writeJsonAtomic } from "../store.mjs";
import { repoDirName, runsRoot } from "./ledger.mjs";

export const CONTRIBUTION_FILE = "contribution.json";
export const SCOPES = Object.freeze(["discovery", "implement", "publish"]);
export const REMOTE_OPERATIONS = Object.freeze(["push-branch", "open-pr", "create-issue", "post-comment", "post-review"]);
export const FINDING_STATUSES = Object.freeze(["suspected", "reproduced", "fixed-locally", "verified", "blocked"]);
export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low", "info"]);
export const CONFIDENCES = Object.freeze(["high", "medium", "low"]);
export const OWNERSHIPS = Object.freeze(["presentation-logic", "upstream-api", "source-document", "repository-code", "unknown"]);
export const MAX_FINDINGS = 200;

/** Explicit mapping from a finding status to the Asterweave graph state that backs it (documented in references/contribution.md). */
export const STATUS_TO_GRAPH = Object.freeze({
  suspected: { evidence: "finding", result: "info" },
  reproduced: { evidence: "reproduction", result: "pass" },
  "fixed-locally": { node: "implement", status: "passed" },
  verified: { node: "test-verify", status: "passed", also: "pr-review" },
  blocked: { runStatus: "blocked" },
});

const clip = (value, max) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, max);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha = (text) => createHash("sha256").update(text).digest("hex");

function fail(message, code, remediation) {
  return new CliError(message, { code, exitCode: EXIT.ERROR, remediation });
}

const fileOf = (dir) => path.join(dir, CONTRIBUTION_FILE);

/** @returns {object | null} null when the run has no contribution state (every non-contribution run). */
export function loadContribution(dir, { fs = nodeFs } = {}) {
  const data = readJson(fileOf(dir), { fallback: null, fs });
  if (data === null) return null;
  if (!isObject(data) || data.v !== 1 || !SCOPES.includes(data.scope?.level)) {
    throw fail("contribution.json is not a valid contribution record.", "CONTRIBUTION_CORRUPT", "Remove the file only if you accept losing the recorded scope, task and remote references.");
  }
  return data;
}

function save(dir, state, options) {
  writeJsonAtomic(fileOf(dir), state, { fs: options?.fs });
  return state;
}

/**
 * Record the scope and objective once, at the start of the run. Scope only ever comes from the caller (the user's command),
 * never from text found in a repository, an issue or a page.
 */
export function initContribution(dir, { skill, workflow, objective, level, grants = [], now = () => new Date().toISOString() }, options = {}) {
  if (!SCOPES.includes(level)) throw fail(`Unknown scope '${clip(level, 20)}'.`, "CONTRIBUTION_SCOPE", `Use one of: ${SCOPES.join(", ")}.`);
  const existing = loadContribution(dir, options);
  if (existing) return existing; // resume: the first recording wins and is never widened implicitly
  for (const grant of grants) validateGrant(grant);
  if (grants.length > 0 && level !== "publish") throw fail("Remote grants need the publish scope.", "CONTRIBUTION_SCOPE", "Use scope publish with explicit {operation, target} grants.");
  return save(dir, { v: 1, skill, workflow, objective: clip(objective, 500), scope: { level, grants: grants.map((g) => ({ operation: g.operation, target: clip(g.target, 300) })), recordedAt: now() }, task: null, findings: [], remote: {} }, options);
}

function validateGrant(grant) {
  if (!isObject(grant) || !REMOTE_OPERATIONS.includes(grant.operation) || typeof grant.target !== "string" || grant.target === "") {
    throw fail("A remote grant is {operation, target} with a known operation.", "CONTRIBUTION_GRANT", `Operations: ${REMOTE_OPERATIONS.join(", ")}. Merge, deploy and force push cannot be granted.`);
  }
}

/** Pure check. @returns {{allowed: boolean, reason: string}} */
export function authorizes(state, operation, target) {
  if (!REMOTE_OPERATIONS.includes(operation)) return { allowed: false, reason: `operation '${clip(operation, 40)}' is never authorizable here` };
  if (state?.scope?.level !== "publish") return { allowed: false, reason: `scope is ${state?.scope?.level ?? "unrecorded"}: no remote write is authorized` };
  const hit = state.scope.grants.some((grant) => grant.operation === operation && grant.target === target);
  return hit ? { allowed: true, reason: "granted" } : { allowed: false, reason: "no grant names this operation and target" };
}

// --- findings ---------------------------------------------------------------------------------------

const FINDING_REQUIRED = ["title", "category", "location", "expected", "observed", "impact", "severity", "severityRationale", "confidence", "ownership"];

/** @returns {string[]} problems; a finding without them can be recorded. */
export function validateFinding(finding) {
  if (!isObject(finding)) return ["finding must be an object"];
  const problems = [];
  for (const key of FINDING_REQUIRED) if (typeof finding[key] !== "string" || finding[key].trim() === "") problems.push(`${key} is required`);
  if (finding.severity && !SEVERITIES.includes(finding.severity)) problems.push(`severity must be one of ${SEVERITIES.join(", ")}`);
  if (finding.confidence && !CONFIDENCES.includes(finding.confidence)) problems.push(`confidence must be one of ${CONFIDENCES.join(", ")}`);
  if (finding.ownership && !OWNERSHIPS.includes(finding.ownership)) problems.push(`ownership must be one of ${OWNERSHIPS.join(", ")}`);
  if (finding.status !== undefined && !FINDING_STATUSES.includes(finding.status)) problems.push(`status must be one of ${FINDING_STATUSES.join(", ")}`);
  if (finding.status === "reproduced" && !(Array.isArray(finding.reproduction) && finding.reproduction.length > 0)) problems.push("a reproduced finding needs reproduction steps");
  if (finding.status === "verified" && !(Array.isArray(finding.evidence) && finding.evidence.length > 0)) problems.push("a verified finding needs evidence references");
  return problems;
}

/** Adds a finding with a stable id (F-1, F-2, ...). A scanner result is `suspected` until assessed. */
export function addFinding(dir, finding, options = {}) {
  const state = requireState(dir, options);
  const { status: _ignored, ...input } = finding ?? {}; // a finding always starts suspected; status only moves via setFindingStatus
  const problems = validateFinding({ ...input, status: "suspected" });
  if (problems.length > 0) throw fail(`Invalid finding: ${problems.slice(0, 4).join("; ")}.`, "FINDING_INVALID");
  if (state.findings.length >= MAX_FINDINGS) throw fail(`More than ${MAX_FINDINGS} findings.`, "FINDING_LIMIT", "Triage and close findings before recording more.");
  const id = `F-${state.findings.reduce((max, f) => Math.max(max, Number(f.id.slice(2))), 0) + 1}`;
  const record = { ...Object.fromEntries(Object.entries(input).map(([k, v]) => [k, typeof v === "string" ? clip(v, 1000) : v])), id, status: "suspected" };
  state.findings.push(record);
  save(dir, state, options);
  return record;
}

const ORDER = { suspected: 0, reproduced: 1, "fixed-locally": 2, verified: 3 };

/** Moves a finding forward (or to blocked). Going backwards is refused so a verified finding is not silently downgraded. */
export function setFindingStatus(dir, id, status, details = {}, options = {}) {
  const state = requireState(dir, options);
  const finding = state.findings.find((f) => f.id === id);
  if (!finding) throw fail(`No finding ${clip(id, 20)}.`, "FINDING_UNKNOWN");
  const next = { ...finding, ...details, status };
  const problems = validateFinding(next);
  if (problems.length > 0) throw fail(`Cannot mark ${id} ${status}: ${problems.slice(0, 3).join("; ")}.`, "FINDING_INVALID");
  if (status !== "blocked" && finding.status !== "blocked" && ORDER[status] < ORDER[finding.status]) throw fail(`Finding ${id} is ${finding.status}; it cannot go back to ${status}.`, "FINDING_ORDER");
  Object.assign(finding, next);
  save(dir, state, options);
  return finding;
}

export function selectTask(dir, task, options = {}) {
  const state = requireState(dir, options);
  if (!isObject(task) || typeof task.title !== "string" || !Array.isArray(task.acceptance) || task.acceptance.length === 0) {
    throw fail("A task needs a title and acceptance criteria before implementation.", "TASK_INVALID");
  }
  state.task = { title: clip(task.title, 200), acceptance: task.acceptance.map((c) => clip(c, 300)).slice(0, 20), findingId: task.findingId ?? null, reproduction: Array.isArray(task.reproduction) ? task.reproduction.map((s) => clip(s, 300)).slice(0, 20) : [] };
  return save(dir, state, options).task;
}

// --- remote-write journal ---------------------------------------------------------------------------

export const remoteKey = (runId, operation, target) => sha(`${runId}\n${operation}\n${target}`).slice(0, 24);

/** @returns {{action: 'proceed'|'duplicate'|'reconcile', key: string, id?: string, reason?: string}} */
export function beginRemoteWrite(dir, { runId, operation, target }, options = {}) {
  const state = requireState(dir, options);
  const verdict = authorizes(state, operation, target);
  if (!verdict.allowed) throw new CliError(`Remote write refused: ${verdict.reason}.`, { code: "REMOTE_NOT_AUTHORIZED", exitCode: EXIT.ERROR, remediation: "Remote actions need a publish scope with a grant naming this operation and target." });
  const key = remoteKey(runId, operation, target);
  const entry = state.remote[key];
  if (entry?.status === "recorded") return { action: "duplicate", key, id: entry.id };
  if (entry?.status === "uncertain" || entry?.status === "pending") return { action: "reconcile", key, reason: `an earlier attempt is ${entry.status}: look it up on the remote before writing again` };
  state.remote[key] = { operation, target: clip(target, 300), status: "pending", attempts: (entry?.attempts ?? 0) + 1 };
  save(dir, state, options);
  return { action: "proceed", key };
}

export function recordRemoteWrite(dir, key, id, options = {}) {
  const state = requireState(dir, options);
  const entry = state.remote[key];
  if (!entry) throw fail("Unknown remote write key.", "REMOTE_UNKNOWN");
  entry.status = "recorded";
  entry.id = clip(id, 200);
  save(dir, state, options);
  return entry;
}

export function markRemoteUncertain(dir, key, options = {}) {
  const state = requireState(dir, options);
  if (state.remote[key]?.status === "pending") state.remote[key].status = "uncertain";
  save(dir, state, options);
}

/** `found`: the remote id of the object the lookup found, or null when the remote has none (the key is then released for a retry). */
export function reconcileRemoteWrite(dir, key, found, options = {}) {
  const state = requireState(dir, options);
  const entry = state.remote[key];
  if (!entry) throw fail("Unknown remote write key.", "REMOTE_UNKNOWN");
  if (found) {
    entry.status = "recorded";
    entry.id = clip(found, 200);
  } else {
    entry.status = "released";
  }
  save(dir, state, options);
  return entry;
}

// --- task claim -------------------------------------------------------------------------------------

/** One fixer per task and repository: an exclusive file in the user directory. The same run may claim again (resume). */
export function claimTask(repoKey, taskKey, runId, options = {}) {
  const fs = options.fs ?? nodeFs;
  const dir = path.join(path.dirname(runsRoot(options)), "claims", repoDirName(repoKey));
  const file = path.join(dir, `${sha(String(taskKey)).slice(0, 32)}.json`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(file, `${stringifyJson({ v: 1, runId, task: clip(taskKey, 200) })}\n`, { flag: "wx", mode: 0o600 });
    return { claimed: true, file };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const holder = readJson(file, { fallback: null, fs });
  if (holder?.runId === runId) return { claimed: true, file, resumed: true };
  return { claimed: false, file, holder: holder?.runId ?? "unknown" };
}

export function releaseTask(file, runId, options = {}) {
  const fs = options.fs ?? nodeFs;
  const holder = readJson(file, { fallback: null, fs });
  if (holder?.runId !== runId) return false;
  fs.unlinkSync(file);
  return true;
}

// --- monitor view -----------------------------------------------------------------------------------

function requireState(dir, options) {
  const state = loadContribution(dir, options);
  if (!state) throw fail("This run has no contribution record.", "CONTRIBUTION_MISSING", "Start it with --workflow contribute or --workflow audit.");
  return state;
}

/**
 * What the run monitor shows for a contribution run. `run` is the ledger snapshot (graph state); everything derived from it is
 * derived from completed nodes, never from a guess. Unavailable telemetry stays null.
 */
export function describeContribution(state, run) {
  const nodes = Object.entries(run?.nodes ?? {});
  const passed = nodes.filter(([, n]) => n.status === "passed").length;
  const current = run?.currentNode ?? null;
  const counts = Object.fromEntries(FINDING_STATUSES.map((s) => [s, state.findings.filter((f) => f.status === s).length]));
  const ledgerFindings = nodes.reduce((sum, [, n]) => sum + (n.attemptLog ?? []).flatMap((a) => a.evidence ?? []).filter((item) => item.kind === "finding").length, 0);
  const blocked = run?.status === "blocked" || state.findings.some((f) => f.status === "blocked");
  const remote = Object.entries(state.remote).map(([key, e]) => ({ key, operation: e.operation, target: e.target, status: e.status, id: e.id ?? null }));
  let next = "none";
  if (run?.status === "blocked") next = `resolve the blocker at ${current}, then \`asterweave run resume ${run.runId}\``;
  else if (run?.status === "completed") next = state.scope.level === "discovery" ? "review the findings and decide which work to authorize" : "review the contribution package; publishing needs authorization naming the action and target";
  else if (run?.status === "aborted") next = "none (aborted)";
  else if (current) next = `finish ${current}`;
  return {
    skill: state.skill,
    workflow: state.workflow,
    scope: state.scope.level,
    task: state.task ? state.task.title : null,
    stage: current,
    stagesPassed: `${passed}/${nodes.length}`,
    findings: { total: state.findings.length, ...counts, ledgerEvidence: ledgerFindings },
    verification: nodes.filter(([id]) => id === "test-verify" || id === "pr-review").map(([id, n]) => ({ stage: id, status: n.status })),
    remote,
    blocked,
    next,
  };
}
