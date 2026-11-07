// Layered effective configuration with per-key origin.
//
// Precedence (lowest to highest):
//   default < user config.json < trusted repo .claude/asterweave.json < ASTERWEAVE_* env < flags
//
// Only the explicit keys in KNOWN_KEYS participate. Repository config follows the existing
// adapter schema (plugins/asterweave/schemas/repository-adapter.schema.json) and is READ-ONLY here;
// this module does a light structural validation of it and never imports the plugin's loader.
// Executable repository fields (quality-gate commands) are only applied for a trusted repository;
// for an untrusted one only non-executable fields are read and the skipped keys are reported.

import path from "node:path";
import * as nodeFs from "node:fs";
import { CliError, EXIT } from "./exit-codes.mjs";
import { HOST_PATTERN } from "./host.mjs";
import { userFilePath } from "./paths.mjs";
import { isSecretKeyName, redactDeep, sanitizeForTerminal } from "./redact.mjs";
import { validateHookEntries } from "./runtime/hooks.mjs";
import { EFFORTS, MAX_FALLBACK, MODEL_ID_PATTERN, STAGE_NODES } from "./runtime/routing.mjs";
import { parseJsonText, readJson, StoreError } from "./store.mjs";
import { assertTrusted, safeTrustStatus } from "./trust.mjs";

/** Configuration is invalid (exit 5). `key` and `origin` say where the bad value came from. */
export class ConfigError extends CliError {
  /** @param {string} message @param {{key?: string, origin?: string, remediation?: string, cause?: unknown}} [details] */
  constructor(message, { key, origin, remediation, cause } = {}) {
    super(message, { code: "CONFIG_INVALID", exitCode: EXIT.CONFIG, remediation, cause });
    this.key = key;
    this.origin = origin;
  }
}

/** Layer names from lowest to highest precedence. */
export const PRECEDENCE = Object.freeze(["default", "user", "repo", "env", "flag"]);

const HOST = HOST_PATTERN;
const WORK_ITEM_PROVIDERS = ["github", "azure-devops", "none"];

/**
 * @typedef {object} KeyDefinition
 * @property {'string'|'boolean'|'integer'|'enum'|'gates'|'modelList'} type
 * @property {unknown} default
 * @property {string} description
 * @property {string[]} [values]       Allowed values for `enum`.
 * @property {number} [min]            Integer bounds.
 * @property {number} [max]
 * @property {RegExp} [pattern]        Required shape for `string`.
 * @property {string} [env]            Environment variable that sets the key (absent: not settable via env).
 * @property {boolean} [repo]          The key may come from the repository adapter file.
 * @property {boolean} [executable]    The value makes code run; repository layer needs trust.
 * @property {boolean} [userSettable]  Defaults to true; false for repo-only keys.
 */

/** Env variable of a stage model: model.stages.submit-pr -> ASTERWEAVE_MODEL_STAGE_SUBMIT_PR. */
const stageEnv = (node) => `ASTERWEAVE_MODEL_STAGE_${node.toUpperCase().replaceAll("-", "_")}`;

/** The complete set of configuration keys. Keys not listed here are not configurable. */
export const KNOWN_KEYS = Object.freeze({
  runner: { type: "enum", values: ["local"], default: "local", env: "ASTERWEAVE_RUNNER", description: "Where agent work runs. Phase A supports only 'local'." },
  "github.host": { type: "string", pattern: HOST, default: "github.com", env: "ASTERWEAVE_GITHUB_HOST", description: "GitHub host used for sign-in and repository listing." },
  "ui.color": { type: "enum", values: ["auto", "always", "never"], default: "auto", env: "ASTERWEAVE_UI_COLOR", description: "Colored output. NO_COLOR and non-TTY output always disable color." },
  "provider.workItems": { type: "enum", values: WORK_ITEM_PROVIDERS, default: "none", env: "ASTERWEAVE_PROVIDER_WORKITEMS", repo: true, description: "Work-item provider (repository adapter field)." },
  // Model routing (routing.mjs). User config and environment only: a repository must not choose where its prompts go.
  "model.default": { type: "string", pattern: MODEL_ID_PATTERN, default: null, env: "ASTERWEAVE_MODEL", description: "Default model id for every stage (unset: the runner's own default)." },
  "model.effort": { type: "enum", values: EFFORTS, default: null, env: "ASTERWEAVE_MODEL_EFFORT", description: "Reasoning effort requested from the model (unset: the runner's own default)." },
  "model.fallback": { type: "modelList", default: null, env: "ASTERWEAVE_MODEL_FALLBACK", description: `Comma-separated model ids to fall back to on transient failures (at most ${MAX_FALLBACK}).` },
  ...Object.fromEntries(STAGE_NODES.map((node) => [`model.stages.${node}`, { type: "string", pattern: MODEL_ID_PATTERN, default: null, env: stageEnv(node), description: `Model id for the '${node}' stage (overrides model.default).` }])),
  "qualityGates.required": { type: "gates", default: [], repo: true, executable: true, userSettable: false, description: "Quality-gate commands from the repository adapter. EXECUTABLE: applied only when the repository is trusted." },
});

