---
sidebar_position: 3
title: Specifications
description: How Asterweave reads and links to specs/ without ever generating one.
---

# Specifications

Specs describe **what the system must do**. `.claude/` describes **how this repository is built**. Asterweave keeps these separate on purpose, and never requires a `specs/` directory — it only reads and links to one when a repository already has it, and helps create individual spec documents when a task genuinely needs one.

## Location and shape

```text
specs/
  requirements.md        stable functional/non-functional requirements and constraints
  domain.md               entity/domain vocabulary
  use-cases/
    UC-024-refund.md
```

Larger systems may scope this by bounded context instead of one flat `specs/`:

```text
specs/
  finance/
    use-cases/UC-024-refund.md
  inventory/
```

Asterweave uses whichever structure a repository already has; it does not restructure `specs/` as part of an unrelated task.

## Identifiers

| Prefix | Meaning |
| --- | --- |
| `FR-###` | A functional behavior the system must exhibit |
| `NFR-###` | A quality attribute — performance, availability, accessibility, etc. |
| `C-###` | A constraint the design must respect |
| `UC-###` | A system use case: actors, preconditions, main flow, alternate flows, postconditions |

Evidence and pull-request bodies reference these identifiers directly rather than inventing new tracking fields — see [Traceability](/concepts/traceability).

## Proportional rigor

Match the artifact to the size of the change:

| Change size | Expected artifacts |
| --- | --- |
| Small bug fix | Task + acceptance criteria + existing tests. No spec changes needed. |
| Normal feature | Task + a system use case + acceptance criteria. Add or update the relevant `UC-###`. |
| Complex / high-risk feature | Requirements, domain impact, use cases, acceptance criteria, and architecture implications. Update `specs/` before `plan`. |

:::note
Do not block implementation on a spec that doesn't exist for a small, well-understood change. `challenge` has a `READY_WITH_ASSUMPTIONS` verdict for exactly this case.
:::

## How the workflow uses specs

- `analyze` treats an existing `specs/` directory as a repository fact and records applicable spec paths in the [context manifest](/architecture/overview#context-manifest).
- `challenge` reads applicable specs before challenging requirements, and treats a contradiction between the task and an existing spec as a **blocker**, not a silent override.
- For a normal or complex feature with no matching use case, `challenge` or `plan` may propose creating or updating one — Asterweave treats this like any other write: it shows the exact diff and gets your approval before committing it, and never rewrites an existing spec merely for formatting.
- `plan` links its implementation DAG to the relevant `FR-`/`UC-` identifiers when they exist.

## Next

[Traceability](/concepts/traceability) covers how these identifiers stay connected from work item to pull request.
