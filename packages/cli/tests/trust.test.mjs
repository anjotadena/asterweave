import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { EXIT } from "../src/exit-codes.mjs";
import { StoreError } from "../src/store.mjs";
import { assertTrusted, classifyExecutableConfig, computeTrustHash, grantTrust, repositoryIdentity, revokeTrust, TRUST_FILES, TrustError, trustStatus } from "../src/trust.mjs";

const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const base = () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aw-trust-")));
  madeDirs.push(dir);
  return dir;
};

function fixture() {
  const root = base();
  const repo = join(root, "repo");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const options = { trustFile: join(root, "user", "trust.json") };
  return { root, repo, options };
}

const put = (repo, relative, text) => {
  const file = join(repo, ...relative.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

test("a repository starts untrusted, can be granted, and can be revoked", () => {
  const { repo, options } = fixture();
  put(repo, ".claude/asterweave.json", '{"version":1}');
  const before = trustStatus(repo, options);
  assert.equal(before.trusted, false);
  assert.equal(before.reason, "NOT_GRANTED");
  assert.equal(before.trustedAt, null);

  const granted = grantTrust(repo, { ...options, now: () => "2026-01-01T00:00:00.000Z" });
  assert.equal(granted.trusted, true);
  assert.equal(granted.hash, before.hash);
  assert.equal(granted.trustedAt, "2026-01-01T00:00:00.000Z");

  const after = trustStatus(repo, options);
  assert.equal(after.trusted, true);
  assert.equal(after.reason, "TRUSTED");
  assert.equal(after.trustedAt, "2026-01-01T00:00:00.000Z");

  const stored = JSON.parse(readFileSync(options.trustFile, "utf8"));
  const key = Object.keys(stored)[0];
  assert.equal(key.toLowerCase(), repositoryIdentity(repo).key.toLowerCase());
  assert.deepEqual(Object.keys(stored[key]).sort(), ["sha256", "trustedAt"]);
  assert.equal(stored[key].sha256, granted.hash);

  const revoked = revokeTrust(repo, options);
  assert.deepEqual({ trusted: revoked.trusted, removed: revoked.removed }, { trusted: false, removed: true });
  assert.equal(trustStatus(repo, options).trusted, false);
  assert.equal(revokeTrust(repo, options).removed, false, "revoke is idempotent");
  assert.deepEqual(JSON.parse(readFileSync(options.trustFile, "utf8")), {});
});

test("a byte change in each of the four governing files invalidates trust", () => {
  assert.deepEqual([...TRUST_FILES], [".claude/asterweave.json", ".claude/settings.json", ".claude/settings.local.json", ".mcp.json"]);
  for (const relative of TRUST_FILES) {
    const { repo, options } = fixture();
    put(repo, relative, "A");
    grantTrust(repo, options);
    assert.equal(trustStatus(repo, options).trusted, true, `${relative} granted`);

    put(repo, relative, "B");
    const changed = trustStatus(repo, options);
    assert.equal(changed.trusted, false, `${relative} byte change`);
    assert.equal(changed.reason, "CHANGED");
    assert.ok(changed.previousHash && changed.previousHash !== changed.hash);

    put(repo, relative, "A");
    assert.equal(trustStatus(repo, options).trusted, true, `${relative} restored`);

    rmSync(join(repo, ...relative.split("/")));
    assert.equal(trustStatus(repo, options).trusted, false, `${relative} deleted`);
  }
});

test("adding a previously missing governing file invalidates trust", () => {
  for (const relative of TRUST_FILES) {
    const { repo, options } = fixture();
    grantTrust(repo, options); // all four missing
    assert.equal(trustStatus(repo, options).trusted, true);
    put(repo, relative, "{}");
    assert.equal(trustStatus(repo, options).trusted, false, relative);
  }
});

test("missing files contribute a stable marker and are reported per file", () => {
  const { repo } = fixture();
  const first = computeTrustHash(repo);
  const second = computeTrustHash(repo);
  assert.equal(first.hash, second.hash);
  assert.match(first.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(first.files.map((file) => file.state), ["missing", "missing", "missing", "missing"]);
  // Empty file differs from missing file.
  put(repo, ".mcp.json", "");
  const empty = computeTrustHash(repo);
  assert.notEqual(empty.hash, first.hash);
  assert.equal(empty.files[3].state, "present");
  // A directory where a file belongs is deterministic and distinct from missing.
  const { repo: other } = fixture();
  mkdirSync(join(other, ".mcp.json"));
  const odd = computeTrustHash(other);
  assert.equal(odd.files[3].state, "unreadable");
  assert.equal(odd.hash, computeTrustHash(other).hash);
});

test("bytes cannot migrate between files without changing the hash", () => {
  const { repo: one } = fixture();
  const { repo: two } = fixture();
  // Same total bytes in the same order, split differently across the files.
  put(one, ".claude/settings.json", "AB");
  put(one, ".claude/settings.local.json", "C");
  put(two, ".claude/settings.json", "A");
  put(two, ".claude/settings.local.json", "BC");
  const hashOne = computeTrustHash(one).hash;
  const hashTwo = computeTrustHash(two).hash;
  assert.notEqual(hashOne, hashTwo);
  // Identical content in a different repository location is a different identity.
  const { repo: three } = fixture();
  put(three, ".claude/settings.json", "AB");
  put(three, ".claude/settings.local.json", "C");
  assert.notEqual(computeTrustHash(three).hash, hashOne);
});

test("trust is bound to the realpath: a directory link shares the grant", (t) => {
  const { root, repo, options } = fixture();
  put(repo, ".claude/asterweave.json", '{"version":1}');
  const link = join(root, "link");
  try {
    symlinkSync(repo, link, "junction");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip(`cannot create directory link: ${error.code}`);
    throw error;
  }
  grantTrust(link, options);
  const viaTarget = trustStatus(repo, options);
  const viaLink = trustStatus(link, options);
  assert.equal(viaTarget.trusted, true, "granting through a link trusts the real directory");
  assert.equal(viaLink.trusted, true);
  assert.equal(viaLink.realpath, repo);
  assert.equal(Object.keys(JSON.parse(readFileSync(options.trustFile, "utf8"))).length, 1);
  assert.equal(revokeTrust(link, options).removed, true);
  assert.equal(trustStatus(repo, options).trusted, false);
});

test("a governing file that is a symlink contributes its target's bytes", (t) => {
  const { root, repo, options } = fixture();
  const target = join(root, "outside.json");
  writeFileSync(target, "ONE");
  try {
    symlinkSync(target, join(repo, ".mcp.json"), "file");
  } catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") return t.skip(`cannot create file symlink: ${error.code}`);
    throw error;
  }
  grantTrust(repo, options);
  writeFileSync(target, "TWO");
  assert.equal(trustStatus(repo, options).trusted, false);
});

test("a nonexistent repository path is a typed error", () => {
  assert.throws(() => trustStatus(join(base(), "nope"), { trustFile: join(base(), "t.json") }), (error) => error.code === "REPO_PATH_INVALID");
});

test("assertTrusted throws a TrustError mapped to exit 4 and names the purpose and remedy", () => {
  const { repo, options } = fixture();
  assert.throws(
    () => assertTrusted(repo, "run quality gates", options),
    (error) => {
      assert.ok(error instanceof TrustError);
      assert.equal(error.exitCode, EXIT.TRUST);
      assert.equal(error.code, "TRUST_REQUIRED");
      assert.match(error.message, /run quality gates/);
      assert.match(error.remediation, /asterweave trust grant/);
      assert.equal(error.status.reason, "NOT_GRANTED");
      return true;
    },
  );
  grantTrust(repo, options);
  assert.equal(assertTrusted(repo, "run quality gates", options).trusted, true);
  put(repo, ".claude/settings.json", "{}");
  assert.throws(() => assertTrusted(repo, "run quality gates", options), (error) => error.status.reason === "CHANGED" && /changed since trust was granted/.test(error.message));
});

test("the user directory comes from the injected environment", () => {
  const { root, repo } = fixture();
  const env = { ASTERWEAVE_CONFIG_DIR: join(root, "cfg") };
  grantTrust(repo, { env });
  assert.equal(JSON.parse(readFileSync(join(root, "cfg", "trust.json"), "utf8")) !== null, true);
  assert.equal(trustStatus(repo, { env }).trusted, true);
  assert.equal(trustStatus(repo, { env: { ASTERWEAVE_CONFIG_DIR: join(root, "other") } }).trusted, false);
});

test("a corrupt trust.json fails closed with a typed store error and is not overwritten by status", () => {
  const { repo, options } = fixture();
  mkdirSync(join(options.trustFile, ".."), { recursive: true });
  writeFileSync(options.trustFile, "{ broken");
  assert.throws(() => trustStatus(repo, options), StoreError);
  assert.equal(readFileSync(options.trustFile, "utf8"), "{ broken");
});

test("granting one repository preserves the others", () => {
  const first = fixture();
  const second = fixture();
  const options = { trustFile: first.options.trustFile };
  grantTrust(first.repo, options);
  grantTrust(second.repo, options);
  assert.equal(Object.keys(JSON.parse(readFileSync(options.trustFile, "utf8"))).length, 2);
  revokeTrust(first.repo, options);
  assert.equal(trustStatus(second.repo, options).trusted, true);
});

test("executable repo config is classified: gate commands, settings, and MCP", () => {
  const { repo } = fixture();
  assert.deepEqual(classifyExecutableConfig(repo), []);
  put(repo, ".claude/asterweave.json", JSON.stringify({ version: 1, provider: { workItems: "github" }, qualityGates: { required: [{ id: "unit", command: "npm test", source: "package.json" }, { id: "lint", command: "npm run lint", source: "package.json" }] } }));
  put(repo, ".claude/settings.json", JSON.stringify({ hooks: {} }));
  put(repo, ".claude/settings.local.json", "{}");
  put(repo, ".mcp.json", "{}");
  assert.deepEqual(classifyExecutableConfig(repo).map(({ field, kind }) => [field, kind]), [
    ["qualityGates.required[0].command", "command"],
    ["qualityGates.required[1].command", "command"],
    [".claude/settings.json", "settings"],
    [".claude/settings.local.json", "settings"],
    [".mcp.json", "mcp"],
  ]);
  // A broken adapter yields no gate entries rather than throwing.
  put(repo, ".claude/asterweave.json", "{ nope");
  assert.deepEqual(classifyExecutableConfig(repo).map(({ kind }) => kind), ["settings", "settings", "mcp"]);
});
