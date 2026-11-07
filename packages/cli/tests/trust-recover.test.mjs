// A corrupt trust.json is recoverable through the real command path: `trust grant` and `trust revoke`
// replace it (trusting nothing else), every read leaves it byte-for-byte alone, and `trust status`
// still fails closed. Also: the trusted config path never falls back to an unbound second read.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { ConfigError, readExecutableRepoConfig, resolveConfig } from "../src/config.mjs";
import { grantTrust, revokeTrust, safeTrustStatus, trustStatus } from "../src/trust.mjs";
import { NATIVE, claudeStatus, fakeSpawn, ghEntry, ghHosts, installed, makeSandbox } from "./auth-helpers.mjs";
import { cleanupTemp, fakeTerminal, makeClone, tempDir, waitFor } from "./repo-fixture.mjs";

after(cleanupTemp);

const CORRUPT = "{ broken";
const exists = installed(NATIVE("gh"), NATIVE("claude"));
const sink = () => {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
};

async function run(argv, sandbox, { cwd = sandbox.root, fs, env = sandbox.env } = {}) {
  const stdout = sink();
  const stderr = sink();
  const spawn = fakeSpawn((cmd) => (/gh(\.exe)?$/i.test(cmd) ? { stdout: ghHosts({ "github.com": [ghEntry()] }) } : { stdout: claudeStatus() }));
  const code = await runCli(argv, { stdout, stderr, stdin: sink(), env, cwd, homedir: () => sandbox.root, spawn, exists, ...(fs ? { fs } : {}) });
  return { code, out: stdout.text(), err: stderr.text() };
}

const adapter = (command) => JSON.stringify({ version: 1, qualityGates: { required: [{ id: "unit", command, source: "t" }] } });

/** A sandbox plus a repository with a gate and a corrupt trust.json. */
function corruptFixture() {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-recover-");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), adapter("echo gate"));
  const store = join(sandbox.userDir, "trust.json");
  writeFileSync(store, CORRUPT);
  return { sandbox, repo, store };
}

test("trust grant --path --json on a corrupt trust.json exits 0 and writes a valid store that trusts the repository", async () => {
  const { sandbox, repo, store } = corruptFixture();
  const result = await run(["trust", "grant", "--path", repo, "--json"], sandbox);
  assert.equal(result.code, 0, result.err || result.out);
  const body = JSON.parse(result.out);
  assert.equal(body.ok, true);
  assert.equal(body.trusted, true);
  const saved = JSON.parse(readFileSync(store, "utf8"));
  const entries = Object.values(saved);
  assert.equal(entries.length, 1, "only the granted repository is in the recreated store");
  assert.equal(entries[0].sha256, body.hash);
  assert.equal(JSON.parse((await run(["trust", "status", "--path", repo, "--json"], sandbox)).out).trusted, true);
});

test("trust grant on a corrupt store stays bound to the previewed hash: a change before the write grants nothing and leaves the file alone", async () => {
  const { sandbox, repo, store } = corruptFixture();
  let reads = 0;
  const fs = {
    ...nodeFs,
    readFileSync(file, ...rest) {
      try {
        return nodeFs.readFileSync(file, ...rest);
      } finally {
        if (String(file).replace(/\\/g, "/").endsWith(".mcp.json") && (reads += 1) === 1) writeFileSync(join(repo, ".claude", "settings.json"), '{"hooks":{}}');
      }
    },
  };
  const result = await run(["trust", "grant", "--path", repo, "--json"], sandbox, { fs });
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(result.out).error.code, "TRUST_CHANGED_DURING_GRANT");
  assert.equal(readFileSync(store, "utf8"), CORRUPT, "nothing was recorded");
});

test("trust grant in a TTY (no --path) on a corrupt store asks y/N, and 'y' recreates the store", async () => {
  const { sandbox, repo, store } = corruptFixture();
  const term = fakeTerminal();
  const running = runCli(["trust", "grant"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: repo, homedir: () => sandbox.root });
  await waitFor(() => /\[y\/N\]/.test(term.text()), { label: "the confirmation prompt" });
  assert.match(term.text(), /trust store \(trust\.json\) is unreadable/);
  term.stdin.write("y");
  assert.equal(await running, 0);
  assert.equal(Object.keys(JSON.parse(readFileSync(store, "utf8"))).length, 1);
});

test("a declined TTY grant on a corrupt store leaves the file untouched", async () => {
  const { sandbox, repo, store } = corruptFixture();
  const term = fakeTerminal();
  const running = runCli(["trust", "grant"], { stdin: term.stdin, stdout: term.stdout, stderr: term.stderr, env: sandbox.env, cwd: repo, homedir: () => sandbox.root });
  await waitFor(() => /\[y\/N\]/.test(term.text()), { label: "the confirmation prompt" });
  term.stdin.write("n");
  assert.equal(await running, 1);
  assert.equal(readFileSync(store, "utf8"), CORRUPT);
});

test("trust revoke --path --json on a corrupt trust.json exits 0, reports recreated, and leaves valid JSON {}", async () => {
  const { sandbox, repo, store } = corruptFixture();
  const result = await run(["trust", "revoke", "--path", repo, "--json"], sandbox);
  assert.equal(result.code, 0, result.err || result.out);
  const body = JSON.parse(result.out);
  assert.equal(body.ok, true);
  assert.equal(body.trusted, false);
  assert.equal(body.removed, false);
  assert.equal(body.recreated, true);
  assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), {});
  // Revoking again is the ordinary idempotent no-op.
  const again = JSON.parse((await run(["trust", "revoke", "--path", repo, "--json"], sandbox)).out);
  assert.deepEqual({ removed: again.removed, recreated: again.recreated }, { removed: false, recreated: false });
});

