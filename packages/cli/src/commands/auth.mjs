// `asterweave auth status|login|logout`. Registered by commands/index.mjs.
//
// Three planes are kept separate: GitHub (gh), model provider (claude), Asterweave account
// (always unavailable). Only references are stored; logout never runs a provider command.

import { authStatus, loginClaude, loginGithub, logoutPlan } from "../auth/index.mjs";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { createStyle } from "../tui/render.mjs";
import { pickOne } from "./picker.mjs";
import { isInteractive, resolveHost, seams, stringOption } from "./shared.mjs";

export const authCommandMeta = Object.freeze({ summary: "Show or change sign-in state (auth status | login | logout)", boolean: ["json"], options: ["json", "host"] });

const USAGE = "Usage: asterweave auth status [--json] | auth login [github|model] [--host h] | auth logout <github|model> [--host h] [--json]";
const PLANES = ["github", "model"];
const LOGIN_NOTE = "A browser will open to authorize Asterweave. After approval, return here to continue.";
const write = (stream, text) => stream.write(text);

/** Handler for `asterweave auth ...`. */
export async function authCommand(ctx) {
  const [sub, ...args] = ctx.positionals ?? [];
  if (sub === "status") return status(ctx, args);
  if (sub === "login") return login(ctx, args);
  if (sub === "logout") return logout(ctx, args);
  throw new UsageError(sub ? `Unknown auth subcommand '${sub}'.` : "Missing auth subcommand.", { remediation: USAGE });
}

/** Options for provider probes. Never includes cwd: probes always run in the user directory. */
function providerSeams(ctx) {
  return seams(ctx, ["spawn", "exists", "timeoutMs"]);
}

// ---------------------------------------------------------------------------------------------
// status

/** Plain-text report of the three planes (masked values only). */
export function formatAuthStatus(report) {
  const { github, model } = report.planes;
  const lines = [];
  if (github.status === "fail") {
    lines.push(`GitHub: ${github.reason}`);
  } else {
    lines.push(`GitHub: signed in as ${github.account ?? "unknown account"} (${github.host}) scopes ${github.status === "ok" ? "ok" : "unknown"}`);
  }
  if (github.status !== "ok" && github.remediation) lines.push(`  -> ${github.remediation}`);
  if (model.status === "ok") {
    lines.push(`Model provider (Claude Code): signed in${model.account ? ` as ${model.account}` : ""}${model.authMethod ? ` (${model.authMethod})` : ""}`);
  } else {
    lines.push(`Model provider (Claude Code): ${model.reason}`);
    if (model.remediation) lines.push(`  -> ${model.remediation}`);
    lines.push("  (warning only: Asterweave can still start without a model sign-in)");
  }
  lines.push("Asterweave account: unavailable (no hosted backend configured)");
  // Provider output (accounts, reasons) is outside our control: strip terminal control sequences.
  return sanitizeForTerminal(`${lines.join("\n")}\n`);
}

async function status(ctx, args) {
  if (args.length > 0) throw new UsageError(`Unexpected argument '${args[0]}'.`, { remediation: USAGE });
  const host = resolveHost(ctx, stringOption(ctx, "host", USAGE));
  const report = await authStatus({ ...providerSeams(ctx), host });
  if (ctx.options?.json === true) write(ctx.stdout, `${JSON.stringify(report)}\n`);
  else write(ctx.stdout, formatAuthStatus(report));
  return report.ok ? EXIT.OK : EXIT.AUTH;
}

// ---------------------------------------------------------------------------------------------
// login

