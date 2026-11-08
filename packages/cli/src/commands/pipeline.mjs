// `asterweave pipeline status|watch|diagnose <pr>`: PR + pipeline monitoring and the closable verdict.
//
// ZERO model calls: nothing here (or under runtime/pipeline) imports the Claude runner or spawns `claude`; a test enforces both. Polling only
// (no webhooks, no server), online only. Everything fixture-tested against a fake GitHub; live GitHub is UNVERIFIED (see pipeline.md).
//
//   status   <pr> [--repo owner/name] [--refresh] [--json]   read the recorded state (--refresh does ONE poll first); exit 0
//   watch    <pr> [--repo] [--timeout 30m] [--interval 15s] [--run runId] [--json]
//                 poll until a terminal verdict, the time cap, an attempt cap or a rate limit that outlasts the cap.
//                 exit 0 closable · 1 any other verdict (machine-readable `verdict`) or a timeout (verdict "waiting") · 130 interrupted (state stays resumable)
//   diagnose <pr> [--repo] [--check key] [--json]            EXPLICIT, read-only: a bounded diagnosis packet for the failing checks. Printed only, never sent
//                 anywhere; no rerun, no remediation, no model call. Handing it to a run is the user's decision.
//
// Exit codes: 0 ok · 1 not closable / error · 2 usage · 3 GitHub sign-in · 5 configuration invalid / newer state · 130 interrupted.

import * as nodeFs from "node:fs";
import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { runBinary } from "../proc.mjs";
import { sanitizeForTerminal, sanitizeLines } from "../redact.mjs";
import { gitEnv, resolveCloneOrigin } from "../repo.mjs";
import { runDir } from "../runtime/ledger.mjs";
import { createGithubTools } from "../runtime/tools/github-api.mjs";
import { asCliError, watchPipeline, pollOnce, rethrowFatal } from "../runtime/pipeline/poll.mjs";
import { loadRequiredChecks } from "../runtime/pipeline/required.mjs";
import { assertRunExists, recordToRun, targetProblem } from "../runtime/pipeline/run-link.mjs";
import { unionRequired, applyObservations, applyPull, evaluate, initialState, matches, matchesLoose, normalizeCheck, normalizePull, normalizeRun, safeText } from "../runtime/pipeline/state.mjs";
import { loadPipeline, openPipelineSession, parseRepoSlug, pipelineDir } from "../runtime/pipeline/store.mjs";
import { createTokenReader } from "../runtime/pipeline/token.mjs";
import { interruptSignal, resolveHost, seams, stringOption } from "./shared.mjs";

export const pipelineCommandMeta = Object.freeze({
  summary: "Monitor a pull request and its pipeline; closable verdict; explicit diagnosis (no model calls)",
  boolean: ["json", "refresh"],
  options: ["json", "refresh", "repo", "timeout", "interval", "run", "check"],
});

const USAGE = "Usage: asterweave pipeline status <pr> [--repo owner/name] [--refresh] [--json] | watch <pr> [--repo owner/name] [--timeout 30m] [--interval 15s] [--run <runId>] [--json] | diagnose <pr> [--repo owner/name] [--check <key>] [--json]";

