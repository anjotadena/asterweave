// Approvals: pure functions over run state. Each returns `{run, events, ...}`: a NEW run and the ledger
// records that describe the change. Persisting them is the loop's job (loop.mjs commitRecords).
//
//   Approval = { id, kind: "plan" | "operation", scope: {operation, target}, artifact: string | null,
//                subjectHash, policyHash, revision: number | null, requestedAt,
//                nonceHash: string | null, nonceExpiresAt: string | null, failedAttempts: number, lastFailedAt: string | null,
//                by: {source: "tty" | "flag", name} | null, grantedAt: string | null, invalidatedAt: string | null }
//
// An approval is VALID only while it is granted, not invalidated, bound to the policy now in force, and (for
// an artifact approval) the artifact it covers still has the same hash and revision. A changed artifact
// invalidates every approval of it and of everything that depends on it, transitively.
//
// Approvals come ONLY from a person: the source of a grant is `tty` (an interactive y/N prompt on a real terminal)
// or `flag` (command-line flags that quote the subject hash shown by `run show` AND the one-time NONCE that only the
// supervising process printed on its own interactive terminal). Model output, repository files, MCP replies and image
// text can never be a source.
//
// NONCE MODEL (Phase D-b). When a request is created, the supervising process draws a random 128-bit nonce. Only its
// sha256 (`nonceHash`) is stored in the request (run.json / ledger); the plaintext is returned to the caller in memory
// (`requestApproval(...).nonce`), shown only on the supervisor's own stderr when that is a TTY, and never written to
// disk, a ledger event, a hook payload, a child's stdio or environment, or any JSON output. A headless supervisor prints
// nothing: such a request can only be approved in an interactive terminal (`run approve` with no flags). A flag grant
// needs `--nonce`, compared in constant time with the stored hash, single use (the grant clears the hash), valid for
// NONCE_TTL_MS, and locked for LOCK_MS after MAX_FAILED_ATTEMPTS wrong tries (the counter lives in the request record,
// as ledger events, so a restart does not reset it). A request created before this model (no `nonceHash`) can only be
// approved at the terminal prompt.
//
// WHAT THIS IS NOT. It is DEFENCE IN DEPTH, not a sandbox. A process that runs as the same OS user can read the
// user's files, may attach to the console on Windows (AttachConsole / CONOUT$), or simply impersonate the terminal;
// the environment markers checked by `agentContextMarker` (ASTERWEAVE_RUN_ID, ASTERWEAVE_SESSION_ID, CLAUDECODE,
// CLAUDE_CODE_*) are advisory because a child can unset them. Real isolation of dispatched processes needs OS-level
// sandboxing, which this package does not provide.
//
// WHAT YOU APPROVE IS WHAT YOU SEE. The subject hash binds the RAW scope target, so the loop only creates an
// approval request for a scope that displays faithfully (displayProblem): short enough to be shown whole, no
// control / invisible / direction-changing characters, and nothing that redaction would rewrite. Newlines, tabs,
// backslashes AND every non-ASCII character are shown as explicit escapes (displayTarget: \u{XXXX}), so two different
// targets never look the same (blank fillers, variation selectors, combining marks and Cyrillic look-alikes are visible).
// The escaped form may not exceed DISPLAY_ESCAPED_LIMIT (4 x DISPLAY_LIMIT) characters.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CliError, EXIT } from "../exit-codes.mjs";
import { redactText, sanitizeForTerminal } from "../redact.mjs";
import { canonicalJson } from "./graph.mjs";

export const APPROVAL_KINDS = Object.freeze(["plan", "operation"]);
export const GRANT_SOURCES = Object.freeze(["tty", "flag"]);
export const MIN_SUBJECT_PREFIX = 6;
const MAX_NAME = 200;
const MAX_OPERATION = 128;
const MAX_TARGET = 1_000_000;
/** The longest operation / target the prompt and `run show` display WHOLE; anything longer is never requested. */
export const DISPLAY_LIMIT = 2000;
/** Who asked for an approval: the executor (request-approval action), the guard, or a validate hook. */
export const REQUESTERS = Object.freeze(["executor", "guard", "hook"]);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\p{Zl}\p{Zp}]|[^\S ]/u;

