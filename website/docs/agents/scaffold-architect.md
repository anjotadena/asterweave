---
sidebar_position: 9
title: scaffold-architect
description: Designs the minimum repository-specific Claude Code scaffold.
---

# `asterweave:scaffold-architect`

## Role

Designs the minimum repository-specific Claude Code scaffold from verified code, configuration, CI, tests, and existing instructions, without editing files or inventing conventions.

## Purpose

Separates stable universal facts, path-specific conventions, reusable workflows, detailed reference knowledge, isolated specialist roles, and deterministic quality gates — using `CLAUDE.md`, rules, skills, references, and agents only for the category each serves. Minimizes always-loaded context and duplication; creates an agent only when repeated specialist work genuinely benefits from a separate context or narrower tools.

## When invoked

During `/asterweave:scaffold`'s "design the minimum scaffold" phase, delegated the raw inventory rather than a predetermined file list.

## Inputs

The repository inventory and evidence gathered by `asterweave:repo-analyzer`, including existing `.claude/agents/*.md` classifications.

## Context received

The full scaffold-design assignment: repository evidence, existing instructions, and the blueprint schema to write against.

## Tools / permissions

`Read, Grep, Glob, Bash, PowerShell`. Explicitly disallowed: `Write, Edit, Agent`.

## Writes allowed?

No direct file writes — it produces the transient `.claude/asterweave/scaffold-proposal.json` proposal object, which `scaffold-repo.mjs apply` later writes only after human approval.

## Output format

A scaffold proposal against `scaffold-blueprint.schema.json`: proposed `CLAUDE.md`/rules/skills/agents/references/adapter content, each grounded in cited evidence, with `KEEP`/`MERGE`/`REMOVE` classification for every existing `.claude/agents/*.md`.

## Typical workflow

`repo-analyzer` gathers evidence → `scaffold-architect` proposes the minimum scaffold → `scaffold-auditor` independently reviews it → a human approves the digest → `scaffold-repo.mjs apply` writes it.

## Related skills

[`/asterweave:scaffold`](/commands/scaffold)
