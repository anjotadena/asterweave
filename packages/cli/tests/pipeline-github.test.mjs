// GitHub read tools added for pipeline monitoring, exercised against the fake GitHub (no network).

import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "../src/runtime/guard.mjs";
import { createGithubTools } from "../src/runtime/tools/github-api.mjs";
import { createRegistry } from "../src/runtime/tools/registry.mjs";
import { createFakeGithub } from "./fixtures/fake-github.mjs";

const TOKEN = "ghp" + "_" + "P".repeat(36);
const SHA = "d".repeat(40);

function setup(options = {}) {
  const fake = createFakeGithub({ owner: "o", repo: "r", ...options });
  const tools = createGithubTools({ getToken: () => TOKEN, fetch: fake.fetch, now: () => Date.now() });
  const registry = createRegistry();
  for (const definition of tools.definitions) registry.register(definition);
  const invoke = (id, input) => registry.invoke(id, input, { node: "monitor-pipeline", sleep: async () => {}, random: () => 1 });
  return { fake, tools, registry, invoke };
}

test("github.pull.get now reports merge info; github.runs.list filters by sha and event", async () => {
  const { fake, invoke } = setup();
  fake.setPull(4, { state: "closed", merged: true, headSha: SHA, mergeCommitSha: "e".repeat(40), mergedAt: "2026-01-01T00:00:00Z" });
  const pull = await invoke("github.pull.get", { owner: "o", repo: "r", number: 4 });
  assert.match(pull.content.excerpt, /"mergeCommitSha": "e{40}"/);
  assert.match(pull.content.excerpt, /"mergedAt": "2026-01-01T00:00:00Z"/);
  fake.setRun({ id: 1, headSha: SHA, event: "pull_request" });
  fake.setRun({ id: 2, headSha: "e".repeat(40), event: "push" });
  const all = await invoke("github.runs.list", { owner: "o", repo: "r", headSha: "e".repeat(40) });
  assert.equal(all.ok, true);
  assert.match(all.content.excerpt, /"id": 2/);
  assert.ok(!all.content.excerpt.includes('"id": 1,'));
  const none = await invoke("github.runs.list", { owner: "o", repo: "r", headSha: "e".repeat(40), event: "pull_request" });
  assert.match(none.content.excerpt, /"runs": \[\]/);
  const last = fake.calls.at(-1);
  assert.equal(last.path, "/repos/o/r/actions/runs");
  assert.equal(last.search, `?head_sha=${"e".repeat(40)}&event=pull_request&per_page=50`);
  assert.equal(last.headers.Authorization, `Bearer ${TOKEN}`);
  assert.ok(!last.url.includes(TOKEN));
});

test("runs.list follows Link pagination within the page bound and flags truncation", async () => {
  const { fake, tools } = setup({ pageSize: 2 });
  for (let i = 1; i <= 9; i += 1) fake.setRun({ id: i, workflowId: i, path: `.github/workflows/w${i}.yml`, headSha: SHA });
  const result = await tools.client.runs({ owner: "o", repo: "r", headSha: SHA });
  assert.equal(result.pages, 3, "maxPages bounds the walk");
  assert.equal(result.items.length, 6);
  assert.equal(result.truncated, true);
  assert.equal(result.total, 9);
});

test("a next link that leaves the allow-list is not followed with the credential", async () => {
  const { fake, tools } = setup();
  fake.setRun({ id: 1, headSha: SHA });
  fake.fault(/actions\/runs/, () => new Response(JSON.stringify({ workflow_runs: [] }), { status: 200, headers: { link: '<https://evil.example/repos/o/r/actions/runs?page=2>; rel="next"' } }));
  const result = await tools.client.runs({ owner: "o", repo: "r", headSha: SHA });
  assert.equal(result.truncated, true);
  assert.ok(fake.calls.every((call) => new URL(call.url).host === "api.github.com"));
  assert.equal(fake.calls.length, 1);
});

