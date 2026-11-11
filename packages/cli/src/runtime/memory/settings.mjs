// The memory settings as a plain object. Callers resolve them once (config.mjs resolveMemoryConfig: user config + environment
// only) and pass them to the runtime functions explicitly; nothing in runtime/memory reads configuration by itself.

export const MEMORY_DEFAULTS = Object.freeze({
  enabled: true,
  defaultScope: "repository",
  historyRetentionDays: 365,
  summaryRetentionDays: 365,
  idleRefreshMinutes: 15,
  coldResumeMinutes: 60,
  contextTokenBudget: 4000,
  retrievalLimit: 8,
  semanticSearchEnabled: false,
  claudeImportEnabled: false,
});

/** `{ "memory.enabled": {value}, ... }` (resolveMemoryConfig entries) -> `{ enabled, ... }`. */
export function settingsFromEntries(entries) {
  const out = { ...MEMORY_DEFAULTS };
  for (const key of Object.keys(MEMORY_DEFAULTS)) {
    const entry = entries?.[`memory.${key}`];
    if (entry && entry.value !== undefined && entry.value !== null) out[key] = entry.value;
  }
  return out;
}

/** Fill missing fields of a partial settings object with the defaults (API callers and tests). */
export function withDefaults(settings) {
  return { ...MEMORY_DEFAULTS, ...(settings ?? {}) };
}
