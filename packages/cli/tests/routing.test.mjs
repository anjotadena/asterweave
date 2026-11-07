// C2: model routing config keys, resolveRoute, the pinned route in run.json, drift, and the fallback rule.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { coerceValue, ConfigError, ENV_NAMES, KNOWN_KEYS, resolveConfig } from "../src/config.mjs";
import { createFakeExecutor } from "../src/runtime/fake-executor.mjs";
import { getGraph } from "../src/runtime/graph.mjs";
import "../src/runtime/graphs/index.mjs";
import { loadRun } from "../src/runtime/ledger.mjs";
import { createRunForGraph, runLoop } from "../src/runtime/loop.mjs";
import { CATALOG, classifyFailure, configOfPinned, nextRoute, pinRouting, resolveRoute, routingDrift, routingFromEntries, STAGE_NODES } from "../src/runtime/routing.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";
import { baseOptions, deliveryGraph, makeBox, readEvents, wait } from "./loop-fixture.mjs";

after(cleanupTemp);

const configOf = (user, env = {}) => {
  const dir = tempDir("aw-route-");
  mkdirSync(dir, { recursive: true });
  if (user !== undefined) writeFileSync(join(dir, "config.json"), JSON.stringify(user));
  return routingFromEntries(resolveConfig({ env: { ASTERWEAVE_CONFIG_DIR: dir, ...env } }).entries);
};

// --- config keys ------------------------------------------------------------------------------------------------------

test("model config keys: defaults are unset, user nested spelling and env both work, bad values are rejected without echo", () => {
  assert.deepEqual(configOf(undefined), { default: null, effort: null, fallback: [], stages: {} });
  const user = configOf({ model: { default: "claude-sonnet-5-5", effort: "high", fallback: ["claude-opus-5-5"], stages: { plan: "claude-opus-5-5" } } });
  assert.deepEqual(user, { default: "claude-sonnet-5-5", effort: "high", fallback: ["claude-opus-5-5"], stages: { plan: "claude-opus-5-5" } });
  const env = configOf({ model: { default: "claude-sonnet-5-5" } }, { ASTERWEAVE_MODEL: "claude-haiku-5-5", ASTERWEAVE_MODEL_FALLBACK: "claude-opus-5-5, my-custom.model", ASTERWEAVE_MODEL_STAGE_SUBMIT_PR: "claude-haiku-5-5", ASTERWEAVE_MODEL_EFFORT: "max" });
  assert.deepEqual(env, { default: "claude-haiku-5-5", effort: "max", fallback: ["claude-opus-5-5", "my-custom.model"], stages: { "submit-pr": "claude-haiku-5-5" } });

  for (const key of STAGE_NODES) assert.ok(KNOWN_KEYS[`model.stages.${key}`], key);
  assert.equal(ENV_NAMES["model.stages.resolve-review-comments"], "ASTERWEAVE_MODEL_STAGE_RESOLVE_REVIEW_COMMENTS");
  assert.ok(Object.keys(KNOWN_KEYS).filter((key) => key.startsWith("model.")).every((key) => KNOWN_KEYS[key].repo !== true), "a repository cannot choose the model");

  for (const [key, value] of [["model.default", "Bad Model"], ["model.effort", "extreme"], ["model.fallback", "a,b,c,d,e"], ["model.fallback", "a,a"], ["model.fallback", ""], ["model.fallback", [1]], ["model.stages.plan", "x y"]]) {
    assert.throws(() => coerceValue(key, value, { origin: "test", fromString: typeof value === "string" }), (error) => error instanceof ConfigError && !error.message.includes("Bad Model"), `${key}=${String(value).slice(0, 8)}`);
  }
});

// --- resolveRoute -----------------------------------------------------------------------------------------------------

