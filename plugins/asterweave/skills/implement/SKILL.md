---
name: implement
description: Implement only an approved Asterweave plan using detected repository patterns and stack-specific rules, with scoped changes and no unapproved architecture, dependency, migration, or API expansion.
argument-hint: "<approved-plan-reference>"
disable-model-invocation: true
model: sonnet
effort: high
---

# Implement an approved plan

Implement `$ARGUMENTS` only after the Asterweave `approve` node has passing approval evidence.

1. Re-read the approved scope, repository instructions, relevant implementation, analogous patterns, detected stack rule pack, the [context manifest](../../references/graph-contract.md#context-manifest) when present, and [repository adapter](../../references/repository-adapter.md). Resolve the `implement` route, invoke configured project skills, and delegate a bounded assignment to its project agent or `asterweave:implementer` when no route exists.
2. Preserve unrelated user changes. Do not stash, reset, clean, bulk restore, or switch away without consent.
3. Make the smallest cohesive change. Respect architecture boundaries, public contracts, validation, authorization, data integrity, error handling, observability, and accessibility.
4. Do not introduce a dependency, schema migration, public API break, infrastructure change, generated bulk rewrite, or secret without explicit plan approval.
5. Add or update tests with production code when behavior changes, but never weaken tests to accommodate a defect.
6. Run targeted format/static/build/test feedback during implementation.
7. Self-review the complete touched files and diff, not only added lines.
8. Review the delegated diff and command evidence yourself. Return changed files, behavior, decisions, tests added, commands run, remaining risks, and a `change` evidence summary.

If the approved plan is invalidated by repository facts, stop and route to `fail-replan`.
