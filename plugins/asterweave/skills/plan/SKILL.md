---
name: plan
description: Produce an approval-ready, repository-grounded implementation DAG with exact boundaries, stack rules, test strategy, risks, rollout, and rollback before any code changes.
argument-hint: "<goal|issue>"
model: opus
effort: high
---

# Build the implementation DAG

Plan `$ARGUMENTS` without editing code or changing dependencies.

Read [graph contract](../../references/graph-contract.md), [stack discovery](../../references/stack-discovery.md), [testing policy](../../references/testing.md), [repository adapter](../../references/repository-adapter.md), and the detected stack-specific references. Resolve the `plan` route, invoke configured project skills, and delegate to its project agent or `asterweave:architect` when no route exists. Validate its proposal against repository evidence.

Return:

1. objective, acceptance criteria, constraints, and non-goals;
2. evidence-backed current design and patterns to reuse;
3. ordered change DAG with independent nodes explicitly marked parallel-safe;
4. exact modules/interfaces/data/configuration affected;
5. unit, integration/contract, E2E/runtime, regression, and negative tests;
6. security/privacy/authorization checks;
7. migration, compatibility, observability, rollout, and rollback;
8. risks and decisions requiring approval;
9. quality-gate commands discovered from the repository;
10. a concise approval summary.

Prefer the smallest production-ready change. Do not add abstractions or dependencies without current business need.
