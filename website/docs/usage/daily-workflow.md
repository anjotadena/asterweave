---
sidebar_position: 2
title: Daily developer workflow
description: The recommended everyday loop, from a small bug to a complex feature.
---

# Daily developer workflow

## Start of day

1. Open the repository.
2. Update your local base branch if that's part of your team's normal routine (Asterweave doesn't do this for you).
3. Run [`/asterweave:daily`](/commands/daily) to see assigned issues, requested reviews, and failing CI in one read-only pass — including whether an Asterweave workflow is already in progress and resumable.
4. Pick a work item.

## Normal feature delivery

```text
/asterweave:deliver 4821
```

Asterweave reads the ticket and its comments, loads repository context, loads or creates the relevant specification, explores the implementation, plans, prepares a feature branch, implements, tests, verifies, reviews, creates the PR, monitors the pipeline, and reports back — pausing for your approval after the plan, and again before push/PR unless you passed `--auto-pr`.

You normally review: the interpretation of requirements when something was ambiguous, important architecture decisions in the plan, security-sensitive or high-risk actions, and the resulting PR. You do not need to manually invoke every internal agent — the orchestrator decides which agents and checks a given change needs.

## Simple bug fix

**Ticket:** "Incorrect date shown on payment history."

```text
/asterweave:deliver 5102
```

For a small, well-understood bug, `challenge` may return `READY_WITH_ASSUMPTIONS` rather than demanding a full spec — proportional rigor means the expected artifacts are just the ticket, acceptance criteria, existing behavior, and a regression test. See [Proportional rigor](/concepts/specifications#proportional-rigor).

## Normal feature

**Ticket:** "Prevent duplicate refunds" (`ADO-4821`).

```text
/asterweave:deliver 4821
```

For a normal feature, `challenge` or `plan` may propose a use case (`FR-4821-01`, `UC-4821-01`) if the repository has a `specs/` directory and no matching use case exists yet — always shown to you for approval before being written. Expect: plan → implementation → tests → independent security and code review → PR.

## Complex or high-risk feature

**Example:** "Add partial purchase-order receiving with multiple suppliers."

For work this size, run the earlier stages explicitly first so you have a stronger checkpoint before implementation begins:

```text
/asterweave:analyze 4821
/asterweave:challenge 4821
```

Review the resulting decision table, resolve any ambiguity it surfaces, and only then:

```text
/asterweave:plan 4821
```

Once you're satisfied with the plan, run:

```text
/asterweave:deliver 4821
```

`deliver` still runs its own `analyze`/`challenge`/`plan` nodes — standalone runs don't persist into `deliver`'s workflow state, and `deliver` re-derives evidence itself rather than trusting a separate exploration. What the standalone pass buys you is a human checkpoint *before* you commit to the full run: if `challenge` would have returned `BLOCKED`, you find out — and resolve it — before an autonomous implementation attempt even starts, rather than partway through one.

## Related

[Starting new work](/usage/starting-new-work), [Command overview](/commands/overview), [Cheat sheet](/usage/cheat-sheet).
