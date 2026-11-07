import assert from "node:assert/strict";
import test from "node:test";
import { check } from "../src/runtime/schema.mjs";
import {
  GraphError,
  canonicalJson,
  defineGraph,
  getGraph,
  graphHash,
  initialRun,
  registerGraph,
  registerPredicate,
  transition,
  validateGraph,
} from "../src/runtime/graph.mjs";
import { bugfixGraph, deliveryGraph } from "../src/runtime/graphs/index.mjs";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const REPO = { key: "repo-key", realpath: process.cwd() };
const FLOW = Object.keys(deliveryGraph.nodes);
const LEDGER_TYPES = new Set([
  "node.entered",
  "node.completed",
  "evidence.recorded",
  "budget.exhausted",
  "run.paused",
  "run.resumed",
  "run.aborted",
  "run.completed",
]);

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

// A thin driver around the pure reducer: keeps the current run, collects every effect, supplies `now`.
function session(graph = deliveryGraph) {
  let run = initialRun(graph, { runId: "run-1", goal: "ship it", repo: REPO, now: new Date(T0).toISOString() });
  let clock = 0;
  const effects = [];
  const api = {
    get run() {
      return run;
    },
    effects,
    send(event) {
      const result = transition(run, graph, { now: new Date(T0 + ++clock * 1000).toISOString(), ...event });
      run = result.run;
      effects.push(...result.effects);
      return result;
    },
    enter: () => api.send({ type: "enter" }),
    evidence: (kind, result = "pass", extra = {}) => api.send({ type: "evidence", kind, summary: `${kind} ${result}`, result, ...extra }),
    complete: (outcome, signature) => api.send({ type: "complete", outcome, ...(signature ? { signature } : {}) }),
    // enter + passing evidence for every required kind + pass
    pass() {
      const id = run.currentNode;
      if (graph.nodes[id].kind === "approval") return api.send({ type: "approve", by: "tester", summary: "ok" });
      api.enter();
      for (const kind of graph.nodes[id].evidence) api.evidence(kind);
      return api.complete("pass");
    },
    advanceTo(target) {
      while (run.currentNode !== target) api.pass();
      return api;
    },
    node: (id) => run.nodes[id],
  };
  return api;
}

const rejects = (fn, code) =>
  assert.throws(fn, (error) => error instanceof GraphError && (code === undefined || error.code === code), `expected GraphError ${code ?? ""}`);

// ---------------------------------------------------------------------------------------------
// schema.check
// ---------------------------------------------------------------------------------------------

test("schema.check covers the supported keywords and never echoes a value", () => {
  const spec = {
    type: "object",
    required: ["name", "count"],
    additionalProperties: false,
    properties: {
      name: { type: "string", pattern: "^[a-z]+$", maxLength: 5, minLength: 2 },
      count: { type: "integer", min: 1, max: 3 },
      mode: { enum: ["a", "b"] },
      fixed: { const: 1 },
      tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, uniqueItems: true },
      either: { type: ["string", "null"] },
    },
  };
  assert.deepEqual(check({ name: "ab", count: 2, mode: "a", fixed: 1, tags: ["x"], either: null }, spec), []);
  const bad = check({ name: "SECRET-VALUE", count: 9, mode: "c", fixed: 2, tags: ["x", "x", "y"], either: 4, extra: true }, spec);
  assert.ok(bad.some((message) => message.startsWith("$.name:")));
  assert.ok(bad.some((message) => message.startsWith("$.count:") && message.includes("above 3")));
  assert.ok(bad.some((message) => message.startsWith("$.mode:") && message.includes('"a", "b"')));
  assert.ok(bad.some((message) => message.startsWith("$.fixed:")));
  assert.ok(bad.some((message) => message.startsWith("$.tags:")));
  assert.ok(bad.some((message) => message.startsWith("$.either:") && message.includes("string or null")));
  assert.ok(bad.some((message) => message.startsWith("$.extra:") && message.includes("unexpected")));
  assert.ok(!bad.join("\n").includes("SECRET-VALUE"), "messages must not contain checked values");
  assert.deepEqual(check({}, spec).sort(), ["$: missing required property count", "$: missing required property name"]);
  assert.ok(check([], { type: "object" })[0].includes("expected object"));
  assert.ok(check(Number.NaN, { type: "number" }).length === 1);
  assert.ok(check(1.5, { type: "integer" }).length === 1);
  assert.deepEqual(check("x", { type: "string" }, "field"), []);
  assert.ok(check("x", { type: "bogus" })[0].includes("invalid spec type"));
});

test("schema.check applies additionalProperties specs and bounds recursion depth", () => {
  assert.deepEqual(check({ a: 1, b: 2 }, { type: "object", additionalProperties: { type: "integer" } }), []);
  assert.equal(check({ a: "x" }, { type: "object", additionalProperties: { type: "integer" } }).length, 1);
  assert.ok(check({ "we ird": "x" }, { type: "object", additionalProperties: { type: "integer" } })[0].startsWith('$["we ird"]'));
  const recursive = { type: "object" };
  recursive.additionalProperties = recursive;
  let deep = {};
  const root = deep;
  for (let index = 0; index < 100; index += 1) deep = deep.next = {};
  const problems = check(root, recursive);
  assert.ok(problems.length > 0 && problems.every((message) => message.includes("nested too deeply")));
});

// ---------------------------------------------------------------------------------------------
// validateGraph
// ---------------------------------------------------------------------------------------------

