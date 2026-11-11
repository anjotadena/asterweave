#!/usr/bin/env node

// The contribution demo: one genuine, reproducible bug (tests/fixtures/contrib-bug) taken from a symptom to a contribution summary,
// plus a blocked check, a discovery-only run and a cancellation. The real bin runs the workflow; the checks (node --test) really
// execute in a temp git repository; the executor is a script that replays those results. No model, no network, no remote write.
//
//   node packages/cli/scripts/demo-contribute.mjs          (or: npm run demo:contribute)
//
// Prints PASS/FAIL per step and exits non-zero if any step failed. Zero dependencies.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SYMPTOM, cli, contributeScript, contributionSummary, doFixWork, makeBox, recordStructured, runDirOf, runUnavailableCheck } from "../tests/contribution-fixture.mjs";
import { cleanupTemp, git } from "../tests/repo-fixture.mjs";

let failures = 0;
const step = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const json = (result) => JSON.parse(result.out);
const fake = (file, runId, graph) => ["run", "start", "--executor", "fake", "--script", file, "--graph", graph, "--goal", SYMPTOM, "--run-id", runId, "--json"];

try {
  const box = makeBox("aw-demo-contribute-");
  console.log(`Fixture repository: ${box.repo}\nUser directory:     ${box.userDir}\n`);

  const route = json(cli(box, ["skill", "route", SYMPTOM, "--json"])).route;
  step("1 symptom routes to bug-fix (automatic routing)", route.skill === "bug-fix" && route.workflow === "bugfix", `${route.skill} / ${route.workflow} / scope ${route.scope}`);
  step("2 bug-fix resolves explicitly with its source", json(cli(box, ["skill", "show", "bug-fix", "--json"])).skill.source === "bundled");

  const work = doFixWork(box.repo);
  step("3 baseline suite passes before any change", work.baseline.ok, `${work.baseline.pass} passed`);
  step("4 bug reproduced: the regression test fails on the unfixed code", !work.beforeFix.ok, `${work.beforeFix.fail} failed at ${work.rootCause?.file}:${work.rootCause?.line}`);
  step("5 fix applied and the regression check passes", work.afterFix.ok, `${work.afterFix.pass} passed`);
  step("6 diff reviewed: only the fix and its test, no secrets", work.diffClean, work.changedFiles.join(", "));

  const done = cli(box, fake(box.scriptFile(contributeScript(work)), "demo-fix", "contribute@1"));
  recordStructured(box, "demo-fix", work);
  const shown = json(cli(box, ["run", "show", "demo-fix", "--json"])).run;
  step("7 contribute@1 ran to completion through the real run engine", done.code === 0 && shown.status === "completed", `${shown.contribution.stagesPassed} stages passed`);
  step("8 no remote action was taken", shown.contribution.remote.length === 0 && shown.contribution.scope === "implement");
  console.log(`\n${cli(box, ["run", "show", "demo-fix"]).out}`);
  console.log("Contribution summary (local draft, nothing published):\n");
  console.log(contributionSummary(work));
  console.log();

  const discovery = makeBox("aw-demo-audit-");
  const steps = contributeScript(work).steps.filter((s) => ["discover", "audit", "triage"].includes(s.node));
  const before = git(discovery.repo, "status", "--porcelain");
  const audit = cli(discovery, ["run", "start", "--executor", "fake", "--script", discovery.scriptFile({ v: 1, steps }), "--graph", "audit@1", "--goal", "Audit this repository", "--run-id", "demo-audit", "--json"]);
  const auditView = json(cli(discovery, ["run", "show", "demo-audit", "--json"])).run;
  step("9 discovery-only run ends with reviewed findings and changes nothing", audit.code === 0 && auditView.nodes.length === 3 && git(discovery.repo, "status", "--porcelain") === before);

  const blockedBox = makeBox("aw-demo-blocked-");
  const blockedWork = doFixWork(blockedBox.repo);
  const unavailable = runUnavailableCheck(blockedBox.repo);
  const blocked = cli(blockedBox, fake(blockedBox.scriptFile(contributeScript(blockedWork, { unavailable })), "demo-blocked", "contribute@1"));
  const blockedView = json(cli(blockedBox, ["run", "show", "demo-blocked", "--json"])).run;
  step("10 a check that cannot run stays blocked, not passed", !unavailable.ran && blocked.code === 1 && blockedView.status === "blocked" && blockedView.currentNode === "test-verify", `required check unavailable: ${unavailable.reason}`);
  const abort = cli(blockedBox, ["run", "abort", "demo-blocked", "--yes"]);
  const abortedView = json(cli(blockedBox, ["run", "show", "demo-blocked", "--json"])).run;
  step("11 cancellation ends the run cleanly (aborted, no lock left)", abort.code === 0 && abortedView.status === "aborted" && abortedView.lock.state === "none");
  step("12 the recorded scope is on disk and unchanged", JSON.parse(readFileSync(join(runDirOf(blockedBox, "demo-blocked"), "contribution.json"), "utf8")).scope.level === "implement");
} finally {
  cleanupTemp();
}

console.log(`\n${failures === 0 ? "All steps passed." : `${failures} step(s) failed.`}`);
console.log("Coverage: FIXTURE ONLY. No live model, no network, no GitHub, no remote write; the executor is a script replaying real local check results.");
process.exitCode = failures === 0 ? 0 : 1;
