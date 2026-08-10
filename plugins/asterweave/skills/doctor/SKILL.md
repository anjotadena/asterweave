---
name: doctor
description: Diagnose Asterweave installation, Node runtime, plugin manifests, hooks, GitHub MCP connectivity, repository trust, stack detection, and graph-state health without changing source code or remote systems.
argument-hint: "[--verbose]"
disable-model-invocation: true
model: haiku
effort: medium
---

# Diagnose Asterweave

Remain read-only except for temporary files outside the repository.

1. Report `claude --version`, `node --version`, repository trust status when visible, and Git status.
2. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/validate-plugin.mjs" "${CLAUDE_SKILL_DIR}/../.."`.
3. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/detect-stack.mjs" .` and verify detected commands against repository files.
4. If state exists, run graph status and validation; distinguish a valid blocked workflow from corrupted state.
5. Inspect `/mcp` or equivalent server status. Confirm the plugin-scoped GitHub server is connected without displaying tokens, headers, or sensitive configuration.
6. Confirm hook scripts exist and Node 18+ is available. Do not trigger destructive commands to test the guard.
7. Return a check table with `PASS`, `WARN`, or `FAIL`, exact remediation, and whether `/reload-plugins` is required.

Never print secrets or recommend disabling security controls as a fix.
