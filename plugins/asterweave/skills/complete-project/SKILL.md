---
name: complete-project
description: Audit an existing, partially implemented repository end to end, discover its real product/domain modules, plan dependency-ordered execution waves, and drive the remaining work to completion with isolated parallel workers, ownership enforcement, and full integration verification.
argument-hint: "[--max-workers <n>] [--dry-run] [--resume]"
disable-model-invocation: true
model: opus
effort: high
---

# Complete an existing project through dependency-aware parallel workstreams

Work on `$ARGUMENTS`. Read these contracts before acting:

- [project-completion contract](../../references/project-completion.md) — the authoritative phase model, run-state layout, ownership, shared-code, concurrency, and failure contracts for this skill
- [graph contract](../../references/graph-contract.md), especially "Parallelism and delegation"
- [evidence contract](../../references/evidence-contract.md)
- [Git and destructive-operation safety](../../references/git-safety.md)
- [security policy](../../references/security.md)
- [repository adapter](../../references/repository-adapter.md)

Do not spawn one agent per directory. Parallelism is granted only to workstreams the dependency
graph proves independent, bounded by the configured concurrency limit.

## Initialize or resume

1. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/scaffold-repo.mjs" verify --root .`; managed-artifact drift or an invalid adapter blocks write stages until resolved. Absence of a scaffold is allowed.
2. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/completion-state.mjs" find-active`.
   - If an active or blocked run exists, summarize it (phase, wave, worker statuses from `worker list <runId>`) and resume from there instead of starting a duplicate. Revalidate anything stale against current repository/Git state before trusting it.
   - Otherwise initialize one: `completion-state.mjs init [--goal "$ARGUMENTS"] [--max-workers <n>]`. Read `.claude/asterweave.json` `completion.parallelism.maxWorkers` when `$ARGUMENTS` does not set `--max-workers`; default is 3.
3. Use `completion-state.mjs` for every phase, module, graph, wave, worker, lock, integration, and audit record. Never edit its files by hand.

## Phase 1-2 — Discovery and gap audit