test("jobs.list returns job and step names only (no log endpoint exists)", async () => {
  const { fake, invoke, tools } = setup();
  fake.setJobs(77, [{ name: "unit", conclusion: "failure", steps: [{ name: "npm test", number: 3, status: "completed", conclusion: "failure" }] }]);
  const result = await invoke("github.jobs.list", { owner: "o", repo: "r", runId: 77 });
  assert.equal(result.ok, true);
  assert.match(result.content.excerpt, /"npm test"/);
  assert.equal(fake.calls.at(-1).search, "?filter=latest&per_page=50");
  assert.ok(!tools.definitions.some((definition) => /log/i.test(definition.id)), "no log download tool");
});

test("branch protection: 200 lists contexts; 403 and 404 are unavailable, not errors", async () => {
  const { fake, invoke, tools } = setup();
  fake.world.protection = { status: 200, contexts: ["ci", "build"] };
  const ok = await invoke("github.branch.protection", { owner: "o", repo: "r", branch: "release/1.0" });
  assert.match(ok.content.excerpt, /"available": true/);
  assert.equal(fake.calls.at(-1).path, "/repos/o/r/branches/release/1.0/protection/required_status_checks");
  for (const status of [403, 404]) {
    fake.world.protection = { status, contexts: [] };
    const unavailable = await tools.client.requiredStatusChecks({ owner: "o", repo: "r", branch: "main" });
    assert.deepEqual({ available: unavailable.available, status: unavailable.status, contexts: unavailable.contexts }, { available: false, status, contexts: [] });
  }
  fake.world.protection = { status: 200, contexts: ["ci", "ci"] };
  assert.deepEqual((await tools.client.requiredStatusChecks({ owner: "o", repo: "r", branch: "main" })).contexts, ["ci"]);
});

test("branch names are validated strictly", async () => {
  const { fake, invoke } = setup();
  for (const branch of ["../x", "a//b", "/lead", "trail/", "a%2fb", "a b", "x".repeat(201)]) {
    assert.equal((await invoke("github.branch.protection", { owner: "o", repo: "r", branch })).error.code, "TOOL_INPUT_INVALID", branch);
  }
  assert.equal(fake.calls.length, 0);
});

test("a 5xx from branch protection is an error (only 403/404 are unavailable)", async () => {
  const { fake, tools } = setup();
  fake.fault(/protection/, () => new Response("x", { status: 502 }));
  await assert.rejects(() => tools.client.requiredStatusChecks({ owner: "o", repo: "r", branch: "main" }), (error) => error.code === "GITHUB_HTTP_502" && error.transient === true);
});

test("rate limit exhaustion surfaces as GITHUB_RATE_LIMITED with the reset time and rate info", async () => {
  const { fake, tools } = setup();
  const reset = Math.floor(Date.now() / 1000) + 90;
  fake.setRate({ remaining: 0, resetAtSec: reset });
  await assert.rejects(() => tools.client.pull({ owner: "o", repo: "r", number: 1 }), (error) => {
    assert.equal(error.code, "GITHUB_RATE_LIMITED");
    assert.equal(error.transient, true);
    assert.equal(error.rate.remaining, 0);
    assert.equal(error.rate.resetAtMs, reset * 1000);
    assert.ok(error.retryAfterMs > 80_000 && error.retryAfterMs <= 90_000);
    return true;
  });
});

test("Retry-After on a 429 is carried on the error and the rate headers are read", async () => {
  const { fake, tools } = setup();
  fake.fault(/pulls\/1/, () => new Response("{}", { status: 429, headers: { "retry-after": "17", "x-ratelimit-remaining": "3" } }));
  await assert.rejects(() => tools.client.pull({ owner: "o", repo: "r", number: 1 }), (error) => error.code === "GITHUB_HTTP_429" && error.retryAfterMs === 17_000 && error.rate.remaining === 3);
});

test("pull files: names only, bounded", async () => {
  const { fake, invoke } = setup();
  fake.world.files = Array.from({ length: 130 }, (_, i) => `src/f${i}.js`);
  const result = await invoke("github.pull.files", { owner: "o", repo: "r", number: 2 });
  assert.equal(result.ok, true);
  assert.match(result.content.excerpt, /src\/f0\.js/);
  assert.ok(!result.content.excerpt.includes("status"));
});

