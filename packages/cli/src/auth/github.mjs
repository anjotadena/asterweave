// GitHub plane: sign-in state comes from the `gh` CLI. We never read or store the token
// (`--show-token` / `-t` is never passed); only the account, host, and granted scopes are used.

import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { HOST_PATTERN } from "../host.mjs";
import { runBinary } from "../proc.mjs";
import { handoffLogin, parseJsonObject, probeCwd } from "./common.mjs";
import { saveReference } from "./credentials.mjs";

export const DEFAULT_HOST = "github.com";
/** Scopes Asterweave needs: list/clone repositories and read org membership. */
export const REQUIRED_SCOPES = Object.freeze(["repo", "read:org"]);
const INSTALL = "Install the GitHub CLI from https://cli.github.com/ and re-run.";
const SCOPE_IMPLIES = { "read:org": ["read:org", "write:org", "admin:org"], repo: ["repo"] };

/** Validate a host name (exit 2 on junk such as `-h`-style injection). */
export function normalizeHost(host = DEFAULT_HOST) {
  if (typeof host !== "string" || !HOST_PATTERN.test(host)) throw new UsageError(`Invalid GitHub host '${String(host)}'.`);
  return host.toLowerCase();
}

function outcome(host, status, code, reason, remediation, extra = {}) {
  return { plane: "github", status, code, reason, remediation: remediation ?? null, host, account: null, scopes: [], scopesKnown: false, tokenSource: null, ...extra };
}