export const pipelineHelpText = `${[
  "asterweave pipeline - pull request and pipeline monitoring (polling only, read-only, no model calls)",
  "",
  USAGE,
  "",
  "  status    print the recorded state and the closable verdict of a pull request; --refresh does ONE poll first",
  "  watch     poll GitHub until the verdict is terminal (closable, failed, cancelled, not-passed, run-not-detected, missing-configuration,",
  "            closed-unmerged), the --timeout (default 30m) or the attempt cap is reached, or you press Ctrl-C (exit 130; the state stays resumable).",
  "            Delays grow with jitter from --interval (default 15s, 5s-120s) to 120s; Retry-After and rate-limit resets are honoured; a",
  "            rate limit is reported as state rate-limited with resumeAt, not as a failure. --run links the verdict to a run's ledger.",
  "  diagnose  explicit, read-only diagnosis packet: failing checks, jobs and step names, bounded check output, changed file names, acceptance",
  "            criteria from the PR body. It is printed and sent nowhere; Asterweave never reruns, fixes or starts a model for you.",
  "            Handing it to a run is your decision, e.g.: asterweave run start --workflow bugfix \"<goal>\"",
  "",
  "A pull request is closable only when it is MERGED and every required check (and deployment check, when configured) PASSED on the resulting",
  "target-branch commit. skipped and neutral do not count unless listed under allowSkipped; absence of a run is never success.",
  "Required checks: pipeline.json in the Asterweave user directory, the trusted repository adapter completion.requiredChecks, and the branch",
  "protection of the base branch (when readable; an unreadable source fails closed: never closable). A key is a workflow FILE (ci.yml) or an exact",
  "check name, never a workflow name. Only push runs count for the merge commit unless the policy sets trigger. None configured => missing-configuration.",
  "See website/docs/cli/pipeline.md.",
  "Credential: the GitHub CLI (gh auth token -h <host>); the token is never printed, logged or stored. Live GitHub behaviour is unverified.",
  "",
  "JSON (stable): { ok, repo, host, prNumber, verdict, closable, pr, target, keys: [{ key, role, stage, state, reason, satisfied, runId, attempt, conclusion,",
  "  url, updatedAt, workflow }], preMerge, blockers: [{ key, state, reason, remediation? }], counters, poll: { status, count, lastPolledAt, resumeAt,",
  "  rateLimit }, policy, links }. watch adds status (terminal|timeout|attempts|rate-limited|aborted), attempts, resumeAt, runLink; ok is true only when closable.",
  "Exit codes: 0 ok / closable · 1 not closable, error · 2 usage · 3 sign-in · 5 configuration · 130 interrupted",
].join("\n")}\n`;

const FLAGS = { status: ["json", "repo", "refresh"], watch: ["json", "repo", "timeout", "interval", "run"], diagnose: ["json", "repo", "check"] };
const write = (stream, text) => stream.write(text);
const safe = (text, limit = 200) => sanitizeForTerminal(String(text ?? "")).slice(0, limit);

function check(ctx, sub, positionals, max) {
  const allowed = new Set(FLAGS[sub]);
  for (const key of Object.keys(ctx.options ?? {})) {
    if (!allowed.has(key)) throw new UsageError(`Option --${safe(key, 40)} does not apply to 'pipeline ${sub}'.`, { remediation: USAGE });
  }
  if (positionals.length > max) throw new UsageError(`Unexpected argument '${safe(positionals[max], 40)}'.`, { remediation: USAGE });
}

function duration(text, name, low, high) {
  const match = /^(\d{1,6})(ms|s|m|h)?$/.exec(String(text));
  const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  const ms = match ? Number(match[1]) * unit[match[2] ?? "s"] : NaN;
  if (!(ms >= low && ms <= high)) throw new UsageError(`--${name} must be a duration such as 30s, 5m or 2h between ${low / 1000}s and ${high / 1000}s.`, { remediation: USAGE });
  return ms;
}

// Target ---------------------------------------------------------------------------------------

async function resolveTarget(ctx) {
  const prText = ctx.positionals[1];
  if (!/^[1-9]\d{0,8}$/.test(prText ?? "")) throw new UsageError("A pull request number is required.", { remediation: USAGE });
  const flag = stringOption(ctx, "repo", USAGE);
  let found = null;
  try {
    found = await resolveCloneOrigin(ctx.cwd ?? process.cwd(), { env: ctx.env, spawn: ctx.spawn, exists: ctx.exists, platform: ctx.platform, homedir: ctx.homedir, timeoutMs: ctx.timeoutMs });
  } catch {
    found = null;
  }
  const origin = found?.origin?.github ?? null;
  let slug;
  let repoPath = null;
  if (flag !== undefined) {
    slug = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(flag) ? parseRepoSlug(flag) : null;
    if (slug === null) throw new UsageError("--repo must look like owner/name.", { remediation: USAGE });
    // The local clone is used (adapter lookup) only when it really is this repository.
    if (origin && origin.nameWithOwner.toLowerCase() === slug.full.toLowerCase()) repoPath = found.root;
  } else {
    slug = origin ? parseRepoSlug(origin.nameWithOwner) : null;
    if (slug === null) throw new UsageError("Cannot tell which repository to use (this directory has no GitHub origin remote); pass --repo owner/name.", { remediation: "Pass --repo owner/name, or run the command inside a clone." });
    repoPath = found.root;
  }
  return { host: resolveHost(ctx), slug, repoPath, pr: Number(prText) };
}