/** How long an issued nonce can be used, how many wrong tries lock a request, and for how long. */
export const NONCE_TTL_MS = 60 * 60 * 1000;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MS = 10 * 60 * 1000;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** ISO time NONCE_TTL_MS after `now`; null when `now` is not a parseable time. */
function expiryFrom(now) {
  const ms = Date.parse(now);
  return Number.isFinite(ms) ? new Date(ms + NONCE_TTL_MS).toISOString() : null;
}

function fail(message, code, exitCode = EXIT.ERROR, remediation) {
  throw new CliError(message, { code, exitCode, remediation });
}

/** sha256 (hex) of the canonical JSON of a scope `{operation, target}`. Hash of the RAW scope, before any redaction. */
export function scopeHash(scope) {
  return sha256(canonicalJson({ operation: scope.operation, target: scope.target }));
}

/** The longest ESCAPED display of a scope member that is shown (four times DISPLAY_LIMIT: a longer one is never requested). */
export const DISPLAY_ESCAPED_LIMIT = 4 * DISPLAY_LIMIT;

/**
 * Text as shown to the person. Printable ASCII is literal; backslash, newline and tab are `\\`, `\n`, `\t`; EVERY other character
 * (control, invisible, combining, look-alike, any non-ASCII) is an explicit `\u{XXXX}` escape per code point. The mapping is
 * injective (a literal backslash is always doubled), so two different targets never display the same.
 */
export function displayTarget(text) {
  let out = "";
  for (const ch of String(text ?? "")) {
    const code = ch.codePointAt(0);
    if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else out += `\\u{${code.toString(16).toUpperCase().padStart(4, "0")}}`;
  }
  return out;
}

/**
 * Why a scope cannot be shown faithfully (null when it can). Checked on BOTH members of the scope.
 * @param {{operation: unknown, target: unknown}} scope
 * @returns {string | null}
 */
export function displayProblem(scope) {
  for (const name of ["operation", "target"]) {
    const value = scope?.[name];
    if (typeof value !== "string") return `the ${name} is not text`;
    if (value.length > DISPLAY_LIMIT) return `the ${name} is longer than ${DISPLAY_LIMIT} characters, so it cannot be shown whole`;
    const shown = value.replace(/[\n\t]/g, "");
    if (INVISIBLE.test(shown) || sanitizeForTerminal(shown) !== shown) return `the ${name} holds control, invisible or direction-changing characters`;
    if (displayTarget(value).length > DISPLAY_ESCAPED_LIMIT) return `the ${name} is longer than ${DISPLAY_ESCAPED_LIMIT} characters once every non-ASCII character is shown as an escape, so it cannot be shown whole`;
    if (redactText(value).text !== value) return `the ${name} holds text that would be redacted, so it would not match what is bound`;
  }
  return null;
}

/** The subject hash of an artifact: its content hash, or a stable digest of name+revision when it has none. */
export function artifactSubject(name, artifact) {
  return artifact.hash ?? sha256(`${name}@${artifact.revision}`);
}

function checkScope(scope) {
  if (!isObject(scope) || typeof scope.operation !== "string" || scope.operation === "" || scope.operation.length > MAX_OPERATION || typeof scope.target !== "string" || scope.target.length > MAX_TARGET) {
    fail("An approval scope needs an operation and a target string.", "APPROVAL_SCOPE_INVALID", EXIT.USAGE);
  }
  return { operation: scope.operation, target: scope.target };
}

// --- nonce -----------------------------------------------------------------------------------------

/**
 * A fresh nonce: 128 random bits as 32 lowercase hex characters in groups of eight (`1a2b3c4d-...`).
 * @param {(size: number) => Uint8Array} [rng]  Seam for tests; the default is crypto.randomBytes.
 */
