// bugfix@1: delivery@1 without `challenge` (a bug report is not a feature request to challenge), and
// `analyze` additionally requires `reproduction` evidence (a failing case captured before any change).
// Everything else - budgets, routing, bounds - is inherited from the delivery definition.

import { defineGraph, registerGraph } from "../graph.mjs";
import { deliveryDefinition } from "./delivery.mjs";

const nodes = Object.fromEntries(
  Object.entries(deliveryDefinition.nodes)
    .filter(([id]) => id !== "challenge")
    .map(([id, node]) => [id, id === "analyze" ? { ...node, evidence: [...node.evidence, "reproduction"] } : node]),
);

const edges = deliveryDefinition.edges
  .filter((edge) => edge.from !== "challenge")
  .map((edge) => (edge.from === "analyze" && edge.on === "pass" ? { ...edge, to: "plan" } : edge));

export const bugfixDefinition = { ...deliveryDefinition, id: "bugfix", nodes, edges };

export const bugfixGraph = registerGraph(defineGraph(bugfixDefinition));
