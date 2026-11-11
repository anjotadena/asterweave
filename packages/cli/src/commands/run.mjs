// `asterweave run start|resume|show|approve|abort`. start and resume drive a run with the Claude runner (run-runner.mjs); the scripted fake
// executor behind them is the only development-gated part.
//
// PUBLIC (listed in help):
//   run show [runId] [--json]                                   what a run is doing (default: the newest run of this repository)
//   run approve <runId> [--approval <id> --subject <hash> --nonce <code>] [--json]   answer y/N on a terminal, or quote the nonce
//   run abort <runId> [--yes] [--json]                          stop a run for good (idempotent)
//
//   run start <goal> [--workflow delivery|bugfix|contribute|audit|auto] [--session id] [--runner claude|fake] [--worktree name] [--json]   (Claude runner: runner.md)
//   run resume <runId> [--json]
//
// DEVELOPMENT ONLY (accepted only when ASTERWEAVE_DEV_EXECUTORS=1, otherwise exit 2 "not available"): the scripted fake executor
//   run start  --executor fake --script <file> [--graph delivery@1|bugfix@1] [--goal text] [--run-id id]   (or --runner fake --script f <goal>)
//   run resume <runId> --executor fake --script <file>
// They drive the loop with the scripted fake executor and a SIMULATED tool dispatcher: no tool is carried out (hooks
// and the read-only git queries of resolveRepo do spawn processes). `resume` takes the script again because the
// ledger does not store it.
//
// Approvals come only from a person at a terminal: the y/N prompt (stdin AND stdout are a TTY), or the flags
// `--approval` + `--subject` (the hash prefix `run show` prints) + `--nonce`, the one-time code that the SUPERVISING
// process (`run start|resume`) printed on its OWN stderr when that was a TTY; only the nonce's hash is stored. Flags without a
// valid nonce never grant (exit 2 without one, exit 7 with a wrong one; 5 wrong tries lock the request for 10 minutes).
// Nothing is ever read from a file in the repository. The command also refuses to run (exit 7) when the environment
// shows an agent context (ASTERWEAVE_RUN_ID, ASTERWEAVE_SESSION_ID, CLAUDECODE, CLAUDE_CODE_*). Those markers are
// advisory (a child can unset them) and the nonce can be seen by a process that reaches the console; this is defence
// in depth, NOT a sandbox: see approvals.mjs and website/docs/cli/policy-and-guards.md. As a cheap hardening, `run show`
// hides the approval subject hashes when ASTERWEAVE_RUN_ID is set.
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
import { DISPLAY_LIMIT, assertHumanContext, displayProblem, displayTarget, failedAttemptEvent, findApproval, grantApproval, isValid, pendingApprovals } from "../runtime/approvals.mjs";
import { simulatedDispatcher } from "../runtime/executor.mjs";
import { createFakeExecutor, loadScript } from "../runtime/fake-executor.mjs";
import { GraphError, getGraph, graphHash } from "../runtime/graph.mjs";
import { describeContribution, initContribution, loadContribution } from "../runtime/contribution.mjs";
import "../runtime/graphs/index.mjs";
import { loadHooks } from "../runtime/hooks.mjs";
import { isValidRunId, listRuns, loadRun, repairTail, runDir } from "../runtime/ledger.mjs";
import { commitRecords, commitTransition, completeInterruptedGroup, createRunForGraph, foldEvents, runLoop } from "../runtime/loop.mjs";
import { acquireRunLock, inspectRunLock } from "../runtime/lock.mjs";
import { DEFAULT_BUDGETS, loadPolicy, resolveBudgets } from "../runtime/policy.mjs";
import { pinRouting, routingFromEntries } from "../runtime/routing.mjs";
import { resolveModelConfig } from "../config.mjs";
import { worktreeRootProblem } from "../runtime/repo-root.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { resumeClaudeRun, startClaudeRun } from "./run-runner.mjs";
import { isInteractive, seams, stringOption } from "./shared.mjs";

export const runCommandMeta = Object.freeze({
  summary: "Start, resume, show, approve or abort a run",
  boolean: ["json", "yes"],
  // The union over every subcommand (including the hidden ones); each subcommand narrows it below.
  options: ["json", "yes", "approval", "subject", "nonce", "executor", "script", "graph", "goal", "run-id", "workflow", "session", "runner", "worktree", "image"],
});