const nowMsOf = (ctx) => ctx.pipelineSeams?.nowMs ?? Date.now;
const isoClock = (ctx) => () => new Date(nowMsOf(ctx)()).toISOString();
const fsOf = (ctx) => (ctx.fs === undefined ? {} : { fs: ctx.fs });

function makeClient(ctx, host) {
  const injected = ctx.pipelineSeams ?? {};
  const reader = injected.getToken ? null : createTokenReader({ host, env: ctx.env, spawn: ctx.spawn, exists: ctx.exists, platform: ctx.platform });
  const tools = createGithubTools({ host, getToken: injected.getToken ?? reader.get, fetch: injected.fetch ?? globalThis.fetch, now: nowMsOf(ctx) });
  return { client: tools.client, ensure: async () => (reader ? reader.ensure() : undefined) };
}

const sleepOf = (ctx) =>
  ctx.pipelineSeams?.sleep ??
  ((ms, signal) =>
    new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", done); // no listener piles up on a long watch
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener?.("abort", done, { once: true });
    }));

/** Open the writer (lock), load the required checks and record them. */
async function prepare(ctx, target, dir, signal) {
  const { client, ensure } = makeClient(ctx, target.host);
  await ensure();
  const existing = loadPipeline(dir, fsOf(ctx));
  let baseBranch = existing.state?.pr.baseBranch ?? null;
  if (baseBranch === null) {
    try {
      baseBranch = normalizePull((await client.pull({ owner: target.slug.owner, repo: target.slug.name, number: target.pr }, signal)).body)?.baseRef ?? null;
    } catch (error) {
      rethrowFatal(error, nowMsOf(ctx)()); // sign-in, not found, forbidden, interrupted
      baseBranch = null; // transient: the required-check set is then reported as unavailable, never as complete
    }
  }
  const loaded = await loadRequiredChecks({ repo: target.slug, baseBranch, repoPath: target.repoPath, client, signal, ...seams(ctx) }).catch((error) => {
    if (error?.code === "TOOL_ABORTED" || signal?.aborted) throw new CliError("Interrupted.", { code: "INTERRUPTED", exitCode: EXIT.INTERRUPTED });
    throw error;
  });
  const session = openPipelineSession(dir, { repo: target.slug.full, host: target.host, prNumber: target.pr }, { ...fsOf(ctx), now: isoClock(ctx) });
  let policy = loaded.policy;
  let sources = loaded.sources;
  try {
    const recorded = session.state.policy;
    const fingerprint = (p) => [p.required.join("|"), p.allowSkipped.join("|"), p.deployment.join("|"), p.detectionWindowMs, p.trigger, (p.pins ?? []).map((pin) => `${pin.key}=${pin.appId}`).join("|"), p.incomplete ?? ""].join("#");
    // If branch protection was part of the RECORDED set it can only leave the set through a successful read (or by the user editing pipeline.json):
    // a 403 / 404 / error now keeps its recorded contexts and pins and marks the set unavailable. User and adapter edits still apply.
    const prevProtection = recorded?.sources?.find((item) => item.source === "branch-protection" && item.used === true) ?? null;
    const nowProtection = loaded.sources.find((item) => item.source === "branch-protection");
    let unavailable = loaded.unavailable;
    if (prevProtection !== null && nowProtection?.used !== true) {
      unavailable = unavailable ?? "branch-protection-unreadable";
      const pins = [...(loaded.policy.pins ?? [])];
      for (const pin of recorded.pins ?? []) if (!pins.some((item) => item.key === pin.key)) pins.push(pin);
      policy = { ...loaded.policy, required: unionRequired(loaded.policy.required, prevProtection.contexts ?? []), pins };
      sources = loaded.sources.map((item) => (item.source === "branch-protection" ? { ...prevProtection } : item));
    }
    if (!recorded || fingerprint(recorded) !== fingerprint({ ...policy, incomplete: unavailable })) session.append({ type: "policy", policy, sources, incomplete: unavailable });
    policy = { ...policy, incomplete: unavailable };
  } catch (error) {
    session.close();
    throw error;
  }
  return { client, session, policy: { ...policy, unavailable: policy.incomplete ?? null }, sources };
}

