---
sidebar_position: 8
title: /asterweave:verify
description: Independently verify observable behavior against acceptance criteria.
---

# `/asterweave:verify`

## Purpose

Independently verifies implemented behavior against acceptance criteria in the **running application or executable environment**, producing an evidence matrix rather than relying only on tests.

## Syntax

```text
/asterweave:verify <acceptance-criteria|issue>
```

## Arguments

`<acceptance-criteria|issue>` — the approved acceptance criteria, or an issue reference to resolve them from.

## Options

None.

## Prerequisites

A build that can actually run. Independent from the implementer — does not treat passing unit tests alone as proof.

## What happens

1. Reads the approved acceptance criteria, the evidence contract, the context manifest, and the repository adapter. Resolves the `verify` route, then delegates to the project agent or `asterweave:verification-engineer`.
2. Builds and launches the application with repository-native commands and required local dependencies.
3. Exercises the affected behavior through its real boundary — browser, API, CLI, worker, mobile simulator/device, desktop process, database, or integration harness.
4. Covers happy path, failure path, permissions, persistence, compatibility, and user-visible states proportional to risk.
5. Captures reproducible evidence: commands, inputs, output/status, screenshots or artifact paths, timestamps, and environment limitations.

## Agents used

The project's routed `verify` agent, or `asterweave:verification-engineer` by default. Never modifies code, configuration, fixtures, or data outside approved ephemeral test setup, and never uses production credentials or environments.

## Files modified

None, except ephemeral, approved test data.

## External side effects

None beyond exercising the application in a non-production environment.

## Output

An acceptance-criteria matrix with `PASS`, `FAIL`, or `BLOCKED` per criterion, plus one `acceptance` evidence summary and stable failure signatures for anything that fails.

## Examples

```text
/asterweave:verify "refund cannot exceed the original payment amount"
```

## Common errors

- **`BLOCKED`** — the environment couldn't be built/launched or a dependency is missing; this is reported as a blocker, not silently skipped.

## Related commands

Follows [`/asterweave:test`](/commands/test); followed by [`/asterweave:review`](/commands/review).