const OK_NODE = { kind: "task", maxAttempts: 2, evidence: [] };
const base = (patch = {}) => ({
  v: 1,
  id: "demo",
  version: 1,
  start: "a",
  terminals: { done: "completed", aborted: "aborted" },
  nodes: { a: { ...OK_NODE }, b: { ...OK_NODE } },
  edges: [
    { from: "a", on: "pass", to: "b" },
    { from: "b", on: "pass", to: "done" },
  ],
  ...patch,
});
const rejectsWith = (def, pattern) => {
  const errors = validateGraph(def);
  assert.ok(errors.some((message) => pattern.test(message)), `expected ${pattern} in: ${errors.join(" | ")}`);
};

test("validateGraph accepts the built-in graphs and a minimal graph", () => {
  assert.deepEqual(validateGraph(base()), []);
  assert.deepEqual(validateGraph(deliveryGraph), []);
  assert.deepEqual(validateGraph(bugfixGraph), []);
});

test("validateGraph rejects bad ids and ids that collide with a terminal", () => {
  rejectsWith(
    base({ start: "Bad_Id", nodes: { Bad_Id: { ...OK_NODE }, b: { ...OK_NODE } }, edges: [{ from: "Bad_Id", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }] }),
    /id must match/,
  );
  rejectsWith(
    base({ nodes: { a: { ...OK_NODE }, done: { ...OK_NODE } }, edges: [{ from: "a", on: "pass", to: "done" }] }),
    /duplicate id/,
  );
});

test("validateGraph rejects a missing start, dangling edges, and nodes with no pass edge", () => {
  rejectsWith(base({ start: "zzz" }), /start "zzz" is not a node/);
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "a", on: "fail-retryable", to: "nowhere", maxTraversals: 1 }] }), /unknown target/);
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "ghost", on: "fail-retryable", to: "a", maxTraversals: 1 }] }), /unknown source node/);
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }] }), /node b: has no pass edge/);
});

test("validateGraph rejects unreachable nodes and nodes that cannot reach a terminal", () => {
  rejectsWith(
    base({ nodes: { a: { ...OK_NODE }, b: { ...OK_NODE }, c: { ...OK_NODE } }, edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "c", on: "pass", to: "done" }] }),
    /node c: unreachable from start/,
  );
  rejectsWith(
    base({
      nodes: { a: { ...OK_NODE }, b: { ...OK_NODE }, c: { ...OK_NODE } },
      edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "c" }, { from: "c", on: "pass", to: "b", maxTraversals: 2 }],
    }),
    /node b: cannot reach a terminal/,
  );
});

test("validateGraph rejects unbounded cycles and accepts the same cycle once an edge is bounded", () => {
  const loop = (cap) =>
    base({
      edges: [
        { from: "a", on: "pass", to: "b" },
        { from: "b", on: "pass", to: "a", ...(cap ? { maxTraversals: cap } : {}) },
        { from: "b", on: "fail-retryable", to: "done" },
      ],
    });
  rejectsWith(loop(0), /unbounded cycle a -> b -> a/);
  assert.deepEqual(validateGraph(loop(3)), []);
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "a", on: "fail-retryable", to: "a" }] }), /unbounded cycle/);
  assert.deepEqual(validateGraph(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "a", on: "fail-retryable", to: "a", maxTraversals: 2 }] })), []);
});

test("validateGraph rejects duplicate (from, on, when), bad outcomes and engine-handled outcomes", () => {
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "a", on: "pass", to: "done" }, { from: "b", on: "pass", to: "done" }] }), /duplicate \(from, on, when\)/);
  rejectsWith(base({ edges: [{ from: "a", on: "explode", to: "b" }, { from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }] }), /on: must be one of/);
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }, { from: "a", on: "blocked", to: "b" }] }), /handled by the engine/);
  assert.deepEqual(
    validateGraph(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "a", on: "pass", to: "done", when: "x" }, { from: "b", on: "pass", to: "done" }] })),
    [],
    "same (from, on) with a different when is not a duplicate",
  );
});

test("validateGraph rejects conditional routes without a fallback and bad artifact wiring", () => {
  rejectsWith(base({ edges: [{ from: "a", on: "pass", to: "b", when: "x" }, { from: "b", on: "pass", to: "done" }] }), /unconditional fallback/);
  rejectsWith(base({ nodes: { a: { ...OK_NODE, dependsOn: ["ghost"] }, b: { ...OK_NODE } } }), /no node produces/);
  rejectsWith(base({ nodes: { a: { ...OK_NODE, produces: "doc" }, b: { ...OK_NODE, produces: "doc" } } }), /already produced/);
  rejectsWith(base({ nodes: { a: { ...OK_NODE, kind: "mystery" }, b: { ...OK_NODE } } }), /kind/);
  rejectsWith(base({ extra: true }), /unexpected property/);
  rejectsWith(base({ terminals: { done: "finished", aborted: "aborted" } }), /terminals\.done/);
  assert.throws(() => defineGraph(base({ start: "zzz" })), (error) => error instanceof GraphError && error.code === "GRAPH_INVALID" && error.errors.length > 0);
});