// Output ---------------------------------------------------------------------------------------

function report(target, state, evaluation, sources) {
  return {
    repo: target.slug.full,
    host: target.host,
    prNumber: target.pr,
    verdict: evaluation.verdict,
    closable: evaluation.closable,
    unavailable: evaluation.unavailable ?? null,
    pr: evaluation.pr,
    target: evaluation.target,
    keys: evaluation.keys,
    preMerge: evaluation.preMerge,
    blockers: evaluation.blockers,
    counters: evaluation.counters,
    poll: { status: state.poll.status, count: state.poll.count, lastPolledAt: state.poll.lastPolledAt, lastSuccessAt: state.poll.lastSuccessAt, resumeAt: state.poll.resumeAt, consecutiveErrors: state.poll.consecutiveErrors, rateLimit: state.poll.rateLimit },
    policy: state.policy ? { required: state.policy.required, allowSkipped: state.policy.allowSkipped, deployment: state.policy.deployment, detectionWindowMs: state.policy.detectionWindowMs, trigger: state.policy.trigger, sources: sources ?? state.policy.sources } : null,
    links: state.links,
  };
}

const short = (sha) => (sha ? sha.slice(0, 8) : "unknown");

function textReport(payload) {
  const lines = [
    `Pull request ${payload.repo}#${payload.prNumber}: ${payload.pr.state}${payload.pr.baseBranch ? ` (base ${payload.pr.baseBranch})` : ""}, head ${short(payload.pr.headSha)}${payload.pr.mergeCommitSha ? `, merge commit ${short(payload.pr.mergeCommitSha)}` : ""}`,
    `Verdict: ${payload.verdict}${payload.closable ? " (closable)" : " (NOT closable)"}`,
    "",
    "Required checks on the target commit (post-merge):",
    ...(payload.keys.length === 0 ? ["  none configured"] : payload.keys.map((k) => `  ${k.key}  ${k.state}${k.attempt ? `  attempt ${k.attempt}` : ""}${k.runId ? `  run ${k.runId}` : ""}${k.reason && k.state !== "passed" ? `  (${k.reason})` : ""}`)),
  ];
  if (payload.preMerge.length > 0) lines.push("", "Pre-merge (PR head):", ...payload.preMerge.map((k) => `  ${k.key}  ${k.state}`));
  if (payload.blockers.length > 0) {
    lines.push("", "Blockers:");
    for (const b of payload.blockers) lines.push(`  - ${b.key}: ${b.state}${b.reason ? ` (${b.reason})` : ""}`, ...(b.remediation ? [`    ${b.remediation}`] : []));
  }
  const rate = payload.poll.rateLimit;
  lines.push("", `Poll: ${payload.poll.status}, ${payload.poll.count} poll(s), last ${payload.poll.lastPolledAt ?? "never"}${payload.poll.resumeAt ? `, resumes at ${payload.poll.resumeAt}` : ""}${rate && rate.remaining !== null ? `, rate limit ${rate.remaining}/${rate.limit ?? "?"}` : ""}`);
  const c = payload.counters;
  lines.push(`Events: ${c.observed} applied, ${c.duplicates} duplicate, ${c.outOfOrder} out of order, ${c.superseded} superseded by a rerun, ${c.foreign} for other commits`);
  return lines;
}

