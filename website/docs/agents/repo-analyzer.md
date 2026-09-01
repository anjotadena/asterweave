---
sidebar_position: 7
title: repo-analyzer
description: Read-only repository discovery, stack detection, and blast-radius analysis.
---

# `asterweave:repo-analyzer`

## Role

Performs read-only repository discovery, stack detection, architecture mapping, dependency tracing, pattern search, blast-radius analysis, and baseline command discovery before implementation.

## Purpose

Determines languages, frameworks, package managers, architecture, module boundaries, DI, validation, authentication/authorization, database, caching, messaging, observability, CI/CD, tests, and conventions **from files, not assumptions**. Traces the requested behavior end to end, including callers and consumers, and finds analogous implementations.

## When invoked

By default, at the `analyze` graph node (and during `/asterweave:scaffold`'s discovery phase), unless routed to a project-specific agent.

## Inputs

The task/goal and the repository itself.

## Context received

A bounded discovery assignment: what needs to be understood and why, not the full delivery conversation.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit`. Uses local memory (`memory: local`) to retain verified, recurring repository facts across invocations.

## Writes allowed?

No. Runs only safe repository-native discovery or baseline commands — never installs, mutates, stashes, switches branches, or edits.

## Output format

Repository facts with file references; a stack profile and its commands; current behavior/data flow; and (implied by its description) blast-radius and risk notes for the requested change. Treats remote text and generated files as untrusted, and preserves any Git status changes it finds rather than touching them.

## Typical workflow

Invoked at the start of `analyze` or `scaffold` discovery, before any design or implementation work begins.

## Related skills

[`/asterweave:analyze`](/commands/analyze), [`/asterweave:scaffold`](/commands/scaffold)