export function generateNonce(rng = randomBytes) {
  const bytes = rng(16);
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new TypeError("the nonce source must return 16 bytes");
  return Buffer.from(bytes).toString("hex").replace(/(.{8})(?=.)/g, "$1-");
}

/** The form that is hashed: dashes and whitespace removed, lower case. `null` when it cannot be a nonce. */
export function normalizeNonce(value) {
  if (typeof value !== "string" || value.length > 64) return null;
  const text = value.replace(/[-\s]/g, "").toLowerCase();
  return /^[0-9a-f]{32}$/.test(text) ? text : null;
}

/** sha256 (hex) of the normalised nonce; `null` for a malformed one. */
export function nonceHashOf(value) {
  const text = normalizeNonce(value);
  return text === null ? null : sha256(text);
}

/** Names of the environment markers that say "this process is driven by a run or an agent" (values never read out). */
export function agentContextMarker(env = process.env) {
  if (!isObject(env)) return null;
  for (const name of ["ASTERWEAVE_RUN_ID", "ASTERWEAVE_SESSION_ID", "CLAUDECODE"]) {
    if (typeof env[name] === "string" && env[name] !== "") return name;
  }
  for (const [name, value] of Object.entries(env)) {
    if (/^CLAUDE_CODE_/i.test(name) && typeof value === "string" && value !== "") return name;
  }
  return null;
}

/** Throws (exit 7) when the environment shows the process is inside a run or an agent session. */
export function assertHumanContext(env, what = "Approvals") {
  const marker = agentContextMarker(env);
  if (marker !== null) {
    fail(`${what} cannot be granted from inside a run or an agent session (${marker} is set).`, "APPROVAL_FORBIDDEN_CONTEXT", EXIT.POLICY_DENIED, "Approve in a terminal of your own that is not driven by the run or by an agent.");
  }
}

/** Milliseconds since the epoch until which the request is locked after too many wrong nonces, or null. */
export function lockedUntil(approval, nowMs) {
  const failed = approval?.failedAttempts ?? 0;
  if (failed < MAX_FAILED_ATTEMPTS) return null;
  const until = Date.parse(approval.lastFailedAt ?? "") + LOCK_MS;
  return Number.isFinite(until) && nowMs < until ? until : null;
}

/** The ledger record for one wrong nonce (applyApprovalEvent counts it). */
export function failedAttemptEvent(approval, now) {
  return { type: "approval.attempt-failed", approvalId: approval.id, at: now };
}

/**
 * Replace the nonce of a pending request (a supervisor that restarted does not hold the old plaintext).
 * The wrong-try counter is NOT reset. Returns the plaintext in memory only. A TTY supervisor that does this INVALIDATES every nonce
 * it replaces (an earlier terminal's code stops working). A legacy request without a nonceHash field gets none (nonce: null).
 * @returns {{run: object, events: object[], nonce: string|null}}
 */
export function reissueNonce(run, id, { now, rng } = {}) {
  const approval = findApproval(run, id);
  if (!approval || approval.grantedAt !== null || approval.invalidatedAt !== null) fail("There is no pending approval to issue a nonce for.", "APPROVAL_NOT_FOUND");
  // A request created before the nonce model (no nonceHash field at all) is terminal-only for good: it never gets a nonce.
  if (!Object.hasOwn(approval, "nonceHash")) return { run, events: [], nonce: null };
  const nonce = generateNonce(rng);
  const event = { type: "approval.nonce-issued", approvalId: approval.id, nonceHash: nonceHashOf(nonce), nonceExpiresAt: expiryFrom(now), issuedAt: now };
  return { run: applyApprovalEvent(run, event), events: [event], nonce };
}

/** Approvals still waiting for a person: not granted and not invalidated. */
export function pendingApprovals(run) {
  return (run?.approvals ?? []).filter((approval) => approval.grantedAt === null && approval.invalidatedAt === null);
}

/** The subject hash that `run show` prints for an approval. */
export function approvalSubject(approval) {
  return approval.subjectHash;
}

