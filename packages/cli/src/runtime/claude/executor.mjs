// ClaudeExecutor: the loop's executor backed by headless `claude` turns (runClaudeTurn).
//
// What it does: `decide` runs ONE claude turn for the current node (prompt on stdin; node-scoped --allowedTools; the generated
// settings file that registers the PreToolUse guard hook; the provider session resumed after the first turn) and returns the
// action that the turn's FINAL fenced JSON block(s) hold. The loop validates it (validateAction), runs the guard and the hooks
// and applies it. Claude executes its own tools (Read, Edit, Bash, ...): the loop never dispatches them, and `tool` actions in
// the reply are not accepted. The hook is the only gate that runs BEFORE one of claude's own tools; allowedTools and the other
// flags are request-side settings of a claude whose behaviour is UNVERIFIED here.
//
// Untrusted: everything claude says. The reply can only propose an action; an approval is never read from it (the action
// schema has no way to grant one, and `request-approval` only creates a pending request a person answers at a terminal).
// Evidence is a CLAIM of the model: the graph still demands the evidence kinds, but nothing here proves a test really passed.
//
// Failures: retryable classes advance the pinned route (routing.nextRoute) and re-run the turn, recording `route.fallback`;
// anything else throws RunnerFailure, which the loop turns into a blocked node (signature runner:<class>) with a remediation.
// An abort (ctx.signal) kills claude's process tree through runClaudeTurn and surfaces as the loop's own interrupt.

import { randomUUID } from "node:crypto";
import { redactText, sanitizeForTerminal } from "../../redact.mjs";
import { MODEL_ID_PATTERN, nextRoute, resolveRoute } from "../routing.mjs";
import { runClaudeTurn } from "./run.mjs";
import { writeRunSettings } from "./settings.mjs";

export const MAX_BLOCKS = 8;
/** The action types a reply may carry; `tool` is refused (claude runs its own tools) and anything else is unknown. */
export const ALLOWED_TYPES = Object.freeze(["evidence", "complete", "request-approval", "wait"]);
const FEEDBACK_CHARS = 1000;
const GOAL_CHARS = 2000;
const MAX_FALLBACK_TURNS = 6;

const READ_TOOLS = ["Read", "Grep", "Glob", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)"];
const EDIT_TOOLS = ["Edit", "Write", "MultiEdit"];
const TEST_TOOLS = ["Bash(npm test:*)", "Bash(npm run test:*)", "Bash(pnpm test:*)", "Bash(node --test:*)"];
const VCS_TOOLS = ["Bash(git:*)", "Bash(gh:*)"];
/** Default allowedTools by node; the PreToolUse hook still classifies every call. Override with options.allowedTools. */
export const NODE_TOOLS = Object.freeze({
  discover: [...READ_TOOLS, ...TEST_TOOLS], audit: [...READ_TOOLS, ...TEST_TOOLS], triage: READ_TOOLS, select: [...READ_TOOLS, ...TEST_TOOLS],
  "test-verify": [...READ_TOOLS, ...TEST_TOOLS], "pr-review": READ_TOOLS, "pr-prepare": [...READ_TOOLS, "Bash(git add:*)", "Bash(git commit:*)"],
  intake: READ_TOOLS, analyze: [...READ_TOOLS, ...TEST_TOOLS], challenge: READ_TOOLS, plan: READ_TOOLS,
  implement: [...READ_TOOLS, ...EDIT_TOOLS, ...TEST_TOOLS], test: [...READ_TOOLS, ...TEST_TOOLS], verify: [...READ_TOOLS, ...TEST_TOOLS], review: READ_TOOLS,
  "submit-pr": [...READ_TOOLS, ...VCS_TOOLS], "monitor-pipeline": [...READ_TOOLS, ...VCS_TOOLS], "resolve-review-comments": [...READ_TOOLS, ...EDIT_TOOLS, ...VCS_TOOLS], "update-work-item": [...READ_TOOLS, ...VCS_TOOLS],
});
const OBJECTIVES = {
  discover: "Discover repository identity, branch and commit, license, setup, contribution guidance and tooling; run the existing checks for a baseline (do not change files).",
  audit: "Audit the relevant code and user journeys. Report findings with evidence; mark scanner output as suspected until assessed (do not change files).",
  triage: "Triage the findings: duplicates, reproduction status, scope, dependencies, acceptance criteria and a fixability decision (do not change files).",
  select: "Select one bounded task, define acceptance criteria and record its reproduction before any change.",
  "test-verify": "Run the focused and repository-required checks and report real results; a check that cannot run is blocked, not passed.",
  "pr-review": "Review the complete diff for correctness, security and accidental changes.",
  "pr-prepare": "Prepare the contribution package locally: focused diff, PR title and body, validation summary. Do not push or open a pull request.",
  intake: "Understand the goal and restate the task.", analyze: "Inspect the repository and capture a baseline (do not change files).", challenge: "Challenge the requirements: gaps, risks, ambiguity.",
  plan: "Write a plan for the change (do not change files).", implement: "Make the change described by the approved plan.", test: "Run the unit and integration tests and report the real results.",
  verify: "Check the change against the acceptance criteria.", review: "Review the change for code quality and security.", "submit-pr": "Prepare the pull request.",
  "monitor-pipeline": "Check the pipeline result.", "resolve-review-comments": "Resolve the review comments.", "update-work-item": "Update the work item.",
};

