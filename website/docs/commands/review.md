---
sidebar_position: 9
title: /asterweave:review
description: Independent staff-engineering and security review of the complete diff.
---

# `/asterweave:review`

## Purpose

Runs independent staff-engineering **and** security reviews over the complete diff and affected consumers, then separates blocking defects from optional improvements. This is the only review command — there is no separate "security-review" command; security review is always a second, independent pass inside this one.

## Syntax

```text
/asterweave:review [base-branch|scope]
```

## Arguments

`[base-branch|scope]` — optional; defaults to reviewing the current change against its base branch.

## Options

None.

## Prerequisites

Most meaningful after implementation and verification, against a concrete diff.

## What happens

1. Reads complete touched files, the diff, tests, acceptance evidence, downstream consumers of changed interfaces, the context manifest, and the repository adapter. Resolves the `review` route, then delegates the staff pass to the project agent or `asterweave:staff-reviewer`.
2. Checks correctness, architecture boundaries, authorization, security, data integrity, concurrency, error behavior, backward compatibility, performance, accessibility, observability, migrations, and maintainability.
3. Validates test quality and identifies behavior not covered by unit/integration/runtime evidence.
4. Delegates a **separate** pass to `asterweave:security-reviewer`, without leaking the staff pass's expected findings — a genuinely independent second opinion.
5. Verifies every reported issue is real and introduced or exposed by this change.
6. Reports findings by `Critical`, `High`, `Medium`, or `Low`, with file/location, evidence, impact, recommended fix, and trade-off. Critical/High findings are graph blockers.

## Agents used

The project's routed `review` agent (or `asterweave:staff-reviewer` by default) for the staff pass; `asterweave:security-reviewer` always, independently, for the security pass.

## Files modified

None — review is read-only. Actionable findings route back to `implement`.

## External side effects

None.

## Output

A verdict, plus `code-review` and `security-review` evidence summaries. If no blocking findings exist, it says so explicitly rather than inventing issues.

## Examples

```text
/asterweave:review
```

```text
/asterweave:review main
```

## Common errors

- **Critical/High finding** — blocks the graph; Asterweave routes back to `implement` rather than proceeding to `submit-pr`.

## Related commands

Follows [`/asterweave:verify`](/commands/verify); followed by [`/asterweave:submit-pr`](/commands/submit-pr).
