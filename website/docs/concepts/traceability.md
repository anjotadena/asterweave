---
sidebar_position: 4
title: Traceability
description: How Asterweave keeps a chain from work item to pull request.
---

# Traceability

Where a spec exists, Asterweave keeps evidence linkable back to it:

```text
work item  →  requirement / use case  →  acceptance criteria  →  change evidence  →  tests  →  pull request
```

For example:

```text
ADO-4821 (or a GitHub issue)
   ↓
FR-4821-01
   ↓
UC-4821-01
   ↓
Acceptance criteria (resolved during `challenge`)
   ↓
Code (the `implement` node's diff)
   ↓
Tests (the `test` node's evidence)
   ↓
Pull Request #391
```

Asterweave uses the identifiers already present in the task and spec — `FR-###`, `UC-###`, the issue or work-item number — inside evidence summaries and the PR body, instead of inventing new tracking fields. It does not add traceability comments to source code merely to satisfy this; the evidence ledger and PR body are the record.

## Why this matters

- **Debugging** — a failing check or a production incident traces back to the exact requirement and use case it violates.
- **Impact analysis** — before changing behavior, you can see which requirements and use cases depend on it.
- **Review** — a reviewer can check the PR against the acceptance criteria it claims to satisfy, not just the diff.
- **AI context** — later Asterweave nodes (and future deliveries) can resolve `UC-024` back to its file instead of re-deriving intent from code.
- **Regression protection** — a regression test tied to `FR-###` makes the requirement executable, not just documented.
- **Compliance** — an auditable chain from requirement to shipped code and its review evidence, without a separate tracking system.

## Next

See [the graph contract's traceability section](/architecture/overview#traceability) for how this is enforced mechanically, and [Specifications](/concepts/specifications) for the identifiers themselves.
