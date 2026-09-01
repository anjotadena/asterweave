---
sidebar_position: 5
title: /asterweave:plan
description: Produce an approval-ready implementation DAG before any code changes.
---

# `/asterweave:plan`

## Purpose

Produces an approval-ready, repository-grounded implementation DAG with exact boundaries, stack rules, test strategy, risks, rollout, and rollback — **without editing code or changing dependencies**.

## Syntax

```text
/asterweave:plan <goal|issue>
```

## Arguments

`<goal|issue>` — the goal or issue reference to plan for.

## Options

None.

## Prerequisites

Most useful after `/asterweave:analyze` and `/asterweave:challenge`, so the plan is grounded in resolved requirements rather than open questions.

## What happens

1. Reads the graph contract, stack-discovery guidance, testing policy, the repository adapter, the context manifest (if present), and detected stack-specific references.
2. Resolves the `plan` route, then delegates to the project agent or `asterweave:architect`, and validates the proposal against repository evidence itself.
3. Prefers the smallest production-ready change; does not add abstractions or dependencies without current business need.

## Agents used

The project's routed `plan` agent, or `asterweave:architect` by default.

## Files modified

None — planning never edits code.

## External side effects

None.

## Output

1. Objective, acceptance criteria, constraints, non-goals, and applicable `FR-`/`UC-` identifiers when specs exist;
2. evidence-backed current design and patterns to reuse;
3. an ordered change DAG with parallel-safe nodes explicitly marked;
4. exact modules/interfaces/data/configuration affected;
5. unit, integration/contract, E2E/runtime, regression, and negative tests;
6. security/privacy/authorization checks;
7. migration, compatibility, observability, rollout, and rollback;
8. risks and decisions requiring approval;
9. quality-gate commands discovered from the repository;
10. a concise approval summary.

## Examples

```text
/asterweave:plan owner/repo#123
```

## Common errors

- **Plan invalidated after approval** — if repository facts change materially after a plan is approved, `implement` stops and routes back to `plan` (`fail-replan`) rather than proceeding on stale assumptions.

## Related commands

Followed by human approval (the `approve` graph node), then [`/asterweave:implement`](/commands/implement).
