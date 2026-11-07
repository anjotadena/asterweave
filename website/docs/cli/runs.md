---
sidebar_position: 5
title: Runs
description: "Asterweave CLI runs (Phase B): run show, approve and abort, the delivery and bugfix graphs, budgets, approvals, crash recovery and the run lock. Everything is simulated: no real tool execution and no model calls."
---

# Runs

A **run** is one pass of a workflow graph (`delivery@1` or `bugfix@1`) over a goal, kept on disk so it survives a crash, a Ctrl+C or a machine restart. Phase B of the CLI adds the run engine: the graph state machine, the persistent ledger, the run lock, approvals, budgets, the guard and hooks.

:::caution What is simulated in Phase B
**Phase B carries out no tool for real and calls no model.** There are **no model calls** and **no real tool execution**. The only executor is a scripted **fake executor** that replays a JSON file of actions, and the tool dispatcher is a simulation that records what it was asked to do and returns canned results. Every action still goes through the full guard, hooks, budgets and audit trail, so the safety behavior is real, but no action of a run writes a file, runs a command or touches the network. Exactly what does run on your machine: the **hooks** you configured (processes started without a shell; see [Hooks](/cli/hooks)), and the read-only `git` queries that identify the repository. The same simulation is why two safety limits below are deliberately advisory: a real tool dispatcher must not ship before approvals have a non-forgeable path (for example a per-request nonce shown only on an interactive terminal, with only its hash stored, or terminal-only grants) and the processes it starts are isolated by the operating system. The commands that start or resume a run are hidden behind an environment variable (see [Development commands](#development-commands-hidden)). A real executor arrives in a later phase.
:::

## Public commands

All three commands work on the runs of the repository you are in (run them inside the clone). A run id is 1 to 64 letters, digits, `-` or `_`.

| Command | What it does | Flags |
| --- | --- | --- |
| `asterweave run show [runId]` | Graph, status, per-node attempts, approvals (with the subject hash prefix), budgets, the run lock and the policy. Without a run id: the newest run of this repository | `--json` |
| `asterweave run approve <runId>` | Record an approval for a waiting run | `--approval id`, `--subject hash`, `--json` |
| `asterweave run abort <runId>` | Stop a run for good. Already aborted: nothing happens (idempotent) | `--yes`, `--json` |

`run show` reads without taking the lock, so it works while a run is being driven. Tokens are shown as `unavailable` when the executor did not report usage; they are never shown as 0.

```text
Run       demo-1
Graph     delivery@1 (3f9a...)
Goal      ship the feature
Status    waiting-approval (at approve)
Policy    supervised, bound 9c1d2e4f5a6b
Lock      none

Nodes
  intake   passed   1/2  pass
  ...
Approvals
  ap-1  pending  plan plan -> approve
      subject 7b3e91c0d2a4  target 7 chars  requested by guard
Approve with:
  asterweave run approve demo-1 --approval ap-1 --subject 7b3e91c0d2a4
```

### `run show --json`

```json
{"ok":true,"run":{"runId":"demo-1","graph":{"id":"delivery","version":1,"hash":"3f9a..."},"goal":"ship the feature","status":"waiting-approval","currentNode":"approve","repo":{"realpath":"C:\\work\\widgets"},"createdAt":"...","updatedAt":"...","lastSeq":42,"eventsBehind":0,"nodes":[{"id":"intake","status":"passed","attempts":1,"maxAttempts":2,"outcome":"pass"}],"approvals":[{"id":"ap-1","kind":"plan","scope":{"operation":"plan","target":"approve"},"targetLength":7,"displayable":true,"state":"pending","valid":false,"subject":"7b3e91c0d2a4","requestedBy":"guard","by":null,"requestedAt":"...","grantedAt":null,"invalidatedAt":null}],"budgets":{"iterations":{"used":0,"limit":20},"toolCalls":{"used":0,"limit":200},"tokens":{"used":null,"limit":null,"available":false},"wallMs":{"used":1200,"limit":1800000}},"lock":{"state":"none","pid":null,"ageMs":null},"policy":{"mode":"supervised","hash":"9c1d2e4f5a6b","currentHash":"9c1d2e4f5a6b","changed":false,"error":null},"attention":null}}
```

`attention` is the last guard decision that is not an `allow` while the run is blocked, waiting or paused: `{decision, reason, ruleId, message, node, point, at}`. `policy.changed` is `true` when `policy.json` changed since the run started (see [Policy and guards](/cli/policy-and-guards#policy-hash-drift)).

### `run approve`

An approval is the only way a run gets past a plan checkpoint, a merge, a deploy, a default-branch push or any other operation that needs a person. It can only come from **you**:

- **In a terminal**, `run approve <runId>` shows each waiting approval (kind, **who requested it** - `executor`, `guard` or `hook` -, scope, the **whole target** with its length, and the subject hash prefix) and asks `y/N`. The default is No. Newline, tab and backslash in a target are shown as the escapes `\n`, `\t` and `\\` so two different targets never look alike. The answers are applied **all or nothing**: every approval is validated first, and if any of them changed while you were deciding, nothing is granted.
- **With flags** (scripts, CI shells you control): `run approve <runId> --approval <id> --subject <hash prefix>`. The subject must be the hash prefix that `run show` prints (at least 6 hex characters); a different prefix is a usage error (exit 2) and nothing is granted. `--approval` and `--subject` go together. Without them, `run approve` needs a terminal; with `--json` it always needs the flags.
- It **refuses to run when `ASTERWEAVE_RUN_ID` is set**, so a process inside a run cannot grant itself approval. **This refusal is advisory**: a child process can simply unset the variable. It is acceptable only because Phase B carries out simulated tools. As a cheap hardening, `run show` hides the approval subject hashes (`hidden inside a run`) when the variable is set.
- Approvals are never read from repository files, model output, MCP servers or image text.
- **What you approve is what you see.** The subject hash binds the raw target, so a request is only ever created for a target that displays faithfully: at most 2000 characters, no control, invisible or direction-changing characters, nothing that the secret redactor would rewrite. Otherwise the node ends `policy-denied` with reason `UNDISPLAYABLE_TARGET` (exit 7) and no request exists. A grant is also refused when the stored scope no longer matches the hash it was bound to.

An approval is valid only while the thing it was granted for is unchanged: the same artifact hash and revision (for a plan), the same exact command or input (for an operation), and the same policy hash. A changed plan invalidates its approval and every approval that depends on it; a changed `policy.json` makes the run ask again before it goes on. `run approve` checks the policy hash in force now: a request made under another policy fails with `APPROVAL_STALE`, and the next `run resume` asks you to accept the policy change (the request to accept it names the new policy and can be granted), retires the requests of the old policy and asks again.

Exit codes: 0 granted. 1 run not found, approval not found, approval already granted, invalidated, stale (`APPROVAL_STALE`) or changed while you were deciding, declined (`APPROVAL_DECLINED`), a scope that cannot be shown faithfully (`UNDISPLAYABLE_TARGET`). 2 usage. 130 interrupted. Every `run` command first checks that the work tree git reports belongs to the repository; a repository whose `.git/config` sets `core.worktree` to some other directory (for example a parent) fails with `REPO_WORKTREE_MISMATCH` (exit 1) because it would widen the guard's workspace root.

### `run abort`

Asks `y/N` in a terminal (answering No fails with `ABORT_DECLINED`, exit 1); needs `--yes` otherwise. It takes the run lock, first completes an event group that a killed process left unfinished (see [Crash recovery](#crash-recovery)), records the abort in the audit trail and sets the status to `aborted`. A completed run cannot be aborted (`RUN_NOT_ACTIVE`, exit 1).

## Statuses and exit codes

| Status | Meaning | Exit code of the command that stopped there |
| --- | --- | --- |
| `active` | A process is (or was, before a crash) driving it | none |
| `waiting-approval` | A person has to approve something. `run show` lists it | 6 |
| `waiting-external` | A `wait`-kind node is waiting for an external event (no registered graph uses one in Phase B) | 0 |
| `paused` | Interrupted (Ctrl+C, SIGTERM). Resuming continues the same attempt | 130 |
| `blocked` | Stopped; see the node outcome below | 7 for `policy-denied`, 6 for `needs-human` and `security-escalation`, otherwise 1 |
| `completed` | Every node passed | 0 |
| `aborted` | Stopped by `run abort` | 1 |

Node outcomes are `pass`, `fail-retryable`, `fail-replan`, `blocked`, `needs-human`, `policy-denied`, `security-escalation` and `abort`. A headless run that needs a person never waits on a prompt: it saves its state, prints what it is waiting for and exits 6.

## Graphs

Both graphs are plain data, built into the CLI. Each node has an attempt budget (`maxAttempts`) and a list of **evidence kinds** it must record before it can pass: for every required kind the **latest** entry in the **current attempt** must not be a failure. Evidence from an earlier attempt does not count (a re-run needs fresh evidence).

### `delivery@1`

| Node | Max attempts | Required evidence | Notes |
| --- | --- | --- | --- |
| `intake` | 2 | `task` | |
| `analyze` | 2 | `repository`, `baseline` | |
| `challenge` | 2 | `requirements` | |
| `plan` | 2 | `plan` | Produces the `plan` artifact |
| `approve` | 1 | `approval` | An approval node: needs a valid plan approval from a person. Depends on `plan` |
| `implement` | 3 | `change` | |
| `test` | 3 | `unit-test`, `integration-test` | |
| `verify` | 2 | `acceptance` | |
| `review` | 2 | `code-review`, `security-review` | |
| `submit-pr` | 2 | `pull-request` | |
| `monitor-pipeline` | 3 | `pipeline` | |
| `resolve-review-comments` | 3 | `review-comments` | |
| `update-work-item` | 2 | `work-item-update` | Last node; passing it completes the run |

Routing:

| Outcome | From | Goes to |
| --- | --- | --- |
| `pass` | any node | the next node (the last one completes the run) |
| `fail-retryable` | `test`, `verify`, `review`, `monitor-pipeline`, `resolve-review-comments` | `implement`; nodes from `implement` up to and including the failing one are reset and run again |
| `fail-retryable` | any other node | the same node again |
| `fail-replan` | `intake`, `analyze`, `challenge`, `plan` | the same node again (there is nothing earlier to re-plan) |
| `fail-replan` | later nodes | `plan`; `plan` through the failing node are reset. A new plan revision invalidates the old approval, and `approve` gets a fresh attempt budget |
| `blocked`, `needs-human`, `policy-denied`, `security-escalation` | any node | the run stops at that node (`blocked` status). These outcomes **refund** the attempt they used |

Two safety rules apply on top: if the **same failure signature** occurs a second time at a node (twice in total), the run is blocked instead of retrying again (a `node.completed` event with `stableFailure: true`), and a node whose attempts are used up blocks the run (a `budget.exhausted` event with `scope: "node"`; a routing cap is `scope: "edge"`, a run budget `scope: "run"`).

### `bugfix@1`

`delivery@1` without `challenge` (a bug report is not a feature request to challenge), and `analyze` also requires `reproduction` evidence: a failing case must be captured before anything is changed. The routing and budgets are otherwise identical.

## Budgets

| Budget | Default | Counted |
| --- | --- | --- |
| `iterations` | 20 | per attempt of a node (one observe, decide, act round) |
| `toolCalls` | 200 | per run, every dispatched tool action |
| `wallMs` | 30 minutes | per run, across restarts |
| `tokens` | unlimited | only when the executor reports usage; unknown usage stays unknown and is **never counted as 0**. The fake executor reports none |

Exhausting a budget records `budget.exhausted` and ends the attempt as `blocked` (exit 1, reason `BUDGET_EXHAUSTED`). A tool call that would exceed the limit is refused before it runs. Resuming with the same limits is refused again; raising the limits lets the run continue. Limits can be tuned in the `autonomous.budgets` block of [`policy.json`](/cli/policy-and-guards#the-policy-file) (`0` means unlimited).

## Where a run lives

Runs are stored in the Asterweave **user directory**, never in the repository:

```text
<userDir>/runs/<repoKey>/<runId>/
  run.json        the current snapshot (atomically rewritten)
  events.jsonl    the append-only audit trail, one JSON object per line
  run.lock        present while a process drives the run
```

`<repoKey>` is a fixed-length name derived from the repository identity (the real path of the clone's git directory), so every work tree of one clone shares its runs. Nothing else is stored: no secrets, and every string in both files passes through the secret redactor.

`run.json` holds `v`, `runId`, `graph` (`id`, `version`, `hash`), `repo`, `goal`, `status`, `currentNode`, per-node state (`status`, `attempts`, `maxAttempts`, `traversals`, `outcome`, `failureSignatures`, `attemptLog`), `artifacts` (hash, revision, dependencies), `approvals`, `budgets.used`, `policyHash`, `lastSeq`, and timestamps. A run written by a newer Asterweave is refused with `RUN_SCHEMA_TOO_NEW` (exit 5); a run whose graph this build does not provide in the same form is refused with `RUN_GRAPH_UNKNOWN`.

Every line of `events.jsonl` is `{v, seq, at, runId, type, ...}`. `v`, `seq`, `at` and `runId` are the first members of every line, and a record's own members with those names are dropped before the line is built, so an event cannot spoof them. The event types are:

| Type | Meaning |
| --- | --- |
| `run.created`, `run.paused`, `run.resumed`, `run.aborted`, `run.completed` | Run lifecycle |
| `run.rewound` | A new revision of an artifact (the plan) put a run that had moved past it back at the node that depends on it. Written in the same event group as the transition that changed the artifact |
| `run.updated` | A transition that changed nothing else (a placeholder so every transition leaves a record) |
| `node.entered`, `node.completed`, `node.recovered` | A node started, ended, or was picked up again after a crash |
| `action.proposed`, `action.started`, `action.completed`, `action.rejected`, `action.verified` | One executor action and its side effect |
| `tool.decision` | Every guard decision: `decision`, `reason`, `ruleId`, evaluation `point` (`dispatch`, `advancement`, `retry`, `resume`, `node.before-enter`, `approval`) |
| `evidence.recorded` | Evidence for the current attempt |
| `approval.requested`, `approval.granted`, `approval.invalidated`, `policy.bound` | Approvals and the policy hash the run is bound to |
| `hook.result` | The outcome of each hook that ran (never its stdin payload) |
| `budget.exhausted` | A budget ran out |
| `ledger.repaired`, `ledger.folded` | Recovery bookkeeping (below) |

## Crash recovery

- **Event first, snapshot second.** Each change is appended to `events.jsonl` and only then written to `run.json`. If the process dies in between, the next process sees the snapshot is *behind* the log and folds the missing events in before doing anything (`ledger.folded`). The log alone can rebuild the snapshot.
- **A torn last line** (a crash in the middle of a write) is ignored by readers, and cut off, under the lock, by the next process (`ledger.repaired`).
- **A crash-interrupted attempt continues as the same attempt.** No new attempt is consumed and the executor continues at the step the log says is next.
- **Side effects use idempotency keys.** An action is recorded as `action.proposed`, then (after the guard allowed it) `action.started`, then `action.completed`. On resume: a started action whose key already completed is skipped; a started-but-not-completed action that is **idempotent** (by default only `read` and `write`) is run again (`node.recovered`); one that is **not idempotent** (`edit`, `shell`, `git`, `merge`, `deploy`) stops the node for a person with `SIDE_EFFECT_UNKNOWN` (outcome `needs-human`, exit 6). Nothing is ever repeated silently. The executor is untrusted: it can mark an action **not** repeatable (`idempotent: false` in a script), but it can never declare a shell, git, merge, deploy or edit action repeatable.
- **An interrupted event group is completed.** A transition is written as a group of events (for example `node.completed` then `run.paused`, plus any `approval.invalidated` / `run.rewound` the new artifact revision implies). If the process dies in the middle, the next process that takes the lock - `run resume`, but also `run approve` and `run abort` - writes the missing events from the group's first event, exactly once, even when a torn last line had to be cut off first. The artifact reconciliation is part of the group, so it cannot be lost to a crash while the `node.completed` hooks run.
- **Ctrl+C** (SIGINT or SIGTERM) pauses the run cleanly, releases the lock and exits 130. A second signal ends the process immediately. The run resumes the same attempt later.

## The run lock

Only one process may drive or change a run. The lock is the file `run.lock` in the run directory, created exclusively and holding the owner's process id, host name and a random token. While a run is being driven the owner refreshes the file's modification time every 5 seconds (heartbeat). Every write to the ledger verifies that the lock still belongs to the writer.

A second process that finds a live lock fails with `RUN_LOCKED` (exit 1) and leaves the first one alone. A lock is **stale**, and is taken over, when either:

- it was written on this host and its process no longer exists; or
- its heartbeat is older than 60 seconds.

An owner whose lock was taken over notices at its next heartbeat; from then on mutating actions are refused (`GUARD_UNAVAILABLE`, rule `lock-not-held`) and the ledger rejects its writes, so a deposed process cannot corrupt the run. `run show` displays the lock as `none`, `live` or `stale`, with the owner's pid.

## Development commands (hidden)

`run start` and `run resume` drive the loop with the fake executor. They are **hidden** (not in `help`) and only work when the environment variable `ASTERWEAVE_DEV_EXECUTORS=1` is set; otherwise they exit 2 with "not available". They exist to exercise the engine, not to do work.

```text
asterweave run start --executor fake --script <file> [--graph delivery@1|bugfix@1] [--goal text] [--run-id id]
asterweave run resume <runId> --executor fake --script <file>
```

`resume` needs the script again because the ledger does not store it. Both also accept `--json`. A script is:

```json
{"v":1,"steps":[
  {"node":"intake","action":{"v":1,"type":"evidence","evidence":{"kind":"task","summary":"read the task","result":"pass"}}},
  {"node":"intake","action":{"v":1,"type":"complete","outcome":"pass"}},
  {"node":"implement","action":{"v":1,"type":"tool","tool":{"name":"merge","input":{"branch":"feat/x","into":"main"}}}}
]}
```

Steps are consumed in order per node across the whole run. A step can also carry `delayMs` (a plain wait, or the duration of the tool call), `idempotent: false`, or be `{"node":"intake","malformed":"..."}` to test bad executor output (two re-asks, then the attempt fails with signature `executor:malformed-output`). When a node has no step left the executor answers `needs-human`. An invalid script is `SCRIPT_INVALID` (exit 2); script values are never echoed.

### Headless approval walkthrough

```bash
export ASTERWEAVE_DEV_EXECUTORS=1
asterweave run start --executor fake --script plan.json --run-id demo-1
# ... stops at the plan checkpoint, exit 6
asterweave run show demo-1                 # lists the approval and its subject hash prefix
asterweave run approve demo-1 --approval ap-1 --subject 7b3e91c0d2a4
asterweave run resume demo-1 --executor fake --script plan.json   # continues from the checkpoint
```

A script that proposes `git reset --hard` instead ends the run with exit 7 (`DESTRUCTIVE_COMMAND`), and nothing is dispatched.

## Errors

| Code | Exit | When |
| --- | --- | --- |
| `RUN_LOCKED` | 1 | Another live process holds the run lock |
| `RUN_NOT_FOUND`, `RUN_NOT_ACTIVE`, `RUN_ID_INVALID` | 1, 1, 2 | Unknown run or none for this repository; completed or aborted run; bad run id |
| `RUN_SCHEMA_TOO_NEW` | 5 | The run was written by a newer Asterweave |
| `RUN_GRAPH_UNKNOWN` | 1 | This build does not provide the run's graph in the same form |
| `APPROVAL_*` | 1 | See `run approve` above; `APPROVAL_SUBJECT_MISMATCH` is a usage error (2) |
| `POLICY_INVALID`, `HOOKS_INVALID` | 5 | A bad `policy.json` or hooks configuration; see [Policy and guards](/cli/policy-and-guards) and [Hooks](/cli/hooks) |
| `SCRIPT_INVALID`, `SCRIPT_UNREADABLE` | 2 | The fake executor script is not valid, is larger than 2 MB (checked in bytes before it is read), or is not a readable regular file (a FIFO or a device is refused) |
| `REPO_WORKTREE_MISMATCH` | 1 | `core.worktree` makes git report a work tree that is not the repository's own |
| `UNDISPLAYABLE_TARGET` | 1 / 7 | An approval whose scope cannot be shown faithfully: refused at request time (the run stops policy-denied, exit 7) or at grant time (exit 1) |
| `RUN_EXISTS`, `ABORT_DECLINED` | 1 | A run id that already exists; `run abort` answered No |

All exit codes: [Exit codes and doctor](/cli/exit-codes).

## Related

- [Policy and guards](/cli/policy-and-guards): what the guard allows, asks about and denies
- [Hooks](/cli/hooks): user and repository hooks around a run
- [Configuration and trust](/cli/config-and-trust)
- [CLI overview](/cli/overview)
