---
sidebar_position: 2
title: PreToolUse — destructive-command guard
description: Blocks a fixed list of destructive shell commands before they run.
---

# PreToolUse: destructive-command guard

## Event

`PreToolUse`, matched against the `Bash` and `PowerShell` tools.

## Purpose

Blocks a small, fixed set of known high-impact shell commands before they execute — defense in depth against accidental or induced data loss, not a complete safety system.

## Behavior

`hook-guard.mjs` reads the tool's proposed command from the hook payload and tests it against a fixed list of regular expressions. On a match, it returns a `PreToolUse` `permissionDecision: "deny"` with a human-readable reason; otherwise the tool call proceeds unmodified.

## What it blocks

| Command pattern | Reason |
| --- | --- |
| A hard Git reset | Can destroy uncommitted work |
| A forced Git clean | Can delete untracked files |
| A bulk Git checkout/restore of `.` | Can discard user changes |
| A forced Git push (`--force`, `--force-with-lease`, `-f`) | Force-push requires an explicit manual operation |
| Recursive-force `rm` against `/`, `~`, `..`, `$HOME` | Broad recursive deletion is prohibited |
| Recursive-force `Remove-Item` against a root path | Broad recursive PowerShell deletion is prohibited |
| Dropping a database/schema, or truncating a table | Destructive database operations require a separate approved runbook |
| A global forced Docker system prune | Global Docker pruning can remove unrelated data |
| Deleting a Kubernetes namespace | Namespace deletion is outside autonomous coding scope |
| Terraform's destroy command | Infrastructure destruction is outside autonomous coding scope |

## What it asks about

Asterweave lands work through a pull request and its required checks ([`/asterweave:submit-pr`](/commands/submit-pr)). A push that would skip that returns `permissionDecision: "ask"`, so you confirm it yourself:

| Command | Why it asks |
| --- | --- |
| `git push <remote> main` / `master`, including `HEAD:main` and `refs/heads/master` refspecs | Pushes directly to the default branch |
| A bare `git push` while `main` or `master` is checked out | Same, through the upstream |
| `git push --all` or `--mirror` | Can land work on the default branch |

Pushing a feature branch, pushing tags, and deleting a remote branch are not affected. Approve the prompt when you asked for a direct push; set `ASTERWEAVE_ALLOW_DEFAULT_BRANCH_PUSH=1` to turn the check off for a session.

## Configuration

No repository-level configuration is needed or expected — the block list is fixed in the plugin. Setting the environment variable `ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD=1` disables the guard entirely; this exists for the plugin's own test suite, not as a normal operational escape hatch. Do not disable it to get past a workflow obstacle — see [Security](/repositories/repository-integration#github-token-posture).

## Failure behavior

A blocked command never runs; Claude receives the denial reason and continues with a reversible alternative. The hook itself fails safe (returns "not blocked") if it cannot parse its input.

## Related

Asterweave wires a second, independent `PreToolUse` hook for file-write tools — see [Workstream ownership guard](/hooks/ownership-guard). Also: [Git and change safety](/repositories/repository-integration#git-and-change-safety), [Stop hook](/hooks/stop).