test("trust revoke (text) on a corrupt store says the store was recreated", async () => {
  const { sandbox, repo } = corruptFixture();
  const result = await run(["trust", "revoke", "--path", repo], sandbox);
  assert.equal(result.code, 0);
  assert.match(result.out, /trust store was unreadable and has been recreated empty/);
});

test("revoke on a healthy store reports recreated:false and does not rewrite it when the key is absent", async () => {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-recover-");
  const store = join(sandbox.userDir, "trust.json");
  const original = '{"other":{"sha256":"x","trustedAt":"t"}}';
  writeFileSync(store, original);
  const body = JSON.parse((await run(["trust", "revoke", "--path", repo, "--json"], sandbox)).out);
  assert.deepEqual({ removed: body.removed, recreated: body.recreated }, { removed: false, recreated: false });
  assert.equal(readFileSync(store, "utf8"), original);
});

test("revokeTrust treats valid JSON that is not an object as a corrupt store and replaces it", () => {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-recover-");
  const store = join(sandbox.userDir, "trust.json");
  writeFileSync(store, "[1,2]");
  const result = revokeTrust(repo, { env: sandbox.env });
  assert.deepEqual({ removed: result.removed, recreated: result.recreated }, { removed: false, recreated: true });
  assert.deepEqual(JSON.parse(readFileSync(store, "utf8")), {});
});

test("reads never rewrite a corrupt trust.json (trust status, config show, doctor, repo status) and trust status still exits 1", async () => {
  const { sandbox } = corruptFixture();
  const clone = makeClone();
  mkdirSync(join(clone, ".claude"), { recursive: true });
  writeFileSync(join(clone, ".claude", "asterweave.json"), adapter("echo gate"));
  const store = join(sandbox.userDir, "trust.json");
  writeFileSync(join(sandbox.userDir, "repo.json"), JSON.stringify({ repository: "acme/widgets", branch: "main", path: clone, runner: "local" }));
  const before = readFileSync(store);

  const status = await run(["trust", "status", "--path", clone, "--json"], sandbox);
  assert.equal(status.code, 1, "trust status on a corrupt store keeps its documented exit 1");
  const error = JSON.parse(status.out).error;
  assert.equal(error.code, "STORE_CORRUPT");
  assert.match(error.remediation, /trust revoke/, "remediation agrees with the warning text instead of contradicting it");
  assert.doesNotMatch(error.remediation, /delete/i);

  assert.equal((await run(["config", "show", "--json", "--path", clone], sandbox)).code, 0);
  const doctor = JSON.parse((await run(["doctor", "--json"], sandbox, { cwd: clone })).out);
  assert.equal(doctor.checks.find((item) => item.id === "repo.trust").status, "WARN");
  const rs = await run(["repo", "status", "--json"], sandbox, { cwd: clone, env: { ...process.env, ...sandbox.env } }); // real PATH: repo status runs git assert.equal(rs.code, 0, rs.out + rs.err);
  assert.ok(readFileSync(store).equals(before), "the corrupt file is byte-for-byte unchanged after every read");
});

test("safeTrustStatus on a corrupt store keeps the hash bound to the repository files", () => {
  const { sandbox, repo } = corruptFixture();
  const safe = safeTrustStatus(repo, { env: sandbox.env });
  assert.equal(safe.reason, "STORE_UNREADABLE");
  grantTrust(repo, { env: sandbox.env, expectedHash: safe.hash });
  assert.equal(trustStatus(repo, { env: sandbox.env }).trusted, true);
});

// --- L-B: no unbound second read of the adapter ---------------------------------------------

/** fs where the hashed read (a Buffer read, no encoding) of the adapter hits EISDIR, but a utf8 read would return real gates. */
function eisdirOnHashedRead() {
  let secondReads = 0;
  const fs = {
    ...nodeFs,
    readFileSync(file, ...rest) {
      if (String(file).replace(/\\/g, "/").endsWith(".claude/asterweave.json")) {
        if (rest[0] === undefined) throw Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
        secondReads += 1;
      }
      return nodeFs.readFileSync(file, ...rest);
    },
  };
  return { fs, secondReads: () => secondReads };
}

test("an adapter that was unreadable when hashed is a ConfigError (exit 5) on both config paths; no second read, gates never applied", () => {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-unreadable-");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  writeFileSync(join(repo, ".claude", "asterweave.json"), adapter("echo SMUGGLED"));
  const { fs, secondReads } = eisdirOnHashedRead();
  // Trust is granted for the state the hash saw (UNREADABLE:EISDIR), so the trusted path is the one exercised.
  grantTrust(repo, { env: sandbox.env, fs });
  assert.equal(trustStatus(repo, { env: sandbox.env, fs }).trusted, true);

  const strict = (error) => error instanceof ConfigError && error.exitCode === 5 && error.code === "CONFIG_INVALID" && !/SMUGGLED/.test(error.message);
  assert.throws(() => readExecutableRepoConfig(repo, "run gates", { env: sandbox.env, fs }), strict);
  assert.throws(() => resolveConfig({ env: sandbox.env, repoPath: repo, fs }), strict);
  assert.equal(secondReads(), 0, "the adapter was never read a second time");
});