test("resolveRoute: stage wins over default over the runner default, and it says why", () => {
  const config = { default: "claude-sonnet-5-5", effort: "high", fallback: ["claude-opus-5-5", "claude-haiku-5-5"], stages: { plan: "claude-opus-5-5" } };
  const stage = resolveRoute({ config, node: "plan" });
  assert.deepEqual([stage.model, stage.source, stage.effort, stage.availability], ["claude-opus-5-5", "stage", "high", "unverified"]);
  assert.deepEqual(stage.fallbackChain, ["claude-haiku-5-5"], "the chosen model is not its own fallback");
  assert.match(stage.reason, /model\.stages\.plan/);
  const dflt = resolveRoute({ config, node: "test" });
  assert.deepEqual([dflt.model, dflt.source], ["claude-sonnet-5-5", "default"]);
  const none = resolveRoute({ config: { default: null, effort: null, fallback: [], stages: {} }, node: "test" });
  assert.deepEqual([none.model, none.source, none.availability, none.warnings], [null, "runner-default", "unverified", []]);
  assert.equal(Object.values(CATALOG).every((entry) => entry.source === "static-catalog" && entry.availability === "unverified"), true);
});

test("resolveRoute: unknown models are allowed but flagged, undocumented effort only warns, unavailable models are skipped", () => {
  const custom = resolveRoute({ config: { default: "my-custom-model", effort: "max", fallback: ["claude-haiku-5-5"], stages: {} }, node: "plan" });
  assert.equal(custom.model, "my-custom-model");
  assert.equal(custom.availability, "unknown-model");
  assert.ok(custom.warnings.some((w) => w.includes("static catalog")));
  const haiku = resolveRoute({ config: { default: "claude-haiku-5-5", effort: "high", fallback: [], stages: {} }, node: "plan" });
  assert.ok(haiku.warnings.some((w) => w.includes("effort 'high'")));
  assert.equal(haiku.availability, "unverified");
  const skipped = resolveRoute({ config: { default: "claude-opus-5-5", effort: null, fallback: ["claude-sonnet-5-5", "claude-haiku-5-5"], stages: {} }, node: "plan", unavailable: ["claude-opus-5-5"] });
  assert.equal(skipped.model, "claude-sonnet-5-5");
  assert.deepEqual(skipped.fallbackChain, ["claude-haiku-5-5"]);
  assert.ok(skipped.warnings.some((w) => w.includes("unavailable")));
  const stuck = resolveRoute({ config: { default: "claude-opus-5-5", effort: null, fallback: [], stages: {} }, node: "plan", unavailable: ["claude-opus-5-5"] });
  assert.equal(stuck.model, "claude-opus-5-5", "never fails closed");
});

// --- pin and drift ----------------------------------------------------------------------------------------------------

test("the route is pinned in run.json at start, survives the loop, and older runs without it still load", async () => {
  const box = makeBox();
  const config = { default: "claude-sonnet-5-5", effort: "medium", fallback: ["claude-haiku-5-5"], stages: { review: "claude-opus-5-5" } };
  const pinned = pinRouting(config);
  assert.equal(pinned.promptVersion, 1);
  assert.match(pinned.configHash, /^[0-9a-f]{64}$/);
  assert.equal(pinRouting({ ...config, stages: { ...config.stages } }).configHash, pinned.configHash, "stable hash");
  assert.notEqual(pinRouting({ ...config, effort: "high" }).configHash, pinned.configHash);

  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: box.repo, runId: "run-p", routing: pinned, now: box.now, env: box.env });
  assert.deepEqual(loadRun(dir).run.routing, pinned);
  const steps = { v: 1, steps: [{ node: "intake", action: wait(0) }] };
  const result = await runLoop(baseOptions(box, dir, deliveryGraph, { executor: createFakeExecutor(steps), budgets: { iterations: 1 } }));
  assert.deepEqual(result.run.routing, pinned, "transitions keep the pin");
  assert.deepEqual(loadRun(dir).run.routing, pinned);
  assert.deepEqual(configOfPinned(loadRun(dir).run.routing).stages, { review: "claude-opus-5-5" });

  const old = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: box.repo, runId: "run-old", now: box.now, env: box.env });
  assert.equal(loadRun(old.dir).run.routing, undefined);
  assert.equal(configOfPinned(undefined), null);
  assert.deepEqual(routingDrift(undefined, config), { pinned: false, drifted: false, changes: [] });
  assert.ok(getGraph("delivery@1"));
});

