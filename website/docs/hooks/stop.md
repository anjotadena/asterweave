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

## Optional handoff reminder

A second, independent script on the same event, `hook-handoff-reminder.mjs`, is **inert unless you configure a threshold**. Set `handoff.contextBudget.warnAtTokens` in [`asterweave.json`](/configuration/asterweave-json), or the `ASTERWEAVE_HANDOFF_WARN_TOKENS` environment variable.

Claude Code doesn't expose the model's context-window size or remaining tokens to hooks. The script reads the most recent main-conversation API usage recorded in the session transcript and treats it as an **approximate** current context size. When that reaches the threshold, it blocks the stop once, with a reason asking Claude to refresh the [handoff](/commands/handoff) and then end the turn. It asks again only when usage grows by another 25% of the threshold, per session.

It respects `stop_hook_active`, never writes a handoff itself, never runs on tool calls, and does nothing when usage isn't recorded. Its only file is a small marker at `.claude/asterweave/handoffs/.reminders.json`.

## Related

[Workflow state](/architecture/workflow-state), [Resume](/commands/resume), [Handoff](/commands/handoff).
