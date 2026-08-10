import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { detectStack } from "../scripts/detect-stack.mjs";

function workspace() {
  return mkdtempSync(join(tmpdir(), "asterweave-stack-"));
}

test("detects an Angular workspace and repository-defined commands", () => {
  const root = workspace();
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  writeFileSync(join(root, "package.json"), JSON.stringify({
    dependencies: { "@angular/core": "20.0.0" },
    devDependencies: { typescript: "5.8.0" },
    scripts: { build: "ng build", test: "ng test --watch=false", lint: "ng lint", e2e: "playwright test" },
  }));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "main.ts"), "export {};\n");
  const profile = detectStack(root);
  assert.ok(profile.frameworks.includes("Angular"));
  assert.ok(profile.languages.includes("TypeScript"));
  assert.deepEqual(profile.packageManagers, ["npm"]);
  assert.ok(profile.commands.unit.includes("npm run test"));
  assert.ok(profile.commands.e2e.includes("npm run e2e"));
});

test("detects polyglot .NET and Flutter markers", () => {
  const root = workspace();
  writeFileSync(join(root, "App.sln"), "\n");
  writeFileSync(join(root, "App.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n');
  mkdirSync(join(root, "mobile"));
  writeFileSync(join(root, "mobile", "pubspec.yaml"), "dependencies:\n  flutter:\n    sdk: flutter\n");
  const profile = detectStack(root);
  assert.ok(profile.frameworks.includes("ASP.NET Core"));
  assert.ok(profile.frameworks.includes("Flutter"));
  assert.ok(profile.commands.build.some((command) => command.includes("dotnet build")));
  assert.ok(profile.commands.unit.some((command) => command.includes("flutter test")));
});