/** Whether `prefix` (at least 6 hex characters, any case) is a prefix of the approval's subject hash. */
export function matchesSubject(approval, prefix) {
  if (typeof prefix !== "string") return false;
  const text = prefix.trim().toLowerCase();
  return /^[0-9a-f]+$/.test(text) && text.length >= MIN_SUBJECT_PREFIX && approvalSubject(approval).startsWith(text);
}

/** Look an approval up by id. */
export function findApproval(run, id) {
  return (run?.approvals ?? []).find((approval) => approval.id === id) ?? null;
}

/**
 * Whether `approval` currently counts. `policyHash` is the hash of the policy in force (omit it to skip that check).
 * @param {object} run @param {object} approval @param {string | null} [policyHash]
 */
export function isValid(run, approval, policyHash) {
  if (!isObject(approval) || approval.grantedAt == null || approval.invalidatedAt != null) return false;
  if (policyHash !== undefined && policyHash !== null && approval.policyHash !== policyHash) return false;
  if (approval.artifact != null) {
    const artifact = run?.artifacts?.[approval.artifact];
    if (!artifact || artifact.revision !== approval.revision || artifactSubject(approval.artifact, artifact) !== approval.subjectHash) return false;
  }
  return true;
}

/** Guard-context form of the valid operation approvals: `[{scope}]`. */
export function validScopedApprovals(run, policyHash) {
  return (run?.approvals ?? []).filter((approval) => approval.kind === "operation" && isValid(run, approval, policyHash)).map((approval) => ({ scope: approval.scope, subjectHash: approval.subjectHash }));
}

// --- applying records (shared by the live path and by crash-recovery folding) ---------------------------

/** Apply one `approval.*` ledger record to a run. Returns a NEW run; unknown or inconsistent records change nothing. */
export function applyApprovalEvent(run, event) {
  const next = structuredClone(run);
  next.approvals ??= [];
  if (event.type === "approval.requested") {
    if (isObject(event.approval) && !next.approvals.some((approval) => approval.id === event.approval.id)) next.approvals.push(structuredClone(event.approval));
  } else if (event.type === "approval.granted") {
    const approval = next.approvals.find((entry) => entry.id === event.approvalId);
    if (approval && approval.grantedAt === null) {
      approval.by = structuredClone(event.by);
      approval.grantedAt = event.grantedAt;
      // A nonce is single use: once the request is granted nothing can be checked against it again.
      if (Object.hasOwn(approval, "nonceHash")) {
        approval.nonceHash = null;
        approval.nonceExpiresAt = null;
      }
    }
  } else if (event.type === "approval.nonce-issued") {
    const approval = next.approvals.find((entry) => entry.id === event.approvalId);
    if (approval && approval.grantedAt === null && approval.invalidatedAt === null && /^[0-9a-f]{64}$/.test(String(event.nonceHash))) {
      approval.nonceHash = event.nonceHash;
      approval.nonceExpiresAt = typeof event.nonceExpiresAt === "string" ? event.nonceExpiresAt : null;
    }
  } else if (event.type === "approval.attempt-failed") {
    const approval = next.approvals.find((entry) => entry.id === event.approvalId);
    if (approval && typeof event.at === "string") {
      const expired = (approval.failedAttempts ?? 0) >= MAX_FAILED_ATTEMPTS && lockedUntil(approval, Date.parse(event.at)) === null;
      approval.failedAttempts = (expired ? 0 : (approval.failedAttempts ?? 0)) + 1;
      approval.lastFailedAt = event.at;
    }
  } else if (event.type === "approval.invalidated") {
    const approval = next.approvals.find((entry) => entry.id === event.approvalId);
    if (approval && approval.invalidatedAt === null) approval.invalidatedAt = event.invalidatedAt;
  }
  return next;
}

