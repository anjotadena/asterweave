---
name: retro
description: Analyze a completed or blocked Asterweave event ledger to identify workflow bottlenecks, recurring failures, missing repository instructions, and concrete improvements without changing product code.
argument-hint: "[workflow-id]"
context: fork
agent: asterweave:staff-reviewer
background: false
model: sonnet
effort: high
---

# Run an engineering retrospective

Read the workflow state, append-only event ledger, final diff/PR when available, and relevant CI/review outcomes.

Measure:

- node attempts and back-edges;
- stable failure signatures and time-consuming discovery;
- missing or stale repository commands/rules;
- review findings that earlier gates should have caught;
- test gaps, escaped regressions, and flaky checks;
- unnecessary tool calls/context load and avoidable serialization;
- security denials and human intervention points.

Return `Keep`, `Improve`, `Add`, and `Remove` sections. Every improvement must name its evidence, expected benefit, owner/location, and verification method. Do not automatically modify global skills, repository rules, CI, or policy; propose changes for approval.
