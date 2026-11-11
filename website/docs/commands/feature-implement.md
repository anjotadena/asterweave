---
sidebar_position: 34
title: /asterweave:feature-implement
description: Build a requested feature or satisfy defined acceptance criteria, integrated with the existing architecture and verified against each criterion.
---

# `/asterweave:feature-implement`

## Purpose

Build a requested feature or satisfy defined acceptance criteria, integrated with the existing architecture and verified against each criterion.

Aliases: `/asterweave:implement-feature`, `/asterweave:add-feature`.

## Syntax

```text
/asterweave:feature-implement <feature|acceptance-criteria|issue>
```

## Inputs

feature description or issue (required), acceptance criteria (derived when absent).

## Prerequisites

repository checked out; approved plan when the repository uses the delivery workflow.

## What happens

1. Write acceptance criteria if none exist, and inspect analogous code, architecture boundaries and public contracts.
2. In the Asterweave delivery workflow, follow the approved plan through the implement skill. Otherwise make the smallest cohesive change using existing patterns.
3. Add tests with the behavior. Do not add a dependency, migration or public API break without explicit approval.
4. Verify every acceptance criterion with `test-verify` and report the evidence per criterion.

## Outputs

integrated implementation, tests, per-criterion verification.

## Verification and stop conditions

- Verified when: each acceptance criterion has evidence; repository-required checks run.
- Stops when: the change needs an unapproved dependency, schema migration or public API break; attempt or cost limit reached.
- Follow-up skills: test-verify, pr-review, pr-prepare.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
