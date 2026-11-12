import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validatePlugin } from "../scripts/validate-plugin.mjs";

const pluginRoot = resolve(import.meta.dirname, "..");
const EIGHT = ["contribute", "repo-audit", "issue-triage", "bug-fix", "feature-implement", "test-verify", "pr-review", "pr-prepare"];

test("the eight contribution skills carry versioned metadata and validate", () => {
  assert.equal(validatePlugin(pluginRoot).valid, true);
  for (const id of EIGHT) {
    const text = readFileSync(join(pluginRoot, "skills", id, "SKILL.md"), "utf8");
    assert.match(text, /^asterweave-skill: 1$/m, id);
    assert.ok(text.split("\n").length < 60, `${id} stays concise`);
  }
});

test("the validator rejects bad extended metadata and leaves legacy skills alone", () => {
  const root = mkdtempSync(join(tmpdir(), "aw-plugin-"));
  try {
    cpSync(pluginRoot, root, { recursive: true });
    const file = join(root, "skills", "bug-fix", "SKILL.md");
    const original = readFileSync(file, "utf8");
    writeFileSync(file, original.replace("follow-ups: test-verify, pr-review, pr-prepare", "follow-ups: no-such-skill").replace("aliases: fix-bug, bugfix, fix-issue", "aliases: review"));
    const result = validatePlugin(root);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /follow-up no-such-skill is not a skill/.test(e)));
    assert.ok(result.errors.some((e) => /alias review already belongs/.test(e)));
    writeFileSync(file, original.replace("asterweave-skill: 1", "asterweave-skill: 7"));
    assert.ok(validatePlugin(root).errors.some((e) => /unsupported asterweave-skill version 7/.test(e)));
    writeFileSync(file, original.replace(/^outputs:.*\r?\n/m, "")); // \r?: a Windows checkout has CRLF, and `.` never matches \r
    assert.ok(validatePlugin(root).errors.some((e) => /missing outputs/.test(e)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
