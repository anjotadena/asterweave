---
sidebar_position: 6
title: /asterweave:implement
description: Execute an approved Asterweave plan.
---

# `/asterweave:implement`

## Purpose

Implements **only an approved Asterweave plan**, using detected repository patterns and stack-specific rules, with scoped changes and no unapproved architecture, dependency, migration, or public API expansion.

## Syntax

```text
/asterweave:implement <approved-plan-reference>
```

## Arguments

`<approved-plan-reference>` — a reference to the plan that already has passing `approve` evidence.

## Options

None.

## Prerequisites

Runs only after the Asterweave `approve` node has passing approval evidence — it will not implement an unapproved plan.

## What happens

1. Re-reads the approved scope, repository instructions, relevant implementation, analogous patterns, the detected stack rule pack, the context manifest, and the repository adapter. Resolves the `implement` route, then delegates a bounded assignment to the project agent or `asterweave:implementer`.
2. Preserves unrelated user changes — never stashes, resets, cleans, bulk-restores, or switches away without consent.
3. Makes the smallest cohesive change, respecting architecture boundaries, public contracts, validation, authorization, data integrity, error handling, observability, and accessibility.
4. Never introduces a dependency, schema migration, public API break, infrastructure change, generated bulk rewrite, or secret without explicit plan approval.
5. Adds or updates tests alongside production code when behavior changes — never weakens tests to accommodate a defect.
6. Runs targeted format/static/build/test feedback during implementation, then self-reviews the complete touched files and diff.

## Agents used

The project's routed `implement` agent, or `asterweave:implementer` by default.

## Files modified

Source and test files within the approved scope only.

## External side effects

None directly (Git commit/push happens later, in `submit-pr`).

## Output

Changed files, behavior, decisions, tests added, commands run, remaining risks, and a `change` evidence summary.

## Examples

```text
/asterweave:implement "approved plan for owner/repo#123"
```

## Common errors

- **Repository facts invalidate the plan** — implement stops and routes to `fail-replan` rather than improvising around a plan that no longer matches reality.

## Related commands

Follows [`/asterweave:plan`](/commands/plan) and human approval; followed by [`/asterweave:test`](/commands/test).
