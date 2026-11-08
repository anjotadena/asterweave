// `asterweave` (bare): the first-launch -> working-session flow.
//   1. interactive terminal required            (exit 2 otherwise)
//   2. GitHub sign-in is REQUIRED               (sign-in screen; gh missing -> exit 3)
//   3. repository: reuse repo.json, or pick     (same pickers as `repo connect`)
//   4. banner + working session                 (composer; no agent loop in Phase A)
// Registered by commands/index.mjs (`launchCommands` is the same registration data as a Map).
// Nothing typed in the session is sent anywhere and no repository command is ever executed.

import path from "node:path";
import { loginClaude, loginGithub, probeClaude, probeGithub } from "../auth/index.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { quoteArg } from "../redact.mjs";
import { connectRepository, repoStatus } from "../repo.mjs";
import { classifyExecutableConfig } from "../trust.mjs";
import { createStyle } from "../tui/render.mjs";
import { SIGN_IN_PROVIDERS, buildBannerLines, renderSignInScreen } from "../tui/screens.mjs";
import { createSession, pickOne, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { launchCommandMeta } from "./index.mjs";
import { pickRepository } from "./repo.mjs";
import { createSessionViews } from "./context.mjs";
import { resolveRepo } from "./run.mjs";
import { assertGithubComOnly, colorMode, runtimeSeams } from "./shared.mjs";

export { launchCommandMeta };

/** Same registration data as a Map, for a table-driven wiring. */
export const launchCommands = new Map([["launch", { handler: launchCommand, ...launchCommandMeta }]]);

/** GitHub probe failures the sign-in screen can fix; anything else (gh missing, unreadable) exits 3. */
const SIGN_IN_FIXES = new Set(["GH_NOT_AUTHENTICATED", "GH_AUTH_INVALID", "GH_SCOPE_MISSING"]);

/** auth login takes a Date from `now`; repo.mjs takes an ISO string. Accept either from the seam. */
function authOptions(options) {
  const { now, fs, ...rest } = options;
  return now === undefined ? rest : { ...rest, now: () => { const value = now(); return value instanceof Date ? value : new Date(value); } };
}

function githubError(probe) {
  return new CliError(probe.reason, { code: probe.code, exitCode: EXIT.AUTH, remediation: probe.remediation ?? undefined });
}

/**
 * Hand the terminal to a provider login. SIGINT during the hand-off aborts the login (the child
 * shares the terminal and gets the signal too), which the auth layer maps to exit 130.
 */
async function handoff(ctx, run) {
  const proc = ctx.proc ?? process;
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  proc.on("SIGINT", onSigint);
  try {
    return await run(controller.signal);
  } finally {
    proc.removeListener("SIGINT", onSigint);
  }
}

/** Handler for bare `asterweave`. Returns the exit code. */
export async function launchCommand(ctx) {
  if (ctx.options?.json === true) {
    throw new UsageError("--json is not supported when launching.", { remediation: "Run `asterweave auth status --json` or `asterweave doctor --json` for machine-readable output." });
  }
  if ((ctx.positionals ?? []).length > 0) throw new UsageError(`Unexpected argument '${ctx.positionals[0]}'.`, { remediation: "Usage: asterweave" });
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  if (!terminal.isInteractive) throw new UsageError("interactive mode requires a TTY; use --json or a TTY terminal");

  // Repository selection is github.com only in this build: fail before any probe, picker or spawn.
  assertGithubComOnly(ctx);

  const options = runtimeSeams(ctx);
  const proc = ctx.proc ?? process;
  const style = createStyle({ env: ctx.env, isTTY: true, mode: colorMode(ctx) });

  // --- GitHub (required) -----------------------------------------------------------------------
  let github = await probeGithub(options);
  let model = null;
  let notice = github.code === "GH_NOT_AUTHENTICATED" ? "" : github.reason ?? "";
  while (github.status === "fail") {
    if (!SIGN_IN_FIXES.has(github.code)) throw githubError(github);
    const picked = await withTerminal({ terminal, stdin: ctx.stdin, proc }, ({ input, signal }) =>
      pickOne({
        terminal, input, signal, count: SIGN_IN_PROVIDERS.length,
        render: (index, { columns }) => renderSignInScreen({ version: ctx.version, index, notice, width: columns, style }),
      }));
    if (picked.interrupted) return EXIT.INTERRUPTED;
    if (picked.cancelled) {
      throw new CliError("Sign-in cancelled; Asterweave needs a GitHub sign-in to continue.", {
        code: "LAUNCH_CANCELLED",
        exitCode: EXIT.ERROR,
        remediation: "Run: gh auth login --web -h github.com -s repo,read:org",
      });
    }
    if (SIGN_IN_PROVIDERS[picked.index].id === "github") {
      ctx.stdout.write("Signing in with GitHub (gh auth login --web)...\n");
      github = (await handoff(ctx, (signal) => loginGithub({ ...authOptions(options), signal }))).probe;
      continue;
    }
    // Browser sign-in is the model provider: it never satisfies the GitHub requirement.
    ctx.stdout.write("Signing in with your browser (claude auth login)...\n");
    notice = "GitHub sign-in is required to continue.";
    try {
      model = (await handoff(ctx, (signal) => loginClaude({ ...authOptions(options), signal }))).probe;
    } catch (error) {
      if (!(error instanceof CliError) || error.exitCode === EXIT.INTERRUPTED) throw error;
      notice = `Model sign-in did not complete: ${error.message} GitHub sign-in is required to continue.`;
    }
  }
  model ??= await probeClaude(options);

  // --- Repository --------------------------------------------------------------------------------
  let repo = await repoStatus(options);
  const repoWarning = repo.warning; // an unreadable repo.json counts as "not connected" and is shown on the banner
  if (!(repo.connected && repo.ok)) {
    const clonePath = path.resolve(ctx.cwd ?? process.cwd());
    let picked;
    try {
      picked = await pickRepository(ctx, terminal, { clonePath, options });
    } catch (error) {
      if (error?.code !== "REPO_BRANCHES_FAILED") throw error;
      throw new CliError(error.message, {
        code: error.code,
        exitCode: error.exitCode,
        remediation: "Start asterweave inside a local clone, or run: asterweave repo connect --repo owner/name --branch main --path <clone>",
      });
    }
    if (picked.interrupted) return EXIT.INTERRUPTED;
    if (picked.cancelled) throw new CliError("Repository selection cancelled; nothing was saved.", { code: "LAUNCH_CANCELLED", exitCode: EXIT.ERROR });
    await connectRepository({ repository: picked.repository, branch: picked.branch, path: clonePath, ...options });
    repo = await repoStatus(options);
  }

  // --- Banner ----------------------------------------------------------------------------------
  const warnings = [];
  if (repoWarning) warnings.push(repoWarning);
  if (repo.trust?.warning) warnings.push(repo.trust.warning);
  if (github.code === "GH_SCOPES_UNKNOWN") warnings.push("GitHub: token scopes could not be verified (repo, read:org)");
  if (model.status !== "ok") {
    warnings.push(model.code === "CLAUDE_NOT_AUTHENTICATED" ? "Model provider: not signed in — run: asterweave auth login model" : `Model provider: ${model.reason}`);
  }
  if (repo.trust && !repo.trust.trusted && hasExecutableConfig(repo.path, ctx.fs)) {
    const quoted = quoteArg(repo.path);
    warnings.push(`Repository config not trusted — run: asterweave trust grant --path ${quoted ?? "<path>"}`);
    // A path that cannot be quoted safely for cmd/PowerShell is never embedded in the command line.
    if (quoted === null) warnings.push("where <path> is the following path (quote this path for your shell):", repo.path);
  }
  const banner = buildBannerLines({
    account: github.account ?? "unknown",
    repo: repo.repository,
    branch: repo.branch,
    model: { ok: model.status === "ok", authMethod: model.authMethod },
    warnings,
    width: terminal.columns,
    style,
  });

  // --- Session -----------------------------------------------------------------------------------
  let active;
  return withTerminal({ terminal, stdin: ctx.stdin, proc, onInterrupt: () => active?.interrupt() }, ({ input }) => {
    // Read-only /context /usage /attachments /image views; the repository key is resolved on first use (a git query).
    const views = createSessionViews(ctx, { resolveKey: async () => (await resolveRepo(ctx)).key });
    active = createSession({ terminal, input, style, version: ctx.version, repo: repo.repository, branch: repo.branch, banner, views });
    return active.run();
  });
}

function hasExecutableConfig(repoPath, fs) {
  try {
    return classifyExecutableConfig(repoPath, fs ? { fs } : undefined).length > 0;
  } catch {
    return true; // cannot inspect the repository: fail closed, show the trust warning
  }
}
