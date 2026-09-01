---
sidebar_position: 4
title: Continuing interrupted work
description: How resumability works when a session ends mid-delivery.
---

# Continuing interrupted work

Asterweave's progress lives in `.claude/asterweave/state.json` and `.claude/asterweave/events.jsonl`, not in conversation memory — see [Workflow state](/architecture/workflow-state). A new Claude Code session, even the next day, can pick up exactly where the last one left off.

## Example

You close Claude Code while a delivery is mid-flight — say, at `monitor-pipeline`, waiting on CI. The next day, in the same repository:

```text
/asterweave:resume
```

reports something like:

> **Existing workflow detected.**
> **Work item:** 4821
> **Current phase:** monitor-pipeline
> **Branch:** feature/4821-refund
> **Pull request:** #391
>
> Resume this workflow?

Confirm, and Asterweave continues polling the same PR's checks rather than starting anything new. Use `--inspect-only` if you just want the summary without continuing yet:

```text
/asterweave:resume --inspect-only
```

Running `/asterweave:deliver` again on the same issue also resumes rather than restarts — `deliver` checks for unfinished state matching the goal before initializing a new workflow.

## What resuming does and does not do

- It does **not** repeat completed nodes unless their evidence has gone stale (code, dependencies, configuration, environment, or the base branch changed since the evidence was recorded).
- It does **not** start a second implementation attempt while resumable state exists for the same goal.
- It does **not** silently reset workflow state — a material conflict between state and the repository (for example, the branch no longer exists) routes to re-analysis or a replan instead of guessing.
- It does **not** recreate an existing pull request — `submit-pr` updates the one already referenced in state.

## End of day, without extra effort

You don't need to write a handoff note — the workflow state already captures phase, branch, PR number, and any pending question. A compact end-of-day summary might read:

> **Work item:** 4821 · **Phase:** PR_REVIEW · **Branch:** feature/4821-refund · **PR:** #391 · **Pending:** one reviewer question

The next `/asterweave:resume` (or `/asterweave:deliver 4821`) picks up exactly from there.

## Related

[Workflow state](/architecture/workflow-state), [`/asterweave:resume`](/commands/resume) command reference.
