// `run start <goal>` and `run resume <runId>` with the Claude runner (the public path). Called from run.mjs, which passes its helpers in
// `kit` (no import cycle). The scripted fake executor path stays in run.mjs behind ASTERWEAVE_DEV_EXECUTORS=1.
//
// Before anything is created: the repository must be trusted (exit 4), claude must be installed and recent enough (exit 1 with a
// remediation), the policy and routing configuration must load (exit 5). Then the run is created, optionally linked to a session
// (`--session`) or given its own session and an isolated worktree (`--worktree`), and driven by the loop with a ClaudeExecutor.
// Claude runs its own tools: the PreToolUse hook (generated settings) is the only gate before them; see website/docs/cli/runner.md.

import * as nodeFs from "node:fs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { resolveUserDir } from "../paths.mjs";
import { resolveModelConfig } from "../config.mjs";
import { checkClaude } from "../runtime/claude/run.mjs";
import { describeFailure } from "../runtime/claude/classify.mjs";
import { createClaudeExecutor } from "../runtime/claude/executor.mjs";
import { getGraph } from "../runtime/graph.mjs";
import "../runtime/graphs/index.mjs";
import { loadHooks } from "../runtime/hooks.mjs";
import { isValidRunId, loadRun, runDir } from "../runtime/ledger.mjs";
import { createRunForGraph } from "../runtime/loop.mjs";
import { loadPolicy } from "../runtime/policy.mjs";
import { configOfPinned, pinRouting, routingFromEntries } from "../runtime/routing.mjs";
import { addCheckpoint, createSession, linkRun, listSessions, loadSession, setProviderSession } from "../runtime/sessions.mjs";
import { assertTrusted } from "../trust.mjs";
import { seams, stringOption } from "./shared.mjs";

const WORKFLOWS = ["delivery", "bugfix"];
/** One claude turn may take minutes: the loop's per-step deadline is raised well above its 2 minute default. */
export const RUNNER_STEP_MS = 40 * 60_000;
export const START_USAGE = "Usage: asterweave run start <goal> [--workflow delivery|bugfix] [--session <id>] [--runner claude|fake] [--worktree <name>] [--json]";
export const RESUME_USAGE = "Usage: asterweave run resume <runId> [--json]";

const safe = (text, limit = 200) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);
const storeOptions = (ctx) => ({ ...seams(ctx), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.userDir ? { userDir: ctx.userDir } : {}) });

/** Throws the CliError for an unusable claude (exit 1, doctor-style remediation). */
function requireClaude(ctx, deps, cwd) {
  return checkClaude({ ...deps.claude, env: ctx.env, ...(ctx.platform ? { platform: ctx.platform } : {}), ...(ctx.exists ? { exists: ctx.exists } : {}), cwd, signal: ctx.signal }).then((checked) => {
    if (checked.ok) return checked;
    const described = describeFailure(checked.failure.class);
    throw new CliError(`${described.message}${checked.failure.detail ? `: ${safe(checked.failure.detail, 300)}` : ""}.`, { code: `RUNNER_${checked.failure.class.toUpperCase().replace(/-/g, "_")}`, exitCode: EXIT.ERROR, remediation: `${described.remediation} Run \`asterweave doctor\` to check.` });
  });
}

function requireTrust(ctx, workspace) {
  return assertTrusted(workspace, "run Claude on this repository", seams(ctx));
}

/**
 * The workspace claude will ACTUALLY work in (a session's worktree, a new worktree, a run's recorded workspace) must belong to the
 * clone that was trusted: same repository key (git common directory). A session or run record pointing at another repository, or at a
 * directory that is gone, is refused (exit 4). The worktree's own governing files are not re-hashed (documented residual risk).
 */
async function requireSameClone(ctx, kit, repo, workspace, what, { fresh = false } = {}) {
  if (workspace === repo.workspace) return;
  let key = null;
  try {
    key = (await kit.resolveRepo({ ...ctx, cwd: workspace })).key;
  } catch {
    key = null;
  }
  if (key !== repo.key) {
    throw new CliError(`The workspace of ${what} (${safe(workspace, 120)}) is not part of the trusted repository ${safe(repo.workspace, 120)}.`, {
      code: "RUNNER_WORKSPACE_MISMATCH", exitCode: EXIT.TRUST,
      remediation: "Use a session or run of this repository, or run the command from the repository the workspace belongs to (and trust it with `asterweave trust grant`).",
    });
  }
  // Same clone is not the same trust: claude reads the workspace's own .claude/settings*.json and .mcp.json. A worktree created by this very
  // command starts from the trusted tree, so only an EXISTING worktree (a session's, a run's) needs a trust grant of its own (exit 4).
  if (!fresh) requireTrust(ctx, workspace);
}

