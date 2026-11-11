---
sidebar_position: 36
title: /asterweave:pr-review
description: Review a diff or pull request and report prioritized, actionable findings with file references, evidence, impact and a suggested resolution.
---

# `/asterweave:pr-review`

## Purpose

Review a diff or pull request and report prioritized, actionable findings with file references, evidence, impact and a suggested resolution.

Aliases: `/asterweave:review-pr`.

## Syntax

```text
/asterweave:pr-review [pr-url|pr-number|base-branch]
```

## Inputs

PR reference or branch (optional, default current diff).

## Prerequisites

diff readable.

## What happens

1. Read complete touched files, the diff and tests, not only added lines.
2. Report `Critical`, `High`, `Medium`, `Low` with `file:line`, evidence, impact and a suggested fix. Separate pre-existing issues.
3. Posting review comments on a remote PR is a remote action and needs authorization for that PR; otherwise return the review locally.
4. If nothing blocks, say so without inventing findings.

## Outputs

findings by severity with file:line, evidence, impact, suggested resolution; verdict.

## Verification and stop conditions

- Verified when: each finding was checked against the code and is introduced or exposed by the change.
- Stops when: verdict given.
- Follow-up skills: bug-fix, feature-implement, pr-prepare.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
