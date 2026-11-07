// Shared fixtures for the auth tests (not a test file: run-tests only runs *.test.mjs).

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Token-shaped strings, assembled at runtime so no real-looking literal exists in the source. */
export const FAKE_GH_TOKEN = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6"].join("");
export const FAKE_ANTHROPIC_KEY = ["sk", "-ant-", "api03-Zy9Xw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"].join("");
export const TOKEN_SHAPED = /gh[opurs]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{10,}|sk-ant-[A-Za-z0-9_-]{8,}|Bearer\s+\S{12,}/;

const sandboxes = [];
// Registered on the importing test file: every sandbox it created is removed when that file finishes.
after(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

export function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "aw-auth-"));
  sandboxes.push(root);
  const userDir = join(root, "user");
  const binDir = join(root, "bin");
  mkdirSync(userDir, { recursive: true });
  const env = { PATH: binDir, ASTERWEAVE_CONFIG_DIR: userDir };
  return { root, userDir, binDir, env, credentialsFile: join(userDir, "credentials.json") };
}

/** `exists` predicate: true only for the named binaries (matched by file name, any directory). */
export function installed(...names) {
  const patterns = names.map((name) => new RegExp(`[\\\\/]${name.replace(/\./g, "\\.")}$`, "i"));
  return (file) => patterns.some((pattern) => pattern.test(file));
}

// Native binaries resolve as `x.exe` on win32 and bare `x` elsewhere.
export const NATIVE = process.platform === "win32" ? (name) => `${name}.exe` : (name) => name;

/**
 * Fake spawn. `handler(cmd, args, options)` returns {code, stdout, stderr, signal, error, hang}.
 * With `hang: true` the child only closes when killed (to model an abort mid-login).
 */
export function fakeSpawn(handler) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end() {} });
    child.kill = (signal) => {
      setImmediate(() => child.emit("close", null, signal ?? "SIGTERM"));
      return true;
    };
    calls.push({ cmd, args, options });
    const outcome = handler(cmd, args, options) ?? {};
    setImmediate(() => {
      if (outcome.error) {
        child.pid = undefined;
        child.emit("error", outcome.error);
        return;
      }
      if (outcome.hang) return;
      if (outcome.stdout) child.stdout.emit("data", Buffer.from(outcome.stdout));
      if (outcome.stderr) child.stderr.emit("data", Buffer.from(outcome.stderr));
      child.emit("close", outcome.code ?? 0, outcome.signal ?? null);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

export function ghHosts(entries) {
  return JSON.stringify({ hosts: entries });
}

export function ghEntry(overrides = {}) {
  return { state: "success", active: true, host: "github.com", login: "octo-dev", tokenSource: "keyring", scopes: "gist, read:org, repo", gitProtocol: "https", ...overrides };
}

export function claudeStatus(overrides = {}) {
  return JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "anjo@example.com", orgId: "org-1", orgName: "Example Org", subscriptionType: "max", ...overrides });
}
