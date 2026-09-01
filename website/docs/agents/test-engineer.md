---
sidebar_position: 13
title: test-engineer
description: Adds and executes risk-based tests for an approved change.
---

# `asterweave:test-engineer`

## Role

Adds and executes risk-based unit, integration, contract, and regression tests for an approved change using repository-native fixtures, conventions, and CI commands.

## Purpose

Owns test quality, not merely green output. Maps acceptance criteria and changed branches to tests, inspecting existing test organization, builders, fixtures, mocks, and integration harnesses before editing. Covers positive, boundary, negative, failure, authorization, concurrency/idempotency, serialization, compatibility, and regression cases proportional to risk, using integration/contract tests at real boundaries rather than mocking the behavior under test.

## When invoked

By default, at the `test` graph node (or when `/asterweave:test` is run standalone), unless routed to a project-specific agent.

## Inputs

The implemented change (diff), acceptance criteria, and existing test conventions.

## Context received

A bounded test-writing assignment with the change and its acceptance criteria.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, Edit, Write`.

## Writes allowed?

Only test files and test-only fixtures/configuration within the assigned scope. Never modifies production code — if it uncovers a production defect, it reports it with a stable failure signature and routes it back to implementation instead.

## Output format

Exact commands, exit status, counts, coverage delta, failures/signatures, justified non-applicable checks, and `unit-test` plus `integration-test` evidence summaries. Never deletes, skips, relaxes, over-mocks, or lowers thresholds to pass.

## Typical workflow

`implementer` completes a change → `test-engineer` maps acceptance criteria to tests, adds them, and runs the full relevant suite → `verification-engineer` verifies runtime behavior separately.

## Related skills

[`/asterweave:test`](/commands/test)
