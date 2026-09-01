---
sidebar_position: 16
title: /asterweave:retro
description: Improve the workflow itself from its event ledger.
---

# `/asterweave:retro`

## Purpose

Analyzes a completed or blocked Asterweave event ledger to identify workflow bottlenecks, recurring failures, missing repository instructions, and concrete improvements — **without changing product code**.

## Syntax

```text
/asterweave:retro [workflow-id]
```

## Arguments

`[workflow-id]` — optional; defaults to the most recent workflow.

## Options

None.

## Prerequisites

A workflow with recorded state/events — typically run after a delivery completes or gets stuck.

## What happens

Runs in a forked context, delegated to `asterweave:staff-reviewer`. Reads the workflow state, the append-only event ledger, the final diff/PR when available, and relevant CI/review outcomes. Measures node attempts and back-edges, stable failure signatures and time-consuming discovery, missing or stale repository commands/rules, review findings that earlier gates should have caught, test gaps and flaky checks, unnecessary tool calls or avoidable serialization, and security denials/human intervention points.

## Agents used

`asterweave:staff-reviewer` (configured as this skill's agent).

## Files modified

None — every improvement is proposed, not applied. `retro` never automatically modifies global skills, repository rules, CI, or policy.

## External side effects

None.

## Output

`Keep`, `Improve`, `Add`, and `Remove` sections. Every improvement names its evidence, expected benefit, owner/location, and verification method.

## Examples

```text
/asterweave:retro
```

```text
/asterweave:retro wf_2026-01-14T09-30-00Z
```

## Common errors

None specific — a missing or empty event ledger simply yields little to report.

## Related commands

Follows a completed or blocked [`/asterweave:deliver`](/commands/deliver) run.
