// `asterweave doctor`: a read-only health report over the installation, sign-in planes, user
// directory, configuration and repository.
//
// Safety rules:
//   - Provider probes are the existing ones (`gh auth status --json hosts`, `claude auth status`),
//     run in the user directory. Doctor never runs `claude doctor` (it spawns .mcp.json stdio
//     servers), never `claude -p`, never `--show-token`, and never executes repository config.
//   - Repository config is only inspected (existence, counts); command text is never printed.
//   - The whole result goes through `redactDeep` before it is returned, so nothing token-shaped
//     (or a personal email) can reach text or JSON output.
//
// Check ids are stable (they are part of the `--json` contract) and always appear in this order:
//   node.version, user-dir.writable, config.valid, github.install, github.auth, github.scopes,
//   model.claude, account.asterweave, repo.connection, repo.trust

import * as nodeFs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { probeAll } from "./auth/index.mjs";
import { DEFAULT_HOST, REQUIRED_SCOPES } from "./auth/github.mjs";
import { ConfigError, resolveConfig } from "./config.mjs";
import { resolveUserDir } from "./paths.mjs";
import { redactDeep } from "./redact.mjs";
import { StoreError } from "./store.mjs";
import { classifyExecutableConfig, safeTrustStatus, TRUST_FILES } from "./trust.mjs";

export const MIN_NODE_MAJOR = 22;

/** The check ids, in report order. */
export const CHECK_IDS = Object.freeze([
  "node.version",
  "user-dir.writable",
  "config.valid",
  "github.install",
  "github.auth",
  "github.scopes",
  "model.claude",
  "account.asterweave",
  "repo.connection",
  "repo.trust",
]);

/**
 * @typedef {object} DoctorCheck
 * @property {string} id
 * @property {'PASS'|'WARN'|'FAIL'} status
 * @property {string} reason
 * @property {string|null} remediation
 */

const check = (id, status, reason, remediation = null) => ({ id, status, reason, remediation: remediation ?? null });
const messageOf = (error) => String(error?.message ?? error ?? "unknown error").split(/\r?\n/)[0];
const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// ---------------------------------------------------------------------------------------------
// node.version

function nodeVersionCheck(nodeVersion) {
  const major = Number.parseInt(String(nodeVersion ?? "").replace(/^v/i, ""), 10);
  const remediation = `Install Node.js ${MIN_NODE_MAJOR} or newer from https://nodejs.org/ and re-run.`;
  if (!Number.isInteger(major)) return check("node.version", "FAIL", `Could not determine the Node.js version ('${nodeVersion}').`, remediation);
  if (major < MIN_NODE_MAJOR) return check("node.version", "FAIL", `Node.js ${nodeVersion} is too old; Asterweave requires Node.js ${MIN_NODE_MAJOR} or newer.`, remediation);
  return check("node.version", "PASS", `Node.js ${String(nodeVersion).replace(/^v/i, "")} (requires ${MIN_NODE_MAJOR}+).`);
}

// ---------------------------------------------------------------------------------------------
// user-dir.writable

