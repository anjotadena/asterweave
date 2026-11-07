import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { parseArgs } from "../src/args.mjs";
import { commands, registerCommand, runCli, usageText } from "../src/cli.mjs";
import { CliError, EXIT, UsageError } from "../src/exit-codes.mjs";
import { resolveUserDir, userFilePath } from "../src/paths.mjs";
import { readJson, removeFile, StoreError, writeJsonAtomic } from "../src/store.mjs";

const binPath = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const tmp = () => track(mkdtempSync(join(tmpdir(), "aw-foundation-")));
const madeDirs = [];
after(() => {
  for (const dir of madeDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const track = (dir) => {
  madeDirs.push(dir);
  return dir;
};


function sink() {
  const chunks = [];
  return { write: (text) => chunks.push(String(text)), text: () => chunks.join("") };
}

// --- exit codes -----------------------------------------------------------------------------

test("exit codes match the documented table", () => {
  assert.deepEqual({ ...EXIT }, { OK: 0, ERROR: 1, USAGE: 2, AUTH: 3, TRUST: 4, CONFIG: 5, APPROVAL_REQUIRED: 6, POLICY_DENIED: 7, INTERRUPTED: 130 });
  assert.ok(Object.isFrozen(EXIT));
  const error = new UsageError("bad");
  assert.equal(error.exitCode, 2);
  assert.equal(error.code, "USAGE");
  assert.ok(error instanceof CliError);
  assert.deepEqual(new CliError("m", { code: "X", remediation: "do y" }).toJSON(), { code: "X", message: "m", remediation: "do y" });
});

// --- args -----------------------------------------------------------------------------------

test("parseArgs handles --key value, --key=value, flags, positionals and --", () => {
  const parsed = parseArgs(["status", "--repo", "o/n", "--branch=main", "--json", "--", "--raw", "x"], { boolean: ["json"] });
  assert.deepEqual(parsed.positionals, ["status"]);
  assert.equal(parsed.options.repo, "o/n");
  assert.equal(parsed.options.branch, "main");
  assert.equal(parsed.options.json, true);
  assert.deepEqual(parsed.rest, ["--raw", "x"]);
});

test("declared booleans never swallow the next positional", () => {
  const parsed = parseArgs(["--json", "status"], { boolean: ["json"] });
  assert.deepEqual(parsed.positionals, ["status"]);
  assert.equal(parsed.options.json, true);
  // An undeclared flag takes the next non-option token.
  assert.equal(parseArgs(["--json", "status"]).options.json, "status");
  // A trailing or option-followed flag is true.
  assert.equal(parseArgs(["--flag"]).options.flag, true);
  assert.equal(parseArgs(["--flag", "--other", "v"]).options.flag, true);
});

test("parseArgs boolean forms and short flags", () => {
  assert.equal(parseArgs(["--json=false"], { boolean: ["json"] }).options.json, false);
  assert.equal(parseArgs(["--no-json"], { boolean: ["json"] }).options.json, false);
  assert.throws(() => parseArgs(["--json=maybe"], { boolean: ["json"] }), UsageError);
  assert.equal(parseArgs(["-h"]).options.help, true);
  assert.equal(parseArgs(["-v"]).options.version, true);
  assert.throws(() => parseArgs(["-x"]), (error) => error instanceof UsageError && error.exitCode === 2);
  assert.throws(() => parseArgs(["--=x"]), UsageError);
  // Lone dash and values containing '=' survive.
  assert.deepEqual(parseArgs(["-"]).positionals, ["-"]);
  assert.equal(parseArgs(["--filter=a=b"]).options.filter, "a=b");
  // Option bags have no prototype, so odd keys are plain data.
  assert.equal(Object.getPrototypeOf(parseArgs(["--x=1"]).options), null);
  assert.equal(parseArgs(["--constructor=x"]).options.constructor, "x");
});

// --- paths ----------------------------------------------------------------------------------

test("resolveUserDir follows the platform conventions from injected inputs", () => {
  const homedir = () => "/home/anjo";
  assert.equal(resolveUserDir({ platform: "linux", env: {}, homedir }), "/home/anjo/.config/asterweave");
  assert.equal(resolveUserDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, homedir }), "/xdg/asterweave");
  assert.equal(resolveUserDir({ platform: "linux", env: { XDG_CONFIG_HOME: "relative" }, homedir }), "/home/anjo/.config/asterweave");
  assert.equal(resolveUserDir({ platform: "darwin", env: {}, homedir }), "/home/anjo/Library/Application Support/asterweave");
  assert.equal(resolveUserDir({ platform: "win32", env: { APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, homedir: () => "C:\\Users\\a" }), "C:\\Users\\a\\AppData\\Roaming\\asterweave");
  assert.equal(resolveUserDir({ platform: "win32", env: {}, homedir: () => "C:\\Users\\a" }), "C:\\Users\\a\\AppData\\Roaming\\asterweave");
});

test("ASTERWEAVE_CONFIG_DIR overrides every platform when absolute", () => {
  assert.equal(resolveUserDir({ platform: "linux", env: { ASTERWEAVE_CONFIG_DIR: "/custom/dir" }, homedir: () => "/h" }), "/custom/dir");
  assert.equal(resolveUserDir({ platform: "win32", env: { ASTERWEAVE_CONFIG_DIR: "D:\\cfg" }, homedir: () => "C:\\h" }), "D:\\cfg");
  assert.equal(resolveUserDir({ platform: "linux", env: { ASTERWEAVE_CONFIG_DIR: "rel" }, homedir: () => "/h" }), "/h/.config/asterweave");
  assert.equal(userFilePath("trust", { platform: "linux", env: { ASTERWEAVE_CONFIG_DIR: "/c" }, homedir: () => "/h" }), "/c/trust.json");
  assert.throws(() => userFilePath("nope", { env: {} }), /Unknown user file/);
});

// --- store ----------------------------------------------------------------------------------

test("store round-trips JSON, creates parents, and leaves no temp files", () => {
  const file = join(tmp(), "a", "b", "data.json");
  writeJsonAtomic(file, { a: 1 });
  writeJsonAtomic(file, { a: 2, list: [1] });
  assert.deepEqual(readJson(file), { a: 2, list: [1] });
  assert.deepEqual(readdirSync(dirname(file)), ["data.json"]);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("store reads are tolerant of missing and empty files but typed on corruption", () => {
  const directory = tmp();
  assert.equal(readJson(join(directory, "missing.json")), null);
  assert.deepEqual(readJson(join(directory, "missing.json"), { fallback: { x: 1 } }), { x: 1 });
  writeFileSync(join(directory, "empty.json"), "  \n");
  assert.equal(readJson(join(directory, "empty.json")), null);
  writeFileSync(join(directory, "bom.json"), "\ufeff{\"ok\":true}");
  assert.deepEqual(readJson(join(directory, "bom.json")), { ok: true });
  writeFileSync(join(directory, "bad.json"), "{ not json");
  assert.throws(() => readJson(join(directory, "bad.json")), (error) => error instanceof StoreError && error.reason === "CORRUPT" && error.code === "STORE_CORRUPT");
  assert.equal(readFileSync(join(directory, "bad.json"), "utf8"), "{ not json", "a corrupt file is never modified by a read");
  // A directory where a file is expected is unreadable, not corrupt.
  assert.throws(() => readJson(directory), (error) => error instanceof StoreError && error.reason === "UNREADABLE");
});

test("store retries EPERM/EBUSY renames and gives up with a typed error, cleaning the temp file", () => {
  const directory = tmp();
  const file = join(directory, "x.json");
  const removed = [];
  const sleeps = [];
  let attempts = 0;
  let failFor = 3;
  const fs = {
    mkdirSync() {},
    writeFileSync: (path, text, options) => writeFileSync(path, text, options),
    chmodSync: (path, mode) => chmodSync(path, mode),
    unlinkSync: (path) => { removed.push(path); },
    renameSync() {
      attempts += 1;
      if (attempts <= failFor) throw Object.assign(new Error("locked"), { code: attempts % 2 ? "EPERM" : "EBUSY" });
      writeFileSync(file, "renamed");
    },
  };
  writeJsonAtomic(file, { a: 1 }, { fs, sleep: (ms) => sleeps.push(ms) });
  assert.equal(attempts, 4);
  assert.equal(sleeps.length, 3);
  assert.deepEqual(removed, []);

  attempts = 0;
  failFor = Infinity;
  assert.throws(() => writeJsonAtomic(file, { a: 1 }, { fs, sleep() {} }), (error) => error instanceof StoreError && error.reason === "WRITE_FAILED");
  assert.equal(removed.length, 1, "temp file removed after final failure");

  // Non-retryable errors are not retried.
  attempts = 0;
  const failing = { ...fs, renameSync() { attempts += 1; throw Object.assign(new Error("nope"), { code: "ENOSPC" }); } };
  assert.throws(() => writeJsonAtomic(file, {}, { fs: failing, sleep() {} }), StoreError);
  assert.equal(attempts, 1);
});

test("removeFile reports whether it removed anything", () => {
  const file = join(tmp(), "r.json");
  writeJsonAtomic(file, {});
  assert.equal(removeFile(file), true);
  assert.equal(removeFile(file), false);
});

// --- cli dispatcher -------------------------------------------------------------------------

test("--version and help print to stdout with exit 0", async () => {
  const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  for (const argv of [["--version"], ["-v"]]) {
    const stdout = sink();
    assert.equal(await runCli(argv, { stdout, stderr: sink() }), 0);
    assert.equal(stdout.text(), `${version}\n`);
  }
  for (const argv of [["help"], ["--help"], ["-h"], []]) {
    const stdout = sink();
    assert.equal(await runCli(argv, { stdout, stderr: sink() }, { commands: new Map() }), 0);
    assert.match(stdout.text(), /^Usage: asterweave <command>/);
  }
});

test("unknown commands print usage on stderr and return 2", async () => {
  const stdout = sink();
  const stderr = sink();
  assert.equal(await runCli(["frobnicate"], { stdout, stderr }, { commands: new Map() }), 2);
  assert.equal(stdout.text(), "");
  assert.match(stderr.text(), /^Asterweave CLI error: unknown command 'frobnicate'\./);
  assert.match(stderr.text(), /Usage: asterweave/);
  assert.equal(await runCli(["help", "frobnicate"], { stdout, stderr: sink() }, { commands: new Map() }), 2);
});

test("registerCommand adds to the shared table; handlers get parsed context and control the exit code", async () => {
  let seen;
  registerCommand("zz-echo", (ctx) => { seen = ctx; return 7; }, { summary: "Echo things", boolean: ["json"] });
  try {
    assert.ok(commands.has("zz-echo"));
    const stdout = sink();
    const code = await runCli(["zz-echo", "--json", "one", "--name=x", "--", "tail"], { stdout, stderr: sink(), cwd: "/work", env: { A: "1" } });
    assert.equal(code, 7);
    assert.equal(seen.name, "zz-echo");
    assert.deepEqual(seen.positionals, ["one"]);
    assert.equal(seen.options.json, true);
    assert.equal(seen.options.name, "x");
    assert.deepEqual(seen.rest, ["tail"]);
    assert.equal(seen.cwd, "/work");
    assert.equal(seen.env.A, "1");
    assert.match(usageText(), /zz-echo\s+Echo things/);
    assert.equal(await runCli(["zz-echo", "--help"], { stdout, stderr: sink() }), 0);
    assert.match(stdout.text(), /asterweave zz-echo - Echo things/);
  } finally {
    commands.delete("zz-echo");
  }
  assert.ok(!commands.has("zz-echo"));
});

test("a handler returning nothing exits 0", async () => {
  const registry = new Map([["quiet", { handler: () => undefined, summary: "", boolean: [] }]]);
  assert.equal(await runCli(["quiet"], { stdout: sink(), stderr: sink() }, { commands: registry }), 0);
});

test("handler errors map to exit codes, stderr text, and JSON error bodies", async () => {
  const registry = new Map([
    ["trust-me", { handler: () => { throw new CliError(`untrusted gh${"p"}_${"a".repeat(30)}`, { code: "TRUST_REQUIRED", exitCode: EXIT.TRUST, remediation: "run trust grant" }); }, summary: "", boolean: ["json"] }],
    ["boom", { handler: () => { throw new Error("kaboom"); }, summary: "", boolean: ["json"] }],
  ]);
  let stdout = sink();
  let stderr = sink();
  assert.equal(await runCli(["trust-me"], { stdout, stderr }, { commands: registry }), 4);
  assert.equal(stdout.text(), "");
  assert.equal(stderr.text(), "Asterweave trust-me error: untrusted ghp_…\nrun trust grant\n");

  stdout = sink();
  stderr = sink();
  assert.equal(await runCli(["trust-me", "--json"], { stdout, stderr }, { commands: registry }), 4);
  assert.equal(stderr.text(), "");
  assert.deepEqual(JSON.parse(stdout.text()), { ok: false, error: { code: "TRUST_REQUIRED", message: "untrusted ghp_…", remediation: "run trust grant" } });

  stderr = sink();
  assert.equal(await runCli(["boom"], { stdout: sink(), stderr }, { commands: registry }), 1);
  assert.match(stderr.text(), /Unexpected failure: kaboom/);
  // A bad flag during parsing is a usage error.
  assert.equal(await runCli(["boom", "-x"], { stdout: sink(), stderr: sink() }, { commands: registry }), 2);
});

test("bin runs as a real subprocess with no escape bytes on piped stdout", () => {
  assert.ok(existsSync(binPath));
  const result = spawnSync(process.execPath, [binPath, "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+\n$/);
  assert.ok(!result.stdout.includes("\x1b"));
  const unknown = spawnSync(process.execPath, [binPath, "nope"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /unknown command 'nope'/);
});
