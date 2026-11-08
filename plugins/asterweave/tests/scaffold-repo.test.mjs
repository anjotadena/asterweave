import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyBlueprint,
  inventoryRepository,
  resolveRoute,
  validateBlueprint,
  verifyScaffold,
} from "../scripts/scaffold-repo.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "asterweave-scaffold-"));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function artifact(path, kind, content, evidence = ["package.json"], extra = {}) {
  return { path, kind, operation: "create", rationale: `Repository evidence supports ${path}`, evidence, content, ...extra };
}

function completeBlueprint() {
  return {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Angular repository scaffold",
    artifacts: [
      artifact("CLAUDE.md", "instructions", "# Repository instructions\n\nUse [repository details](.claude/references/repository.md).\n"),
      artifact(".claude/references/repository.md", "reference", "# Repository details\n\nThe application entry point is `src/main.ts`.\n"),
      artifact(".claude/rules/angular.md", "rule", "---\npaths:\n  - \"src/**/*.ts\"\n---\n\n# Angular rules\n\nFollow the standalone component pattern already used in `src/main.ts`.\n"),
      artifact(".claude/skills/check-change/SKILL.md", "skill", "---\nname: check-change\ndescription: Run the repository-defined validation commands after changing application code.\ndisable-model-invocation: true\n---\n\n# Check a change\n\nRun `npm test` and report the exact result.\n"),
      artifact(".claude/agents/angular-reviewer.md", "agent", "---\nname: angular-reviewer\ndescription: Reviews Angular changes against this repository's established standalone patterns.\nmodel: sonnet\ntools: Read, Grep, Glob, Bash\n---\n\nReview complete touched files and tests. Remain read-only.\n"),
      artifact(".claude/asterweave.json", "adapter", `${JSON.stringify({
        version: 1,
        routing: { review: { agent: "angular-reviewer", skills: ["check-change"] } },
        qualityGates: { required: [{ id: "unit-test", command: "npm test", source: "package.json#scripts.test", timeoutSeconds: 600 }] },
      }, null, 2)}\n`),
    ],
  };
}

test("inventories, plans, applies, verifies, and routes an evidence-backed scaffold", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { "@angular/core": "20.0.0" }, scripts: { test: "ng test --watch=false" } }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");

  const inventory = inventoryRepository(root);
  assert.ok(inventory.stack.frameworks.includes("Angular"));
  assert.ok(inventory.evidenceCandidates.includes("package.json"));

  const blueprint = completeBlueprint();
  const plan = validateBlueprint(blueprint, root);
  assert.equal(plan.valid, true, plan.errors.join("\n"));
  assert.match(plan.approvalDigest, /^[a-f0-9]{64}$/);
  const applied = applyBlueprint(blueprint, { root, approval: plan.approvalDigest });
  assert.equal(applied.applied.length, blueprint.artifacts.length);
  assert.equal(existsSync(join(root, ".claude", "asterweave-scaffold.json")), true);
  assert.deepEqual(verifyScaffold(root).errors, []);
  const route = resolveRoute("review", root);
  assert.equal(route.route.agent, "angular-reviewer");
  assert.deepEqual(route.route.skills, ["check-change"]);
});

test("requires exact current hashes and rejects drift between approval and apply", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  const original = "# Existing\n";
  writeFileSync(join(root, "CLAUDE.md"), original);
  const blueprint = {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Merge existing instructions",
    artifacts: [artifact("CLAUDE.md", "instructions", "# Existing\n\nKeep changes scoped.\n", ["package.json"], { operation: "replace" })],
  };
  assert.equal(validateBlueprint(blueprint, root).valid, false);
  blueprint.artifacts[0].expectedSha256 = hash(original);
  const plan = validateBlueprint(blueprint, root);
  assert.equal(plan.valid, true, plan.errors.join("\n"));
  writeFileSync(join(root, "CLAUDE.md"), "# User changed this after preview\n");
  assert.throws(() => applyBlueprint(blueprint, { root, approval: plan.approvalDigest }), /expectedSha256/);
  assert.match(readFileSync(join(root, "CLAUDE.md"), "utf8"), /User changed/);
});

