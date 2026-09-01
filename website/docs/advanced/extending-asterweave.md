---
sidebar_position: 1
title: Extending Asterweave safely
description: How to add repository-specific rules, agents, and quality gates without weakening Asterweave's guarantees.
---

# Extending Asterweave safely

Every extension point in Asterweave is designed so a repository can **specialize or tighten** the graph, never weaken it. This page collects the actual extension points; see [Asterweave vs. the repository](/concepts/plugin-vs-repository) for the underlying reasoning.

## What you can extend

| Extension point | Mechanism | Guardrail |
| --- | --- | --- |
| Project conventions | `.claude/rules/*.md` | Path-scoped, evidence-backed, generated/refreshed by `/asterweave:scaffold` |
| Domain-specific review/implementation expertise | `.claude/agents/*.md` + [routing](/architecture/agent-routing) | Only justified for bounded expertise a generic agent cannot provide |
| Reusable project workflows | `.claude/skills/*/SKILL.md` | Unscoped names, doubling as the repository's own slash commands |
| Required quality gates | `.claude/asterweave.json`'s `qualityGates.required` | Adds commands; cannot remove Asterweave's own gates |
| Stage delegation | `.claude/asterweave.json`'s `routing` | Adds/narrows; cannot skip approval, evidence, testing, verification, review, security, or Git safety |
| Work-item provider | `.claude/asterweave.json`'s `provider.workItems` | Selects GitHub, Azure DevOps, or none — doesn't change gates |

## What you cannot extend from a repository

- You cannot disable the `PreToolUse` destructive-command guard or the `Stop` evidence gate from a repository. `ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD=1` exists for the plugin's own test suite, not for repository use.
- You cannot make a routed agent skip a node's required evidence category, human approval, or the independent security-review pass.
- You cannot widen a delegated subagent's tool permissions beyond what the corresponding plugin agent allows — a child agent can only narrow, never widen, its parent's authority.

## Adding a repository-specific agent

1. Confirm the need is genuine: bounded, recurring domain expertise a generic Asterweave agent cannot reasonably provide (see the [decision tree](/concepts/plugin-vs-repository#a-decision-tree-for-new-project-knowledge)).
2. Let `/asterweave:scaffold` propose it from real evidence, or write `.claude/agents/<name>.md` with a narrow description, an explicit tool allowlist (least privilege — read-only unless it must write), and a scoped system prompt.
3. Add a `routing.<stage>.agent` entry in `.claude/asterweave.json` pointing at it by name.
4. Run `/asterweave:scaffold --check` (or let the next `deliver` validate the adapter) to confirm it resolves correctly.

## Adding a required quality gate

Add an entry to `qualityGates.required` in `.claude/asterweave.json` with a real, repository-native command and its source (for example the CI workflow file that already runs it) — see the [reference](/configuration/asterweave-json#full-example). Asterweave refuses invented or unverifiable commands during scaffolding audit.

## What extension is not for

Extension points are not a way to reimplement Asterweave's own workflows inside a repository. See [Do not duplicate Asterweave](/repositories/scaffolding#worked-example) and the [anti-patterns](/usage/overview#anti-patterns) list — a repository `deliver` command, a generic reviewer agent, or a hook re-blocking what the plugin already blocks are all signs the extension point is being used for the wrong thing.

## Contributing to the plugin itself

If what you need is genuinely reusable across repositories — not specific to one codebase — it likely belongs in the Asterweave plugin itself, not a repository extension. See [Contributing](/contributing/development).

## Related

[Repository scaffolding](/repositories/scaffolding), [Agent routing](/architecture/agent-routing), [`asterweave.json` reference](/configuration/asterweave-json).
