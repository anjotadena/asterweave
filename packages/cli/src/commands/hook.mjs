// `asterweave hook pre-tool-use` -- hidden, experimental. An ADDITIONAL PreToolUse guard hook that can run next to the
// Claude Code plugin's own guard hook; it does not replace it.
//
// Reads the Claude Code hook payload (JSON) on stdin, evaluates it with the runtime guard in SUPERVISED mode
// and answers with the plugin's output shape:
//   {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"|"ask","permissionDecisionReason":"..."}}
//
// Exit code is ALWAYS 0 once the command is recognised: Claude Code treats exit 2 as "block" and any other
// non-zero exit as a non-blocking error (the tool would run), so every failure -- malformed JSON, a non-string
// command, an oversized payload or command, a workspace that cannot be determined, a guard that cannot decide,
// an unexpected exception -- is answered with a `deny` document instead. Only usage errors (unknown flag,
// unknown subcommand) exit 2, which also blocks.
//
// Decision mapping: allow -> NO output (the normal permission flow continues, exactly like the plugin hook; this
// command never emits an "allow" document, because Claude Code treats a hook "allow" as a permission grant that
// skips the user's own prompt); require-approval -> ask; deny / unavailable / anything else -> deny.
//
// Workspace boundary. The boundary is NOT taken from the payload: `payload.cwd` is only the directory the command
// runs in (a model that `cd`s to the home directory must not widen the boundary). The root is, in order:
//   1. $CLAUDE_PROJECT_DIR when set (it must be absolute and exist; its realpath is used; it must be neither a filesystem
//      root nor the home directory nor one of its ancestors);
//   2. otherwise the git top level of the payload cwd (hardened git, see runGitSync), accepted only if
//      worktreeRootProblem (runtime/repo-root.mjs) finds it consistent with the repository itself (a hostile
//      `core.worktree` fails this) and it is neither a filesystem root nor the home directory nor one of its ancestors.
// If no root can be determined the answer is deny.
//
// Shell syntax follows the tool, not the host: the Bash tool is classified as POSIX shell even on Windows (Git Bash
// de-escapes backslashes), the PowerShell tool as PowerShell, any other tool name as both.

import * as nodeFs from "node:fs";
import { homedir as osHomedir } from "node:os";
import path from "node:path";
import { EXIT, UsageError } from "../exit-codes.mjs";
import { stringifyJson } from "../json.mjs";
import { evaluate } from "../runtime/guard.mjs";
import { loadPolicy } from "../runtime/policy.mjs";
import { worktreeRootProblem } from "../runtime/repo-root.mjs";
import { MAX_COMMAND_CHARS, runGitSync } from "../runtime/shell-classify.mjs";

export const hookCommandMeta = Object.freeze({
  summary: "Internal hook entry points used by Claude Code",
  boolean: [],
  options: [],
  hidden: true,
});

const MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Wall-clock budget of one classification inside the hook (the guard answers `unavailable`, i.e. deny, when exceeded). */
const DEFAULT_BUDGET_MS = 2000;
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

function document(permissionDecision, reason) {
  return `${stringifyJson({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason } })}\n`;
}

const deny = (reason) => document("deny", `Asterweave blocked this command: ${reason}. Preserve user data and choose a reversible alternative.`);

async function readPayload(stdin) {
  if (stdin?.isTTY === true) return { error: "no hook payload was provided on stdin" };
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buffer.length;
    if (size > MAX_PAYLOAD_BYTES) return { error: "the hook payload is larger than 1 MiB" };
    chunks.push(buffer);
  }
  return { text: Buffer.concat(chunks).toString("utf8") };
}

function dialectFor(toolName) {
  const name = toolName.toLowerCase();
  if (name === "bash") return "posix";
  if (name === "powershell") return "powershell";
  return ["posix", "powershell"];
}

/** Build the guard action for a hook payload, or an error string. */
function actionFor(payload) {
  const input = payload.tool_input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { error: "the hook payload has no tool_input object" };
  const toolName = typeof payload.tool_name === "string" ? payload.tool_name : "";
  if (WRITE_TOOLS.has(toolName.toLowerCase())) {
    const file = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof file !== "string" || file === "") return { error: "the file path is missing or not a string" };
    // A tool path is classified AS A PATH by the guard (no variable expansion; Windows stream / 8.3 / trailing dot forms normalized).
    return { action: { type: "tool", tool: { name: "write", input: { path: file } } }, dialect: "posix" };
  }
  const command = input.command ?? input.script;
  if (typeof command !== "string") return { error: "the command is missing or not a string" };
  if (command.length > MAX_COMMAND_CHARS) return { error: `the command is longer than ${MAX_COMMAND_CHARS} characters, which the guard refuses to read` };
  return { action: { type: "tool", tool: { name: "shell", input: { command } } }, dialect: dialectFor(toolName) };
}

function realpathOf(value) {
  return (nodeFs.realpathSync.native ?? nodeFs.realpathSync)(value);
}

const foldFor = (platform) => (platform === "win32" ? (value) => value.toLowerCase() : (value) => value);