const emit = (ctx, payload, extra = {}) => {
  if (ctx.options?.json === true) write(ctx.stdout, `${stringifyJson({ ok: payload.ok ?? true, ...payload, ...extra })}\n`);
  else write(ctx.stdout, `${sanitizeLines(textReport(payload))}\n`);
};

// status ---------------------------------------------------------------------------------------

async function statusCommand(ctx) {
  check(ctx, "status", ctx.positionals.slice(1), 1);
  const target = await resolveTarget(ctx);
  const dir = pipelineDir(target.host, target.slug, target.pr, seams(ctx));
  let sources;
  let refresh = null;
  if (ctx.options?.refresh === true) {
    const prepared = await prepare(ctx, target, dir, ctx.signal);
    try {
      refresh = await pollOnce({ session: prepared.session, client: prepared.client, repo: target.slug, prNumber: target.pr, policy: prepared.policy, nowMs: nowMsOf(ctx), signal: ctx.signal, reconciled: true });
    } finally {
      prepared.session.close();
    }
    sources = prepared.sources;
  }
  const loaded = loadPipeline(dir, fsOf(ctx));
  if (!loaded.exists) {
    throw new CliError(`Nothing is recorded for ${target.slug.full}#${target.pr}.`, { code: "PIPELINE_NOT_FOUND", exitCode: EXIT.ERROR, remediation: `Run: asterweave pipeline status ${target.pr} --refresh --repo ${target.slug.full}   (or: pipeline watch ${target.pr})` });
  }
  const recorded = loaded.state.policy;
  const policy = recorded ?? (await loadRequiredChecks({ repo: target.slug, baseBranch: null, repoPath: target.repoPath, ...seams(ctx) })).policy;
  const evaluation = evaluate(loaded.state, { ...policy, unavailable: policy.incomplete ?? null }, nowMsOf(ctx)());
  const failedRefresh = refresh !== null && refresh.outcome !== "ok";
  emit(ctx, { ...report(target, loaded.state, evaluation, sources), ...(failedRefresh ? { ok: false, refresh: refresh.outcome } : {}) });
  if (failedRefresh && ctx.options?.json !== true) write(ctx.stdout, `Refresh did not complete: ${refresh.outcome}${loaded.state.poll.resumeAt ? ` (resume after ${loaded.state.poll.resumeAt})` : ""}. The state above is the last one read.\n`);
  return failedRefresh ? EXIT.ERROR : EXIT.OK;
}

// watch ----------------------------------------------------------------------------------------

