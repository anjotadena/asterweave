// An external SIGINT while any picker is open must end the picker (exit 130), restore the terminal,
// remove its listener and leave nothing that a later Enter could confirm (no `gh auth login`, no
// credentials.json, no repo.json).

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { launchCommand } from "../src/commands/launch.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { pickOne, withTerminal } from "../src/tui/session.mjs";
import { createTerminal } from "../src/tui/terminal.mjs";
import { ghSignedOut, launchContext, makeWorld, setup } from "./launch-fixture.mjs";
import { cleanupTemp, fakeTerminal, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const loginSpawned = (world) => world.log.some((entry) => (entry.name === "gh" || entry.name === "claude") && entry.args[0] === "auth" && entry.args[1] === "login");

/** After the interrupt: terminal restored, listener gone, and Enter confirms nothing. */
async function assertDead({ term, proc, world, files }) {
  assert.equal(term.stdin.rawCalls.at(-1), false, "raw mode restored");
  assert.equal(proc.listenerCount("SIGINT"), 0, "SIGINT listener removed");
  const spawned = world.log.length;
  term.stdin.write("\r");
  term.stdin.write("\r");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(world.log.length, spawned, "Enter after SIGINT spawned nothing");
  assert.equal(loginSpawned(world), false, "no provider login was started");
  assert.equal(existsSync(files.credentials), false, "no credentials.json");
  assert.equal(existsSync(files.repo), false, "no repo.json");
  assert.equal(proc.exitCode, 130);
}

async function launchUntil(text, { world, env, cwd }) {
  const term = fakeTerminal();
  const ctx = launchContext(term, world, { env, cwd });
  const running = launchCommand(ctx);
  await waitFor(() => term.text().includes(text), { label: text });
  return { term, ctx, running };
}

test("SIGINT at the sign-in picker resolves 130; a later Enter does not start gh auth login", async () => {
  const { env, clone, files } = setup();
  const world = makeWorld({ gh: ghSignedOut() });
  const { term, ctx, running } = await launchUntil("Sign in to continue.", { world, env, cwd: clone });
  ctx.proc.emit("SIGINT");
  assert.equal(await running, EXIT.INTERRUPTED);
  await assertDead({ term, proc: ctx.proc, world, files });
});

test("SIGINT at the repository picker resolves 130 and connects nothing", async () => {
  const { env, clone, files } = setup({ cloneOptions: { origin: null } });
  const world = makeWorld();
  const { term, ctx, running } = await launchUntil("Select a repository", { world, env, cwd: clone });
  ctx.proc.emit("SIGINT");
  assert.equal(await running, EXIT.INTERRUPTED);
  await assertDead({ term, proc: ctx.proc, world, files });
});

test("SIGINT at the branch picker resolves 130 and connects nothing", async () => {
  const { env, clone, files } = setup();
  const world = makeWorld();
  const { term, ctx, running } = await launchUntil("Select a branch for acme/widgets", { world, env, cwd: clone });
  ctx.proc.emit("SIGINT");
  assert.equal(await running, EXIT.INTERRUPTED);
  await assertDead({ term, proc: ctx.proc, world, files });
});

test("SIGINT at the `auth login` picker resolves 130, spawns nothing and writes no reference", async () => {
  const { env, clone, files } = setup();
  const world = makeWorld();
  const term = fakeTerminal();
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  const running = runCli(["auth", "login"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env, cwd: clone, spawn: world.spawn, exists: world.exists, proc });
  await waitFor(() => term.text().includes("Sign in to Asterweave"), { label: "the login picker" });
  proc.emit("SIGINT");
  assert.equal(await running, EXIT.INTERRUPTED);
  await assertDead({ term, proc, world, files });
  assert.equal(world.log.length, 0, "nothing was ever spawned");
});

test("a render error inside a picker restores the terminal and rejects (no uncaught exception)", async () => {
  const term = fakeTerminal();
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  await assert.rejects(
    withTerminal({ terminal, stdin: term.stdin, proc }, ({ input, signal }) =>
      pickOne({ terminal, input, signal, count: 2, render: () => { throw new Error("render boom"); } })),
    /render boom/,
  );
  assert.equal(term.stdin.rawCalls.at(-1), false);
  assert.equal(proc.listenerCount("SIGINT"), 0);
});

test("a render error after the first frame (on a key press) also restores the terminal", async () => {
  const term = fakeTerminal();
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  let calls = 0;
  const running = withTerminal({ terminal, stdin: term.stdin, proc }, ({ input, signal }) =>
    pickOne({ terminal, input, signal, count: 2, render: () => { calls += 1; if (calls > 1) throw new Error("late boom"); return "frame"; } }));
  const settled = assert.rejects(running, /late boom/);
  await waitFor(() => calls === 1);
  term.stdin.write("\x1b[B");
  await settled;
  assert.equal(term.stdin.rawCalls.at(-1), false);
});

test("pickOne after an abort resolves interrupted immediately and never draws", async () => {
  const term = fakeTerminal();
  const terminal = createTerminal({ stdin: term.stdin, stdout: term.stdout, env: { TERM: "xterm" } });
  const proc = Object.assign(new EventEmitter(), { exitCode: undefined });
  await withTerminal({ terminal, stdin: term.stdin, proc }, async ({ input, signal }) => {
    proc.emit("SIGINT");
    let drew = false;
    const result = await pickOne({ terminal, input, signal, count: 2, render: () => { drew = true; return "x"; } });
    assert.deepEqual(result, { done: true, interrupted: true });
    assert.equal(drew, false);
  });
});
