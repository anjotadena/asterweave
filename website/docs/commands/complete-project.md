---
sidebar_position: 18
title: /asterweave:complete-project
description: Audit an existing repository end to end and drive its remaining modules to completion with dependency-ordered parallel workstreams.
---

# `/asterweave:complete-project`

## Purpose

Analyzes an entire existing, partially implemented repository — not one issue — discovers its
real product/domain modules from actual architecture, determines what's complete, partial,
broken, missing, or unknown per module, builds a dependency graph between modules and shared
components, and executes the remaining work as dependency-ordered waves of isolated, ownership-
bounded parallel workers. See [Architecture overview](/architecture/overview) for how this relates
to the single-issue `deliver` graph, and the plugin's `references/project-completion.md` contract
for the full phase-by-phase detail this command follows.

## Syntax

```text
/asterweave:complete-project [--max-workers <n>] [--dry-run] [--resume]
```

## Options

| Flag | Effect |
| --- | --- |
| `--max-workers <n>` | Overrides the concurrency limit for this run (default 3, or the repository's `.claude/asterweave.json` `completion.parallelism.maxWorkers`). Never launches more workers than there are independent workstreams in the current wave regardless of this setting. |
| `--dry-run` | Stops after presenting the wave plan for approval, without launching any worker. |
| `--resume` | Explicit resume; also happens automatically when an unfinished run is detected. |

## Prerequisites

Runs `scaffold-repo.mjs verify` first; managed-artifact drift or an invalid `.claude/asterweave.json` blocks write stages until resolved (absence of a scaffold is fine). If an unfinished completion run exists (`.claude/asterweave/completion/<runId>/`), it is summarized and resumed rather than duplicated.

## What happens

Drives: `Repository Audit → Module Discovery → Gap Analysis → Dependency Analysis → Workstream Planning → Human review (unless an explicit autonomous mode is configured) → Parallel Implementation → Module Verification → Integration Verification → Completion Report`.

Each writing workstream runs in its own isolated Git worktree and branch. A worker's write access is bounded to its assigned paths and enforced by a `PreToolUse` hook, not just its prompt — an attempt outside that boundary is denied with the offending path and reason. A worker that needs a shared/core-code change must request a decision from the orchestrating session rather than edit it directly. One worker's failure never discards another independent worker's already-verified work; a newly discovered cross-module coupling stops the affected change and triggers a replan instead of forcing the original plan.

## Agents used

`asterweave:repo-analyzer` (discovery), `asterweave:architect` (gap audit, dependency graph, wave planning), `asterweave:requirements-challenger` (ambiguous business behavior), `asterweave:implementer` (one per workstream), `asterweave:staff-reviewer` and `asterweave:security-reviewer` (parallel read-only review once a workstream stabilizes), `asterweave:verification-engineer` (integration verification), and `asterweave:pr-engineer` (per-workstream PR submission) — or their routed project-specific equivalents.

## Files modified

Source, test, and configuration files within each workstream's approved write boundary, inside that workstream's own worktree; `.claude/asterweave/completion/<runId>/` (run state, module/dependency-graph/wave/worker/lock/integration/audit records) in the main working tree.

## External side effects

Optionally one Git branch/commit/push and pull-request per completed workstream, via `asterweave:pr-engineer` — every write previewed, confirmed, and read back, same as `deliver`.

## Output

A completion report: modules discovered/completed/partial, before/after completion percentages per module, remaining backlog by priority (P0-P3) with anything intentionally deferred explained, build/test/integration/security status, and PR references — or, if it cannot proceed safely, a paused run with a concise blocker and recommended human decision.

## Examples

```text
/asterweave:complete-project
```

```text
/asterweave:complete-project --max-workers 2 --dry-run
```

## Common errors

An ownership-overlap or concurrency-limit error at worker initialization means the wave plan needs narrower boundaries or fewer concurrent workstreams — see [Troubleshooting](/troubleshooting/common-issues). A `WRITE DENIED` during implementation means a worker attempted a path outside its assigned ownership; that is the hook working as intended, not a bug to bypass.

## Related commands

Delegates bounded per-workstream implementation through the same [`asterweave:implementer`](/agents/implementer) loop [`/asterweave:deliver`](/commands/deliver) uses for a single issue. Interrupted runs resume with the same command; [`/asterweave:resume`](/commands/resume) is for a single-issue `deliver` graph, not a completion run. [`/asterweave:doctor`](/commands/doctor) diagnoses plugin/hook health if the ownership guard isn't behaving as expected.
