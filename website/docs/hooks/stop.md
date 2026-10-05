---
sidebar_position: 3
title: Stop — evidence stop gate
description: Keeps an active Asterweave workflow moving instead of ending mid-flight.
---

# Stop: evidence stop gate

## Event

`Stop` — fires at the end of each Claude Code turn.

## Purpose

Long runs shouldn't need a human typing "continue". While a `/asterweave:deliver` graph or a `/asterweave:complete-project` run still has work to do, this hook blocks the stop and sends Claude back to the ledger. Approval checkpoints, blocked runs and questions to the user still end the turn.

## Behavior

`hook-stop-gate.mjs` looks at `.claude/asterweave/state.json` and every `.claude/asterweave/completion/<runId>/state.json`. It only considers ledgers written **during the current session** (since the transcript's first timestamp), so an old run left active in the repository never hijacks an unrelated session.

A ledger is unfinished when its status is `active` and it is not at a deliberate stopping point: graph node `approve` or `done`, or completion phase `awaiting-approval` or `done`. When at least one is unfinished, the hook returns `decision: "block"` with a reason that names each run and its node or phase. That tells Claude to keep going, record evidence, and transition through the state script.

It lets the turn end when:

- Claude's last message ends with a question, which is a real escalation to the user;
- neither the ledgers, `HEAD`, nor the working tree changed across two consecutive nudges (the run is stuck, not progressing);
- the session reached `autoContinue.maxNudges` nudges (default 25);
- the [handoff reminder](#optional-handoff-reminder) threshold is reached, so the reminder can ask for a handoff instead;
- it is disabled.

It deliberately ignores `stop_hook_active`, which would cap it at one nudge per human turn. Its per-session counter, kept in the OS temp directory, bounds the loop instead.

## Configuration

| Setting | Effect |
| --- | --- |
| `autoContinue.enabled: false` in [`asterweave.json`](/configuration/asterweave-json) | Turns it off for the repository. |
| `autoContinue.maxNudges` (1–200, default 25) | Per-session nudge cap. |
| `ASTERWEAVE_NO_AUTOCONTINUE=1` | Turns it off for the session. |
| A `.claude/asterweave/.no-autocontinue` file | Turns it off for the repository without editing config, for example mid-run. |

The hook keeps a run going within one session. A run that stops because the usage limit was hit, or that ends with a [handoff](/commands/handoff), still needs a new session: `/asterweave:resume`, `/asterweave:handoff resume`, or `/loop /asterweave:resume` to retry on an interval.

## Failure behavior

If there is no transcript, no ledger, an unparsable ledger, or the counter can't be written, the hook does nothing. It fails open, never blocking a stop it can't bound.

## Optional handoff reminder

A second, independent script on the same event, `hook-handoff-reminder.mjs`, is **inert unless you configure a threshold**. Set `handoff.contextBudget.warnAtTokens` in [`asterweave.json`](/configuration/asterweave-json), or the `ASTERWEAVE_HANDOFF_WARN_TOKENS` environment variable.

Claude Code doesn't expose the model's context-window size or remaining tokens to hooks. The script reads the most recent main-conversation API usage recorded in the session transcript and treats it as an **approximate** current context size. When that reaches the threshold, it blocks the stop once, with a reason asking Claude to refresh the [handoff](/commands/handoff) and then end the turn. It asks again only when usage grows by another 25% of the threshold, per session.

It respects `stop_hook_active`, never writes a handoff itself, never runs on tool calls, and does nothing when usage isn't recorded. Its only file is a small marker at `.claude/asterweave/handoffs/.reminders.json`.

## Related

[Workflow state](/architecture/workflow-state), [Resume](/commands/resume), [Handoff](/commands/handoff).
