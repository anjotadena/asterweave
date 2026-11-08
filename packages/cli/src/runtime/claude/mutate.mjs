// The mutation envelope: EVERY `claude mcp|plugin ...` change made through Asterweave goes through `applyMutation`.
//
//   1. refuse inside an agent context (env markers: exit 7, exactly like `run approve`);
//   2. build and show the exact claude command (redacted) and the files that may change;
//   3. confirm: an interactive y/N on a terminal, or --yes. --json and a non-terminal NEVER prompt: they need --yes (exit 2);
//   4. snapshot BEFORE (caller-supplied `snapshot()` between two trust-hash reads that must agree, else nothing runs), run claude (SIGINT/SIGTERM kill its tree, exit 130) through runClaudeAdmin, snapshot AFTER;
//   5. verify (caller-supplied `verify(before, after)`): the change must be exactly the intended one. Anything else is
//      UNEXPECTED_CHANGE (exit 1): trust is NOT granted, nothing is reverted, the user is told to review with `git diff`;
//   6. trust-after-mutation: a repo-scope change alters the trust hash, so the repository is UNTRUSTED afterwards (exit 4 until it is
//      re-granted with `asterweave trust grant`). `--trust` re-grants ONLY when the repository was trusted immediately before
//      (otherwise the grant would also bless unrelated unreviewed config), the diff was verified exactly, the files are unchanged since
//      the verification, and a person confirmed (prompt, or --yes). The grant is bound to the verified hash (expectedHash).
//      A global-scope change never touches repository trust, and if it did (the repository hash moved) it is UNEXPECTED_CHANGE.
//
// Request (`applyMutation(request)`; `previewMutation(request)` builds the shown text only):
//   ctx         the command context (env, stdin/stdout, spawn, signal, platform, exists, fs, homedir, now; `ctx.claude` = admin runner seams
//               {claudePath, claudeArgs, claudeVersion, timeoutMs, killTree} used by tests)
//   kind, action, scope ("global"|"repo"), id (server name / plugin id; display only)
//   args        argv after the claude binary (validated again by runClaudeAdmin / parseAdminArgs)
//   repoRoot    absolute repository root: REQUIRED for scope "repo"; optional for "global" (then its trust hash must not move)
//   snapshot(governing)  sync or async; returns the state to compare; called before and after (and again right before a trust grant). For a request
//               with a repoRoot it receives {".mcp.json": text|null, ...} for the four trust-governing files: the bytes that were hashed. It MUST compare
//               those, not re-read them from disk (a write-then-revert between the hash and a second read would otherwise go unseen)
//   verify(before, after) -> {ok: boolean, problems: string[]}  pure
//   changedLabels(before, after) -> string[]  optional: labels (e.g. "~/.claude.json") of the files that differ between two snapshots; without it a global
//               change cannot name what changed, and says so
//   expectedFiles[]  repo scope: the trust-governing files this change may touch (default .mcp.json for mcp, .claude/settings.json for plugin); any other changed file is UNEXPECTED_CHANGE
//   warnings[], summary[], files[] (labels shown as "may change")  display lines
//   yes, trust, json  booleans
// Result: {ok: true, exitCode: 0|4, command, verified: true, changedFiles: string[], trust: {state, remediation?}, claude: {exitCode, stdout, stderr}}.
// Throws CliError: 7 agent context · 2 needs --yes / bad request · 1 UNEXPECTED_CHANGE | CLAUDE_ADMIN_FAILED | MUTATION_DECLINED | 130 interrupted.

import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../../exit-codes.mjs";
import { redactText, sanitizeForTerminal, sanitizeLines, suggestCommand } from "../../redact.mjs";
import { computeTrustHash, grantTrust, safeTrustStatus, TRUST_FILES } from "../../trust.mjs";
import { askYesNo, withTerminal } from "../../tui/session.mjs";
import { createTerminal } from "../../tui/terminal.mjs";
import { assertHumanContext } from "../approvals.mjs";
import { interruptSignal } from "../../commands/shared.mjs";
import { assertSupportedEnvironment, displayCommand, parseAdminArgs, runClaudeAdmin } from "./admin.mjs";

