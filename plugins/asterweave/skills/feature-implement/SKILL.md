---
name: feature-implement
description: Build a requested feature or satisfy defined acceptance criteria, integrated with the existing architecture and verified against each criterion.
argument-hint: "<feature|acceptance-criteria|issue>"
model: sonnet
effort: high
asterweave-skill: 1
aliases: implement-feature, add-feature
triggers: add, build, implement, support, export, new feature, acceptance criteria
inputs: feature description or issue (required), acceptance criteria (derived when absent)
prerequisites: repository checked out; approved plan when the repository uses the delivery workflow
outputs: integrated implementation, tests, per-criterion verification
capabilities: read, search, edit, run-tests, git-local
verification: each acceptance criterion has evidence; repository-required checks run
stop-when: the change needs an unapproved dependency, schema migration or public API break; attempt or cost limit reached
follow-ups: test-verify, pr-review, pr-prepare
---

# Feature implementation

Feature: `$ARGUMENTS`. Read the [contribution reference](../../references/contribution.md) for scope.

1. Write acceptance criteria if none exist, and inspect analogous code, architecture boundaries and public contracts.
2. In the Asterweave delivery workflow, follow the approved plan through the [implement skill](../implement/SKILL.md). Otherwise make the smallest cohesive change using existing patterns.
3. Add tests with the behavior. Do not add a dependency, migration or public API break without explicit approval.
4. Verify every acceptance criterion with `test-verify` and report the evidence per criterion.
