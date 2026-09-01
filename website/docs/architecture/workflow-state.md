---
sidebar_position: 2
title: Workflow state
description: How Asterweave persists delivery progress outside conversation memory.
---

# Workflow state

Asterweave does not depend entirely on conversation context to know where a delivery stands. Progress lives on disk, in the repository being worked on:

```text
.claude/asterweave/state.json     current typed state
.claude/asterweave/events.jsonl   append-only history
```

Both files are owned exclusively by `scripts/graph-state.mjs`; nothing else should edit them directly. `state.json` holds the current node, its status and attempt count, recorded evidence, the goal, and the source reference (for example `owner/repo#123`). `events.jsonl` is an append-only audit ledger of every transition.

:::note Gitignore this by default
Add `.claude/asterweave/` to your ignore rules unless your organization intentionally retains sanitized workflow evidence in version control. Never store secrets, raw customer data, or sensitive logs there.
:::

## State commands

Run from the repository root:

```bash
node "<plugin>/scripts/graph-state.mjs" init --goal "..." --source "owner/repo#123"
node "<plugin>/scripts/graph-state.mjs" enter analyze
node "<plugin>/scripts/graph-state.mjs" evidence analyze --kind repository --summary "..." --result pass --path "..."
node "<plugin>/scripts/graph-state.mjs" complete analyze pass
node "<plugin>/scripts/graph-state.mjs" complete test fail-retryable --signature "tests:OrderService:expected-403"
node "<plugin>/scripts/graph-state.mjs" approve --by "user" --summary "Approved plan revision 2"
node "<plugin>/scripts/graph-state.mjs" pause --reason "Waiting for API contract decision"
node "<plugin>/scripts/graph-state.mjs" resume
node "<plugin>/scripts/graph-state.mjs" status --compact
node "<plugin>/scripts/graph-state.mjs" validate
```

User-provided text is quoted as data; it is never interpolated into a shell command without safe argument handling.

`.claude/asterweave/state.json` follows [`workflow-state.schema.json`](https://github.com/anjotadena/asterweave/blob/main/plugins/asterweave/schemas/workflow-state.schema.json) in the plugin source.

## Project-completion runs keep their own state

[`/asterweave:complete-project`](/commands/complete-project) coordinates several concurrent workers rather than one linear graph, so it persists a separate run bundle alongside the delivery state, owned exclusively by `scripts/completion-state.mjs`:

```text
.claude/asterweave/completion/<runId>/
  state.json             run status, phase, maxWorkers, approvals
  events.jsonl           append-only history
  modules.json           module gap inventory
  dependency-graph.json  modules, shared components, blocking edges
  waves.json             execution waves and workstream ownership
  workers/<id>.json      one record per workstream
  locks.json             shared-code change requests and decisions
  integration.json       integration-verification results
  final-audit.json       before/after completion, remaining backlog
```

`runId`s sort chronologically, so `completion-state.mjs find-active` finds the most recent unfinished run — that's how a completion run resumes instead of spawning duplicate workers. `state.json` follows [`completion-run.schema.json`](https://github.com/anjotadena/asterweave/blob/main/plugins/asterweave/schemas/completion-run.schema.json). The same gitignore guidance above applies.

Each worker also writes a small ownership manifest, `.claude/asterweave/completion-worker.json`, inside **its own worktree** — that file is what the [workstream ownership guard](/hooks/ownership-guard) reads to enforce write boundaries.

## The Stop hook keeps a workflow moving

Asterweave's `Stop` hook (`hook-stop-gate.mjs`) reads `state.json` on every turn boundary. If a workflow is `active` and not at `done` or paused at `approve`, it injects a reminder telling Claude to continue the current node, record evidence, and transition through `graph-state.mjs` — or, if human input is genuinely required, to record a `needs-human` outcome so the workflow becomes properly `blocked` and the turn can end. See [The Stop hook](/hooks/stop).

## Resuming

`/asterweave:resume` reads `state.json` and the relevant tail of `events.jsonl`, inspects current Git status/branch/diff and whether recorded artifact/commit paths still exist, and summarizes the goal, current node, completed evidence, attempts/budgets, blocker, and any repository divergence since the last event — without repeating completed nodes or discarding your changes. Pass `--inspect-only` to stop after the summary instead of continuing. See [Continuing interrupted work](/usage/continuing-work).

## Outcomes you'll see in state

| Status | Meaning |
| --- | --- |
| `active` at some node | The graph is mid-flight; the current node's evidence is not yet complete. |
| paused at `approve` | Waiting for your explicit approval of the plan (or a later approval-gated action). |
| `blocked` / `needs-human` | Asterweave stopped rather than guess — see [Starting new work](/usage/starting-new-work) for how to respond. |
| `policy-denied` | A proposed action would weaken a mandatory gate; it will not run. |
| `security-escalation` | A security finding requires a remediation decision before continuing. |
| `done` | Every node contract passed, and the convergence criteria in [Architecture overview](/architecture/overview#convergence-and-termination) are satisfied. |

## Related

- [Architecture overview](/architecture/overview) for the node contracts these commands drive through.
- [Resume](/commands/resume) and [Doctor](/commands/doctor) command references.
