---
name: analyze
description: Analyze a task and repository without changing files, producing stack, architecture, dependency, blast-radius, baseline, and risk evidence for Asterweave.
argument-hint: "<goal|issue>"
context: fork
agent: asterweave:repo-analyzer
background: false
model: sonnet
effort: high
---

# Analyze before changing

Analyze `$ARGUMENTS` read-only.

1. Read repository instructions and [stack discovery](../../references/stack-discovery.md).
2. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/detect-stack.mjs" .` and verify its signals against manifests, CI, documentation, and code.
3. Trace the task from entry points through business logic, data boundaries, external contracts, callers, and tests.
4. Find analogous implementations and record conventions that should be reused.
5. Inspect Git status and report user changes without modifying them.
6. Identify affected components, data/API/config/deployment impacts, security boundaries, and likely regressions.
7. Discover repository-native build/test commands. Run only safe, read-only or baseline checks already supported by the repository.
8. Return: facts with file references, assumptions, unknowns, blast radius, baseline evidence, risks, and recommended next graph node.

Do not propose implementation details unsupported by repository evidence.
