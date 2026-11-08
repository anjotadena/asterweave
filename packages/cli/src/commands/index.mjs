// Registers every Phase A command on a registry Map (the shape used by cli.mjs).
//
// Launch contract (implemented by commands/launch.mjs, owned by the session work):
//   export async function launchCommand(ctx): Promise<number | void>
// `ctx` is the normal CommandContext (stdin, stdout, stderr, env, cwd, spawn, version, options,
// positionals, ...) plus `registry` and `usage`. It is reached through the "launch" command, which
// is also what a bare `asterweave` runs. This module guards the TTY requirement itself (exit 2) and
// loads launch.mjs lazily. FALLBACK: if launch.mjs does not exist (or does not export
// `launchCommand`) in an interactive terminal, the usage text is printed and the exit code is 0.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXIT, UsageError } from "../exit-codes.mjs";
import { createTerminal } from "../tui/terminal.mjs";
import { authCommand, authCommandMeta } from "./auth.mjs";
import { configCommand, configCommandMeta } from "./config.mjs";
import { contextCommand, contextCommandMeta } from "./context.mjs";
import { doctorCommand, doctorCommandMeta } from "./doctor.mjs";
import { COMMAND_HELP, helpCommand, helpCommandMeta } from "./help.mjs";
import { hookCommand, hookCommandMeta } from "./hook.mjs";
import { pipelineCommand, pipelineCommandMeta } from "./pipeline.mjs";
import { repoCommand, repoCommandMeta } from "./repo.mjs";
import { mcpCommand, mcpCommandMeta } from "./mcp.mjs";
import { modelCommand, modelCommandMeta } from "./model.mjs";
import { runCommand, runCommandMeta } from "./run.mjs";
import { sessionCommand, sessionCommandMeta } from "./session.mjs";
import { trustCommand, trustCommandMeta } from "./trust.mjs";
import { usageCommand, usageCommandMeta } from "./usage.mjs";

/** Load commands/launch.mjs lazily; `null` when the module is not present in this build. */
export async function defaultLoadLaunch() {
  const url = new URL("./launch.mjs", import.meta.url);
  if (!existsSync(fileURLToPath(url))) return null;
  return import(url.href);
}

/**
 * Handler for `launch` (and the bare `asterweave`).
 * @param {{loadLaunch?: () => Promise<{launchCommand?: Function} | null>}} [options]  Loader seam (tests).
 */
export function createLaunchCommand({ loadLaunch = defaultLoadLaunch } = {}) {
  return async function launch(ctx) {
    const terminal = createTerminal({ stdin: ctx.stdin, stdout: ctx.stdout, env: ctx.env });
    if (!terminal.isInteractive) {
      throw new UsageError("interactive mode requires a TTY; use --json or a TTY terminal", {
        remediation: "Run asterweave in a terminal, or use a subcommand such as `asterweave doctor --json`.",
      });
    }
    const module = await loadLaunch();
    if (typeof module?.launchCommand !== "function") {
      ctx.stdout.write(ctx.usage ?? "");
      return EXIT.OK;
    }
    return module.launchCommand(ctx);
  };
}

export const launchCommandMeta = Object.freeze({ summary: "Start the interactive session (also what plain `asterweave` does)", boolean: ["json"], options: ["json"] });

/**
 * Register help, launch, doctor, repo, auth, config, trust, run and the hidden hook command on `registry`.
 * @param {Map<string, object>} registry
 * @param {{loadLaunch?: () => Promise<object | null>}} [options]
 * @returns {Map<string, object>} the same registry
 */
export function registerAllCommands(registry, { loadLaunch } = {}) {
  const add = (name, handler, meta) => registry.set(name, { handler, summary: meta.summary ?? "", boolean: [...(meta.boolean ?? [])], options: meta.options ? [...meta.options] : undefined, hidden: meta.hidden === true, helpText: COMMAND_HELP[name] });
  add("help", helpCommand, helpCommandMeta);
  add("launch", createLaunchCommand({ loadLaunch }), launchCommandMeta);
  add("doctor", doctorCommand, doctorCommandMeta);
  add("repo", repoCommand, repoCommandMeta);
  add("auth", authCommand, authCommandMeta);
  add("config", configCommand, configCommandMeta);
  add("trust", trustCommand, trustCommandMeta);
  add("run", runCommand, runCommandMeta);
  add("session", sessionCommand, sessionCommandMeta);
  add("pipeline", pipelineCommand, pipelineCommandMeta);
  add("context", contextCommand, contextCommandMeta);
  add("usage", usageCommand, usageCommandMeta);
  add("model", modelCommand, modelCommandMeta);
  add("mcp", mcpCommand, mcpCommandMeta);
  add("hook", hookCommand, hookCommandMeta);
  return registry;
}
