---
name: repo-audit
description: Audit a repository, site or module for defects and gaps. Produces evidence-backed findings with impact, severity, confidence, ownership and verification status. Does not edit code.
argument-hint: "<repository|url|module> [focus]"
model: sonnet
effort: high
asterweave-skill: 1
triggers: audit, find bugs, look for defects, check for gaps, assess the repository, assess the site
inputs: target (required), focus areas (optional), sample bound (optional)
prerequisites: target readable; live sites use ordinary browsing and bounded reads only
outputs: findings using the finding record, sample size and coverage statement, unavailable sources
capabilities: read, search, browse-read, run-tests
verification: every finding has evidence references and a status; scanner output stays suspected until assessed
stop-when: findings reviewed, sample bound reached, a required source is unavailable
follow-ups: issue-triage, bug-fix, feature-implement
---

# Repository audit

Target: `$ARGUMENTS`. Use the finding record, status mapping and civic checklist in the [contribution reference](../../references/contribution.md).

1. Pick only the relevant categories: functionality, data correctness, accessibility, usability, performance, security, dependencies, documentation, reliability. One audit, not one skill per category.
2. State the bounded sample (size and coverage) before reading. Do not generalize it into an accuracy claim.
3. Exercise real user journeys through the normal entry point. For each defect capture expected versus observed behavior, reproduction steps and evidence.
4. Treat scanner or tool output as `suspected` until you have assessed its evidence.
5. For budget or transparency data also apply the civic checklist and name where a discrepancy originates.
6. Security probing runs only against local fixtures or an explicitly authorized environment. Put sensitive findings on the private reporting route, not in public drafts.
7. Record each unreachable site, issue list or document as `unavailable`, not as clean.

This skill never edits code. Hand findings to `issue-triage`.
