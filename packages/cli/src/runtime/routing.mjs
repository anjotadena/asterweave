// Model routing: which model (and effort) a stage of a run uses, pinned per run, with a transient-failure fallback.
//
// Everything here is PURE and offline. The catalog below is a STATIC list of model ids and the features documented
// for them; it is never checked against a live service, so every entry is `availability: "unverified"` and an id that
// is not in it is `unknown-model` (still allowed: custom and newer models work, they just are not vouched for).
// Routing never fails closed on an unknown model; it says what it chose and why.
//
// The configuration shape this module reads (see config.mjs `routingFromConfig`):
//   { default: string|null, effort: string|null, fallback: string[], stages: { [node]: string } }
// A run PINS that shape when it starts (`run.routing`, see pinRouting): a later config change does not alter the route
// of a run that already started; `routingDrift` shows the difference.

import { sha256Canonical } from "./policy.mjs";

export const ROUTING_PROMPT_VERSION = 1;
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
export const MAX_FALLBACK = 4;
/** The nodes of the shipped graphs (delivery@1 is the superset); each can have its own `model.stages.<node>`. */
export const STAGE_NODES = Object.freeze(["intake", "analyze", "challenge", "plan", "approve", "implement", "test", "verify", "review", "submit-pr", "monitor-pipeline", "resolve-review-comments", "update-work-item"]);

const entry = (id, family, effort) => Object.freeze({ id, family, features: Object.freeze({ tools: true, images: true }), effort: Object.freeze(effort), source: "static-catalog", availability: "unverified" });

/**
 * Known model ids and their documented features. STATIC: not verified against any live service.
 * `effort` lists the effort levels documented for the model (empty: none documented).
 */
export const CATALOG = Object.freeze({
  "claude-fable-5-1": entry("claude-fable-5-1", "fable", ["low", "medium", "high", "xhigh", "max"]),
  "claude-opus-5-5": entry("claude-opus-5-5", "opus", ["low", "medium", "high", "xhigh", "max"]),
  "claude-sonnet-5-5": entry("claude-sonnet-5-5", "sonnet", ["low", "medium", "high", "xhigh"]),
  "claude-haiku-5-5": entry("claude-haiku-5-5", "haiku", []),
});

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const lookup = (catalog, id) => (typeof id === "string" && Object.hasOwn(catalog, id) ? catalog[id] : null);

/** The routing part of a resolved configuration (`resolveConfig(...).entries`) as plain values. */
export function routingFromEntries(entries) {
  const get = (key) => entries?.[key]?.value ?? null;
  const stages = {};
  for (const node of STAGE_NODES) {
    const value = get(`model.stages.${node}`);
    if (typeof value === "string") stages[node] = value;
  }
  return { default: get("model.default"), effort: get("model.effort"), fallback: Array.isArray(get("model.fallback")) ? [...get("model.fallback")] : [], stages };
}

const normalize = (config) => ({
  default: typeof config?.default === "string" ? config.default : null,
  effort: typeof config?.effort === "string" ? config.effort : null,
  fallback: Array.isArray(config?.fallback) ? config.fallback.filter((id) => typeof id === "string") : [],
  stages: isObject(config?.stages) ? Object.fromEntries(Object.entries(config.stages).filter(([, id]) => typeof id === "string").sort(([a], [b]) => (a < b ? -1 : 1))) : {},
});

/**
 * What a run records at start: the routing configuration plus a hash of it. Older runs have no `routing`; readers
 * treat that as "not pinned".
 */
export function pinRouting(config) {
  const plain = normalize(config);
  return { promptVersion: ROUTING_PROMPT_VERSION, ...plain, configHash: sha256Canonical(plain) };
}

/** The config shape back out of a pinned `run.routing` (null when the run has none). */
export function configOfPinned(pinned) {
  return isObject(pinned) ? normalize(pinned) : null;
}

/**
 * Differences between what a run pinned and the configuration now.
 * @returns {{pinned: boolean, drifted: boolean, changes: Array<{key: string, pinned: unknown, current: unknown}>}}
 */
export function routingDrift(pinned, current) {
  if (!isObject(pinned)) return { pinned: false, drifted: false, changes: [] };
  const was = normalize(pinned);
  const now = normalize(current);
  const changes = [];
  for (const key of ["default", "effort"]) if (was[key] !== now[key]) changes.push({ key, pinned: was[key], current: now[key] });
  if (was.fallback.join(",") !== now.fallback.join(",")) changes.push({ key: "fallback", pinned: was.fallback, current: now.fallback });
  for (const node of new Set([...Object.keys(was.stages), ...Object.keys(now.stages)])) {
    if ((was.stages[node] ?? null) !== (now.stages[node] ?? null)) changes.push({ key: `stages.${node}`, pinned: was.stages[node] ?? null, current: now.stages[node] ?? null });
  }
  return { pinned: true, drifted: changes.length > 0, changes };
}

/**
 * Resolve the route of one node.
 * @param {{config: object, node: string, catalog?: object, unavailable?: string[]}} options
 *   `unavailable`: model ids known to be unusable right now (e.g. after fallbacks); they are skipped.
 * @returns {{node: string, model: string|null, effort: string|null, source: 'stage'|'default'|'runner-default',
 *   fallbackChain: string[], reason: string, availability: 'unverified'|'unknown-model', warnings: string[]}}
 */