const FORKED = (patch = {}) => ({
  ...base(),
  start: "f",
  nodes: {
    f: { kind: "fork", maxAttempts: 1, evidence: [] },
    x: { ...OK_NODE },
    y: { ...OK_NODE },
    j: { kind: "join", maxAttempts: 1, evidence: [] },
    w: { kind: "wait", maxAttempts: 1, evidence: [] },
  },
  edges: [
    { from: "f", on: "pass", to: "x", when: "left" },
    { from: "f", on: "pass", to: "y", when: "right" },
    { from: "x", on: "pass", to: "j" },
    { from: "y", on: "pass", to: "j" },
    { from: "j", on: "pass", to: "w" },
    { from: "w", on: "pass", to: "done" },
  ],
  ...patch,
});

test("validateGraph accepts fork, join and wait definitions", () => {
  assert.deepEqual(validateGraph(FORKED()), []);
  assert.doesNotThrow(() => defineGraph(FORKED()));
});

test("validateGraph rejects malformed forks and joins, including predecessors from different forks", () => {
  rejectsWith(FORKED({ edges: FORKED().edges.map((edge) => (edge.to === "y" ? { ...edge, when: undefined } : edge)) }), /fork f: every branch edge needs a when label/);
  rejectsWith(FORKED({ edges: FORKED().edges.filter((edge) => edge.to !== "y") }), /needs at least two pass edges/);
  rejectsWith(FORKED({ edges: FORKED().edges.filter((edge) => edge.from !== "y").concat([{ from: "y", on: "pass", to: "done" }]) }), /join j: needs at least two predecessors/);

  // Two unrelated forks feeding one join. f1 and f2 are both reachable from start `s` but not from each other.
  const twoForks = {
    ...base(),
    start: "s",
    nodes: {
      s: { ...OK_NODE },
      f1: { kind: "fork", maxAttempts: 1, evidence: [] },
      f2: { kind: "fork", maxAttempts: 1, evidence: [] },
      a: { ...OK_NODE },
      c: { ...OK_NODE },
      b: { ...OK_NODE },
      d: { ...OK_NODE },
      j: { kind: "join", maxAttempts: 1, evidence: [] },
    },
    edges: [
      { from: "s", on: "pass", to: "f1" },
      { from: "s", on: "fail-retryable", to: "f2" },
      { from: "f1", on: "pass", to: "a", when: "l" },
      { from: "f1", on: "pass", to: "c", when: "r" },
      { from: "f2", on: "pass", to: "b", when: "l" },
      { from: "f2", on: "pass", to: "d", when: "r" },
      { from: "a", on: "pass", to: "j" },
      { from: "b", on: "pass", to: "j" },
      { from: "c", on: "pass", to: "done" },
      { from: "d", on: "pass", to: "done" },
      { from: "j", on: "pass", to: "done" },
    ],
  };
  rejectsWith(twoForks, /join j: predecessors do not all come from one fork/);
});

test("reducer refuses to execute fork and join nodes (validator-only in this release)", () => {
  const graph = defineGraph(FORKED());
  const s = session(graph);
  rejects(() => s.enter(), "UNSUPPORTED_NODE_KIND");
});

// ---------------------------------------------------------------------------------------------
// Built-in graphs, hashing, registry, initialRun
// ---------------------------------------------------------------------------------------------

test("delivery@1 and bugfix@1 are registered, frozen and hash deterministically", () => {
  assert.equal(getGraph("delivery", 1), deliveryGraph);
  assert.equal(getGraph("delivery@1"), deliveryGraph);
  assert.equal(getGraph("bugfix", 1), bugfixGraph);
  assert.equal(getGraph("delivery", 2), undefined);
  assert.ok(Object.isFrozen(deliveryGraph) && Object.isFrozen(deliveryGraph.nodes.intake.evidence));
  assert.match(graphHash(deliveryGraph), /^[0-9a-f]{64}$/);
  assert.equal(graphHash(deliveryGraph), graphHash(JSON.parse(JSON.stringify(deliveryGraph))));
  assert.notEqual(graphHash(deliveryGraph), graphHash(bugfixGraph));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  assert.equal(registerGraph(deliveryGraph), deliveryGraph, "re-registering identical content is a no-op");
  const altered = JSON.parse(JSON.stringify(deliveryGraph));
  altered.nodes.intake.maxAttempts = 5;
  rejects(() => registerGraph(altered), "GRAPH_CONFLICT");
});

test("bugfix@1 is delivery minus challenge with required reproduction evidence on analyze", () => {
  assert.ok(!("challenge" in bugfixGraph.nodes));
  assert.deepEqual(Object.keys(bugfixGraph.nodes), FLOW.filter((id) => id !== "challenge"));
  assert.deepEqual(bugfixGraph.nodes.analyze.evidence, ["repository", "baseline", "reproduction"]);
  assert.ok(bugfixGraph.edges.every((edge) => edge.from !== "challenge" && edge.to !== "challenge"));
  assert.equal(bugfixGraph.edges.find((edge) => edge.from === "analyze" && edge.on === "pass").to, "plan");
  const s = session(bugfixGraph);
  s.pass();
  s.enter();
  s.evidence("repository");
  s.evidence("baseline");
  rejects(() => s.complete("pass"), "EVIDENCE_MISSING");
  s.evidence("reproduction");
  s.complete("pass");
  assert.equal(s.run.currentNode, "plan");
  s.advanceTo("done");
  assert.equal(s.run.status, "completed");
});

test("every cycle in the built-in graphs is bounded and every retry edge has a traversal cap", () => {
  for (const graph of [deliveryGraph, bugfixGraph]) {
    for (const edge of graph.edges) {
      if (edge.on !== "pass") assert.ok(Number.isInteger(edge.maxTraversals), `${graph.id}: ${edge.from} ${edge.on}`);
    }
  }
});

