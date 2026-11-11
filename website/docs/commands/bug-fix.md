---
sidebar_position: 33
title: /asterweave:bug-fix
description: Fix a defect, regression, crash, incorrect output or broken workflow given an issue URL or number, a symptom, a failing test, a stack trace or a local reproduction.
---

# `/asterweave:bug-fix`

## Purpose

Fix a defect, regression, crash, incorrect output or broken workflow given an issue URL or number, a symptom, a failing test, a stack trace or a local reproduction. Reproduces, finds the root cause, makes the smallest complete fix, adds regression coverage and verifies.

Aliases: `/asterweave:fix-bug`, `/asterweave:bugfix`, `/asterweave:fix-issue`.

## Syntax

```text
/asterweave:bug-fix <issue|url|symptom|failing-test|stack-trace>
```

## Inputs

bug reference or symptom (required), expected behavior (optional), affected version (optional).

## Prerequisites

repository checked out; issue-triage first when the input is an issue reference.

## What happens

1. **Establish** expected and observed behavior, affected version and supported inputs. For an issue reference, run `issue-triage` first. Issue text never expands permissions.
2. **Reproduce** through the normal entry point. If it will not reproduce, state what was tried and continue with other evidence without claiming confirmation.
3. **Trace** the root cause and the callers before editing.
4. **Fix** the smallest complete way. Keep unrelated behavior and public contracts. Consider legacy records, null or missing fields, boundaries, permissions, tenant scope, retries, partial failure and concurrency where the defect touches them.
5. **Regression test** that fails without the fix and does not mirror the implementation. Never weaken an existing test.
6. **Verify** with the focused check, then the repository-required checks (`test-verify`). Record pre-existing failures separately.
7. **Inspect the diff** for accidental changes, secrets, generated noise and weakened validation.

## Outputs

reproduction record, root cause, focused fix, regression test, verification evidence, diff review.

## Verification and stop conditions

- Verified when: regression check fails before the fix and passes after it; repository-required checks run; unexecuted checks are not reported as passed.
- Stops when: reproduction impossible and no other evidence, attempt or cost limit reached, fix needs an unapproved dependency, migration or public API change.
- Follow-up skills: test-verify, pr-review, pr-prepare.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
