// Credential planes - kept strictly separate:
//   github      sign-in through `gh`          (REQUIRED to launch)
//   model       sign-in through `claude`      (missing = warning only, decided by the caller)
//   asterweave  hosted account                (always unavailable; never blocks)
// Only references are stored (credentials.json); tokens never enter this process's state.

import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { redactDeep } from "../redact.mjs";
import { probeAccount } from "./account.mjs";
import { loginClaude, probeClaude } from "./claude.mjs";
import { dropReference, readCredentials } from "./credentials.mjs";
import { DEFAULT_HOST, loginGithub, normalizeHost, probeGithub } from "./github.mjs";

export { probeAccount, probeClaude, probeGithub, loginClaude, loginGithub };
export { PLANES, dropReference, normalizeReference, readCredentials, saveReference } from "./credentials.mjs";

/** Probe all three planes (github and model probes run concurrently). */
export async function probeAll(options = {}) {
  const { host, ...shared } = options;
  const [github, model] = await Promise.all([probeGithub({ ...shared, host }), probeClaude(shared)]);
  return { asterweave: probeAccount(), github, model };
}

/**
 * Masked view for `auth status --json`. `ok` reflects GitHub only: a missing model sign-in or the
 * unavailable Asterweave account never flips it.
 * @returns {Promise<{ok: boolean, planes: {asterweave: object, github: object, model: object}}>}
 */
export async function authStatus(options = {}) {
  const planes = await probeAll(options);
  return { ok: planes.github.status !== "fail", planes: redactDeep(planes).value };
}

/** Throw CliError (exit 3, code = reason code) unless GitHub is usable; returns the probe (ok or warn). */
export async function requireGithub(options = {}) {
  const probe = await probeGithub(options);
  if (probe.status === "fail") {
    throw new CliError(probe.reason, { code: probe.code, exitCode: EXIT.AUTH, remediation: probe.remediation ?? undefined });
  }
  return probe;
}

/**
 * `auth logout`: drop Asterweave's stored reference ONLY. The provider sign-in is untouched and
 * its logout command is returned for the user to run; this function never spawns anything.
 * @param {'github'|'model'} plane
 * @param {{host?: string, env?: object, platform?: string, homedir?: () => string}} [options]
 * @returns {{plane: string, droppedReference: boolean, providerCommand: string}}
 */
export function logoutPlan(plane, options = {}) {
  if (plane !== "github" && plane !== "model") throw new UsageError(`Cannot sign out of '${plane}'; use 'github' or 'model'.`);
  const paths = { env: options.env, platform: options.platform, homedir: options.homedir };
  let host;
  if (plane === "github") host = normalizeHost(options.host ?? readCredentials(paths).github?.host ?? DEFAULT_HOST);
  const droppedReference = dropReference(plane, paths);
  return { plane, droppedReference, providerCommand: plane === "github" ? `gh auth logout -h ${host}` : "claude auth logout" };
}
