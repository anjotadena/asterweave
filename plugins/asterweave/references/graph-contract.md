# Asterweave graph contract

## Contents

- Control model
- Node contracts
- Typed edges and recovery
- State commands
- Convergence and termination
- Parallelism and delegation

## Control model

Use a deterministic delivery graph around Claude's ordinary gather-act-verify loop:

`intake -> analyze -> challenge -> plan -> approve -> implement -> test -> verify -> review -> submit-pr -> done`

The graph owns routing, attempt budgets, approvals, and evidence. Claude reasons and uses tools inside one node at a time. A narrative claim never changes graph state.

State lives at `.claude/asterweave/state.json`. An append-only audit ledger lives at `.claude/asterweave/events.jsonl`. Update both only through `scripts/graph-state.mjs`. These files may be gitignored if the team does not want local workflow data committed; never store secrets or sensitive issue content in them.

## Node contracts

| Node | Exit evidence | Attempts | Write policy |
| --- | --- | ---: | --- |
| `intake` | `task`: normalized task, criteria, constraints, source | 2 | GitHub writes require confirmation |
| `analyze` | `repository`, `baseline`: stack/map and command results | 2 | Read-only |
| `challenge` | `requirements`: readiness and resolved decisions | 2 | Read-only |
| `plan` | `plan`: approved-ready change/test/rollback DAG | 2 | Read-only |
| `approve` | `approval`: human identity and decision | 1 | State only |
| `implement` | `change`: diff/commit and self-review | 3 | Approved scope only |
| `test` | `unit-test`, `integration-test`: commands and results | 3 | Tests/fixtures only for test agent |
| `verify` | `acceptance`: criteria-to-runtime evidence | 2 | Read-only except ephemeral test data |
| `review` | `code-review`, `security-review`: independent verdicts | 2 | Read-only |
| `submit-pr` | `pull-request`: URL, SHA, base/head, checks | 2 | Confirmed commit/push/PR only |

Record a required category as non-applicable only with evidence explaining why and which alternative verification covers the risk.

## Typed edges and recovery

- `pass`: advance to the next node only when required evidence exists and its latest result is not failing.
- `fail-retryable`: use a new hypothesis. Failures from test/verify/review route back to implement; other nodes retry locally.
- `fail-replan`: route to plan because repository facts or constraints invalidated the approved design.
- `blocked` or `needs-human`: pause without consuming retries until the blocker is resolved.
- `policy-denied`: pause; choose a safer design or request authorized human action. Never weaken policy.
- `security-escalation`: pause at security review and require a remediation decision.
- `abort`: terminate without claiming success.

Use a stable failure signature derived from normalized error type, failing test/check, and relevant component. If the same signature recurs with no meaningful state change, stop retrying and escalate.

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

Quote user-provided text as data; never interpolate it into a shell command without safe argument handling.

## Convergence and termination

Do not treat “the model stopped calling tools” as success. Finish only when:

- every node passed its evidence contract;
- every acceptance criterion links to current passing evidence;
- required build/static/unit/integration/runtime checks pass;
- no unresolved Critical/High review or security finding remains;
- approval and GitHub identifiers exist;
- the current diff matches the evidence revision.

Bound retries by the node budget. Within an attempt, bound tool/turn/time use proportionally to the task. After a repeated signature, call `failure-analyst` or ask for human direction.

## Parallelism and delegation

Parallelize only independent read-only discovery, tests with isolated data, or independent reviews. Serialize changes sharing files, schemas, migrations, APIs, generated output, or configuration.

For parallel writers, require separate Git worktrees/branches, explicit file/interface ownership, an integration order, and a final combined test run. Subagents receive isolated contexts: every delegation must contain the approved criteria, repository facts, exact assignment, constraints, and output contract. Only summaries and evidence references return to the parent.
