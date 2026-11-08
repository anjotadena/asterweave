// Shared helpers for the plugin tests (not a test file). Every world uses temp HOME / USERPROFILE / APPDATA / config dirs: nothing
// touches the real ~/.claude or %APPDATA%\asterweave. The fake mutation envelope applies `claude plugin ...` to fixture files the way
// the (UNVERIFIED) real tool is assumed to, so the plugin-specific snapshot/verify pair is exercised end to end without any claude.

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../src/cli.mjs";
import { CliError } from "../src/exit-codes.mjs";
import { buildPluginArgs, parseAdminArgs, toClaudeScope } from "../src/runtime/claude/admin.mjs";
import { pluginCommand, pluginCommandMeta } from "../src/commands/plugin.mjs";
import { grantTrust, safeTrustStatus } from "../src/trust.mjs";
import { fakeTerminal, waitFor } from "./repo-fixture.mjs";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));

const temps = [];
export const tempDir = (prefix) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
export const cleanup = () => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); };

export const sink = () => { const chunks = []; return { write: (t) => { chunks.push(String(t)); return true; }, text: () => chunks.join("") }; };
export const NO_SPAWN = () => { throw new Error("spawn must not be called"); };

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
const writeJson = (file, value) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, JSON.stringify(value, null, 2)); };

/**
 * Fake of the Track A envelope: toClaudeScope + applyMutation, with a fake admin runner that records argv and edits the fixture files.
 * `mode`: normal | noop | extra-settings | add-marketplace | other-plugin | untrusted-extra-mcp
 */
export function fakeMutation(world, { mode = "normal" } = {}) {
  const runs = [];
  const applied = [];
  const fakeAdmin = (args, scope) => {
    runs.push(args);
    // the REAL allow-list validates the argv (throws AdminError for local scope, a missing -s, unknown flags, ...)
    const parsed = parseAdminArgs(args, scope);
    const { action, claudeScope } = parsed;
    const id = parsed.positionals[0];
    const settingsFile = claudeScope === "user" ? join(world.home, ".claude", "settings.json") : join(world.repo, ".claude", "settings.json");
    const installedFile = join(world.home, ".claude", "plugins", "installed_plugins.json");
    const installed = readJson(installedFile, { version: 2, plugins: {} });
    const settings = readJson(settingsFile, {});
    settings.enabledPlugins ??= {};
    if (mode === "noop") return;
    if (action === "install") {
      installed.plugins[id] = [...(installed.plugins[id] ?? []).filter((r) => r.scope !== claudeScope), { scope: claudeScope, installPath: join(world.home, ".claude", "plugins", "cache", id), version: "1.0.0", ...(claudeScope === "project" ? { projectPath: world.repo } : {}) }];
      settings.enabledPlugins[id] = true;
    } else if (action === "uninstall") {
      installed.plugins[id] = (installed.plugins[id] ?? []).filter((r) => r.scope !== claudeScope);
      if (installed.plugins[id].length === 0) delete installed.plugins[id];
      delete settings.enabledPlugins[id];
    } else if (action === "enable") settings.enabledPlugins[id] = true;
    else if (action === "disable") settings.enabledPlugins[id] = false;
    if (mode === "extra-settings") settings.env = { INJECTED: "1" };
    if (mode === "other-plugin") { installed.plugins["evil@market"] = [{ scope: claudeScope, installPath: "/x", version: "9" }]; settings.enabledPlugins["evil@market"] = true; }
    if (mode === "add-marketplace") writeJson(join(world.home, ".claude", "plugins", "known_marketplaces.json"), { ...readJson(join(world.home, ".claude", "plugins", "known_marketplaces.json"), {}), evil: { source: { source: "github", repo: "x/y" } } });
    if (mode === "untrusted-extra-mcp" && claudeScope === "project") writeJson(join(world.repo, ".mcp.json"), { mcpServers: { x: { command: "node" } } });
    writeJson(installedFile, installed);
    writeJson(settingsFile, settings);
    // keys the sanitizing reader drops: the raw bytes (and so the trust hash) still change
    if (mode === "proto-key" || mode === "constructor-key") {
      const injected = mode === "proto-key" ? '"__proto__":{"hooks":{"x":1}}' : '"constructor":{"prototype":{"y":1}}';
      writeFileSync(settingsFile, readFileSync(settingsFile, "utf8").replace("{", `{${injected},`));
    }
  };
  return {
    runs, applied, fakeAdmin,
    toClaudeScope, buildPluginArgs,
    async applyMutation(request) {
      applied.push(request);
      const before = request.snapshot();
      fakeAdmin(request.args, request.scope);
      const after = request.snapshot();
      const verdict = request.verify(before, after);
      if (!verdict.ok) throw new CliError(`UNEXPECTED_CHANGE: ${verdict.problems.join("; ")}`, { code: "UNEXPECTED_CHANGE", exitCode: 1, remediation: "Review with git diff." });
      return { ok: true, command: ["claude", ...request.args], verified: true, trust: { state: request.scope === "repo" ? "untrusted" : "not applicable", remediation: request.scope === "repo" ? "asterweave trust grant" : undefined }, exitCode: request.scope === "repo" ? 4 : 0 };
    },
  };
}

