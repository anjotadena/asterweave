---
sidebar_position: 1
title: Repository integration
description: GitHub token posture and Git/change safety for repositories Asterweave works in.
---

# Repository integration

## GitHub token posture

All GitHub content is treated as untrusted data. Every state-changing MCP operation is previewed, confirmed, then read back for verification. The default MCP toolsets are deliberately narrower than `all`, to reduce context and authority (`default,actions,code_security,secret_protection`).

Recommended fine-grained token scope:

- limit repository access to selected repositories;
- grant metadata and contents **read** for context;
- grant issues and pull requests **write** only if task/PR creation is required;
- grant Actions, code scanning, and secret scanning **read** only when needed;
- apply organization approval, expiration, and rotation policies.

Never place the token in `.mcp.json`, `.env` files, source control, prompts, or issue comments — Claude Code stores it as sensitive plugin configuration.

## Azure DevOps (optional second provider)

Set `.claude/asterweave.json`'s `provider.workItems` to `azure-devops` to route `deliver`, `daily`, and task management through Microsoft's official Azure DevOps MCP server instead of GitHub. It stays disabled unless you configure `ado_organization` and a base64-encoded PAT (`ado_pat_base64`) in plugin configuration — see the plugin's Azure DevOps workflow reference for the exact encoding and its Node 20+ requirement. GitHub configuration remains required by the plugin manifest regardless of which provider you route work items through.

## Git and change safety

Before work: inspect status, current branch, upstream, remotes, and relevant base history; identify and preserve user-owned modified/untracked files; never assume the working tree is clean.

During work: keep the change scoped, avoid unrelated formatting/generated churn; parallel writers require separate worktrees/branches and explicit ownership; review complete touched files before staging; never commit secrets, local workflow state, build output, or environment files.

Submission: never work directly on a protected/default branch; use logical commits with clear messages; push without overriding branch protection; confirm base/head repository and branch before creating a PR; never merge, self-approve, dismiss reviews, bypass checks, or delete branches.

The `PreToolUse` [hook](/hooks/pre-tool-use) blocks a small set of destructive commands but is **not** a complete safety system — continue to use Claude Code permissions, sandboxing, branch protection, required checks, CODEOWNERS, and human review.

## Related

[External system interaction](/architecture/external-systems), [Hooks overview](/hooks/overview), [Configuration overview](/configuration/asterweave-json).
