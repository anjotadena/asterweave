---
sidebar_position: 14
title: verification-engineer
description: Independently verifies acceptance criteria against the running application.
---

# `asterweave:verification-engineer`

## Role

Independently verifies acceptance criteria against the built and running application, API, CLI, mobile, desktop, database, or integration environment and returns reproducible evidence.

## Purpose

Acts independently from the implementer, verifying observable behavior against approved acceptance criteria rather than implementation intent. Builds and runs through repository-native commands and the real boundary appropriate to the product. A passing unit test is supporting context, not runtime proof.

## When invoked

By default, at the `verify` graph node (or when `/asterweave:verify` is run standalone), unless routed to a project-specific agent.

## Inputs

The approved acceptance criteria and the implemented, tested change.

## Context received

A bounded verification assignment: the acceptance criteria and enough context to build/run the application.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, ToolSearch`. Explicitly disallowed: `Write, Edit`.

## Writes allowed?

No, except approved ephemeral test setup/data. Never modifies code, configuration, or fixtures outside that, and never uses production credentials or environments.

## Output format

An acceptance matrix with `PASS`, `FAIL`, or `BLOCKED` per criterion, evidence per criterion (commands, inputs, outputs/status, artifact or screenshot paths, environment, limitations), stable failure signatures, and one concise `acceptance` evidence summary.

## Typical workflow

`test-engineer` completes automated tests → `verification-engineer` independently exercises the real running system against acceptance criteria → `staff-reviewer`/`security-reviewer` review next.

## Related skills

[`/asterweave:verify`](/commands/verify)