/**
 * Ask for an approval. Idempotent: an identical open or granted request (same kind, scope, subject) is returned
 * as it is, with `created: false` and no event.
 *
 * @param {object} run
 * @param {{kind: "plan"|"operation", scope: {operation: string, target: string}, now: string, artifact?: string|null,
 *   subjectHash?: string, reason?: string}} options  `plan` approvals name the `artifact` they cover (its current
 *   hash and revision are bound); `operation` approvals are bound to the hash of their scope. `requestedBy`
 *   (executor | guard | hook) is recorded on the approval and shown next to it. `rng(size)` is a test seam for the nonce.
 * @returns {{run: object, events: object[], approval: object, created: boolean, nonce: string | null}}
 *   `nonce` is the plaintext one-time nonce of a NEW request (null when the request already existed). It is returned in
 *   memory only for the supervisor to show on its own terminal; the record and the event hold only its hash.
 */
export function requestApproval(run, { kind, scope, now, artifact = null, subjectHash, reason, requestedBy, rng, issueNonce = true } = {}) {
  if (!APPROVAL_KINDS.includes(kind)) fail("Unknown approval kind.", "APPROVAL_KIND_INVALID", EXIT.USAGE);
  if (requestedBy !== undefined && !REQUESTERS.includes(requestedBy)) fail("Unknown approval requester.", "APPROVAL_REQUESTER_INVALID", EXIT.USAGE);
  const cleanScope = checkScope(scope);
  if (typeof now !== "string" || now === "") fail("An approval request needs a timestamp.", "APPROVAL_TIME_REQUIRED", EXIT.USAGE);
  let revision = null;
  let subject = subjectHash;
  let artifactName = null;
  if (kind === "plan" && artifact !== null && artifact !== undefined) {
    const current = run.artifacts?.[artifact];
    if (!current) fail(`There is no ${String(artifact).slice(0, 40)} artifact to approve yet.`, "APPROVAL_NO_SUBJECT");
    artifactName = artifact;
    revision = current.revision;
    subject = artifactSubject(artifact, current);
  } else if (subject === undefined) {
    subject = scopeHash(cleanScope);
  }
  const existing = (run.approvals ?? []).find(
    (approval) =>
      approval.kind === kind &&
      approval.invalidatedAt === null &&
      approval.subjectHash === subject &&
      approval.scope.operation === cleanScope.operation &&
      approval.artifact === artifactName &&
      approval.revision === revision &&
      approval.policyHash === (run.policyHash ?? null),
  );
  if (existing) return { run, events: [], approval: existing, created: false, nonce: null };
  // A headless supervisor (no terminal to show a nonce on) passes issueNonce: false: nothing is stored, so a flag grant is refused
  // with APPROVAL_TERMINAL_REQUIRED and only the terminal prompt can approve.
  const nonce = issueNonce ? generateNonce(rng) : null;
  const approval = {
    id: `ap-${(run.approvals ?? []).length + 1}`,
    kind,
    scope: cleanScope,
    artifact: artifactName,
    subjectHash: subject,
    policyHash: run.policyHash ?? null,
    revision,
    requestedAt: now,
    requestedBy: requestedBy ?? null,
    nonceHash: nonce === null ? null : nonceHashOf(nonce),
    nonceExpiresAt: nonce === null ? null : expiryFrom(now),
    failedAttempts: 0,
    lastFailedAt: null,
    by: null,
    grantedAt: null,
    invalidatedAt: null,
  };
  const event = { type: "approval.requested", approval, ...(reason ? { reason: String(reason).slice(0, 500) } : {}) };
  return { run: applyApprovalEvent(run, event), events: [event], approval, created: true, nonce };
}

const TERMINAL_HINT = "Approve in a terminal: run `asterweave run approve <runId>` with no flags and answer the prompt.";

/**
 * The nonce gate of a flag grant. Throws APPROVAL_TERMINAL_REQUIRED (exit 2: no nonce was ever issued to a person, or none
 * was quoted), APPROVAL_LOCKED / APPROVAL_NONCE_INVALID (exit 7; the latter is the one the caller counts), or
 * APPROVAL_NONCE_EXPIRED.
 */
