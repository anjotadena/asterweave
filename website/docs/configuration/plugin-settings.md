---
sidebar_position: 2
title: Plugin settings
description: The user configuration Claude Code prompts for when enabling Asterweave.
---

# Plugin settings

These are configured once, at the Claude Code level, when you enable the plugin — not per-repository. They are declared in the plugin manifest (`plugin.json`) and stored as sensitive plugin configuration.

| Setting | Type | Required | Sensitive | Description |
| --- | --- | :---: | :---: | --- |
| `github_token` | string | ✅ | ✅ | Fine-grained GitHub token with access only to the repositories and operations you want Asterweave to use. |
| `ado_organization` | string | — | — | Azure DevOps organization name. Only needed when a repository sets `provider.workItems: azure-devops` in its `.claude/asterweave.json`. |
| `ado_pat_base64` | string | — | ✅ | Base64 of `<email>:<personal-access-token>` for Azure DevOps, as required by the official Azure DevOps MCP server. Leave unset unless you use Azure DevOps. |

The plugin ships **disabled by default** — enabling it activates its hooks and prompts for `github_token` immediately. See [GitHub token posture](/repositories/repository-integration#github-token-posture) for the recommended token scope.

## Related

[`asterweave.json` reference](/configuration/asterweave-json) for per-repository configuration; [Installation](/getting-started/installation).
