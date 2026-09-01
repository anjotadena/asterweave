---
sidebar_position: 1
title: Prerequisites
description: What you need before installing Asterweave.
---

# Prerequisites

| Requirement | Why |
| --- | --- |
| Claude Code 2.1.218+ | Plugin, skill, and hook APIs Asterweave uses |
| Node.js 18+ | Deterministic hooks and state scripts run as plain Node.js |
| Git | Issue-to-PR delivery |
| A fine-grained GitHub token | Scoped to the repositories and operations you allow Asterweave to use |
| Node.js 20+ (only if using Azure DevOps) | Required by the official Azure DevOps MCP server |
| Azure DevOps org + PAT (optional) | Only needed when `provider.workItems: azure-devops` |

:::note Disabled by default
The plugin ships **disabled by default**, because enabling it activates hooks and requests sensitive GitHub configuration. You explicitly enable it after installing.
:::

:::warning Token handling
Claude Code stores your GitHub token as sensitive plugin configuration. Never place it in `.mcp.json`, `.env` files, source control, prompts, or issue comments. See [GitHub token posture](/repositories/repository-integration#github-token-posture) for the recommended scope.
:::

## Next

Continue to [Installation](/getting-started/installation).
