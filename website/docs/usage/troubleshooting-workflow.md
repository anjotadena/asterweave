---
sidebar_position: 10
title: Debugging a delivery
description: How to read workflow state when a delivery isn't behaving as expected.
---

# Debugging a delivery

When a `/asterweave:deliver` run isn't doing what you expect, work through these in order.

## 1. Check the workflow state directly

```text
/asterweave:resume --inspect-only
```

This is read-only and gives you the goal, current node, completed evidence, attempts/budgets, blocker, and any repository divergence since the last recorded event — usually enough to see exactly where things stand.

## 2. Run the health check

```text
/asterweave:doctor --verbose
```

Confirms the plugin, hooks, MCP connectivity, stack detection, and graph-state file are all healthy, and distinguishes a **valid blocked workflow** from **corrupted state**.

## 3. Check for repository drift

```text
/asterweave:scaffold --check
```

A surprising agent selection, missing quality gate, or unexpected routing often traces back to `.claude/asterweave.json` drifting from what the repository actually looks like now.

## 4. Read the event ledger

`.claude/asterweave/events.jsonl` is an append-only, human-readable record of every node transition, evidence entry, and edge taken. For a pattern across multiple deliveries (not just one), [`/asterweave:retro`](/commands/retro) analyzes this automatically and proposes concrete improvements.

## 5. Consult the specific symptom

See [Common issues](/troubleshooting/common-issues) for a symptom → cause → resolution table covering detection problems, scaffold churn, agent conflicts, hook denials, missing commands, work-item load failures, existing PRs, invalid configuration, and stale specs.

## What not to do

- Don't hand-edit `.claude/asterweave/state.json` or `events.jsonl` — both are owned exclusively by `graph-state.mjs`.
- Don't disable the destructive-command guard to get past an obstacle — fix the underlying command instead.
- Don't start a second `/asterweave:deliver` on the same goal while resumable state exists — resume it.

## Related

[Workflow state](/architecture/workflow-state), [Common issues](/troubleshooting/common-issues), [`/asterweave:doctor`](/commands/doctor).
