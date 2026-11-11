---
sidebar_position: 32
title: /asterweave:issue-triage
description: Evaluate existing issues or audit findings for action.
---

# `/asterweave:issue-triage`

## Purpose

Evaluate existing issues or audit findings for action. Checks duplicates and active work, reproduction status, scope, dependencies and acceptance criteria, and decides whether the item is fixable now.

## Syntax

```text
/asterweave:issue-triage <issue-url|issue-number|finding-id>
```

## Inputs

issue or finding reference (required), repository (optional).

## Prerequisites

tracker access, otherwise findings supplied locally.

## What happens

1. Read the issue, its comments, linked PRs and branches. Search other issues and PRs for duplicates and active work; link them.
2. Attempt reproduction through the normal entry point. Report `reproduced`, `not reproduced (what was tried)` or `not attempted (why)`.
3. Define scope, dependencies and acceptance criteria. Apply maintainer guidance from CONTRIBUTING and templates.
4. Decide: `fix now`, `needs info`, `not actionable` or `blocked`, with the evidence. Do not fabricate priority scores.
5. Posting comments or labels is a remote action and needs authorization for that action and target.

## Outputs

duplicate check, reproduction status, scope, dependencies, acceptance criteria, fixability decision (fix now, needs info, not actionable, blocked).

## Verification and stop conditions

- Verified when: the decision names the evidence it rests on.
- Stops when: decision recorded, or tracker access missing (state it).
- Follow-up skills: bug-fix, feature-implement, repo-audit.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
