---
sidebar_position: 10
title: scaffold-auditor
description: Independently audits a proposed repository scaffold before approval.
---

# `asterweave:scaffold-auditor`

## Role

Independently audits a proposed repository scaffold for evidence accuracy, context efficiency, duplication, unsafe commands, excessive agents/skills, conflicts, invalid routing, and maintainability before approval.

## Purpose

Verifies that every instruction, path glob, command, framework/version claim, architectural rule, test gate, agent role, skill workflow, and adapter route is supported by current repository evidence — rejecting invented thresholds, guessed commands, stale documentation, unsafe practices, absolute local paths, placeholders, secrets, and duplication across artifacts. Independently re-classifies every existing `.claude/agents/*.md`, and rejects a proposal that keeps an agent duplicating a generic role, or removes one with genuine bounded domain expertise.

## When invoked

During `/asterweave:scaffold`'s "validate, audit, and approve" phase, always independently from `scaffold-architect`.

## Inputs

The scaffold proposal produced by `scaffold-architect`, and the repository sources it cites.

## Context received

The full proposal plus enough repository access to independently re-verify its claims — not the architect's reasoning, only its output and the raw evidence.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit, Agent`.

## Writes allowed?

No.

## Output format

An audit verdict covering: whether each always-loaded `CLAUDE.md` line belongs there, whether each rule needs its declared path scope, whether each skill is genuinely reusable, whether each reference is linked, whether each agent justifies isolated context and its tool permissions, whether project task skills replace legacy command duplication, and whether repository policy tightens (never bypasses) Asterweave's mandatory gates.

## Typical workflow

Runs after `scaffold-architect` proposes a scaffold and before a human ever sees the digest — an independent second opinion, not a rubber stamp.

## Related skills

[`/asterweave:scaffold`](/commands/scaffold)