function parseScopes(value) {
  const items = Array.isArray(value) ? value : String(value ?? "").split(/[,\s]+/);
  return items.map((item) => String(item).trim().replace(/^['"]+|['"]+$/g, "")).filter(Boolean);
}

function hostEntries(hosts, host) {
  const list = [];
  const add = (value) => {
    if (Array.isArray(value)) value.forEach(add);
    else if (value && typeof value === "object") list.push(value);
  };
  if (Array.isArray(hosts)) hosts.forEach(add);
  else for (const [key, value] of Object.entries(hosts)) if (key.toLowerCase() === host) add(value);
  return list.filter((entry) => entry.host === undefined || String(entry.host).toLowerCase() === host);
}

/**
 * Turn `gh auth status --json hosts` output into a normalized outcome. `gh` exits 0 even when
 * logged out, so the decision is made from the JSON, not the exit code.
 * @param {{code: number|null, stdout: string, stderr?: string}} result
 */
export function interpretGithubStatus(result, host = DEFAULT_HOST) {
  const parsed = parseJsonObject(result.stdout);
  if (!parsed || !parsed.hosts || typeof parsed.hosts !== "object") {
    if (result.code !== 0 && /not logged in/i.test(result.stderr ?? "")) {
      return outcome(host, "fail", "GH_NOT_AUTHENTICATED", `Not signed in to ${host}.`, `Run: gh auth login --web -h ${host} -s repo,read:org`);
    }
    return outcome(host, "fail", "GH_STATUS_UNPARSEABLE", "Could not read 'gh auth status --json hosts' output.", "Upgrade the GitHub CLI (gh 2.40 or newer) and re-run.");
  }
  const entries = hostEntries(parsed.hosts, host);
  const hasActiveFlag = entries.some((entry) => typeof entry.active === "boolean");
  const entry = hasActiveFlag ? entries.find((candidate) => candidate.active) : entries[0];
  if (!entry) {
    return outcome(host, "fail", "GH_NOT_AUTHENTICATED", `Not signed in to ${host}.`, `Run: gh auth login --web -h ${host} -s repo,read:org`);
  }

  const account = typeof entry.login === "string" ? entry.login : null;
  const tokenSource = typeof entry.tokenSource === "string" ? entry.tokenSource : null;
  const scopes = parseScopes(entry.scopes);
  const scopesKnown = scopes.length > 0;
  const extra = { account, scopes, scopesKnown, tokenSource };

  if (entry.state !== "success") {
    const state = typeof entry.state === "string" ? entry.state : "unknown";
    return outcome(host, "fail", "GH_AUTH_INVALID", `The ${host} sign-in${account ? ` for ${account}` : ""} is not valid (state: ${state}); the token may be expired or revoked.`, `Run: gh auth refresh -h ${host}`, extra);
  }
  if (!scopesKnown) {
    return outcome(host, "warn", "GH_SCOPES_UNKNOWN", "Token scopes cannot be determined (environment or fine-grained token); repo and read:org access is not verified.", `If repository access fails, run: gh auth login --web -h ${host} -s repo,read:org`, extra);
  }
  const missing = REQUIRED_SCOPES.filter((scope) => !SCOPE_IMPLIES[scope].some((granted) => scopes.includes(granted)));
  if (missing.length > 0) {
    const fromEnv = tokenSource && /^(GH|GITHUB)_/.test(tokenSource);
    const remediation = fromEnv
      ? `The token comes from ${tokenSource}; unset it or use one with scopes: ${REQUIRED_SCOPES.join(", ")}.`
      : `Run: gh auth refresh -h ${host} -s ${REQUIRED_SCOPES.join(",")}`;
    return outcome(host, "fail", "GH_SCOPE_MISSING", `The ${host} token lacks required scope(s): ${missing.join(", ")}.`, remediation, extra);
  }
  return outcome(host, "ok", "OK", `Signed in to ${host}${account ? ` as ${account}` : ""}.`, null, extra);
}

/**
 * Probe GitHub sign-in via `gh auth status --json hosts`. Never throws; never sees the token.
 * @param {{env?: object, spawn?: Function, exists?: Function, platform?: string, cwd?: string, host?: string, timeoutMs?: number, homedir?: () => string}} [options]
 */
export async function probeGithub({ env = process.env, spawn, exists, platform, cwd, host = DEFAULT_HOST, timeoutMs, homedir } = {}) {
  const hostName = normalizeHost(host);
  const result = await runBinary("gh", ["auth", "status", "--json", "hosts"], {
    env, spawn, exists, platform, timeoutMs, cwd: cwd ?? probeCwd({ env, platform, homedir }),
  });
  if (result.error) {
    if (result.error.code === "NOT_FOUND" || result.error.code === "SHELL_SHIM_ONLY" || result.error.code === "ENOENT") {
      return outcome(hostName, "fail", "GH_NOT_INSTALLED", "The GitHub CLI (gh) was not found.", INSTALL);
    }
    return outcome(hostName, "fail", "GH_STATUS_UNPARSEABLE", `Could not run gh: ${result.error.message}`, "Check that gh runs ('gh --version') and re-run.");
  }
  return interpretGithubStatus(result, hostName);
}

/**
 * Hand the terminal to `gh auth login --web`, then re-probe and record the reference.
 * Throws CliError: exit 130 when interrupted (nothing written), exit 3 when gh is missing or the
 * sign-in still does not satisfy the probe. Resolves `{probe, reference}` on success.
 * @param {Parameters<typeof probeGithub>[0] & {signal?: AbortSignal, now?: () => Date}} [options]
 */
export async function loginGithub(options = {}) {
  const { env = process.env, spawn, exists, platform, cwd, signal, homedir, now = () => new Date() } = options;
  const host = normalizeHost(options.host);
  const directory = cwd ?? probeCwd({ env, platform, homedir });
  await handoffLogin({
    binary: "gh",
    args: ["auth", "login", "--web", "-h", host, "-s", REQUIRED_SCOPES.join(",")],
    label: "GitHub",
    codes: { notInstalled: "GH_NOT_INSTALLED", shim: "GH_NOT_INSTALLED", loginFailed: "GH_LOGIN_FAILED" },
    installRemediation: INSTALL,
    env, spawn, exists, platform, cwd: directory, signal,
  });
  const probe = await probeGithub({ env, spawn, exists, platform, cwd: directory, host, homedir });
  if (probe.status === "fail") {
    throw new CliError(probe.reason, { code: probe.code, exitCode: EXIT.AUTH, remediation: probe.remediation ?? undefined });
  }
  const reference = saveReference(
    "github",
    { provider: "github", source: "gh-cli", host, account: probe.account, verifiedAt: now().toISOString() },
    { env, platform, homedir },
  );
  return { probe, reference };
}
