// Optional link from the pipeline monitor to an Asterweave run (`pipeline watch <pr> --run <runId>`).
//
// The link only APPENDS to the run's ledger, under the run lock, through the existing ledger API:
//   - `pipeline.observed` / `pipeline.verdict` records (plain log records: the graph reducer ignores them), so `run show` and the audit trail
//     can display the verdict;
//   - when the run's current node is `monitor-pipeline` and it is running, a `pipeline` evidence entry through the existing evidence transition,
//     only for a settled verdict: "pass" when the verdict is closable, "fail" for any other final verdict. While the verdict is still waiting NO
//     evidence is written (an "info" entry could supersede an earlier "fail" as the latest evidence of the kind and unblock the node); the log
//     records alone show progress. One entry is written per link call, so a watch that settles adds one. Graph semantics are untouched: the
//     monitor never completes, retries or advances a node.
//   - the first link records `pipeline.target` ({repo, prNumber}); a later link for another pull request is refused, as is one that disagrees with
//     the pull request named in the run's submit-pr evidence. The caller also refuses a repository that is not the run's own.
// A run that is locked by a live process, or whose snapshot is behind its log, is NOT touched (the link reports why and the monitor carries on).
// No model call, no runner import.

import * as nodeFs from "node:fs";
import { CliError, EXIT } from "../../exit-codes.mjs";
import { getGraph, GraphError, graphHash } from "../graph.mjs";
import "../graphs/index.mjs";
import { appendEvent, isValidRunId, loadRun, repairTail } from "../ledger.mjs";
import { commitTransition, completeInterruptedGroup } from "../loop.mjs";
import { acquireRunLock } from "../lock.mjs";

const isoNow = () => new Date().toISOString();

/** The evidence result for a verdict; null (no evidence) while the verdict is still waiting. */
export function evidenceResult(verdict) {
  if (verdict === "closable") return "pass";
  if (verdict === "waiting") return null;
  return "fail";
}

/**
 * The pull request numbers a piece of evidence text refers to: a single `/pull/N` URL of the run's OWN repository wins outright; otherwise the
 * own-repository URLs and the bare `#N` references (URLs of other repositories are ignored). More than one distinct number means the text does
 * not say which pull request is meant.
 */
export function pullReferences(text, repo) {
  const found = new Set();
  const own = repo ? repo.toLowerCase() : null;
  for (const match of String(text ?? "").matchAll(/https?:\/\/[^\s/]+\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d{1,9})\b/g)) if (own !== null && match[1].toLowerCase() === own) found.add(Number(match[2]));
  // Exactly one pull request URL of the run's own repository is the answer; bare #N references (issues, mentions) are then not consulted.
  if (found.size === 1) return [...found];
  for (const match of String(text ?? "").replace(/https?:\/\/\S+/g, " ").matchAll(/(?:^|[^\w])#(\d{1,9})\b/g)) found.add(Number(match[1]));
  return [...found];
}

/**
 * The pull request a run is bound to: its latest submit-pr `pull-request` evidence when that names exactly ONE pull request of this repository, else
 * the first recorded pipeline.target. Ambiguous evidence binds nothing: the user names the pull request, which is then recorded as the target.
 */
export function boundPullRequest(loaded, repo = null) {
  const attempts = loaded.run.nodes?.["submit-pr"]?.attemptLog ?? [];
  const latest = [...attempts].reverse().flatMap((attempt) => [...(attempt.evidence ?? [])].reverse()).find((item) => item.kind === "pull-request");
  if (latest !== undefined) {
    const numbers = pullReferences(latest.summary, repo);
    if (numbers.length === 1) return { prNumber: numbers[0], source: "submit-pr evidence" };
  }
  const target = loaded.events.findLast((event) => event.type === "pipeline.target");
  return target ? { prNumber: target.prNumber, repo: target.repo, source: "pipeline.target" } : null;
}

/** null when the run may be linked to this pull request, otherwise why not. */
export function targetProblem(loaded, { repo, prNumber }) {
  const bound = boundPullRequest(loaded, repo);
  if (bound !== null && bound.prNumber !== prNumber) return `the run is bound to pull request #${bound.prNumber} (${bound.source})`;
  if (bound?.repo !== undefined && bound.repo.toLowerCase() !== repo.toLowerCase()) return `the run is bound to ${bound.repo}`;
  return null;
}

/** Throws RUN_NOT_FOUND / RUN_ID_INVALID early so a bad `--run` is reported before any polling. */
export function assertRunExists(dir, runId, fs = nodeFs) {
  if (!isValidRunId(runId)) throw new CliError("Invalid run id.", { code: "RUN_ID_INVALID", exitCode: EXIT.USAGE });
  return loadRun(dir, { fs });
}

/**
 * @param {string} dir  Run directory.
 * @param {{kind: 'observed'|'verdict', repo: string, prNumber: number, verdict: string, closable: boolean, blockers: object[], polls: number, summary: string}} info
 * @param {{fs?: typeof nodeFs, now?: () => string}} [options]
 * @returns {{linked: boolean, note?: string, evidence?: string}}
 */
export function recordToRun(dir, info, { fs = nodeFs, now = isoNow } = {}) {
  let lock;
  try {
    lock = acquireRunLock(dir, { fs });
  } catch (error) {
    if (error?.code === "RUN_LOCKED") return { linked: false, note: "run-locked" };
    throw error;
  }
  try {
    let loaded = loadRun(dir, { fs });
    if (loaded.torn) {
      repairTail(dir, { lockToken: lock.token, fs });
      loaded = loadRun(dir, { fs });
    }
    if (loaded.behind > 0) return { linked: false, note: "run-behind-its-log" };
    const problem = targetProblem(loaded, { repo: info.repo, prNumber: info.prNumber });
    if (problem !== null) return { linked: false, note: "run-bound-to-another-pull-request" };
    // An event group the previous process did not finish is completed first, exactly as `run approve|abort` do under the lock.
    let base = completeInterruptedGroup({ dir, lockToken: lock.token, now, fs }, loaded.run, loaded.events).run;
    if (boundPullRequest(loaded, info.repo) === null) base = appendEvent(dir, { type: "pipeline.target", repo: info.repo, prNumber: info.prNumber }, { run: base, lockToken: lock.token, now, fs }).run;
    const record = {
      type: info.kind === "verdict" ? "pipeline.verdict" : "pipeline.observed",
      repo: info.repo,
      prNumber: info.prNumber,
      verdict: info.verdict,
      closable: info.closable,
      polls: info.polls,
      blockers: info.blockers.slice(0, 10).map((item) => ({ key: item.key, state: item.state, reason: item.reason })),
    };
    let run = appendEvent(dir, record, { run: base, lockToken: lock.token, now, fs }).run;
    const node = run.currentNode;
    if (node !== "monitor-pipeline" || run.status !== "active" || run.nodes?.[node]?.status !== "running") return { linked: true };
    const graph = getGraph(run.graph?.id, run.graph?.version);
    if (!graph || graphHash(graph) !== run.graph?.hash) return { linked: true, note: "graph-unknown" };
    const result = evidenceResult(info.verdict);
    if (result === null) return { linked: true };
    try {
      run = commitTransition({ dir, graph, lockToken: lock.token, now, fs }, run, { type: "evidence", kind: "pipeline", summary: info.summary.slice(0, 3900), result }).run;
      return { linked: true, evidence: result };
    } catch (error) {
      if (error instanceof GraphError) return { linked: true, note: `evidence-refused-${error.code}` };
      throw error;
    }
  } finally {
    lock.release();
  }
}