const PUBLIC_USAGE = "Usage: asterweave run start <goal> [--workflow delivery|bugfix|contribute|audit|auto] [--session <id>] [--worktree <name>] [--image <path>]... | run resume <runId> | run show [runId] [--json] | run approve <runId> [--approval <id> --subject <hash> --nonce <code>] | run abort <runId> [--yes]";
const SUBJECT_SHOWN = 12;
const GOAL_LINE = 400;
const HIDDEN_SUBJECT = "hidden inside a run";
const GOAL_MAX = 2000;
const DEV_ENV = "ASTERWEAVE_DEV_EXECUTORS";

const FLAGS = {
  show: ["json"],
  approve: ["json", "approval", "subject", "nonce"],
  abort: ["json", "yes"],
  start: ["json", "executor", "script", "graph", "goal", "run-id", "workflow", "session", "runner", "worktree", "image"],
  resume: ["json", "executor", "script", "runner"],
};
// start and resume are public with the Claude runner; only the scripted fake executor behind them is development only (wantsFake).

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
    ...contributionField(dir, run), // only present for contribution runs: other runs keep their exact shape
  };
}

/** Skill, task, stage, findings, verification, remote references, blockers and next action of a contribution run; null for other runs. */
function contributionField(dir, run) {
  const view = contributionView(dir, run);
  return view === null ? {} : { contribution: view };
}

