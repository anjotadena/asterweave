---
sidebar_position: 14
title: /asterweave:ado-task
description: List, inspect, create, update, or claim Azure DevOps work items safely.
---

# `/asterweave:ado-task`

## Purpose

Lists, inspects, creates, updates, or claims Azure DevOps work items through the bundled Azure DevOps MCP, with explicit confirmation for writes and prompt-injection-safe handling of remote content. Use this when `.claude/asterweave.json` sets `provider.workItems: azure-devops`; otherwise use [`/asterweave:github-task`](/commands/github-task).

## Syntax

```text
/asterweave:ado-task <list|read|create|update|claim> [organization/project] [work-item-id]
```

## Arguments

- `<list|read|create|update|claim>` — the operation.
- `[organization/project]` — optional; resolved from `.claude/asterweave.json` when omitted.
- `[work-item-id]` — required for `read`/`update`/`claim`.

## Options

None beyond the operation argument.

## Prerequisites

Requires `ado_organization` and a base64-encoded PAT (`ado_pat_base64`) configured in plugin settings, and Node.js 20+ for the Azure DevOps MCP server. See [External system interaction](/architecture/external-systems#providers).

## What happens

Behaves identically to [`/asterweave:github-task`](/commands/github-task), against Azure Boards instead of GitHub Issues: `list`/`read` are read-only and paginated (max 20); `create` challenges the request and drafts a full work item; `update`/`claim` show proposed changes first; every write requires explicit confirmation and a post-write read-back verifying project, work item ID, state, assignee, and fields.

## Agents used

None — a direct, self-contained skill.

## Files modified

None.

## External side effects

Azure DevOps work-item reads, and (for `create`/`update`/`claim`) confirmed writes.

## Output

The Azure DevOps URL, final state, and a recommended next Asterweave command. Never resolves/closes work items, completes PRs, deletes branches, or alters project settings.

## Examples

```text
/asterweave:ado-task list myorg/myproject
```

```text
/asterweave:ado-task read myorg/myproject 4821
```

## Common errors

- **Azure DevOps MCP unavailable** — if `ado_organization`/PAT aren't configured, reports the setup issue rather than guessing at work-item state.

## Related commands

[`/asterweave:github-task`](/commands/github-task) for the default GitHub provider; [`/asterweave:deliver`](/commands/deliver), which uses whichever provider `provider.workItems` selects.