test("initialRun produces the run.json shape without mutating anything", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const options = { runId: "r-1", goal: "  do the thing  ", repo: REPO, now };
  const run = initialRun(deliveryGraph, options);
  assert.deepEqual(initialRun(deliveryGraph, options), run);
  assert.equal(run.v, 1);
  assert.deepEqual(run.graph, { id: "delivery", version: 1, hash: graphHash(deliveryGraph) });
  assert.equal(run.goal, "do the thing");
  assert.equal(run.status, "active");
  assert.equal(run.currentNode, "intake");
  assert.deepEqual(Object.keys(run.nodes), FLOW);
  assert.deepEqual(run.nodes.implement, { status: "pending", attempts: 0, maxAttempts: 3, traversals: {}, outcome: null, failureSignatures: [], attemptLog: [] });
  assert.deepEqual(run.artifacts, {});
  assert.deepEqual(run.approvals, []);
  assert.deepEqual(run.budgets, { used: { iterations: 0, toolCalls: 0, tokens: 0, wallMs: 0 } });
  assert.equal(run.lastSeq, 0);
  assert.equal(run.policyHash, null);
  assert.equal(run.createdAt, now);
  assert.equal(run.updatedAt, now);
  assert.deepEqual(run.repo, REPO);
  rejects(() => initialRun(deliveryGraph, { ...options, goal: " " }), "BAD_RUN");
  rejects(() => initialRun(deliveryGraph, { ...options, runId: "" }), "BAD_RUN");
});

// ---------------------------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------------------------

test("a full delivery run passes every node, produces the plan artifact, and completes", () => {
  const s = session();
  s.advanceTo("done");
  assert.equal(s.run.status, "completed");
  assert.equal(s.run.currentNode, "done");
  for (const id of FLOW) {
    assert.equal(s.node(id).status, "passed", id);
    assert.equal(s.node(id).attempts, 1, id);
    assert.equal(s.node(id).attemptLog.at(-1).outcome, "pass", id);
  }
  assert.equal(s.run.artifacts.plan.revision, 1);
  assert.deepEqual(s.run.artifacts.plan.dependsOn, []);
  assert.equal(s.effects.at(-1).type, "run.completed");
  rejects(() => s.enter(), "RUN_NOT_ACTIVE");
  rejects(() => s.send({ type: "abort" }), "RUN_NOT_ACTIVE");
});

test("effects stay inside the ledger vocabulary and never carry at or seq, even when the event does", () => {
  const all = [];
  const run = (build) => {
    const s = session();
    build(s);
    all.push(...s.effects);
  };
  run((s) => s.advanceTo("done"));
  run((s) => {
    s.advanceTo("test");
    s.enter();
    s.complete("fail-retryable", "sig-1");
    s.pass();
    s.enter();
    s.complete("fail-retryable", "sig-1");
  });
  run((s) => {
    s.enter();
    s.complete("needs-human");
    s.send({ type: "resume" });
    s.enter();
    s.send({ type: "pause", reason: "stop", status: "paused" });
    s.send({ type: "resume" });
    s.send({ type: "abort", reason: "done here", at: "evil", seq: 99 });
  });
  run((s) => {
    s.advanceTo("implement");
    s.enter();
    s.send({ type: "complete", outcome: "fail-replan", at: "evil", seq: 7, signature: "x" });
  });
  assert.ok(all.length > 30);
  for (const effect of all) {
    assert.ok(LEDGER_TYPES.has(effect.type), `unexpected effect type ${effect.type}`);
    assert.ok(!("at" in effect) && !("seq" in effect), `effect ${effect.type} must not carry at/seq`);
  }
  const s = session();
  const result = s.send({ type: "enter", at: "evil", seq: 5 });
  assert.deepEqual(Object.keys(result.effects[0]).sort(), ["attempt", "attempts", "node", "type"]);
  assert.equal(result.run.updatedAt, new Date(T0 + 1000).toISOString(), "run timestamps come from `now`, not from `at`");
});

test("transition is pure: the input run is never mutated and rejected events change nothing", () => {
  const s = session();
  s.enter();
  const frozen = deepFreeze(structuredClone(s.run));
  const result = transition(frozen, deliveryGraph, { type: "evidence", kind: "task", summary: "s", result: "pass", now: "2026-02-02T00:00:00.000Z" });
  assert.notEqual(result.run, frozen);
  assert.equal(frozen.nodes.intake.attemptLog[0].evidence.length, 0);
  assert.equal(result.run.nodes.intake.attemptLog[0].evidence.length, 1);
  assert.ok(result.effects.length >= 1, "a state change always yields an effect to append first");
  assert.throws(() => transition(frozen, deliveryGraph, { type: "complete", outcome: "pass" }), GraphError);
  assert.equal(frozen.nodes.intake.status, "running");
  assert.equal(frozen.updatedAt, s.run.updatedAt);
});

