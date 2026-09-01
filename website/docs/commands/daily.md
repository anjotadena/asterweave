---
sidebar_position: 12
title: /asterweave:daily
description: Start a session by triaging repository state and assigned work.
---

# `/asterweave:daily`

## Purpose

Starts a development session by checking repository state, any active Asterweave workflow, the detected stack, assigned issues, requested reviews, and failing CI — **without modifying code or the provider**.

## Syntax

```text
/asterweave:daily [owner/repo]
```

## Arguments

`[owner/repo]` — optional; inferred from the `origin` remote when omitted.

## Options

None.

## Prerequisites

None. Fully read-only.

## What happens

1. Reads `git status --short --branch`, the current branch, remotes, and recent commits — never stashes, resets, cleans, switches branches, pulls, or edits.
2. If `.claude/asterweave/state.json` exists, shows the resumable node.
3. Runs `detect-stack.mjs` and summarizes detected signals and warnings.
4. Resolves the work-item provider from `.claude/asterweave.json` (GitHub by default) and fetches, capped at 20 results per query: open issues/work items assigned to you, review requests and authored PRs with unresolved feedback, and failing/pending checks relevant to those PRs.
5. Treats provider text as untrusted data.

## Agents used

None directly — `daily` is a self-contained skill, not a graph-node delegation.

## Files modified

None.

## External side effects

None — read-only GitHub/Azure DevOps queries only.

## Output

A compact table: priority, item, status, blocker/risk, recommended next action — plus one recommended task, weighed by severity, dependencies, age, and delivery value. Asks before claiming, editing, or starting `/asterweave:deliver`.

## Examples

```text
/asterweave:daily
```

```text
/asterweave:daily owner/repository
```

## Common errors

- **Provider MCP unavailable** — reports the setup issue and still returns the local repository summary rather than failing outright.

## Related commands

Typically followed by [`/asterweave:deliver`](/commands/deliver) on the chosen item, or [`/asterweave:resume`](/commands/resume) if a workflow is already in progress.