async function login(ctx, args) {
  if (ctx.options?.json === true) {
    throw new UsageError("auth login is interactive and does not support --json.", { remediation: "Use `asterweave auth status --json` to inspect sign-in state." });
  }
  if (args.length > 1) throw new UsageError(`Unexpected argument '${args[1]}'.`, { remediation: USAGE });
  let plane = args[0];
  if (plane !== undefined && !PLANES.includes(plane)) throw new UsageError(`Cannot sign in to '${plane}'; use 'github' or 'model'.`, { remediation: USAGE });
  const hostFlag = stringOption(ctx, "host", USAGE);
  if (hostFlag !== undefined && plane === "model") throw new UsageError("--host applies to GitHub only.", { remediation: USAGE });
  if (hostFlag !== undefined) resolveHost(ctx, hostFlag); // validate before any picker or hand-off

  if (plane === undefined) {
    if (!isInteractive(ctx)) {
      throw new UsageError("auth login needs a plane (github or model) when it is not run in an interactive terminal.", {
        remediation: "Example: asterweave auth login github",
      });
    }
    const picked = await pickOne(ctx, {
      title: "Sign in to Asterweave",
      header: "Asterweave",
      items: [{ label: "GitHub (recommended)" }, { label: "Browser sign-in" }],
      note: LOGIN_NOTE,
    });
    if (picked.interrupted) return EXIT.INTERRUPTED;
    if (picked.cancelled) throw new CliError("Sign-in cancelled; nothing was saved.", { code: "LOGIN_CANCELLED", exitCode: EXIT.ERROR });
    plane = picked.index === 0 ? "github" : "model";
    write(ctx.stdout, `${LOGIN_NOTE}\n`);
  }

  const style = createStyle({ env: ctx.env, isTTY: Boolean(ctx.stdout?.isTTY) });
  // SIGINT during the hand-off aborts the provider command and ends in LOGIN_INTERRUPTED (exit 130,
  // nothing written) instead of Node's default termination.
  const controller = new AbortController();
  const proc = ctx.proc ?? process;
  const onSigint = () => controller.abort();
  const onParentAbort = () => controller.abort();
  proc.on("SIGINT", onSigint);
  if (ctx.signal?.aborted) controller.abort();
  else ctx.signal?.addEventListener("abort", onParentAbort, { once: true });
  try {
    if (plane === "github") {
      const host = resolveHost(ctx, hostFlag);
      const { probe } = await loginGithub({ ...providerSeams(ctx), host, signal: controller.signal });
      write(ctx.stdout, `${style.green("✓")} Signed in: GitHub (${sanitizeForTerminal(probe.account ?? "unknown account")}) on ${sanitizeForTerminal(probe.host)}\n`);
      if (probe.status === "warn") write(ctx.stdout, `  Note: ${sanitizeForTerminal(probe.reason)}\n`);
    } else {
      const { probe } = await loginClaude({ ...providerSeams(ctx), signal: controller.signal });
      write(ctx.stdout, `${style.green("✓")} Signed in: Claude Code${probe.account ? ` (${sanitizeForTerminal(probe.account)})` : ""}\n`);
    }
  } finally {
    proc.removeListener("SIGINT", onSigint);
    ctx.signal?.removeEventListener("abort", onParentAbort);
  }
  write(ctx.stdout, "Asterweave stored a reference only; no token is kept.\n");
  return EXIT.OK;
}

// ---------------------------------------------------------------------------------------------
// logout

async function logout(ctx, args) {
  const [plane, ...extra] = args;
  if (!plane) throw new UsageError("auth logout needs a plane: github or model.", { remediation: USAGE });
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${extra[0]}'.`, { remediation: USAGE });
  if (!PLANES.includes(plane)) throw new UsageError(`Cannot sign out of '${plane}'; use 'github' or 'model'.`, { remediation: USAGE });
  const hostFlag = stringOption(ctx, "host", USAGE);
  if (hostFlag !== undefined && plane === "model") throw new UsageError("--host applies to GitHub only.", { remediation: USAGE });

  // Reference removal only: logoutPlan never spawns anything.
  const result = logoutPlan(plane, { ...seams(ctx), host: hostFlag });
  if (ctx.options?.json === true) {
    write(ctx.stdout, `${JSON.stringify({ ok: true, plane: result.plane, droppedReference: result.droppedReference, providerCommand: result.providerCommand })}\n`);
    return EXIT.OK;
  }
  const label = plane === "github" ? "GitHub" : "Claude Code";
  write(
    ctx.stdout,
    [
      result.droppedReference
        ? "Removed Asterweave's stored reference (no provider sign-out performed)."
        : "No Asterweave reference was stored (no provider sign-out performed).",
      `To sign out of ${label} run: ${sanitizeForTerminal(result.providerCommand)}`,
      "",
    ].join("\n"),
  );
  return EXIT.OK;
}