function contributionView(dir, run) {
  try {
    const state = loadContribution(dir);
    return state === null ? null : describeContribution(state, run);
  } catch (error) {
    return { error: String(error?.code ?? "CONTRIBUTION_UNREADABLE") };
  }
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
  if (view.contribution) {
    const c = view.contribution;
    if (c.error) lines.push("", `Contribution  unavailable (${c.error})`);
    else {
      lines.push("", "Contribution", `  skill       ${c.skill} via ${c.workflow}, scope ${c.scope}`, `  task        ${c.task ?? "none recorded"}`, `  stage       ${c.stage ?? "none"} (${c.stagesPassed} stages passed)`);
      lines.push(`  findings    ${c.findings.total} recorded${c.findings.ledgerEvidence ? `, ${c.findings.ledgerEvidence} finding evidence item(s) in the ledger` : ""}${c.findings.total ? ` (${["suspected", "reproduced", "fixed-locally", "verified", "blocked"].filter((s) => c.findings[s]).map((s) => `${c.findings[s]} ${s}`).join(", ")})` : ""}`);
      lines.push(`  verification ${c.verification.length ? c.verification.map((v) => `${v.stage} ${v.status}`).join(", ") : "not reached"}`);
      for (const r of c.remote) lines.push(`  remote      ${r.operation} ${r.target}: ${r.status}${r.id ? ` (${r.id})` : ""}`);
      lines.push(`  blocked     ${c.blocked ? "yes" : "no"}`, `  next        ${c.next}`, "  not recorded by the ledger: active agent, current tool, changed files");
    }
  }
  if (view.attention) {
    const a = view.attention;
    lines.push("", `Attention  ${a.decision} ${a.reason} (${a.ruleId})${a.node ? ` at ${a.node}` : ""}`, ...(a.message ? [`           ${a.message.replace(/\s+/g, " ")}`] : []));
  }
  const pending = view.approvals.filter((approval) => approval.state === "pending" && approval.displayable && approval.subject !== HIDDEN_SUBJECT);
  if (pending.length > 0) {
    lines.push("", "Approve in a terminal (answer the prompt):", `  asterweave run approve ${view.runId}`);
    lines.push("Or with flags, quoting the one-time nonce the supervising terminal printed:");
    for (const approval of pending) lines.push(`  asterweave run approve ${view.runId} --approval ${approval.id} --subject ${approval.subject} --nonce <nonce>`);
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

const approveRemediation = "Approve in a terminal: asterweave run approve <runId>. With flags: --approval <id> --subject <hash prefix from `run show`> --nonce <code printed by the supervising terminal>";

async function approveRun(ctx, rest) {
  assertHumanContext(ctx.env);
  const [runId, ...extra] = rest;
  if (runId === undefined) throw new UsageError("run approve needs a run id.", { remediation: approveRemediation });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${sanitizeForTerminal(extra[0]).slice(0, 40)}'.`, { remediation: approveRemediation });
  const approvalId = stringOption(ctx, "approval", approveRemediation);
  const subject = stringOption(ctx, "subject", approveRemediation);
  const nonce = stringOption(ctx, "nonce", approveRemediation);
  const json = ctx.options?.json === true;
  if ((approvalId === undefined) !== (subject === undefined)) {
    throw new UsageError("--approval and --subject go together: quote the subject hash prefix that `run show` prints.", { remediation: approveRemediation });
  }
  const viaFlags = approvalId !== undefined;
  if (!viaFlags && nonce !== undefined) throw new UsageError("--nonce goes with --approval and --subject.", { remediation: approveRemediation });
  if (viaFlags && nonce === undefined) {
    // Flags alone never grant: anything that can run this command with flags could be an agent.
    throw new CliError("Flags alone cannot approve: a flag approval needs the one-time --nonce that the supervising process printed on its own terminal.", { code: "APPROVAL_TERMINAL_REQUIRED", exitCode: EXIT.USAGE, remediation: approveRemediation });
  }
  if (!viaFlags && (json || !isInteractive(ctx))) {
    throw new CliError("run approve needs an interactive terminal (stdin and stdout both a TTY, no --json) unless --approval, --subject and --nonce are given.", { code: "APPROVAL_TERMINAL_REQUIRED", exitCode: EXIT.USAGE, remediation: approveRemediation });
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
      let result;
      try {
        result = grantApproval(current, item.id, { by: { source, name }, now: isoNow(), policyHash, ...(source === "flag" ? { subject, nonce } : {}), env: ctx.env });
      } catch (error) {
        // A wrong nonce is counted in the request record (ledger event) BEFORE the error is reported; 5 lock it for 10 minutes.
        if (error?.code === "APPROVAL_NONCE_INVALID") {
          const target = findApproval(current, item.id);
          if (target) commitRecords(env, run, [failedAttemptEvent(target, isoNow())]);
        }
        throw error;
      }
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
    runnerFailure: result.runnerFailure ?? null,
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
  if (summary.runnerFailure) lines.push(`Runner: ${summary.runnerFailure.class} - ${summary.runnerFailure.message}`, `Next: ${summary.runnerFailure.remediation}`);
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

/**
 * The supervisor's own terminal is the ONLY place a nonce is shown: stderr, and only when it is a TTY. Headless supervisors
 * get no callback, so no nonce exists anywhere for them (their approvals need the interactive prompt).
 */
function nonceAnnouncer(ctx) {
  if (ctx.stderr?.isTTY !== true) return {};
  return {
    onApprovalNonce({ runId, approvalId, kind, nonce }) {
      write(ctx.stderr, `${sanitizeLines([`Approval ${approvalId} (${kind}) of run ${runId} is waiting. One-time nonce: ${nonce}`, "Keep it to yourself; it is shown only here. Without it, answer the prompt of `asterweave run approve` in a terminal."])}\n`);
    },
  };
}

async function drive(ctx, { loop, loopOptions, dir, graph, executor, policy, hooks, repo, branch, run, finish, imageInfo }) {
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
      ...nonceAnnouncer(ctx),
      ...fsOption(ctx),
      ...loopOptions,
    });
    // An interrupted claude turn is fully gone (process tree killed) before the command returns; an executor that never settles cannot hang it.
    await Promise.race([executor.idle?.(), new Promise((resolve) => { setTimeout(resolve, 10_000).unref?.(); })]);
    try { finish?.(result); } catch { /* a convenience record must not change the outcome */ }
    // Images sent with the first turn: hashes and sizes only (never bytes). Present only when the run was started with images.
    const summary = { ...summarize(result, run ?? result.run, insideRun(ctx)), ...(imageInfo ? { attachments: imageInfo.views, ...(imageInfo.warnings.length > 0 ? { imageWarnings: imageInfo.warnings } : {}) } : {}) };
    report(ctx, summary);
    return result.exitCode;
  } finally {
    interrupt.dispose();
  }
}

/** The scripted fake executor is wanted: --executor / --script, or --runner fake. It needs ASTERWEAVE_DEV_EXECUTORS=1. */
function wantsFake(ctx) {
  const runner = ctx.options?.runner;
  if (runner !== undefined && runner !== "claude" && runner !== "fake") throw new UsageError("--runner must be claude or fake.", { remediation: PUBLIC_USAGE });
  return ctx.options?.executor !== undefined || ctx.options?.script !== undefined || runner === "fake";
}

const KIT = () => ({ resolveRepo, currentBranch, drive, graphOf, fsOption, newRunId, GOAL_MAX });

async function startRun(ctx, rest, deps) {
  if (!wantsFake(ctx)) return startClaudeRun(ctx, rest, deps, KIT());
  if (ctx.env?.[DEV_ENV] !== "1") throw notAvailable("start");
  if (ctx.options?.runner === "fake" && ctx.options?.executor === undefined && rest.length === 1 && ctx.options?.goal === undefined) {
    ctx = { ...ctx, options: { ...ctx.options, goal: rest[0] } }; // `run start <goal> --runner fake --script f`
    rest = [];
  }
  const remediation = "Usage: asterweave run start <goal> [--workflow delivery|bugfix|contribute|audit|auto] [--session <id>] [--worktree <name>] [--json]";
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
  const routing = pinRouting(routingFromEntries(resolveModelConfig(seams(ctx)).entries)); // the model route is pinned for the life of the run
  const hooks = loadHooks({ ...seams(ctx), repoPath: repo.workspace });
  const branch = await currentBranch(ctx, repo.workspace);
  const created = createRunForGraph({ graph, goal, repo: { key: repo.key, realpath: repo.workspace }, runId, policyHash: policy.policyHash, routing, ...seams(ctx) });
  const recorded = { audit: ["repo-audit", "discovery"], contribute: ["contribute", "implement"], bugfix: ["bug-fix", "implement"] }[graph.id];
  if (recorded) initContribution(created.dir, { skill: recorded[0], workflow: graph.id, objective: goal, level: recorded[1] });
  return drive(ctx, { ...deps, dir: created.dir, graph, executor, policy, hooks, repo, branch, run: created.run });
}

async function resumeRun(ctx, rest, deps) {
  if (!wantsFake(ctx)) return resumeClaudeRun(ctx, rest, deps, KIT());
  if (ctx.env?.[DEV_ENV] !== "1") throw notAvailable("resume");
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
 * Handler factory. `runLoopImpl`, `loopOptions`, `claude` (claudePath, claudeArgs, spawn, exists), `runTurn`, `runnerOptions`, `catalog` (model catalog for the image check) and `imageStore` ({listAttachments}) are test seams.
 * @param {{runLoopImpl?: typeof runLoop, loopOptions?: object}} [seamsIn]
 */
export function createRunCommand({ runLoopImpl = runLoop, loopOptions = {}, claude, runTurn, runnerOptions, catalog, imageStore } = {}) {
  const runner = { ...(claude ? { claude } : {}), ...(runTurn ? { runTurn } : {}), ...(runnerOptions ? { runnerOptions } : {}), ...(catalog ? { catalog } : {}), ...(imageStore ? { imageStore } : {}) };
  return async function run(ctx) {
    const [sub, ...rest] = ctx.positionals ?? [];
    if (sub === undefined) throw new UsageError("Missing run subcommand.", { remediation: PUBLIC_USAGE });
    if (!Object.hasOwn(FLAGS, sub)) throw new UsageError(`Unknown run subcommand '${sanitizeForTerminal(sub).slice(0, 40)}'.`, { remediation: PUBLIC_USAGE });
    for (const key of Object.keys(ctx.options ?? {})) {
      if (key !== "help" && key !== "version" && !FLAGS[sub].includes(key)) {
        throw new UsageError(`Option '--${sanitizeForTerminal(key).slice(0, 40)}' is not valid for 'run ${sub}'.`, { remediation: `Run \`asterweave help run\` to see the accepted options.` });
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
        return startRun(ctx, rest, { loop: runLoopImpl, loopOptions, ...runner });
      default:
        return resumeRun(ctx, rest, { loop: runLoopImpl, loopOptions, ...runner });
    }
  };
}

/** Handler for `asterweave run ...`. */
export const runCommand = createRunCommand();
