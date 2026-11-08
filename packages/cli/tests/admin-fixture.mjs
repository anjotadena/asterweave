// Shared world for the Phase F2 admin tests (not a test file). EVERY world isolates HOME / USERPROFILE / APPDATA / ASTERWEAVE_CONFIG_DIR in
// temp directories and runs the fake claude (tests/fixtures/fake-claude.mjs, admin mode): the real ~/.claude, ~/.claude.json and
// %APPDATA%\asterweave are never touched, and no real claude is ever started.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli.mjs";
import { mcpCommand, mcpCommandMeta } from "../src/commands/mcp.mjs";
import { fakeTerminal, waitFor } from "./repo-fixture.mjs";

export const FAKE_CLAUDE = fileURLToPath(new URL("./fixtures/fake-claude.mjs", import.meta.url));
const temps = [];
export const tempDir = (prefix) => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
};
export const cleanup = () => { for (const dir of temps.splice(0)) { try { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* a just-killed child can hold its cwd on Windows */ } } };
export const sink = () => { const chunks = []; return { write: (t) => { chunks.push(String(t)); return true; }, text: () => chunks.join("") }; };
export const NO_SPAWN = () => { throw new Error("spawn must not be called"); };
export const readJsonFile = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; } };
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export function world({ behavior = "ok", mcpServers, settings, extraScenario = {} } = {}) {
  const repo = tempDir("aw-adm-repo-");
  const home = tempDir("aw-adm-home-");
  const userDir = tempDir("aw-adm-user-");
  const appdata = tempDir("aw-adm-appdata-");
  const scratch = tempDir("aw-adm-sc-");
  const scenarioFile = join(scratch, "scenario.json");
  const record = join(scratch, "record.json");
  const recordLog = join(scratch, "log.jsonl");
  const userFile = join(home, ".claude.json");
  const base = { record, recordLog, admin: { behavior, userFile, userSettings: join(home, ".claude", "settings.json"), installedPlugins: join(home, ".claude", "plugins", "installed_plugins.json") }, ...extraScenario };
  const scenario = (patch = {}) => writeFileSync(scenarioFile, JSON.stringify({ ...base, ...patch, admin: { ...base.admin, ...(patch.admin ?? {}) } }));
  scenario();
  if (mcpServers) writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers }, null, 2));
  if (settings) { mkdirSync(join(repo, ".claude"), { recursive: true }); writeFileSync(join(repo, ".claude", "settings.json"), JSON.stringify(settings, null, 2)); }
  const env = { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}), HOME: home, USERPROFILE: home, APPDATA: appdata, ASTERWEAVE_CONFIG_DIR: userDir };
  const claude = { claudePath: process.execPath, claudeArgs: [FAKE_CLAUDE, "--fake-scenario", scenarioFile] };
  const registry = () => new Map([["mcp", { handler: (ctx) => mcpCommand({ ...ctx, claude }), summary: mcpCommandMeta.summary, boolean: [...mcpCommandMeta.boolean], options: [...mcpCommandMeta.options], hidden: false }]]);
  const run = async (argv, extra = {}) => {
    const out = sink();
    const err = sink();
    const code = await runCli(["mcp", ...argv], { stdout: out, stderr: err, stdin: extra.stdin ?? { isTTY: false }, env: { ...env, ...extra.env }, cwd: repo, homedir: () => home, ...extra.io }, { commands: registry() });
    return { code, out: out.text(), err: err.text(), json: () => JSON.parse(out.text()) };
  };
  /** Run on a fake terminal, answering each `[y/N]` prompt with the next key of `answers`. */
  const tty = async (argv, answers = ["y"], extra = {}) => {
    const terminal = fakeTerminal({ tty: true });
    const done = run(argv, { ...extra, stdin: terminal.stdin, io: { ...extra.io, stdout: terminal.stdout, stderr: terminal.stderr } });
    let finished = false;
    done.then(() => { finished = true; });
    const prompts = () => (terminal.text().match(/\[y\/N\]/g) ?? []).length;
    for (let i = 0; i < answers.length; i += 1) {
      await waitFor(() => finished || prompts() >= i + 1, { label: "the prompt" });
      if (finished) break;
      terminal.stdin.write(answers[i]);
    }
    const result = await done;
    return { code: result.code, out: terminal.text(), err: terminal.errText(), prompts: prompts() };
  };
  const recorded = () => readJsonFile(record);
  const calls = () => (existsSync(recordLog) ? readFileSync(recordLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).argv) : []);
  return { repo, home, userDir, appdata, env, claude, scenario, scenarioFile, run, tty, recorded, calls, userFile, mcpFile: join(repo, ".mcp.json"), settingsFile: join(repo, ".claude", "settings.json") };
}
