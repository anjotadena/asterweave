---
sidebar_position: 1
title: Hooks overview
description: Prompts guide. Hooks enforce. Asterweave's two deterministic hooks.
---

# Hooks

Prompts guide; hooks **enforce**. A hook is a plain Node.js script wired to a Claude Code lifecycle event through `plugins/asterweave/hooks/hooks.json`. Asterweave ships exactly two.

```json title="hooks/hooks.json"
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell",
        "hooks": [{"type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook-guard.mjs\"", "timeout": 10}]
      }
    ],
    "Stop": [
      {
        "hooks": [{"type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/hook-stop-gate.mjs\"", "timeout": 10}]
      }
    ]
  }
}
```

:::note Only two hooks exist
Asterweave does not ship a `PostToolUse` or `SessionStart` hook. If a repository needs enforcement at those events, that would be a repository-level addition — see [Repository scaffolding](/repositories/scaffolding#existing-agent-classification) for why Asterweave's scaffolder deliberately avoids proposing hooks by default.
:::

## The two hooks

| Hook | Event | Purpose |
| --- | --- | --- |
| [Destructive-command guard](/hooks/pre-tool-use) | `PreToolUse`, matching `Bash`/`PowerShell` | Blocks a fixed list of known high-impact shell commands before they run. |
| [Evidence stop gate](/hooks/stop) | `Stop` | Keeps an active Asterweave workflow moving instead of letting the turn end mid-flight. |

## Defense in depth, not a complete safety system

The destructive-command hook is not a complete shell parser or a substitute for Claude Code permissions and sandboxing. It blocks a known, fixed set of high-impact operations, and is not meant to be disabled to work around an implementation problem. Continue to use Claude Code permissions, sandboxing, branch protection, required checks, CODEOWNERS, and human review alongside it.

## Related

[Repository scaffolding](/repositories/scaffolding) explains why Asterweave's own scaffolder avoids proposing a second, competing hook for enforcement it already provides.