/** A turn failed in a way the run cannot continue from by itself. `class` is a classify.mjs failure class. */
export class RunnerFailure extends Error {
  constructor({ class: failureClass, message, remediation, retryable }) {
    super(message);
    this.name = "RunnerFailure";
    this.class = failureClass;
    this.remediation = remediation;
    this.retryable = retryable === true;
  }
}

const clean = (value, max) => redactText(sanitizeForTerminal(String(value ?? ""))).text.slice(0, max);

/**
 * The trailing group of fenced code blocks of a reply (blocks separated only by whitespace, the last one ending the text).
 * Earlier blocks (examples quoted in prose) are ignored. @returns {string[]} block bodies (the caller rejects more than MAX_BLOCKS).
 */
export function finalBlocks(text) {
  const source = String(text ?? "");
  const fence = /```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```/g;
  const found = [];
  for (let match = fence.exec(source); match !== null; match = fence.exec(source)) found.push({ start: match.index, end: match.index + match[0].length, body: match[1] });
  const group = [];
  let boundary = source.length;
  for (let index = found.length - 1; index >= 0; index -= 1) {
    if (source.slice(found[index].end, boundary).trim() !== "") break;
    group.unshift(found[index]);
    boundary = found[index].start;
  }
  return group.map((block) => block.body.trim());
}

/** The prompt of one turn (stdin). The `Node:` / `Required evidence:` lines are a contract the fake claude of the tests parses. */
export function buildPrompt(observation, graphNode) {
  const evidence = graphNode?.evidence ?? [];
  const lines = [
    "You are working on one stage of an Asterweave run. Do the work with your own tools, then report.",
    "",
    `Node: ${observation.node}`,
    `Attempt: ${observation.attempt}`,
    `Goal: ${clean(observation.goal, GOAL_CHARS)}`,
    `Objective: ${observation.objective}`,
    `Required evidence: ${evidence.length > 0 ? evidence.join(", ") : "none"}`,
    ...(graphNode?.produces ? [`Artifact evidence needing sha256: ${graphNode.produces}`] : []),
    ...(observation.feedback ? ["", `Feedback on your last reply (fix this): ${clean(observation.feedback, FEEDBACK_CHARS)}`] : []),
    "",
    "Finish your reply with ONLY fenced json blocks, one JSON action object per block, nothing after them:",
    '  {"v":1,"type":"evidence","evidence":{"kind":"<kind>","summary":"<what you verified>","result":"pass|fail|info"}}  (one per required kind; add "sha256" for the artifact kind)',
    '  then {"v":1,"type":"complete","outcome":"pass|fail-retryable|fail-replan|blocked|needs-human","signature":"<short reason when not pass>"}',
    "Only evidence, complete, request-approval and wait actions are accepted; do not emit tool actions (you run tools yourself).",
    "Report evidence honestly: a failing result must say fail. You cannot approve anything; a person does that.",
  ];
  return lines.join("\n");
}

const addKnown = (sum, value) => (Number.isInteger(value) && value >= 0 ? (sum ?? 0) + value : sum);

/**
 * @param {object} options
 * @param {object} options.graph  Defined graph of the run.
 * @param {string} options.cwd  Directory claude works in (the workspace or worktree root).
 * @param {string} options.runId
 * @param {string} options.runDir  Run directory (the generated settings go in <runDir>/claude/).
 * @param {string} options.configDir  Asterweave user directory, passed to the child (ASTERWEAVE_CONFIG_DIR) for the hook.
 * @param {object|null} [options.routing]  Pinned route config (routing.configOfPinned).
 * @param {string|null} [options.providerSessionId]  Provider session to resume on the first turn.
 * @param {string} [options.providerSessionModel]  Route model that session was created under (provider.session.routeModel); another model starts afresh.
 * @param {string} [options.sessionId]  Asterweave session id (correlation only).
 * @param {object} [options.claude]  Seams for runClaudeTurn: claudePath, claudeArgs, claudeVersion, spawn, env, platform, exists, killTree.
 * @param {Function} [options.runTurn]  Replaces runClaudeTurn (tests).
 * @param {(id: string) => void} [options.onProviderSession]
 * @param {{items: {id: string, sha256: string, bytes: number}[], load: () => {mime: string, dataBase64: string}[]}} [options.attachments]  Images for the FIRST
 *   successful turn of the run only (later turns resume the provider session, which already holds them). `load` reads and verifies the stored copies.
 * @param {(ids: string[]) => void} [options.onAttachmentsSent]  Called once, after the first successful turn that carried the images.
 */
