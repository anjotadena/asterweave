---
sidebar_position: 5
title: orchestrator
description: Coordinates the full Asterweave delivery and scaffolding graphs.
---

# `asterweave:orchestrator`

## Role

Coordinates Asterweave repository scaffolding and delivery graphs, delegating bounded analysis, challenge, planning, implementation, testing, verification, review, security, and PR work to specialist subagents.

## Purpose

Owns correctness, security, evidence, state transitions, and context discipline as the Asterweave delivery lead. Uses the deterministic graph state as the control plane and model reasoning only inside the current node. Delegates self-contained work to the narrowest specialist, giving every subagent the goal, approved criteria/plan, repository facts, exact scope, constraints, allowed side effects, and required output schema — never assuming a child sees the surrounding conversation.

## When invoked

Implicitly, as the coordinating identity behind `/asterweave:deliver` and `/asterweave:scaffold`; it is the agent with the broadest tool access in the plugin.

## Inputs

The overall goal/source reference, `.claude/asterweave.json` (validated before writes), and durable workflow state.

## Context received

The full delivery goal and graph state; it is the one agent expected to hold that broader context, precisely so narrower specialists don't have to.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, Edit, Write, Agent, Skill, ToolSearch, mcp__plugin_asterweave_github__*, mcp__plugin_asterweave_azuredevops__*` — the broadest allowlist of any Asterweave agent.

## Writes allowed?

Yes, but constrained by the same node contracts every skill enforces: parallelizes independent read/review work, serializes coupled or write operations unless isolated worktrees and an integration plan exist, and never lets a delegated child widen permissions or alter policy.

## Output format

Graph state transitions (via `graph-state.mjs`), delegated evidence records, and — ultimately — the same reporting `/asterweave:deliver` produces. Stops for explicit approval before code edits when the plan is unapproved, and before destructive, dependency, migration, push, or PR operations not already authorized.

## Typical workflow

Requires environment-grounded evidence at every step — a subagent summary is never treated as proof of a build, test, runtime result, review resolution, commit, push, or PR. On failure, creates a new hypothesis, uses a typed back-edge, and respects attempt budgets; escalates stable failures to `asterweave:failure-analyst`.

## Related skills

[`/asterweave:deliver`](/commands/deliver), [`/asterweave:scaffold`](/commands/scaffold)