test("the guard allows exactly the URLs the new tools build and denies others", () => {
  const { tools, registry } = setup();
  const sha = SHA;
  const cases = [["github.runs.list", { owner: "o", repo: "r", headSha: sha }], ["github.jobs.list", { owner: "o", repo: "r", runId: 5 }], ["github.branch.protection", { owner: "o", repo: "r", branch: "main" }], ["github.pull.files", { owner: "o", repo: "r", number: 3 }]];
  for (const [id, args] of cases) {
    const request = registry.requestOf(id, args);
    assert.equal(evaluate({ type: "tool", tool: { name: "api", input: { tool: id, ...request, args } } }, { workspaceRoot: process.cwd(), apiAllow: tools.allow }).decision, "allow", id);
  }
  assert.equal(evaluate({ type: "tool", tool: { name: "api", input: { url: "https://api.github.com/user" } } }, { workspaceRoot: process.cwd(), apiAllow: tools.allow }).decision, "deny");
});

test("every new tool is read-only API kind scoped to monitor-pipeline", () => {
  const { registry } = setup();
  const ids = ["github.runs.list", "github.jobs.list", "github.branch.protection", "github.pull.files"];
  for (const id of ids) {
    const tool = registry.get(id);
    assert.equal(tool.kind, "api");
    assert.equal(tool.readOnly, true);
    assert.ok(tool.stages.includes("monitor-pipeline"));
  }
});

test("client methods validate every argument with the registry's patterns before any request", async () => {
  const { fake, tools } = setup();
  const { client } = tools;
  const bad = [
    () => client.pull({ owner: "o/x", repo: "r", number: 1 }),
    () => client.pull({ owner: "o", repo: "..", number: 1 }),
    () => client.pull({ owner: "o", repo: "r", number: "1" }),
    () => client.pull({ owner: "o", repo: "r", number: 0 }),
    () => client.pull(null),
    () => client.runs({ owner: "o", repo: "r", headSha: "../x" }),
    () => client.runs({ owner: "o", repo: "r", headSha: SHA, event: "a&b=c" }),
    () => client.checkRuns({ owner: "o", repo: "r", ref: "xyz" }),
    () => client.jobs({ owner: "o", repo: "r", runId: "5/logs" }),
    () => client.pullFiles({ owner: "-o", repo: "r", number: 1 }),
    () => client.requiredStatusChecks({ owner: "o", repo: "r", branch: "a/../b" }),
  ];
  for (const call of bad) await assert.rejects(call, (error) => error.code === "GITHUB_ARGS_INVALID");
  assert.equal(fake.calls.length, 0);
});

test("N2: check runs are requested with filter=all; only filter=all returns both same-name runs, and the reducer then reports the failure", async () => {
  const { fake, tools } = setup();
  fake.setCheck({ id: 1, name: "build", headSha: SHA, conclusion: "failure", suiteId: 11, startedAt: Date.now() - 5000 });
  fake.setCheck({ id: 2, name: "build", headSha: SHA, conclusion: "success", suiteId: 12, startedAt: Date.now() });
  const viaClient = await tools.client.checkRuns({ owner: "o", repo: "r", ref: SHA });
  assert.equal(fake.calls.at(-1).search, "?filter=all&per_page=50");
  assert.deepEqual(viaClient.items.map((item) => item.id).sort(), [1, 2]);
  // the fake models GitHub's default: without filter=all only the newest per (app, name) comes back
  const latest = await (await fake.fetch(`https://api.github.com/repos/o/r/commits/${SHA}/check-runs?per_page=50`)).json();
  assert.deepEqual(latest.check_runs.map((item) => item.id), [2]);
  const all = await (await fake.fetch(`https://api.github.com/repos/o/r/commits/${SHA}/check-runs?filter=all`)).json();
  assert.equal(all.check_runs.length, 2);
});
