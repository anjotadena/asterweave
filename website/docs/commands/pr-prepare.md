---
sidebar_position: 37
title: /asterweave:pr-prepare
description: Prepare a contribution for maintainer review.
---

# `/asterweave:pr-prepare`

## Purpose

Prepare a contribution for maintainer review. Produces a focused diff, commits where authorized, a PR title and body, issue linkage and a validation summary, without publishing.

Aliases: `/asterweave:prepare-pr`, `/asterweave:contribution-package`.

## Syntax

```text
/asterweave:pr-prepare [base-branch] [issue]
```

## Inputs

base branch (optional), linked issue (optional).

## Prerequisites

test-verify and pr-review completed or their gaps stated.

## What happens

1. Confirm the diff is focused: no unrelated edits, generated noise or secrets.
2. Follow the repository's PR template and commit conventions. Commit only if the user authorized commits.
3. Write the title and body: problem, change, issue linkage, validation summary with exact commands and results, remaining blockers and limitations.
4. To publish, hand off to [submit-pr](../submit-pr/SKILL.md). It needs authorization naming the action and target, and it records the PR number the moment it exists.

## Outputs

focused diff summary, commits where authorized, PR title and body, issue linkage, validation summary with exact checks, remaining blockers.

## Verification and stop conditions

- Verified when: the PR body lists only checks that were executed.
- Stops when: package written locally; publishing needs the submit-pr skill and authorization.
- Follow-up skills: submit-pr.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
