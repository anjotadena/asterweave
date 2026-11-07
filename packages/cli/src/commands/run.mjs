// `asterweave run show|approve|abort` and the hidden development subcommands `run start|resume`.
//
// PUBLIC (listed in help):
//   run show [runId] [--json]                                   what a run is doing (default: the newest run of this repository)
//   run approve <runId> --approval <id> --subject <hash> [--json]   record an approval (flags), or answer y/N on a terminal
//   run abort <runId> [--yes] [--json]                          stop a run for good (idempotent)
//
// HIDDEN (accepted only when ASTERWEAVE_DEV_EXECUTORS=1, otherwise exit 2 "not available"):
//   run start  --executor fake --script <file> [--graph delivery@1|bugfix@1] [--goal text] [--run-id id]
//   run resume <runId> --executor fake --script <file>
// They drive the loop with the scripted fake executor and a SIMULATED tool dispatcher: no tool is carried out (hooks
// and the read-only git queries of resolveRepo do spawn processes). `resume` takes the script again because the
// ledger does not store it.
//
// Approvals come only from a person: the TTY prompt or the explicit flags (`--approval` + `--subject`, the
// hash prefix that `run show` prints). Nothing is ever read from a file in the repository, and the command
// refuses to run when ASTERWEAVE_RUN_ID is set (it would be a process inside a run granting itself approval).
// THAT REFUSAL IS ADVISORY: a child process can unset the variable. It is acceptable only because Phase B carries
// out simulated tools; a real dispatcher MUST NOT ship before approvals have a non-forgeable path (a per-request
// nonce shown only on an interactive terminal with only its hash stored, or terminal-only grants) and OS-level
// isolation. As a cheap hardening, `run show` hides the approval subject hashes when ASTERWEAVE_RUN_ID is set.
// Every write takes the per-run lock; a person is prompted BEFORE the lock is taken (no heartbeat is running
// while a human thinks) and the grant is bound to the subject that was shown. Several approvals are granted
// all-or-nothing: all are validated first, then written.

import * as nodeFs from "node:fs";
import { userInfo } from "node:os";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { runBinary } from "../proc.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { gitEnv } from "../repo.mjs";
import { resolveUserDir } from "../paths.mjs";
import { DISPLAY_LIMIT, displayProblem, displayTarget, findApproval, grantApproval, isValid, pendingApprovals } from "../runtime/approvals.mjs";
import { simulatedDispatcher } from "../runtime/executor.mjs";
import { createFakeExecutor, loadScript } from "../runtime/fake-executor.mjs";
import { GraphError, getGraph, graphHash } from "../runtime/graph.mjs";
import "../runtime/graphs/index.mjs";
import { loadHooks } from "../runtime/hooks.mjs";
import { isValidRunId, listRuns, loadRun, repairTail, runDir } from "../runtime/ledger.mjs";
import { commitRecords, commitTransition, completeInterruptedGroup, createRunForGraph, foldEvents, runLoop } from "../runtime/loop.mjs";
import { acquireRunLock, inspectRunLock } from "../runtime/lock.mjs";
import { DEFAULT_BUDGETS, loadPolicy, resolveBudgets } from "../runtime/policy.mjs";
import { worktreeRootProblem } from "../runtime/repo-root.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { isInteractive, seams, stringOption } from "./shared.mjs";

export const runCommandMeta = Object.freeze({
  summary: "Show, approve or abort a run",
  boolean: ["json", "yes"],
  // The union over every subcommand (including the hidden ones); each subcommand narrows it below.
  options: ["json", "yes", "approval", "subject", "executor", "script", "graph", "goal", "run-id"],
});

const PUBLIC_USAGE = "Usage: asterweave run show [runId] [--json] | run approve <runId> --approval <id> --subject <hash> | run abort <runId> [--yes]";
const SUBJECT_SHOWN = 12;
const GOAL_LINE = 400;
const HIDDEN_SUBJECT = "hidden inside a run";
const GOAL_MAX = 2000;
const DEV_ENV = "ASTERWEAVE_DEV_EXECUTORS";

const FLAGS = {
  show: ["json"],
  approve: ["json", "approval", "subject"],
  abort: ["json", "yes"],
  start: ["json", "executor", "script", "graph", "goal", "run-id"],
  resume: ["json", "executor", "script"],
};
const HIDDEN = new Set(["start", "resume"]);

const write = (stream, text) => stream.write(text);
const isoNow = () => new Date().toISOString();
const clip = (text, limit) => {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
};
const prefix = (hash) => String(hash ?? "").slice(0, SUBJECT_SHOWN);

// ---------------------------------------------------------------------------------------------
// Repository identity
// ---------------------------------------------------------------------------------------------

