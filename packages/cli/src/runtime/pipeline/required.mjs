// Where the required checks of a repository come from. The union, in precedence order (earlier sources first, duplicates dropped):
//
//   1. the user policy file `<userDir>/pipeline.json`:
//        { "repos": { "owner/name": { "required": [..], "allowSkipped": [..], "deployment": [..], "detectionWindowMs": n, "trigger": "push"|"pull_request" } } }
//      (the only source of allowSkipped / deployment / detectionWindowMs / trigger: a repository cannot loosen the policy)
//   2. the repository adapter's `completion.requiredChecks` (names or workflow paths, at most 50 strings) - executable-adjacent repository
//      config, so it is read ONLY when the repository is trusted (the same gate as `hooks`), from the bytes the trust hash covers
//   3. the branch protection "required status checks" of the base branch, when the credential can read them (403 / 404 => unavailable)
//
// An empty union is `missing-configuration` (state.mjs evaluate): never closable, with a remediation.

import { CliError, EXIT } from "../../exit-codes.mjs";
import { resolveUserDir } from "../../paths.mjs";
import { parseJsonText, readJson, StoreError } from "../../store.mjs";
import { safeTrustStatus } from "../../trust.mjs";
import path from "node:path";
import { normalizePolicy, safeText, unionRequired, validateRequiredChecks } from "./state.mjs";

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const configError = (message, remediation) => new CliError(message, { code: "PIPELINE_CONFIG_INVALID", exitCode: EXIT.CONFIG, remediation });

/** `<userDir>/pipeline.json`. */
export function pipelineConfigPath(options = {}) {
  const platform = options.platform ?? process.platform;
  return (platform === "win32" ? path.win32 : path.posix).join(resolveUserDir(options), "pipeline.json");
}

/** The user policy for one repository ({} when the file or the entry is absent). Throws PIPELINE_CONFIG_INVALID (exit 5). */
export function readUserPolicy(repoFull, options = {}) {
  const file = pipelineConfigPath(options);
  let data;
  try {
    data = readJson(file, { fallback: null, fs: options.fs });
  } catch (error) {
    if (error instanceof StoreError) throw configError(`${file} cannot be read as JSON.`, `Fix or remove ${file}.`);
    throw error;
  }
  if (data === null) return { file, found: false, raw: {} };
  if (!isObject(data) || (data.repos !== undefined && !isObject(data.repos))) throw configError(`${file} must contain {"repos": {"owner/name": {...}}}.`, `Fix ${file}.`);
  const wanted = repoFull.toLowerCase();
  const key = Object.keys(data.repos ?? {}).find((name) => name.toLowerCase() === wanted);
  return { file, found: key !== undefined, raw: key === undefined ? {} : data.repos[key] };
}

/** The adapter's required checks, only for a trusted repository. */
export function readAdapterChecks(repoPath, options = {}) {
  if (!repoPath) return { source: "adapter", used: false, checks: [], note: "no-repository" };
  const status = safeTrustStatus(repoPath, { env: options.env, platform: options.platform, homedir: options.homedir, fs: options.fs, ...options.trust });
  const bytes = status.adapter?.state === "present" ? status.adapter.bytes : null;
  if (bytes === null) return { source: "adapter", used: false, checks: [], note: "no-adapter" };
  let data;
  try {
    data = parseJsonText(bytes.toString("utf8"), ".claude/asterweave.json", null);
  } catch {
    if (status.trusted) throw configError(".claude/asterweave.json is not valid JSON.", "Fix the repository adapter.");
    return { source: "adapter", used: false, checks: [], note: "unreadable" };
  }
  const value = isObject(data) && isObject(data.completion) ? data.completion.requiredChecks : undefined;
  if (value === undefined) return { source: "adapter", used: false, checks: [], note: "not-declared" };
  if (!status.trusted) return { source: "adapter", used: false, checks: [], note: "repository-not-trusted", remediation: "Review the repository, then run: asterweave trust grant" };
  const problems = validateRequiredChecks(value);
  if (problems.length > 0) throw configError(`.claude/asterweave.json: ${problems.slice(0, 3).join("; ")}.`, "Fix completion.requiredChecks in the repository adapter.");
  return { source: "adapter", used: true, checks: value.map((item) => safeText(item.trim(), 200)) };
}

/**
 * @param {{repo: {owner: string, name: string, full: string}, baseBranch?: string|null, repoPath?: string|null, client?: object, signal?: AbortSignal,
 *   env?: object, platform?: string, homedir?: () => string, fs?: object}} input
 * @returns {Promise<{policy: object, sources: object[], unavailable: string|null}>}
 */
export async function loadRequiredChecks({ repo, baseBranch = null, repoPath = null, client = null, signal, ...options }) {
  const user = readUserPolicy(repo.full, options);
  const normalized = normalizePolicy(user.raw);
  if (normalized.problems.length > 0) throw configError(`${user.file}: ${normalized.problems.slice(0, 3).join("; ")}.`, `Fix repos.${repo.full} in ${user.file}.`);
  const adapter = readAdapterChecks(repoPath, options);
  const sources = [{ source: "user-policy", used: user.found, count: normalized.policy.required.length }, { source: "adapter", used: adapter.used, count: adapter.checks.length, ...(adapter.note ? { note: adapter.note } : {}), ...(adapter.remediation ? { remediation: adapter.remediation } : {}) }];
  let protection = { source: "branch-protection", used: false, count: 0, note: "not-queried" };
  // `unavailable` is set when branch protection COULD have contributed but could not be read now (anything except a plain 403 / 404, or an
  // unknown base branch). The caller must then neither shrink a recorded policy nor treat the set as complete.
  let unavailable = null;
  if (client && !baseBranch) unavailable = "base-branch-unknown";
  if (client && baseBranch) {
    try {
      const result = await client.requiredStatusChecks({ owner: repo.owner, repo: repo.name, branch: baseBranch }, signal);
      protection = result.available ? { source: "branch-protection", used: true, count: result.contexts.length, contexts: result.contexts.map((item) => safeText(item, 200)).filter((item) => item), pins: (result.checks ?? []).filter((item) => item.appId !== null).map((item) => ({ key: safeText(item.context, 200), appId: item.appId })) } : { source: "branch-protection", used: false, count: 0, note: `unavailable-${result.status}` };
    } catch (error) {
      if (error?.code === "TOOL_ABORTED" || signal?.aborted) throw error;
      const code = typeof error?.code === "string" ? error.code.replace(/[^A-Za-z0-9_]/g, "").slice(0, 40) : "unknown";
      protection = { source: "branch-protection", used: false, count: 0, note: `error-${code}` };
      unavailable = `branch-protection-${code}`;
    }
  }
  sources.push({ source: protection.source, used: protection.used, count: protection.count, ...(protection.note ? { note: protection.note } : {}), ...(protection.contexts ? { contexts: protection.contexts } : {}) });
  const required = unionRequired(normalized.policy.required, adapter.checks, protection.contexts ?? []);
  // A check pinned to a GitHub App by branch protection only counts when that app produced it, whichever source named the check.
  const pins = [...(normalized.policy.pins ?? []), ...(protection.pins ?? []).filter((pin) => !(normalized.policy.pins ?? []).some((item) => item.key === pin.key))];
  return { policy: { ...normalized.policy, required, pins }, sources, unavailable };
}