function checkNonce(approval, nonce, now) {
  const stored = approval.nonceHash;
  if (typeof stored !== "string" || !/^[0-9a-f]{64}$/.test(stored)) {
    fail(`Approval ${approval.id} cannot be granted with flags: no nonce is outstanding for it.`, "APPROVAL_TERMINAL_REQUIRED", EXIT.USAGE, TERMINAL_HINT);
  }
  if (nonce === undefined || nonce === null || nonce === "") {
    fail(`Approval ${approval.id} needs --nonce, the one-time code the supervising process printed on its own terminal.`, "APPROVAL_TERMINAL_REQUIRED", EXIT.USAGE, TERMINAL_HINT);
  }
  const nowMs = Date.parse(now);
  const until = lockedUntil(approval, nowMs);
  if (until !== null) {
    fail(`Approval ${approval.id} is locked after ${MAX_FAILED_ATTEMPTS} wrong nonces.`, "APPROVAL_LOCKED", EXIT.POLICY_DENIED, `${TERMINAL_HINT} The flag path unlocks at ${new Date(until).toISOString()}.`);
  }
  if (Number.isFinite(nowMs) && typeof approval.nonceExpiresAt === "string" && Date.parse(approval.nonceExpiresAt) <= nowMs) {
    fail(`The nonce of approval ${approval.id} expired.`, "APPROVAL_NONCE_EXPIRED", EXIT.ERROR, TERMINAL_HINT);
  }
  const given = nonceHashOf(nonce);
  const match = given !== null && timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(stored, "hex"));
  if (!match) {
    fail(`The nonce does not match approval ${approval.id}.`, "APPROVAL_NONCE_INVALID", EXIT.POLICY_DENIED, TERMINAL_HINT);
  }
}

/**
 * Record that a person granted an approval.
 *
 * @param {object} run
 * @param {string} id
 * @param {{by: {source: "tty"|"flag", name: string}, now: string, subject?: string, policyHash?: string|null,
 *   env?: Record<string, string|undefined>}} options
 *   `subject` is the hash prefix quoted from `run show`; it is REQUIRED for the `flag` source, together with `nonce`
 *   (the one-time code from the supervisor's terminal; see the NONCE MODEL above). A `tty` grant needs neither: the CLI
 *   only uses that source after a real interactive prompt. Any agent marker in `env` refuses the grant (exit 7).
 *   `policyHash`, when given, must be the policy still in force.
 * @returns {{run: object, events: object[], approval: object}}
 * @throws {CliError}
 */