function claudeSeams(deps, checked) {
  return { ...deps.claude, claudePath: checked.command, claudeArgs: checked.prefix, claudeVersion: checked.version.join(".") };
}

function makeExecutor(ctx, deps, { graph, run, dir, workspace, checked, sessionId, repoKey, providerSessionId, providerSessionModel }) {
  const options = storeOptions(ctx);
  return createClaudeExecutor({
    graph, cwd: workspace, runId: run.runId, runDir: dir, configDir: resolveUserDir(seams(ctx)), routing: configOfPinned(run.routing),
    providerSessionId: providerSessionId ?? null, ...(typeof providerSessionModel === "string" ? { providerSessionModel } : {}), ...(sessionId ? { sessionId } : {}), claude: { ...claudeSeams(deps, checked), env: ctx.env, ...(ctx.platform ? { platform: ctx.platform } : {}) },
    ...(deps.runTurn ? { runTurn: deps.runTurn } : {}), ...(deps.runnerOptions ?? {}),
    onProviderSession: sessionId ? (id) => { setProviderSession(repoKey, sessionId, id, options); } : undefined,
  });
}

async function worktreeApi(ctx) {
  if (ctx.sessionSeams?.worktree !== undefined) return ctx.sessionSeams.worktree;
  try {
    return await import("../runtime/worktree.mjs");
  } catch {
    return null;
  }
}

async function makeWorktree(ctx, kit, repo, name) {
  const api = await worktreeApi(ctx);
  if (!api || typeof api.planWorktree !== "function" || typeof api.createWorktree !== "function") throw new CliError("Worktrees are not available in this build.", { code: "WORKTREE_UNAVAILABLE", remediation: "Run without --worktree." });
  const options = storeOptions(ctx);
  for (const key of ["spawn", "exists", "signal"]) if (ctx[key] !== undefined) options[key] = ctx[key];
  const plan = await api.planWorktree({ root: repo.workspace, name, base: "HEAD", ...options });
  const made = await api.createWorktree(plan, options);
  const done = made !== null && typeof made === "object" ? made : plan;
  const baseOf = (value) => (typeof value === "string" ? value : value?.commit ?? null);
  return { path: done.path ?? plan.path, branch: done.branch ?? plan.branch ?? null, base: baseOf(done.base) ?? baseOf(plan.base), created: true };
}

const checkpoint = (repoKey, sessionId, ctx) => (result) => {
  if (!sessionId) return;
  try {
    const options = storeOptions(ctx);
    linkRun(repoKey, sessionId, { runId: result.run.runId, node: result.run.currentNode ?? null }, options);
    addCheckpoint(repoKey, sessionId, { runId: result.run.runId, node: result.run.currentNode ?? null, seq: result.seq, note: `run ${result.status}` }, options);
  } catch {
    /* the session record is a convenience; the run ledger is the source of truth */
  }
};

