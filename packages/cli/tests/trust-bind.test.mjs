// S5: the bytes that were trusted are the bytes that are parsed (no check/use gap), and `trust grant`
// is bound to the hash the user previewed.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { runCli } from "../src/cli.mjs";
import { readExecutableRepoConfig, resolveConfig } from "../src/config.mjs";
import { grantTrust, trustStatus } from "../src/trust.mjs";
import { makeSandbox } from "./auth-helpers.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const adapter = (command) => JSON.stringify({ version: 1, qualityGates: { required: [{ id: "unit", command, source: "t" }] } });

function fixture() {
  const sandbox = makeSandbox();
  const repo = tempDir("aw-bind-");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const file = join(repo, ".claude", "asterweave.json");
  writeFileSync(file, adapter("echo trusted"));
  return { sandbox, repo, file, env: sandbox.env };
}

/** fs whose reads of `suffix` are counted, and which runs `afterRead` once after the first such read. */
function watchedFs(suffix, afterRead) {
  const state = { reads: 0 };
  const fs = {
    ...nodeFs,
    readFileSync(file, ...rest) {
      const isTarget = String(file).replace(/\\/g, "/").endsWith(suffix);
      try {
        return nodeFs.readFileSync(file, ...rest);
      } finally {
        if (isTarget) {
          state.reads += 1;
          if (state.reads === 1) afterRead?.();
        }
      }
    },
  };
  return { fs, state };
}

test("readExecutableRepoConfig parses the same bytes it hashed: a swap after the hash read cannot smuggle a gate in", () => {
  const { repo, file, env } = fixture();
  grantTrust(repo, { env });
  const { fs, state } = watchedFs(".claude/asterweave.json", () => writeFileSync(file, adapter("echo SWAPPED")));
  const result = readExecutableRepoConfig(repo, "run gates", { env, fs });
  assert.equal(result.gates[0].command, "echo trusted");
  assert.equal(state.reads, 1, "the adapter is read exactly once");
});

test("resolveConfig's repo layer also reads the adapter once and applies what was hashed", () => {
  const { repo, file, env } = fixture();
  grantTrust(repo, { env });
  const { fs, state } = watchedFs(".claude/asterweave.json", () => writeFileSync(file, adapter("echo SWAPPED")));
  const resolved = resolveConfig({ env, repoPath: repo, fs });
  assert.equal(resolved.repo.trusted, true);
  assert.equal(resolved.entries["qualityGates.required"].value[0].command, "echo trusted");
  assert.equal(state.reads, 1);
});

test("a trust status object does not leak the adapter bytes into JSON or equality", () => {
  const { repo, env } = fixture();
  const status = trustStatus(repo, { env });
  assert.equal("adapter" in JSON.parse(JSON.stringify(status)), false);
  assert.ok(Buffer.isBuffer(status.adapter.bytes));
});

test("grantTrust({expectedHash}) refuses when the files changed after the preview and records nothing", () => {
  const { repo, file, env, sandbox } = fixture();
  const previewed = trustStatus(repo, { env }).hash;
  writeFileSync(file, adapter("echo changed"));
  assert.throws(() => grantTrust(repo, { env, expectedHash: previewed }), (error) => error.code === "TRUST_CHANGED_DURING_GRANT" && error.exitCode === 1 && /rerun trust grant/.test(error.remediation));
  assert.equal(existsSync(join(sandbox.userDir, "trust.json")), false);
  assert.equal(grantTrust(repo, { env, expectedHash: trustStatus(repo, { env }).hash }).trusted, true);
});

test("`trust grant --path` is bound to the previewed hash: a change between preview and grant exits 1 and grants nothing", async () => {
  const { repo, sandbox } = fixture();
  const { fs } = watchedFs(".mcp.json", () => writeFileSync(join(repo, ".claude", "settings.json"), '{"hooks":{}}'));
  const out = [];
  const err = [];
  const code = await runCli(["trust", "grant", "--path", repo, "--json"], {
    stdout: { write: (t) => out.push(t) }, stderr: { write: (t) => err.push(t) }, stdin: { isTTY: false },
    env: sandbox.env, cwd: sandbox.root, homedir: () => sandbox.root, fs,
  });
  assert.equal(code, 1);
  const body = JSON.parse(out.join(""));
  assert.equal(body.error.code, "TRUST_CHANGED_DURING_GRANT");
  assert.match(body.error.remediation, /rerun trust grant/);
  assert.equal(existsSync(join(sandbox.userDir, "trust.json")), false, "nothing was recorded");
  assert.equal(readFileSync(join(repo, ".claude", "settings.json"), "utf8"), '{"hooks":{}}');
});

test("grant and revoke recreate a corrupt trust.json (an explicit act that trusts nothing else); status never rewrites it", () => {
  const { repo, env, sandbox } = fixture();
  const store = join(sandbox.userDir, "trust.json");
  writeFileSync(store, "{ broken");
  assert.throws(() => trustStatus(repo, { env }));
  assert.equal(readFileSync(store, "utf8"), "{ broken");
  assert.equal(grantTrust(repo, { env }).trusted, true);
  assert.equal(trustStatus(repo, { env }).trusted, true);
});