async function runDirectory(ctx, runId) {
  const platform = ctx.platform ?? process.platform;
  const fs = ctx.fs ?? nodeFs;
  const real = (file) => {
    try {
      return fs.realpathSync.native(file);
    } catch {
      return path.resolve(file);
    }
  };
  const cwd = real(path.resolve(ctx.cwd ?? process.cwd()));
  const flags = ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", `core.hooksPath=${platform === "win32" ? "NUL" : "/dev/null"}`, "-c", "protocol.ext.allow=never", "-c", "core.sshCommand="];
  const result = await runBinary("git", [...flags, "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, env: gitEnv(ctx.env), spawn: ctx.spawn, exists: ctx.exists, platform: ctx.platform, timeoutMs: ctx.timeoutMs ?? 15_000 });
  const line = result.error || result.code !== 0 ? "" : result.stdout.split(/\r?\n/)[0];
  const key = line ? real(line) : cwd;
  return runDir(platform === "win32" ? key.toLowerCase() : key, runId, seams(ctx));
}

const signatureOf = (evaluation) => `${evaluation.verdict}|${evaluation.keys.map((k) => `${k.key}:${k.state}:${k.attempt}`).join(",")}`;

/** The run must exist, belong to THIS repository (its workspace's origin) and not be bound to another pull request. Usage error (exit 2) otherwise. */
async function assertRunTarget(ctx, runPath, runId, target) {
  const loaded = assertRunExists(runPath, runId, ctx.fs);
  let origin = null;
  try {
    origin = (await resolveCloneOrigin(loaded.run.repo?.realpath ?? "", { env: ctx.env, spawn: ctx.spawn, exists: ctx.exists, platform: ctx.platform, homedir: ctx.homedir, timeoutMs: ctx.timeoutMs }))?.origin?.github ?? null;
  } catch {
    origin = null;
  }
  if (origin === null || origin.nameWithOwner.toLowerCase() !== target.slug.full.toLowerCase()) {
    throw new UsageError(`Run ${safe(runId, 64)} does not belong to ${target.slug.full} (its workspace's origin is ${origin ? origin.nameWithOwner : "unknown"}).`, { remediation: "Use --repo with the repository the run works on, or run the command from its clone." });
  }
  const problem = targetProblem(loaded, { repo: target.slug.full, prNumber: target.pr });
  if (problem !== null) throw new UsageError(`Run ${safe(runId, 64)} cannot be linked to pull request #${target.pr}: ${problem}.`, { remediation: "Link the run to the pull request it submitted." });
}

async function watchCommand(ctx) {
  check(ctx, "watch", ctx.positionals.slice(1), 1);
  const target = await resolveTarget(ctx);
  const timeoutMs = ctx.options?.timeout === undefined ? 30 * 60_000 : duration(ctx.options.timeout, "timeout", 1000, 24 * 3_600_000);
  const intervalMs = ctx.options?.interval === undefined ? 15_000 : duration(ctx.options.interval, "interval", 5000, 120_000);
  const runId = stringOption(ctx, "run", USAGE);
  const runPath = runId === undefined ? null : await runDirectory(ctx, runId);
  if (runPath !== null) await assertRunTarget(ctx, runPath, runId, target);
  const dir = pipelineDir(target.host, target.slug, target.pr, seams(ctx));
  const interrupt = interruptSignal(ctx);
  let prepared = null;
  const json = ctx.options?.json === true;
  const linkNotes = [];
  try {
    prepared = await prepare(ctx, target, dir, interrupt.signal);
    const { session, client, policy } = prepared;
    if (runId !== undefined && session.state.links.runId !== runId) session.append({ type: "link", runId });
    let lastSignature = null;
    const link = (kind, evaluation) => {
      if (runPath === null) return;
      const outcome = recordToRun(runPath, { kind, repo: target.slug.full, prNumber: target.pr, verdict: evaluation.verdict, closable: evaluation.closable, blockers: evaluation.blockers, polls: session.state.poll.count, summary: `Pipeline ${evaluation.verdict} for ${target.slug.full}#${target.pr}${evaluation.blockers.length ? `: ${evaluation.blockers.slice(0, 5).map((b) => `${b.key} ${b.state}`).join(", ")}` : ""}` }, { ...fsOf(ctx), now: isoClock(ctx) });
      if (outcome.note) linkNotes.push(outcome.note);
    };
    const result = await watchPipeline({
      session, client, repo: target.slug, prNumber: target.pr, policy, nowMs: nowMsOf(ctx), sleep: sleepOf(ctx), signal: interrupt.signal, random: ctx.pipelineSeams?.random ?? Math.random, intervalMs, timeoutMs,
      onPoll({ attempt, result: poll, verdict }) {
        const signature = signatureOf(verdict);
        if (!json) write(ctx.stdout, `${sanitizeLines([`poll ${attempt}: ${poll.outcome === "ok" ? verdict.verdict : poll.outcome}${verdict.blockers.length ? ` (${verdict.blockers.slice(0, 3).map((b) => `${b.key} ${b.state}`).join(", ")})` : ""}`])}\n`);
        if (signature !== lastSignature) {
          lastSignature = signature;
          link("observed", verdict);
        }
      },
    });
    if (result.status === "aborted") {
      if (!json) write(ctx.stdout, "Interrupted. The recorded state is kept; rerun `asterweave pipeline watch` to resume.\n");
      else write(ctx.stdout, `${stringifyJson({ ok: false, status: "aborted", verdict: result.verdict.verdict, closable: false })}\n`);
      return EXIT.INTERRUPTED;
    }
    link("verdict", result.verdict);
    const payload = { ...report(target, session.state, result.verdict, prepared.sources), ok: result.verdict.closable, status: result.status, attempts: result.attempts, ...(result.resumeAt ? { resumeAt: result.resumeAt } : {}), ...(runId !== undefined ? { runLink: { runId, notes: [...new Set(linkNotes)] } } : {}) };
    if (json) write(ctx.stdout, `${stringifyJson(payload)}\n`);
    else {
      write(ctx.stdout, `${sanitizeLines([...textReport(payload), ...(result.status === "terminal" ? [] : [`Stopped: ${result.status}${result.resumeAt ? ` (resume after ${result.resumeAt})` : ""}. The verdict is not final.`]), ...(linkNotes.length ? [`Run link: ${[...new Set(linkNotes)].join(", ")}`] : [])])}\n`);
    }
    return result.verdict.closable ? EXIT.OK : EXIT.ERROR;
  } finally {
    prepared?.session.close();
    interrupt.dispose();
  }
}

// diagnose -------------------------------------------------------------------------------------

function acceptanceCriteria(body) {
  if (typeof body !== "string") return null;
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s{0,3}#{1,6}\s*acceptance(?:\s+criteria)?\b/i.test(line));
  if (start < 0) return null;
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,6}\s/.test(line)) break;
    out.push(line);
  }
  return safeText(out.join("\n").trim(), 2048) || null;
}

