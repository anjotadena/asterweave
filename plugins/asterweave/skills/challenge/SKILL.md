---
name: challenge
description: Challenge a proposed feature, bug fix, user story, or implementation plan to expose ambiguity, contradictions, hidden constraints, edge cases, security risks, and missing acceptance criteria before coding.
argument-hint: "<task|plan|issue>"
model: opus
effort: high
---

# Challenge the requirement

Challenge `$ARGUMENTS` against repository facts and the task source. Read [the repository adapter](../../references/repository-adapter.md), resolve the `challenge` route, invoke configured project skills, and delegate to its project agent or `asterweave:requirements-challenger` when no route exists. Validate the result independently before returning it.

Cover business rules, actors/permissions, states and transitions, validation, errors, concurrency, idempotency, data migration, backward compatibility, observability, rollout/rollback, accessibility, privacy, performance, offline/mobile/desktop concerns, and unit/integration/E2E coverage as applicable.

Do not invent answers. Classify each item:

- blocker requiring human/product decision;
- assumption safe to state explicitly;
- repository fact with file evidence;
- engineering decision with alternatives and trade-offs;
- out of scope.

Return a short decision table, proposed testable acceptance criteria, and a readiness verdict: `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED`.