test("refresh updates approved files and marks untouched managed artifacts stale without deleting them", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  const initial = completeBlueprint();
  const initialPlan = validateBlueprint(initial, root);
  assert.equal(initialPlan.valid, true, initialPlan.errors.join("\n"));
  applyBlueprint(initial, { root, approval: initialPlan.approvalDigest });

  const current = readFileSync(join(root, "CLAUDE.md"), "utf8");
  const refresh = {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Refresh concise root instructions",
    artifacts: [artifact("CLAUDE.md", "instructions", `${current}\nUse repository-native test commands.\n`, ["package.json"], {
      operation: "replace",
      expectedSha256: hash(current),
    })],
  };
  const refreshPlan = validateBlueprint(refresh, root);
  assert.equal(refreshPlan.valid, true, refreshPlan.errors.join("\n"));
  const applied = applyBlueprint(refresh, { root, approval: refreshPlan.approvalDigest });
  assert.ok(applied.verification.warnings.some((warning) => /stale/.test(warning)));
  assert.equal(existsSync(join(root, ".claude", "skills", "check-change", "SKILL.md")), true);
  const manifest = JSON.parse(readFileSync(join(root, ".claude", "asterweave-scaffold.json"), "utf8"));
  assert.equal(manifest.artifacts.find(({ path }) => path === ".claude/skills/check-change/SKILL.md").stale, true);
});

test("rejects path traversal, likely secrets, and unresolved placeholders", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  const blueprint = {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Unsafe proposal",
    artifacts: [
      artifact("../CLAUDE.md", "instructions", "# Escaped\n"),
      artifact(".claude/references/unsafe.md", "reference", `# TODO\n\n${`ghp_${"a".repeat(24)}`}\n`),
    ],
  };
  const result = validateBlueprint(blueprint, root);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /safe repository-relative path/.test(error)));
  assert.ok(result.errors.some((error) => /unresolved placeholder/.test(error)));
  assert.ok(result.errors.some((error) => /secret or private key/.test(error)));
});

test("rejects writes through a symlinked configuration directory", (t) => {
  const root = workspace();
  const external = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  try {
    symlinkSync(external, join(root, ".claude"), "dir");
  } catch (error) {
    t.skip(`Symlinks are unavailable: ${error.message}`);
    return;
  }
  const blueprint = {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Symlink proposal",
    artifacts: [artifact(".claude/rules/app.md", "rule", "---\npaths:\n  - \"src/**\"\n---\n\n# App\n\nKeep changes scoped.\n")],
  };
  const result = validateBlueprint(blueprint, root);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => /symlink/.test(error)));
  assert.equal(existsSync(join(external, "rules", "app.md")), false);
});

test("rejects destructive quality gates and missing adapter definitions", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  const blueprint = {
    schemaVersion: 1,
    pluginVersion: "0.2.1",
    summary: "Unsafe adapter",
    artifacts: [artifact(".claude/asterweave.json", "adapter", `${JSON.stringify({
      version: 1,
      routing: { test: { agent: "missing-agent", skills: ["missing-skill"] } },
      qualityGates: { required: [{ id: "cleanup", command: "git reset --hard HEAD", source: "README.md" }] },
    })}\n`)],
  };
  const plan = validateBlueprint(blueprint, root);
  assert.equal(plan.valid, false);
  assert.ok(plan.errors.some((error) => /destructive/.test(error)));
});

test("accepts provider and post-PR routing stages, rejects an unsupported provider value", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  mkdirSync(join(root, ".claude", "agents"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "agents", "pipeline-watcher.md"),
    "---\nname: pipeline-watcher\ndescription: Watches this repository's required pipeline checks.\nmodel: sonnet\ntools: Read, Bash\n---\n\nWatch CI.\n",
  );
  writeFileSync(
    join(root, ".claude", "asterweave.json"),
    JSON.stringify({
      version: 1,
      provider: { workItems: "azure-devops" },
      routing: { "monitor-pipeline": { agent: "pipeline-watcher" } },
    }),
  );
  const verification = verifyScaffold(root);
  assert.deepEqual(verification.errors, []);
  const route = resolveRoute("monitor-pipeline", root);
  assert.equal(route.route.agent, "pipeline-watcher");

  writeFileSync(
    join(root, ".claude", "asterweave.json"),
    JSON.stringify({ version: 1, provider: { workItems: "bitbucket" } }),
  );
  assert.ok(verifyScaffold(root).errors.some((error) => /provider.workItems/.test(error)));
});

