---
sidebar_position: 4
title: /asterweave:challenge
description: Challenge a proposed feature, bug fix, user story, or plan before coding.
---

# `/asterweave:challenge`

## Purpose

Challenges a proposed feature, bug fix, user story, or implementation plan to expose ambiguity, contradictions, hidden constraints, edge cases, security risks, and missing acceptance criteria **before coding**. This is `deliver`'s requirements "grill" phase, and doubles as a standalone sanity check on a plan someone else wrote.

## Syntax

```text
/asterweave:challenge <task|plan|issue>
```

## Arguments

`<task|plan|issue>` — the requirement, user story, or plan text to challenge.

## Options

None.

## Prerequisites

Read-only; benefits from having run `/asterweave:analyze` first so it can read the context manifest instead of starting cold.

## What happens

1. Reads the repository adapter, the context manifest (if present), and applicable project specifications.
2. Resolves the `challenge` route, then delegates to the project agent or `asterweave:requirements-challenger`, validating the result independently before returning it.
3. Covers business rules, actors/permissions, states/transitions, validation, errors, concurrency, idempotency, data migration, backward compatibility, observability, rollout/rollback, accessibility, privacy, performance, offline/mobile/desktop concerns, and test coverage as applicable.
4. Treats a contradiction between the task and an existing spec as a **blocker**, not a silent override.
5. For a normal/complex feature with no matching use case, may propose creating or updating one — showing the exact content and getting your approval before writing it.
6. Classifies every item: blocker requiring a human/product decision, a safe explicit assumption, a repository fact, an engineering trade-off, or out of scope.

## Agents used

The project's routed `challenge` agent, or `asterweave:requirements-challenger` by default.

## Files modified

None directly; may propose (never silently write) a new or updated spec file under `specs/`.

## External side effects

None.

## Output

A concise decision table, proposed testable acceptance criteria, and a readiness verdict: `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED`.

## Examples

```text
/asterweave:challenge "Allow customers to request a partial refund on a paid order"
```

## Common errors

- **`BLOCKED` verdict** — means a genuine product or business-rule decision is missing; answer the listed question(s) rather than proceeding. See [Starting new work](/usage/starting-new-work).

## Related commands

[`/asterweave:plan`](/commands/plan) consumes a `READY`/`READY_WITH_ASSUMPTIONS` result; [`/asterweave:analyze`](/commands/analyze) typically runs first.
