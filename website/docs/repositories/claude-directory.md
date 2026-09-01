---
sidebar_position: 3
title: The .claude directory
description: What a repository's .claude/ holds once Asterweave is scaffolded.
---

# The `.claude` directory

Once scaffolded, a repository typically looks like this:

```text
my-project/
├── CLAUDE.md
├── .claude/
│   ├── rules/
│   │   ├── backend.md
│   │   ├── database.md
│   │   └── security.md
│   ├── agents/
│   │   └── finance-domain-reviewer.md      (only if genuinely domain-specific)
│   ├── skills/
│   │   └── ...                              (only if the repo has reusable workflows)
│   ├── references/
│   │   └── ...                              (only if detail needs its own file)
│   └── asterweave.json
│
├── specs/                                    (only if the repo already tracks specs)
│   └── ...
│
├── src/
└── tests/
```

Nothing here is mandatory — a small, simple repository may end up with just `CLAUDE.md` and no `.claude/rules/` at all. Scaffolding sizes its output to the evidence: simple repositories get a small setup; monorepos and domain-heavy systems may get scoped rules, references, and specialists.

## What each piece is for

| Path | Purpose |
| --- | --- |
| `CLAUDE.md` | Short, stable, always-loaded facts — kept concise, linking to detail rather than duplicating it |
| `.claude/rules/*.md` | Path-scoped conventions, each requiring a `paths` frontmatter scope |
| `.claude/agents/*.md` | Domain-specific specialists only — see [Repository-specific agents](/repositories/scaffolding#repository-specific-agents) |
| `.claude/skills/*/SKILL.md` | Reusable, repository-specific workflows; these double as the repository's own slash commands |
| `.claude/references/*.md` | Detailed architecture/domain/test material, linked from the above rather than inlined |
| `.claude/asterweave.json` | Routing and quality-gate configuration — see the [reference](/configuration/asterweave-json) |
| `specs/` | Product/system intent — read and linked, never generated, by Asterweave (see [Specifications](/concepts/specifications)) |

## Project skills are the project's commands

A repository does not need a separate legacy `.claude/commands/` directory — a project skill under `.claude/skills/` is already exposed as a slash command, the same way an Asterweave plugin skill is exposed as `/asterweave:*`.

## What stays out of `.claude`

- Product/business requirements — those belong in `specs/`.
- Anything Asterweave's plugin already provides generically (a `deliver` command, a code-reviewer agent, destructive-command blocking) — see [Do not duplicate Asterweave](/repositories/scaffolding#worked-example).
- Workflow execution state — that lives under the separate, usually-gitignored `.claude/asterweave/` directory (see [Workflow state](/architecture/workflow-state)), not committed alongside the rest of `.claude/`.

## Related

[Repository scaffolding](/repositories/scaffolding), [`asterweave.json` reference](/configuration/asterweave-json), [Team workflow](/usage/repository-maintenance#team-workflow-what-to-commit).
