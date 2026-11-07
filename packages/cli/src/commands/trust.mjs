// `asterweave trust [status|grant|revoke] [--path dir] [--json]`.
//
// Trust is bound to a content hash of the files that can make code run (see trust.mjs). Granting is
// always an explicit act: in a non-interactive context (or with --json) it needs an explicit --path,
// so a script can never trust the current directory by accident; in a terminal without --path it
// asks a y/N question (default No) naming the path. The grant is bound to the hash that was
// previewed: if the files change in between, nothing is granted. Findings list counts and file
// names, never the text of any command.

import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { classifyExecutableConfig, grantTrust, revokeTrust, safeTrustStatus, trustStatus } from "../trust.mjs";
import { askYesNo, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { defaultRepoPath, isInteractive, seams, stringOption } from "./shared.mjs";

export const trustCommandMeta = Object.freeze({ summary: "Review, grant or revoke trust for a repository's executable config", boolean: ["json"], options: ["json", "path"] });

const USAGE = "Usage: asterweave trust [status|grant|revoke] [--path dir] [--json]";
const KIND_LABEL = { command: "quality-gate command(s)", settings: "Claude Code settings file(s)", mcp: "MCP server config" };
const write = (stream, text) => stream.write(text);

/** Handler for `asterweave trust ...`. */
export async function trustCommand(ctx) {
  const [sub = "status", ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${extra[0]}'.`, { remediation: USAGE });
  if (!["status", "grant", "revoke"].includes(sub)) throw new UsageError(`Unknown trust subcommand '${sub}'.`, { remediation: USAGE });
  const pathFlag = stringOption(ctx, "path", USAGE);
  const json = ctx.options?.json === true;
  if (sub === "grant" && pathFlag === undefined && (json || !isInteractive(ctx))) {
    throw new UsageError("trust grant needs an explicit --path when it is not run in an interactive terminal (or with --json).", {
      remediation: 'Example: asterweave trust grant --path "/path/to/repo"',
    });
  }
  const target = pathFlag === undefined ? defaultRepoPath(ctx).path : path.resolve(ctx.cwd ?? process.cwd(), pathFlag);
  const options = seams(ctx, ["now"]);

  // The status computation validates the path (CliError when missing) before anything else touches it.
  // `status` is a trust decision and fails (exit 1) on a corrupt trust.json; grant and revoke are the
  // explicit acts that recreate it, so their preview must not throw on it. The hash is still computed
  // from the repository files, so `expectedHash` binding is unchanged.
  const before = sub === "status" ? trustStatus(target, options) : safeTrustStatus(target, options);
  const findings = classifyExecutableConfig(before.realpath, { fs: options.fs });

  if (sub === "status") {
    if (json) write(ctx.stdout, `${JSON.stringify({ ok: true, ...statusBody(before), executable: findings })}\n`);
    else write(ctx.stdout, sanitizeForTerminal(formatStatus(before, findings)));
    return EXIT.OK;
  }

  if (sub === "grant") {
    if (!json) write(ctx.stdout, sanitizeForTerminal(formatGrantPreview(before, findings)));
    if (pathFlag === undefined) {
      // Interactive grant of the default repository: the user must say yes, naming the path.
      const answer = await confirmGrant(ctx, before.realpath, findings);
      if (answer.interrupted) return EXIT.INTERRUPTED;
      if (!answer.yes) throw new CliError("Trust was not granted.", { code: "TRUST_DECLINED", exitCode: EXIT.ERROR, remediation: "Nothing was changed." });
    }
    // Bound to the previewed hash: grantTrust re-hashes and refuses when the files changed since.
    const granted = grantTrust(target, { ...options, expectedHash: before.hash });
    if (json) {
      write(ctx.stdout, `${JSON.stringify({ ok: true, trusted: true, path: granted.realpath, hash: granted.hash, trustedAt: granted.trustedAt, executable: findings })}\n`);
    } else {
      write(ctx.stdout, sanitizeForTerminal(`Trusted ${granted.realpath}\nhash ${granted.hash}\n`));
    }
    return EXIT.OK;
  }

  const revoked = revokeTrust(target, options);
  if (json) {
    write(ctx.stdout, `${JSON.stringify({ ok: true, trusted: false, path: revoked.realpath, hash: revoked.hash, removed: revoked.removed, recreated: revoked.recreated })}\n`);
  } else if (revoked.recreated) {
    write(ctx.stdout, sanitizeForTerminal(`The trust store was unreadable and has been recreated empty; ${revoked.realpath} is not trusted.\n`));
  } else {
    write(ctx.stdout, sanitizeForTerminal(revoked.removed ? `Trust revoked for ${revoked.realpath}\n` : `${revoked.realpath} was not trusted; nothing to revoke.\n`));
  }
  return EXIT.OK;
}

/** One-line counts of executable config (never command text). */
function summarizeFindings(findings) {
  const parts = ["command", "settings", "mcp"].map((kind) => [findings.filter((item) => item.kind === kind).length, KIND_LABEL[kind]]).filter(([count]) => count > 0);
  return parts.length > 0 ? parts.map(([count, label]) => `${count} ${label}`).join(", ") : "no executable config";
}

async function confirmGrant(ctx, realpath, findings) {
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const question = sanitizeForTerminal(`Trust ${realpath} (${summarizeFindings(findings)})? [y/N] `);
  const answer = await withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process, enter: { altScreen: false, hideCursor: false } }, ({ input, signal }) => {
    terminal.write(question);
    return askYesNo({ input, signal });
  });
  terminal.write("\n");
  return answer;
}

