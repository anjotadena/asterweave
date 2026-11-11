---
name: test-verify
description: Validate a change or investigate a failing check. Runs the appropriate checks, reports actual results, attributes failures, and states unresolved limitations.
argument-hint: "[scope|failing-check]"
model: sonnet
effort: high
asterweave-skill: 1
aliases: verify-change
triggers: run the tests, verify, why is this failing, check the change, validate
inputs: changed files or failing check (optional)
prerequisites: repository checked out and trusted
outputs: checks run with real results, failure attribution (pre-existing or introduced), unresolved limitations
capabilities: read, run-tests
verification: every reported pass was actually executed
stop-when: a check cannot run (report it as blocked, not passed)
follow-ups: bug-fix, feature-implement, pr-review
---

# Test and verify

Scope: `$ARGUMENTS`. Combine the [test skill](../test/SKILL.md) for risk-based tests with the [verify skill](../verify/SKILL.md) for behavior against acceptance criteria.

1. Choose focused checks first, then the repository-required checks; broaden when risk warrants it.
2. Run them and record command, result and duration. A check that could not run is `blocked` with the reason, never `passed`.
3. Attribute each failure: pre-existing (shown on the baseline) or introduced by the change.
4. List unresolved limitations, such as untested environments.
