# Project-completion contract

## Contents

- Purpose
- Phase model
- Run state
- Module gap inventory
- Dependency graph and waves
- Worker context manifest and ownership
- Shared-code protocol
- Concurrency limit
- Isolation
- Failure classification
- Merge and integration strategy
- Resumability and observability
- Human control

## Purpose

`/asterweave:complete-project` (skill: `complete-project`) analyzes an existing, partially
implemented repository as a whole, discovers its real product/domain modules, determines what
remains to finish each one, and executes that remaining work as dependency-ordered waves of
isolated parallel workers — one writer per workstream, coordinated centrally, never guessing at
parallelism from folder names.

It does not replace [`/asterweave:deliver`](graph-contract.md): a single completion workstream's
implementation loop is the same bounded implement → test → verify → review cycle `deliver` uses,
just delegated per-module instead of per-issue. Use `deliver` for one bounded change; use
`complete-project` to drive many independent modules of an existing repository toward completion
in one coordinated run.

## Phase model

`discovery -> gap-analysis -> dependency-analysis -> wave-planning -> awaiting-approval ->
implementation -> module-verification -> integration-verification -> report -> done`

| Phase | Produces | Owner |
| --- | --- | --- |
| `discovery` | Module inventory grounded in real architecture (not folder names) | `asterweave:repo-analyzer` |
| `gap-analysis` | Per-module status, completion estimate, actionable gaps with IDs and priority | `asterweave:architect` |
| `dependency-analysis` | Dependency graph: modules, shared libraries, blocking vs. non-blocking edges | `asterweave:architect` |
| `wave-planning` | Execution waves, workstream ownership boundaries, concurrency plan | `asterweave:architect` + orchestrator |
| `awaiting-approval` | Explicit human approval of the wave plan | Human (skip only in an explicit autonomous mode the repository has configured) |
| `implementation` | Parallel module workers, one worktree/branch per workstream | `asterweave:implementer` per workstream |
| `module-verification` | Independent tests/reviews per completed workstream | `asterweave:test-engineer`, `asterweave:staff-reviewer`, `asterweave:security-reviewer` |
| `integration-verification` | Full-repository build/test/E2E and cross-module scenario checks | `asterweave:verification-engineer` |
| `report` | Before/after completion percentages, remaining backlog by priority | orchestrator |

The orchestrating session (the one that ran `/asterweave:complete-project`) stays the coordinator
throughout: it owns the dependency graph, wave plan, worker lifecycle, shared-code locks, and
result aggregation. It does not implement module code itself while workers are active.

## Run state

State lives under `.claude/asterweave/completion/<runId>/`, written only through
`scripts/completion-state.mjs` (never edited by hand), mirroring how `deliver` owns
`.claude/asterweave/state.json` through `graph-state.mjs`:

```text
.claude/asterweave/completion/<runId>/
  state.json            run status, phase, maxWorkers, approvals
  events.jsonl           append-only audit ledger
  modules.json           gap inventory (Phase: gap-analysis)
  dependency-graph.json  nodes + edges (Phase: dependency-analysis)
  waves.json             execution waves (Phase: wave-planning)
  workers/<id>.json      one record per workstream (Phase: implementation onward)
  locks.json             shared-code change requests and decisions
  integration.json       integration-verification results
  final-audit.json       before/after completion percentages, remaining backlog
```

`schemas/completion-run.schema.json` documents each file's shape. `runId`s sort chronologically
(`project-completion-<UTC timestamp>`), so `find-active` and `list` can identify the most recent
unfinished run without a separate pointer file.

## Module gap inventory

`discovery` and `gap-analysis` write `modules.json`, an array where every module has:

- `id`, `name`, `status` (`COMPLETE | PARTIAL | BROKEN | MISSING | UNKNOWN`), `completionEstimate`
  (0-100, evidence-based — never inferred from file existence alone);
- `implemented`: what already works;
- `gaps`: `{ id, priority: P0-P3, description, category? }` — every gap must be a specific,
  actionable unit of work (`FIN-002 partial refunds`), never a vague instruction
  (`"improve Finance"`);
- `testingGaps`, `securityNotes`, `dependencies` (other module/shared-component ids).

A feature is not `COMPLETE` because its files exist — the audit must consider business behavior,
API/UI, persistence, validation, authorization, error handling, integration behavior, tests, data
integrity, security, and operational readiness before marking a module complete.

`completion-state.mjs modules set <runId> --file <path>` validates status/priority enums and
rejects duplicate module ids before writing.

## Dependency graph and waves

`dependency-analysis` writes `dependency-graph.json`: `{ nodes: [{id, type}], edges: [{from, to,
type: "blocking" | "non-blocking", sharedPaths? }] }`. `graph set` rejects a cycle among
`blocking` edges — such a cycle would make any wave ordering impossible, so it is caught before
planning rather than discovered mid-execution.

`wave-planning` writes `waves.json`: `[{ wave: 1, workstreams: [{ id, modules: [...], dependsOn:
[...] }] }]`. `waves set` runs `validateWaves`, which rejects a plan where:

- a workstream's `dependsOn` names a workstream in the same or a later wave;
- a module-level `blocking` edge crosses two workstreams whose waves don't respect that order.

This is the mandatory dependency-aware, ownership-aware check before any writer is spawned —
parallelizing agents is not the goal; parallelizing genuinely independent work is.

## Worker context manifest and ownership

Each workstream gets a focused manifest, not the whole repository:

