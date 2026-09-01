---
sidebar_position: 2
title: /asterweave:scaffold
description: Analyze a repository and safely scaffold or refresh its evidence-backed Claude Code context.
---

# `/asterweave:scaffold`

## Purpose

Analyzes a repository and safely scaffolds or refreshes its evidence-backed `CLAUDE.md`, path rules, project skills, specialist agents, references, Asterweave routing, and quality gates — through preview, independent audit, explicit approval, drift protection, and validation. This is Asterweave's repository-onboarding command; see [Repository scaffolding](/repositories/scaffolding) for the full contract.

## Syntax

```text
/asterweave:scaffold [--refresh] [--dry-run|--check]
```

## Arguments

None required — it operates on the current repository.

## Options

| Flag | Effect |
| --- | --- |
| `--dry-run` / `--check` | Return the audited proposal, its operations, warnings, and an approval digest — without writing anything. |
| `--refresh` | Re-run scaffolding against a repository that already has Asterweave context, to reconcile drift after architecture, tooling, or policy changes. |

## Prerequisites

None beyond the plugin being enabled. Works on a repository with no `.claude/` at all, or one that already has hand-written instructions.

## What happens

1. **Discover** — inspects Git status (preserving unrelated work), runs `scaffold-repo.mjs inventory`, and delegates repository mapping to `asterweave:repo-analyzer`: existing instructions, manifests, CI, representative code, architecture boundaries, an existing `specs/` directory if present, and every existing `.claude/agents/*.md` classified by actual responsibility.
2. **Model** — classifies every proposed fact as verified repository fact, explicit inference, unresolved question, or unsafe/stale practice.
3. **Propose** — delegates artifact design to `asterweave:scaffold-architect`, which writes a transient `.claude/asterweave/scaffold-proposal.json` against the blueprint schema. Existing targets get `operation: replace` with their exact current SHA-256, preserving useful content.
4. **Independent audit** — `asterweave:scaffold-auditor` reviews the proposal independently for evidence accuracy, context efficiency, duplication, unsafe commands, invalid routing, and maintainability.
5. **Human approval** — shows every create/replace operation, rationale, evidence, conflicts, assumptions, and warnings, and asks you to approve the exact returned digest. With `--dry-run`/`--check`, it stops here.
6. **Apply** — writes only the approved proposal via `scaffold-repo.mjs apply ... --approval <digest>`. The script refuses stale file hashes, path traversal, symlinks, secrets, duplicate skill/agent names, broken links, invalid routes, and unsafe quality commands.
7. **Validate** — inspects the complete Git diff, confirms nothing unrelated changed, and validates generated frontmatter, adapter routes, links, and path matches.

## Agents used

`asterweave:repo-analyzer` (discovery), `asterweave:scaffold-architect` (proposal design), `asterweave:scaffold-auditor` (independent audit).

## Files modified

Only, and only after your approval: `CLAUDE.md`, `.claude/rules/*.md`, `.claude/skills/*/SKILL.md`, `.claude/agents/*.md`, `.claude/references/*.md`, `.claude/asterweave.json`. It never generates legacy `.claude/commands`, hooks, MCP configuration, permission grants, or deployment automation as part of normal scaffolding. See [what it never removes](/repositories/scaffolding#what-it-never-removes-automatically).

## External side effects

None — scaffolding is entirely local to the repository's working tree.

## Output

An audited create/replace plan before writing, and after applying: created/updated files, detected stack/architecture, generated commands and routing, validation results, assumptions, skipped artifacts with reasons, and a recommended first `/asterweave:deliver` invocation.

## Examples

```text
/asterweave:scaffold --dry-run
```

```text
/asterweave:scaffold
```

```text
/asterweave:scaffold --refresh
```

## Common errors

- **Invalid adapter or drifted managed artifact** — a hand-edited file that a prior scaffold generated blocks write stages until you make an explicit keep/update/remove decision. Scaffolding never overwrites a changed file silently.
- **Stale approval digest** — if the repository changed between proposal and apply, apply refuses the stale hash rather than writing over it.

## Related commands

[`/asterweave:doctor`](/commands/doctor) to check plugin/repository health first; [`/asterweave:deliver`](/commands/deliver) to start delivering work once scaffolding is aligned.
