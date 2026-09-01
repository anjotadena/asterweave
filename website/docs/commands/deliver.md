---
sidebar_position: 11
title: /asterweave:deliver
description: Run the full intake-to-pull-request delivery graph.
---

# `/asterweave:deliver`

## Purpose

Executes the complete issue-to-PR delivery workflow: intake, analysis, challenge, plan approval, implementation, tests, runtime verification, independent reviews, bounded repair loops, and PR submission. This is Asterweave's primary command — see [Architecture overview](/architecture/overview) for the full node-by-node contract.

## Syntax

```text
/asterweave:deliver <goal|owner/repo#issue> [--auto-pr]
```

## Arguments

`<goal|owner/repo#issue>` — a free-text goal, or an issue reference such as `owner/repo#123`.

## Options

| Flag | Effect |
| --- | --- |
| `--auto-pr` | Skip the explicit confirmation step before commit/push/PR creation. Every other gate (approval of the plan, tests, verification, review) still applies. |

## Prerequisites

Runs `scaffold-repo.mjs verify` first; managed-artifact drift or an invalid `.claude/asterweave.json` blocks write stages until resolved (absence of a scaffold is fine). If unfinished workflow state exists for a different goal, it is summarized rather than silently overwritten.

## What happens

Initializes or resumes durable state, then drives the full graph described in [Architecture overview](/architecture/overview#node-contracts): `intake → analyze → challenge → plan → approve → implement → test → verify → review → submit-pr → monitor-pipeline → resolve-review-comments → update-work-item → done`. A `test`/`verify`/`review`/`monitor-pipeline`/`resolve-review-comments` failure routes back to `implement`, invalidating and re-running the stages after it. Pauses for explicit human approval after `plan`, and (unless `--auto-pr`) again before commit/push/PR.

## Agents used

Across the full graph: `asterweave:repo-analyzer`, `asterweave:requirements-challenger`, `asterweave:architect`, `asterweave:implementer`, `asterweave:test-engineer`, `asterweave:verification-engineer`, `asterweave:staff-reviewer`, `asterweave:security-reviewer`, and `asterweave:pr-engineer` — or their routed project-specific equivalents per stage.

## Files modified

Source, test, and configuration files within the approved plan's scope; `.claude/asterweave/state.json` and `.claude/asterweave/events.jsonl` throughout.

## External side effects

Issue/work-item reads, a Git branch/commit/push, a pull-request create/update, CI-check polling, PR-comment reads/replies, and a final work-item update — every write previewed, confirmed, and read back.

## Output

A completed pull request whose evidence satisfies every node's contract, plus a final report — or, if it cannot proceed safely, a typed stop (`blocked`, `needs-human`, `policy-denied`, or `security-escalation`) with a concise reason and recommended human decision.

## Examples

```text
/asterweave:deliver owner/repository#123
```

```text
/asterweave:deliver owner/repository#123 --auto-pr
```

## Common errors

See [Starting new work](/usage/starting-new-work) and [Troubleshooting](/troubleshooting/common-issues) for `BLOCKED`/`needs-human` outcomes, invalid-adapter blocks, and stale evidence.

## Related commands

Runs [`/asterweave:analyze`](/commands/analyze), [`/asterweave:challenge`](/commands/challenge), [`/asterweave:plan`](/commands/plan), [`/asterweave:implement`](/commands/implement), [`/asterweave:test`](/commands/test), [`/asterweave:verify`](/commands/verify), [`/asterweave:review`](/commands/review), and [`/asterweave:submit-pr`](/commands/submit-pr) as graph nodes. Interrupted work resumes with [`/asterweave:resume`](/commands/resume).
