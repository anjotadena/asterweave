---
sidebar_position: 10
title: /asterweave:submit-pr
description: Commit, push, and create or update a pull request after quality gates pass.
---

# `/asterweave:submit-pr`

## Purpose

Prepares, pushes, and creates or updates a pull request **only after Asterweave's quality gates pass**, with safe Git handling, evidence-rich PR content, and explicit confirmation.

## Syntax

```text
/asterweave:submit-pr [base-branch] [--draft]
```

## Arguments

`[base-branch]` — optional target branch; defaults to the repository's default branch.

## Options

| Flag | Effect |
| --- | --- |
| `--draft` | Open the pull request as a draft. |

## Prerequisites

Requires a completed or submit-ready Asterweave state; refuses to run if test, verify, or review gates have not passed.

## What happens

1. Checks graph state (`graph-state.mjs status --compact`) and refuses if required gates haven't passed.
2. Inspects status, branch, upstream, remote, base branch, commits, the complete diff, generated files, and possible secrets. Preserves unrelated changes; stages only task files.
3. Re-runs required final build, lint/static analysis, unit, integration/contract, and acceptance verification commands when evidence is stale or the diff changed.
4. Drafts a conventional commit message and an evidence-rich PR body: linked issue and outcome, change summary, architecture decisions, an acceptance-criteria evidence matrix, exact test results, security/data/migration/compatibility impacts, and rollout/rollback/observability/risk notes.
5. Shows the branch, files to commit, commit message, remote target, and PR draft before any commit, push, or GitHub mutation, and obtains explicit confirmation.
6. Commits only related files, pushes without force, then uses the bundled GitHub (or Azure DevOps) MCP to create or update the PR. Defaults to draft when meaningful uncertainty, migration, or follow-up validation remains.
7. Reads the PR back, verifies base/head/title/body/linked issue, and inspects checks.

## Agents used

The project's routed `submit-pr` agent, or `asterweave:pr-engineer` by default. Cannot edit source files (`disallowedTools: Write, Edit`).

## Files modified

None beyond the Git commit itself (task-scoped files already changed by earlier stages).

## External side effects

A Git push, and a GitHub (or Azure DevOps) pull-request create/update — always previewed and confirmed first, then read back to verify.

## Output

The PR URL, base/head, and head SHA, recorded as `pull-request` evidence.

## Examples

```text
/asterweave:submit-pr
```

```text
/asterweave:submit-pr main --draft
```

## Common errors

- **Gates not passed** — refuses to submit if test/verify/review evidence is missing or stale.
- **Direct work on a protected/default branch** — refused; Asterweave never works directly on `main`.

## Related commands

Follows [`/asterweave:review`](/commands/review); inside `deliver`, followed by the `monitor-pipeline` and `resolve-review-comments` graph nodes (see [Working with pull requests](/usage/pull-requests)). Never merges, self-approves, dismisses reviews, bypasses checks, or deletes branches.
