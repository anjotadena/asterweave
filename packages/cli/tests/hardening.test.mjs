// L-1 (PATH resolution), L-3 (probe cwd), store 'wx', and own-property config lookups.

import assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { probeCwd } from "../src/auth/common.mjs";
import { probeGithub } from "../src/auth/github.mjs";
import { coerceValue, ConfigError, resolveConfig } from "../src/config.mjs";
import { CliError, EXIT } from "../src/exit-codes.mjs";
import { resolveBinary, runBinary } from "../src/proc.mjs";
import { writeJsonAtomic } from "../src/store.mjs";
import { cleanupTemp, fakeSpawn, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

// --- L-1 --------------------------------------------------------------------------------------------

test("L-1 posix: relative and empty PATH entries are ignored; the result is always absolute", () => {
  const planted = new Set(["git", "./git", "bin/git", "/work/clone/git", "/usr/bin/git"]);
  const exists = (file) => planted.has(file);
  const result = resolveBinary("git", { platform: "linux", env: { PATH: ".::bin:/usr/bin" }, exists });
  assert.equal(result.path, "/usr/bin/git");
  assert.deepEqual(result.candidates, ["/usr/bin/git"]);
  assert.deepEqual(resolveBinary("git", { platform: "linux", env: { PATH: ".::bin:relative/dir" }, exists }), { reason: "NOT_FOUND", candidates: [] });
  assert.equal(resolveBinary("./git", { platform: "linux", env: { PATH: "/usr/bin" }, exists }).reason, "NOT_FOUND", "a relative command with a separator is not resolved");
});

test("L-1 win32: '.', empty, rooted-without-drive and drive-relative PATH entries never resolve a planted git.exe/gh.exe", async () => {
  const planted = new Set(["git.exe", ".\\git.exe", "\\git.exe", "C:git.exe", "gh.exe", ".\\gh.exe"].map((file) => file.toLowerCase()));
  const exists = (file) => planted.has(file.toLowerCase());
  const env = { PATH: ".;;\\;C:;bin", PATHEXT: ".EXE;.CMD" };
  for (const name of ["git", "gh"]) assert.deepEqual(resolveBinary(name, { platform: "win32", env, exists }), { reason: "NOT_FOUND", candidates: [] }, name);
  assert.equal(resolveBinary(".\\git.exe", { platform: "win32", env, exists }).reason, "NOT_FOUND");

  const spawn = fakeSpawn((child) => child.emit("close", 0, null));
  for (const name of ["git", "gh"]) {
    const result = await runBinary(name, ["--version"], { platform: "win32", env, exists, spawn });
    assert.equal(result.error.code, "NOT_FOUND");
  }
  assert.equal(spawn.calls.length, 0, "nothing was spawned from the current directory");

  const good = resolveBinary("git", { platform: "win32", env: { PATH: ".;C:\\tools\\bin" }, exists: (file) => file.toLowerCase() === "c:\\tools\\bin\\git.exe" });
  assert.equal(good.path, "C:\\tools\\bin\\git.exe");
  const spawned = fakeSpawn((child) => child.emit("close", 0, null));
  await runBinary("git", [], { platform: "win32", env: { PATH: ".;C:\\tools\\bin" }, exists: (file) => file.toLowerCase() === "c:\\tools\\bin\\git.exe", spawn: spawned });
  assert.equal(spawned.calls[0].cmd, "C:\\tools\\bin\\git.exe", "the absolute resolved path is spawned, not the bare name");
});

// --- L-3 --------------------------------------------------------------------------------------------

test("L-3: probeCwd fails closed (USER_DIR_UNAVAILABLE) instead of falling back to the shared temp dir", () => {
  const failing = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  assert.throws(
    () => probeCwd({ env: { ASTERWEAVE_CONFIG_DIR: join(tempDir("aw-cfg-"), "user") }, mkdir: failing }),
    (error) => error instanceof CliError && error.code === "USER_DIR_UNAVAILABLE" && error.exitCode === EXIT.ERROR && /ASTERWEAVE_CONFIG_DIR/.test(error.remediation),
  );
});

test("L-3: a provider probe with an unusable user directory spawns nothing", async () => {
  const dir = tempDir("aw-cfg-");
  const blocker = join(dir, "file");
  nodeFs.writeFileSync(blocker, "x");
  const spawn = fakeSpawn((child) => child.emit("close", 0, null));
  await assert.rejects(
    probeGithub({ env: { ASTERWEAVE_CONFIG_DIR: join(blocker, "sub"), PATH: dir }, spawn, exists: () => true }),
    (error) => error.code === "USER_DIR_UNAVAILABLE",
  );
  assert.equal(spawn.calls.length, 0);
});

// --- store ----------------------------------------------------------------------------------------------

test("store: the temporary file is opened exclusively (wx) and the result is written", () => {
  const dir = tempDir("aw-store-");
  const flags = [];
  const fs = { ...nodeFs, writeFileSync: (file, text, options) => { flags.push(options?.flag); return nodeFs.writeFileSync(file, text, options); } };
  writeJsonAtomic(join(dir, "x.json"), { a: 1 }, { fs });
  assert.deepEqual(flags, ["wx"]);
  assert.deepEqual(JSON.parse(nodeFs.readFileSync(join(dir, "x.json"), "utf8")), { a: 1 });
});

// --- own-property lookups ---------------------------------------------------------------------------------

test("config: keys such as constructor, toString and __proto__ in the user config are unknown, never resolved through Object.prototype", () => {
  const dir = tempDir("aw-cfg-");
  nodeFs.writeFileSync(join(dir, "config.json"), '{"constructor": 1, "toString": "x", "__proto__": {"runner": "cloud"}, "hasOwnProperty": true}');
  const resolved = resolveConfig({ env: { ASTERWEAVE_CONFIG_DIR: dir } });
  assert.equal(resolved.entries.runner.value, "local");
  assert.equal(resolved.entries.runner.origin, "default");
  assert.deepEqual(resolved.unknown.map((item) => item.key).sort(), ["__proto__.runner", "constructor", "hasOwnProperty", "toString"]);
  assert.equal({}.runner, undefined, "Object.prototype was not polluted");
  assert.throws(() => coerceValue("constructor", 1), (error) => error instanceof ConfigError && /Unknown configuration key/.test(error.message));
  assert.throws(() => resolveConfig({ env: { ASTERWEAVE_CONFIG_DIR: dir }, flags: { constructor: "x" } }), ConfigError);
});
