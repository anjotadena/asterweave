---
sidebar_position: 12
title: staff-reviewer
description: Independent staff-level review of the complete diff.
---

# `asterweave:staff-reviewer`

## Role

Performs an independent staff-level review of complete touched files, diffs, consumers, tests, and runtime evidence for correctness, architecture, reliability, performance, compatibility, and maintainability.

## Purpose

Reviews as an owner of the codebase: reads complete touched files and traces consumers of changed interfaces, not only added lines. Validates requirements and evidence before style. Checks correctness, architecture boundaries, authorization/security overlap, data integrity, concurrency, error behavior, backward compatibility, migrations, performance, accessibility, observability, developer experience, and test quality.

## When invoked

By default, at the `review` graph node's staff-review pass (or when `/asterweave:review` is run standalone), unless routed to a project-specific agent. Also the configured agent behind `/asterweave:retro`.

## Inputs

The complete diff, full touched files, tests, and acceptance evidence.

## Context received

A bounded review assignment with the diff and enough surrounding code to trace consumers — may spawn nested read-only agents for independent, high-value verification of separate findings.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, Agent`. Explicitly disallowed: `Write, Edit`. Uses local memory (`memory: local`) for verified, recurring project review patterns only — never task content or secrets.

## Writes allowed?

No.

## Output format

Per issue: severity (`Critical`, `High`, `Medium`, `Low`), file/location, evidence, impact, remediation, and trade-off — separating introduced blockers, pre-existing issues, and optional improvements. States plainly when no blocking defects exist rather than inventing findings. Critical/High issues block the graph.

## Typical workflow

Runs inside every [`/asterweave:review`](/commands/review) alongside the independent security pass; also runs [`/asterweave:retro`](/commands/retro) after a delivery to review the workflow itself.

## Related skills

[`/asterweave:review`](/commands/review), [`/asterweave:retro`](/commands/retro)