export function createClaudeExecutor(options) {
  const { graph, cwd, runId, runDir, configDir, routing = null, sessionId, claude = {}, runTurn = runClaudeTurn, onProviderSession } = options;
  const deadlineMs = options.deadlineMs ?? 10 * 60_000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  const routes = new Map();
  const queue = { key: null, items: [] };
  let providerSessionId = options.providerSessionId ?? null;
  // The route model the provider session was created under ("default" = none requested); undefined = unknown (an old record).
  let providerRouteModel = options.providerSessionModel ?? undefined;
  let settingsPath = null;
  let claudeVersion = claude.claudeVersion;
  let events = [];
  let pendingUsage = null;
  let inflight = Promise.resolve();
  let imagesPending = Array.isArray(options.attachments?.items) && options.attachments.items.length > 0;

  const routeFor = (node) => {
    if (!routes.has(node)) routes.set(node, resolveRoute({ config: routing ?? { default: null, effort: null, fallback: [], stages: {} }, node }));
    return routes.get(node);
  };
  const allowedFor = (node) => options.allowedTools?.[node] ?? NODE_TOOLS[node] ?? READ_TOOLS;

  function ensureSettings() {
    if (settingsPath !== null) return settingsPath;
    try {
      settingsPath = writeRunSettings({ runDir, platform: claude.platform, ...(options.hook ?? {}) }).path;
    } catch (error) {
      throw new RunnerFailure({ class: "invalid-request", message: `the Claude settings file could not be written: ${clean(error.message, 200)}`, remediation: "Check that the run directory is writable.", retryable: false });
    }
    return settingsPath;
  }

  function collect(result, node, routeModel) {
    for (const tool of result.toolEvents ?? []) events.push({ type: "tool.observed", node, id: tool.id, name: tool.name, inputSummary: tool.inputSummary, at: tool.at });
    events.push({ type: "runner.turn", node, ok: result.ok, class: result.error?.class ?? null, exitCode: result.exitCode, killed: result.killed, durationMs: result.durationMs ?? null, costUsd: result.costUsd, model: result.model, malformedLines: result.malformedLines, toolEventsDropped: result.toolEventsDropped ?? 0 });
    const usage = result.usage ?? {};
    const known = Object.values(usage).some((value) => value !== null && value !== undefined);
    if (known || result.model) {
      pendingUsage ??= { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheCreationTokens: null, model: null };
      pendingUsage.inputTokens = addKnown(pendingUsage.inputTokens, usage.inputTokens);
      pendingUsage.outputTokens = addKnown(pendingUsage.outputTokens, usage.outputTokens);
      pendingUsage.cacheReadTokens = addKnown(pendingUsage.cacheReadTokens, usage.cacheReadTokens);
      pendingUsage.cacheCreationTokens = addKnown(pendingUsage.cacheCreationTokens, usage.cacheCreationTokens);
      if (typeof result.model === "string" && MODEL_ID_PATTERN.test(result.model)) pendingUsage.model = result.model;
    }
    if (typeof result.claudeVersion === "string") claudeVersion = result.claudeVersion;
    if (result.providerSessionId && result.providerSessionId !== providerSessionId) {
      providerSessionId = result.providerSessionId;
      providerRouteModel = routeModel;
      events.push({ type: "provider.session", providerSessionId, routeModel });
      try { onProviderSession?.(providerSessionId); } catch { /* the session store is best effort */ }
    }
  }

  async function runWithFallback(ctx, prompt) {
    const node = ctx.node;
    for (let turns = 0; turns < MAX_FALLBACK_TURNS; turns += 1) {
      const route = routeFor(node);
      const wanted = route.model ?? "default";
      // A provider session belongs to the model it was created under: another model starts a fresh one (the prompt carries the context).
      if (providerSessionId !== null && providerRouteModel !== undefined && providerRouteModel !== wanted) {
        providerSessionId = null;
        providerRouteModel = undefined;
      }
      // While images are pending the turn ALWAYS starts a fresh provider session: images are never sent twice into one provider session.
      const resumeNow = providerSessionId !== null && !imagesPending;
      let images = null;
      if (imagesPending) {
        try {
          images = options.attachments.load();
        } catch (error) {
          throw new RunnerFailure({ class: "invalid-request", message: `the attached images could not be read: ${clean(error.message, 200)}`, remediation: "Check the session's attachments (asterweave session show), or detach the image and attach it again.", retryable: false });
        }
      }
      const turnOptions = {
        prompt, cwd, deadlineMs, maxOutputBytes, signal: ctx.signal,
        ...(route.model ? { model: route.model } : {}), ...(route.effort ? { effort: route.effort } : {}),
        permissionMode: "default", allowedTools: allowedFor(node), settingsPath: ensureSettings(),
        extraEnv: { ASTERWEAVE_RUN_ID: runId, ...(sessionId ? { ASTERWEAVE_SESSION_ID: sessionId } : {}), ASTERWEAVE_CONFIG_DIR: configDir },
        ...claude, ...(claudeVersion === undefined ? {} : { claudeVersion }),
        ...(resumeNow ? { resume: providerSessionId } : { sessionId: randomUUID() }),
        ...(images ? { images } : {}),
      };
      const turn = runTurn(turnOptions);
      const result = await turn;
      collect(result, node, wanted);
      if (images) {
        const items = options.attachments.items;
        events.push({ type: "attachments.sent", node, count: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0), turnOk: result.ok === true, sha256: items.map((item) => item.sha256.slice(0, 12)).join(",") });
      }
      if (images && !result.ok) {
        providerSessionId = null; // the failed turn may have put the images into its provider session: never resume it
        providerRouteModel = undefined;
      }
      if (result.ok) {
        if (images) {
          imagesPending = false;
          try { options.onAttachmentsSent?.(options.attachments.items.map((item) => item.id)); } catch { /* the session record is best effort */ }
        }
        return result;
      }
      if (ctx.signal?.aborted) {
        // Interrupted (user) or past the step deadline: the turn's records are already collected above; stop here, no fallback.
        if (ctx.signal.reason?.name === "TimeoutError") throw new RunnerFailure({ class: "timeout", message: "the step deadline was exceeded", remediation: "Raise the deadline or retry.", retryable: false });
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }
      const failure = result.error;
      if (failure.retryable) {
        const next = nextRoute(route, { class: failure.class });
        if (next.advanced) {
          events.push({ ...next.event, node });
          routes.set(node, next.route);
          providerSessionId = null; // a different model starts a fresh provider session; the prompt carries the whole context
          continue;
        }
      }
      throw new RunnerFailure(failure);
    }
    throw new RunnerFailure({ class: "unknown", message: "too many fallback turns", remediation: "Check the model fallback list.", retryable: false });
  }

  return {
    id: "claude",
    /** The loop counts the tool calls claude reports (tool.observed) against the toolCalls budget. */
    observesTools: true,
    async observe(ctx) {
      const node = graph.nodes[ctx.node];
      return { node: ctx.node, attempt: ctx.attempt, step: ctx.step, goal: ctx.goal, feedback: ctx.feedback ?? null, objective: OBJECTIVES[ctx.node] ?? "Complete this stage.", evidence: node?.evidence ?? [] };
    },
    async decide(ctx, observation) {
      const key = `${ctx.node}#${ctx.attempt}`;
      if (ctx.feedback) queue.items = []; // the last reply was rejected: ask again, do not replay the rest of it
      if (queue.key === key && queue.items.length > 0) return queue.items.shift();
      queue.key = key;
      queue.items = [];
      const work = runWithFallback(ctx, buildPrompt(observation, graph.nodes[ctx.node]));
      inflight = work.catch(() => {}); // idle() waits for the whole decision, fallback turns and bookkeeping included
      const result = await work;
      const blocks = finalBlocks(result.resultText);
      if (blocks.length === 0) return "claude did not end its reply with a fenced json action block";
      if (blocks.length > MAX_BLOCKS) return `a reply may end with at most ${MAX_BLOCKS} json action blocks`;
      // EVERY block must be a known, non-tool action: one forged or unknown block rejects the whole reply (nothing is queued).
      for (const block of blocks) {
        let parsed = null;
        try { parsed = JSON.parse(block); } catch { /* handled below */ }
        const type = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && Object.hasOwn(parsed, "type") ? parsed.type : undefined;
        if (type === "tool") return "claude runs its own tools: tool actions are not accepted, report evidence instead";
        if (typeof type !== "string" || !ALLOWED_TYPES.includes(type)) return "every final json block must be an evidence, complete, request-approval or wait action";
      }
      queue.items = blocks.slice(1);
      return blocks[0];
    },
    usage() {
      const report = pendingUsage;
      pendingUsage = null;
      if (report === null) return null;
      return { ...report };
    },
    drainEvents() {
      const out = events;
      events = [];
      return out;
    },
    /** Resolves when the last claude turn has ended (its process tree is gone). */
    async idle() { await inflight; },
    get providerSessionId() { return providerSessionId; },
    get claudeVersion() { return claudeVersion; },
  };
}