/** Environment variable name for each key that has one: { 'github.host': 'ASTERWEAVE_GITHUB_HOST', ... }. */
export const ENV_NAMES = Object.freeze(Object.fromEntries(Object.entries(KNOWN_KEYS).filter(([, def]) => def.env).map(([key, def]) => [key, def.env])));

// ---------------------------------------------------------------------------------------------
// Value parsing and validation

/** Own-property lookup so keys such as 'constructor' or '__proto__' never resolve to Object.prototype members. */
function knownKey(key) {
  return Object.hasOwn(KNOWN_KEYS, key) ? KNOWN_KEYS[key] : undefined;
}

/** A user/repo supplied name quoted for a message: JSON-quoted, then stripped of terminal control sequences. */
const quoteName = (value) => sanitizeForTerminal(JSON.stringify(String(value)));

function fail(key, origin, message, remediation) {
  throw new ConfigError(`Invalid value for '${key}' (${origin}): ${message}`, { key, origin, remediation });
}

/**
 * Validate (and, for strings from the environment, convert) a value for a known key.
 * @param {string} key
 * @param {unknown} raw
 * @param {{origin?: string, fromString?: boolean}} [options]  `fromString`: raw comes from env/CLI text.
 * @returns {unknown} the normalised value
 * @throws {ConfigError}
 */