test("transition rejects unknown events, a mismatched graph, and malformed arguments", () => {
  const s = session();
  rejects(() => s.send({ type: "teleport" }), "BAD_EVENT");
  rejects(() => transition(s.run, deliveryGraph, null), "BAD_EVENT");
  rejects(() => transition(s.run, bugfixGraph, { type: "enter" }), "GRAPH_MISMATCH");
  const tampered = structuredClone(s.run);
  tampered.graph.hash = "0".repeat(64);
  rejects(() => transition(tampered, deliveryGraph, { type: "enter" }), "GRAPH_MISMATCH");
  rejects(() => s.send({ type: "enter", node: "analyze" }), "WRONG_NODE");
  const corrupt = structuredClone(s.run);
  delete corrupt.nodes.intake;
  rejects(() => transition(corrupt, deliveryGraph, { type: "enter" }), "RUN_CORRUPT");
  rejects(() => s.send({ type: "complete", outcome: "explode" }), "BAD_OUTCOME");
});

test("enter requires an active run, the current node and a runnable status", () => {
  const s = session();
  s.enter();
  assert.equal(s.node("intake").status, "running");
  assert.equal(s.node("intake").attempts, 1);
  assert.deepEqual(s.node("intake").attemptLog[0], { n: 1, startedAt: new Date(T0 + 1000).toISOString(), endedAt: null, outcome: null, evidence: [], refunded: false });
  rejects(() => s.enter(), "ALREADY_RUNNING");
  rejects(() => s.send({ type: "enter", node: "plan" }), "WRONG_NODE");
  s.send({ type: "pause", reason: "stop" });
  rejects(() => s.enter(), "RUN_NOT_ACTIVE");
});

test("enter on an exhausted node blocks the run with budget.exhausted instead of throwing", () => {
  const s = session();
  const tampered = structuredClone(s.run);
  tampered.nodes.intake.attempts = 2;
  const result = transition(tampered, deliveryGraph, { type: "enter", now: "2026-01-02T00:00:00.000Z" });
  assert.equal(result.run.status, "blocked");
  assert.equal(result.run.nodes.intake.attempts, 2);
  assert.equal(result.run.nodes.intake.status, "pending");
  assert.deepEqual(result.effects, [{ type: "budget.exhausted", scope: "node", node: "intake", attempts: 2, maxAttempts: 2 }]);
});

test("pass needs current-attempt evidence for every required kind; info satisfies, any failing latest blocks", () => {
  const s = session();
  s.advanceTo("analyze");
  s.enter();
  rejects(() => s.complete("pass"), "EVIDENCE_MISSING");
  s.evidence("repository", "info");
  rejects(() => s.complete("pass"), "EVIDENCE_MISSING");
  s.evidence("baseline", "fail");
  rejects(() => s.complete("pass"), "EVIDENCE_FAILING");
  s.evidence("baseline", "pass");
  s.evidence("extra-kind", "fail");
  rejects(() => s.complete("pass"), "EVIDENCE_FAILING");
  s.evidence("extra-kind", "info");
  s.complete("pass");
  assert.equal(s.node("analyze").status, "passed");
  assert.deepEqual(s.node("analyze").attemptLog[0].evidence.map((item) => [item.kind, item.result, item.attempt]).slice(0, 2), [["repository", "info", 1], ["baseline", "fail", 1]]);
});

test("evidence is validated: needs a running current node, a kind, a summary and a known result", () => {
  const s = session();
  rejects(() => s.evidence("task"), "NOT_RUNNING");
  s.enter();
  rejects(() => s.send({ type: "evidence", kind: " ", summary: "x", result: "pass" }), "BAD_EVENT");
  rejects(() => s.send({ type: "evidence", kind: "task", summary: "", result: "pass" }), "BAD_EVENT");
  rejects(() => s.send({ type: "evidence", kind: "task", summary: "x", result: "great" }), "BAD_EVENT");
  rejects(() => s.send({ type: "evidence", kind: "task", summary: "x", result: "pass", sha256: "nope" }), "BAD_EVENT");
  rejects(() => s.send({ type: "evidence", node: "plan", kind: "task", summary: "x", result: "pass" }), "WRONG_NODE");
  const entry = s.evidence("task", "pass", { path: "a/b.txt", sha256: "a".repeat(64) }).effects[0].evidence;
  assert.deepEqual(entry, { kind: "task", summary: "task pass", result: "pass", path: "a/b.txt", sha256: "a".repeat(64), attempt: 1 });
});

test("evidence counts per attempt: a re-run cannot pass on stale evidence", () => {
  const s = session();
  s.advanceTo("analyze");
  s.enter();
  s.evidence("repository");
  s.evidence("baseline");
  s.complete("fail-retryable", "a");
  assert.equal(s.run.currentNode, "analyze");
  s.enter();
  assert.equal(s.node("analyze").attemptLog.length, 2);
  rejects(() => s.complete("pass"), "EVIDENCE_MISSING");
  s.evidence("repository");
  rejects(() => s.complete("pass"), "EVIDENCE_MISSING");
  s.evidence("baseline");
  s.complete("pass");
  assert.equal(s.run.currentNode, "challenge");
});

test("fail-retryable from test, verify, review, monitor-pipeline and resolve-review-comments routes to implement and invalidates the range", () => {
  for (const id of ["test", "verify", "review", "monitor-pipeline", "resolve-review-comments"]) {
    const s = session();
    s.advanceTo(id);
    s.enter();
    s.complete("fail-retryable", `sig-${id}`);
    assert.equal(s.run.currentNode, "implement", id);
    assert.equal(s.run.status, "active", id);
    const range = FLOW.slice(FLOW.indexOf("implement"), FLOW.indexOf(id) + 1);
    for (const name of FLOW) {
      const expected = range.includes(name) ? "pending" : FLOW.indexOf(name) < FLOW.indexOf("implement") ? "passed" : "pending";
      assert.equal(s.node(name).status, expected, `${id}: ${name}`);
    }
    assert.equal(s.node(id).attempts, 1, "attempts are kept across invalidation");
    assert.equal(s.node("implement").attempts, 1);
    assert.deepEqual(s.node(id).failureSignatures, [`sig-${id}`]);
    assert.ok(s.node(id).attemptLog[0].endedAt, "history is kept");
  }
});

