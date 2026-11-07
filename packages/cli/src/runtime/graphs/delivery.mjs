// delivery@1: the Asterweave delivery workflow as data. Node order, attempt budgets and required
// evidence mirror NODE_ORDER / NODE_CONTRACTS in plugins/asterweave/scripts/graph-state.mjs (a parity test
// compares them; this module never imports the plugin).
//
// Edges: every node passes to the next one (the last passes to `done`).
//   fail-retryable  test|verify|review|monitor-pipeline|resolve-review-comments -> implement, which
//                   invalidates and re-runs everything from implement through the failing node;
//                   every other node retries itself.
//   fail-replan     before `plan` the same node retries locally (nothing earlier can be re-planned);
//                   from `plan` onward it routes to `plan`, invalidating plan..node.
// Every retry and replan edge carries maxTraversals so every cycle is statically bounded; the per-node
// attempt budget is the tighter limit in practice.

import { defineGraph, registerGraph } from "../graph.mjs";

const TASKS = [
  ["intake", 2, ["task"]],
  ["analyze", 2, ["repository", "baseline"]],
  ["challenge", 2, ["requirements"]],
  ["plan", 2, ["plan"], { produces: "plan" }],
  ["approve", 1, ["approval"], { kind: "approval", dependsOn: ["plan"] }],
  ["implement", 3, ["change"]],
  ["test", 3, ["unit-test", "integration-test"]],
  ["verify", 2, ["acceptance"]],
  ["review", 2, ["code-review", "security-review"]],
  ["submit-pr", 2, ["pull-request"]],
  ["monitor-pipeline", 3, ["pipeline"]],
  ["resolve-review-comments", 3, ["review-comments"]],
  ["update-work-item", 2, ["work-item-update"]],
];

const ROUTE_TO_IMPLEMENT = new Set(["test", "verify", "review", "monitor-pipeline", "resolve-review-comments"]);
const LOCAL_REPLAN = new Set(["intake", "analyze", "challenge", "plan"]);

const nodes = Object.fromEntries(
  TASKS.map(([id, maxAttempts, evidence, extra = {}]) => [id, { kind: "task", maxAttempts, evidence, ...extra }]),
);

const edges = [];
TASKS.forEach(([id, maxAttempts], index) => {
  edges.push({ from: id, on: "pass", to: index === TASKS.length - 1 ? "done" : TASKS[index + 1][0] });
  if (ROUTE_TO_IMPLEMENT.has(id)) edges.push({ from: id, on: "fail-retryable", to: "implement", invalidate: "range", maxTraversals: 4 });
  else edges.push({ from: id, on: "fail-retryable", to: id, maxTraversals: maxAttempts });
  if (LOCAL_REPLAN.has(id)) edges.push({ from: id, on: "fail-replan", to: id, maxTraversals: maxAttempts });
  else edges.push({ from: id, on: "fail-replan", to: "plan", invalidate: "range", maxTraversals: 3 });
});

/** The plain definition (frozen copy lives in `deliveryGraph`). */
export const deliveryDefinition = { v: 1, id: "delivery", version: 1, start: "intake", terminals: { done: "completed", aborted: "aborted" }, nodes, edges };

export const deliveryGraph = registerGraph(defineGraph(deliveryDefinition));
