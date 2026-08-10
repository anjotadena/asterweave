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
    pluginVersion: "0.2.0",
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
    pluginVersion: "0.2.0",
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
    pluginVersion: "0.2.0",
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
    pluginVersion: "0.2.0",
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
    pluginVersion: "0.2.0",
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
    pluginVersion: "0.2.0",
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
