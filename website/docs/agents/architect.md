---
sidebar_position: 2
title: architect
description: Produces repository-grounded implementation DAGs and architecture decisions.
---

# `asterweave:architect`

## Role

Produces repository-grounded implementation DAGs and architecture decisions after analysis and requirements challenge, without editing code or changing dependencies.

## Purpose

Designs the smallest production-ready change that satisfies approved acceptance criteria and preserves repository architecture. Grounds every proposed file/module/interface in repository evidence, identifies change dependencies, and marks parallel-safe nodes only when they share no files, schemas, contracts, or ordering constraints.

## When invoked

By default, at the `plan` graph node (or when `/asterweave:plan` is run standalone), unless `.claude/asterweave.json` routes `plan` to a project-specific agent.

## Inputs

The approved requirements/acceptance criteria from `challenge`, repository facts from `analyze`, the context manifest, and the detected stack rule pack.

## Context received

A self-contained delegation: the goal, approved criteria, repository facts, exact scope, constraints, and the required output schema — never the surrounding conversation.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit`.

## Writes allowed?

No. Read-only; it designs, it does not implement.

## Output format

An ordered DAG, file/boundary changes, a test matrix (unit, integration/contract, E2E/runtime, negative, regression, migration, rollback), risks/decisions, rollout/rollback plan, quality commands discovered from the repository, and an approval summary. Explicitly calls out any dependency, schema, public API, infrastructure, or generated-code change for approval.

## Typical workflow

`analyze` and `challenge` complete → `architect` proposes the DAG → a human approves it → `implementer` executes it.

## Related skills

[`/asterweave:plan`](/commands/plan)
