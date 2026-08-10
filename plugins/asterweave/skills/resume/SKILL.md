---
name: resume
description: Resume or inspect a paused Asterweave workflow from durable graph state and event history without repeating completed nodes or discarding user changes.
argument-hint: "[--inspect-only]"
disable-model-invocation: true
model: sonnet
effort: medium
---

# Resume durable workflow state

1. Read `.claude/asterweave/state.json` and the relevant tail of `.claude/asterweave/events.jsonl`; never edit either manually.
2. Inspect current Git status, branch, diff, and whether recorded artifact/commit paths still exist.
3. Summarize the goal, current node, completed evidence, attempts/budgets, blocker, and repository divergence since the last event.
4. If `$ARGUMENTS` contains `--inspect-only`, stop after the summary.
5. If state is blocked and the blocker is resolved, run `node "${CLAUDE_SKILL_DIR}/../../scripts/graph-state.mjs" resume`.
6. Revalidate stale evidence when code, dependencies, configuration, environment, or base branch changed. Do not blindly reuse prior pass claims.
7. Continue from the current node under [graph contract](../../references/graph-contract.md). Do not repeat passed nodes unless their evidence became stale.

If state and repository conflict materially, route to re-analysis or replan rather than guessing.