// The hardened git flags of src/repo.mjs (copied, not shared: that module keeps them private). Only plain
// read-only plumbing is run (rev-parse, symbolic-ref): no content hashing, no hooks, no pager.
function gitFlags(platform) {
  return ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand="];
}

async function git(ctx, cwd, args) {
  const result = await runBinary("git", [...gitFlags(ctx.platform ?? process.platform), ...args], {
    cwd,
    env: gitEnv(ctx.env),
    spawn: ctx.spawn,
    exists: ctx.exists,
    platform: ctx.platform,
    timeoutMs: ctx.timeoutMs ?? 15_000,
  });
  return result.error || result.code !== 0 ? null : result.stdout;
}

function realpath(file, fs) {
  try {
    return (fs ?? nodeFs).realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * The repository a run belongs to. `key` is the realpath of the git common directory (lower-cased on win32), so
 * every work tree of one clone shares its runs; outside a git repository it is the realpath of the directory.
 * `workspace` is the work tree root (the guard's workspace root).
 * @returns {Promise<{key: string, workspace: string, git: boolean}>}
 */
export async function resolveRepo(ctx) {
  const platform = ctx.platform ?? process.platform;
  const fold = (value) => (platform === "win32" ? value.toLowerCase() : value);
  const cwd = realpath(path.resolve(ctx.cwd ?? process.cwd()), ctx.fs);
  const out = await git(ctx, cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"]);
  const lines = out === null ? [] : out.split(/\r?\n/).filter((line) => line !== "");
  if (lines.length >= 2) {
    const commonDir = realpath(lines[0], ctx.fs);
    const workspace = realpath(lines[1], ctx.fs);
    // core.worktree in a hostile .git/config can make git report a PARENT directory as the work tree, which would
    // widen the guard's workspace root: only a root that is consistent with the repository itself is trusted.
    const problem = worktreeRootProblem({ cwd, toplevel: workspace, commonDir, platform, fs: ctx.fs });
    if (problem !== null) {
      throw new CliError(`This repository's work tree is not what git reports: ${problem}.`, {
        code: "REPO_WORKTREE_MISMATCH",
        exitCode: EXIT.ERROR,
        remediation: "Check `core.worktree` in the repository's .git/config (a repository from an untrusted source can set it to a parent directory) and remove it, or run from a clean clone.",
      });
    }
    return { key: fold(commonDir), workspace, git: true };
  }
  return { key: fold(cwd), workspace: cwd, git: false };
}

async function currentBranch(ctx, cwd) {
  const out = await git(ctx, cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  const name = out?.trim();
  return name ? name : null;
}

// ---------------------------------------------------------------------------------------------
// Locating and loading runs
// ---------------------------------------------------------------------------------------------

const fsOption = (ctx) => (ctx.fs === undefined ? {} : { fs: ctx.fs });

function locateRun(ctx, repo, runId) {
  const options = seams(ctx);
  if (runId !== undefined) return runDir(repo.key, runId, options);
  const latest = listRuns(repo.key, options).find((item) => item.error === undefined);
  if (!latest) {
    throw new CliError("There are no runs for this repository.", { code: "RUN_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Runs are kept per repository; run this command from inside the repository the run belongs to." });
  }
  return latest.dir;
}

/** The graph a run was created with; fails when this build does not provide that exact graph. */
function graphOf(run) {
  const graph = getGraph(run.graph?.id, run.graph?.version);
  if (!graph || graphHash(graph) !== run.graph?.hash) {
    throw new CliError(`This run uses the graph ${sanitizeForTerminal(`${run.graph?.id}@${run.graph?.version}`).slice(0, 80)}, which this Asterweave does not provide in the same form.`, {
      code: "RUN_GRAPH_UNKNOWN",
      exitCode: EXIT.ERROR,
      remediation: "Use the Asterweave version that created the run.",
    });
  }
  return graph;
}

/** Read-only view of a run: the snapshot with the events past it folded in memory (no lock, no repair). */
function viewRun(dir) {
  const loaded = loadRun(dir);
  let run = loaded.run;
  let folded = loaded.behind === 0;
  if (loaded.behind > 0) {
    try {
      run = foldEvents(run, graphOf(run), loaded.pending).run;
      folded = true;
    } catch {
      folded = false;
    }
  }
  return { loaded, run, folded };
}

/**
 * Run `work` while holding the run lock, on an up-to-date copy of the run: a torn log tail is repaired and
 * events past the snapshot are folded first (exactly what the loop does at start).
 */
async function withRunLock(ctx, dir, work) {
  loadRun(dir, fsOption(ctx)); // a missing run is RUN_NOT_FOUND, not a lock failure on a directory that does not exist
  const lock = acquireRunLock(dir, fsOption(ctx));
  try {
    let loaded = loadRun(dir, fsOption(ctx));
    if (loaded.torn) {
      repairTail(dir, { lockToken: lock.token, ...fsOption(ctx) });
      loaded = loadRun(dir, fsOption(ctx));
    }
    const graph = graphOf(loaded.run);
    const env = { dir, graph, lockToken: lock.token, now: isoNow, ...fsOption(ctx) };
    let run = loaded.run;
    if (loaded.behind > 0) {
      run = foldEvents(run, graph, loaded.pending).run;
      run = commitRecords(env, run, [{ type: "ledger.folded", count: loaded.behind, fromSeq: loaded.pending[0].seq, toSeq: loaded.events.length }]).run;
    }
    // An event group the previous process did not finish (crash, kill) is completed first, exactly as the loop does,
    // so what this command appends afterwards cannot bury the missing records.
    run = completeInterruptedGroup(env, run, loaded.events).run;
    return await work({ run, graph, env });
  } finally {
    lock.release();
  }
}

// ---------------------------------------------------------------------------------------------
// run show
// ---------------------------------------------------------------------------------------------

function approvalState(approval) {
  if (approval.invalidatedAt) return "invalidated";
  return approval.grantedAt ? "granted" : "pending";
}

const insideRun = (ctx) => typeof ctx?.env?.ASTERWEAVE_RUN_ID === "string" && ctx.env.ASTERWEAVE_RUN_ID !== "";

/**
 * One approval as shown. The target is shown WHOLE (up to DISPLAY_LIMIT; the loop never requests a longer one), with
 * its length; `displayable` is false for a scope that does not display faithfully (then the text is only a sanitised
 * excerpt and the approval cannot be granted). `hide` hides the subject hash (inside a run).
 */
function describeApproval(run, approval, hide = false) {
  const state = approvalState(approval);
  const problem = displayProblem(approval.scope);
  return {
    id: approval.id,
    kind: approval.kind,
    scope: { operation: clip(approval.scope.operation, 128), target: clip(approval.scope.target, DISPLAY_LIMIT) },
    targetLength: String(approval.scope.target ?? "").length,
    displayable: problem === null,
    state,
    valid: state === "granted" ? isValid(run, approval, run.policyHash) : false,
    subject: hide ? HIDDEN_SUBJECT : prefix(approval.subjectHash),
    requestedBy: approval.requestedBy ?? null,
    by: approval.by ? { source: approval.by.source, name: approval.by.name } : null,
    requestedAt: approval.requestedAt ?? null,
    grantedAt: approval.grantedAt ?? null,
    invalidatedAt: approval.invalidatedAt ?? null,
  };
}

function lockInfo(dir, ctx) {
  try {
    const state = inspectRunLock(dir, fsOption(ctx));
    return { state: state.state, pid: state.owner?.pid ?? null, ageMs: state.ageMs ?? null };
  } catch {
    return { state: "unknown", pid: null, ageMs: null };
  }
}

function policyInfo(ctx, run) {
  const bound = run.policyHash ? prefix(run.policyHash) : null;
  try {
    const loaded = loadPolicy(seams(ctx));
    return { info: { mode: loaded.mode, hash: bound, currentHash: prefix(loaded.policyHash), changed: bound !== null && bound !== prefix(loaded.policyHash), error: null }, limits: resolveBudgets(loaded.policy) };
  } catch (error) {
    return { info: { mode: null, hash: bound, currentHash: null, changed: false, error: error?.code ?? "POLICY_UNAVAILABLE" }, limits: { ...DEFAULT_BUDGETS } };
  }
}

function attentionOf(run, events) {
  if (!["blocked", "waiting-approval", "paused"].includes(run.status)) return null;
  const event = events.findLast((candidate) => candidate.type === "tool.decision" && candidate.decision !== "allow");
  if (!event) return null;
  return { decision: event.decision, reason: event.reason, ruleId: event.ruleId, message: clip(event.message ?? "", 500), node: event.node ?? null, point: event.point ?? null, at: event.at };
}

/**
 * The stable JSON shape of `run show --json` (documented in help):
 * { ok, run: { runId, graph:{id,version,hash}, goal, status, currentNode, repo:{realpath}, createdAt, updatedAt, lastSeq,
 *   eventsBehind, nodes:[{id,status,attempts,maxAttempts,outcome}],
 *   approvals:[{id,kind,scope:{operation,target},targetLength,displayable,state,valid,subject,requestedBy,by,requestedAt,
 *   grantedAt,invalidatedAt}]  (subject is "hidden inside a run" when ASTERWEAVE_RUN_ID is set),
 *   budgets:{iterations,toolCalls,tokens,wallMs: {used,limit}, tokens also has available},
 *   lock:{state,pid,ageMs}, policy:{mode,hash,currentHash,changed,error}, attention } }
 */
export function describeRun(ctx, dir, view) {
  const { run, loaded } = view;
  const { info, limits } = policyInfo(ctx, run);
  const used = run.budgets?.used ?? {};
  // The loop treats a 0 counter as "no usage reported" (see loop.mjs start()); so does the display: never a fake 0.
  const tokensUsed = typeof used.tokens === "number" && used.tokens > 0 ? used.tokens : null;
  return {
    runId: run.runId,
    graph: { id: run.graph?.id ?? null, version: run.graph?.version ?? null, hash: prefix(run.graph?.hash) },
    goal: run.goal ?? "",
    status: run.status,
    currentNode: run.currentNode,
    repo: { realpath: run.repo?.realpath ?? null },
    createdAt: run.createdAt ?? null,
    updatedAt: run.updatedAt ?? null,
    lastSeq: loaded.events.length,
    eventsBehind: view.folded ? 0 : loaded.behind,
    nodes: Object.entries(run.nodes ?? {}).map(([id, node]) => ({ id, status: node.status, attempts: node.attempts, maxAttempts: node.maxAttempts, outcome: node.outcome ?? null })),
    approvals: (run.approvals ?? []).map((approval) => describeApproval(run, approval, insideRun(ctx))),
    budgets: {
      iterations: { used: used.iterations ?? 0, limit: limits.iterations ?? null },
      toolCalls: { used: used.toolCalls ?? 0, limit: limits.toolCalls ?? null },
      tokens: { used: tokensUsed, limit: limits.tokens ?? null, available: tokensUsed !== null },
      wallMs: { used: used.wallMs ?? 0, limit: limits.wallMs ?? null },
    },
    lock: lockInfo(dir, ctx),
    policy: info,
    attention: attentionOf(run, loaded.events),
  };
}

const formatMs = (ms) => {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 120) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds / 60)}min`;
};

function pad(rows) {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => String(row[column]).length)));
  return rows.map((row) => row.map((cell, column) => String(cell).padEnd(widths[column])).join("  ").trimEnd());
}

/** Text form of `describeRun` (every dynamic value is sanitised by the caller's sanitizeLines). */
export function formatRun(view) {
  const lines = [
    `Run       ${view.runId}`,
    `Graph     ${view.graph.id}@${view.graph.version} (${view.graph.hash})`,
    `Goal      ${clip(view.goal, GOAL_LINE).replace(/\s+/g, " ")}`,
    `Status    ${view.status}${view.currentNode ? ` (at ${view.currentNode})` : ""}`,
    `Repo      ${view.repo.realpath}`,
    `Policy    ${view.policy.mode ?? "unavailable"}${view.policy.hash ? `, bound ${view.policy.hash}` : ""}${view.policy.changed ? ", policy.json changed since the run started" : ""}${view.policy.error ? ` (${view.policy.error})` : ""}`,
    `Lock      ${view.lock.state === "none" ? "none" : `${view.lock.state}${view.lock.pid ? ` (pid ${view.lock.pid})` : ""}`}`,
    `Updated   ${view.updatedAt ?? "?"}  (event ${view.lastSeq}${view.eventsBehind > 0 ? `, snapshot ${view.eventsBehind} event(s) behind` : ""})`,
    "",
    "Nodes",
    ...pad(view.nodes.map((node) => [`  ${node.id}`, node.status, `${node.attempts}/${node.maxAttempts}`, node.outcome ?? ""])),
    "",
    "Approvals",
  ];
  if (view.approvals.length === 0) lines.push("  none");
  for (const approval of view.approvals) {
    const shown = displayTarget(approval.scope.target);
    const target = approval.scope.target === "" ? "" : ` -> ${shown}${approval.displayable ? "" : "  [NOT FAITHFUL: cannot be approved]"}`;
    lines.push(`  ${approval.id}  ${approval.state}${approval.state === "granted" && !approval.valid ? " (no longer valid)" : ""}  ${approval.kind} ${displayTarget(approval.scope.operation)}${target}`);
    lines.push(`      subject ${approval.subject}  target ${approval.targetLength} chars  requested by ${approval.requestedBy ?? "unknown"}${approval.by ? `  by ${approval.by.name} (${approval.by.source})` : ""}`);
  }
  const { budgets } = view;
  const of = (entry) => `${entry.used}${entry.limit ? ` / ${entry.limit}` : ""}`;
  lines.push(
    "",
    "Budgets",
    `  iterations  ${of(budgets.iterations)} (this attempt)`,
    `  tool calls  ${of(budgets.toolCalls)}`,
    `  tokens      ${budgets.tokens.available ? of(budgets.tokens) : "unavailable"}`,
    `  wall time   ${formatMs(budgets.wallMs.used)}${budgets.wallMs.limit ? ` / ${formatMs(budgets.wallMs.limit)}` : ""}`,
  );
  if (view.attention) {
    const a = view.attention;
    lines.push("", `Attention  ${a.decision} ${a.reason} (${a.ruleId})${a.node ? ` at ${a.node}` : ""}`, ...(a.message ? [`           ${a.message.replace(/\s+/g, " ")}`] : []));
  }
  const pending = view.approvals.filter((approval) => approval.state === "pending" && approval.displayable && approval.subject !== HIDDEN_SUBJECT);
  if (pending.length > 0) {
    lines.push("", "Approve with:");
    for (const approval of pending) lines.push(`  asterweave run approve ${view.runId} --approval ${approval.id} --subject ${approval.subject}`);
  }
  return lines;
}

async function showRun(ctx, rest) {
  const [runId, ...extra] = rest;
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation: "Usage: asterweave run show [runId] [--json]" });
  const repo = await resolveRepo(ctx);
  const dir = locateRun(ctx, repo, runId);
  const view = describeRun(ctx, dir, viewRun(dir));
  if (ctx.options?.json === true) write(ctx.stdout, `${stringifyJson({ ok: true, run: view })}\n`);
  else write(ctx.stdout, `${sanitizeLines(formatRun(view))}\n`);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------------------------

async function confirm(ctx, lines) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(`${sanitizeLines(lines)} `);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

function approverName(ctx) {
  const fromEnv = ctx.env?.USERNAME || ctx.env?.USER;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim().slice(0, 100);
  try {
    return userInfo().username || "user";
  } catch {
    return "user";
  }
}

function assertRunOpen(run, what) {
  if (run.status === "completed" || run.status === "aborted") {
    throw new CliError(`Run ${run.runId} is already ${run.status}; ${what}.`, { code: "RUN_NOT_ACTIVE", exitCode: EXIT.ERROR });
  }
}

// ---------------------------------------------------------------------------------------------
// run approve
// ---------------------------------------------------------------------------------------------

const approveRemediation = "Usage: asterweave run approve <runId> --approval <id> --subject <hash prefix from `run show`>";

async function approveRun(ctx, rest) {
  if (typeof ctx.env?.ASTERWEAVE_RUN_ID === "string" && ctx.env.ASTERWEAVE_RUN_ID !== "") {
    throw new CliError("Approvals cannot be granted from inside a run.", { code: "APPROVAL_FORBIDDEN_CONTEXT", exitCode: EXIT.ERROR, remediation: "Run `asterweave run approve` yourself, in a terminal that is not driven by the run." });
  }
  const [runId, ...extra] = rest;
  if (runId === undefined) throw new UsageError("run approve needs a run id.", { remediation: approveRemediation });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation: approveRemediation });
  const approvalId = stringOption(ctx, "approval", approveRemediation);
  const subject = stringOption(ctx, "subject", approveRemediation);
  const json = ctx.options?.json === true;
  if ((approvalId === undefined) !== (subject === undefined)) {
    throw new UsageError("--approval and --subject go together: quote the subject hash prefix that `run show` prints.", { remediation: approveRemediation });
  }
  const viaFlags = approvalId !== undefined;
  if (!viaFlags && (json || !isInteractive(ctx))) {
    throw new UsageError("run approve needs --approval and --subject when it is not run in an interactive terminal (or with --json).", { remediation: approveRemediation });
  }

  const repo = await resolveRepo(ctx);
  const dir = runDir(repo.key, runId, seams(ctx));
  let source = "flag";
  let wanted = [{ id: approvalId, subjectHash: null }];

  if (!viaFlags) {
    source = "tty";
    const view = viewRun(dir);
    assertRunOpen(view.run, "there is nothing to approve");
    const waiting = pendingApprovals(view.run);
    if (waiting.length === 0) throw new CliError(`Run ${view.run.runId} has no approval waiting for a decision.`, { code: "APPROVAL_NOT_FOUND", exitCode: EXIT.ERROR });
    wanted = [];
    // Nothing is asked about a scope that cannot be shown faithfully: the person could not know what they approve.
    for (const approval of waiting) {
      const problem = displayProblem(approval.scope);
      if (problem !== null) {
        throw new CliError(`Approval ${sanitizeForTerminal(String(approval.id)).slice(0, 40)} cannot be shown faithfully (${problem}); nothing was approved.`, { code: "UNDISPLAYABLE_TARGET", exitCode: EXIT.ERROR, remediation: "Abort the run or let it ask again; this request can not be granted." });
      }
    }
    for (const approval of waiting) {
      const described = describeApproval(view.run, approval, false);
      const answer = await confirm(ctx, [
        `Approve ${described.id} for run ${view.run.runId}?`,
        `  kind          ${described.kind}`,
        `  requested by  ${described.requestedBy ?? "unknown"}`,
        `  scope         ${displayTarget(described.scope.operation)}`,
        `  target        ${displayTarget(described.scope.target)}`,
        `  length        ${described.targetLength} characters (shown whole; \\n, \\t, \\\\ and \\u{XXXX} are escapes; every non-ASCII character is shown as one)`,
        `  subject       ${described.subject}`,
        "This allows exactly that, nothing else. [y/N]",
      ]);
      if (answer.interrupted) return EXIT.INTERRUPTED;
      if (answer.yes) wanted.push({ id: approval.id, subjectHash: approval.subjectHash });
    }
    if (wanted.length === 0) throw new CliError("Nothing was approved.", { code: "APPROVAL_DECLINED", exitCode: EXIT.ERROR, remediation: "Nothing was changed." });
  }

  const name = approverName(ctx);
  const hide = insideRun(ctx);
  const granted = await withRunLock(ctx, dir, ({ run, env }) => {
    assertRunOpen(run, "there is nothing to approve");
    // The policy in force NOW: an approval requested under another policy is stale (APPROVAL_STALE).
    const { policyHash } = loadPolicy(seams(ctx));
    // All-or-nothing: every approval is validated against the state as it would be after the previous ones, and
    // only then are the records written. A failure on any of them leaves the ledger as it was.
    let current = run;
    const events = [];
    for (const item of wanted) {
      const before = findApproval(current, item.id);
      if (item.subjectHash !== null && (!before || before.subjectHash !== item.subjectHash || before.grantedAt !== null || before.invalidatedAt !== null)) {
        throw new CliError(`Approval ${sanitizeForTerminal(String(item.id)).slice(0, 40)} changed while you were deciding; nothing was granted.`, { code: "APPROVAL_CHANGED", exitCode: EXIT.ERROR, remediation: "Run `asterweave run show` and decide again." });
      }
      const result = grantApproval(current, item.id, { by: { source, name }, now: isoNow(), policyHash, ...(source === "flag" ? { subject } : {}), env: ctx.env });
      current = result.run;
      events.push(...result.events);
    }
    const written = commitRecords(env, run, events).run;
    return wanted.map((item) => describeApproval(written, findApproval(written, item.id), hide));
  });

  if (json) write(ctx.stdout, `${stringifyJson({ ok: true, runId, approved: granted })}\n`);
  else {
    const lines = granted.map((item) => `Approved ${item.id} (${item.kind} ${item.scope.operation}) for run ${runId}.`);
    write(ctx.stdout, `${sanitizeLines([...lines, "The approval is recorded; the run picks it up when it continues."])}\n`);
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------
// run abort
// ---------------------------------------------------------------------------------------------

async function abortRun(ctx, rest) {
  const [runId, ...extra] = rest;
  const remediation = "Usage: asterweave run abort <runId> [--yes] [--json]";
  if (runId === undefined) throw new UsageError("run abort needs a run id.", { remediation });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation });
  const yes = ctx.options?.yes === true;
  const json = ctx.options?.json === true;
  if (!yes && (json || !isInteractive(ctx))) throw new UsageError("run abort needs --yes when it is not run in an interactive terminal (or with --json).", { remediation });

  const repo = await resolveRepo(ctx);
  const dir = runDir(repo.key, runId, seams(ctx));
  const view = viewRun(dir);
  const report = (already) => {
    if (json) write(ctx.stdout, `${stringifyJson({ ok: true, runId, status: "aborted", alreadyAborted: already })}\n`);
    else write(ctx.stdout, `${sanitizeLines(already ? `Run ${runId} was already aborted.` : `Run ${runId} aborted.`)}\n`);
    return EXIT.OK;
  };
  if (view.run.status === "aborted") return report(true);
  assertRunOpen(view.run, "it cannot be aborted");
  if (!yes) {
    const answer = await confirm(ctx, [`Abort run ${runId} (${view.run.status}${view.run.currentNode ? `, at ${view.run.currentNode}` : ""})? This cannot be undone. [y/N]`]);
    if (answer.interrupted) return EXIT.INTERRUPTED;
    if (!answer.yes) throw new CliError("The run was not aborted.", { code: "ABORT_DECLINED", exitCode: EXIT.ERROR, remediation: "Nothing was changed." });
  }
  const already = await withRunLock(ctx, dir, ({ run, env }) => {
    if (run.status === "aborted") return true;
    assertRunOpen(run, "it cannot be aborted");
    try {
      commitTransition(env, run, { type: "abort", reason: "aborted by the user" });
    } catch (error) {
      if (error instanceof GraphError) throw new CliError(`Run ${runId} cannot be aborted: ${sanitizeForTerminal(error.message).slice(0, 200)}`, { code: "RUN_NOT_ACTIVE", exitCode: EXIT.ERROR });
      throw error;
    }
    return false;
  });
  return report(already);
}

// ---------------------------------------------------------------------------------------------
// run start / resume (hidden, development executors only)
// ---------------------------------------------------------------------------------------------

function notAvailable(sub) {
  return new UsageError(`'run ${sub}' is not available.`, { remediation: PUBLIC_USAGE });
}

function requireFake(ctx, remediation) {
  const executor = stringOption(ctx, "executor", remediation);
  if (executor !== undefined && executor !== "fake") throw new UsageError("Only --executor fake is available.", { remediation });
  const script = stringOption(ctx, "script", remediation);
  if (script === undefined) throw new UsageError("--script <file> is required.", { remediation });
  const file = path.resolve(ctx.cwd ?? process.cwd(), script);
  return createFakeExecutor(loadScript(file, ctx.fs ? { fs: ctx.fs } : undefined));
}

function newRunId() {
  return `run-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`;
}

function summarize(result, run, hide = false) {
  return {
    runId: run.runId,
    graph: `${run.graph.id}@${run.graph.version}`,
    status: result.status,
    currentNode: result.run.currentNode,
    exitCode: result.exitCode,
    reason: result.reason ?? null,
    decision: result.decision ? { point: result.decision.point, decision: result.decision.decision, reason: result.decision.reason, ruleId: result.decision.ruleId, message: clip(result.decision.message ?? "", 500) } : null,
    pendingApprovals: result.pendingApprovals.map((approval) => ({ id: approval.id, kind: approval.kind, scope: { operation: approval.scope.operation, target: clip(approval.scope.target, DISPLAY_LIMIT) }, subject: hide ? HIDDEN_SUBJECT : prefix(approval.subjectHash), requestedBy: approval.requestedBy ?? null })),
  };
}

function report(ctx, summary) {
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson({ ok: summary.exitCode === EXIT.OK, ...summary })}\n`);
    return;
  }
  const lines = [`Run ${summary.runId} (${summary.graph}): ${summary.status}${summary.currentNode ? ` at ${summary.currentNode}` : ""}`];
  if (summary.reason) lines.push(`Stopped: ${summary.reason}${summary.decision?.message ? ` - ${summary.decision.message.replace(/\s+/g, " ")}` : ""}`);
  for (const approval of summary.pendingApprovals) lines.push(`Waiting for approval ${approval.id}: ${approval.kind} ${approval.scope.operation} (subject ${approval.subject})`);
  if (summary.exitCode !== EXIT.OK) lines.push(`See: asterweave run show ${summary.runId}`);
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
}