const safe = (text, limit = 300) => redactText(sanitizeForTerminal(String(text ?? ""))).text.slice(0, limit);
const write = (stream, text) => stream.write(text);
const isFunction = (value) => typeof value === "function";

function trustOptions(ctx) {
  const out = { env: ctx.env };
  for (const key of ["platform", "homedir", "fs", "now"]) if (ctx[key] !== undefined) out[key] = ctx[key];
  return out;
}

/**
 * ONE read of every trust-governing file: the bytes, their utf8 text (null = missing, "\u0000unreadable" = unreadable) and a digest of each.
 * The text is what `snapshot` receives, so the state that is compared is the state that was hashed, never a second read of the disk.
 */
function readGoverning(repoRoot, fs) {
  const texts = {};
  const digests = {};
  for (const relative of TRUST_FILES) {
    try {
      const bytes = fs.readFileSync(path.join(repoRoot, ...relative.split("/")));
      texts[relative] = Buffer.from(bytes).toString("utf8");
      digests[relative] = createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
      texts[relative] = missing ? null : "\u0000unreadable";
      digests[relative] = missing ? "missing" : "unreadable";
    }
  }
  return { texts, digests };
}

const sameDigests = (x, y) => TRUST_FILES.every((relative) => x[relative] === y[relative]);

const changedBetween = (before, after) => TRUST_FILES.filter((relative) => before[relative] !== after[relative]);

/** The text a person reviews before anything runs. Pure. @returns {{command: string, lines: string[]}} */
export function previewMutation(request) {
  const command = displayCommand(request.args);
  const repo = request.scope === "repo";
  const lines = [
    ...(request.summary ?? []).map((line) => safe(line, 400)),
    ...(request.warnings ?? []).map((line) => `WARNING: ${safe(line, 500)}`),
    `command: ${command}`,
    repo ? `runs in: the repository root ${safe(request.repoRoot, 300)}` : "runs in: a new empty temporary directory (not the repository)",
    `files that may change: ${(request.files ?? (repo ? TRUST_FILES.filter((file) => file !== ".claude/asterweave.json") : ["your user-level Claude files"])).map((file) => safe(file, 120)).join(", ")}`,
    repo
      ? request.trust === true
        ? "trust: the repository becomes untrusted by this change; --trust re-grants it only if it was trusted before and the result is verified as exactly this change."
        : "trust: the repository becomes untrusted by this change; review it, then run `asterweave trust grant` (or repeat with --trust)."
      : "trust: not affected (global scope)",
  ];
  return { command, lines };
}

async function confirm(ctx, lines) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(`${sanitizeLines(lines)} `);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

function unexpected(problems, { repo, files }) {
  const list = problems.map((problem) => safe(problem, 200)).slice(0, 8).join("; ");
  return new CliError(`UNEXPECTED_CHANGE: ${list || "the result is not exactly the intended change"}.${files.length > 0 ? ` Files that changed: ${files.join(", ")}.` : ""}`, {
    code: "UNEXPECTED_CHANGE",
    exitCode: EXIT.ERROR,
    remediation: `Nothing was reverted and trust was NOT granted${repo ? " (the repository stays untrusted)" : ""}. ${repo ? "Review what changed with `git diff`" : "Review the file(s) named above (Asterweave keeps no backup of them)"}, undo what you do not want${repo ? ", then run `asterweave trust grant` yourself if appropriate" : ""}.`,
  });
}

/** Which files changed, worded for the scope; says so when Asterweave cannot tell (a global change without a label function). */
function changedText(files, { repo, known }) {
  if (files.length > 0) return `Files changed: ${files.join(", ")}.`;
  return known ? "No file changed." : "Asterweave could not tell whether any file changed; check the files this command may change.";
}

/** The files a repo-scope change of this kind is expected to touch (anything else in the trust set is UNEXPECTED_CHANGE). */
const defaultTargets = (request) => request.expectedFiles ?? (request.kind === "plugin" ? [".claude/settings.json"] : [".mcp.json"]);