test("fail-retryable elsewhere retries the same node; approve has a single attempt so it blocks", () => {
  for (const id of ["intake", "analyze", "challenge", "plan", "implement", "submit-pr", "update-work-item"]) {
    const s = session();
    s.advanceTo(id);
    s.enter();
    s.complete("fail-retryable", `sig-${id}`);
    assert.equal(s.run.currentNode, id, id);
    assert.equal(s.node(id).status, "failed", id);
    assert.equal(s.run.status, "active", id);
    s.enter();
    assert.equal(s.node(id).attempts, 2, id);
  }
  const s = session();
  s.advanceTo("approve");
  s.enter();
  s.complete("fail-retryable");
  assert.equal(s.run.status, "blocked");
  assert.equal(s.run.currentNode, "approve");
});

test("fail-retryable on the last attempt blocks the run in place", () => {
  const s = session();
  s.enter();
  s.complete("fail-retryable", "one");
  s.enter();
  s.complete("fail-retryable", "two");
  assert.equal(s.run.status, "blocked");
  assert.equal(s.run.currentNode, "intake");
  assert.equal(s.node("intake").status, "failed");
  assert.equal(s.effects.at(-1).type, "budget.exhausted");
});

test("fail-replan before plan retries the same node locally instead of jumping forward", () => {
  for (const id of ["intake", "analyze", "challenge"]) {
    const s = session();
    s.advanceTo(id);
    s.enter();
    s.complete("fail-replan", `r-${id}`);
    assert.equal(s.run.currentNode, id, id);
    assert.equal(s.node(id).status, "failed", id);
    assert.equal(s.node("plan").status, "pending");
    assert.equal(s.run.status, "active");
  }
});

test("fail-replan from implement routes to plan and invalidates plan..implement; plan itself retries", () => {
  const s = session();
  s.advanceTo("implement");
  s.enter();
  s.complete("fail-replan", "design-flaw");
  assert.equal(s.run.currentNode, "plan");
  for (const id of ["plan", "approve", "implement"]) assert.equal(s.node(id).status, "pending", id);
  for (const id of ["intake", "analyze", "challenge"]) assert.equal(s.node(id).status, "passed", id);
  const p = session();
  p.advanceTo("plan");
  p.enter();
  p.complete("fail-replan", "again");
  assert.equal(p.run.currentNode, "plan");
  assert.equal(p.node("plan").status, "failed");
});

test("a new plan revision resets the approve budget so a replanned run can be approved again", () => {
  const s = session();
  s.advanceTo("implement");
  assert.equal(s.node("approve").attempts, 1);
  s.enter();
  s.complete("fail-replan", "design-flaw");
  s.pass(); // plan, attempt 2
  assert.equal(s.run.artifacts.plan.revision, 2);
  assert.equal(s.node("approve").attempts, 0, "budget reset by the new plan revision");
  assert.equal(s.run.currentNode, "approve");
  s.pass();
  assert.equal(s.run.currentNode, "implement");
  assert.equal(s.node("approve").status, "passed");
  assert.equal(s.node("approve").attemptLog.length, 2, "history is never dropped");
});

test("the same failure signature twice on one node blocks it; counting is per node", () => {
  const s = session();
  s.advanceTo("implement");
  s.enter();
  s.complete("fail-retryable", "sig-A");
  s.enter();
  assert.equal(s.run.status, "active");
  const blocked = s.complete("fail-retryable", "  sig-A ");
  assert.equal(s.run.status, "blocked");
  assert.equal(s.run.currentNode, "implement");
  assert.equal(s.node("implement").attempts, 2);
  assert.deepEqual(s.node("implement").failureSignatures, ["sig-A", "sig-A"]);
  assert.deepEqual(blocked.effects, [{ type: "node.completed", node: "implement", outcome: "fail-retryable", signature: "sig-A", stableFailure: true, next: "implement" }]);

  // The same signature on two different nodes is not a repeat.
  const t = session();
  t.advanceTo("test");
  t.enter();
  t.complete("fail-retryable", "shared");
  t.pass(); // implement
  t.advanceTo("verify");
  t.enter();
  t.complete("fail-retryable", "shared");
  assert.equal(t.run.status, "active");
  assert.equal(t.run.currentNode, "implement");
});

test("a failure without a usable edge blocks the run instead of guessing a route", () => {
  const graph = defineGraph(base({ edges: [{ from: "a", on: "pass", to: "b" }, { from: "b", on: "pass", to: "done" }] }));
  const s = session(graph);
  s.enter();
  const result = s.complete("fail-retryable");
  assert.equal(s.run.status, "blocked");
  assert.equal(result.effects[0].routed, false);
});

