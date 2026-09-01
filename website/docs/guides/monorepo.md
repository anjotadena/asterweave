---
sidebar_position: 8
title: Polyglot and monorepo repositories
description: How Asterweave scopes work in repositories with multiple stacks or packages.
---

# Polyglot and monorepo repositories

Asterweave builds a component map rather than treating a monorepo as one undifferentiated codebase: each changed path is associated with its local instructions, manifest, commands, owners, and runtime.

- Component-level quality gates run first, then integration gates at shared contracts.
- Not every stack rule pack loads into every subagent — only the ones relevant to the components actually touched.
- `/asterweave:scaffold` sizes its output to this reality: a monorepo with genuinely distinct subsystems may end up with several scoped `.claude/rules/*.md` files (one per component) instead of one flat rule file, each with its own `paths` frontmatter.

## Discovery order (applies to any stack, monorepo or not)

1. Repository `CLAUDE.md`, nested rules, contribution guides, architecture docs, README, and CI workflows.
2. `detect-stack.mjs` as a signal generator, not an authority.
3. Manifests, lockfiles, solution/project files, framework configuration, migrations, containers, deployment files, and tests.
4. The actual commands CI and maintainers use — repository wrappers such as `tasks.ps1`, Make, npm scripts, or a Gradle wrapper are preferred over guessed defaults.
5. Analogous production and test code, before choosing a pattern.

For a stack with no dedicated rule pack, Asterweave follows repository-native patterns and official framework documentation rather than forcing a familiar architecture onto it.

## Command safety

Detected commands are candidates, not commands to run blindly — script bodies are inspected first. Install/update/migrate/seed/deploy/reset commands are never run merely because their names appear; locked/reproducible dependency restore and repository-defined test configuration are used instead.
