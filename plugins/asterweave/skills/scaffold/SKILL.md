---
name: scaffold
description: Analyze a repository and safely scaffold or refresh its evidence-backed CLAUDE.md, path rules, project skills/commands, specialist agents, references, Asterweave routing, and quality gates through preview, audit, explicit approval, drift protection, and validation.
argument-hint: "[--refresh] [--dry-run]"
disable-model-invocation: true
model: opus
effort: high
---

# Scaffold repository-native Claude Code context

Scaffold `$ARGUMENTS` under [the repository scaffolding contract](../../references/repository-scaffolding.md) and [repository adapter contract](../../references/repository-adapter.md).

## Discover without changing the repository

1. Inspect Git status and preserve all unrelated work. Do not stash, reset, clean, switch branches, install dependencies, or execute documentation commands.
2. Run:

   `node "${CLAUDE_SKILL_DIR}/../../scripts/scaffold-repo.mjs" inventory --root .`

3. Delegate repository mapping to `asterweave:repo-analyzer`. Read existing repository instructions, manifests, CI, representative production/test code, architecture boundaries, security/data concerns, and repository-native commands.
4. Classify every proposed fact as verified repository fact, explicit inference, unresolved question, or unsafe/stale practice. Do not turn an inference into a rule.

## Design the minimum scaffold

1. Delegate artifact design to `asterweave:scaffold-architect` with the inventory and raw evidence, not a predetermined file list.
2. Prefer:
   - concise `CLAUDE.md` for stable universal facts;
   - path-scoped `.claude/rules/*.md` for real modules/files;
   - `.claude/skills/<name>/SKILL.md` for reusable knowledge and user workflows; these are the project's slash commands;
   - `.claude/agents/*.md` only for recurring, bounded specialist roles;
   - linked references for architecture, domain, testing, commands, or operations detail;
   - `.claude/asterweave.json` only when project routing or verified quality gates add value.
3. Do not generate legacy `.claude/commands`, hooks, MCP configuration, permission grants, deployment commands, or speculative framework rules by default.
4. Write the proposal only to `.claude/asterweave/scaffold-proposal.json` using [the blueprint schema](../../schemas/scaffold-blueprint.schema.json). This transient proposal is not a final scaffold artifact.
5. For existing targets, preserve useful content, use `operation: replace`, and include the exact current SHA-256 from inventory. Never silently replace an unowned or drifted file.

## Validate, audit, and approve

1. Run:

   `node "${CLAUDE_SKILL_DIR}/../../scripts/scaffold-repo.mjs" plan ".claude/asterweave/scaffold-proposal.json" --root .`

2. Fix validation errors in the proposal. Delegate an independent review to `asterweave:scaffold-auditor`; require evidence accuracy, minimal context, no duplication, least-privilege agents, valid path globs, valid local links, and safe commands.
3. If `$ARGUMENTS` contains `--dry-run`, return the audited proposal, operations, warnings, and approval digest without applying it.
4. Otherwise show a compact table of every create/replace operation, rationale, evidence, conflicts, assumptions, and warnings. Obtain explicit approval of the exact returned digest before applying.

## Apply and verify

1. Apply only the approved proposal:

   `node "${CLAUDE_SKILL_DIR}/../../scripts/scaffold-repo.mjs" apply ".claude/asterweave/scaffold-proposal.json" --approval "<approved-digest>" --root .`

2. Run `verify`, inspect the complete Git diff, and confirm no unrelated file changed.
3. Validate generated skill and agent frontmatter, adapter routes, links, path matches, referenced commands, and managed hashes. Run safe repository-native lint/build/test checks only when needed to prove generated commands and the baseline remains valid.
4. Return created/updated files, detected stack/architecture, generated commands and routing, validation results, assumptions, skipped artifacts with reasons, and recommended first `/asterweave:deliver` workflow.

Never weaken an existing security or quality control. Never delete stale scaffold artifacts automatically; present a separate keep/update/remove decision.
