#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".idea",
  ".vs",
  ".vscode",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "vendor",
]);

function walk(root, maxDepth = 4, maxEntries = 20_000) {
  const found = [];
  const queue = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length && visited < maxEntries) {
    const current = queue.shift();
    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited >= maxEntries) break;
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !EXCLUDED_DIRECTORIES.has(entry.name)) {
          queue.push({ path, depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  }
  return { files: found, truncated: visited >= maxEntries };
}

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function safeText(path, limit = 512_000) {
  try {
    const size = statSync(path).size;
    if (size > limit) return "";
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function add(set, ...values) {
  for (const value of values.flat()) if (value) set.add(value);
}

function addCommand(commands, category, command) {
  if (!command) return;
  commands[category] ||= [];
  if (!commands[category].includes(command)) commands[category].push(command);
}

function jsCommand(manager, script, directory, root) {
  const prefix = directory === root ? "" : `cd \"${relative(root, directory)}\" && `;
  if (manager === "yarn") return `${prefix}yarn ${script}`;
  if (manager === "pnpm") return `${prefix}pnpm ${script}`;
  if (manager === "bun") return `${prefix}bun run ${script}`;
  return `${prefix}npm run ${script}`;
}

function managerFor(directory, root) {
  let current = directory;
  while (current.startsWith(root)) {
    if (existsSync(join(current, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(current, "yarn.lock"))) return "yarn";
    if (existsSync(join(current, "bun.lock")) || existsSync(join(current, "bun.lockb"))) return "bun";
    if (existsSync(join(current, "package-lock.json"))) return "npm";
    const parent = resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  return "npm";
}

export function detectStack(rootInput = process.cwd()) {
  const root = resolve(rootInput);
  const { files, truncated } = walk(root);
  const languages = new Set();
  const frameworks = new Set();
  const packageManagers = new Set();
  const signals = new Set();
  const warnings = [];
  const commands = {};
  const byName = new Map();
  for (const file of files) {
    const name = basename(file);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(file);
    const extension = extname(file).toLowerCase();
    if ([".ts", ".tsx"].includes(extension)) add(languages, "TypeScript");
    if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) add(languages, "JavaScript");
    if (extension === ".cs") add(languages, "C#");
    if (extension === ".php") add(languages, "PHP");
    if (extension === ".py") add(languages, "Python");
    if (extension === ".dart") add(languages, "Dart");
    if ([".kt", ".kts"].includes(extension)) add(languages, "Kotlin");
    if (extension === ".swift") add(languages, "Swift");
  }

  for (const packageFile of byName.get("package.json") || []) {
    const manifest = safeJson(packageFile);
    if (!manifest) {
      warnings.push(`Could not parse ${relative(root, packageFile)}`);
      continue;
    }
    const directory = resolve(packageFile, "..");
    const manager = managerFor(directory, root);
    add(packageManagers, manager);
    add(languages, "JavaScript/TypeScript");
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    const frameworkSignals = [
      ["@angular/core", "Angular"],
      ["react", "React"],
      ["react-native", "React Native"],
      ["expo", "Expo"],
      ["next", "Next.js"],
      ["@nestjs/core", "NestJS"],
      ["express", "Express"],
      ["vue", "Vue"],
      ["svelte", "Svelte"],
      ["electron", "Electron"],
    ];
    for (const [dependency, framework] of frameworkSignals) {
      if (dependencies[dependency]) add(frameworks, framework);
    }
    const scriptMap = {
      build: "build",
      lint: "lint",
      test: "unit",
      "test:unit": "unit",
      "test:integration": "integration",
      "test:e2e": "e2e",
      e2e: "e2e",
      typecheck: "static-analysis",
      "type-check": "static-analysis",
      start: "run",
      dev: "run",
    };
    for (const [script, category] of Object.entries(scriptMap)) {
      if (manifest.scripts?.[script]) addCommand(commands, category, jsCommand(manager, script, directory, root));
    }
    add(signals, relative(root, packageFile));
  }

  const dotnetFiles = files.filter((file) => /\.(?:sln|slnx|csproj|fsproj)$/i.test(file));
  if (dotnetFiles.length) {
    add(languages, "C#/.NET");
    add(frameworks, ".NET");
    add(packageManagers, "NuGet");
    const entry = dotnetFiles.find((file) => /\.(?:sln|slnx)$/i.test(file)) || dotnetFiles[0];
    const target = relative(root, entry) || basename(entry);
    addCommand(commands, "restore", `dotnet restore \"${target}\"`);
    addCommand(commands, "build", `dotnet build \"${target}\" --no-restore`);
    addCommand(commands, "unit", `dotnet test \"${target}\" --no-build`);
    for (const project of dotnetFiles.filter((file) => /\.csproj$/i.test(file))) {
      const text = safeText(project);
      if (/<UseWPF>true<\/UseWPF>/i.test(text)) add(frameworks, "WPF");
      if (/<UseWindowsForms>true<\/UseWindowsForms>/i.test(text)) add(frameworks, "Windows Forms");
      if (/Microsoft\.NET\.Test\.Sdk|xunit|nunit|MSTest/i.test(text)) add(signals, relative(root, project));
      if (/Microsoft\.AspNetCore/i.test(text) || /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(text)) add(frameworks, "ASP.NET Core");
    }
  }

  for (const composerFile of byName.get("composer.json") || []) {
    const manifest = safeJson(composerFile);
    add(languages, "PHP");
    add(packageManagers, "Composer");
    if (manifest?.require?.["laravel/framework"]) add(frameworks, "Laravel");
    const directory = resolve(composerFile, "..");
    const prefix = directory === root ? "" : `cd \"${relative(root, directory)}\" && `;
    addCommand(commands, "restore", `${prefix}composer install --no-interaction`);
    if (manifest?.scripts?.test) addCommand(commands, "unit", `${prefix}composer test`);
    else if (existsSync(join(directory, "vendor", "bin", "phpunit")) || existsSync(join(directory, "phpunit.xml"))) {
      addCommand(commands, "unit", `${prefix}vendor/bin/phpunit`);
    }
    if (existsSync(join(directory, "artisan"))) addCommand(commands, "run", `${prefix}php artisan serve`);
    add(signals, relative(root, composerFile));
  }

  if ((byName.get("wp-config.php") || []).length || files.some((file) => file.includes(`${join("wp-content", "plugins")}`))) {
    add(languages, "PHP");
    add(frameworks, "WordPress");
    add(signals, "WordPress layout");
  }

  for (const pubspec of byName.get("pubspec.yaml") || []) {
    const text = safeText(pubspec);
    add(languages, "Dart");
    add(packageManagers, "Pub");
    if (/^\s*flutter:\s*$/m.test(text) || /sdk:\s*flutter/m.test(text)) add(frameworks, "Flutter");
    const directory = resolve(pubspec, "..");
    const prefix = directory === root ? "" : `cd \"${relative(root, directory)}\" && `;
    addCommand(commands, "restore", `${prefix}flutter pub get`);
    addCommand(commands, "static-analysis", `${prefix}flutter analyze`);
    addCommand(commands, "unit", `${prefix}flutter test`);
    addCommand(commands, "run", `${prefix}flutter run`);
    add(signals, relative(root, pubspec));
  }

  const pythonMarkers = [
    ...(byName.get("pyproject.toml") || []),
    ...(byName.get("requirements.txt") || []),
    ...(byName.get("Pipfile") || []),
    ...(byName.get("manage.py") || []),
  ];
  if (pythonMarkers.length) {
    add(languages, "Python");
    if ((byName.get("poetry.lock") || []).length) add(packageManagers, "Poetry");
    else if ((byName.get("uv.lock") || []).length) add(packageManagers, "uv");
    else add(packageManagers, "pip");
    if ((byName.get("manage.py") || []).length) {
      add(frameworks, "Django");
      addCommand(commands, "unit", "python manage.py test");
      addCommand(commands, "run", "python manage.py runserver");
    } else {
      addCommand(commands, "unit", "python -m pytest");
    }
    for (const marker of pythonMarkers) add(signals, relative(root, marker));
  }

  if ((byName.get("build.gradle") || []).length || (byName.get("build.gradle.kts") || []).length) {
    add(languages, "Kotlin/Java");
    add(packageManagers, "Gradle");
    addCommand(commands, "build", existsSync(join(root, "gradlew")) ? "./gradlew build" : "gradle build");
    add(signals, "Gradle build");
  }
  if ((byName.get("Podfile") || []).length || files.some((file) => /\.xcodeproj\//.test(file))) {
    add(languages, "Swift/Objective-C");
    add(frameworks, "iOS native");
    add(packageManagers, "CocoaPods");
  }

  if (truncated) warnings.push("Repository scan reached the 20,000-entry safety limit; verify nested stacks manually.");
  if (!frameworks.size) warnings.push("No supported framework marker was detected; use repository-native commands and conventions.");
  if (!commands.unit?.length) warnings.push("No reliable unit-test command was discovered; do not guess—inspect CI and project documentation.");

  return {
    root,
    languages: [...languages].sort(),
    frameworks: [...frameworks].sort(),
    packageManagers: [...packageManagers].sort(),
    commands,
    signals: [...signals].sort(),
    warnings,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const root = process.argv[2] || process.cwd();
  console.log(JSON.stringify(detectStack(root), null, 2));
}