function userDirCheck({ env, platform, homedir, fs }) {
  const dir = resolveUserDir({ env, platform, homedir });
  const p = platform === "win32" ? path.win32 : path.posix;
  const probe = p.join(dir, `.doctor-probe-${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  const remediation = `Make ${dir} writable, or set ASTERWEAVE_CONFIG_DIR to a writable absolute directory.`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(probe, "asterweave doctor write probe\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    return check("user-dir.writable", "FAIL", `Cannot write to the Asterweave user directory ${dir} (${error?.code ?? messageOf(error)}).`, remediation);
  }
  try {
    fs.unlinkSync(probe);
  } catch (error) {
    return check("user-dir.writable", "WARN", `The user directory ${dir} is writable, but the temporary probe file ${probe} could not be removed (${error?.code ?? messageOf(error)}).`, `Delete ${probe} manually.`);
  }
  return check("user-dir.writable", "PASS", `User directory ${dir} is writable.`);
}

// ---------------------------------------------------------------------------------------------
// config.valid

function configCheck(options) {
  try {
    const resolved = resolveConfig(options);
    const layers = options.repoPath ? "user and repository" : "user";
    return check("config.valid", "PASS", `Configuration is valid (${layers} layers${resolved.unknown.length > 0 ? `; ${plural(resolved.unknown.length, "unrecognised user key")} ignored` : ""}).`);
  } catch (error) {
    if (error instanceof ConfigError) {
      // A JSON syntax error's own message can quote file content; say only where it is broken.
      const corrupt = error.cause instanceof StoreError;
      const reason = corrupt
        ? `Configuration file is ${error.cause.reason === "CORRUPT" ? "not valid JSON" : "unreadable"} (${error.origin ?? "unknown origin"}).`
        : error.message;
      const missing = [
        error.key && !reason.includes(error.key) ? `key '${error.key}'` : null,
        error.origin && !reason.includes(error.origin) ? `origin ${error.origin}` : null,
      ].filter(Boolean);
      return check("config.valid", "FAIL", `${reason}${missing.length > 0 ? ` [${missing.join(", ")}]` : ""} (configuration invalid, exit code 5)`, error.remediation ?? "Fix the setting named above, then re-run `asterweave doctor`.");
    }
    return check("config.valid", "FAIL", `Configuration could not be read: ${messageOf(error)}`, "Fix or delete the file named above, then re-run `asterweave doctor`.");
  }
}

// ---------------------------------------------------------------------------------------------
// github.* / model.claude / account.asterweave

function githubChecks(probe) {
  const skip = (id, why) => check(id, "WARN", `Skipped: ${why}`);
  const notInstalled = probe.code === "GH_NOT_INSTALLED";
  const install = notInstalled ? check("github.install", "FAIL", probe.reason, probe.remediation) : check("github.install", "PASS", "GitHub CLI (gh) is installed.");

  let auth;
  let scopes;
  switch (probe.code) {
    case "GH_NOT_INSTALLED":
      auth = skip("github.auth", "the GitHub CLI (gh) is not installed.");
      scopes = skip("github.scopes", "the GitHub CLI (gh) is not installed.");
      break;
    case "GH_NOT_AUTHENTICATED":
    case "GH_AUTH_INVALID":
      auth = check("github.auth", "FAIL", probe.reason, probe.remediation);
      scopes = skip("github.scopes", "not signed in to GitHub.");
      break;
    case "GH_STATUS_UNPARSEABLE":
      auth = check("github.auth", "WARN", probe.reason, probe.remediation);
      scopes = skip("github.scopes", "GitHub sign-in state could not be read.");
      break;
    case "GH_SCOPE_MISSING":
      auth = check("github.auth", "PASS", `Signed in to ${probe.host}${probe.account ? ` as ${probe.account}` : ""}.`);
      scopes = check("github.scopes", "FAIL", probe.reason, probe.remediation);
      break;
    case "GH_SCOPES_UNKNOWN":
      auth = check("github.auth", "PASS", `Signed in to ${probe.host}${probe.account ? ` as ${probe.account}` : ""}.`);
      scopes = check("github.scopes", "WARN", probe.reason, probe.remediation);
      break;
    default:
      // OK, or an unrecognised code from a newer probe: trust its own status.
      if (probe.status === "ok") {
        auth = check("github.auth", "PASS", probe.reason);
        scopes = check("github.scopes", "PASS", `Token scopes cover ${REQUIRED_SCOPES.join(", ")}.`);
      } else {
        auth = check("github.auth", "WARN", probe.reason, probe.remediation);
        scopes = skip("github.scopes", "GitHub sign-in state is unknown.");
      }
  }
  return [install, auth, scopes];
}

function modelCheck(probe) {
  if (probe.status === "ok") return check("model.claude", "PASS", probe.reason);
  // Model-provider sign-in is never a blocker (user amendment): every non-OK result is a WARN.
  return check("model.claude", "WARN", `${probe.reason} Model sign-in is not required to start Asterweave.`, probe.remediation);
}

const accountCheck = () => check("account.asterweave", "PASS", "unavailable: no hosted backend configured (local sessions unaffected)");

// ---------------------------------------------------------------------------------------------
// repo.*

async function loadRepoStatus() {
  const module = await import("./repo.mjs");
  if (typeof module.repoStatus !== "function") throw Object.assign(new Error("repo.mjs does not export repoStatus"), { code: "ERR_MODULE_NOT_FOUND" });
  return module.repoStatus;
}

async function readRepoStatus(injected, options) {
  try {
    const fn = injected ?? (await loadRepoStatus());
    const result = await fn(options);
    if (!result || typeof result !== "object") throw new Error("repoStatus returned no result");
    return { result };
  } catch (error) {
    return { error };
  }
}

function repoConnectionCheck(read) {
  if (read.error) {
    const missing = read.error?.code === "ERR_MODULE_NOT_FOUND" || read.error?.code === "MODULE_NOT_FOUND";
    return check(
      "repo.connection",
      "WARN",
      missing ? "repository status unavailable: repository support is not part of this build." : `repository status unavailable: ${messageOf(read.error)}`,
      missing ? null : "Run `asterweave repo connect` to reconnect a local clone.",
    );
  }
  const status = read.result;
  if (!status.connected) return check("repo.connection", "WARN", `No repository is connected.${status.warning ? ` ${status.warning}` : ""}`, "asterweave repo connect");
  const label = `${status.repository ?? "repository"}${status.branch ? ` (${status.branch})` : ""}`;
  if (status.ok) return check("repo.connection", "PASS", `Connected: ${label} at ${status.path}.`);
  const why = status.problem === "REPO_PATH_MISSING" ? "no longer exists" : status.problem === "REPO_NOT_GIT" ? "is no longer a git work tree" : "is not usable";
  return check("repo.connection", "FAIL", `The connected repository ${label} path ${status.path} ${why}.`, "asterweave repo connect --path <existing clone>");
}

function hasGoverningFile(dir, fs) {
  return TRUST_FILES.some((relative) => {
    try {
      return fs.statSync(path.join(dir, ...relative.split("/"))).isFile();
    } catch {
      return false;
    }
  });
}

function describeFindings(findings) {
  const count = (kind) => findings.filter((finding) => finding.kind === kind).length;
  const parts = [
    [count("command"), "quality-gate command"],
    [count("settings"), "Claude settings file"],
    [count("mcp"), "MCP server config"],
  ].filter(([n]) => n > 0).map(([n, label]) => plural(n, label));
  return parts.length > 0 ? parts.join(", ") : "no executable config detected";
}

const quoteIfNeeded = (value) => (/\s/.test(value) ? `"${value}"` : value);

function repoTrustCheck(target, { env, platform, homedir, fs }) {
  if (!target) return check("repo.trust", "PASS", "Not applicable: no repository is connected and the current directory has no repository config files.");
  let status;
  let findings;
  try {
    status = safeTrustStatus(target, { env, platform, homedir, fs });
    findings = classifyExecutableConfig(target, { fs });
  } catch (error) {
    return check("repo.trust", "WARN", `repository trust status unavailable: ${messageOf(error)}`, null);
  }
  const summary = describeFindings(findings);
  if (status.trusted) return check("repo.trust", "PASS", `Repository ${status.realpath} is trusted (${summary}).`);
  const why = status.reason === "CHANGED" ? "its trust-governing files changed since trust was granted" : status.warning ?? "trust has not been granted";
  return check(
    "repo.trust",
    "WARN",
    `Repository ${status.realpath} is untrusted (${why}); executable config found: ${summary}. Its commands and settings are not applied or run.`,
    `Review the repository config, then run: asterweave trust grant --path ${quoteIfNeeded(status.realpath)}`,
  );
}

// ---------------------------------------------------------------------------------------------
// Orchestration

/**
 * Run every check and return the redacted report. Never throws.
 *
 * @param {object} [options]
 * @param {Record<string,string|undefined>} [options.env]
 * @param {Function} [options.spawn]      child_process.spawn-compatible (injectable).
 * @param {(file: string) => boolean} [options.exists]  Executable existence check for PATH lookup.
 * @param {string} [options.platform]
 * @param {string} [options.cwd]          Directory whose repository config is considered when no repository is connected.
 * @param {() => string} [options.homedir]
 * @param {(options: object) => Promise<object>} [options.repoStatus]  Defaults to `repoStatus` from ./repo.mjs.
 * @param {() => string} [options.now]    Accepted for symmetry with the other modules; unused.
 * @param {string} [options.nodeVersion]  Defaults to process.versions.node.
 * @param {typeof nodeFs} [options.fs]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, checks: DoctorCheck[]}>}  `ok` is true when no check is FAIL.
 */
export async function runDoctor(options = {}) {
  const {
    env = process.env,
    spawn,
    exists,
    platform = process.platform,
    cwd = process.cwd(),
    homedir,
    repoStatus: injectedRepoStatus,
    nodeVersion = process.versions.node,
    fs = nodeFs,
    timeoutMs,
  } = options;

  // Only forward options the caller actually provided, so defaults live in one place.
  const shared = { env, platform };
  for (const [key, value] of Object.entries({ spawn, exists, homedir, timeoutMs, fs })) if (value !== undefined) shared[key] = value;

  const checks = new Map();
  const set = (...list) => list.forEach((item) => checks.set(item.id, item));
  const guard = (ids, fn) => {
    try {
      fn();
    } catch (error) {
      for (const id of ids) if (!checks.has(id)) set(check(id, "FAIL", `Check could not complete: ${messageOf(error)}`, "Re-run `asterweave doctor`; if it persists, report this as a bug."));
    }
  };

  guard(["node.version"], () => set(nodeVersionCheck(nodeVersion)));
  guard(["user-dir.writable"], () => set(userDirCheck({ env, platform, homedir, fs })));

  // The GitHub host comes from the user config when it is valid (invalid config is reported below).
  let host = DEFAULT_HOST;
  try {
    host = resolveConfig({ env, platform, homedir, fs }).entries["github.host"].value;
  } catch {
    // Reported by config.valid.
  }

  // Provider probes and the repository status are independent: run them together.
  const [probes, repoRead] = await Promise.all([
    probeAll({ ...shared, host }).catch((error) => ({ error })),
    readRepoStatus(injectedRepoStatus, shared),
  ]);

  const connected = !repoRead.error && repoRead.result.connected === true;
  const connectedUsable = connected && repoRead.result.ok === true && typeof repoRead.result.path === "string";

  guard(["config.valid"], () => set(configCheck({ ...shared, repoPath: connectedUsable ? repoRead.result.path : undefined })));

  if (probes.error) {
    const failure = (id) => check(id, "FAIL", `Check could not complete: ${messageOf(probes.error)}`, "Re-run `asterweave doctor`.");
    set(failure("github.install"), failure("github.auth"), failure("github.scopes"), check("model.claude", "WARN", `Check could not complete: ${messageOf(probes.error)}`));
  } else {
    guard(["github.install", "github.auth", "github.scopes"], () => set(...githubChecks(probes.github)));
    guard(["model.claude"], () => set(modelCheck(probes.model)));
  }
  set(accountCheck());
  guard(["repo.connection"], () => set(repoConnectionCheck(repoRead)));

  guard(["repo.trust"], () => {
    let target = null;
    if (connectedUsable) target = repoRead.result.path;
    else if (!connected && hasGoverningFile(cwd, fs)) target = cwd;
    set(repoTrustCheck(target, { env, platform, homedir, fs }));
  });

  const ordered = CHECK_IDS.map((id) => checks.get(id));
  const redacted = redactDeep({ ok: ordered.every((item) => item.status !== "FAIL"), checks: ordered }).value;
  return { ok: redacted.ok, checks: redacted.checks };
}
