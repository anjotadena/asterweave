// Workflow graphs for the CLI runtime: data-only definitions, a validator, a registry, and a PURE
// reducer. Nothing here touches the disk, the clock or the environment; the caller (ledger + loop)
// supplies `now`, persists the returned run and appends the returned effects to the audit trail
// (event first, then the run.json snapshot).
//
// The delivery topology and its recovery semantics reproduce plugins/asterweave/scripts/graph-state.mjs
// (see references/graph-contract.md), with the defects listed in the work-package spec fixed on purpose:
//   - evidence counts only inside the CURRENT attempt (a re-run can never pass on stale evidence);
//   - fail-replan raised before `plan` retries the same node instead of jumping forward;
//   - a new revision of the artifact an `approval` node depends on resets that node's attempt budget;
//   - blocked / needs-human / policy-denied / security-escalation REFUND the attempt;
//   - a routed budget exhaustion leaves the run positioned at the node that must re-run;
//   - evidence / complete / enter are rejected unless the run is active.
//
// Public API: validateGraph, defineGraph, registerGraph, getGraph, graphHash, canonicalJson,
// initialRun, transition, registerPredicate, GraphError, OUTCOMES.

import { createHash } from "node:crypto";
import { stringifyJson } from "../json.mjs";
import { check } from "./schema.mjs";

export const ID_PATTERN = "^[a-z][a-z0-9-]{0,39}$";
const ID_RE = new RegExp(ID_PATTERN);

export const OUTCOMES = Object.freeze([
  "pass",
  "fail-retryable",
  "fail-replan",
  "blocked",
  "needs-human",
  "policy-denied",
  "security-escalation",
  "abort",
]);
// Outcomes the engine handles itself; a graph routes only pass, fail-retryable and fail-replan.
const PAUSE_OUTCOMES = new Set(["blocked", "needs-human", "policy-denied", "security-escalation"]);
const ENGINE_OUTCOMES = new Set([...PAUSE_OUTCOMES, "abort"]);
const NODE_KINDS = ["task", "approval", "wait", "fork", "join"];
export const RUN_STATUSES = Object.freeze(["active", "waiting-approval", "waiting-external", "paused", "blocked", "completed", "aborted"]);
const RESUMABLE = new Set(["blocked", "paused", "waiting-approval", "waiting-external"]);
const PAUSE_STATUSES = ["paused", "waiting-approval", "waiting-external"];
const EVIDENCE_RESULTS = ["pass", "fail", "info"];

const MAX_NODES = 200;
const MAX_EDGES = 2000;
const MAX_EVIDENCE_PER_ATTEMPT = 500;

export class GraphError extends Error {
  /** @param {string} code @param {string} message @param {string[]} [errors] */
  constructor(code, message, errors) {
    super(message);
    this.name = "GraphError";
    this.code = code;
    if (errors) this.errors = errors;
  }
}
const fail = (code, message) => {
  throw new GraphError(code, message);
};

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------
// Definition schema and validation
// ---------------------------------------------------------------------------------------------

const NAME = { type: "string", pattern: ID_PATTERN };
const NODE_SPEC = {
  type: "object",
  required: ["kind", "maxAttempts", "evidence"],
  additionalProperties: false,
  properties: {
    kind: { enum: NODE_KINDS },
    maxAttempts: { type: "integer", min: 1, max: 20 },
    evidence: { type: "array", items: NAME, maxItems: 20, uniqueItems: true },
    produces: NAME,
    dependsOn: { type: "array", items: NAME, maxItems: 20, uniqueItems: true },
  },
};
const EDGE_SPEC = {
  type: "object",
  required: ["from", "on", "to"],
  additionalProperties: false,
  properties: {
    from: { type: "string", maxLength: 64 },
    on: { enum: OUTCOMES },
    to: { type: "string", maxLength: 64 },
    invalidate: { type: ["string", "array"], items: { type: "string", maxLength: 64 }, maxItems: MAX_NODES },
    when: NAME,
    maxTraversals: { type: "integer", min: 1, max: 1000 },
  },
};
const GRAPH_SPEC = {
  type: "object",
  required: ["v", "id", "version", "start", "terminals", "nodes", "edges"],
  additionalProperties: false,
  properties: {
    v: { const: 1 },
    id: NAME,
    version: { type: "integer", min: 1, max: 1000 },
    start: { type: "string", maxLength: 64 },
    terminals: {
      type: "object",
      required: ["done", "aborted"],
      additionalProperties: false,
      properties: { done: { const: "completed" }, aborted: { const: "aborted" } },
    },
    nodes: { type: "object", additionalProperties: NODE_SPEC },
    edges: { type: "array", items: EDGE_SPEC, maxItems: MAX_EDGES },
  },
};

