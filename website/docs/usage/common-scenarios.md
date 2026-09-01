---
sidebar_position: 8
title: Common scenarios
description: Situation-based quick reference for everyday Asterweave use.
---

# Common scenarios

Each row: situation → recommended command → what happens → what you do.

## First day on an existing repository

**Situation:** Repository has no Asterweave context yet.
**Command:** [`/asterweave:scaffold --dry-run`](/commands/scaffold), then `/asterweave:scaffold`.
**Asterweave:** Proposes an evidence-backed `CLAUDE.md`/`.claude/rules/`/`.claude/asterweave.json`.
**You:** Review and approve the digest; correct anything it detected wrong before committing the result.

## Starting a normal ticket

**Situation:** An assigned, reasonably well-understood issue.
**Command:** [`/asterweave:deliver <id>`](/commands/deliver).
**Asterweave:** Runs the full graph, pausing for plan approval and PR confirmation.
**You:** Approve the plan; review the PR.

## Small bug fix

**Situation:** A narrow, well-understood defect.
**Command:** `/asterweave:deliver <id>`.
**Asterweave:** Uses proportional rigor — ticket, acceptance criteria, existing behavior, regression test, small implementation.
**You:** Review the PR; usually little else.

## Large or ambiguous feature

**Situation:** Significant scope, or a ticket that reads ambiguously.
**Command:** `/asterweave:analyze <id>` → `/asterweave:challenge <id>` → resolve questions → `/asterweave:plan <id>` → approve → `/asterweave:deliver <id>`.
**Asterweave:** Surfaces blockers before any implementation attempt.
**You:** Answer the specific questions raised; approve the plan.

## Existing PR needs fixes after a review comment

**Situation:** A reviewer left comments on a PR Asterweave created.
**Command:** [`/asterweave:resume`](/commands/resume) (if the workflow is still active) or re-run `/asterweave:deliver <id>`.
**Asterweave:** Triages each comment as actionable or informational; actionable ones route through `implement`.
**You:** Answer anything that requires a business decision.

## Pipeline failed

**Situation:** A required CI check failed after PR submission.
**Command:** Nothing extra — this is handled inside `deliver`'s `monitor-pipeline` node.
**Asterweave:** Diagnoses, fixes if safe, re-verifies, and re-pushes, within its retry budget.
**You:** Respond if it reports `needs-human` after exhausting retries. See [Pipeline failures](/usage/pipeline-failures).

## You changed code manually

**Situation:** You wrote code outside `deliver` and want it checked.
**Command:** [`/asterweave:review`](/commands/review).
**Asterweave:** Independent staff and security review of the complete diff.
**You:** Address Critical/High findings before opening a PR.

## Repository architecture changed

**Situation:** A framework upgrade, reorganization, or new testing tooling.
**Command:** [`/asterweave:scaffold --refresh`](/commands/scaffold).
**Asterweave:** Reconciles `.claude/` against current reality.
**You:** Approve the updated digest.

## You need a new project rule

**Situation:** Asterweave keeps proposing something that conflicts with an intentional project convention.
**Command:** Add or edit a file under `.claude/rules/`.
**You:** See [Adding a project rule](/usage/repository-maintenance#adding-a-project-rule).

## You need a domain-specific agent

**Situation:** A change touches regulated or highly specialized domain logic.
**Command:** Add `.claude/agents/<name>.md` and route to it in `.claude/asterweave.json`.
**You:** See [Adding a project-specific agent](/usage/repository-maintenance#adding-a-project-specific-agent).

## Resuming yesterday's work

**Situation:** A session ended mid-delivery.
**Command:** [`/asterweave:resume`](/commands/resume).
**Asterweave:** Continues from recorded state, revalidating only stale evidence.
**You:** Confirm you want to continue; answer any pending question.

## Scaffold finds a conflicting local agent

**Situation:** `/asterweave:scaffold --check` reports a duplicate agent.
**Command:** `/asterweave:scaffold --refresh`.
**Asterweave:** Proposes `KEEP`/`MERGE`/`REMOVE` for the conflicting agent, with evidence.
**You:** Approve the classification, or override it with your own reasoning.

## An existing spec conflicts with the ticket

**Situation:** `challenge` reports a contradiction between the task and `specs/`.
**Command:** No special command — resolve the product question directly.
**Asterweave:** Treats the contradiction as a blocker, not a silent override; proposes the spec update once you've decided.
**You:** Make the call; approve the spec change.

## Related

[Cheat sheet](/usage/cheat-sheet), [Daily workflow](/usage/daily-workflow).
