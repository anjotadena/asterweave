# Stack discovery and rule routing

## Discovery order

1. Read repository `CLAUDE.md`, nested rules, contribution guides, architecture docs, README, and CI workflows.
2. Run `scripts/detect-stack.mjs` as a signal generator, not an authority.
3. Verify manifests, lockfiles, solution/project files, framework configuration, migrations, containers, deployment files, and tests.
4. Find the actual commands used by CI and maintainers. Prefer repository wrappers such as `tasks.ps1`, Make, npm scripts, Gradle wrapper, or documented scripts.
5. Search for analogous production and test code before choosing a pattern.
6. Load only relevant rule packs:
   - .NET, ASP.NET Core, WPF, Windows Forms: [dotnet](stack-rules/dotnet.md)
   - Angular, React, React Native, Node, Next, Nest, Electron: [JavaScript/TypeScript](stack-rules/javascript-typescript.md)
   - Laravel and generic PHP: [PHP](stack-rules/php.md)
   - WordPress: [WordPress](stack-rules/wordpress.md) plus PHP
   - Python and Django: [Python](stack-rules/python.md)
   - Flutter/Dart: [Flutter](stack-rules/flutter.md)
   - Native or cross-platform mobile concerns: [mobile](stack-rules/mobile.md)
7. For an unknown stack, follow repository-native patterns and official framework documentation. Do not force a familiar architecture onto it.

## Command safety

Treat detected commands as candidates. Inspect script bodies before running them. Never run install/update/migrate/seed/deploy/reset commands merely because their names appear. Use locked/reproducible dependency restore and repository-defined test configuration.

## Polyglot and monorepo rules

Build a component map. Associate each changed path with its local instructions, manifest, commands, owners, and runtime. Run component gates first, then integration gates at shared contracts. Do not load every stack rule into every subagent.