/** A fresh isolated world; `run(argv, {env, mutation})` goes through runCli with a registry that injects the fake envelope. */
export function world({ mode, marketplaces = { market: { source: { source: "github", repo: "a/b" } } } } = {}) {
  const repo = tempDir("aw-plug-repo-");
  const home = tempDir("aw-plug-home-");
  const userDir = tempDir("aw-plug-user-");
  const appdata = tempDir("aw-plug-appdata-");
  if (marketplaces) writeJson(join(home, ".claude", "plugins", "known_marketplaces.json"), marketplaces);
  const mutation = fakeMutation({ home, repo }, { mode });
  const env = { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, APPDATA: appdata, ASTERWEAVE_CONFIG_DIR: userDir };
  const registryFor = (injected) => new Map([["plugin", { handler: (ctx) => pluginCommand({ ...ctx, ...(injected ? { mutation: injected } : {}) }), summary: pluginCommandMeta.summary, boolean: [...pluginCommandMeta.boolean], options: [...pluginCommandMeta.options], hidden: false }]]);
  const run = async (argv, { env: extraEnv, inject = true, io } = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["plugin", ...argv], { stdout: out, stderr: err, stdin: { isTTY: false }, env: { ...env, ...extraEnv }, cwd: repo, homedir: () => home, spawn: NO_SPAWN, ...io }, { commands: registryFor(inject ? mutation : null) });
    return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  const file = (...parts) => join(home, ".claude", ...parts);
  return { repo, home, userDir, env, mutation, run, writeJson, readJson, file, repoFile: (...parts) => join(repo, ...parts) };
}

/**
 * A world that runs the REAL admin runner and mutation envelope against the scripted fake claude (admin mode). `behavior` is the fake's
 * (ok | fail | hang | edit-settings | edit-asterweave | ...). `calls()` is the argv log of every claude call.
 */
export function realWorld(behavior = "ok", { marketplaces = { market: {}, other: {} } } = {}) {
  const repo = tempDir("aw-penv-repo-");
  const home = tempDir("aw-penv-home-");
  const userDir = tempDir("aw-penv-user-");
  const appdata = tempDir("aw-penv-appdata-");
  const scratch = tempDir("aw-penv-sc-");
  const scenarioFile = join(scratch, "scenario.json");
  const recordLog = join(scratch, "log.jsonl");
  writeFileSync(scenarioFile, JSON.stringify({ recordLog, admin: { behavior, userSettings: join(home, ".claude", "settings.json"), installedPlugins: join(home, ".claude", "plugins", "installed_plugins.json"), userFile: join(home, ".claude.json") } }));
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true });
  writeFileSync(join(home, ".claude", "plugins", "known_marketplaces.json"), JSON.stringify(marketplaces));
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: [] } }));
  const env = { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, APPDATA: appdata, ASTERWEAVE_CONFIG_DIR: userDir };
  const claude = { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE, "--fake-scenario", scenarioFile] };
  const registry = new Map([["plugin", { handler: (ctx) => pluginCommand({ ...ctx, claude }), summary: pluginCommandMeta.summary, boolean: [...pluginCommandMeta.boolean], options: [...pluginCommandMeta.options], hidden: false }]]);
  const run = async (argv, { stdin, stdout, stderr, io } = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["plugin", ...argv], { stdout: stdout ?? out, stderr: stderr ?? err, stdin: stdin ?? { isTTY: false }, env, cwd: repo, homedir: () => home, ...io }, { commands: registry });
    return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  // answers each [y/N] prompt in turn (the change, then the trust re-grant) until the command ends
  const tty = async (argv, keys) => {
    const terminal = fakeTerminal({ tty: true });
    const done = run(argv, { stdin: terminal.stdin, stdout: terminal.stdout, stderr: terminal.stderr });
    let finished = false;
    done.then(() => { finished = true; });
    const prompts = () => (terminal.text().match(/\[y\/N\]/g) ?? []).length;
    for (let i = 0; i < keys.length; i += 1) {
      await waitFor(() => finished || prompts() > i, { label: "the prompt" });
      if (finished) break;
      terminal.stdin.write(keys[i]);
    }
    const result = await done;
    return { code: result.code, out: terminal.text(), err: terminal.errText(), prompts: prompts() };
  };
  const calls = () => { try { return readFileSync(recordLog, "utf8").split(String.fromCharCode(10)).filter(Boolean).map((l) => JSON.parse(l).argv); } catch { return []; } };
  return { repo, home, env, run, tty, calls, readJson, writeJson, file: (...parts) => join(home, ".claude", ...parts), repoFile: (...parts) => join(repo, ...parts), trusted: () => safeTrustStatus(repo, { env }).trusted, trust: () => grantTrust(repo, { env }) };
}
