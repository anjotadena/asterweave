---
name: analyze
description: Analyze a task and repository without changing files, producing stack, architecture, dependency, blast-radius, baseline, and risk evidence for Asterweave.
argument-hint: "<goal|issue>"
model: sonnet
effort: high
---

# Analyze before changing

Analyze `$ARGUMENTS` read-only.

1. Read repository instructions, [stack discovery](../../references/stack-discovery.md), [repository adapter](../../references/repository-adapter.md), and, if a `specs/` directory exists, [project specifications](../../references/specs.md).
2. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/scaffold-repo.mjs" route analyze --root .`. Invoke configured project skills and delegate to the configured project agent; when no route exists, delegate to `asterweave:repo-analyzer`.
3. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/detect-stack.mjs" .` and verify its signals against manifests, CI, documentation, and code.
4. Trace the task from entry points through business logic, data boundaries, external contracts, callers, and tests.
5. Find analogous implementations and record conventions that should be reused.
6. Inspect Git status and report user changes without modifying them.
7. Identify affected components, data/API/config/deployment impacts, security boundaries, and likely regressions.
8. Discover repository-native build/test commands. Run only safe, read-only or baseline checks already supported by the repository, including configured required quality gates when applicable.
9. Validate the delegated result against raw repository evidence and return: facts with file references, assumptions, unknowns, blast radius, baseline evidence, risks, and recommended next graph node.
10. When running inside an active `deliver` workflow, write the [context manifest](../../references/graph-contract.md#context-manifest) to `.claude/asterweave/context-manifest.json` and record its path on the `repository` evidence entry, so `challenge`/`plan`/`implement`/`test`/`verify`/`review` can reuse this bounded context instead of re-scanning the repository.

Do not propose implementation details unsupported by repository evidence.
