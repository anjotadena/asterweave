// The published package is bin + src only: `npm pack --dry-run` must list no tests and nothing else.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));

/** npm's own JS entry point, run through this node binary (no shell, no .cmd shim). */
function findNpmCli() {
  const bin = dirname(process.execPath);
  return [
    process.env.npm_execpath,
    join(bin, "node_modules", "npm", "bin", "npm-cli.js"),
    join(bin, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate) => candidate && /npm-cli\.js$/.test(candidate) && existsSync(candidate));
}

test("package.json files allow-list is exactly bin and src", () => {
  assert.deepEqual(manifest.files, ["bin", "src"]);
});

const npmCli = findNpmCli();
test("npm pack --dry-run ships only bin/ and src/ (no tests) plus package metadata", { skip: !npmCli && "npm was not found next to this node binary (no npm-cli.js)" }, () => {
  const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageDir, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  const [pack] = JSON.parse(result.stdout);
  const files = pack.files.map((file) => file.path.split("\\").join("/"));
  assert.ok(files.includes("bin/asterweave.mjs"));
  assert.ok(files.includes("src/cli.mjs"));
  assert.equal(files.some((file) => file.startsWith("tests/") || file.startsWith("scripts/")), false, `unexpected files: ${files.filter((f) => /^(tests|scripts)\//.test(f))}`);
  const allowed = (file) => file.startsWith("bin/") || file.startsWith("src/") || file === "package.json" || /^(README|LICENSE|CHANGELOG)/i.test(file);
  assert.deepEqual(files.filter((file) => !allowed(file)), []);
});