test("accepts documented completion and handoff adapter settings and rejects invalid ones", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const adapterPath = join(root, ".claude", "asterweave.json");
  writeFileSync(
    adapterPath,
    JSON.stringify({
      version: 1,
      completion: { parallelism: { maxWorkers: 4 } },
      handoff: { staleAfterHours: 12, expireAfterHours: 168, track: false, contextBudget: { warnAtTokens: 150000 } },
    }),
  );
  assert.deepEqual(verifyScaffold(root).errors, []);

  writeFileSync(adapterPath, JSON.stringify({ version: 1, handoff: { staleAfterHours: 0, contextBudget: { warnAtTokens: 10 }, directory: "/tmp" } }));
  const errors = verifyScaffold(root).errors.join("\n");
  assert.match(errors, /handoff has unsupported field directory/);
  assert.match(errors, /handoff.staleAfterHours must be a positive number/);
  assert.match(errors, /warnAtTokens must be an integer of at least 1000/);

  writeFileSync(adapterPath, JSON.stringify({ version: 1, completion: { parallelism: { maxWorkers: 40 } } }));
  assert.match(verifyScaffold(root).errors.join("\n"), /maxWorkers must be an integer from 1 to 12/);
});

test("accepts documented autoContinue settings and rejects invalid ones", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const adapterPath = join(root, ".claude", "asterweave.json");
  writeFileSync(adapterPath, JSON.stringify({ version: 1, autoContinue: { enabled: true, maxNudges: 40 } }));
  assert.deepEqual(verifyScaffold(root).errors, []);

  writeFileSync(adapterPath, JSON.stringify({ version: 1, autoContinue: { enabled: "yes", maxNudges: 0, forever: true } }));
  const errors = verifyScaffold(root).errors.join("\n");
  assert.match(errors, /autoContinue has unsupported field forever/);
  assert.match(errors, /autoContinue.enabled must be a boolean/);
  assert.match(errors, /autoContinue.maxNudges must be an integer from 1 to 200/);
});

test("accepts valid repository hooks and rejects invalid ones, consistent with the adapter schema", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const adapterPath = join(root, ".claude", "asterweave.json");
  const hook = (overrides = {}) => ({ id: "audit", event: "tool.before", argv: ["node", "scripts/audit.mjs", "--strict"], kind: "validate", timeoutMs: 5000, onFailure: "block", ...overrides });
  const errorsFor = (adapter) => {
    writeFileSync(adapterPath, JSON.stringify({ version: 1, ...adapter }));
    return verifyScaffold(root).errors.join("\n");
  };

  assert.equal(errorsFor({ hooks: [hook(), hook({ id: "trace", event: "tool.after", kind: "log", onFailure: "ignore" }), hook({ id: "gate", event: "node.before-enter" })] }), "");
  assert.equal(errorsFor({ hooks: [{ id: "minimal", event: "run.finished", argv: ["notify"], kind: "log" }] }), "");
  assert.equal(errorsFor({ hooks: [] }), "");

  assert.match(errorsFor({ hooks: {} }), /hooks must be an array/);
  assert.match(errorsFor({ hooks: ["node"] }), /hooks\[0\] must be an object/);
  assert.match(errorsFor({ hooks: [hook({ kind: "validate", event: "tool.after" })] }), /validate hooks are only allowed on node\.before-enter and tool\.before/);
  assert.match(errorsFor({ hooks: [hook({ event: "tool.during" })] }), /hooks\[0\]\.event must be one of/);
  assert.match(errorsFor({ hooks: [hook({ kind: "audit" })] }), /hooks\[0\]\.kind must be validate or log/);
  assert.match(errorsFor({ hooks: [hook({ id: "-bad id" })] }), /hooks\[0\]\.id must match/);
  assert.match(errorsFor({ hooks: [hook({ argv: [] })] }), /hooks\[0\]\.argv must be an array of 1 to 64 strings/);
  assert.match(errorsFor({ hooks: [hook({ argv: "node audit" })] }), /hooks\[0\]\.argv must be an array/);
  assert.match(errorsFor({ hooks: [hook({ argv: ["node", `a${String.fromCharCode(0)}b`] })] }), /hooks\[0\]\.argv must be an array/);
  assert.match(errorsFor({ hooks: [hook({ argv: [""] })] }), /argv\[0\] must be a non-empty command/);
  assert.match(errorsFor({ hooks: [hook({ argv: ["git", "reset", "--hard"] })] }), /argv contains a destructive/);
  assert.match(errorsFor({ hooks: [hook({ timeoutMs: 30001 })] }), /timeoutMs must be an integer from 1 to 30000/);
  assert.match(errorsFor({ hooks: [hook({ timeoutMs: 0 })] }), /timeoutMs must be an integer from 1 to 30000/);
  assert.match(errorsFor({ hooks: [hook({ onFailure: "retry" })] }), /onFailure must be block or ignore/);
  assert.match(errorsFor({ hooks: [hook({ cwd: "/tmp" })] }), /hooks\[0\] has unsupported field cwd/);
  assert.match(errorsFor({ hooks: [hook(), hook()] }), /duplicate id audit for event tool\.before/);
});