const edgeLabel = (edge) => `edge ${edge.from} --${edge.on}--> ${edge.to}`;
const TERMINAL_KEYS = ["done", "aborted"];

/**
 * @param {unknown} def
 * @returns {string[]} problems; empty when `def` is a well-formed, bounded, fully routable graph
 */
export function validateGraph(def) {
  const errors = check(def, GRAPH_SPEC, "graph");
  if (errors.length > 0) return errors;
  const nodeIds = Object.keys(def.nodes);
  if (nodeIds.length === 0) errors.push("graph: has no nodes");
  if (nodeIds.length > MAX_NODES) errors.push(`graph: more than ${MAX_NODES} nodes`);
  const isNode = (id) => Object.hasOwn(def.nodes, id);
  const isTerminal = (id) => TERMINAL_KEYS.includes(id);

  for (const id of nodeIds) {
    if (!ID_RE.test(id)) errors.push(`node ${stringifyJson(id)}: id must match ${ID_PATTERN}`);
    if (isTerminal(id)) errors.push(`node ${id}: duplicate id, collides with the terminal of the same name`);
  }
  if (!isNode(def.start)) errors.push(`graph: start ${stringifyJson(def.start)} is not a node`);

  // Artifacts: one producer per name; every dependency must be produced somewhere.
  const producers = new Map();
  for (const id of nodeIds) {
    const produced = def.nodes[id].produces;
    if (produced === undefined) continue;
    if (producers.has(produced)) errors.push(`node ${id}: artifact ${produced} is already produced by ${producers.get(produced)}`);
    else producers.set(produced, id);
  }
  for (const id of nodeIds) {
    for (const dependency of def.nodes[id].dependsOn ?? []) {
      if (!producers.has(dependency)) errors.push(`node ${id}: depends on artifact ${dependency} that no node produces`);
      else if (producers.get(dependency) === id) errors.push(`node ${id}: depends on its own artifact ${dependency}`);
    }
  }

  // Edges.
  const seen = new Set();
  const groups = new Map();
  for (const edge of def.edges) {
    const label = edgeLabel(edge);
    if (!isNode(edge.from)) errors.push(`${label}: unknown source node`);
    if (!isNode(edge.to) && !isTerminal(edge.to)) errors.push(`${label}: unknown target`);
    if (ENGINE_OUTCOMES.has(edge.on)) errors.push(`${label}: outcome ${edge.on} is handled by the engine and cannot be routed`);
    const key = `${edge.from}\u0000${edge.on}\u0000${edge.when ?? ""}`;
    if (seen.has(key)) errors.push(`${label}: duplicate (from, on, when)`);
    seen.add(key);
    const group = `${edge.from}\u0000${edge.on}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(edge);
    if (typeof edge.invalidate === "string" && edge.invalidate !== "range") errors.push(`${label}: invalidate must be "range" or a list of node ids`);
    if (Array.isArray(edge.invalidate)) {
      for (const target of edge.invalidate) if (!isNode(target)) errors.push(`${label}: invalidates unknown node ${stringifyJson(target)}`);
    }
  }

  for (const id of nodeIds) {
    const passEdges = def.edges.filter((edge) => edge.from === id && edge.on === "pass");
    if (passEdges.length === 0) errors.push(`node ${id}: has no pass edge`);
    if (def.nodes[id].kind === "fork") {
      if (passEdges.length < 2) errors.push(`fork ${id}: needs at least two pass edges (one per branch)`);
      if (passEdges.some((edge) => edge.when === undefined)) errors.push(`fork ${id}: every branch edge needs a when label`);
    }
  }
  for (const [group, edges] of groups) {
    const [from] = group.split("\u0000");
    const isForkBranches = isNode(from) && def.nodes[from].kind === "fork" && edges[0].on === "pass";
    if (!isForkBranches && edges.some((edge) => edge.when !== undefined) && edges.every((edge) => edge.when !== undefined)) {
      errors.push(`node ${from}: conditional ${edges[0].on} edges need an unconditional fallback`);
    }
  }

  // Reachability.
  const forward = new Map(nodeIds.map((id) => [id, []]));
  const backward = new Map([...nodeIds, ...TERMINAL_KEYS].map((id) => [id, []]));
  for (const edge of def.edges) {
    if (!isNode(edge.from) || (!isNode(edge.to) && !isTerminal(edge.to))) continue;
    if (isNode(edge.to)) forward.get(edge.from).push(edge.to);
    backward.get(edge.to).push(edge.from);
  }
  if (isNode(def.start)) {
    const reachable = flood([def.start], forward);
    for (const id of nodeIds) if (!reachable.has(id)) errors.push(`node ${id}: unreachable from start`);
  }
  const canFinish = flood(TERMINAL_KEYS, backward);
  for (const id of nodeIds) if (!canFinish.has(id)) errors.push(`node ${id}: cannot reach a terminal`);

  // Every cycle must contain at least one bounded edge: the unbounded edges alone must be acyclic.
  const unbounded = new Map(nodeIds.map((id) => [id, []]));
  for (const edge of def.edges) {
    if (edge.maxTraversals === undefined && isNode(edge.from) && isNode(edge.to)) unbounded.get(edge.from).push(edge.to);
  }
  const cycle = findCycle(nodeIds, unbounded);
  if (cycle) errors.push(`graph: unbounded cycle ${cycle.join(" -> ")} (an edge on it needs maxTraversals)`);

  // Join predecessors must all come from one fork.
  const forks = nodeIds.filter((id) => def.nodes[id].kind === "fork");
  const regions = new Map(forks.map((fork) => [fork, regionOf(def, fork)]));
  for (const join of nodeIds.filter((id) => def.nodes[id].kind === "join")) {
    const predecessors = [...new Set(def.edges.filter((edge) => edge.to === join && isNode(edge.from)).map((edge) => edge.from))];
    if (predecessors.length < 2) {
      errors.push(`join ${join}: needs at least two predecessors`);
      continue;
    }
    const common = forks.filter((fork) => predecessors.every((predecessor) => regions.get(fork).has(predecessor)));
    if (common.length === 0) errors.push(`join ${join}: predecessors do not all come from one fork`);
  }

  return [...new Set(errors)];
}

function flood(starts, adjacency) {
  const seen = new Set(starts.filter((id) => adjacency.has(id)));
  const queue = [...seen];
  while (queue.length > 0) {
    for (const next of adjacency.get(queue.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

function findCycle(ids, adjacency) {
  const state = new Map();
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adjacency.get(id) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.has(next)) {
        const found = visit(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

// Nodes reachable from a fork without crossing a join (a join is included but not expanded).
function regionOf(def, fork) {
  const seen = new Set();
  const queue = def.edges.filter((edge) => edge.from === fork).map((edge) => edge.to);
  while (queue.length > 0) {
    const id = queue.pop();
    if (seen.has(id) || !Object.hasOwn(def.nodes, id)) continue;
    seen.add(id);
    if (def.nodes[id].kind === "join") continue;
    for (const edge of def.edges) if (edge.from === id) queue.push(edge.to);
  }
  return seen;
}

// ---------------------------------------------------------------------------------------------
// Canonical JSON, hashing, definition, registry
// ---------------------------------------------------------------------------------------------

/** Deterministic JSON: object keys sorted, undefined members dropped. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (isObject(value)) {
    const members = Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${stringifyJson(key)}:${canonicalJson(value[key])}`);
    return `{${members.join(",")}}`;
  }
  return stringifyJson(value) ?? "null";
}

