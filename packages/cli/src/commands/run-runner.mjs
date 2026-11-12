// `run start <goal>` and `run resume <runId>` with the Claude runner (the public path). Called from run.mjs, which passes its helpers in
// `kit` (no import cycle). The scripted fake executor path stays in run.mjs behind ASTERWEAVE_DEV_EXECUTORS=1; it uses the same memory
// wiring (startMemory, memoryInfoOf, withMemoryFinish, exported here) through attachMemory, so dev runs capture and inject identically.
//
// Before anything is created: the repository must be trusted (exit 4), claude must be installed and recent enough (exit 1 with a
// remediation), the policy and routing configuration must load (exit 5). Then the run is created, optionally linked to a session
// (`--session`) or given its own session and an isolated worktree (`--worktree`), and driven by the loop with a ClaudeExecutor.
// Claude runs its own tools: the PreToolUse hook (generated settings) is the only gate before them; see website/docs/cli/runner.md.

import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { resolveUserDir } from "../paths.mjs";
import { resolveMemoryConfig, resolveModelConfig } from "../config.mjs";
import { readOriginStatus } from "../repo.mjs";
import { readCloneAnchor } from "../runtime/memory/identity.mjs";
import { createMemoryPipeline } from "../runtime/memory/pipeline.mjs";
import { settingsFromEntries } from "../runtime/memory/settings.mjs";
import { checkClaude } from "../runtime/claude/run.mjs";
import { describeFailure } from "../runtime/claude/classify.mjs";
import { createClaudeExecutor } from "../runtime/claude/executor.mjs";
import { getGraph } from "../runtime/graph.mjs";
import "../runtime/graphs/index.mjs";
import { loadHooks } from "../runtime/hooks.mjs";
import { isValidRunId, loadRun, runDir } from "../runtime/ledger.mjs";
import { createRunForGraph } from "../runtime/loop.mjs";
import { initContribution } from "../runtime/contribution.mjs";
import { routeIntent } from "../runtime/skills.mjs";
import { loadPolicy } from "../runtime/policy.mjs";
import { configOfPinned, pinRouting, resolveRoute, routingFromEntries } from "../runtime/routing.mjs";
import { claimAttachments, listAttachments, markAttachmentsSent, pendingAttachmentsOf, sessionClaiming } from "../runtime/attachments.mjs";
import { IMAGE_LIMITS } from "../runtime/image-format.mjs";
import { addCheckpoint, createSession, linkRun, listSessions, loadSession, setProviderSession } from "../runtime/sessions.mjs";
import { assertTrusted } from "../trust.mjs";
import { attachInspected, attachmentViews, checkImageModel, imageModelError, imagePaths, imageSource, inspectAll, sendLines, storeOpts, storeProblemError } from "./images.mjs";
import { runtimeSeams, seams, stringOption } from "./shared.mjs";

const WORKFLOWS = ["delivery", "bugfix", "contribute", "audit", "auto"];
// Skill and authorization scope recorded for a workflow chosen by name (`auto` records what the router decided).
const WORKFLOW_SKILL = Object.freeze({ audit: { skill: "repo-audit", scope: "discovery" }, contribute: { skill: "contribute", scope: "implement" }, bugfix: { skill: "bug-fix", scope: "implement" } });
/** One claude turn may take minutes: the loop's per-step deadline is raised well above its 2 minute default. */
export const RUNNER_STEP_MS = 40 * 60_000;
export const START_USAGE = "Usage: asterweave run start <goal> [--workflow delivery|bugfix|contribute|audit|auto] [--session <id>] [--runner claude|fake] [--worktree <name>] [--image <path>]... [--json]";
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

