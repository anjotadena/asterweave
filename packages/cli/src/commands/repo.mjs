// `asterweave repo connect|status`. Registered by commands/index.mjs (`repoCommands` is the same
// registration data as a Map).

import path from "node:path";
import { CliError, EXIT, UsageError } from "../exit-codes.mjs";
import { connectRepository, isRepositoryName, listBranches, listRepositories, repoStatus, resolveCloneOrigin } from "../repo.mjs";
import { sanitizeForTerminal } from "../redact.mjs";
import { createStyle, frame, renderPicker, renderStrip } from "../tui/render.mjs";
import { pickOne, withTerminal } from "../tui/session.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { assertGithubComOnly, runtimeSeams, stringOption as sharedStringOption } from "./shared.mjs";

export const repoCommandMeta = Object.freeze({
  summary: "Connect a local clone (repo connect) or show the connection (repo status)",
  boolean: ["json"],
  options: ["json", "repo", "branch", "path"],
});

const USAGE = "Usage: asterweave repo connect [--repo owner/name] [--branch name] [--path dir] [--json] | asterweave repo status [--json]";

/** Handler for `asterweave repo ...`. */
export async function repoCommand(ctx) {
  const [sub, ...extra] = ctx.positionals ?? [];
  if (extra.length > 0) throw new UsageError(`Unexpected argument '${extra[0]}'.`, { remediation: USAGE });
  if (sub === "connect") return connect(ctx);
  if (sub === "status") return status(ctx);
  throw new UsageError(sub ? `Unknown repo subcommand '${sub}'.` : "Missing repo subcommand.", { remediation: USAGE });
}

/** Same registration data as a Map, for a table-driven wiring. */
export const repoCommands = new Map([["repo", { handler: repoCommand, ...repoCommandMeta }]]);

const stringOption = (ctx, name) => sharedStringOption(ctx, name, USAGE);

/** Options forwarded to repo.mjs (only what the caller provided, so defaults stay in one place). */
const repoOptions = runtimeSeams;

const write = (stream, text) => stream.write(text);

// ---------------------------------------------------------------------------------------------
// connect

async function connect(ctx) {
  const json = ctx.options?.json === true;
  const repoFlag = stringOption(ctx, "repo");
  const branchFlag = stringOption(ctx, "branch");
  const pathFlag = stringOption(ctx, "path");
  if (repoFlag !== undefined && !isRepositoryName(repoFlag)) throw new UsageError(`'${repoFlag}' is not in owner/name form.`, { remediation: "Example: --repo acme/widgets" });
  // Repository selection is github.com only in this build: fail before any probe, picker or spawn.
  assertGithubComOnly(ctx);

  const options = repoOptions(ctx);
  const clonePath = path.resolve(ctx.cwd ?? process.cwd(), pathFlag ?? ".");
  const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
  const interactive = !json && terminal.isInteractive;

  let repository = repoFlag;
  let branch = branchFlag;

  if (!interactive) {
    const missing = [!repository && "--repo owner/name", !branch && "--branch <name>"].filter(Boolean);
    if (missing.length > 0) {
      throw new UsageError(`repo connect needs ${missing.join(" and ")} when it is not run in an interactive terminal.`, {
        remediation: "Example: asterweave repo connect --repo acme/widgets --branch main [--path <clone>] [--json]",
      });
    }
  } else {
    const picked = await pickRepository(ctx, terminal, { repository, branch, clonePath, options });
    if (picked.interrupted) return EXIT.INTERRUPTED;
    if (picked.cancelled) {
      throw new CliError("Repository connection cancelled; nothing was saved.", { code: "REPO_CONNECT_CANCELLED", exitCode: EXIT.ERROR });
    }
    ({ repository, branch } = picked);
  }

  const result = await connectRepository({ repository, branch, path: clonePath, ...options });
  if (json) {
    write(ctx.stdout, `${JSON.stringify({ ok: true, repository: result.repository, branch: result.branch, path: result.path, runner: "local" })}\n`);
    return EXIT.OK;
  }
  const style = createStyle({ env: ctx.env, isTTY: Boolean(ctx.stdout?.isTTY) });
  const lines = [
    `${style.green("✓")} Local runner connected.`,
    "",
    `  Repository  ${sanitizeForTerminal(result.repository)}`,
    `  Branch      ${sanitizeForTerminal(result.branch)}`,
    `  Path        ${sanitizeForTerminal(result.path)}`,
  ];
  write(ctx.stdout, `${lines.join("\n")}\n`);
  return EXIT.OK;
}