export function grantApproval(run, id, { by, now, subject, nonce, policyHash, env = process.env } = {}) {
  assertHumanContext(env);
  if (!isObject(by) || !GRANT_SOURCES.includes(by.source)) {
    fail("An approval can only be granted from a terminal prompt (tty) or an explicit command-line flag (flag).", "APPROVAL_SOURCE_INVALID", EXIT.USAGE);
  }
  if (typeof by.name !== "string" || by.name.trim() === "" || by.name.length > MAX_NAME) fail("An approval needs the name of the person granting it.", "APPROVAL_NAME_REQUIRED", EXIT.USAGE);
  const approval = findApproval(run, id);
  if (!approval) fail(`There is no approval ${sanitizeForTerminal(String(id)).slice(0, 40)}.`, "APPROVAL_NOT_FOUND");
  if (approval.invalidatedAt !== null) fail(`Approval ${approval.id} was invalidated and cannot be granted; request it again.`, "APPROVAL_INVALIDATED");
  if (approval.grantedAt !== null) fail(`Approval ${approval.id} was already granted.`, "APPROVAL_ALREADY_GRANTED");
  if (policyHash !== undefined && policyHash !== null) {
    // A policy-change ("resume") approval is requested under the OLD policy and accepts the NEW one named in its target.
    const expected = approval.kind === "operation" && approval.scope.operation === "resume" ? String(approval.scope.target).split("->")[1] : approval.policyHash;
    if (expected !== policyHash) fail(`Approval ${approval.id} was requested under a different policy.`, "APPROVAL_STALE", EXIT.ERROR, "Resume the run so it asks again under the current policy.");
  }
  if (approval.kind === "operation" && approval.artifact === null && approval.subjectHash !== scopeHash(approval.scope)) {
    fail(`Approval ${approval.id} no longer matches what was bound when it was requested; it cannot be granted.`, "APPROVAL_SCOPE_MISMATCH", EXIT.ERROR, "Run `asterweave run show` and ask again.");
  }
  if (approval.kind === "operation" && displayProblem(approval.scope) !== null) {
    fail(`Approval ${approval.id} covers a scope that cannot be shown faithfully; it cannot be granted.`, "UNDISPLAYABLE_TARGET", EXIT.ERROR, "Nothing was approved; the request can only be refused.");
  }
  if (approval.artifact !== null) {
    const current = run.artifacts?.[approval.artifact];
    if (!current || current.revision !== approval.revision || artifactSubject(approval.artifact, current) !== approval.subjectHash) {
      fail(`Approval ${approval.id} covers a ${approval.artifact} revision that is no longer current.`, "APPROVAL_STALE");
    }
  }
  if (by.source === "flag" && !matchesSubject(approval, subject)) {
    fail(`The subject does not match approval ${approval.id}; quote at least ${MIN_SUBJECT_PREFIX} hex characters of the subject hash from \`run show\`.`, "APPROVAL_SUBJECT_MISMATCH", EXIT.USAGE);
  }
  if (by.source === "flag") checkNonce(approval, nonce, now);
  const name = redactText(sanitizeForTerminal(by.name.trim())).text;
  const event = { type: "approval.granted", approvalId: approval.id, kind: approval.kind, scope: approval.scope, subjectHash: approval.subjectHash, by: { source: by.source, name }, grantedAt: now };
  return { run: applyApprovalEvent(run, event), events: [event], approval: findApproval(applyApprovalEvent(run, event), approval.id) };
}

/** Names of `artifactName` and of every artifact that depends on it, directly or through others. */
export function dependentArtifacts(run, artifactName) {
  const affected = new Set([artifactName]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, artifact] of Object.entries(run.artifacts ?? {})) {
      if (!affected.has(name) && (artifact.dependsOn ?? []).some((dependency) => affected.has(dependency))) {
        affected.add(name);
        grew = true;
      }
    }
  }
  return affected;
}

/**
 * The artifact `artifactName` changed: mark invalidated every not-yet-invalidated approval of it and of
 * everything depending on it (transitively through `run.artifacts[].dependsOn`).
 * @returns {{run: object, events: object[]}}
 */
export function invalidateDependents(run, artifactName, { now, cause = "artifact-changed" } = {}) {
  if (typeof now !== "string" || now === "") fail("Invalidation needs a timestamp.", "APPROVAL_TIME_REQUIRED", EXIT.USAGE);
  const affected = dependentArtifacts(run, artifactName);
  let next = run;
  const events = [];
  for (const approval of run.approvals ?? []) {
    if (approval.invalidatedAt !== null || approval.artifact === null || !affected.has(approval.artifact)) continue;
    const event = { type: "approval.invalidated", approvalId: approval.id, artifact: approval.artifact, cause: `${cause}:${artifactName}`.slice(0, 200), invalidatedAt: now };
    next = applyApprovalEvent(next, event);
    events.push(event);
  }
  return { run: next, events };
}

/** Invalidate one approval explicitly (e.g. a policy change made it stale). */
export function invalidateApproval(run, id, { now, cause }) {
  const approval = findApproval(run, id);
  if (!approval || approval.invalidatedAt !== null) return { run, events: [] };
  const event = { type: "approval.invalidated", approvalId: id, artifact: approval.artifact, cause: String(cause ?? "invalidated").slice(0, 200), invalidatedAt: now };
  return { run: applyApprovalEvent(run, event), events: [event] };
}
