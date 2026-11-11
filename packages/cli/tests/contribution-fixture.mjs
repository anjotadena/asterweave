// Shared by tests/contribution-*.test.mjs and scripts/demo-contribute.mjs (not a test file: the runner picks *.test.mjs only).
//
// The fixture is a small module with a genuine, reproducible bug (tests/fixtures/contrib-bug): going back from a project page
// loses the search text. `doFixWork` performs the REAL work in a temp git repository - it runs `node --test`, writes the regression
// test, watches it fail, applies the fix, watches it pass, and inspects the diff - and returns what actually happened.
// The scripted (fake) executor then replays those real results into the contribute@1 ledger, so the graph, the evidence and the
// monitor are real while no model is involved. Everything here is a fixture, never a live run.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { addFinding, selectTask, setFindingStatus } from "../src/runtime/contribution.mjs";
import { git, tempDir } from "./repo-fixture.mjs";

export const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/contrib-bug/", import.meta.url));
export const BIN = fileURLToPath(new URL("../bin/asterweave.mjs", import.meta.url));
export const SYMPTOM = "Search resets when I open a project and go back";

export const REGRESSION_TEST = `import assert from "node:assert/strict";
import test from "node:test";
import { createNav } from "../src/nav.mjs";

test("the search text survives opening a project and going back", () => {
  const nav = createNav();
  nav.setSearch("road");
  nav.openProject("p1");
  nav.goBack();
  assert.deepEqual(nav.view, { page: "list", search: "road" });
});

test("going back twice restores each page's own search", () => {
  const nav = createNav();
  nav.setSearch("a");
  nav.openProject("p1");
  nav.setSearch("b");
  nav.openProject("p2");
  nav.goBack();
  assert.equal(nav.view.search, "b");
  nav.goBack();
  assert.equal(nav.view.search, "a");
});
`;

/** An isolated user directory, home and git repository seeded from the fixture. */
export function makeBox(prefix = "aw-contrib-") {
  const root = tempDir(prefix);
  const userDir = join(root, "user");
  const home = join(root, "home");
  const repo = join(root, "repo");
  for (const dir of [userDir, home, repo]) mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE_DIR, repo, { recursive: true });
  git(repo, "init", "-b", "main");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "initial");
  const env = { ASTERWEAVE_CONFIG_DIR: userDir, ASTERWEAVE_DEV_EXECUTORS: "1", HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData"), LOCALAPPDATA: join(home, "AppData") };
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  let counter = 0;
  const scriptFile = (script) => {
    const file = join(root, `script-${counter++}.json`);
    writeFileSync(file, JSON.stringify(script));
    return file;
  };
  return { root, userDir, home, repo, env, scriptFile };
}