/** @returns {Promise<object>} see the header */
export async function applyMutation(request) {
  const { ctx, scope, args } = request;
  if (!ctx || (scope !== "global" && scope !== "repo") || !Array.isArray(args) || !isFunction(request.snapshot) || !isFunction(request.verify)) throw new UsageError("applyMutation needs ctx, a scope, args, snapshot and verify.");
  assertHumanContext(ctx.env, `${request.kind === "plugin" ? "Plugin" : "MCP"} changes`);
  parseAdminArgs(args, scope); // refuse a forbidden shape (local scope, list/get, unknown flags) before anything is shown or run
  assertSupportedEnvironment(scope, ctx.env, ctx.platform);
  const repo = scope === "repo";
  const fs = ctx.fs ?? nodeFs;
  const options = trustOptions(ctx);
  if (repo && (typeof request.repoRoot !== "string" || request.repoRoot === "")) throw new UsageError("A repo-scope change needs the repository root.");
  if (request.trust === true && !repo) throw new UsageError("--trust applies to --scope repo only (a global change does not touch repository trust).");
  const { command, lines } = previewMutation(request);
  const interactive = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env }).isInteractive && request.json !== true;
  if (request.yes !== true && !interactive) {
    throw new UsageError(`This change needs --yes when it is not run in an interactive terminal (or with --json). Command: ${command}`, { remediation: "Review the command above, then repeat with --yes. Nothing was changed." });
  }

  // 1. preview and confirmation
  if (request.json !== true) write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  if (request.yes !== true) {
    const answer = await confirm(ctx, ["Run it? [y/N]"]);
    if (answer.interrupted) throw new CliError("Interrupted; nothing was changed.", { code: "INTERRUPTED", exitCode: EXIT.INTERRUPTED });
    if (answer.yes !== true) throw new CliError("Not confirmed; nothing was changed.", { code: "MUTATION_DECLINED", exitCode: EXIT.ERROR, remediation: "Nothing was changed." });
  }

  // 2. before. Read A, hash, read R (the bytes handed to snapshot), hash, read B: all three reads and both hashes must agree, and agree with the
  //    trust decision, otherwise a write (or a write-then-revert) landed in the window and nothing is run. `snapshot(governing)` receives the
  //    bytes of R, so the "before" state is exactly what was hashed. The digests are checked once more immediately before claude is spawned.
  const stableRead = async () => {
    if (!request.repoRoot) return { state: await request.snapshot(), hash: null, steady: true, digests: {} };
    const first = readGoverning(request.repoRoot, fs);
    const hash1 = computeTrustHash(request.repoRoot, options).hash;
    const read = readGoverning(request.repoRoot, fs);
    const state = await request.snapshot(read.texts);
    const hash2 = computeTrustHash(request.repoRoot, options).hash;
    const last = readGoverning(request.repoRoot, fs);
    return { state, hash: hash2, steady: hash1 === hash2 && sameDigests(first.digests, read.digests) && sameDigests(read.digests, last.digests), digests: read.digests };
  };
  const trustBefore = request.repoRoot ? safeTrustStatus(request.repoRoot, options) : null;
  const beforeRead = await stableRead();
  const before = beforeRead.state;
  const digestsBefore = beforeRead.digests;
  const hashBefore = trustBefore?.hash ?? null;
  if (trustBefore !== null && (!beforeRead.steady || beforeRead.hash !== hashBefore || !sameDigests(readGoverning(request.repoRoot, fs).digests, digestsBefore))) {
    throw unexpected(["a governing file changed while the change was being prepared, so nothing was run"], { repo, files: changedBetween(digestsBefore, readGoverning(request.repoRoot, fs).digests) });
  }

  // 3. run claude (the admin runner re-validates the argv and picks the working directory). A SIGINT/SIGTERM aborts it and kills its tree.
  const seam = { ...(ctx.claude ?? {}) };
  for (const key of ["spawn", "env", "platform", "exists"]) if (ctx[key] !== undefined) seam[key] = ctx[key];
  const interrupt = interruptSignal(ctx);
  let result;
  try {
    result = await runClaudeAdmin({ ...seam, args, scope, signal: interrupt.signal, ...(repo ? { cwd: request.repoRoot } : {}) });
  } finally {
    interrupt.dispose();
  }

  // 4. after: the same triple-read and double hash; a file that moved in between is not verified
  const after = await stableRead();
  const trustChanged = changedBetween(digestsBefore, after.digests);
  const labelled = isFunction(request.changedLabels) ? [...request.changedLabels(before, after.state)].map(String) : [];
  const changedFiles = [...new Set([...trustChanged, ...labelled])];
  const known = repo || isFunction(request.changedLabels);
  const verdict = request.verify(before, after.state);
  const problems = [...(verdict.problems ?? [])];
  if (!after.steady) problems.push("a governing file changed while the result was being verified");
  if (!repo && hashBefore !== null && after.hash !== hashBefore) problems.push("a global change must not touch the repository, but its trust-governing files changed");
  if (repo) {
    const targets = defaultTargets(request);
    const outside = trustChanged.filter((file) => !targets.includes(file));
    if (outside.length > 0) problems.push(`files outside the expected target changed: ${outside.join(", ")}`);
  }

  if (!result.ok) {
    const where = changedText(changedFiles, { repo, known });
    if (result.killed && !result.timedOut) {
      throw new CliError(`Interrupted: claude was stopped before it finished. ${where}${repo && changedFiles.length > 0 ? " The repository is untrusted until you review it." : ""}`, {
        code: "INTERRUPTED", exitCode: EXIT.INTERRUPTED,
        remediation: `${repo ? "Review the result with `git diff`, then run `asterweave trust grant`" : "Review the file(s) named above"}; trust was NOT granted and nothing was reverted.`,
      });
    }
    const detail = result.timedOut ? "claude did not finish in time" : `claude exited with ${result.exitCode}`;
    throw new CliError(`${detail}: ${safe(result.stderr || result.stdout, 300)} ${where}`, {
      code: "CLAUDE_ADMIN_FAILED", exitCode: EXIT.ERROR,
      remediation: changedFiles.length > 0 || !known ? `${repo ? "Review the result with `git diff`" : "Review the file(s) named above"}; trust was NOT granted.` : "Nothing was changed.",
    });
  }
  if (problems.length > 0 || verdict.ok !== true) throw unexpected(problems, { repo, files: changedFiles });

  // 5. trust
  const claude = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  const base = { ok: true, command, verified: true, changedFiles, claude };
  if (!repo) return { ...base, exitCode: EXIT.OK, trust: { state: "not applicable" } };
  const grantCommand = suggestCommand("asterweave trust grant --path ", request.repoRoot);
  if (trustBefore.trusted && after.hash === trustBefore.hash) return { ...base, exitCode: EXIT.OK, trust: { state: "trusted" } };
  const untrusted = (why) => ({ ...base, exitCode: EXIT.TRUST, trust: { state: "untrusted", remediation: `${why} Review the change (git diff), then run: ${grantCommand}` } });
  if (request.trust !== true) return untrusted("The repository is now untrusted because its governing files changed.");
  if (!trustBefore.trusted) return untrusted("--trust was not applied: the repository was not trusted before this change, and re-granting would also bless config you have not reviewed.");
  if (request.yes !== true) {
    const answer = await confirm(ctx, [`The change was verified as exactly the intended one. Trust ${safe(request.repoRoot, 200)} again, bound to the result? [y/N]`]);
    if (answer.interrupted) throw new CliError("Interrupted; the repository stays untrusted.", { code: "INTERRUPTED", exitCode: EXIT.INTERRUPTED });
    if (answer.yes !== true) return untrusted("Trust was not re-granted.");
  }
  // Re-verify right before the grant: nothing may have moved since the verified snapshot (a prompt can take time).
  const again = await stableRead();
  const recheck = request.verify(before, again.state);
  if (!again.steady || recheck.ok !== true || again.hash !== after.hash) throw unexpected(["the files changed after the result was verified, so trust was not re-granted"], { repo, files: changedFiles });
  grantTrust(request.repoRoot, { ...options, expectedHash: after.hash });
  return { ...base, exitCode: EXIT.OK, trust: { state: "trusted" } };
}
