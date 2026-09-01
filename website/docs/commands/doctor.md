---
sidebar_position: 17
title: /asterweave:doctor
description: Diagnose plugin, state, hooks, stack, and MCP health.
---

# `/asterweave:doctor`

## Purpose

Diagnoses the Asterweave installation, Node.js runtime, plugin manifests, hooks, GitHub MCP connectivity, repository trust, stack detection, and graph-state health — **without changing source code or remote systems**.

## Syntax

```text
/asterweave:doctor [--verbose]
```

## Arguments

None.

## Options

| Flag | Effect |
| --- | --- |
| `--verbose` | Report more detail per check. |

## Prerequisites

None. This is the right first command to run after installing or when something seems wrong.

## What happens

1. Reports `claude --version`, `node --version`, repository trust status when visible, and Git status.
2. Runs `validate-plugin.mjs` against the plugin itself.
3. Runs `detect-stack.mjs` and verifies detected commands against repository files.
4. Runs `scaffold-repo.mjs verify` and reports managed drift, stale artifacts, invalid adapter routes, or missing project skills/agents.
5. If workflow state exists, runs graph status/validation and distinguishes a valid blocked workflow from corrupted state.
6. Inspects MCP server status, confirming the plugin-scoped GitHub server (and Azure DevOps, if configured) is connected — without displaying tokens, headers, or sensitive configuration.
7. Confirms hook and scaffold scripts exist and Node 18+ is available, without triggering destructive commands to test the guard.

## Agents used

None — a direct, self-contained diagnostic skill.

## Files modified

None (only temporary files outside the repository, if any).

## External side effects

None — status checks only, no writes.

## Output

A check table with `PASS`, `WARN`, or `FAIL` per item, exact remediation, and whether `/reload-plugins` is required. Never prints secrets or recommends disabling security controls as a fix.

## Examples

```text
/asterweave:doctor
```

```text
/asterweave:doctor --verbose
```

## Common errors

See [Troubleshooting](/troubleshooting/common-issues) for how to act on specific `FAIL`/`WARN` results.

## Related commands

Run this first after [installation](/getting-started/installation), and any time behavior seems off.
