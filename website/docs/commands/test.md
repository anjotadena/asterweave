---
sidebar_position: 7
title: /asterweave:test
description: Add and run risk-based unit, integration, contract, and regression tests.
---

# `/asterweave:test`

## Purpose

Designs, adds, and runs risk-based unit, integration, contract, and regression tests using repository-native tooling — while refusing to weaken tests and recording reproducible evidence.

## Syntax

```text
/asterweave:test [scope|changed-files]
```

## Arguments

`[scope|changed-files]` — optional; defaults to the current change scope when omitted.

## Options

None.

## Prerequisites

Most useful after `/asterweave:implement`, against a concrete diff.

## What happens

1. Maps changed behavior and acceptance criteria to tests before writing more tests.
2. Inspects existing test organization, fixtures, builders, mocks, naming, and CI commands.
3. Resolves the `test` route, then delegates to the project agent or `asterweave:test-engineer`.
4. Adds focused tests for success, boundary, negative, failure, authorization, concurrency/idempotency, compatibility, and regression paths as applicable, using integration/contract tests at real boundaries — never mocking the behavior being validated.
5. Runs targeted tests first, then configured quality gates, required broader suites, build, lint/static analysis, and coverage commands already defined by the repository.
6. Investigates failures rather than deleting, skipping, relaxing, over-mocking, snapshot-blessing, or lowering coverage to pass.

## Agents used

The project's routed `test` agent, or `asterweave:test-engineer` by default. May edit test files and test-only fixtures/configuration; never production code.

## Files modified

Test files and test fixtures/configuration within the assigned scope.

## External side effects

None.

## Output

Exact commands, exit status, test counts, coverage delta when available, skipped checks with justification, failure signatures, and `unit-test` plus `integration-test` evidence summaries.

## Examples

```text
/asterweave:test
```

```text
/asterweave:test src/payments/
```

## Common errors

- **A test failure reveals a production defect** — the test agent reports it with a stable failure signature and routes it back to `implement` rather than editing production code itself.

## Related commands

Follows [`/asterweave:implement`](/commands/implement); followed by [`/asterweave:verify`](/commands/verify).
