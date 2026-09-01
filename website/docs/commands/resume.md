---
sidebar_position: 15
title: /asterweave:resume
description: Resume or inspect a paused Asterweave workflow from durable state.
---

# `/asterweave:resume`

## Purpose

Resumes or inspects a paused Asterweave workflow from durable graph state and event history, **without repeating completed nodes or discarding your changes**.

## Syntax

```text
/asterweave:resume [--inspect-only]
```

## Arguments

None.

## Options

| Flag | Effect |
| --- | --- |
| `--inspect-only` | Print the summary and stop, without resuming the workflow. |

## Prerequisites

An existing `.claude/asterweave/state.json`.

## What happens

1. Reads `state.json` and the relevant tail of `events.jsonl` — never edits either manually.
2. Inspects current Git status, branch, diff, and whether recorded artifact/commit paths still exist.
3. Summarizes the goal, current node, completed evidence, attempts/budgets, blocker, and repository divergence since the last event.
4. With `--inspect-only`, stops here.
5. If blocked and the blocker is resolved, runs `graph-state.mjs resume`.
6. Revalidates stale evidence when code, dependencies, configuration, environment, or the base branch changed — never blindly reuses a prior pass claim.
7. Continues from the current node; does not repeat passed nodes unless their evidence became stale.

## Agents used

None directly — resume drives the existing graph forward through the same delegation the original node used.

## Files modified

`.claude/asterweave/state.json` and `.claude/asterweave/events.jsonl`; source/test files only as the resumed node's own work requires.

## External side effects

Whatever the resumed node itself performs (for example, `monitor-pipeline` resumes polling CI).

## Output

A resume summary (goal, current node, evidence, blocker, divergence), then continued graph execution.

## Examples

```text
/asterweave:resume --inspect-only
```

```text
/asterweave:resume
```

## Common errors

- **State and repository conflict materially** — for example, the branch was deleted or force-pushed — routes to re-analysis or replan rather than guessing.

## Related commands

See [Workflow state](/architecture/workflow-state) and [Continuing interrupted work](/usage/continuing-work).
