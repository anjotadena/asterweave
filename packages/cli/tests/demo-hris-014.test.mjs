// The HRIS-014 fixture demo (scripts/demo-hris-014.mjs) run as a child process: every step PASSes, nothing is written outside temp
// directories (the sentinel ASTERWEAVE_CONFIG_DIR stays empty and the REAL default user directory is unchanged), the output ends with the
// fixture-vs-live table, and the exit code follows the steps. No network, no model.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { resolveUserDir } from "../src/paths.mjs";
import { COVERAGE, main, runSteps } from "../scripts/demo-hris-014.mjs";
import { cleanupTemp, tempDir } from "./repo-fixture.mjs";

after(cleanupTemp);

const SCRIPT = fileURLToPath(new URL("../scripts/demo-hris-014.mjs", import.meta.url));
const DOCS = join(dirname(SCRIPT), "..", "..", "..", "website", "docs", "cli", "demo.md");

/** Recursive listing (relative path, size, mtime) of a directory that may not exist. */
function listing(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = join(current, entry.name);
      if (entry.isDirectory()) { out.push(`${file}/`); walk(file); } else { const stat = statSync(file); out.push(`${file}|${stat.size}|${stat.mtimeMs}`); }
    }
  };
  walk(dir);
  return out.sort();
}

let cached;
function runDemo() {
  if (cached) return cached;
  const sentinel = tempDir("aw-demo-sentinel-");
  const realEnv = { ...process.env };
  delete realEnv.ASTERWEAVE_CONFIG_DIR;
  const realUserDir = resolveUserDir({ env: realEnv });
  const before = listing(realUserDir);
  const started = Date.now();
  const result = spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, ASTERWEAVE_CONFIG_DIR: sentinel, DEMO_TIME_LIMIT_SECONDS: "170" }, encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  cached = { result, sentinel, realUserDir, before, after: listing(realUserDir), wallMs: Date.now() - started };
  return cached;
}

test("the demo passes: exit 0, 0 failed, every step line is PASS", () => {
  const { result } = runDemo();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const lines = result.stdout.split(/\r?\n/);
  const stepLines = lines.filter((line) => /^(PASS|FAIL)\s+\d\d\s/.test(line));
  assert.ok(stepLines.length >= 20, `expected the full scenario, saw ${stepLines.length} steps`);
  assert.deepEqual(stepLines.filter((line) => !line.startsWith("PASS")), []);
  assert.match(result.stdout, /\b0 failed\b/);
  assert.ok(!/^FAIL/m.test(result.stdout));
  const seconds = Number(/, ([\d.]+) s/.exec(result.stdout)?.[1]);
  assert.ok(seconds < 170, `the demo took ${seconds} s (a quiet machine needs about 10 s; 60 s is the default limit of the script itself)`);
});

test("the output covers the required scenario and ends with the fixture-vs-live table", () => {
  const { result } = runDemo();
  const text = result.stdout;
  for (const phrase of ["auth validated", "repository connected", "fixture MCP server", "model route shown", "session started", "plan approval", "library tty source", "interrupted", "RUN_LOCKED", "pull request created", "merge simulated", "workflow failure", "duplicate and delayed", "rerun", "NOT closable until", "ZERO model calls", "offline runner", "invalid MCP", "provider throttling", "budget exhaustion", "non-TTY", "safe cancellation", "denied tool request", "hook timeout"]) {
    assert.ok(text.toLowerCase().includes(phrase.toLowerCase()), `missing: ${phrase}`);
  }
  const table = text.slice(text.indexOf("Fixture-vs-live coverage"));
  assert.ok(table.length > 0, "the table is printed");
  for (const [area] of COVERAGE) assert.ok(table.includes(area), area);
  assert.match(table, /No live model, no live GitHub, no live MCP server/);
  assert.ok(table.indexOf("passed,") > table.indexOf("No live model"), "the summary comes last");
});

test("the coverage table claims nothing as verified live", () => {
  for (const [, , live] of COVERAGE) assert.match(live, /NOT verified live|real code/i, live);
  assert.ok(!COVERAGE.some(([, , live]) => /^(yes|verified)/i.test(live)));
});

test("nothing is written outside temp directories: the sentinel config dir is empty and the real user directory is unchanged", () => {
  const { sentinel, before, after: afterListing, realUserDir, result } = runDemo();
  assert.deepEqual(readdirSync(sentinel), [], "ASTERWEAVE_CONFIG_DIR given to the child was not used");
  assert.deepEqual(afterListing, before, `${realUserDir} changed`);
  const printed = result.stdout.match(/[A-Za-z]:\\[^\s,;]+|\/(?:tmp|var|private|home|Users)[^\s,;]*/g) ?? [];
  assert.ok(printed.length > 0);
  for (const path of printed) assert.ok(path.includes("aw-demo-"), `a printed path is outside the demo temp root: ${path}`);
  assert.ok(!/gho_D{36}/.test(result.stdout + result.stderr), "the fake token is never printed");
});

test("the demo removes its temporary root when it finishes", () => {
  const { result } = runDemo();
  const roots = [...result.stdout.matchAll(/(?:[A-Za-z]:\\|\/)[^\s]*?aw-demo-[A-Za-z0-9]+/g)].map((match) => match[0]);
  assert.ok(roots.length > 0);
  for (const root of new Set(roots)) assert.equal(existsSync(root), false, `${root} was not removed`);
});

test("main returns non-zero when a step fails or the time limit is exceeded, zero otherwise", async () => {
  const lines = [];
  const log = (line) => lines.push(line);
  const ok = { id: "01", title: "fine", path: "x", fn: async () => ["detail"] };
  const bad = { id: "02", title: "broken", path: "x", fn: async () => { throw new Error("boom"); } };
  assert.equal(await main({ log, steps: [ok] }), 0);
  assert.equal(await main({ log, steps: [ok, bad] }), 1);
  assert.ok(lines.some((line) => /^FAIL\s+02/.test(line)) && lines.some((line) => line.includes("boom")));
  assert.ok(lines.some((line) => /1 passed, 1 failed/.test(line)));
  assert.equal(await main({ log, steps: [{ ...ok, fn: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); } }], limitMs: 1 }), 1, "too slow is a failure");
  const summary = await runSteps([bad, ok], { log });
  assert.deepEqual([summary.passed, summary.failed], [1, 1]);
});

test("website/docs/cli/demo.md matches the script: every step title is in the docs table, the command and sidebar position are right", () => {
  const docs = readFileSync(DOCS, "utf8");
  assert.match(docs, /^sidebar_position: 12$/m);
  assert.ok(docs.includes("npm run demo:hris-014"));
  const root = JSON.parse(readFileSync(join(dirname(SCRIPT), "..", "..", "..", "package.json"), "utf8"));
  assert.equal(root.scripts["demo:hris-014"], "node packages/cli/scripts/demo-hris-014.mjs");
  const ids = [...runDemo().result.stdout.matchAll(/^PASS\s+(\d\d)\s/gm)].map((match) => match[1]);
  for (const id of ids) assert.match(docs, new RegExp(`^\\| ${id} \\|`, "m"), `step ${id} is documented`);
  assert.equal([...docs.matchAll(/^\| \d\d \|/gm)].length, ids.length, "no documented step is missing from the script");
  for (const [area] of COVERAGE) assert.ok(docs.includes(area.split(" (")[0]), `coverage row in docs: ${area}`);
});