/** True when `target` is `root` or below it (path semantics of `platform`). */
function isInside(root, target, platform) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = foldFor(platform);
  const relative = p.relative(fold(root), fold(target));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${p.sep}`) && !p.isAbsolute(relative));
}

/**
 * Determine the workspace root and the (real) working directory. See the file comment for the rules.
 * @returns {{root: string, cwd: string} | {error: string}}
 */
export function resolveWorkspace({ payloadCwd, processCwd, env = process.env, platform = process.platform, homedir = osHomedir } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const candidate = typeof payloadCwd === "string" && p.isAbsolute(payloadCwd) ? payloadCwd : processCwd;
  if (typeof candidate !== "string" || !p.isAbsolute(candidate)) return { error: "the working directory of the command is missing or not absolute" };
  // Decide by TEXT before touching the file system: a UNC / device working directory would make this very hook contact the network.
  const projectText = env.CLAUDE_PROJECT_DIR;
  if (platform === "win32" && /^[\\/]{2}/.test(candidate)) {
    const fold = (value) => value.toLowerCase();
    if (typeof projectText !== "string" || !p.isAbsolute(projectText) || !isInside(fold(p.resolve(projectText)), fold(p.resolve(candidate)), platform)) {
      return { error: "the working directory is a network or device path outside CLAUDE_PROJECT_DIR; the guard does not touch it" };
    }
  }
  let cwd;
  try {
    cwd = realpathOf(candidate);
  } catch {
    return { error: "the working directory of the command does not exist" };
  }
  let home = null;
  try {
    home = realpathOf(homedir());
  } catch {
    home = null;
  }
  const tooBroad = (root) => p.parse(root).root === root || (home !== null && isInside(root, home, platform));

  const project = env.CLAUDE_PROJECT_DIR;
  if (typeof project === "string" && project !== "") {
    if (!p.isAbsolute(project)) return { error: "CLAUDE_PROJECT_DIR is not an absolute path" };
    let root;
    try {
      root = realpathOf(project);
    } catch {
      return { error: "CLAUDE_PROJECT_DIR does not exist" };
    }
    if (tooBroad(root)) return { error: "CLAUDE_PROJECT_DIR is a filesystem root, the home directory or one of its ancestors, which is too broad to be a workspace" };
    return { root, cwd };
  }

  let top;
  try {
    top = realpathOf(runGitSync(["rev-parse", "--show-toplevel"], cwd, { env, platform }));
  } catch {
    return { error: "the workspace root cannot be determined: the working directory is not inside a git repository and CLAUDE_PROJECT_DIR is not set" };
  }
  if (!isInside(top, cwd, platform)) return { error: "the git top level does not contain the working directory (a hostile core.worktree?)" };
  if (tooBroad(top)) return { error: "the git top level is a filesystem root, the home directory or one of its ancestors, which is too broad to be a workspace" };
  let commonDir;
  try {
    commonDir = realpathOf(p.resolve(cwd, runGitSync(["rev-parse", "--git-common-dir"], cwd, { env, platform })));
  } catch {
    return { error: "the git directory of the working directory cannot be determined" };
  }
  const problem = worktreeRootProblem({ cwd, toplevel: top, commonDir, platform });
  if (problem !== null) return { error: `the git top level is not trustworthy (${problem})` };
  return { root: top, cwd };
}

async function preToolUse(ctx) {
  const raw = await readPayload(ctx.stdin);
  if (raw.error) return deny(raw.error);
  let payload;
  try {
    payload = JSON.parse(raw.text);
  } catch {
    return deny("the hook payload is not valid JSON");
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return deny("the hook payload is not a JSON object");
  const built = actionFor(payload);
  if (built.error) return deny(built.error);
  const workspace = resolveWorkspace({
    payloadCwd: payload.cwd,
    processCwd: ctx.cwd ?? process.cwd(),
    env: ctx.env ?? process.env,
    platform: ctx.platform,
    homedir: ctx.homedir,
  });
  if (workspace.error) return deny(workspace.error);
  const guardContext = { workspaceRoot: workspace.root, cwd: workspace.cwd, mode: "supervised", env: ctx.env, dialect: built.dialect, budgetMs: ctx.budgetMs ?? DEFAULT_BUDGET_MS };
  for (const key of ["platform", "homedir", "branchOf", "realpath", "readdir", "lstat", "readlink"]) if (ctx[key] !== undefined) guardContext[key] = ctx[key];
  // The user's own allowCommands (policy.json only). An unreadable or invalid policy file simply grants nothing.
  try {
    const { policy } = loadPolicy({ env: ctx.env ?? process.env, platform: ctx.platform, homedir: ctx.homedir });
    if (Array.isArray(policy.allowCommands)) guardContext.allowCommands = policy.allowCommands;
  } catch {
    // supervised defaults: nothing extra is understood
  }
  const decision = evaluate(built.action, guardContext);
  const message = decision.detail?.message || decision.reason;
  if (decision.decision === "allow") return "";
  if (decision.decision === "require-approval") {
    const advice = decision.reason === "DEFAULT_BRANCH_PUSH" ? "Asterweave lands work through /asterweave:submit-pr and CI; approve only if you asked for a direct push." : "Approve only if you asked for this.";
    return document("ask", `Asterweave: ${message}. ${advice}`);
  }
  return deny(message);
}

/** Handler for `asterweave hook <name>`. */
export async function hookCommand(ctx) {
  const [name, ...extra] = ctx.positionals ?? [];
  if (name !== "pre-tool-use" || extra.length > 0) {
    throw new UsageError(name === undefined ? "Missing hook name." : `Unknown hook '${String(name).slice(0, 40)}'.`, { remediation: "Usage: asterweave hook pre-tool-use < payload.json" });
  }
  let output;
  try {
    output = await preToolUse(ctx);
  } catch (error) {
    output = deny(`the guard failed (${error instanceof Error ? error.message : "unexpected error"})`);
  }
  if (output) ctx.stdout.write(output);
  return EXIT.OK;
}
