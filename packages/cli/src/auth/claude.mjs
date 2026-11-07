// Model plane: sign-in state comes from `claude auth status` (JSON by default). Never runs
// `claude doctor` (it spawns .mcp.json stdio servers) or `claude -p`. Probes run in the user
// directory so a repository's .claude/settings.json is never loaded.

import { CliError, EXIT } from "../exit-codes.mjs";
import { runBinary } from "../proc.mjs";
import { maskEmail, redactText } from "../redact.mjs";
import { handoffLogin, parseJsonObject, probeCwd } from "./common.mjs";
import { saveReference } from "./credentials.mjs";

const INSTALL = "Install the native Claude Code build (https://docs.claude.com/en/docs/claude-code) so that claude.exe is on PATH.";
const LOGIN = "Run: claude auth login";

function outcome(status, code, reason, remediation, extra = {}) {
  return { plane: "model", status, code, reason, remediation: remediation ?? null, account: null, authMethod: null, apiProvider: null, orgName: null, subscriptionType: null, ...extra };
}

/** A displayable provider string with secrets redacted, or null. */
function text(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  return String(redactText(value).text);
}

/**
 * Turn `claude auth status` output into a normalized outcome. The logged-out JSON shape is not
 * verified, so parsing is tolerant: `loggedIn:false`, or a failing exit without a usable
 * `loggedIn:true`, both mean "not authenticated".
 * @param {{code: number|null, stdout: string}} result
 */
export function interpretClaudeStatus(result) {
  const parsed = parseJsonObject(result.stdout);
  const loggedIn = parsed && typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : undefined;
  if (loggedIn === true) {
    const account = typeof parsed.email === "string" && parsed.email ? maskEmail(parsed.email) : null;
    return outcome("ok", "OK", account ? `Claude Code is signed in as ${account}.` : "Claude Code is signed in.", null, {
      account,
      authMethod: text(parsed.authMethod),
      apiProvider: text(parsed.apiProvider),
      orgName: text(parsed.orgName),
      subscriptionType: text(parsed.subscriptionType),
    });
  }
  if (loggedIn === false || result.code !== 0) {
    return outcome("fail", "CLAUDE_NOT_AUTHENTICATED", loggedIn === false ? "Claude Code is not signed in." : `'claude auth status' exited with code ${result.code ?? "unknown"} and no sign-in was reported.`, LOGIN);
  }
  return outcome("fail", "CLAUDE_STATUS_UNPARSEABLE", "Could not read 'claude auth status' output.", "Upgrade Claude Code (claude update) and re-run.");
}

/**
 * Probe Claude Code sign-in. Never throws. The probe reports 'fail' honestly; whether a missing
 * model sign-in blocks anything (it does not, in Phase A) is the caller's decision.
 * @param {{env?: object, spawn?: Function, exists?: Function, platform?: string, cwd?: string, timeoutMs?: number, homedir?: () => string}} [options]
 */
export async function probeClaude({ env = process.env, spawn, exists, platform, cwd, timeoutMs, homedir } = {}) {
  const result = await runBinary("claude", ["auth", "status"], {
    env, spawn, exists, platform, timeoutMs, cwd: cwd ?? probeCwd({ env, platform, homedir }),
  });
  if (result.error) {
    const code = result.error.code;
    if (code === "SHELL_SHIM_ONLY") {
      return outcome("fail", "CLAUDE_SHELL_SHIM_ONLY", "Claude Code is only installed as a .cmd shim, which Asterweave does not run (it never uses a shell).", INSTALL);
    }
    if (code === "NOT_FOUND" || code === "ENOENT") {
      return outcome("fail", "CLAUDE_NOT_INSTALLED", "Claude Code (claude) was not found.", INSTALL);
    }
    return outcome("fail", "CLAUDE_STATUS_UNPARSEABLE", `Could not run claude: ${result.error.message}`, "Check that 'claude --version' runs and re-run.");
  }
  return interpretClaudeStatus(result);
}

/**
 * Hand the terminal to `claude auth login`, then re-probe and record the reference.
 * Same contract as `loginGithub`: exit 130 and nothing written when interrupted.
 * @param {Parameters<typeof probeClaude>[0] & {signal?: AbortSignal}} [options]
 */
export async function loginClaude(options = {}) {
  const { env = process.env, spawn, exists, platform, cwd, signal, homedir } = options;
  const directory = cwd ?? probeCwd({ env, platform, homedir });
  await handoffLogin({
    binary: "claude",
    args: ["auth", "login"],
    label: "Claude Code",
    codes: { notInstalled: "CLAUDE_NOT_INSTALLED", shim: "CLAUDE_SHELL_SHIM_ONLY", loginFailed: "CLAUDE_LOGIN_FAILED" },
    installRemediation: INSTALL,
    env, spawn, exists, platform, cwd: directory, signal,
  });
  const probe = await probeClaude({ env, spawn, exists, platform, cwd: directory, homedir });
  if (probe.status !== "ok") {
    throw new CliError(probe.reason, { code: probe.code, exitCode: EXIT.AUTH, remediation: probe.remediation ?? undefined });
  }
  const reference = saveReference(
    "model",
    { provider: "model", source: "claude-cli", account: probe.account, authMethod: probe.authMethod },
    { env, platform, homedir },
  );
  return { probe, reference };
}