const HASHES = new WeakMap();
const VALIDATED = new WeakSet();

/** sha256 (hex) of the canonical JSON of a graph definition. */
export function graphHash(def) {
  const cached = HASHES.get(def);
  if (cached) return cached;
  const hash = createHash("sha256").update(canonicalJson(def)).digest("hex");
  if (Object.isFrozen(def)) HASHES.set(def, hash);
  return hash;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** Validate and freeze a copy of `def`. @throws {GraphError} GRAPH_INVALID listing every problem */
export function defineGraph(def) {
  const errors = validateGraph(def);
  if (errors.length > 0) throw new GraphError("GRAPH_INVALID", `Invalid graph: ${errors.join("; ")}`, errors);
  const graph = deepFreeze(structuredClone(def));
  VALIDATED.add(graph);
  return graph;
}

function ensureValid(graph) {
  if (VALIDATED.has(graph) && Object.isFrozen(graph)) return;
  const errors = validateGraph(graph);
  if (errors.length > 0) throw new GraphError("GRAPH_INVALID", `Invalid graph: ${errors.join("; ")}`, errors);
  if (Object.isFrozen(graph)) VALIDATED.add(graph);
}

const REGISTRY = new Map();

/** Register a graph under `id@version`. Re-registering identical content is a no-op; different content throws. */
export function registerGraph(graph) {
  const defined = VALIDATED.has(graph) && Object.isFrozen(graph) ? graph : defineGraph(graph);
  const key = `${defined.id}@${defined.version}`;
  const existing = REGISTRY.get(key);
  if (existing) {
    if (graphHash(existing) !== graphHash(defined)) fail("GRAPH_CONFLICT", `A different graph is already registered as ${key}.`);
    return existing;
  }
  REGISTRY.set(key, defined);
  return defined;
}

/** getGraph("delivery", 1) or getGraph("delivery@1"); undefined when unknown. */
export function getGraph(id, version) {
  const key = version === undefined ? String(id) : `${id}@${version}`;
  return REGISTRY.get(key);
}

// ---------------------------------------------------------------------------------------------
// Run state
// ---------------------------------------------------------------------------------------------

/**
 * Fresh run.json content (no ledger I/O).
 * @param {object} graph a defined graph
 * @param {{runId:string, goal:string, repo:{key:string,realpath:string}, now:string, policyHash?:string|null}} options
 */
export function initialRun(graph, { runId, goal, repo, now, policyHash = null }) {
  ensureValid(graph);
  if (typeof runId !== "string" || runId === "") fail("BAD_RUN", "runId is required.");
  if (typeof goal !== "string" || goal.trim() === "") fail("BAD_RUN", "goal is required.");
  if (!isObject(repo) || typeof repo.key !== "string" || typeof repo.realpath !== "string") fail("BAD_RUN", "repo {key, realpath} is required.");
  if (typeof now !== "string" || now === "") fail("BAD_RUN", "now is required.");
  return {
    v: 1,
    runId,
    graph: { id: graph.id, version: graph.version, hash: graphHash(graph) },
    repo: { key: repo.key, realpath: repo.realpath },
    goal: goal.trim(),
    status: "active",
    currentNode: graph.start,
    nodes: Object.fromEntries(
      Object.entries(graph.nodes).map(([id, def]) => [
        id,
        { status: "pending", attempts: 0, maxAttempts: def.maxAttempts, traversals: {}, outcome: null, failureSignatures: [], attemptLog: [] },
      ]),
    ),
    artifacts: {},
    approvals: [],
    budgets: { used: { iterations: 0, toolCalls: 0, tokens: 0, wallMs: 0 } },
    policyHash,
    lastSeq: 0,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------------------------

const PREDICATES = new Map();
/** Register a pure `(run) => boolean` used by edges that carry a `when` label. Unknown labels are false. */
export function registerPredicate(id, predicate) {
  if (!ID_RE.test(id) || typeof predicate !== "function") fail("BAD_PREDICATE", "A predicate needs an id and a function.");
  PREDICATES.set(id, predicate);
}

const edgeKey = (edge) => `${edge.on}:${edge.to}${edge.when === undefined ? "" : `#${edge.when}`}`;

function selectEdge(ctx, from, on) {
  const candidates = ctx.graph.edges.filter((edge) => edge.from === from && edge.on === on);
  for (const edge of candidates) {
    if (edge.when === undefined) continue;
    const predicate = PREDICATES.get(edge.when);
    let holds = false;
    try {
      holds = predicate ? predicate(structuredClone(ctx.run)) === true : false;
    } catch {
      holds = false;
    }
    if (holds) return edge;
  }
  return candidates.find((edge) => edge.when === undefined) ?? null;
}

const capReached = (rec, edge) => edge.maxTraversals !== undefined && (rec.traversals[edgeKey(edge)] ?? 0) >= edge.maxTraversals;

function requireStatus(ctx, allowed) {
  if (!allowed.includes(ctx.run.status)) fail("RUN_NOT_ACTIVE", `Run is ${ctx.run.status}, not ${allowed.join(" or ")}.`);
}

function currentNode(ctx, event) {
  const id = ctx.run.currentNode;
  if (Object.hasOwn(ctx.graph.terminals, id)) fail("RUN_NOT_ACTIVE", `Run already reached ${id}.`);
  const rec = Object.hasOwn(ctx.run.nodes, id) ? ctx.run.nodes[id] : undefined;
  const def = Object.hasOwn(ctx.graph.nodes, id) ? ctx.graph.nodes[id] : undefined;
  if (!rec || !def) fail("RUN_CORRUPT", `Run state has no node ${id}.`);
  if (event.node !== undefined && event.node !== id) fail("WRONG_NODE", `Cannot act on ${String(event.node)}; current node is ${id}.`);
  return { id, rec, def };
}

const openAttempt = (rec) => {
  const attempt = rec.attemptLog.at(-1);
  return attempt && attempt.endedAt === null ? attempt : null;
};

function closeAttempt(ctx, rec, outcome, refunded = false) {
  const attempt = openAttempt(rec);
  if (!attempt) return;
  attempt.endedAt = ctx.at;
  attempt.outcome = outcome;
  attempt.refunded = refunded;
}

function blockRun(ctx) {
  ctx.run.status = "blocked";
}

function signatureOf(event) {
  if (event.signature === undefined || event.signature === null) return null;
  if (typeof event.signature !== "string" || event.signature.length > 512) fail("BAD_EVENT", "signature must be a string of at most 512 characters.");
  return event.signature.trim() || null;
}

function enterCurrent(ctx, event) {
  requireStatus(ctx, ["active"]);
  const { id, rec, def } = currentNode(ctx, event);
  if (rec.status === "running") fail("ALREADY_RUNNING", `${id} is already running.`);
  if (rec.status === "passed") fail("ALREADY_PASSED", `${id} is already passed.`);
  if (rec.status === "blocked") fail("NODE_BLOCKED", `${id} is blocked; resume the run first.`);
  if (def.kind === "fork" || def.kind === "join") fail("UNSUPPORTED_NODE_KIND", `${def.kind} nodes cannot be executed yet.`);
  if (rec.attempts >= rec.maxAttempts) {
    blockRun(ctx);
    ctx.effects.push({ type: "budget.exhausted", scope: "node", node: id, attempts: rec.attempts, maxAttempts: rec.maxAttempts });
    return false;
  }
  rec.status = "running";
  rec.attempts += 1;
  rec.outcome = null;
  const n = rec.attemptLog.length + 1;
  rec.attemptLog.push({ n, startedAt: ctx.at, endedAt: null, outcome: null, evidence: [], refunded: false });
  if (def.kind === "wait") ctx.run.status = "waiting-external";
  ctx.effects.push({ type: "node.entered", node: id, attempt: n, attempts: rec.attempts });
  return true;
}

function recordEvidence(ctx, event) {
  requireStatus(ctx, ["active"]);
  const { id, rec } = currentNode(ctx, event);
  const attempt = openAttempt(rec);
  if (rec.status !== "running" || !attempt) fail("NOT_RUNNING", `${id} must be running before evidence can be recorded.`);
  const problems = check(
    event,
    {
      type: "object",
      required: ["kind", "summary", "result"],
      properties: {
        kind: { type: "string", minLength: 1, maxLength: 128 },
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        result: { enum: EVIDENCE_RESULTS },
        path: { type: ["string", "null"], maxLength: 1024 },
        sha256: { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" },
      },
    },
    "evidence",
  );
  if (problems.length > 0) fail("BAD_EVENT", problems.join("; "));
  const kind = event.kind.trim();
  const summary = event.summary.trim();
  if (!kind || !summary) fail("BAD_EVENT", "Evidence requires a kind and a summary.");
  if (attempt.evidence.length >= MAX_EVIDENCE_PER_ATTEMPT) fail("EVIDENCE_LIMIT", `An attempt can hold at most ${MAX_EVIDENCE_PER_ATTEMPT} evidence entries.`);
  const entry = { kind, summary, result: event.result, path: event.path ?? null, sha256: event.sha256 ?? null, attempt: attempt.n };
  attempt.evidence.push(entry);
  ctx.effects.push({ type: "evidence.recorded", node: id, evidence: structuredClone(entry) });
}

// Latest entry per kind inside the open attempt only.
function latestEvidence(rec) {
  const latest = new Map();
  for (const item of openAttempt(rec)?.evidence ?? []) latest.set(item.kind, item);
  return latest;
}

function reset(rec) {
  rec.status = "pending";
  rec.outcome = null;
}

function moveTo(ctx, edge, fromId) {
  const { run, graph } = ctx;
  const fromRec = run.nodes[fromId];
  const key = edgeKey(edge);
  fromRec.traversals[key] = (fromRec.traversals[key] ?? 0) + 1;
  if (Object.hasOwn(graph.terminals, edge.to)) {
    run.currentNode = edge.to;
    run.status = graph.terminals[edge.to];
    return;
  }
  const order = Object.keys(graph.nodes);
  if (Array.isArray(edge.invalidate)) {
    for (const id of edge.invalidate) reset(run.nodes[id]);
  } else if (edge.invalidate === "range" && edge.to !== fromId) {
    const start = order.indexOf(edge.to);
    const end = order.indexOf(fromId);
    if (start >= 0 && end >= start) for (const id of order.slice(start, end + 1)) reset(run.nodes[id]);
  }
  run.currentNode = edge.to;
  if (run.nodes[edge.to].status === "passed") reset(run.nodes[edge.to]);
}

function completePass(ctx, id, rec, def) {
  const latest = latestEvidence(rec);
  const missing = def.evidence.filter((kind) => !latest.has(kind));
  if (missing.length > 0) fail("EVIDENCE_MISSING", `${id} cannot pass; no evidence in the current attempt for: ${missing.join(", ")}`);
  const failing = [...latest.values()].filter((item) => item.result === "fail").map((item) => item.kind);
  if (failing.length > 0) fail("EVIDENCE_FAILING", `${id} cannot pass while its latest evidence is failing: ${failing.join(", ")}`);
  const edge = selectEdge(ctx, id, "pass");
  if (!edge) fail("NO_ROUTE", `${id} has no usable pass edge.`);
  if (capReached(rec, edge)) {
    ctx.effects.push({ type: "budget.exhausted", scope: "edge", node: id, edge: edgeKey(edge) });
    blockRun(ctx);
    return;
  }
  rec.status = "passed";
  rec.outcome = "pass";
  closeAttempt(ctx, rec, "pass");
  if (def.produces !== undefined) {
    const withHash = [...latest.values()].reverse().find((item) => item.kind === def.produces && item.sha256);
    const previous = ctx.run.artifacts[def.produces];
    ctx.run.artifacts[def.produces] = { hash: withHash?.sha256 ?? null, revision: (previous?.revision ?? 0) + 1, dependsOn: [...(def.dependsOn ?? [])] };
    // A new revision of an artifact gives every node that depends on it a fresh attempt budget.
    for (const [otherId, other] of Object.entries(ctx.graph.nodes)) {
      if (otherId !== id && (other.dependsOn ?? []).includes(def.produces)) ctx.run.nodes[otherId].attempts = 0;
    }
  }
  moveTo(ctx, edge, id);
  ctx.effects.push({ type: "node.completed", node: id, outcome: "pass", next: ctx.run.currentNode });
  if (ctx.run.status === "completed") ctx.effects.push({ type: "run.completed" });
  if (ctx.run.status === "aborted") ctx.effects.push({ type: "run.aborted", reason: "graph routed to the aborted terminal" });
}

function completeFailure(ctx, id, rec, outcome, signature) {
  rec.status = "failed";
  rec.outcome = outcome;
  closeAttempt(ctx, rec, outcome);
  const completed = { type: "node.completed", node: id, outcome, ...(signature ? { signature } : {}) };
  if (signature) {
    rec.failureSignatures.push(signature);
    if (rec.failureSignatures.filter((value) => value === signature).length >= 2) {
      blockRun(ctx);
      ctx.effects.push({ ...completed, stableFailure: true, next: id });
      return;
    }
  }
  const edge = selectEdge(ctx, id, outcome);
  if (!edge) {
    blockRun(ctx);
    ctx.effects.push({ ...completed, routed: false, next: id });
    return;
  }
  if (capReached(rec, edge)) {
    blockRun(ctx);
    ctx.effects.push({ ...completed, next: id }, { type: "budget.exhausted", scope: "edge", node: id, edge: edgeKey(edge) });
    return;
  }
  moveTo(ctx, edge, id);
  ctx.effects.push({ ...completed, next: ctx.run.currentNode });
  if (ctx.run.status === "aborted") {
    ctx.effects.push({ type: "run.aborted", reason: "graph routed to the aborted terminal" });
    return;
  }
  const destination = ctx.run.nodes[ctx.run.currentNode];
  if (destination.attempts >= destination.maxAttempts) {
    blockRun(ctx);
    ctx.effects.push({ type: "budget.exhausted", scope: "node", node: ctx.run.currentNode, attempts: destination.attempts, maxAttempts: destination.maxAttempts });
  }
}

function abortRun(ctx, reason) {
  if (ctx.run.status === "completed" || ctx.run.status === "aborted") fail("RUN_NOT_ACTIVE", `Run is already ${ctx.run.status}.`);
  const id = ctx.run.currentNode;
  if (Object.hasOwn(ctx.run.nodes, id)) {
    const rec = ctx.run.nodes[id];
    closeAttempt(ctx, rec, "abort");
    rec.status = "failed";
    rec.outcome = "abort";
  }
  ctx.run.status = "aborted";
  ctx.effects.push({ type: "node.completed", node: id, outcome: "abort", next: id }, { type: "run.aborted", reason });
}

function completeNode(ctx, event) {
  if (!OUTCOMES.includes(event.outcome)) fail("BAD_OUTCOME", `Unsupported outcome: ${String(event.outcome)}`);
  if (event.outcome === "abort") {
    requireStatus(ctx, ["active", "waiting-approval", "waiting-external", "paused", "blocked"]);
    const { rec } = currentNode(ctx, event);
    if (rec.status !== "running") fail("NOT_RUNNING", `${ctx.run.currentNode} must be running before it can complete.`);
    abortRun(ctx, "abort outcome");
    return;
  }
  requireStatus(ctx, ["active"]);
  const { id, rec, def } = currentNode(ctx, event);
  if (rec.status !== "running") fail("NOT_RUNNING", `${id} must be running before it can complete.`);
  const signature = signatureOf(event);
  if (event.outcome === "pass") return completePass(ctx, id, rec, def);
  if (PAUSE_OUTCOMES.has(event.outcome)) {
    // Pause in place; the blocker is not the attempt's fault, so the attempt is refunded.
    rec.status = "blocked";
    rec.outcome = event.outcome;
    rec.attempts = Math.max(0, rec.attempts - 1);
    closeAttempt(ctx, rec, event.outcome, true);
    blockRun(ctx);
    ctx.effects.push({ type: "node.completed", node: id, outcome: event.outcome, refunded: true, next: id }, { type: "run.paused", reason: event.outcome, node: id });
    return;
  }
  return completeFailure(ctx, id, rec, event.outcome, signature);
}

function approve(ctx, event) {
  requireStatus(ctx, ["active", "waiting-approval"]);
  const { id, rec, def } = currentNode(ctx, event);
  if (def.kind !== "approval") fail("NOT_APPROVAL_NODE", `Approval is not current; current node is ${id}.`);
  for (const key of ["by", "summary"]) {
    if (typeof event[key] !== "string" || event[key].trim() === "" || event[key].length > 2000) fail("BAD_EVENT", `Approval requires ${key}.`);
  }
  ctx.run.status = "active";
  if (rec.status !== "running" && !enterCurrent(ctx, event)) return;
  const kind = def.evidence[0] ?? "approval";
  recordEvidence(ctx, { kind, summary: `${event.by.trim()}: ${event.summary.trim()}`, result: "pass" });
  completePass(ctx, id, rec, def);
}

function resume(ctx, event) {
  if (!RESUMABLE.has(ctx.run.status)) fail("NOT_RESUMABLE", `Run is ${ctx.run.status}; only blocked, paused or waiting runs can resume.`);
  const previous = ctx.run.status;
  const { id, rec, def } = currentNode(ctx, event);
  ctx.run.status = "active";
  ctx.effects.push({ type: "run.resumed", node: id });
  if (def.kind === "wait" && previous === "waiting-external" && rec.status === "running") {
    completePass(ctx, id, rec, def);
    return;
  }
  // A paused/blocked node is runnable again. A node that was mid-attempt (status running) keeps its
  // attempt. Budgets are never topped up here: a node out of attempts blocks again on enter.
  if (rec.status === "blocked") rec.status = "pending";
}

function pause(ctx, event) {
  requireStatus(ctx, ["active"]);
  const status = event.status ?? "paused";
  if (!PAUSE_STATUSES.includes(status)) fail("BAD_EVENT", `Unsupported pause status: ${String(status)}`);
  const reason = typeof event.reason === "string" ? event.reason.slice(0, 500) : "paused";
  ctx.run.status = status;
  ctx.effects.push({ type: "run.paused", reason, status, node: ctx.run.currentNode });
}

const HANDLERS = {
  enter: (ctx, event) => void enterCurrent(ctx, event),
  evidence: recordEvidence,
  complete: completeNode,
  approve,
  resume,
  pause,
  abort: (ctx, event) => abortRun(ctx, typeof event.reason === "string" ? event.reason.slice(0, 500) : "aborted"),
};

/**
 * Pure reducer. Events: enter | evidence | complete{outcome,signature} | approve{by,summary} | resume |
 * pause{reason,status?} | abort{reason?}. Each may carry `node` (must be the current node) and `now`
 * (ISO string; defaults to run.updatedAt so the reducer never reads a clock). Caller-supplied `at` / `seq`
 * are ignored: the ledger stamps them when the effect is appended.
 *
 * Returns `{run, effects}`: a NEW run (the input is never mutated) and the audit events to append before
 * persisting it. Rejected events throw GraphError and change nothing. Budget exhaustion is a state change,
 * not a rejection: it returns a blocked run plus a `budget.exhausted` effect.
 */
export function transition(run, graph, event) {
  if (!isObject(run) || !isObject(graph)) fail("BAD_EVENT", "transition needs a run and a graph.");
  ensureValid(graph);
  if (!isObject(event) || typeof event.type !== "string" || !Object.hasOwn(HANDLERS, event.type)) {
    fail("BAD_EVENT", `Unknown event type: ${String(isObject(event) ? event.type : event)}`);
  }
  if (!isObject(run.graph) || run.graph.id !== graph.id || run.graph.version !== graph.version || run.graph.hash !== graphHash(graph)) {
    fail("GRAPH_MISMATCH", `Run was created with a different graph than ${graph.id}@${graph.version}.`);
  }
  const next = structuredClone(run);
  const ctx = { run: next, graph, effects: [], at: typeof event.now === "string" && event.now !== "" ? event.now : run.updatedAt };
  HANDLERS[event.type](ctx, event);
  if (ctx.effects.length > 0) next.updatedAt = ctx.at;
  return { run: next, effects: ctx.effects };
}