/** Interrupt handling: the first SIGINT/SIGTERM pauses the run cleanly, a second one ends the process. */
function interruptSignal(ctx) {
  const controller = new AbortController();
  const proc = ctx.proc ?? process;
  const onSignal = () => {
    if (controller.signal.aborted) proc.exit?.(EXIT.INTERRUPTED);
    else controller.abort();
  };
  const onParent = () => controller.abort();
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", onParent, { once: true });
  proc.on?.("SIGINT", onSignal);
  proc.on?.("SIGTERM", onSignal);
  return {
    signal: controller.signal,
    dispose() {
      proc.removeListener?.("SIGINT", onSignal);
      proc.removeListener?.("SIGTERM", onSignal);
      ctx.signal?.removeEventListener("abort", onParent);
    },
  };
}

async function drive(ctx, { loop, loopOptions, dir, graph, executor, policy, hooks, repo, branch, run }) {
  const interrupt = interruptSignal(ctx);
  try {
    const result = await loop({
      dir,
      graph,
      executor,
      dispatcher: simulatedDispatcher(),
      policy: policy.policy,
      policyHash: policy.policyHash,
      hooks: hooks.hooks,
      signal: interrupt.signal,
      workspaceRoot: repo.workspace,
      repoPath: repo.workspace,
      ...(branch ? { branch } : {}),
      guardOptions: { env: ctx.env, userDir: resolveUserDir(seams(ctx)), ...(ctx.platform ? { platform: ctx.platform } : {}), ...(ctx.homedir ? { homedir: ctx.homedir } : {}) },
      hookOptions: { env: ctx.env },
      ...fsOption(ctx),
      ...loopOptions,
    });
    const summary = summarize(result, run ?? result.run, insideRun(ctx));
    report(ctx, summary);
    return result.exitCode;
  } finally {
    interrupt.dispose();
  }
}

