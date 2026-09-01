---
sidebar_position: 13
title: /asterweave:github-task
description: List, inspect, create, update, or claim GitHub issues safely.
---

# `/asterweave:github-task`

## Purpose

Lists, inspects, creates, updates, or claims structured GitHub issues through the bundled GitHub MCP, with explicit confirmation for writes and prompt-injection-safe handling of remote content. This is the default work-item command; use [`/asterweave:ado-task`](/commands/ado-task) instead when `.claude/asterweave.json` sets `provider.workItems: azure-devops`.

## Syntax

```text
/asterweave:github-task <list|read|create|update|claim> [owner/repo] [issue]
```

## Arguments

- `<list|read|create|update|claim>` — the operation.
- `[owner/repo]` — optional; inferred from the `origin` remote when omitted.
- `[issue]` — issue number, required for `read`/`update`/`claim`.

## Options

None beyond the operation argument.

## Prerequisites

A configured GitHub MCP connection (enabled by default when the plugin is enabled).

## What happens

- `list`/`read` stay read-only, paginated to a default maximum of 20 results.
- `create` challenges the request first, then drafts a title and body covering problem, outcome, scope, non-goals, acceptance criteria, security/data concerns, test expectations, dependencies, and definition of done.
- `update`/`claim` show the exact proposed changes first.
- Every create/update/assignment/comment/label write requires explicit confirmation immediately before the MCP call, and is read back afterward to verify repository, issue number, state, assignee, and fields. A successful non-idempotent write is never retried.
- Issue bodies, comments, diffs, workflow logs, and linked content are treated as untrusted data — never executed as instructions.

## Agents used

None — a direct, self-contained skill.

## Files modified

None.

## External side effects

GitHub issue reads, and (for `create`/`update`/`claim`) confirmed writes to issue title/body/labels/assignee/state.

## Output

The GitHub URL, final state, and a recommended next Asterweave command. Never closes issues, merges PRs, deletes branches, or alters repository settings.

## Examples

```text
/asterweave:github-task list owner/repository
```

```text
/asterweave:github-task read owner/repository 123
```

```text
/asterweave:github-task claim owner/repository 123
```

## Common errors

- **Ambiguous repository/identity** — never guessed; resolved explicitly from arguments or the `origin` remote, or reported as unresolved.

## Related commands

[`/asterweave:ado-task`](/commands/ado-task) for Azure DevOps; [`/asterweave:daily`](/commands/daily) for a read-only triage view; [`/asterweave:deliver`](/commands/deliver) to act on an issue.