test("a blueprint may propose an adapter with hooks, and an invalid hook blocks the plan", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  const plan = (adapter) => validateBlueprint({ schemaVersion: 1, pluginVersion: "0.2.1", summary: "hooks", artifacts: [artifact(".claude/asterweave.json", "adapter", `${JSON.stringify(adapter)}\n`)] }, root);
  const good = plan({ version: 1, hooks: [{ id: "trace", event: "tool.after", argv: ["node", "trace.mjs"], kind: "log" }] });
  assert.equal(good.valid, true, good.errors.join("\n"));
  const bad = plan({ version: 1, hooks: [{ id: "trace", event: "tool.after", argv: ["node"], kind: "validate" }] });
  assert.equal(bad.valid, false);
  assert.match(bad.errors.join("\n"), /validate hooks are only allowed/);
});

test("accepts completion.requiredChecks (at most 50 non-empty strings) and rejects invalid ones, consistent with the adapter schema", () => {
  const root = workspace();
  writeFileSync(join(root, "package.json"), "{}\n");
  mkdirSync(join(root, ".claude"), { recursive: true });
  const adapterPath = join(root, ".claude", "asterweave.json");
  const errorsFor = (completion) => {
    writeFileSync(adapterPath, JSON.stringify({ version: 1, completion }));
    return verifyScaffold(root).errors.join("\n");
  };
  assert.equal(errorsFor({ requiredChecks: [".github/workflows/ci.yml", "build"], parallelism: { maxWorkers: 2 } }), "");
  assert.equal(errorsFor({ requiredChecks: [] }), "");
  assert.match(errorsFor({ requiredChecks: "ci" }), /requiredChecks must be an array of strings/);
  assert.match(errorsFor({ requiredChecks: ["ok", "", 3] }), /requiredChecks\[1\] must be a non-empty string/);
  assert.match(errorsFor({ requiredChecks: ["x".repeat(201)] }), /requiredChecks\[0\]/);
  assert.match(errorsFor({ requiredChecks: ["  "] }), /requiredChecks\[0\] must be a non-empty string/);
  assert.equal(JSON.parse(readFileSync(new URL("../schemas/repository-adapter.schema.json", import.meta.url), "utf8")).properties.completion.properties.requiredChecks.items.pattern, "\\S", "the schema rejects whitespace-only strings as well");
  assert.match(errorsFor({ requiredChecks: Array.from({ length: 51 }, (_, i) => `c${i}`) }), /at most 50/);
  assert.match(errorsFor({ requiredCheck: ["ci"] }), /completion.requiredCheck is not a supported property/);
  const schema = JSON.parse(readFileSync(new URL("../schemas/repository-adapter.schema.json", import.meta.url), "utf8"));
  const checks = schema.properties.completion.properties.requiredChecks;
  assert.deepEqual([checks.type, checks.maxItems, checks.items.type, checks.items.minLength, checks.items.maxLength], ["array", 50, "string", 1, 200]);
});