async function startRun(ctx, rest, deps) {
  const remediation = "Usage: asterweave run start --executor fake --script <file> [--graph delivery@1|bugfix@1] [--goal text] [--run-id id]";
  if (rest.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(rest[0]).slice(0, 40)}'.`, { remediation });
  const executor = requireFake(ctx, remediation);
  const graphName = stringOption(ctx, "graph", remediation) ?? "delivery@1";
  const graph = getGraph(graphName);
  if (!graph) throw new UsageError(`Unknown graph '${sanitizeForTerminal(graphName).slice(0, 40)}'.`, { remediation });
  const goal = stringOption(ctx, "goal", remediation) ?? "development run";
  if (goal.length > GOAL_MAX) throw new UsageError(`--goal is longer than ${GOAL_MAX} characters.`, { remediation });
  const runId = stringOption(ctx, "run-id", remediation) ?? newRunId();
  if (!isValidRunId(runId)) throw new UsageError("--run-id must be 1-64 letters, digits, '-' or '_'.", { remediation });

  const repo = await resolveRepo(ctx);
  // Configuration errors (exit 5) must surface before a run directory exists.
  const policy = loadPolicy(seams(ctx));
  const hooks = loadHooks({ ...seams(ctx), repoPath: repo.workspace });
  const branch = await currentBranch(ctx, repo.workspace);
  const created = createRunForGraph({ graph, goal, repo: { key: repo.key, realpath: repo.workspace }, runId, policyHash: policy.policyHash, ...seams(ctx) });
  return drive(ctx, { ...deps, dir: created.dir, graph, executor, policy, hooks, repo, branch, run: created.run });
}

