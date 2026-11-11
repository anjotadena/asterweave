// contribute@1 and audit@1: the contribution workflow as data, built with the same engine as delivery@1.
//
//   audit@1       discover -> audit -> triage -> done           (discovery only: ends with reviewed findings and proposed work)
//   contribute@1  discover -> audit -> triage -> select -> implement -> test-verify -> pr-review -> pr-prepare -> done
//
// Authorization is not a new layer: the audit graph has no node that can change the repository, contribute@1 asks for
// implementation, and every remote write (commit, push, PR) still goes through the existing guard and approvals.
// test-verify and pr-review failures re-enter `implement` (invalidating the range) within the attempt budgets; the edge
// maxTraversals bound every cycle. A `blocked` outcome is handled by the engine and leaves the run visibly blocked.

import { defineGraph, registerGraph } from "../graph.mjs";

const DISCOVERY = [
  ["discover", 2, ["repository", "baseline"]],
  ["audit", 2, ["finding"]],
  ["triage", 2, ["triage"]],
];
const DELIVERY = [
  ["select", 2, ["acceptance-criteria", "reproduction"]],
  ["implement", 3, ["change"]],
  ["test-verify", 3, ["regression-test"]],
  ["pr-review", 2, ["code-review"]],
  ["pr-prepare", 2, ["contribution-package"]],
];

function build(id, tasks) {
  const nodes = Object.fromEntries(tasks.map(([nodeId, maxAttempts, evidence]) => [nodeId, { kind: "task", maxAttempts, evidence }]));
  const hasImplement = tasks.some(([nodeId]) => nodeId === "implement");
  const edges = [];
  tasks.forEach(([nodeId, maxAttempts], index) => {
    edges.push({ from: nodeId, on: "pass", to: index === tasks.length - 1 ? "done" : tasks[index + 1][0] });
    const reenter = hasImplement && (nodeId === "test-verify" || nodeId === "pr-review");
    edges.push(reenter ? { from: nodeId, on: "fail-retryable", to: "implement", invalidate: "range", maxTraversals: 4 } : { from: nodeId, on: "fail-retryable", to: nodeId, maxTraversals: maxAttempts });
    edges.push({ from: nodeId, on: "fail-replan", to: nodeId, maxTraversals: maxAttempts });
  });
  return { v: 1, id, version: 1, start: tasks[0][0], terminals: { done: "completed", aborted: "aborted" }, nodes, edges };
}

export const auditDefinition = build("audit", DISCOVERY);
export const contributeDefinition = build("contribute", [...DISCOVERY, ...DELIVERY]);

export const auditGraph = registerGraph(defineGraph(auditDefinition));
export const contributeGraph = registerGraph(defineGraph(contributeDefinition));
