// M-1: terminal escape injection from repository-, config- and provider-controlled text.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { formatDoctorReport } from "../src/commands/doctor.mjs";
import { runDoctor } from "../src/doctor.mjs";
import { isExecutableFile } from "../src/proc.mjs";
import { sanitizeForTerminal } from "../src/redact.mjs";
import { createStyle, frame, renderBanner, renderHeader, renderPicker, renderStrip } from "../src/tui/render.mjs";
import { cleanupTemp, git, makeClone, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const BAD = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;
const ESC = "\x1b";
const BEL = "\x07";
const HOSTILE = `${ESC}]0;PWNED${BEL}${ESC}]52;c;QUJD${BEL}${ESC}[2J${ESC}[31mred\x9b2J\x85\x00\r`;

test("sanitizeForTerminal removes escape sequences wholesale and neutralises stray controls", () => {
  assert.equal(sanitizeForTerminal(`a${ESC}]0;title${BEL}b`), "ab");
  assert.equal(sanitizeForTerminal(`a${ESC}]52;c;QUJD${ESC}\\b`), "ab", "OSC terminated by ST");
  assert.equal(sanitizeForTerminal(`a${ESC}[2Jb${ESC}[1;31mc`), "abc");
  assert.equal(sanitizeForTerminal(`a${ESC}Pq;data${ESC}\\b`), "ab", "DCS string");
  assert.equal(sanitizeForTerminal("a\x9b2Jb\x85c\x7fd\x00e\rf\x08g"), "a?2Jb?c?d?e?f?g");
  assert.equal(sanitizeForTerminal("tab\tnewline\nok"), "tab\tnewline\nok");
  assert.equal(sanitizeForTerminal(`x${ESC}`), "x", "dangling ESC");
  assert.equal(sanitizeForTerminal(`${ESC}]0;never terminated`), "", "unterminated OSC is dropped to the end");
  assert.equal(sanitizeForTerminal("a‮b"), "a?b", "bidi override");
  assert.equal(sanitizeForTerminal(undefined), "");
  assert.equal(sanitizeForTerminal(42), "42");
  assert.equal(BAD.test(sanitizeForTerminal(HOSTILE)), false);
  // SGR colour survives only on request, and only SGR.
  assert.equal(sanitizeForTerminal(`${ESC}[1mbold${ESC}[0m${ESC}[2J`, { allowSgr: true }), `${ESC}[1mbold${ESC}[0m`);
});

test("render entry points sanitise dynamic text but keep their own style codes", () => {
  const style = createStyle({ env: {}, isTTY: true });
  assert.equal(style.enabled, true);
  const outputs = [
    renderPicker({ title: HOSTILE, items: [{ label: HOSTILE, hint: HOSTILE }, { label: "ok" }], selected: 0, width: 200, style }),
    renderHeader({ version: HOSTILE, repo: HOSTILE, branch: HOSTILE, width: 200, style }),
    renderStrip({ items: [{ key: HOSTILE, label: HOSTILE }], width: 200, style }),
    renderBanner({ account: HOSTILE, repo: HOSTILE, branch: HOSTILE, runner: HOSTILE, warnings: [HOSTILE], width: 200, style }),
    frame({ header: HOSTILE, body: [HOSTILE, `${style.bold("styled")}${ESC}[2J`], footer: HOSTILE, width: 200 }),
  ];
  for (const text of outputs) {
    const withoutOwnStyle = text.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(BAD.test(withoutOwnStyle), false, JSON.stringify(withoutOwnStyle));
    assert.ok(!text.includes("PWNED") || !text.includes(`${ESC}]`), "no OSC introducer survives");
  }
  assert.ok(outputs[0].includes(`${ESC}[1m`), "our own bold survives in the picker");
  assert.ok(outputs[4].includes(`${ESC}[1mstyled${ESC}[22m`), "our own SGR survives frame()");
});

test("doctor text output sanitises hostile reasons and remediations; JSON data is untouched", () => {
  const report = {
    ok: false,
    checks: [
      { id: "config.valid", status: "FAIL", reason: `bad ${HOSTILE}`, remediation: `fix ${HOSTILE}` },
      { id: "repo.trust", status: "WARN", reason: HOSTILE, remediation: null },
    ],
  };
  const text = formatDoctorReport(report);
  assert.equal(BAD.test(text.replaceAll("\n", "")), false, JSON.stringify(text));
  assert.ok(text.includes("FAIL  config.valid"));
});

test("a real doctor run with a hostile config.valid reason prints no control bytes in text mode", async () => {
  const configDir = tempDir("aw-cfg-");
  const clone = makeClone();
  mkdirSync(join(clone, ".claude"), { recursive: true });
  writeFileSync(join(clone, ".claude", "asterweave.json"), JSON.stringify({ version: 1, [HOSTILE]: true }));
  writeFileSync(join(configDir, "repo.json"), JSON.stringify({ repository: "acme/widgets", branch: "main", path: clone }));
  const noProviders = (file) => (/(^|[\\/])(gh|claude)(\.exe|\.com|\.cmd|\.bat)?$/i.test(file) ? false : isExecutableFile(file));
  const report = await runDoctor({ env: { ...process.env, ASTERWEAVE_CONFIG_DIR: configDir }, exists: noProviders, cwd: clone });
  const config = report.checks.find((check) => check.id === "config.valid");
  assert.equal(config.status, "FAIL");
  assert.equal(BAD.test(formatDoctorReport(report).replaceAll("\n", "")), false);
});

// --- real subprocess ------------------------------------------------------------------------------

const binPath = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aw-sanitize-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
let nextId = 0;

function box() {
  const dir = join(root, `case-${nextId++}`);
  const paths = { dir, userDir: join(dir, "user"), cwd: join(dir, "cwd"), home: join(dir, "home") };
  for (const path of [paths.userDir, paths.cwd, paths.home]) mkdirSync(path, { recursive: true });
  return paths;
}

function bin(args, sandbox, cwd = sandbox.cwd) {
  const env = { ...process.env, ASTERWEAVE_CONFIG_DIR: sandbox.userDir, HOME: sandbox.home, USERPROFILE: sandbox.home };
  const result = spawnSync(process.execPath, [binPath, ...args], { cwd, env, input: "", encoding: "utf8", timeout: 60_000 });
  assert.equal(result.error, undefined);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const assertClean = (...streams) => {
  for (const stream of streams) assert.equal(BAD.test(stream.replaceAll("\n", "")), false, JSON.stringify(stream));
};

test("subprocess: an untrusted repo whose adapter has a hostile key -> config show exits 5 with no control bytes", () => {
  const sandbox = box();
  mkdirSync(join(sandbox.cwd, ".claude"), { recursive: true });
  writeFileSync(join(sandbox.cwd, ".claude", "asterweave.json"), JSON.stringify({ version: 1, [`${ESC}]0;PWNED${BEL}${ESC}]52;c;QUJD${BEL}${ESC}[2J\x9b31m`]: true }));
  const result = bin(["config", "show"], sandbox);
  assert.equal(result.code, 5);
  assert.match(result.err, /unknown top-level property/);
  assertClean(result.out, result.err);
  const json = bin(["config", "show", "--json"], sandbox);
  assert.equal(json.code, 5);
  assert.equal(JSON.parse(json.out).ok, false, "JSON mode is escaped by JSON.stringify and still parses");
});

test("subprocess: a corrupt user config.json containing ESC bytes -> exit 5, no control bytes", () => {
  const sandbox = box();
  writeFileSync(join(sandbox.userDir, "config.json"), `{ ${ESC}]0;PWNED${BEL} ${ESC}[2J \x9b`);
  const result = bin(["config", "show"], sandbox);
  assert.equal(result.code, 5);
  assert.match(result.err, /is not valid JSON\./);
  assert.equal(result.err.includes("PWNED"), false, "no snippet of the file is echoed");
  assertClean(result.out, result.err);
});

test("subprocess: hostile unknown keys in a valid user config are listed without control bytes", () => {
  const sandbox = box();
  writeFileSync(join(sandbox.userDir, "config.json"), JSON.stringify({ [`${ESC}]0;PWNED${BEL}\x9b2J`]: 1, runner: "local" }));
  const result = bin(["config", "show"], sandbox);
  assert.equal(result.code, 0, result.err);
  assert.match(result.out, /Ignored unknown keys:/);
  assertClean(result.out, result.err);
});

test("subprocess: hostile branch and remote names on the repo connect error paths", () => {
  const sandbox = box();
  const clone = makeClone({ origin: `https://example.com/${ESC}]0;PWNED${BEL}${ESC}[2Jx/y.git` });
  const mismatch = bin(["repo", "connect", "--repo", "acme/widgets", "--branch", "main", "--path", clone], sandbox);
  assert.equal(mismatch.code, 1);
  assertClean(mismatch.out, mismatch.err);

  const ok = makeClone();
  const badBranch = bin(["repo", "connect", "--repo", "acme/widgets", "--branch", `${ESC}]0;PWNED${BEL}${ESC}[2J`, "--path", ok], sandbox);
  assert.equal(badBranch.code, 2);
  assertClean(badBranch.out, badBranch.err);

  const unknown = bin([`${ESC}]0;PWNED${BEL}`], sandbox);
  assert.equal(unknown.code, 2);
  assertClean(unknown.out, unknown.err);
  git(ok, "status", "--porcelain");
});