```json
{
  "workstreamId": "WS-FINANCE",
  "module": "Finance",
  "tasks": ["FIN-001", "FIN-002", "FIN-003"],
  "specs": ["specs/finance/**"],
  "rules": [".claude/rules/backend.md", ".claude/rules/database.md"],
  "representativeFiles": ["src/Finance/RefundService.cs"],
  "write": ["src/Finance/**", "tests/Finance/**"],
  "read": ["src/**", "tests/**", "specs/**", ".claude/**"],
  "deny": ["src/Inventory/**", "src/HRIS/**", "src/FrontOffice/**"],
  "shared": ["src/Shared/**", "src/Infrastructure/**"],
  "approvedShared": []
}
```

`completion-state.mjs worker init <runId> <id> --file <manifest.json>` records it, after
rejecting the worker if the run's `maxWorkers` concurrency limit is already reached, or if its
`write` ownership overlaps another still-active worker's `write` ownership (an ownership conflict
caught here is far cheaper than one discovered mid-implementation).

Spawn the workstream with `Agent({ isolation: "worktree", subagent_type: "asterweave:implementer",
... })` — the harness creates the isolated worktree/branch; record the returned path/branch with
`worker start <runId> <id> --branch <b> --worktree <path>`. The worker's first action must be to
write `workerManifest(worker)` (from `worker manifest <runId> <id>`) to
`.claude/asterweave/completion-worker.json` **inside its own worktree** — this is what activates
enforcement.

## Enforcement

A PreToolUse hook (`completion-guard.mjs`, matcher `Edit|Write|NotebookEdit`) reads that local
manifest on every write attempt and denies anything outside `write`/`approvedShared`, returning a
structured `WRITE DENIED` reason naming the worker, the path, and why. Sessions with no
`completion-worker.json` (every non-worker session) are unaffected — this is not a global lock,
only a per-worktree one. This is enforcement, not a prompt convention: do not rely on the worker
merely being told its boundaries.

## Shared-code protocol

A worker must never edit a `shared` path directly, even if it believes it's the only one touching
it. Instead:

1. Worker calls `completion-state.mjs lock request <runId> --worker <id> --path <glob> --reason
   "..."`.
2. Orchestrator evaluates impact against every other workstream that might also depend on that
   shared path, then calls `lock decide <runId> <lockId> --decision <decision> --by <identity>`
   with one of:
   - `approve-exclusive-lock` — grants that worker `approvedShared` for that path (the hook then
     allows it) until the workstream completes;
   - `create-shared-workstream` — split the shared change into its own workstream/wave;
   - `defer-until-next-wave` — the shared change waits;
   - `replan-dependencies` — the dependency graph and waves were wrong; re-run wave-planning.

## Concurrency limit

`maxWorkers` (default 3, override with `init --max-workers <n>` or repository
`.claude/asterweave.json` `completion.parallelism.maxWorkers`) bounds active workers
(`pending|implementing|verifying|code-review`) across the run. `worker init` refuses to add a
worker past the limit. Never launch more workers than there are independent workstreams in the
current wave, and never launch a wave's workers before the wave plan is approved.

## Isolation

Every writing workstream runs in its own Git worktree (via Agent `isolation: "worktree"`) and
branch — never two independent writer agents in the same working directory. `scripts/worktree.mjs
list` inspects existing worktrees for resume; `worktree.mjs remove <path>` safely cleans one up
only after confirming it has no uncommitted changes (or `--force`, used deliberately).

## Failure classification

`completion-state.mjs worker complete <runId> <id> <outcome>` requires one of:

| Outcome | Meaning | Worker status becomes |
| --- | --- | --- |
| `pass` | Assigned P0/P1 tasks done, module gate green, reviews clean | `complete` |
| `implementation-failure` | Could not implement within budget | `failed` |
| `test-failure` | Implementation done, module tests fail | `failed` |
| `environment-failure` | Toolchain/environment problem, not a code defect | `failed` |
| `dependency-discovered` | Found a coupling the graph missed | `blocked` |
| `ownership-conflict` | Needs a path outside its `write` boundary | `blocked` |
| `shared-code-required` | Needs a shared-path change (see lock protocol) | `blocked` |
| `needs-human` | Ambiguous business behavior or a decision only a human can make | `blocked` |

One worker's failure never rolls back another independent worker's completed, verified work. On
`dependency-discovered`, stop the conflicting change, update `dependency-graph.json`, and re-run
`waves set` — do not force the original plan once evidence shows it unsafe.

## Merge and integration strategy

After a wave's workers reach `complete`, integrate branches in dependency order (never all at
once): inspect each diff for overlap, resolve semantic conflicts, then run
`integration-verification` — full build, full test suite, integration/E2E, architecture and
security checks, and the cross-module scenarios the dependency graph flagged (e.g. Front Office →
Finance, Receiving → Inventory → Finance). Passing module tests independently does not prove
modules integrate. Record results with `completion-state.mjs integration set`. Prefer one PR per
meaningful workstream via `asterweave:pr-engineer` unless the repository's delivery model requires
a single consolidated branch.

## Resumability and observability

`find-active` returns the most recently updated run that is not `completed`/`aborted`; resume it
instead of starting a duplicate. Report progress concisely at the wave/worker level (module,
status, percentage) — do not surface every worker's low-level tool log in the parent context;
that detail lives in each worker's own transcript and in `events.jsonl`.

## Human control

Require explicit approval before `implementation` begins (the `awaiting-approval` phase), unless
the repository has an explicit trusted/autonomous mode that permits skipping it. Pause for
ambiguous business behavior, a major architecture change, a destructive operation, an incompatible
contract between workstreams, an unresolved ownership conflict, production-deployment approval, or
security-risk acceptance. Routine per-module implementation stays autonomous inside its approved
boundary.
