---
sidebar_position: 1
title: Command overview
description: "All sixteen /asterweave: commands, what they do, and when to use each."
---

# Command overview

Every Asterweave command is a Claude Code skill under the `/asterweave:` namespace. Most are also invoked automatically by `/asterweave:deliver`'s graph nodes — you can run them individually when you want a single stage without the full pipeline.

| Command | Purpose | Model / effort |
| --- | --- | --- |
| [`/asterweave:scaffold`](/commands/scaffold) | Analyze and generate/refresh repository-specific Claude Code context | opus / high |
| [`/asterweave:analyze`](/commands/analyze) | Read-only repository and impact analysis | sonnet / high |
| [`/asterweave:challenge`](/commands/challenge) | Requirements/design challenge (the "grill" phase) | opus / high |
| [`/asterweave:plan`](/commands/plan) | Approval-ready implementation DAG | opus / high |
| [`/asterweave:implement`](/commands/implement) | Execute an approved plan | sonnet / high |
| [`/asterweave:test`](/commands/test) | Add and run unit and integration/contract tests | sonnet / high |
| [`/asterweave:verify`](/commands/verify) | Verify real observable behavior | sonnet / high |
| [`/asterweave:review`](/commands/review) | Independent staff and security review | opus / high |
| [`/asterweave:submit-pr`](/commands/submit-pr) | Commit, push, and create/update a PR after gates pass | sonnet / high |
| [`/asterweave:deliver`](/commands/deliver) | Run the full intake → PR graph | opus / high |
| [`/asterweave:daily`](/commands/daily) | Triage and pick up assigned work | sonnet / medium |
| [`/asterweave:github-task`](/commands/github-task) | `list`, `read`, `create`, `update`, `claim` on GitHub issues | sonnet / medium |
| [`/asterweave:ado-task`](/commands/ado-task) | `list`, `read`, `create`, `update`, `claim` on Azure DevOps work items | sonnet / medium |
| [`/asterweave:resume`](/commands/resume) | Resume durable local graph state | sonnet / medium |
| [`/asterweave:retro`](/commands/retro) | Improve the workflow from its event ledger | sonnet / high |
| [`/asterweave:doctor`](/commands/doctor) | Diagnose plugin, state, hooks, stack, and MCP | haiku / medium |

Use the individual stages when you don't want the complete workflow — see [When to use each command](/usage/overview#when-to-use-each-command) for a task-oriented version of this table.

:::note No standalone "bootstrap", "security-review", or "resolve-pr-comments" commands
Some names circulating informally don't match the plugin's actual command set. Repository setup is `/asterweave:scaffold`, not `bootstrap`. Security review runs automatically as a second, independent pass inside `/asterweave:review` — there is no separate `security-review` command. PR comment triage is the `resolve-review-comments` **graph node**, run automatically inside `/asterweave:deliver` (and resumable with `/asterweave:resume`); there is no standalone `resolve-pr-comments` command. This page and the rest of the docs use only commands that exist.
:::

## Related

[Skill vs. agent](/concepts/core-concepts#command-skill) explains how a command relates to the specialist agents it delegates to.