function makeExecutor(ctx, deps, { graph, run, dir, workspace, checked, sessionId, repoKey, providerSessionId, providerSessionModel, attachments, imageSessionId, memory }) {
  const options = storeOptions(ctx);
  return createClaudeExecutor({
    graph, cwd: workspace, runId: run.runId, runDir: dir, configDir: resolveUserDir(seams(ctx)), routing: configOfPinned(run.routing),
    providerSessionId: providerSessionId ?? null, ...(typeof providerSessionModel === "string" ? { providerSessionModel } : {}), ...(sessionId ? { sessionId } : {}), claude: { ...claudeSeams(deps, checked), env: ctx.env, ...(ctx.platform ? { platform: ctx.platform } : {}) },
    ...(attachments?.length > 0 ? { attachments: imageSource(imageSessionId ?? sessionId, attachments, ctx, repoKey), onAttachmentsSent: (ids) => { markAttachmentsSent(imageSessionId ?? sessionId, ids, run.runId, storeOpts(ctx, repoKey)); } } : {}),
    ...(deps.runTurn ? { runTurn: deps.runTurn } : {}), ...(deps.runnerOptions ?? {}), ...(memory ? { memory } : {}),
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

/**
 * The memory pipeline of this run (runtime/memory/pipeline.mjs), or null when memory is off (memory.enabled = false, i.e.
 * `memory capture off`). Never throws: an unusable store or configuration is a visible degraded line, not a failed run.
 */
export async function startMemory(ctx, deps, { repo, run, workspace, branch, externalSessionId, providerContextLost }) {
  const warn = (line) => {
    if (ctx.options?.json === true) return;
    try { ctx.stderr?.write?.(`${safe(line, 400)}\n`); } catch { /* a failing stderr must not break the run or leak the open store */ }
  };
  let settings;
  try {
    settings = settingsFromEntries(resolveMemoryConfig({ ...seams(ctx), ...(ctx.userDir ? { userConfigFile: path.join(ctx.userDir, "config.json") } : {}) }).entries);
  } catch (error) {
    warn(`Memory: not used for this run: the memory settings are invalid (${safe(error.message, 160)}). Nothing of this run is saved to memory.`);
    return null;
  }
  if (settings.enabled === false) return null;
  const probeOptions = { env: ctx.env, ...(ctx.spawn ? { spawn: ctx.spawn } : {}), ...(ctx.exists ? { exists: ctx.exists } : {}), ...(ctx.platform ? { platform: ctx.platform } : {}) };
  // The identity inputs. "git could not answer" is never read as "no origin" (that would be a false changed-remote ambiguity whose
  // `resolve new` advice splits the history): memory is skipped for this run instead, with one degraded line and no ambiguity.
  let remote = null;
  let unavailable;
  if (repo.git) {
    const origin = await (deps.readOriginStatus ?? readOriginStatus)(repo.workspace, runtimeSeams(ctx));
    if (origin.state === "ok") remote = origin.origin.url;
    else if (origin.state === "failed") unavailable = `git could not read the origin remote (${safe(origin.reason, 120)})`;
  }
  // A clone without a remote is bound to its root commit(s) (a folder outside git: its inode and birth time), see identity.mjs.
  let anchor = null;
  if (unavailable === undefined && remote === null) {
    const read = await (deps.readCloneAnchor ?? readCloneAnchor)({ workspace: repo.workspace, git: repo.git === true }, { ...probeOptions, ...(ctx.fs ? { fs: ctx.fs } : {}) });
    if (read.ok) anchor = read.anchor;
    else unavailable = `the repository's identity could not be read (${safe(read.reason, 120)})`;
  }
  let model = "default";
  try { model = resolveRoute({ config: configOfPinned(run.routing), node: run.currentNode }).model ?? "default"; } catch { model = "default"; }
  // deferStart: nothing is written (and no resume note said) until the loop, holding the run lock, first uses the pipeline.
  return createMemoryPipeline({
    settings, storeOptions: { ...storeOptions(ctx), ...(ctx.loadSqlite ? { loadSqlite: ctx.loadSqlite } : {}) },
    repo: { cloneKey: repo.key, kind: repo.git ? "git-common-dir" : "directory", remote, anchor, ...(unavailable !== undefined ? { unavailable } : {}) },
    runId: run.runId, goal: run.goal, run, externalSessionId: externalSessionId ?? null, workspace, branch, model, providerContextLost, probeOptions, onDegraded: warn,
    deferStart: true, onNote: (note) => warn(`Memory: ${note}`),
    ...(ctx.memoryOwner ? { owner: ctx.memoryOwner } : {}), ...(deps.memory ?? {}),
  });
}

export const memoryInfoOf = (pipeline) => () => {
  const status = pipeline?.status();
  if (!status || status.degraded.length === 0) return null;
  return { degraded: true, saved: status.saved, failed: status.failed, reasons: status.degraded.slice(0, 5) };
};

export const withMemoryFinish = (finish, pipeline) => async (result) => {
  try { finish(result); } catch { /* see checkpoint */ }
  await pipeline?.finish(result);
};

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
  let workflow = stringOption(ctx, "workflow", START_USAGE) ?? "delivery";
  if (!WORKFLOWS.includes(workflow)) throw new UsageError(`Unknown workflow '${safe(workflow, 40)}'. Use one of: ${WORKFLOWS.join(", ")}.`, { remediation: START_USAGE });
  // `auto` is opt-in: the default stays delivery. The router is deterministic; the decision is recorded with the run.
  let recorded = WORKFLOW_SKILL[workflow] ?? null;
  if (workflow === "auto") {
    const route = routeIntent(goal);
    if (route.skill === null || route.workflow === null) {
      throw new UsageError(route.skill === null ? "No skill matches this goal; choose --workflow explicitly." : `This goal selects the ${route.skill} skill, which runs inside a session and has no workflow; choose --workflow explicitly.`, { remediation: START_USAGE });
    }
    workflow = route.workflow;
    recorded = { skill: route.skill, scope: route.scope };
  }
  const graph = getGraph(`${workflow}@1`);
  const sessionOption = stringOption(ctx, "session", START_USAGE);
  const worktreeName = stringOption(ctx, "worktree", START_USAGE);
  if (sessionOption !== undefined && worktreeName !== undefined) throw new UsageError("Use either --session (an existing session) or --worktree (a new one), not both.", { remediation: START_USAGE });
  const runId = stringOption(ctx, "run-id", START_USAGE) ?? kit.newRunId();
  if (!isValidRunId(runId)) throw new UsageError("--run-id must be 1-64 letters, digits, '-' or '_'.", { remediation: START_USAGE });
  // Images are explicit (--image, repeatable) and every file is validated here, before a trust check, a session or any child process.
  const inspectedImages = inspectAll(imagePaths(ctx, START_USAGE), ctx);

  const repo = await kit.resolveRepo(ctx);
  requireTrust(ctx, repo.workspace); // exit 4
  const checked = await requireClaude(ctx, deps, repo.workspace); // exit 1
  const policy = loadPolicy(seams(ctx)); // exit 5 before any run directory exists
  const routing = pinRouting(routingFromEntries(resolveModelConfig(seams(ctx)).entries));

  // The routed model of the FIRST node must list image input in the static catalog (unknown or unset model: a warning, images still sent).
  let imageCheck = null;
  const checkModel = () => {
    imageCheck ??= checkImageModel({ routing, node: graph.start, catalog: deps.catalog });
    if (imageCheck.refused.length > 0) throw imageModelError(imageCheck.refused);
  };
  if (inspectedImages.length > 0) checkModel();

  let workspace = repo.workspace;
  let sessionId = null;
  let providerSessionId = null;
  const options = storeOptions(ctx);
  if (sessionOption !== undefined) {
    const { session } = loadSession(repo.key, sessionOption, options);
    if (session.status !== "active") throw new CliError("That session is archived.", { code: "SESSION_ARCHIVED", exitCode: EXIT.ERROR, remediation: "Start a new session, or run without --session." });
    sessionId = session.id;
    providerSessionId = session.providerSessionId;
    // Early refusals, before anything is created (the list that is finally SENT is re-checked after the images are stored, below).
    // Images attached earlier and not sent yet (and not claimed by another open run) go with this run's first turn.
    const staged = pendingAttachmentsOf(session.attachments, repo.key, storeOpts(ctx, repo.key));
    if (staged.length > 0) checkModel();
    const known = new Set(session.attachments.map((item) => item.sha256));
    const added = new Set(inspectedImages.map((item) => item.result.image.sha256));
    for (const item of staged) added.add(item.sha256);
    if (added.size > IMAGE_LIMITS.perMessage) throw new UsageError(`This run would send ${added.size} images; at most ${IMAGE_LIMITS.perMessage} fit in one message.`, { code: "TOO_MANY", remediation: "Detach some with: asterweave session detach <id> <attachmentId>" });
    const fresh = new Set(inspectedImages.map((item) => item.result.image.sha256).filter((sha) => !known.has(sha)));
    if (session.attachments.length + fresh.size > IMAGE_LIMITS.perSession) throw new UsageError(`The session would hold more than ${IMAGE_LIMITS.perSession} images.`, { code: "TOO_MANY", remediation: "Detach some with: asterweave session detach <id> <attachmentId>" });
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

  const branch = await kit.currentBranch(ctx, workspace);
  const hooks = loadHooks({ ...seams(ctx), repoPath: workspace });
  // The run is created FIRST: a duplicate --run-id (or any ledger error) leaves no session and no stored image copy behind.
  const created = createRunForGraph({ graph, goal, repo: { key: repo.key, realpath: workspace }, runId, policyHash: policy.policyHash, routing, ...seams(ctx) });
  if (recorded) initContribution(created.dir, { skill: recorded.skill, workflow, objective: goal, level: recorded.scope }); // the scope comes from the command, never from repository text
  let attachments = [];
  const heldWarnings = [];
  try {
    if (inspectedImages.length > 0 && sessionId === null) {
      // the session store holds the attachment copies, so an image run always has a session
      try {
        sessionId = createSession({ repoKey: repo.key, workspace: repo.workspace, branch, title: goal.slice(0, 100), goal: goal.slice(0, 400) }, options).session.id;
      } catch (error) {
        throw new CliError(`The session that holds the images could not be recorded: ${safe(error.message)}`, { code: error.code ?? "SESSION_CREATE_FAILED", remediation: "Check that the Asterweave user directory is writable." });
      }
    }
    if (sessionId !== null) {
      const store = storeOpts(ctx, repo.key);
      let named = [];
      if (inspectedImages.length > 0) {
        const attached = attachInspected(sessionId, inspectedImages, ctx, repo.key); // all or nothing
        if (attached.problem) throw storeProblemError(attached.problem, "Detach an image first (asterweave session detach), or send fewer images.");
        named = attached.attachments.map((item) => item.id);
      }
      // The list that will ACTUALLY be sent is read once, here; the model check and the per-message cap are applied to it.
      const all = (deps.imageStore?.listAttachments ?? listAttachments)(sessionId, store);
      const pending = new Set(pendingAttachmentsOf(all, repo.key, store).map((item) => item.id));
      attachments = all.filter((item) => pending.has(item.id) || named.includes(item.id));
      if (attachments.length > IMAGE_LIMITS.perMessage) throw new UsageError(`This run would send ${attachments.length} images; at most ${IMAGE_LIMITS.perMessage} fit in one message.`, { code: "TOO_MANY", remediation: "Detach some with: asterweave session detach <id> <attachmentId>" });
      if (attachments.length > 0) {
        checkModel();
        // Claimed before the first turn (cannot be detached while this run is open); compare-and-set: an image held by ANOTHER open run is skipped unless named.
        const claimed = claimAttachments(sessionId, attachments.map((item) => item.id), runId, { ...store, explicit: named });
        if (!claimed.ok) throw storeProblemError(claimed.problems[0]);
        if (claimed.skipped.length > 0) {
          const holders = [...new Set(claimed.skipped.map((item) => item.heldBy))].join(", ");
          heldWarnings.push(`${claimed.skipped.length} staged image(s) are held by open run ${holders} and are not sent with this run`);
          const got = new Set(claimed.claimed);
          attachments = attachments.filter((item) => got.has(item.id));
        }
      }
    }
  } catch (error) {
    throw withRunHint(error, runId);
  }
  if (sessionId) checkpoint(repo.key, sessionId, ctx)({ run: created.run, seq: 0, status: "created" });
  const imageInfo = announceImages(ctx, attachments, imageCheck, heldWarnings);
  const memory = await startMemory(ctx, deps, { repo, run: created.run, workspace, branch, externalSessionId: sessionId, providerContextLost: providerSessionId === null || attachments.length > 0 });
  try {
    const executor = makeExecutor(ctx, deps, { graph, run: created.run, dir: created.dir, workspace, checked, sessionId, repoKey: repo.key, providerSessionId, attachments, memory });
    return await kit.drive(ctx, { ...deps, loopOptions: { stepMs: RUNNER_STEP_MS, ...deps.loopOptions, ...(memory ? { onCommitted: memory.onCommitted } : {}) }, dir: created.dir, graph, executor, policy, hooks, repo: { ...repo, workspace }, branch, run: created.run, finish: withMemoryFinish(checkpoint(repo.key, sessionId, ctx), memory), imageInfo, memoryInfo: memoryInfoOf(memory) });
  } finally {
    memory?.close();
  }
}

/** The run exists already when an image step fails after it: say how to get rid of it (the error keeps its code and exit code). */
function withRunHint(error, runId) {
  if (!(error instanceof CliError)) throw error;
  return new CliError(error.message, { code: error.code, exitCode: error.exitCode, remediation: `${error.remediation ?? "Fix the problem."} The run ${runId} was created but never started; abort it with: asterweave run abort ${runId} --yes` });
}

/** Print exactly what will be sent BEFORE the first turn (text mode) and return the summary for the JSON result. */
function announceImages(ctx, attachments, check, extraWarnings = []) {
  if (attachments.length === 0 && extraWarnings.length === 0) return undefined;
  const info = { views: attachmentViews(attachments), warnings: [...(check?.warnings ?? []), ...extraWarnings] };
  if (ctx.options?.json !== true) {
    if (attachments.length > 0) ctx.stdout.write(`${sanitizeLines(sendLines(attachments))}\n`);
    for (const warning of info.warnings) ctx.stderr?.write?.(`Warning: ${safe(warning, 300)}\n`);
  }
  return info;
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
  // Images this run CLAIMED but never got to send (its first turn failed or the run was interrupted) go with the first turn of the resume.
  // A successful attachments.sent in the ledger means they were delivered: nothing is sent again.
  let attachments = [];
  // The session that holds the claimed images may no longer be the one linked to this run (a later run in it re-linked the session).
  let imageSessionId = null;
  try {
    imageSessionId = sessionClaiming(repo.key, runId, storeOptions(ctx));
  } catch {
    imageSessionId = null;
  }
  if (imageSessionId !== null && !loaded.events.some((event) => event.type === "attachments.sent" && event.turnOk === true)) {
    attachments = (deps.imageStore?.listAttachments ?? listAttachments)(imageSessionId, storeOpts(ctx, repo.key)).filter((item) => item.sentRunId === null && item.claimedRunId === runId);
  }
  let imageCheck = null;
  if (attachments.length > 0) {
    imageCheck = checkImageModel({ routing: run.routing, node: run.currentNode, catalog: deps.catalog });
    if (imageCheck.refused.length > 0) throw imageModelError(imageCheck.refused);
  }
  const imageInfo = announceImages(ctx, attachments, imageCheck);
  const memory = await startMemory(ctx, deps, { repo, run, workspace, branch, externalSessionId: sessionId, providerContextLost: !providerEvent || attachments.length > 0 });
  try {
    const executor = makeExecutor(ctx, deps, { graph, run, dir, workspace, checked, sessionId, repoKey: repo.key, providerSessionId: providerEvent?.providerSessionId ?? null, providerSessionModel: providerEvent?.routeModel, attachments, imageSessionId, memory });
    return await kit.drive(ctx, { ...deps, loopOptions: { stepMs: RUNNER_STEP_MS, ...deps.loopOptions, ...(memory ? { onCommitted: memory.onCommitted } : {}) }, dir, graph, executor, policy, hooks, repo: { ...repo, workspace }, branch, run, finish: withMemoryFinish(checkpoint(repo.key, sessionId, ctx), memory), imageInfo, memoryInfo: memoryInfoOf(memory) });
  } finally {
    memory?.close();
  }
}