/**
 * Interactive repository/branch pickers (shared by `repo connect` and the launch flow). Fills in
 * whichever of `repository` / `branch` is missing, enters the terminal for the pickers and always
 * restores it. Does not persist anything; the caller connects the result.
 *
 * @param {object} ctx  Handler context (stdin, stdout, env, version, optional proc).
 * @param {ReturnType<typeof createTerminal>} terminal
 * @param {{repository?: string, branch?: string, clonePath: string, options: object}} input
 *   `options` are the repo.mjs options (env, spawn, exists, ...).
 * @returns {Promise<{done: false, repository: string, branch: string, fromOrigin: boolean} | {done: true, cancelled?: true, interrupted?: true}>}
 *   When `repository` is not given, the clone's `origin` (a GitHub remote) decides it and the repository
 *   picker (`gh repo list`) is skipped; the list is only the fallback for a clone with no usable origin.
 */
export async function pickRepository(ctx, terminal, { repository, branch, clonePath, options }) {
  // The clone's own origin decides the repository whenever it names a GitHub repository: `gh repo list`
  // only lists repositories owned by the signed-in user (not organisation or collaborator repos), so a
  // list can never be the authority on which repository this clone is. The list is the fallback for a
  // clone with no usable origin (and an explicit --repo is never second-guessed here).
  let fromOrigin = false;
  if (!repository) {
    const found = await resolveCloneOrigin(clonePath, options);
    if (found?.origin.github) {
      repository = found.origin.github.nameWithOwner;
      fromOrigin = true;
    }
  }
  const repositories = repository ? [] : await listRepositories(options);
  if (!repository && repositories.length === 0) {
    throw new CliError("No repositories were returned by `gh repo list`.", { code: "REPO_NONE_FOUND", exitCode: EXIT.ERROR, remediation: "Pass --repo owner/name instead." });
  }
  return withSession(ctx, terminal, async (session) => {
    let defaultBranch = null;
    if (!repository) {
      const choice = await session.pick({
        title: "Select a repository",
        items: repositories.map((item) => ({ label: item.nameWithOwner, hint: item.defaultBranch ? `default: ${item.defaultBranch}` : "" })),
      });
      if (choice.done) return choice;
      repository = repositories[choice.index].nameWithOwner;
      defaultBranch = repositories[choice.index].defaultBranch;
    }
    if (!branch) {
      const branches = await listBranches(clonePath, { ...options, defaultBranch });
      if (branches.length === 0) throw new CliError(`No branches were found in ${clonePath}.`, { code: "REPO_BRANCH_NOT_FOUND", exitCode: EXIT.ERROR, remediation: "Pass an existing clone with --path." });
      const choice = await session.pick({
        title: `Select a branch for ${repository}`,
        note: fromOrigin ? `Repository: ${repository} (from origin)` : undefined,
        items: branches.map((name) => ({ label: name, hint: name === defaultBranch ? "default" : "" })),
      });
      if (choice.done) return choice;
      branch = branches[choice.index];
    }
    return { done: false, repository, branch, fromOrigin };
  });
}