test("blocked, needs-human, policy-denied and security-escalation pause in place and refund the attempt", () => {
  for (const outcome of ["blocked", "needs-human", "policy-denied", "security-escalation"]) {
    const s = session();
    s.advanceTo("review");
    s.enter();
    s.evidence("code-review");
    const result = s.complete(outcome);
    assert.equal(s.run.status, "blocked", outcome);
    assert.equal(s.run.currentNode, "review", outcome);
    assert.equal(s.node("review").status, "blocked", outcome);
    assert.equal(s.node("review").attempts, 0, `${outcome} refunds the attempt`);
    assert.equal(s.node("review").attemptLog[0].refunded, true);
    assert.equal(s.node("review").attemptLog[0].outcome, outcome);
    assert.deepEqual(result.effects.map((effect) => effect.type), ["node.completed", "run.paused"]);
    s.send({ type: "resume" });
    assert.equal(s.run.status, "active");
    assert.equal(s.node("review").status, "pending");
    s.enter();
    assert.equal(s.node("review").attempts, 1, "the retried attempt is counted once");
    assert.equal(s.node("review").attemptLog.length, 2);
    assert.deepEqual(s.node("review").attemptLog[1].evidence, [], "refunded attempts do not leak evidence into the next one");
    assert.equal(s.node("review").attemptLog[1].n, 2, "attempt numbers stay monotonic even though attempts was refunded");
  }
});

test("repeated pause and resume never exhaust the budget", () => {
  const s = session();
  for (let index = 0; index < 6; index += 1) {
    s.enter();
    s.complete("needs-human");
    s.send({ type: "resume" });
  }
  s.pass();
  assert.equal(s.run.currentNode, "analyze");
  assert.equal(s.node("intake").attemptLog.length, 7);
});

test("resume is only valid for blocked, paused and waiting runs and keeps a mid-attempt node running", () => {
  const s = session();
  rejects(() => s.send({ type: "resume" }), "NOT_RESUMABLE");
  s.enter();
  s.send({ type: "pause", reason: "ctrl-c" });
  assert.equal(s.run.status, "paused");
  rejects(() => s.evidence("task"), "RUN_NOT_ACTIVE");
  s.send({ type: "resume" });
  assert.equal(s.run.status, "active");
  assert.equal(s.node("intake").status, "running");
  assert.equal(s.node("intake").attempts, 1, "the interrupted attempt continues; no new attempt is consumed");
  s.evidence("task");
  s.complete("pass");
  s.send({ type: "pause", status: "waiting-approval" });
  assert.equal(s.run.status, "waiting-approval");
  rejects(() => s.send({ type: "pause" }), "RUN_NOT_ACTIVE");
  rejects(() => session().send({ type: "pause", status: "blocked" }), "BAD_EVENT");
});

test("after a routed budget exhaustion the run is positioned at the node that must re-run", () => {
  const s = session();
  s.advanceTo("test");
  s.enter();
  s.complete("fail-retryable", "t1"); // implement attempt 2 next
  s.pass(); // implement 2
  s.advanceTo("verify");
  s.enter();
  s.complete("fail-retryable", "v1"); // implement attempt 3 next
  s.pass(); // implement 3
  s.advanceTo("review");
  s.enter();
  assert.equal(s.node("implement").attempts, 3);
  s.complete("fail-retryable", "r1"); // implement is out of attempts
  assert.equal(s.run.status, "blocked");
  assert.equal(s.run.currentNode, "implement", "not at review: review must not run on the old change");
  assert.equal(s.node("review").status, "pending");
  assert.equal(s.node("review").attempts, 1);
  assert.deepEqual(s.effects.slice(-2).map((effect) => [effect.type, effect.scope, effect.node]), [["node.completed", undefined, "review"], ["budget.exhausted", "node", "implement"]]);
  s.send({ type: "resume" });
  assert.equal(s.run.status, "active");
  s.enter();
  assert.equal(s.run.status, "blocked", "resume does not top the budget up; implement blocks again, honestly");
  assert.equal(s.effects.at(-1).type, "budget.exhausted");
  assert.equal(s.node("implement").attempts, 3);
});

test("abort ends the run from a running node or from any non-terminal state", () => {
  const s = session();
  s.enter();
  s.complete("abort");
  assert.equal(s.run.status, "aborted");
  assert.equal(s.node("intake").status, "failed");
  assert.equal(s.node("intake").outcome, "abort");
  assert.equal(s.run.currentNode, "intake");
  assert.deepEqual(s.effects.slice(-2).map((effect) => effect.type), ["node.completed", "run.aborted"]);
  rejects(() => s.enter(), "RUN_NOT_ACTIVE");

  const blocked = session();
  blocked.enter();
  blocked.complete("blocked");
  blocked.send({ type: "abort", reason: "operator" });
  assert.equal(blocked.run.status, "aborted");
  assert.equal(blocked.effects.at(-1).reason, "operator");
  rejects(() => blocked.send({ type: "abort" }), "RUN_NOT_ACTIVE");
  rejects(() => blocked.send({ type: "resume" }), "NOT_RESUMABLE");
});

test("evidence, complete and enter are rejected while the run is not active", () => {
  const s = session();
  s.enter();
  s.send({ type: "pause" });
  rejects(() => s.evidence("task"), "RUN_NOT_ACTIVE");
  rejects(() => s.complete("pass"), "RUN_NOT_ACTIVE");
  rejects(() => s.complete("fail-retryable"), "RUN_NOT_ACTIVE");
  rejects(() => s.enter(), "RUN_NOT_ACTIVE");
  const b = session();
  b.enter();
  b.complete("needs-human");
  rejects(() => b.evidence("task"), "RUN_NOT_ACTIVE");
  rejects(() => b.complete("pass"), "RUN_NOT_ACTIVE");
});

