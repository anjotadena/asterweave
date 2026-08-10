---
name: challenge
description: Challenge a proposed feature, bug fix, user story, or implementation plan to expose ambiguity, contradictions, hidden constraints, edge cases, security risks, and missing acceptance criteria before coding.
argument-hint: "<task|plan|issue>"
context: fork
agent: asterweave:requirements-challenger
background: false
model: opus
effort: high
---

# Challenge the requirement

Challenge `$ARGUMENTS` against repository facts and the task source.

Cover business rules, actors/permissions, states and transitions, validation, errors, concurrency, idempotency, data migration, backward compatibility, observability, rollout/rollback, accessibility, privacy, performance, offline/mobile/desktop concerns, and unit/integration/E2E coverage as applicable.

Do not invent answers. Classify each item:

- blocker requiring human/product decision;
- assumption safe to state explicitly;
- repository fact with file evidence;
- engineering decision with alternatives and trade-offs;
- out of scope.

Return a short decision table, proposed testable acceptance criteria, and a readiness verdict: `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED`.