/**
 * Terminal lifecycle for the repository/branch pickers: the shared `withTerminal` (restores the
 * terminal on every exit path and aborts on SIGINT) plus the shared `pickOne`. `fn` receives
 * `{pick}`; `pick` resolves `{index}` or `{done: true, cancelled?: true, interrupted?: true}`, and
 * after an interrupt every further `pick` resolves interrupted at once without drawing.
 */
function withSession(ctx, terminal, fn) {
  const style = createStyle({ env: ctx.env, isTTY: true });
  return withTerminal({ terminal, stdin: ctx.stdin, proc: ctx.proc ?? process }, ({ input, signal }) => {
    const pick = ({ title, items, note, selected = 0 }) =>
      pickOne({
        terminal, input, signal, count: items.length, selected,
        render: (index) => renderPickerFrame({ title, note, items, index, width: terminal.columns, rows: terminal.rows, version: ctx.version, style }),
      });
    return fn({ pick });
  });
}

function renderPickerFrame({ title, note, items, index, width, rows, version, style }) {
  const visible = Math.max(3, rows - 8 - (note ? 2 : 0));
  let start = 0;
  if (items.length > visible) start = Math.min(Math.max(index - Math.floor(visible / 2), 0), items.length - visible);
  const window = items.slice(start, start + visible);
  const heading = items.length > visible ? `${title} (${index + 1}/${items.length})` : title;
  return frame({
    header: `Asterweave v${version ?? "?"}   Connect a repository`,
    body: [...(note ? [note, ""] : []), renderPicker({ title: heading, items: window, selected: index - start, width, style })],
    footer: renderStrip({ items: [{ key: "Up/Down", label: "move" }, { key: "Enter", label: "confirm" }, { key: "Esc", label: "cancel" }], width, style }),
    width,
  });
}

// ---------------------------------------------------------------------------------------------
// status

async function status(ctx) {
  for (const flag of ["repo", "branch", "path"]) {
    if (ctx.options?.[flag] !== undefined) throw new UsageError(`--${flag} is not accepted by repo status; it only applies to repo connect.`, { remediation: USAGE });
  }
  const json = ctx.options?.json === true;
  const result = await repoStatus(repoOptions(ctx));
  if (result.warning && !json) write(ctx.stderr, `Warning: ${sanitizeForTerminal(result.warning)}
`);
  if (json) {
    write(ctx.stdout, `${JSON.stringify(result)}\n`);
    return result.ok ? EXIT.OK : EXIT.ERROR;
  }
  if (!result.connected) {
    write(ctx.stdout, "No repository connected.\nRun: asterweave repo connect --repo owner/name --branch main\n");
    return EXIT.OK;
  }
  const safe = (text) => sanitizeForTerminal(text);
  const lines = [
    `  Repository  ${safe(result.repository)}`,
    `  Branch      ${safe(result.branch)}${result.currentBranch && result.currentBranch !== result.branch ? ` (checked out: ${safe(result.currentBranch)})` : ""}`,
    `  Path        ${safe(result.path)}`,
    `  Runner      ${safe(result.runner)}`,
  ];
  if (result.ok) {
    // The work tree is never inspected (that would run repository-configured filter drivers), so its
    // state is always "unknown"; the branch above and the trust line are what is known.
    lines.push(
      "  Work tree   unknown",
      `  Trust       ${result.trust.trusted ? "trusted" : `untrusted (${safe(result.trust.reason)})`}`,
    );
    if (result.trust.warning) write(ctx.stderr, `Warning: ${safe(result.trust.warning)}
`);
  }
  write(ctx.stdout, `${lines.join("\n")}\n`);
  if (!result.ok) {
    const what = result.problem === "REPO_PATH_MISSING" ? "no longer exists" : "is no longer a git work tree";
    write(ctx.stderr, `Asterweave repo error: the connected path ${safe(result.path)} ${what}.\nRun \`asterweave repo connect\` with the new --path.\n`);
    return EXIT.ERROR;
  }
  return EXIT.OK;
}
