---
sidebar_position: 4
title: implementer
description: Implements a bounded, approved assignment using repository-native patterns.
---

# `asterweave:implementer`

## Role

Implements a bounded, approved assignment using repository-native patterns and stack rules, including focused tests and self-review, while preserving unrelated work.

## Purpose

Implements only the delegated, approved assignment. Before editing, reads applicable instructions, relevant complete files, analogous implementations, and tests. Keeps changes cohesive and minimal, preserving boundaries, public contracts, validation, authorization, error behavior, data integrity, concurrency, observability, accessibility, and backward compatibility.

## When invoked

By default, at the `implement` graph node (or when `/asterweave:implement` is run standalone), unless routed to a project-specific agent.

## Inputs

The approved plan/scope, repository facts, the context manifest, and the detected stack rule pack.

## Context received

A self-contained, bounded assignment — goal, approved scope, constraints, and required output — not the full conversation.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell, Edit, Write, Skill`.

## Writes allowed?

Yes, within the approved scope only. Does not add dependencies, migrations, public API breaks, infrastructure changes, bulk rewrites, secrets, or unrelated refactors without explicit approval, and never stashes, resets, cleans, bulk-restores, force-pushes, or merges.

## Output format

Changed files, behavior, tests, commands/results, decisions, risks, and a reproducible `change` evidence summary. If repository evidence invalidates the plan, stops with `FAIL_REPLAN` instead of improvising.

## Typical workflow

Plan approved → `implementer` makes the smallest cohesive change and adds focused tests → self-reviews the complete touched files and diff → hands off to `test-engineer` and `verification-engineer`.

## Related skills

[`/asterweave:implement`](/commands/implement)
