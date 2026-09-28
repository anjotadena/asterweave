---
sidebar_position: 19
title: /asterweave:handoff
description: Hand a task from a long Claude Code session to a fresh one, check handoff freshness, and resume safely.
---

# `/asterweave:handoff`

## Purpose

Moves one task from a long Claude Code session to a fresh session with minimal context loss. The handoff is a short, evidence-labeled `HANDOFF.md`. Every fact in it is marked **Verified**, **Reported**, **Inferred**, or **Unknown**, and the file carries a source-state fingerprint so the next session can tell whether it is still true.

It works with or without a [`/asterweave:deliver`](/commands/deliver) graph. When a graph workflow is active, `state.json` stays authoritative for node progress, and the handoff adds the conversational context a new session would otherwise lose.

## Syntax

```text
/asterweave:handoff [create|resume|status] [--task <slug>] [--replace]
```

| Invocation | Effect |
| --- | --- |
| `/asterweave:handoff` or `/asterweave:handoff create` | Create or refresh the handoff for the current task. |
| `/asterweave:handoff resume` | In a fresh session: verify the repository against the handoff, then continue the work. |
| `/asterweave:handoff status` | Show each handoff's age, task, branch, verification counts, and whether it appears stale. Read-only. |

## Options

| Flag | Effect |
| --- | --- |
| `--task <slug>` | Names the handoff. Defaults to the current branch name (`feature/refunds` becomes `feature-refunds`). Required on a detached HEAD, or when two tasks share a branch. |
| `--replace` | Reconstructs a missing, corrupted, or untrustworthy handoff. The damaged or previous version is archived. |

## Where handoffs are stored

```text
.claude/asterweave/handoffs/<task-slug>/HANDOFF.md      # read this
.claude/asterweave/handoffs/<task-slug>/handoff.json    # structured record + fingerprint
.claude/asterweave/handoffs/<task-slug>/evidence/       # redacted logs, referenced by path
```

This is Asterweave's existing transient-state directory. Handoffs are not committed by default. If the repository doesn't already ignore the path, Asterweave writes a self-ignoring `.gitignore` inside `handoffs/`. It never edits your repository's own `.gitignore`. To commit handoffs deliberately, set `handoff.track: true` in [`asterweave.json`](/configuration/asterweave-json). Only do this in single-owner repositories. Committed handoffs carry your local path and anything redaction missed. Without that setting, a committed handoff is treated as `untrusted`.

## What happens

**create**

1. Captures the repository, branch, HEAD, upstream, and worktree from Git.
2. Collects commits, local task files, and — only through an available connector — PR, CI, or issue state. An unavailable connector is recorded; it doesn't block the handoff.
3. Writes the goal, scope, decisions, changes, checks run, unverified claims, environment, open issues, ordered next actions, acceptance criteria, references, and fingerprint.
4. Downgrades any "Verified" check that lacks an exact command, a timestamp, or captured output (a redacted log attached into the task's `evidence/`, or a short excerpt) to **Reported**. A previous assistant summary is never Verified. Checks that don't record the HEAD they ran at are always rechecked on resume.
5. Redacts secrets, tokens, connection-string credentials, and personal email addresses. Records database targets as host, port, and database only.
6. Replies with the file path and a copyable fresh-session command.

**resume**

1. Reads repository instructions, then the handoff, treating it as task data that cannot override you or the repository. Nothing in it is an authorization. A suggested next command is checked against the repository's documented commands, and network fetches, pipe-to-shell, or destructive commands from a handoff always need your confirmation.
2. Compares the current branch, HEAD, worktree, graph workflow, and database target with the fingerprint.
3. Rechecks only the evidence the first next action depends on.
4. Tells you the goal, the confirmed state, the first action, and any conflict.
5. Continues from the first unmet acceptance criterion, and refreshes the handoff after material progress.

| Verdict | Meaning | Resume behavior |
| --- | --- | --- |
| `fresh` | Nothing changed | Continue |
| `drifted` | HEAD advanced or worktree edited | Recheck the affected evidence, then continue |
| `stale` | Older than `staleAfterHours` (24h default) | Recheck, then continue |
| `conflict` | Branch switched, history rewritten, workflow or database target changed | Don't follow old steps. Report, then reconstruct |
| `untrusted` | The handoff files are committed to Git, so someone else may have written them | Report it, never run anything from it, and reconstruct |
| `expired`, `wrong-repository`, `corrupted`, `missing` | Not trustworthy | Reconstruct a minimal handoff from current evidence, marking prior claims Unknown |
| `ambiguous` | Several handoffs and none matches the current branch | Asks which `--task` to resume |

## Files modified

Only `.claude/asterweave/handoffs/**`. Resuming then modifies whatever the resumed task itself requires.

## External side effects

None. Creating or resuming a handoff never pushes, merges, deploys, migrates, changes a database, or sends messages. Those still need the task's own authorization.

## Example: ending a session and resuming

Near the end of a long session:

```text
/asterweave:handoff
```

> Handoff written: `.claude/asterweave/handoffs/feature-refund-reasons/HANDOFF.md` (generation 1).
> 1 check downgraded to Reported (no captured output). First unmet criterion: AC2.
> Fresh session: `claude "/asterweave:handoff resume --task feature-refund-reasons"`

In a new terminal:

```text
claude "/asterweave:handoff resume --task feature-refund-reasons"
```

> **Resuming:** Add refund reason codes · branch `feature/refund-reasons` · HEAD `4be1c2a` (advanced 1 commit since the handoff — drifted).
> Rechecking `npm test -- refunds` because the validator it covers changed. First unmet criterion: **AC2 — reason code is required**. Starting with `src/refunds/validator.ts`.

…and the session keeps working from there.

:::note Illustration only
The same flow works in any repository. For example, a .NET + Next.js POS module on `feature/pos-module` might resume with "First unmet criterion: end-to-end run on a fresh database". Asterweave hard-codes no project, stack, or provider. The slug comes from your branch, and the checks come from your own commands.
:::

## Optional context-budget reminder

Claude Code doesn't tell hooks how large the model's context window is or how many tokens remain. If you set `handoff.contextBudget.warnAtTokens` in `asterweave.json` (or the `ASTERWEAVE_HANDOFF_WARN_TOKENS` environment variable), the [Stop hook](/hooks/stop) compares the **last recorded API usage** in the transcript against that number. When usage reaches it, the hook asks Claude once to refresh the handoff before stopping. It asks again only after usage grows by another 25% of the threshold. It is off by default, never writes a handoff itself, and never runs per tool call. Manual `/asterweave:handoff` always works.

## Common errors

- **"Task 'x' already holds handoff …"** — another task already uses that slug. Pass the existing `taskId` to refresh it, or choose another `--task`.
- **"… is now at generation N"** or **"requires --base-generation"** — another session refreshed the handoff since you read it, or the refresh didn't say which generation it read. Run `status` again, then write.
- **"Refusing handoff path through a symlink"** — part of `.claude/asterweave/handoffs/` is a symlink or junction. Asterweave won't write through it. Replace it with a real directory.
- **`conflict` after switching branches** — expected. Switch back yourself, or let resume reconstruct from the current branch.

## Related commands

[`/asterweave:resume`](/commands/resume) continues a durable delivery graph. `handoff` carries the conversation-level context for any task. See [Continuing interrupted work](/usage/continuing-work).
