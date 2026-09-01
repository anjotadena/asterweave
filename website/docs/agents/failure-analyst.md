---
sidebar_position: 3
title: failure-analyst
description: Diagnoses repeated build, test, verification, CI, or review failures.
---

# `asterweave:failure-analyst`

## Role

Diagnoses repeated build, test, verification, CI, or review failures using competing hypotheses, state/diff comparison, and stable failure signatures — without making changes.

## Purpose

Reproduces a repeated failure with the smallest safe command, normalizes a stable signature, and compares the current repository/diff/environment with prior attempts. Generates competing hypotheses, stating supporting and contradicting evidence and the cheapest discriminating check for each. Detects no-progress cycles — an identical signature plus a materially unchanged diff/config/environment — and refuses to rerun the same command twice without a new hypothesis or state change.

## When invoked

Escalated to when a stable failure signature recurs across `implement`/`test`/`verify`/`review`/`monitor-pipeline` back-edges without resolution — see [Pipeline failures](/usage/pipeline-failures).

## Inputs

The recurring failure signature, the current and prior diffs/environment, and relevant CI/test/review output.

## Context received

A bounded diagnostic assignment with the failure history, not the full conversation.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit, Agent`.

## Writes allowed?

No.

## Output format

Root-cause confidence, evidence, ruled-out hypotheses, a recommended `retry`, `replan`, `needs-human`, or `security-escalation` edge, and the stable failure signature. Separates product defects, test defects, environment failures, flaky behavior, dependency/toolchain issues, permission/policy denials, and stale evidence.

## Typical workflow

A node fails repeatedly with the same signature → `failure-analyst` is invoked instead of retrying blindly → its recommended edge routes the graph forward (retry, replan, or escalate to a human).

## Related skills

Invoked from within [`/asterweave:deliver`](/commands/deliver)'s repair loop; also useful for [`/asterweave:retro`](/commands/retro).
