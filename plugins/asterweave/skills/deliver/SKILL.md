---
name: deliver
description: Execute an enterprise issue-to-PR delivery workflow through intake, analysis, challenge, plan approval, implementation, tests, runtime verification, independent reviews, bounded repair loops, and PR submission.
argument-hint: "<goal|owner/repo#issue> [--auto-pr]"
disable-model-invocation: true
model: opus
effort: high
---

# Deliver through the Asterweave graph

Work on `$ARGUMENTS`. Read these contracts before acting:

- [graph contract](../../references/graph-contract.md)
- [evidence contract](../../references/evidence-contract.md)
- [Git and destructive-operation safety](../../references/git-safety.md)
- [security policy](../../references/security.md)

## Initialize or resume

1. Inspect repository instructions, status, architecture, and existing patterns before editing.
2. If an unfinished `.claude/asterweave/state.json` exists, summarize it and resume only when it matches this goal. Otherwise initialize:

   `node "${CLAUDE_SKILL_DIR}/../../scripts/graph-state.mjs" init --goal "$ARGUMENTS" --source "$ARGUMENTS"`

3. Use the state script for every node entry, evidence record, and outcome. Never edit state or the append-only event ledger manually.

## Execute the graph

For each node, run `enter <node>`, complete its contract, record evidence, then run `complete <node> pass`. Use specialist agents for bounded, self-contained work:

1. `intake`: retrieve the issue/task and comments if supplied; normalize scope, acceptance criteria, constraints, dependencies, and non-goals. Record `task` evidence.
2. `analyze`: delegate repository discovery to `asterweave:repo-analyzer`; detect the stack; run safe baseline checks that the repository already defines. Record `repository` and `baseline` evidence.
3. `challenge`: delegate to `asterweave:requirements-challenger`. Resolve contradictions and missing acceptance criteria. If material questions remain, complete with `needs-human` and ask the user.
4. `plan`: delegate to `asterweave:architect`. Produce a change DAG, exact boundaries, test plan, risks, migrations, observability, and rollback. Record `plan` evidence.
5. `approve`: show the plan and obtain explicit human approval before code edits, dependency changes, or migrations. Record it only with `approve --by ... --summary ...`.
6. `implement`: load only the detected stack rules. For small sequential changes, implement in the main context. For an isolated assignment, use `asterweave:implementer` and integrate its worktree only after reviewing its diff. Record `change` evidence with the diff/commit reference.
7. `test`: delegate to `asterweave:test-engineer`. Run changed-area unit tests, required integration/contract tests, build, lint/static analysis, and broader regression tests proportional to risk. Record `unit-test` and `integration-test` evidence; use explicit `skipped` evidence only when a test category is genuinely not applicable and explain why.
8. `verify`: delegate to `asterweave:verification-engineer` with the approved criteria. Verify runtime behavior in the appropriate application, device, browser, API, CLI, or desktop environment. Record `acceptance` evidence.
9. `review`: run `asterweave:staff-reviewer` and `asterweave:security-reviewer` independently, in parallel only when safe. Record `code-review` and `security-review` evidence.
10. If test, verification, or review fails, record a stable failure signature and follow the graph back to implementation. Never repeat the same unsuccessful action twice without a new hypothesis or state change.
11. `submit-pr`: re-run final diff and Git safety checks. Unless `$ARGUMENTS` contains `--auto-pr`, obtain confirmation before commit/push/PR creation. Use `asterweave:pr-engineer` and the GitHub MCP. Record `pull-request` evidence.

## Termination

Finish only when all nodes pass, every acceptance criterion maps to evidence, required tests pass, no unresolved Critical/High finding remains, and the PR reference exists. If budgets are exhausted, pause with a concise blocker and a recommended human decision. Never weaken a gate to claim completion.