export function resolveRoute({ config, node, catalog = CATALOG, unavailable = [] }) {
  const cfg = normalize(config);
  const warnings = [];
  let source = "runner-default";
  let model = null;
  let reason = "no model configured: the runner chooses its own default";
  if (Object.hasOwn(cfg.stages, node)) {
    source = "stage";
    model = cfg.stages[node];
    reason = `model.stages.${node} selects it for this stage`;
  } else if (cfg.default !== null) {
    source = "default";
    model = cfg.default;
    reason = "model.default selects it (no stage-specific model is configured)";
  }
  let chain = [...new Set(cfg.fallback)].filter((id) => id !== model);
  const down = new Set(unavailable);
  if (model !== null && down.has(model)) {
    const next = chain.find((id) => !down.has(id));
    warnings.push(`${model} is marked unavailable`);
    if (next === undefined) warnings.push("no fallback model is left; the route keeps the configured model");
    else {
      reason += `; ${model} is marked unavailable, so fallback ${next} is used`;
      chain = chain.filter((id) => id !== next);
      model = next;
    }
  }
  chain = chain.filter((id) => !down.has(id));
  const checked = modelChecks({ model, effort: cfg.effort, chain, catalog });
  return { node, model, effort: cfg.effort, source, fallbackChain: chain, reason, availability: checked.availability, warnings: [...warnings, ...checked.warnings] };
}

/** Availability and warnings of a model, its effort and its fallback chain against the catalog (never an error). */
function modelChecks({ model, effort, chain, catalog }) {
  const known = lookup(catalog, model);
  const warnings = [];
  if (model !== null && known === null) warnings.push(`${model} is not in the static catalog: it is allowed, but nothing here vouches for it`);
  if (effort !== null && known !== null && !known.effort.includes(effort)) warnings.push(`effort '${effort}' is not documented for ${model}; the runner may ignore or reject it`);
  for (const id of chain) if (lookup(catalog, id) === null) warnings.push(`fallback ${id} is not in the static catalog`);
  return { availability: model !== null && known === null ? "unknown-model" : "unverified", warnings };
}

// --- fallback ---------------------------------------------------------------------------------------------------

/** Failure classes a fallback may advance on. Everything else (auth, policy-denied, invalid-request, unknown) never does. */
export const TRANSIENT_CLASSES = Object.freeze(["rate-limit", "overloaded", "timeout", "5xx"]);
export const NON_TRANSIENT_CLASSES = Object.freeze(["auth", "policy-denied", "invalid-request"]);

/**
 * Failure class of a provider failure described by `{class?, status?, code?}`; unknown shapes are "unknown".
 * Only the class matters to nextRoute, never the message.
 */
export function classifyFailure(failure) {
  if (typeof failure?.class === "string") return failure.class;
  const status = Number(failure?.status);
  if (status === 429) return "rate-limit";
  if (status === 529) return "overloaded";
  if (status === 408 || failure?.code === "ETIMEDOUT" || failure?.name === "TimeoutError") return "timeout";
  if (status >= 500 && status <= 599) return "5xx";
  if (status === 401 || status === 403) return "auth";
  if (status === 400 || status === 422) return "invalid-request";
  return "unknown";
}

/**
 * Advance a route to its next fallback model after a failure. Pure: returns a new route and the ledger record.
 * Only transient classes advance. Auth, policy-denied, invalid-request and unknown failures never do, and a fallback
 * changes the MODEL only: the effort, the stage, the approvals and every data boundary stay as they were.
 *
 * @param {object} route  From resolveRoute.
 * @param {{class?: string, status?: number, code?: string, name?: string}} failure
 * @param {object} [catalog]
 * @returns {{advanced: boolean, route: object, class: string, reason: string, event: object|null}}
 */
export function nextRoute(route, failure, catalog = CATALOG) {
  const failureClass = classifyFailure(failure);
  if (!TRANSIENT_CLASSES.includes(failureClass)) {
    const why = NON_TRANSIENT_CLASSES.includes(failureClass) ? `${failureClass} failures never fall back` : "only transient failures (rate-limit, overloaded, timeout, 5xx) fall back";
    return { advanced: false, route, class: failureClass, reason: why, event: null };
  }
  const [next, ...rest] = route.fallbackChain ?? [];
  if (next === undefined) return { advanced: false, route, class: failureClass, reason: "no fallback model is left", event: null };
  const checked = modelChecks({ model: next, effort: route.effort, chain: rest, catalog });
  const advancedRoute = {
    ...route,
    model: next,
    fallbackChain: rest,
    availability: checked.availability,
    reason: `${route.reason}; fell back from ${route.model ?? "the runner default"} after a ${failureClass} failure`,
    warnings: checked.warnings,
  };
  return { advanced: true, route: advancedRoute, class: failureClass, reason: advancedRoute.reason, event: { type: "route.fallback", node: route.node, from: route.model, to: next, class: failureClass } };
}