test("drift: a config change after the start shows up as changes and never alters the pinned route", () => {
  const config = { default: "claude-sonnet-5-5", effort: "medium", fallback: ["claude-haiku-5-5"], stages: { review: "claude-opus-5-5" } };
  const pinned = pinRouting(config);
  assert.equal(routingDrift(pinned, config).drifted, false);
  const now = { default: "claude-opus-5-5", effort: null, fallback: [], stages: { review: "claude-opus-5-5", plan: "claude-haiku-5-5" } };
  const drift = routingDrift(pinned, now);
  assert.equal(drift.drifted, true);
  assert.deepEqual(drift.changes.map((change) => change.key).sort(), ["default", "effort", "fallback", "stages.plan"]);
  assert.equal(resolveRoute({ config: configOfPinned(pinned), node: "test" }).model, "claude-sonnet-5-5", "the pinned config still routes as before");
});

// --- fallback ---------------------------------------------------------------------------------------------------------

test("fallback advances only on transient classes, changes only the model, and records route.fallback", () => {
  const route = resolveRoute({ config: { default: "claude-opus-5-5", effort: "high", fallback: ["claude-sonnet-5-5", "claude-haiku-5-5"], stages: {} }, node: "plan" });
  for (const failure of [{ class: "rate-limit" }, { status: 429 }, { status: 529 }, { status: 503 }, { code: "ETIMEDOUT" }, { name: "TimeoutError" }]) assert.equal(nextRoute(route, failure).advanced, true, JSON.stringify(failure));
  for (const failure of [{ status: 401 }, { status: 403 }, { class: "auth" }, { class: "policy-denied" }, { class: "invalid-request" }, { status: 400 }, { class: "weird" }, {}, null]) {
    const verdict = nextRoute(route, failure);
    assert.equal(verdict.advanced, false, JSON.stringify(failure));
    assert.equal(verdict.route, route);
    assert.equal(verdict.event, null);
  }
  const first = nextRoute(route, { status: 429 });
  assert.deepEqual(first.event, { type: "route.fallback", node: "plan", from: "claude-opus-5-5", to: "claude-sonnet-5-5", class: "rate-limit" });
  assert.deepEqual([first.route.model, first.route.effort, first.route.node, first.route.source, first.route.fallbackChain], ["claude-sonnet-5-5", "high", "plan", route.source, ["claude-haiku-5-5"]]);
  assert.equal(route.model, "claude-opus-5-5", "the input route is not mutated");
  const second = nextRoute(first.route, { class: "overloaded" });
  assert.equal(second.route.model, "claude-haiku-5-5");
  assert.ok(second.route.warnings.some((w) => w.includes("effort 'high'")), "haiku has no documented effort");
  const third = nextRoute(second.route, { class: "timeout" });
  assert.equal(third.advanced, false);
  assert.match(third.reason, /no fallback/);
  assert.equal(classifyFailure({ status: 502 }), "5xx");
});

test("a route.fallback record is accepted by the ledger as a plain log event", async () => {
  const box = makeBox();
  const { dir } = createRunForGraph({ graph: deliveryGraph, goal: "g", repo: box.repo, runId: "run-f", now: box.now, env: box.env });
  const { commitRecords } = await import("../src/runtime/loop.mjs");
  const { acquireRunLock } = await import("../src/runtime/lock.mjs");
  const lock = acquireRunLock(dir);
  try {
    const route = resolveRoute({ config: { default: "claude-opus-5-5", effort: null, fallback: ["claude-haiku-5-5"], stages: {} }, node: "plan" });
    commitRecords({ dir, graph: deliveryGraph, lockToken: lock.token, now: box.now }, loadRun(dir).run, [nextRoute(route, { status: 529 }).event]);
  } finally {
    lock.release();
  }
  const event = readEvents(dir).find((entry) => entry.type === "route.fallback");
  assert.deepEqual([event.from, event.to, event.class], ["claude-opus-5-5", "claude-haiku-5-5", "overloaded"]);
});