/** @returns {Promise<number>} exit code */
export async function startClaudeRun(ctx, rest, deps, kit) {
  for (const key of ["graph", "goal"]) {
    if (ctx.options?.[key] !== undefined) throw new UsageError(`--${key} is only for the scripted development runner; use <goal> and --workflow.`, { remediation: START_USAGE });
  }
  if (rest.length !== 1 || rest[0].trim() === "") throw new UsageError(rest.length === 0 ? "run start needs a goal." : "run start takes exactly one goal (quote it).", { remediation: START_USAGE });
  const goal = rest[0].trim();
  if (goal.length > kit.GOAL_MAX) throw new UsageError(`The goal is longer than ${kit.GOAL_MAX} characters.`, { remediation: START_USAGE });
  const workflow = stringOption(ctx, "workflow", START_USAGE) ?? "delivery";
  if (!WORKFLOWS.includes(workflow)) throw new UsageError(`Unknown workflow '${safe(workflow, 40)}'. Use one of: ${WORKFLOWS.join(", ")}.`, { remediation: START_USAGE });
  const graph = getGraph(`${workflow}@1`);
  const sessionOption = stringOption(ctx, "session", START_USAGE);
  const worktreeName = stringOption(ctx, "worktree", START_USAGE);
  if (sessionOption !== undefined && worktreeName !== undefined) throw new UsageError("Use either --session (an existing session) or --worktree (a new one), not both.", { remediation: START_USAGE });
  const runId = stringOption(ctx, "run-id", START_USAGE) ?? kit.newRunId();
  if (!isValidRunId(runId)) throw new UsageError("--run-id must be 1-64 letters, digits, '-' or '_'.", { remediation: START_USAGE });

  const repo = await kit.resolveRepo(ctx);
  requireTrust(ctx, repo.workspace); // exit 4
  const checked = await requireClaude(ctx, deps, repo.workspace); // exit 1
  const policy = loadPolicy(seams(ctx)); // exit 5 before any run directory exists
  const routing = pinRouting(routingFromEntries(resolveModelConfig(seams(ctx)).entries));

  let workspace = repo.workspace;
  let sessionId = null;
  let providerSessionId = null;
  const options = storeOptions(ctx);
  if (sessionOption !== undefined) {
    const { session } = loadSession(repo.key, sessionOption, options);
    if (session.status !== "active") throw new CliError("That session is archived.", { code: "SESSION_ARCHIVED", exitCode: EXIT.ERROR, remediation: "Start a new session, or run without --session." });
    sessionId = session.id;
    providerSessionId = session.providerSessionId;
    if (session.worktree?.path) {
      await requireSameClone(ctx, kit, repo, (ctx.fs ?? nodeFs).existsSync(session.worktree.path) ? (await kit.resolveRepo({ ...ctx, cwd: session.worktree.path })).workspace : session.worktree.path, "the session");
      workspace = (await kit.resolveRepo({ ...ctx, cwd: session.worktree.path })).workspace;
    }
  } else if (worktreeName !== undefined) {
    const worktree = await makeWorktree(ctx, kit, repo, worktreeName);
    workspace = (await kit.resolveRepo({ ...ctx, cwd: worktree.path })).workspace;
    await requireSameClone(ctx, kit, repo, workspace, "the new worktree", { fresh: true });
    const branch = worktree.branch ?? (await kit.currentBranch(ctx, workspace));
    try {
      sessionId = createSession({ repoKey: repo.key, workspace: repo.workspace, branch, worktree, title: goal.slice(0, 100), goal: goal.slice(0, 400) }, options).session.id;
    } catch (error) {
      throw new CliError(`The worktree was created at ${safe(worktree.path)} but the session could not be recorded: ${safe(error.message)}`, { code: error.code ?? "SESSION_CREATE_FAILED", remediation: "The worktree was kept; remove it yourself if you do not need it." });
    }
  }

  const hooks = loadHooks({ ...seams(ctx), repoPath: workspace });
  const branch = await kit.currentBranch(ctx, workspace);
  const created = createRunForGraph({ graph, goal, repo: { key: repo.key, realpath: workspace }, runId, policyHash: policy.policyHash, routing, ...seams(ctx) });
  if (sessionId) checkpoint(repo.key, sessionId, ctx)({ run: created.run, seq: 0, status: "created" });
  const executor = makeExecutor(ctx, deps, { graph, run: created.run, dir: created.dir, workspace, checked, sessionId, repoKey: repo.key, providerSessionId });
  return kit.drive(ctx, { ...deps, loopOptions: { stepMs: RUNNER_STEP_MS, ...deps.loopOptions }, dir: created.dir, graph, executor, policy, hooks, repo: { ...repo, workspace }, branch, run: created.run, finish: checkpoint(repo.key, sessionId, ctx) });
}

/** @returns {Promise<number>} exit code */
export async function resumeClaudeRun(ctx, rest, deps, kit) {
  const [runId, ...extra] = rest;
  if (runId === undefined) throw new UsageError("run resume needs a run id.", { remediation: RESUME_USAGE });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${safe(extra[0], 40)}'.`, { remediation: RESUME_USAGE });
  const repo = await kit.resolveRepo(ctx);
  requireTrust(ctx, repo.workspace);
  const dir = runDir(repo.key, runId, seams(ctx));
  const loaded = loadRun(dir, kit.fsOption(ctx));
  const { run } = loaded;
  const graph = kit.graphOf(run);
  const workspace = run.repo?.realpath ?? repo.workspace;
  await requireSameClone(ctx, kit, repo, workspace, "the run");
  const checked = await requireClaude(ctx, deps, workspace);
  const policy = loadPolicy(seams(ctx));
  const hooks = loadHooks({ ...seams(ctx), repoPath: workspace });
  const branch = await kit.currentBranch(ctx, workspace);
  const providerEvent = loaded.events.findLast((event) => event.type === "provider.session" && typeof event.providerSessionId === "string");
  let sessionId = null;
  try {
    sessionId = listSessions(repo.key, storeOptions(ctx)).sessions.find((session) => session.runId === runId && session.status === "active")?.id ?? null;
  } catch {
    sessionId = null;
  }
  const executor = makeExecutor(ctx, deps, { graph, run, dir, workspace, checked, sessionId, repoKey: repo.key, providerSessionId: providerEvent?.providerSessionId ?? null, providerSessionModel: providerEvent?.routeModel });
  return kit.drive(ctx, { ...deps, loopOptions: { stepMs: RUNNER_STEP_MS, ...deps.loopOptions }, dir, graph, executor, policy, hooks, repo: { ...repo, workspace }, branch, run, finish: checkpoint(repo.key, sessionId, ctx) });
}
