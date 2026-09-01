---
sidebar_position: 6
title: pr-engineer
description: Prepares and submits pull requests, monitors CI, and triages review comments.
---

# `asterweave:pr-engineer`

## Role

Prepares and submits a pull request after all Asterweave gates pass, monitors its required CI checks, triages its review comments, and updates the linked work item — using safe Git commands and the plugin-scoped GitHub or Azure DevOps MCP, without merging or bypassing protections.

## Purpose

Operates only after explicit submission confirmation and passing Asterweave gates, against whichever provider `.claude/asterweave.json`'s `provider.workItems` selects. Inspects branch, status, upstream, base, commits, complete diff, generated files, and secret risk. Never stashes, resets, cleans, bulk-restores, force-pushes, rewrites shared history, merges, approves its own PR, dismisses reviews, bypasses checks, or deletes branches. Refuses to work directly on a protected/default branch.

## When invoked

By default, at the `submit-pr`, `monitor-pipeline`, `resolve-review-comments`, and `update-work-item` graph nodes, unless routed to a project-specific agent.

## Inputs

Passing test/verify/review evidence, the approved change, and (for monitoring/comment triage) the submitted commit's checks and PR comments.

## Context received

A bounded assignment per node — for example a `monitor-pipeline` assignment carries just the submitted commit and required-check list.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, mcp__plugin_asterweave_github__*, mcp__plugin_asterweave_azuredevops__*`. Explicitly disallowed: `Write, Edit, Agent`.

## Writes allowed?

No source writes. Only Git operations (commit, push without force) and provider MCP writes, always shown as an exact plan and confirmed first, then read back after each remote write to verify the result.

## Output format

For `submit-pr`: an evidence-rich PR body (linked task, outcome, changes, architecture decisions, acceptance matrix, exact test results, security/data/migration/compatibility impacts, rollout/rollback, observability, known risks). For `monitor-pipeline`: each required check's name, conclusion, and log reference for any failure.

## Typical workflow

Gates pass → `pr-engineer` shows the commit/push/PR plan → confirmed → PR created and read back → CI polled → review comments triaged → the work item updated with a confirmed, read-back write.

## Related skills

[`/asterweave:submit-pr`](/commands/submit-pr), and the `monitor-pipeline`/`resolve-review-comments`/`update-work-item` nodes inside [`/asterweave:deliver`](/commands/deliver).
