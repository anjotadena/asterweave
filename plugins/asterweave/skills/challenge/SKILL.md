---
name: challenge
description: Challenge a proposed feature, bug fix, user story, or implementation plan to expose ambiguity, contradictions, hidden constraints, edge cases, security risks, and missing acceptance criteria before coding.
argument-hint: "<task|plan|issue>"
model: opus
effort: high
---

# Challenge the requirement

Challenge `$ARGUMENTS` against repository facts and the task source. Read [the repository adapter](../../references/repository-adapter.md), the [context manifest](../../references/graph-contract.md#context-manifest) when present, and any applicable [project specifications](../../references/specs.md). Resolve the `challenge` route, invoke configured project skills, and delegate to its project agent or `asterweave:requirements-challenger` when no route exists. Validate the result independently before returning it.

Cover business rules, actors/permissions, states and transitions, validation, errors, concurrency, idempotency, data migration, backward compatibility, observability, rollout/rollback, accessibility, privacy, performance, offline/mobile/desktop concerns, and unit/integration/E2E coverage as applicable.

Treat a contradiction between the task and an existing spec as a blocker, not a silent override. If the task is a normal or complex feature with no matching use case, propose creating or updating one under the proportional-rigor guidance in [specs](../../references/specs.md); show the exact content and get approval before writing it.

Do not invent answers. Classify each item:

- blocker requiring human/product decision;
- assumption safe to state explicitly;
- repository fact with file evidence;
- engineering decision with alternatives and trade-offs;
- out of scope.

Return a short decision table, proposed testable acceptance criteria, and a readiness verdict: `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED`.
