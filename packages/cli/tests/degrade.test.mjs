// S9: a corrupt trust.json or repo.json must not stop launch / repo status / doctor / config show
// (launch never needs trust), while trust DECISIONS still fail closed. Reads never rewrite the files.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { launchCommand } from "../src/commands/launch.mjs";
import { EXIT } from "../src/exit-codes.mjs";
import { NATIVE, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox } from "./auth-helpers.mjs";
import { lastFrame, launchContext, makeWorld, setup, waitForSession } from "./launch-fixture.mjs";
import { cleanupTemp, fakeTerminal, makeClone, tempDir, waitFor } from "./repo-fixture.mjs";
import { mkdirSync } from "node:fs";

after(cleanupTemp);

const exitSessionKeys = "/exit" + String.fromCharCode(13);

const TRUST_WARNING = "trust store unreadable: run asterweave trust revoke/grant to recreate";

test("launch with a corrupt trust.json still reaches the session, untrusted, with a warning; the file is untouched", async () => {
  const { env, clone, files, configDir } = setup({ connected: true });
  const trustFile = join(configDir, "trust.json");
  writeFileSync(trustFile, "{ broken");
  const term = fakeTerminal();
  const ctx = launchContext(term, makeWorld(), { env, cwd: clone });
  const running = launchCommand(ctx);
  await waitForSession(term);
  assert.ok(lastFrame(term).includes(TRUST_WARNING), lastFrame(term));
  term.stdin.write(exitSessionKeys);
  assert.equal(await running, EXIT.OK);
  assert.equal(readFileSync(trustFile, "utf8"), "{ broken");
  assert.ok(files.repo);
});

test("launch with a corrupt repo.json treats it as not connected, warns, and reconnects through the picker", async () => {
  const { env, clone, files } = setup();
  writeFileSync(files.repo, "{ broken");
  const term = fakeTerminal();
  const ctx = launchContext(term, makeWorld(), { env, cwd: clone });
  const running = launchCommand(ctx);
  await waitFor(() => term.text().includes("Select a branch for acme/widgets"), { label: "branch picker" });
  term.stdin.write("\r");
  await waitForSession(term);
  assert.match(lastFrame(term), /unreadable or invalid/);
  term.stdin.write(exitSessionKeys);
  assert.equal(await running, EXIT.OK);
  assert.equal(JSON.parse(readFileSync(files.repo, "utf8")).repository, "acme/widgets", "the broken file was replaced by the new connection");
});

const exists = installed(NATIVE("gh"), NATIVE("claude"));
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};
const spawn = () => fakeSpawn((cmd) => (/gh(\.exe)?$/i.test(cmd) ? { stdout: ghHosts({ "github.com": [ghEntry()] }) } : { stdout: claudeStatus() }));
async function run(argv, sandbox, cwd = sandbox.root) {
  const stdout = sink();
  const stderr = sink();
  const code = await runCli(argv, { stdout, stderr, stdin: sink(), env: sandbox.env, cwd, homedir: () => sandbox.root, spawn: spawn(), exists });
  return { code, out: stdout.text(), err: stderr.text() };
}

test("repo status / doctor / config show survive a corrupt repo.json and trust.json", async () => {
  const sandbox = makeSandbox();
  const repo = makeClone();
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "settings.json"), "{}");
  writeFileSync(join(sandbox.userDir, "repo.json"), "{ broken");
  writeFileSync(join(sandbox.userDir, "trust.json"), "{ broken");

  const status = await run(["repo", "status", "--json"], sandbox);
  assert.equal(status.code, 0);
  assert.match(JSON.parse(status.out).warning, /unreadable or invalid/);

  const doctor = await run(["doctor", "--json"], sandbox, repo);
  const checks = Object.fromEntries(JSON.parse(doctor.out).checks.map((item) => [item.id, item]));
  assert.equal(checks["repo.connection"].status, "WARN");
  assert.match(checks["repo.connection"].reason, /unreadable or invalid/);
  assert.equal(checks["repo.trust"].status, "WARN");
  assert.ok(checks["repo.trust"].reason.includes(TRUST_WARNING), checks["repo.trust"].reason);
  assert.equal(checks["config.valid"].status, "PASS");

  const config = await run(["config", "show", "--json", "--path", repo], sandbox);
  assert.equal(config.code, 0);
  const view = JSON.parse(config.out);
  assert.equal(view.repo.trusted, false);
  assert.equal(view.repo.warning, TRUST_WARNING);

  assert.equal(readFileSync(join(sandbox.userDir, "repo.json"), "utf8"), "{ broken");
  assert.equal(readFileSync(join(sandbox.userDir, "trust.json"), "utf8"), "{ broken");
});

test("trust decisions still fail closed: `trust status` on a corrupt trust.json errors (exit 1) and executable config is not applied", async () => {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-degrade-");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), JSON.stringify({ version: 1, qualityGates: { required: [{ id: "u", command: "echo x", source: "t" }] } }));
  writeFileSync(join(sandbox.userDir, "trust.json"), "{ broken");
  assert.equal((await run(["trust", "status", "--path", repo], sandbox)).code, 1);
  const config = JSON.parse((await run(["config", "show", "--json", "--path", repo], sandbox)).out);
  assert.deepEqual(config.repo.skipped, ["qualityGates.required"]);
  assert.deepEqual(config.entries["qualityGates.required"].value, []);
});
