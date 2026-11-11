// Importing this module registers every built-in graph (delivery@1, bugfix@1, audit@1, contribute@1) with getGraph().

export { bugfixGraph } from "./bugfix.mjs";
export { deliveryGraph } from "./delivery.mjs";
export { auditGraph, contributeGraph } from "./contribution.mjs";
