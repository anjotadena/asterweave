// Shared fixtures for the launch tests (not a test file: the runner only picks *.test.mjs).
// `gh` and `claude` are faked by a routing spawn driven by a mutable "world"; git runs for real
// against temp clones, so nothing touches the network or the user's real sign-ins.

import { spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isExecutableFile } from "../src/proc.mjs";
import { stripAnsi } from "../src/tui/render.mjs";
import { SEQ } from "../src/tui/terminal.mjs";
import { claudeStatus, ghEntry, ghHosts } from "./auth-helpers.mjs";
import { fakeChild, fakeTerminal, makeClone, tempDir, waitFor } from "./repo-fixture.mjs";

export const REPOS = JSON.stringify([
  { nameWithOwner: "acme/other", defaultBranchRef: { name: "main" } },
  { nameWithOwner: "acme/widgets", defaultBranchRef: { name: "main" } },
]);
export const SIGNED_OUT_CLAUDE = JSON.stringify({ loggedIn: false });
export const UP = "\x1b[A";
export const DOWN = "\x1b[B";

/** A signed-in gh state with the given entry overrides. */
export const ghSignedIn = (overrides) => ghHosts([ghEntry(overrides)]);
export const ghSignedOut = () => ghHosts([]);

export function makeWorld(overrides = {}) {
  const world = {
    gh: ghSignedIn(),
    claude: claudeStatus(),
    ghInstalled: true,
    claudeInstalled: true,
    ghLoginCode: 0,
    ghLoginSignal: null,
    ghLoginHang: false,
    claudeLoginCode: 0,
    onGhLogin: null,
    onClaudeLogin: null,
    term: null,
    log: [], // every spawn: {name, args} (git included)
    logins: [], // hand-offs: {name, args, stdio, rawCalls}
    ...overrides,
  };

  const answer = (child, name, args, options) => {
    const reply = ({ stdout = "", stderr = "", code = 0, signal = null } = {}) => {
      if (stdout) child.stdout.emit("data", Buffer.from(stdout));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code, signal);
    };
    const key = `${name} ${args[0]} ${args[1]}`;
    if (key === "gh auth status") return reply({ stdout: world.gh });
    if (key === "gh repo list") return reply({ stdout: world.repos ?? REPOS });
    if (key === "claude auth status") return reply({ stdout: world.claude });
    if (key === "gh auth login" || key === "claude auth login") {
      world.logins.push({ name, args: [...args], stdio: options?.stdio, rawCalls: world.term ? [...world.term.stdin.rawCalls] : [] });
      if (name === "gh") {
        if (world.ghLoginHang) return undefined;
        world.onGhLogin?.(world);
        return reply({ code: world.ghLoginCode, signal: world.ghLoginSignal });
      }
      world.onClaudeLogin?.(world);
      return reply({ code: world.claudeLoginCode });
    }
    return reply({ code: 1, stderr: `unexpected ${key}` });
  };

  world.spawn = (cmd, args, options) => {
    const name = basename(cmd).toLowerCase().replace(/\.(exe|com)$/, "");
    world.log.push({ name, args: [...args] });
    if (name !== "gh" && name !== "claude") return nodeSpawn(cmd, args, options);
    const child = fakeChild();
    child.kill = () => {
      queueMicrotask(() => child.emit("close", null, "SIGTERM"));
      return true;
    };
    queueMicrotask(() => answer(child, name, args, options));
    return child;
  };

  // gh/claude exist only as native binaries (never the real .cmd shims on the developer's PATH).
  world.exists = (file) => {
    const name = basename(file).toLowerCase().replace(/\.(exe|com|cmd|bat)$/, "");
    const native = !/\.(cmd|bat)$/i.test(file);
    if (name === "gh") return world.ghInstalled && native;
    if (name === "claude") return world.claudeInstalled && native;
    return isExecutableFile(file);
  };
  /** Spawns after the session started must not include anything new. */
  world.names = () => world.log.map((entry) => entry.name);
  return world;
}

/** Temp config dir + a real clone whose origin is acme/widgets. */
export function setup({ connected = false, cloneOptions } = {}) {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone(cloneOptions);
  const env = { ...process.env, TERM: "xterm", ASTERWEAVE_CONFIG_DIR: configDir };
  delete env.NO_COLOR;
  const files = { repo: join(configDir, "repo.json"), credentials: join(configDir, "credentials.json") };
  if (connected) {
    writeFileSync(files.repo, JSON.stringify({ repository: "acme/widgets", branch: "main", path: clone, runner: "local", connectedAt: "2026-01-01T00:00:00.000Z" }));
  }
  return { configDir, clone, env, files };
}

/** Handler context for launchCommand with fake TTY streams. */
export function launchContext(term, world, { env, cwd, tty, ...extra } = {}) {
  world.term = term;
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  return {
    stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd,
    spawn: world.spawn, exists: world.exists, version: "9.9.9", name: "launch",
    argv: [], positionals: [], options: {}, rest: [], proc, ...extra,
  };
}

export { fakeTerminal, waitFor };

export const frames = (term) => term.text().split(SEQ.clear).length - 1;
export const lastFrame = (term) => stripAnsi(term.text().split(SEQ.clear).at(-1));

/** Write a key and wait for the redraw it causes. */
export async function press(term, key) {
  const before = frames(term);
  term.stdin.write(key);
  await waitFor(() => frames(term) > before, { label: `a redraw after ${JSON.stringify(key)}` });
}

/** Wait until the session frame (banner + composer) is on screen. */
export const waitForSession = (term) => waitFor(() => /Welcome to /.test(term.text()), { label: "the working session" });