test("approve works only on the approval node, enters it, records evidence and advances", () => {
  const s = session();
  rejects(() => s.send({ type: "approve", by: "me", summary: "ok" }), "NOT_APPROVAL_NODE");
  s.advanceTo("approve");
  rejects(() => s.send({ type: "approve", by: "", summary: "ok" }), "BAD_EVENT");
  rejects(() => s.send({ type: "approve", by: "me" }), "BAD_EVENT");
  const result = s.send({ type: "approve", by: " me ", summary: " plan v1 " });
  assert.deepEqual(result.effects.map((effect) => effect.type), ["node.entered", "evidence.recorded", "node.completed"]);
  assert.equal(result.effects[1].evidence.summary, "me: plan v1");
  assert.equal(s.run.currentNode, "implement");
  assert.equal(s.node("approve").attempts, 1);
  assert.deepEqual(s.run.approvals, [], "approval records belong to the approvals module, not the graph");
  // waiting-approval runs can be approved directly
  const w = session();
  w.advanceTo("approve");
  w.enter();
  w.send({ type: "pause", status: "waiting-approval", reason: "asked" });
  w.send({ type: "approve", by: "me", summary: "ok" });
  assert.equal(w.run.status, "active");
  assert.equal(w.run.currentNode, "implement");
});

test("plan pass records the artifact hash from its evidence and later revisions bump the revision", () => {
  const s = session();
  s.advanceTo("plan");
  s.enter();
  s.evidence("plan", "pass", { sha256: "b".repeat(64) });
  s.complete("pass");
  assert.deepEqual(s.run.artifacts.plan, { hash: "b".repeat(64), revision: 1, dependsOn: [] });
});

// ---------------------------------------------------------------------------------------------
// Edge bounds, predicates, wait nodes and explicit invalidation (custom graphs)
// ---------------------------------------------------------------------------------------------

test("edge traversal caps block the run when exhausted", () => {
  const graph = defineGraph(
    base({
      nodes: { a: { ...OK_NODE, maxAttempts: 9 }, b: { ...OK_NODE } },
      edges: [
        { from: "a", on: "pass", to: "b" },
        { from: "a", on: "fail-retryable", to: "a", maxTraversals: 1 },
        { from: "b", on: "pass", to: "done" },
      ],
    }),
  );
  const s = session(graph);
  s.enter();
  s.complete("fail-retryable");
  assert.equal(s.run.status, "active");
  assert.deepEqual(s.node("a").traversals, { "fail-retryable:a": 1 });
  s.enter();
  s.complete("fail-retryable");
  assert.equal(s.run.status, "blocked");
  assert.equal(s.run.currentNode, "a");
  assert.deepEqual(s.effects.slice(-2).map((effect) => [effect.type, effect.scope]), [["node.completed", undefined], ["budget.exhausted", "edge"]]);
});

test("conditional edges use registered predicates and fall back when none holds", () => {
  registerPredicate("goal-mentions-docs", (run) => run.goal.includes("docs"));
  const graph = defineGraph(
    base({
      nodes: { a: { ...OK_NODE }, b: { ...OK_NODE }, c: { ...OK_NODE } },
      edges: [
        { from: "a", on: "pass", to: "b", when: "goal-mentions-docs" },
        { from: "a", on: "pass", to: "c" },
        { from: "b", on: "pass", to: "done" },
        { from: "c", on: "pass", to: "done" },
      ],
    }),
  );
  const docs = transition(initialRun(graph, { runId: "r", goal: "fix the docs", repo: REPO, now: "2026-01-01T00:00:00.000Z" }), graph, { type: "enter" });
  assert.equal(transition(docs.run, graph, { type: "complete", outcome: "pass" }).run.currentNode, "b");
  const other = transition(initialRun(graph, { runId: "r", goal: "fix the code", repo: REPO, now: "2026-01-01T00:00:00.000Z" }), graph, { type: "enter" });
  assert.equal(transition(other.run, graph, { type: "complete", outcome: "pass" }).run.currentNode, "c");
});

test("explicit invalidate lists reset exactly the listed nodes; wait nodes continue on resume", () => {
  const graph = defineGraph({
    ...base(),
    nodes: { a: { ...OK_NODE }, w: { kind: "wait", maxAttempts: 2, evidence: [] }, c: { ...OK_NODE, maxAttempts: 3 } },
    edges: [
      { from: "a", on: "pass", to: "w" },
      { from: "w", on: "pass", to: "c" },
      { from: "c", on: "pass", to: "done" },
      { from: "c", on: "fail-retryable", to: "w", invalidate: ["a", "w"], maxTraversals: 2 },
    ],
  });
  const s = session(graph);
  s.pass(); // a
  s.enter(); // w
  assert.equal(s.run.status, "waiting-external");
  rejects(() => s.evidence("x"), "RUN_NOT_ACTIVE");
  s.send({ type: "resume" });
  assert.equal(s.run.status, "active");
  assert.equal(s.node("w").status, "passed");
  assert.equal(s.run.currentNode, "c");
  s.enter();
  s.complete("fail-retryable");
  assert.equal(s.run.currentNode, "w");
  assert.equal(s.node("a").status, "pending");
  assert.equal(s.node("w").status, "pending");
  assert.equal(s.node("c").status, "failed");
});