export function coerceValue(key, raw, { origin = "value", fromString = false } = {}) {
  const def = knownKey(key);
  if (!def) throw new ConfigError(`Unknown configuration key ${quoteName(key)}.`, { key, origin });
  switch (def.type) {
    case "boolean": {
      if (typeof raw === "boolean") return raw;
      if (fromString && (raw === "true" || raw === "1")) return true;
      if (fromString && (raw === "false" || raw === "0")) return false;
      return fail(key, origin, "expected true or false");
    }
    case "integer": {
      const value = fromString && typeof raw === "string" && /^-?\d+$/.test(raw.trim()) ? Number(raw) : raw;
      if (!Number.isInteger(value)) return fail(key, origin, "expected an integer");
      if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
        return fail(key, origin, `expected an integer between ${def.min ?? "-inf"} and ${def.max ?? "inf"}`);
      }
      return value;
    }
    case "enum": {
      if (typeof raw !== "string" || !def.values.includes(raw)) return fail(key, origin, `expected one of ${def.values.join(", ")}`);
      return raw;
    }
    case "string": {
      if (typeof raw !== "string" || raw.trim() === "") return fail(key, origin, "expected a non-empty string");
      const value = raw.trim();
      if (def.pattern && !def.pattern.test(value)) return fail(key, origin, "unexpected format");
      return value;
    }
    case "modelList": {
      const items = Array.isArray(raw) ? raw : fromString || typeof raw === "string" ? String(raw).split(",") : null;
      if (items === null) return fail(key, origin, "expected a comma-separated list of model ids");
      const ids = items.map((item) => (typeof item === "string" ? item.trim() : null));
      if (ids.length === 0 || ids.length > MAX_FALLBACK) return fail(key, origin, `expected 1 to ${MAX_FALLBACK} model ids`);
      if (ids.some((id) => id === null || !MODEL_ID_PATTERN.test(id))) return fail(key, origin, "unexpected format");
      if (new Set(ids).size !== ids.length) return fail(key, origin, "model ids must be unique");
      return ids;
    }
    case "gates": {
      if (!Array.isArray(raw)) return fail(key, origin, "expected an array");
      raw.forEach((gate, index) => {
        const valid = gate && typeof gate === "object" && !Array.isArray(gate) && typeof gate.id === "string" && typeof gate.command === "string" && gate.command !== "" && typeof gate.source === "string";
        if (!valid) fail(`${key}[${index}]`, origin, "each gate needs string id, command and source");
      });
      return raw;
    }
    default:
      return fail(key, origin, "unsupported key type");
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Flatten nested objects into dotted keys. Arrays and scalars are leaves. */
function flatten(object, prefix = "", out = Object.create(null)) {
  for (const [key, value] of Object.entries(object)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(value) && Object.keys(value).length > 0 && !Object.hasOwn(KNOWN_KEYS, full)) flatten(value, full, out);
    else out[full] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layer readers

function readUserLayer(file, fs) {
  let data;
  try {
    data = readJson(file, { fallback: null, fs });
  } catch (error) {
    if (error instanceof StoreError) {
      throw new ConfigError(error.message, { origin: `user:${file}`, remediation: `Fix or delete ${file}.`, cause: error });
    }
    throw error;
  }
  if (data === null) return { exists: false, values: {}, unknown: [] };
  if (!isPlainObject(data)) throw new ConfigError(`${file} must contain a JSON object.`, { origin: `user:${file}`, remediation: `Fix or delete ${file}.` });
  const values = {};
  const unknown = [];
  for (const [key, value] of Object.entries(flatten(data))) {
    const def = knownKey(key);
    if (!def || def.userSettable === false) unknown.push({ key, value, origin: `user:${file}` });
    else values[key] = coerceValue(key, value, { origin: `user:${file}` });
  }
  return { exists: true, values, unknown };
}

const ADAPTER_TOP_LEVEL = new Set(["version", "provider", "routing", "completion", "handoff", "autoContinue", "qualityGates", "hooks"]);

/** Light structural validation of the repository adapter (the full JSON Schema lives in the plugin). */
function validateAdapter(data, file) {
  const origin = `repo:${file}`;
  if (!isPlainObject(data)) throw new ConfigError(`${file} must contain a JSON object.`, { origin });
  if (data.version !== 1) throw new ConfigError(`${file}: 'version' must be 1.`, { key: "version", origin });
  for (const key of Object.keys(data)) {
    if (!ADAPTER_TOP_LEVEL.has(key)) throw new ConfigError(`${file}: unknown top-level property ${quoteName(key)}.`, { key, origin });
  }
  if (data.provider !== undefined) {
    if (!isPlainObject(data.provider)) throw new ConfigError(`${file}: 'provider' must be an object.`, { key: "provider", origin });
    if (data.provider.workItems !== undefined && !WORK_ITEM_PROVIDERS.includes(data.provider.workItems)) {
      throw new ConfigError(`${file}: provider.workItems must be one of ${WORK_ITEM_PROVIDERS.join(", ")}.`, { key: "provider.workItems", origin });
    }
  }
  if (data.hooks !== undefined) {
    // Executable (hook commands): only validated here; they are loaded solely for a trusted repository (runtime/hooks.mjs).
    const issues = validateHookEntries(data.hooks, "hooks");
    if (issues.length > 0) throw new ConfigError(`${file}: invalid hooks: ${issues.slice(0, 3).join("; ")}.`, { key: "hooks", origin });
  }
  if (data.qualityGates !== undefined) {
    if (!isPlainObject(data.qualityGates)) throw new ConfigError(`${file}: 'qualityGates' must be an object.`, { key: "qualityGates", origin });
    if (data.qualityGates.required !== undefined) coerceValue("qualityGates.required", data.qualityGates.required, { origin });
  }
}

/**
 * Read the repository adapter. Returns `null` when the repository has none.
 *
 * `adapter` is the `{bytes, state}` the trust hash was computed from (see computeTrustHash): when
 * given, THOSE bytes are parsed, so the content that was trusted is exactly the content that is used
 * (no second read of the file). There is no fallback read: a second read would not be bound to the
 * hash. An adapter that was unreadable when hashed, or a missing `adapter` (e.g. lost through an
 * object spread), is a ConfigError (exit 5) instead.
 * @returns {{file: string, values: Record<string, unknown>} | null}
 */
function readRepoLayer(repoRoot, adapter) {
  const file = path.join(repoRoot, ".claude", "asterweave.json");
  const origin = `repo:${file}`;
  if (!adapter || typeof adapter !== "object" || !("state" in adapter)) {
    throw new ConfigError(`${file} cannot be read: the trust check did not provide the file content that was hashed.`, { origin, remediation: "Rerun the command. If this persists, it is a bug in Asterweave." });
  }
  if (adapter.state === "unreadable") {
    throw new ConfigError(`${file} cannot be read (it is not a readable file).`, { origin, remediation: `Make ${file} a readable regular file, or remove it.` });
  }
  let data;
  try {
    data = adapter.bytes === null ? null : parseJsonText(adapter.bytes.toString("utf8"), file, null);
  } catch (error) {
    if (error instanceof StoreError) throw new ConfigError(error.message, { origin: `repo:${file}`, remediation: `Fix ${file}.`, cause: error });
    throw error;
  }
  if (data === null) return null;
  validateAdapter(data, file);
  const values = {};
  for (const [key, value] of Object.entries(flatten(data))) {
    if (knownKey(key)?.repo) values[key] = value;
  }
  return { file, values };
}

// ---------------------------------------------------------------------------------------------
// Resolution

/**
 * @typedef {object} ResolveOptions
 * @property {Record<string,string|undefined>} [env]        Environment (default process.env).
 * @property {Record<string, unknown>} [flags]              Flag values keyed by config key, e.g. {'github.host': 'ghe.example'}.
 * @property {string} [repoPath]                            Repository root to layer in (omit for none).
 * @property {string} [platform]
 * @property {() => string} [homedir]
 * @property {string} [userConfigFile]                      Explicit config.json path.
 * @property {import('./trust.mjs').TrustOptions} [trust]   Overrides for the trust store lookup.
 * @property {typeof nodeFs} [fs]
 */

/**
 * Compute the effective configuration.
 *
 * @param {ResolveOptions} [options]
 * @returns {{
 *   precedence: string[],
 *   entries: Record<string, {value: unknown, origin: string}>,
 *   unknown: Array<{key: string, value: unknown, origin: string}>,
 *   repo: null | {path: string, file: string, hasAdapter: boolean, trusted: boolean, trustReason: string, hash: string, skipped: string[]},
 * }}
 *   `origin` is `default`, `user:<file>`, `repo:<file>`, `env:<NAME>` or `flag`.
 *   `unknown` lists user-config keys that are not recognised (reported, never applied).
 * @throws {ConfigError} on any invalid value in any layer (exit 5).
 */
export function resolveConfig(options = {}) {
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const entries = {};
  for (const [key, def] of Object.entries(KNOWN_KEYS)) entries[key] = { value: structuredClone(def.default), origin: "default" };

  // user
  const userFile = options.userConfigFile ?? userFilePath("config", { env, platform: options.platform, homedir: options.homedir });
  const user = readUserLayer(userFile, fs);
  for (const [key, value] of Object.entries(user.values)) entries[key] = { value, origin: `user:${userFile}` };

  // repo (trust-gated for executable fields)
  let repo = null;
  if (options.repoPath) {
    const trustOptions = { env, platform: options.platform, homedir: options.homedir, fs, ...options.trust };
    // A trust store that cannot be read means "untrusted" here (executable fields are skipped), not a failure.
    const status = safeTrustStatus(options.repoPath, trustOptions);
    const adapter = readRepoLayer(status.realpath, status.adapter);
    const skipped = [];
    if (adapter) {
      for (const [key, raw] of Object.entries(adapter.values)) {
        const def = knownKey(key);
        if (def.executable && !status.trusted) {
          skipped.push(key);
          continue;
        }
        entries[key] = { value: coerceValue(key, raw, { origin: `repo:${adapter.file}` }), origin: `repo:${adapter.file}` };
      }
    }
    repo = {
      path: status.realpath,
      file: path.join(status.realpath, ".claude", "asterweave.json"),
      hasAdapter: adapter !== null,
      trusted: status.trusted,
      trustReason: status.reason,
      hash: status.hash,
      skipped,
      ...(status.warning ? { warning: status.warning } : {}),
    };
  }

  // env
  for (const [key, def] of Object.entries(KNOWN_KEYS)) {
    if (!def.env) continue;
    const raw = env[def.env];
    if (raw === undefined || raw === "") continue;
    entries[key] = { value: coerceValue(key, raw, { origin: `env:${def.env}`, fromString: true }), origin: `env:${def.env}` };
  }

  // flags
  for (const [key, raw] of Object.entries(options.flags ?? {})) {
    if (raw === undefined || raw === null) continue;
    const def = knownKey(key);
    if (!def || def.userSettable === false) throw new ConfigError(`Unknown configuration key ${quoteName(key)}.`, { key, origin: "flag" });
    entries[key] = { value: coerceValue(key, raw, { origin: "flag", fromString: typeof raw === "string" }), origin: "flag" };
  }

  return { precedence: [...PRECEDENCE], entries, unknown: user.unknown, repo };
}

/**
 * Only the `model.*` keys (user config + environment), validated; every other key of every layer is ignored, so an
 * unrelated bad value cannot fail a caller that only needs the model routing (`run start`). An invalid model.* value
 * is a ConfigError (exit 5) naming the key and where it came from, with a remediation. An unparsable user config.json
 * is also a ConfigError: the model keys in it cannot be known.
 * @param {ResolveOptions} [options]
 * @returns {{entries: Record<string, {value: unknown, origin: string}>}}
 */
export function resolveModelConfig(options = {}) {
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const keys = Object.keys(KNOWN_KEYS).filter((key) => key.startsWith("model."));
  const entries = {};
  for (const key of keys) entries[key] = { value: structuredClone(KNOWN_KEYS[key].default), origin: "default" };
  const withRemediation = (error, file) => {
    if (!(error instanceof ConfigError)) throw error;
    const where = error.origin?.startsWith("env:") ? `the ${error.origin.slice(4)} environment variable` : file;
    throw new ConfigError(error.message, { key: error.key, origin: error.origin, remediation: `Fix ${error.key ?? "the value"} in ${where}, or remove it.`, cause: error });
  };
  const userFile = options.userConfigFile ?? userFilePath("config", { env, platform: options.platform, homedir: options.homedir });
  let data;
  try {
    data = readJson(userFile, { fallback: null, fs });
  } catch (error) {
    if (error instanceof StoreError) throw new ConfigError(error.message, { origin: `user:${userFile}`, remediation: `Fix or delete ${userFile}.`, cause: error });
    throw error;
  }
  if (data !== null && !isPlainObject(data)) throw new ConfigError(`${userFile} must contain a JSON object.`, { origin: `user:${userFile}`, remediation: `Fix or delete ${userFile}.` });
  for (const [key, value] of Object.entries(data === null ? {} : flatten(data))) {
    if (!keys.includes(key)) continue;
    try {
      entries[key] = { value: coerceValue(key, value, { origin: `user:${userFile}` }), origin: `user:${userFile}` };
    } catch (error) {
      withRemediation(error, userFile);
    }
  }
  for (const key of keys) {
    const name = KNOWN_KEYS[key].env;
    const raw = name ? env[name] : undefined;
    if (raw === undefined || raw === "") continue;
    try {
      entries[key] = { value: coerceValue(key, raw, { origin: `env:${name}`, fromString: true }), origin: `env:${name}` };
    } catch (error) {
      withRemediation(error, userFile);
    }
  }
  return { entries };
}

/**
 * Safe-to-print view of a resolved configuration: secret-like keys are replaced by `[redacted]`
 * and token/email shapes inside values are redacted. Never mutates its input.
 *
 * @param {ReturnType<typeof resolveConfig>} resolved
 * @returns {{precedence: string[], entries: Record<string, {value: unknown, origin: string}>, unknown: Array<{key: string, value: unknown, origin: string}>, repo: ReturnType<typeof resolveConfig>['repo']}}
 */
export function configView(resolved) {
  const scrub = (key, value) => (isSecretKeyName(key) ? "[redacted]" : redactDeep(value).value);
  return {
    precedence: [...resolved.precedence],
    entries: Object.fromEntries(Object.entries(resolved.entries).map(([key, entry]) => [key, { value: scrub(key, entry.value), origin: entry.origin }])),
    unknown: resolved.unknown.map(({ key, value, origin }) => ({ key, value: scrub(key, value), origin })),
    repo: resolved.repo,
  };
}

/**
 * Read the repository's executable config (quality-gate commands). Requires trust: throws
 * `TrustError` (exit 4) for an untrusted repository. This is the only path that returns commands.
 *
 * @param {string} repoPath
 * @param {string} purpose  What the commands will be used for, shown in the error.
 * @param {ResolveOptions} [options]
 * @returns {{gates: Array<{id: string, command: string, source: string, timeoutSeconds?: number}>, file: string|null}}
 */
export function readExecutableRepoConfig(repoPath, purpose, options = {}) {
  const env = options.env ?? process.env;
  const fs = options.fs ?? nodeFs;
  const status = assertTrusted(repoPath, purpose, { env, platform: options.platform, homedir: options.homedir, fs, ...options.trust });
  const adapter = readRepoLayer(status.realpath, status.adapter);
  const gates = adapter?.values["qualityGates.required"];
  return { gates: gates ? coerceValue("qualityGates.required", gates, { origin: `repo:${adapter.file}` }) : [], file: adapter?.file ?? null };
}
