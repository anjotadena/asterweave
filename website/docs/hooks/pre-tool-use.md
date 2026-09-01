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

## Configuration

No repository-level configuration is needed or expected — the block list is fixed in the plugin. Setting the environment variable `ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD=1` disables the guard entirely; this exists for the plugin's own test suite, not as a normal operational escape hatch. Do not disable it to get past a workflow obstacle — see [Security](/repositories/repository-integration#github-token-posture).

## Failure behavior

A blocked command never runs; Claude receives the denial reason and continues with a reversible alternative. The hook itself fails safe (returns "not blocked") if it cannot parse its input.

## Related

[Git and change safety](/repositories/repository-integration#git-and-change-safety), [Stop hook](/hooks/stop).