/** Synchronous CLI call against the real bin. */
export function cli(box, args, { cwd = box.repo, timeout = 120_000 } = {}) {
  const result = spawnSync(process.execPath, [BIN, ...args], { cwd, env: box.env, input: "", encoding: "utf8", timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const lastLine = (text, pattern) => text.split(/\r?\n/).filter((line) => pattern.test(line)).pop() ?? "";
function nodeTest(repo, args = []) {
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env; // a nested runner started inside a test would otherwise behave as a child of the outer one
  const result = spawnSync(process.execPath, ["--test", ...args], { cwd: repo, env, encoding: "utf8", timeout: 60_000 });
  const out = `${result.stdout}${result.stderr}`;
  return { ok: result.status === 0, code: result.status, pass: Number(lastLine(out, /^# pass /).replace("# pass ", "")), fail: Number(lastLine(out, /^# fail /).replace("# fail ", "")), out };
}

/** The real work of the fix, in `repo`. Returns the facts the evidence will carry. */
export function doFixWork(repo) {
  const work = { steps: [] };
  const note = (name, detail) => work.steps.push({ name, ...detail });

  work.baseline = nodeTest(repo);
  note("baseline", { ok: work.baseline.ok });

  writeFileSync(join(repo, "test", "search-restore.test.mjs"), REGRESSION_TEST);
  work.beforeFix = nodeTest(repo);
  note("reproduction", { reproduced: !work.beforeFix.ok });

  const source = readFileSync(join(repo, "src", "nav.mjs"), "utf8");
  const line = source.split("\n").findIndex((text) => text.includes('{ ...previous, search: "" }')) + 1;
  work.rootCause = line > 0 ? { file: "src/nav.mjs", line, text: "goBack() rebuilds the previous view with search reset to an empty string" } : null;

  if (work.rootCause) {
    writeFileSync(join(repo, "src", "nav.mjs"), source.replace('previous ? { ...previous, search: "" } : view', "previous ?? view"));
  }
  work.afterFix = nodeTest(repo);
  note("regression", { passed: work.afterFix.ok });

  const status = git(repo, "status", "--porcelain").split(/\r?\n/).filter(Boolean).map((row) => row.slice(3).trim()).sort();
  const diff = git(repo, "diff");
  work.changedFiles = status;
  work.diffStat = git(repo, "diff", "--stat");
  work.diffClean = !/(?:gh[opurs]_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|password\s*=)/.test(diff) && status.every((file) => ["src/nav.mjs", "test/search-restore.test.mjs"].includes(file));
  return work;
}

/** A required check that cannot run here: really attempted, really unavailable. */
export function runUnavailableCheck(repo) {
  const result = spawnSync("asterweave-fixture-lint-not-installed", ["--check"], { cwd: repo, encoding: "utf8", timeout: 10_000 });
  return { ran: result.error === undefined, reason: result.error ? String(result.error.code ?? result.error.message) : "ran" };
}

const ev = (kind, summary, result = "pass") => ({ v: 1, type: "evidence", evidence: { kind, summary, result } });
const done = (outcome = "pass", signature) => ({ v: 1, type: "complete", outcome, ...(signature ? { signature } : {}) });
const steps = (node, kinds, outcome, extra = {}) => [...kinds.map(([kind, summary, result]) => ({ node, action: ev(kind, summary, result) })), { node, action: done(outcome, extra.signature), ...(extra.delayMs ? { delayMs: extra.delayMs } : {}) }];

/** The contribute@1 script that replays `work`. `unavailable` turns test-verify into a blocked stage; `slowImplement` makes implement long enough to interrupt. */
export function contributeScript(work, { unavailable = null, slowImplement = false } = {}) {
  const tests = (r) => `${r.pass} passed, ${r.fail} failed`;
  const all = [];
  all.push(...steps("discover", [["repository", "fixture repository on branch main, no license file in the fixture, node --test is the check", "pass"], ["baseline", `baseline suite: ${tests(work.baseline)}`, work.baseline.ok ? "pass" : "fail"]], "pass"));
  all.push(...steps("audit", [["finding", `F-1 suspected->reproduced: "${SYMPTOM}"; goBack() resets search (${work.rootCause?.file}:${work.rootCause?.line})`, "pass"]], "pass"));
  all.push(...steps("triage", [["triage", "no duplicate in the fixture, reproduced locally, scope: one function, decision: fix now", "pass"]], "pass"));
  all.push(...steps("select", [["acceptance-criteria", "search text is kept when going back; going back from the root keeps the view", "pass"], ["reproduction", `regression test fails before the fix (${tests(work.beforeFix)})`, work.beforeFix.ok ? "fail" : "pass"]], "pass"));
  if (slowImplement) all.push({ node: "implement", action: { v: 1, type: "tool", tool: { name: "read", input: { path: "src/nav.mjs" } } }, delayMs: 8_000 });
  all.push(...steps("implement", [["change", `src/nav.mjs goBack() keeps the stored view; changed: ${work.changedFiles.join(", ")}`, "pass"]], "pass"));
  if (unavailable) {
    all.push(...steps("test-verify", [["regression-test", `focused suite ${tests(work.afterFix)}; required check asterweave-fixture-lint could not run (${unavailable.reason})`, "info"]], "blocked", { signature: "check-unavailable:lint" }));
  } else {
    all.push(...steps("test-verify", [["regression-test", `after the fix: ${tests(work.afterFix)}; before the fix it failed (${tests(work.beforeFix)})`, work.afterFix.ok ? "pass" : "fail"]], "pass"));
    all.push(...steps("pr-review", [["code-review", `diff reviewed: ${work.changedFiles.join(", ")}; no secrets, no generated noise, no weakened tests`, work.diffClean ? "pass" : "fail"]], "pass"));
    all.push(...steps("pr-prepare", [["contribution-package", "local package written: title, body, validation summary; nothing pushed, no PR opened", "pass"]], "pass"));
  }
  return { v: 1, steps: all };
}

/** The contribution summary a maintainer would read. Lists only checks that were executed. */
export function contributionSummary(work) {
  return [
    "Keep the search text when navigating back from a project page",
    "",
    `Problem: "${SYMPTOM}". goBack() rebuilt the previous view with an empty search (${work.rootCause?.file}:${work.rootCause?.line}).`,
    "Change: goBack() restores the stored view unchanged.",
    "",
    "Validation (executed):",
    `- node --test before the change (baseline): ${work.baseline.pass} passed, ${work.baseline.fail} failed`,
    `- regression test before the fix: ${work.beforeFix.pass} passed, ${work.beforeFix.fail} failed (reproduces the bug)`,
    `- node --test after the fix: ${work.afterFix.pass} passed, ${work.afterFix.fail} failed`,
    `- files changed: ${work.changedFiles.join(", ")}`,
    "",
    "Not run: any check outside this fixture. Remote actions: none.",
  ].join("\n");
}

/** The structured records a person (or the skill) would write: the finding, its reproduction and the selected task. Library calls, run by the harness. */
export function recordStructured(box, runId, work) {
  const dir = runDirOf(box, runId);
  const finding = addFinding(dir, { title: SYMPTOM, category: "functionality", location: `${work.rootCause.file}:${work.rootCause.line}`, commit: git(box.repo, "rev-parse", "HEAD").trim(), expected: "the search text is kept when going back", observed: "the search text is cleared", impact: "users lose their query on every back navigation", severity: "medium", severityRationale: "no data loss; repeated friction on a core journey", confidence: "high", ownership: "repository-code" });
  setFindingStatus(dir, finding.id, "reproduced", { reproduction: ["set the search to 'road'", "open a project", "go back"] });
  setFindingStatus(dir, finding.id, "fixed-locally");
  setFindingStatus(dir, finding.id, "verified", { evidence: ["test/search-restore.test.mjs: 2 passed after the fix, 2 failed before"] });
  selectTask(dir, { title: "Keep the search text when navigating back", acceptance: ["search is kept after back", "back from the root keeps the view"], findingId: finding.id, reproduction: ["open a project", "go back"] });
  return finding.id;
}

export const runDirOf = (box, runId) => {
  const runs = join(box.userDir, "runs");
  if (!existsSync(runs)) return null;
  for (const name of readdirSync(runs)) if (existsSync(join(runs, name, runId))) return join(runs, name, runId);
  return null;
};
