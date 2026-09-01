---
sidebar_position: 4
title: PreToolUse — workstream ownership guard
description: Blocks a parallel completion worker from writing outside its assigned module boundary.
---

# PreToolUse: workstream ownership guard

## Event

`PreToolUse`, matched against the `Edit`, `Write`, and `NotebookEdit` tools.

## Purpose

During a [`/asterweave:complete-project`](/commands/complete-project) run, several implementation workers run in parallel — each owning one module, in its own isolated Git worktree. Telling a worker its boundary is not the same as enforcing it. This hook makes the boundary real: a Finance worker attempting `src/Inventory/StockService.cs` is denied before the write happens, with the worker, the path, and the reason in the denial.

## Behavior

`completion-guard.mjs` looks for `.claude/asterweave/completion-worker.json` in the current working directory — the bounded ownership manifest a worker writes inside its own worktree as its first action. If that file is absent, the hook returns immediately and the write proceeds; **every session that is not a completion worker is unaffected.**

When the manifest is present, the target path is resolved relative to the worktree and evaluated in order:

| Match | Decision |
| --- | --- |
| `deny` (a path owned by another workstream) | **Denied** — "Path is owned by another workstream." |
| `write` (this workstream's own paths) | Allowed |
| `approvedShared` (a shared path the orchestrator granted an exclusive lock for) | Allowed |
| `shared` (shared/core code, no lock granted) | **Denied** — file a Shared Change Request with the orchestrator instead |
| Anything else | **Denied** — outside this workstream's approved write boundary |

The default is deny: only explicitly owned or explicitly granted paths are writable. That is what makes concurrent writers safe to run at all.

## Why both worktrees and this hook

Isolated worktrees stop two workers from writing the same working directory at the same time. They do **not** stop one worker from editing another module's files inside its own copy of the repository — a worktree is a full checkout. The worktree gives concurrency safety; this hook gives ownership safety. Both are required.

## Shared code

A worker never widens its own access. It calls `completion-state.mjs lock request`, and the orchestrating session decides: grant an exclusive lock, split the change into its own shared workstream, defer it to the next wave, or replan the dependency graph. Only an approved lock adds a path to `approvedShared`.

## Configuration

No repository-level configuration. Setting `ASTERWEAVE_DISABLE_OWNERSHIP_GUARD=1` disables the guard entirely; it exists for the plugin's own test suite, not as an operational escape hatch. A `WRITE DENIED` during a completion run means the plan's ownership boundaries and the work don't agree — fix the plan or request a shared lock, don't disable the guard.

## Failure behavior

The hook fails safe: unparseable input, a malformed manifest, or a missing manifest all allow the write rather than blocking work. It only ever denies on a positive boundary match.

## Related

[`/asterweave:complete-project`](/commands/complete-project), [Destructive-command guard](/hooks/pre-tool-use), [Workflow state](/architecture/workflow-state).
