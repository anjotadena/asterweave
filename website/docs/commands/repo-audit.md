---
sidebar_position: 31
title: /asterweave:repo-audit
description: Audit a repository, site or module for defects and gaps.
---

# `/asterweave:repo-audit`

## Purpose

Audit a repository, site or module for defects and gaps. Produces evidence-backed findings with impact, severity, confidence, ownership and verification status. Does not edit code.

## Syntax

```text
/asterweave:repo-audit <repository|url|module> [focus]
```

## Inputs

target (required), focus areas (optional), sample bound (optional).

## Prerequisites

target readable; live sites use ordinary browsing and bounded reads only.

## What happens

1. Pick only the relevant categories: functionality, data correctness, accessibility, usability, performance, security, dependencies, documentation, reliability. One audit, not one skill per category.
2. State the bounded sample (size and coverage) before reading. Do not generalize it into an accuracy claim.
3. Exercise real user journeys through the normal entry point. For each defect capture expected versus observed behavior, reproduction steps and evidence.
4. Treat scanner or tool output as `suspected` until you have assessed its evidence.
5. For budget or transparency data also apply the civic checklist and name where a discrepancy originates.
6. Security probing runs only against local fixtures or an explicitly authorized environment. Put sensitive findings on the private reporting route, not in public drafts.
7. Record each unreachable site, issue list or document as `unavailable`, not as clean.

## Outputs

findings using the finding record, sample size and coverage statement, unavailable sources.

## Verification and stop conditions

- Verified when: every finding has evidence references and a status; scanner output stays suspected until assessed.
- Stops when: findings reviewed, sample bound reached, a required source is unavailable.
- Follow-up skills: issue-triage, bug-fix, feature-implement.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
