---
sidebar_position: 3
title: /asterweave:analyze
description: Read-only repository and impact analysis.
---

# `/asterweave:analyze`

## Purpose

Analyzes a task and repository **without changing files**, producing stack, architecture, dependency, blast-radius, baseline, and risk evidence. This is the first working node of `/asterweave:deliver`'s graph, and can also be run alone to understand a change before committing to a plan.

## Syntax

```text
/asterweave:analyze <goal|issue>
```

## Arguments

`<goal|issue>` — a free-text goal or an issue reference (for example `owner/repo#123`).

## Options

None.

## Prerequisites

None. Read-only by design.

## What happens

1. Reads repository instructions, stack-discovery guidance, the repository adapter, and (if present) `specs/`.
2. Resolves the `analyze` [route](/architecture/agent-routing) — a configured project skill/agent, or `asterweave:repo-analyzer`.
3. Runs `detect-stack.mjs` and verifies its signals against manifests, CI, documentation, and code — treating detection as a signal, not an authority.
4. Traces the task from entry points through business logic, data boundaries, external contracts, callers, and tests.
5. Finds analogous implementations and records conventions to reuse.
6. Inspects Git status and reports (without touching) user changes.
7. Identifies affected components, data/API/config/deployment impact, security boundaries, and likely regressions.
8. Discovers repository-native build/test commands and runs only safe, read-only or baseline checks the repository already defines.
9. When run inside an active `deliver` workflow, writes the [context manifest](/architecture/overview#context-manifest) so later nodes reuse this bounded context instead of re-scanning the repository.

## Agents used

The project's routed `analyze` agent, or `asterweave:repo-analyzer` by default.

## Files modified

None, except the workflow-state context manifest (`.claude/asterweave/context-manifest.json`) when run inside an active `deliver` workflow.

## External side effects

None.

## Output

Facts with file references, assumptions, unknowns, blast radius, baseline command evidence, risks, and a recommended next graph node.

## Examples

```text
/asterweave:analyze owner/repo#123
```

```text
/asterweave:analyze "why does checkout total round incorrectly for split payments?"
```

## Common errors

- **Detected commands don't match reality** — `analyze` cross-checks `detect-stack.mjs` output against manifests and CI rather than trusting it blindly; if they diverge, it reports the discrepancy instead of guessing.

## Related commands

[`/asterweave:challenge`](/commands/challenge) to grill the resulting understanding before planning; [`/asterweave:deliver`](/commands/deliver) to run the full graph, of which this is the first stage.
