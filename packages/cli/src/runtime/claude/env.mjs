// Environment allow-list of the `claude` child. Pure.
//
// Provider authentication lives in claude's OWN store (its login), not in anything Asterweave passes: the only credentials
// that can reach the child are the ones already named ANTHROPIC_* / CLAUDE_* (an API key, an OAuth token variable) and, for a
// third-party provider that is explicitly selected with CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX, that provider's
// own variables. Everything else (GITHUB_TOKEN, GH_TOKEN, NPM_TOKEN, SSH_AUTH_SOCK, ASTERWEAVE_*, ...) is dropped.
// The three correlation variables below are the only ASTERWEAVE_* values the child ever sees; they come from `extraEnv`.

export const CORRELATION_KEYS = Object.freeze(["ASTERWEAVE_RUN_ID", "ASTERWEAVE_SESSION_ID", "ASTERWEAVE_CONFIG_DIR"]);

const EXACT = new Set([
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
  "LANG", "TERM", "NO_COLOR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  // Windows basics a native program may need to start (beyond the spec list; no secrets).
  "PATHEXT", "COMSPEC", "HOMEDRIVE", "HOMEPATH",
]);
const POSIX_LOWERCASE = new Set(["http_proxy", "https_proxy", "no_proxy"]);
const PREFIXES = ["LC_", "ANTHROPIC_", "CLAUDE_"];
const PROVIDER_FAMILIES = Object.freeze({
  CLAUDE_CODE_USE_BEDROCK: ["AWS_"],
  CLAUDE_CODE_USE_VERTEX: ["GOOGLE_", "VERTEX_", "CLOUD_ML_REGION"],
});

const truthy = (value) => typeof value === "string" && /^(?:1|true|yes|on)$/i.test(value.trim());
const validValue = (value) => typeof value === "string" && !value.includes("\u0000") && value.length <= 32_768;

/**
 * @param {Record<string, string|undefined>} hostEnv
 * @param {{extraEnv?: Record<string,string>, platform?: string}} [options]
 * @returns {Record<string, string>}
 */
export function buildClaudeEnv(hostEnv = {}, { extraEnv = {}, platform = process.platform } = {}) {
  // Windows environment names are case-insensitive: compare upper-cased there, exactly elsewhere.
  const fold = (name) => (platform === "win32" ? name.toUpperCase() : name);
  const names = Object.keys(hostEnv ?? {});
  const families = [];
  for (const name of names) {
    const key = fold(name);
    if (Object.hasOwn(PROVIDER_FAMILIES, key) && truthy(hostEnv[name])) families.push(...PROVIDER_FAMILIES[key]);
  }
  const allowed = (name) => {
    const key = fold(name);
    if (EXACT.has(key) || (platform !== "win32" && POSIX_LOWERCASE.has(key))) return true;
    if (PREFIXES.some((prefix) => key.startsWith(prefix))) return true;
    return families.some((family) => (family.endsWith("_") ? key.startsWith(family) : key === family));
  };
  const env = {};
  for (const name of names) {
    if (name === "__proto__" || name.includes("=") || name.includes("\u0000")) continue;
    if (!validValue(hostEnv[name]) || !allowed(name)) continue;
    if (Object.hasOwn(env, name)) continue;
    env[name] = hostEnv[name];
  }
  for (const key of Object.keys(extraEnv ?? {})) {
    if (!CORRELATION_KEYS.includes(key)) throw new TypeError(`extraEnv may only set ${CORRELATION_KEYS.join(", ")}`);
    if (!validValue(extraEnv[key]) || extraEnv[key].length > 1024) throw new TypeError(`extraEnv.${key} is not a valid value`);
    env[key] = extraEnv[key];
  }
  return env;
}
