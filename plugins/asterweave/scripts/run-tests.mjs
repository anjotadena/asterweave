#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const testsDirectory = join(scriptsDirectory, "..", "tests");
const testFiles = readdirSync(testsDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => join(testsDirectory, entry.name))
  .sort((left, right) => left.localeCompare(right));

if (testFiles.length === 0) {
  console.error(`No test files found in ${testsDirectory}`);
  process.exitCode = 1;
} else {
  const result = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`Unable to start the Node.js test runner: ${result.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = result.status ?? 1;
  }
}