function statusBody(status) {
  return { trusted: status.trusted, reason: status.reason, path: status.realpath, hash: status.hash, trustedAt: status.trustedAt, files: status.files };
}

/** Findings grouped by kind: counts and file names only. */
export function formatFindings(findings) {
  if (findings.length === 0) return ["No executable repository config found (no quality-gate commands, Claude Code settings or MCP servers)."];
  const lines = ["Executable repository config found:"];
  for (const kind of ["command", "settings", "mcp"]) {
    const items = findings.filter((item) => item.kind === kind);
    if (items.length === 0) continue;
    const files = [...new Set(items.map((item) => item.file))];
    lines.push(`  ${String(items.length).padStart(2)}  ${KIND_LABEL[kind]}  in ${files.join(", ")}`);
  }
  return lines;
}

function trustLabel(status) {
  if (status.trusted) return `trusted${status.trustedAt ? ` since ${status.trustedAt}` : ""}`;
  return status.reason === "CHANGED" ? "untrusted (trust-governing files changed since trust was granted)" : "untrusted (trust has not been granted)";
}

function formatStatus(status, findings) {
  const lines = [`Repository  ${status.realpath}`, `Trust       ${trustLabel(status)}`, `Hash        ${status.hash}`, "", ...formatFindings(findings)];
  if (!status.trusted && findings.length > 0) lines.push("", `Review these files, then run: asterweave trust grant --path "${status.realpath}"`);
  return `${lines.join("\n")}\n`;
}

function formatGrantPreview(status, findings) {
  const present = status.files.filter((file) => file.state !== "missing").map((file) => file.file);
  return `${[
    `Repository  ${status.realpath}`,
    "",
    ...formatFindings(findings),
    "",
    ...(status.reason === "STORE_UNREADABLE" ? ["Note: the trust store (trust.json) is unreadable; granting replaces it with a fresh store.", ""] : []),
    "Granting trust allows Asterweave to run the repository's quality-gate commands and Claude Code to load",
    `its settings, hooks and MCP servers. Trust covers the current contents of: ${present.length > 0 ? present.join(", ") : "(none of the governing files exist yet)"}.`,
    "Any change to those files makes the repository untrusted again.",
    "",
  ].join("\n")}\n`;
}
