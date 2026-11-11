---
sidebar_position: 35
title: /asterweave:test-verify
description: Validate a change or investigate a failing check.
---

# `/asterweave:test-verify`

## Purpose

Validate a change or investigate a failing check. Runs the appropriate checks, reports actual results, attributes failures, and states unresolved limitations.

Aliases: `/asterweave:verify-change`.

## Syntax

```text
/asterweave:test-verify [scope|failing-check]
```

## Inputs

changed files or failing check (optional).

## Prerequisites

repository checked out and trusted.

## What happens

1. Choose focused checks first, then the repository-required checks; broaden when risk warrants it.
2. Run them and record command, result and duration. A check that could not run is `blocked` with the reason, never `passed`.
3. Attribute each failure: pre-existing (shown on the baseline) or introduced by the change.
4. List unresolved limitations, such as untested environments.

## Outputs

checks run with real results, failure attribution (pre-existing or introduced), unresolved limitations.

## Verification and stop conditions

- Verified when: every reported pass was actually executed.
- Stops when: a check cannot run (report it as blocked, not passed).
- Follow-up skills: bug-fix, feature-implement, pr-review.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
