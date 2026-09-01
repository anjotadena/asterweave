---
sidebar_position: 3
title: Stop — evidence stop gate
description: Keeps an active Asterweave workflow moving instead of ending mid-flight.
---

# Stop: evidence stop gate

## Event

`Stop` — fires at the end of each Claude Code turn.

## Purpose

Prevents an active Asterweave workflow from being silently abandoned mid-node. Claude Code's own continuation cap is a separate, additional escape hatch; this hook is what keeps a workflow moving under normal circumstances.

## Behavior

`hook-stop-gate.mjs` reads `.claude/asterweave/state.json`. If there is no active workflow, the workflow is `done`, or it is currently paused at `approve` (a deliberate stop point), the hook does nothing and the turn ends normally. Otherwise, it injects additional context telling Claude to continue the current graph node, record environment evidence, and transition through `graph-state.mjs` — or, if human input is genuinely required, to record a `needs-human` outcome so the workflow becomes properly `blocked` and the turn may end.

It also respects `stop_hook_active` from its own payload, to avoid looping the same reminder indefinitely.

## Configuration

None — it operates purely on `.claude/asterweave/state.json`, which every `/asterweave:deliver` run already maintains.

## Failure behavior

If `state.json` is missing or unparsable, the hook does nothing — it fails open, in the sense of not blocking anything, because it simply has no workflow to protect.

## Related

[Workflow state](/architecture/workflow-state), [Resume](/commands/resume).
