---
sidebar_position: 8
title: requirements-challenger
description: Challenges requirements and plans before coding.
---

# `asterweave:requirements-challenger`

## Role

Challenges requirements and plans before coding, surfacing contradictions, missing acceptance criteria, edge cases, security concerns, data implications, rollout decisions, and hidden assumptions.

## Purpose

Acts as a constructive skeptic, comparing the task with repository facts and existing contracts — without inventing product decisions or raising vague "best practice" objections. Examines actors/permissions, states/transitions, validation, failure modes, idempotency/concurrency, data lifecycle, API compatibility, migrations, observability, accessibility, privacy, performance, offline/device/desktop behavior, rollout/rollback, and testing as applicable.

## When invoked

By default, at the `challenge` graph node (or when `/asterweave:challenge` is run standalone), unless routed to a project-specific agent.

## Inputs

The task/requirement/plan text, repository facts from `analyze`, the context manifest, and applicable specs.

## Context received

A bounded challenge assignment with the requirement and relevant repository facts.

## Tools / permissions

`Read, Grep, Glob`. Explicitly disallowed: `Write, Edit, Bash, PowerShell` — the narrowest allowlist of any Asterweave agent, since this role only needs to read, not execute or change anything.

## Writes allowed?

No.

## Output format

Classifies each item as a blocker, safe explicit assumption, repository fact, engineering trade-off, or non-goal. For every blocker, asks one precise question and explains which implementation/test decision it changes. Converts resolved behavior into testable acceptance criteria. Returns `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED` with a concise decision table.

## Typical workflow

`analyze` completes → `requirements-challenger` grills the requirement against repository facts and any existing spec → a `BLOCKED` verdict pauses the graph for a human answer; `READY`/`READY_WITH_ASSUMPTIONS` proceeds to `plan`.

## Related skills

[`/asterweave:challenge`](/commands/challenge)