async function diagnoseCommand(ctx) {
  check(ctx, "diagnose", ctx.positionals.slice(1), 1);
  const target = await resolveTarget(ctx);
  const only = stringOption(ctx, "check", USAGE);
  const { client, ensure } = makeClient(ctx, target.host);
  await ensure();
  const { owner, name: repo } = target.slug;
  // Every GitHub failure becomes a fixed-text CliError: sign-in => exit 3, not found / forbidden => exit 1, interrupted => 130.
  const guard = async (call) => {
    try {
      return await call();
    } catch (error) {
      throw asCliError(error, nowMsOf(ctx)());
    }
  };
  const raw = await guard(() => client.pull({ owner, repo, number: target.pr }, ctx.signal));
  const pull = normalizePull(raw.body);
  if (pull === null) throw new CliError("GitHub returned an unusable pull request.", { code: "PIPELINE_BAD_RESPONSE", exitCode: EXIT.ERROR });
  const now = isoClock(ctx)();
  let state = applyPull(initialState({ repo: target.slug.full, prNumber: target.pr, host: target.host, now }), pull, now);
  const shas = [...new Set([pull.merged ? pull.mergeCommitSha : null, pull.headSha].filter((sha) => sha !== null))];
  const checkRaw = new Map();
  const observations = [];
  for (const sha of shas) {
    for (const run of (await guard(() => client.runs({ owner, repo, headSha: sha }, ctx.signal))).items) observations.push(normalizeRun(run, target.host));
    for (const item of (await guard(() => client.checkRuns({ owner, repo, ref: sha }, ctx.signal))).items) {
      const normalized = normalizeCheck(item, target.host);
      if (normalized) checkRaw.set(normalized.id, item);
      observations.push(normalized);
    }
  }
  state = applyObservations(state, observations, { now }).state;
  const slots = Object.values(state.slots).filter((slot) => (slot.state === "failed" || slot.state === "cancelled") && (only === undefined || matchesLoose(only, slot)));
  const required = new Set(loadPipeline(pipelineDir(target.host, target.slug, target.pr, seams(ctx)), fsOf(ctx)).state?.policy?.required ?? []);
  const failing = [];
  for (const slot of slots.slice(0, 20)) {
    const entry = { key: slot.path ?? slot.name, source: slot.source, state: slot.state, conclusion: slot.conclusion, runId: slot.runId, attempt: slot.attempt, sha: short(slot.sha), url: slot.htmlUrl, required: [...required].some((key) => matches(key, slot)), jobs: [], output: null };
    if (slot.source === "run") {
      try {
        const jobs = await client.jobs({ owner, repo, runId: slot.runId }, ctx.signal);
        entry.jobs = jobs.items.slice(0, 20).map((job) => ({ name: safeText(job?.name, 200), conclusion: safeText(job?.conclusion, 40), failedSteps: (Array.isArray(job?.steps) ? job.steps : []).filter((step) => step?.conclusion === "failure").slice(0, 10).map((step) => safeText(step?.name, 200)) })).filter((job) => job.conclusion !== "success" && job.conclusion !== "skipped");
      } catch (error) {
        rethrowFatal(error, nowMsOf(ctx)()); // sign-in problems and interrupts still stop the command
        entry.jobs = [];
      }
    } else {
      const output = checkRaw.get(slot.runId)?.output;
      entry.output = { title: safeText(output?.title, 200), summary: safeText(output?.summary, 2048) };
    }
    failing.push(entry);
  }
  let files = { files: [] };
  try {
    files = await client.pullFiles({ owner, repo, number: target.pr }, ctx.signal);
  } catch (error) {
    rethrowFatal(error, nowMsOf(ctx)());
    files = { files: [], unavailable: true };
  }
  const packet = {
    ok: true,
    repo: target.slug.full,
    prNumber: target.pr,
    pr: { state: state.pr.state, title: safeText(raw.body?.title, 200), headRef: pull.headRef, baseBranch: pull.baseRef, headSha: short(pull.headSha), mergeCommitSha: pull.merged ? short(pull.mergeCommitSha) : null },
    filter: only ?? null,
    failing,
    changedFiles: files.files.map((file) => safeText(file, 300)),
    changedFilesUnavailable: files.unavailable === true,
    acceptanceCriteria: acceptanceCriteria(raw.body?.body),
    sentAnywhere: false,
    handoff: { note: "Nothing was sent anywhere and nothing was changed. Handing this packet to a run is your decision.", command: "asterweave run start --workflow bugfix \"<goal>\"" },
  };
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${stringifyJson(packet)}\n`);
    return EXIT.OK;
  }
  const lines = [`Diagnosis for ${packet.repo}#${packet.prNumber} (${packet.pr.state}): ${failing.length} failing check(s)${only ? ` matching ${only}` : ""}`];
  for (const f of failing) {
    lines.push("", `${f.key}  ${f.state} (${f.conclusion})  attempt ${f.attempt}  run ${f.runId}${f.required ? "  [required]" : ""}`, ...(f.url ? [`  ${f.url}`] : []));
    for (const job of f.jobs) lines.push(`  job ${job.name}: ${job.conclusion}${job.failedSteps.length ? `; failed steps: ${job.failedSteps.join(", ")}` : ""}`);
    if (f.output?.title) lines.push(`  output: ${f.output.title}`);
    if (f.output?.summary) lines.push(...f.output.summary.split("\n").map((line) => `    ${line}`));
  }
  lines.push("", `Changed files (${packet.changedFiles.length}${packet.changedFiles.length >= 100 ? "+" : ""}): ${packet.changedFiles.slice(0, 30).join(", ") || "none"}`);
  if (packet.acceptanceCriteria) lines.push("", "Acceptance criteria (from the PR body):", ...packet.acceptanceCriteria.split("\n").map((line) => `  ${line}`));
  lines.push("", packet.handoff.note, `To start a run yourself: ${packet.handoff.command}`);
  write(ctx.stdout, `${sanitizeLines(lines)}\n`);
  return EXIT.OK;
}

// Entry ----------------------------------------------------------------------------------------

/** Handler for `asterweave pipeline <status|watch|diagnose>`. */
export async function pipelineCommand(ctx) {
  const [sub] = ctx.positionals ?? [];
  if (sub === "status") return statusCommand(ctx);
  if (sub === "watch") return watchCommand(ctx);
  if (sub === "diagnose") return diagnoseCommand(ctx);
  throw new UsageError(sub === undefined ? "A subcommand is required." : `Unknown pipeline subcommand '${safe(sub, 40)}'.`, { remediation: USAGE });
}