async function resumeRun(ctx, rest, deps) {
  const remediation = "Usage: asterweave run resume <runId> --executor fake --script <file>";
  const [runId, ...extra] = rest;
  if (runId === undefined) throw new UsageError("run resume needs a run id.", { remediation });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation });
  const executor = requireFake(ctx, remediation);
  const repo = await resolveRepo(ctx);
  const dir = runDir(repo.key, runId, seams(ctx));
  const { run } = loadRun(dir, fsOption(ctx));
  const graph = graphOf(run);
  const policy = loadPolicy(seams(ctx));
  const hooks = loadHooks({ ...seams(ctx), repoPath: repo.workspace });
  const branch = await currentBranch(ctx, repo.workspace);
  return drive(ctx, { ...deps, dir, graph, executor, policy, hooks, repo, branch, run });
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Handler factory. `runLoopImpl` and `loopOptions` are test seams (a different loop, a fast sleep, ...).
 * @param {{runLoopImpl?: typeof runLoop, loopOptions?: object}} [seamsIn]
 */
export function createRunCommand({ runLoopImpl = runLoop, loopOptions = {} } = {}) {
  return async function run(ctx) {
    const [sub, ...rest] = ctx.positionals ?? [];
    if (sub === undefined) throw new UsageError("Missing run subcommand.", { remediation: PUBLIC_USAGE });
    if (!Object.hasOwn(FLAGS, sub)) throw new UsageError(`Unknown run subcommand '${sanitizeForTerminal(sub).slice(0, 40)}'.`, { remediation: PUBLIC_USAGE });
    if (HIDDEN.has(sub) && ctx.env?.[DEV_ENV] !== "1") throw notAvailable(sub);
    for (const key of Object.keys(ctx.options ?? {})) {
      if (key !== "help" && key !== "version" && !FLAGS[sub].includes(key)) {
        throw new UsageError(`Option '--${sanitizeForTerminal(key).slice(0, 40)}' is not valid for 'run ${sub}'.`, { remediation: HIDDEN.has(sub) ? PUBLIC_USAGE : `Run \`asterweave help run\` to see the accepted options.` });
      }
    }
    switch (sub) {
      case "show":
        return showRun(ctx, rest);
      case "approve":
        return approveRun(ctx, rest);
      case "abort":
        return abortRun(ctx, rest);
      case "start":
        return startRun(ctx, rest, { loop: runLoopImpl, loopOptions });
      default:
        return resumeRun(ctx, rest, { loop: runLoopImpl, loopOptions });
    }
  };
}

/** Handler for `asterweave run ...`. */
export const runCommand = createRunCommand();