1. Delegate repository discovery to `asterweave:repo-analyzer`: CLAUDE.md/.claude/**, `.claude/asterweave.json`, specs/**, README, architecture docs, source trees, tests, API routes, frontend routes, domain entities, application services, migrations, integrations, background workers/jobs, CI/CD, infrastructure, deployment, configuration. It must discover logical product/domain modules from actual architecture, not assume folders equal modules.
2. Delegate the completion audit to `asterweave:architect`, grounded in that discovery: for every module, determine `COMPLETE | PARTIAL | BROKEN | MISSING | UNKNOWN` from business functionality, API/backend, UI, persistence, validation, authorization, error handling, integration behavior, tests, data integrity, security, and operational readiness — never `COMPLETE` merely because files exist. Produce specific, actionable gaps (`FIN-002 partial refunds`, never `"improve Finance"`) with `P0`-`P3` priority.
3. Record it: `completion-state.mjs modules set <runId> --file <path>` (schema: [module gap inventory](../../references/project-completion.md#module-gap-inventory)). Then `completion-state.mjs phase <runId> gap-analysis`.
4. If material ambiguity remains about expected business behavior, delegate to `asterweave:requirements-challenger` before proceeding, and pause with `needs-human` if it isn't resolvable from the repository.

## Phase 3-4 — Prioritize

Within `architect`'s output, confirm every module's gaps are ordered (P0 correctness/security/production blockers first, then required P1 functionality, then P2 reliability/quality, then P3 polish) and every gap has an explicit dependency list (other modules, shared components, auth, schema, contracts).

## Phase 5-7 — Dependency graph and waves

1. Delegate to `asterweave:architect`: build the dependency graph (modules, shared libraries, domain primitives, auth/authz, schema, APIs/contracts, event schemas, infrastructure, shared UI, configuration) with `blocking` vs. `non-blocking` edges and identified shared write areas. Record: `completion-state.mjs graph set <runId> --file <path>`, then `phase <runId> dependency-analysis`.
2. Group modules into workstreams with explicit `write`/`read`/`deny`/`shared` ownership paths (see [worker context manifest](../../references/project-completion.md#worker-context-manifest-and-ownership)) and assign each to a wave. Record: `completion-state.mjs waves set <runId> --file <path>` — this validates dependency-respecting order and rejects an unsafe plan; fix the plan rather than the validator. Then `phase <runId> wave-planning`.
3. Never place two workstreams with a `blocking` dependency between them in the same wave, and never place a workstream ahead of a shared-infrastructure fix it depends on.

## Phase 8 — Workstream plan and approval

1. Present the plan: modules discovered, remaining critical modules, waves with their workstreams and reasons, shared paths requiring orchestrator approval, and expected concurrency (bounded by `maxWorkers`).
2. Obtain explicit human approval before launching parallel implementation, unless the repository's `.claude/asterweave.json` already declares an explicit trusted/autonomous mode permitting it. Record: `completion-state.mjs approve <runId> --by "..." --summary "..."` (this also advances the run to `implementation`).
3. If `$ARGUMENTS` contains `--dry-run`, stop here and return the plan without launching workers.

## Phase 9-16 — Parallel implementation, one wave at a time

For each wave, in order:

1. For every workstream in the wave: `completion-state.mjs worker init <runId> <id> --file <manifest.json>` using the [worker context-manifest](../../references/project-completion.md#worker-context-manifest-and-ownership) shape (`tasks`, `specs`, `rules`, `representativeFiles`, `write`/`read`/`deny`/`shared`). This enforces the concurrency limit and rejects ownership overlap with any other active worker before anything is spawned.
2. Spawn each initialized worker as `Agent({ isolation: "worktree", subagent_type: "asterweave:implementer", run_in_background: true, prompt: <self-contained assignment> })`. The prompt must be self-contained (the worker does not see this conversation and must not re-audit the whole repository): its module, its exact task IDs, the manifest's `specs`/`rules`/`representativeFiles`, its `write`/`read`/`deny`/`shared` boundaries, and this explicit first step — **write `.claude/asterweave/completion-worker.json` with the output of `completion-state.mjs worker manifest <runId> <id>` before any other tool call.** That activates the ownership-enforcement hook for the rest of its session. Instruct it to follow the [module implementation loop](../../references/project-completion.md): load its gaps, plan the smallest coherent batch, implement, run its module-scoped tests/lint, self-review, repeat — never attempt the entire remaining module unbounded in one pass.
3. When the tool call returns, record the actual branch/worktree: `completion-state.mjs worker start <runId> <id> --branch <b> --worktree <path>`.
4. If a worker needs a `shared` path, it must call `completion-state.mjs lock request` rather than edit it; evaluate impact against every other workstream that might also depend on it and decide with `lock decide` (`approve-exclusive-lock`, `create-shared-workstream`, `defer-until-next-wave`, or `replan-dependencies`). Never approve a shared edit silently.
5. Once a worker's implementation stabilizes (its tests pass), run its required read-only reviewers in parallel — `asterweave:staff-reviewer`, `asterweave:security-reviewer`, and any repository-routed domain reviewer for that module — then aggregate findings back to the same worker for fixes. Do not spawn a second writer for the same workstream.
6. A worker may report `pass` only under the [module completion contract](../../references/project-completion.md#failure-classification): assigned P0/P1 gaps implemented, acceptance criteria met, module build/tests/reviews pass, no unresolved blocking finding, diff stays inside its approved ownership (or an approved shared change), worktree clean and understood. Record: `completion-state.mjs worker complete <runId> <id> <outcome> --file <details.json>`.
7. Track progress concisely at the wave/worker level (module, status, rough percentage from completed vs. assigned tasks) instead of surfacing every worker's tool-level log in this context.

### Failure handling within a wave

Classify every non-`pass` outcome via `worker complete <runId> <id> <outcome>` (`implementation-failure`, `test-failure`, `environment-failure` → retryable; `dependency-discovered`, `ownership-conflict`, `shared-code-required`, `needs-human` → requires orchestrator decision). One worker's failure never rolls back another independent worker's already-verified work — decide per worker: retry, pause it, replan the wave, continue the others, or (only for a genuine cross-cutting blocker) stop the wave. On `dependency-discovered`, stop the conflicting change in that worker, update `dependency-graph.json`, and re-run `waves set` for the remaining waves rather than forcing the original plan.

## Phase 17-22 — Module verification and dynamic replanning

After each worker reaches `complete`, its module-level verification (tests, targeted checks, reviews) has already gated the `pass` outcome above; `completion-state.mjs phase <runId> module-verification` once every workstream in the current wave has reached a terminal state (`complete`, or a resolved `blocked`/`failed`) before moving to the next wave.

## Phase 23-25 — Merge, integration verification, cross-module scenarios

1. Integrate completed workstream branches in dependency order — never all at once. Inspect overlapping changes, resolve semantic conflicts, and prefer one PR per workstream via `asterweave:pr-engineer` unless the repository's delivery model requires a consolidated branch.
2. Run full integration verification with `asterweave:verification-engineer`: full build, full test suite, integration/E2E tests, architecture checks, security checks, database/contract validation. Passing module tests independently does not prove integration.
3. Validate the cross-module workflows the dependency graph flagged (e.g. Front Office → Finance, Receiving → Inventory → Finance). Record: `completion-state.mjs integration set <runId> --file <path>`, then `phase <runId> integration-verification`.

## Phase 26-27 — Final audit and report

1. Re-run the module completion audit (same rigor as Phase 1-2) and compare before/after per module. Do not inflate completion percentages — use remaining observable gaps.
2. Record: `completion-state.mjs final-audit set <runId> --file <path>`, then `phase <runId> report` and `complete-run <runId>`.
3. Report: modules discovered/completed/partial, P0-P3 remaining counts with what was intentionally deferred and why, build/tests/integration/security status, PR references, and recommended next work.

## Termination

Finish only when every wave reached a terminal state, integration verification passed, the final audit reflects observable (not assumed) completion, and remaining work is captured as a prioritized backlog. If budgets, an unresolved ownership conflict, or a genuine ambiguity block progress, pause the run (`completion-state.mjs pause <runId> --reason "..."`) with a concise blocker and recommended human decision — never claim completion by weakening a gate.
