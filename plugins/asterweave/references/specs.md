# Project specifications

Specs describe **what the system must do**; `.claude/` describes how this repository is built. Keep them separate. Asterweave never requires a `specs/` directory and never generates one during scaffolding — it only reads and links to one when a repository already has it, and helps create individual spec documents when a task genuinely needs one.

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

Use whichever existing structure the repository already has; do not restructure it as part of an unrelated task.

## Identifiers

- `FR-###` — a functional behavior the system must exhibit.
- `NFR-###` — a quality attribute (performance, availability, accessibility, etc.).
- `C-###` — a constraint the design must respect.
- `UC-###` — a system use case: actors, preconditions, main flow, alternate flows, postconditions.

Reference existing identifiers in evidence and PR bodies rather than inventing new tracking fields; see [traceability](graph-contract.md#traceability).

## Proportional rigor

Match the artifact to the change, per [the graph contract](graph-contract.md):

| Change size | Expected artifacts |
| --- | --- |
| Small bug fix | Task + acceptance criteria + existing tests. No spec changes needed. |
| Normal feature | Task + a system use case + acceptance criteria. Add or update the relevant `UC-###`. |
| Complex / high-risk feature | Requirements, domain impact, use cases, acceptance criteria, and architecture implications. Update `specs/` before `plan`. |

## Workflow integration

- `analyze` treats an existing `specs/` directory as a repository fact and records applicable spec paths in the [context manifest](graph-contract.md#context-manifest).
- `challenge` reads applicable specs before challenging requirements and flags contradictions between the task and an existing spec as a blocker, not a silent override.
- For a normal or complex feature with no matching use case, `challenge` or `plan` may propose creating or updating one; treat this like any other write — show the exact diff and get approval before committing it, and never rewrite an existing spec merely for formatting.
- `plan` links its DAG to the relevant `FR-`/`UC-` identifiers when they exist.

Do not block implementation on a spec that does not exist for a small, well-understood change; use `challenge`'s `READY_WITH_ASSUMPTIONS` verdict instead.
