---
sidebar_position: 10
title: The Claude runner
description: "asterweave run start and run resume with the Claude runner (Phase D-b): what runs, how it is guarded, the environment allow-list, failure classes and exit codes, sessions and worktrees, and what is still unverified."
---

# The Claude runner

`asterweave run start <goal>` drives the delivery or bugfix workflow with headless `claude` turns. This page says what runs, what guards it, and, just as important, what does **not** guard it. Read [Policy and guards](/cli/policy-and-guards) and [Runs](/cli/runs) first.

```text
asterweave run start <goal> [--workflow delivery|bugfix] [--session <id>] [--worktree <name>] [--runner claude] [--json]
asterweave run resume <runId> [--json]
```

:::warning Unverified against a live claude
Nothing in this repository has ever run against a real `claude`. The tests use a scriptable stand-in (`tests/fixtures/fake-claude.mjs`). The flag names, the stream-json event shapes, the settings/hook schema, the wording of failures and the minimum version are all **guesses written from a specification**. See [Unverified](#unverified) for the list. Try it on a disposable repository first.
:::

## What runs

For every node of the workflow the loop asks the `ClaudeExecutor` for one action. The executor:

1. builds a small prompt (node, attempt, goal, objective, required evidence kinds, the last feedback) and sends it on **stdin** (never on the command line);
2. starts `claude -p --output-format stream-json --verbose --permission-mode default` with `--allowedTools <node-scoped list>` and `--settings <generated file>`, `--model` / `--effort` from the pinned [model route](/cli/tools-usage-routing), and `--session-id` (first turn) or `--resume <provider session>` (later turns);
3. parses the stream tolerantly, takes the **trailing group of fenced `json` blocks** of the final reply, and hands the first one to the loop as the action (the rest are queued for the same node attempt). Evidence blocks record evidence, a `complete` block ends the node.

A reply without a valid final block is a malformed output: the loop asks again with the validation errors as feedback, twice, then the attempt fails (`executor:malformed-output`) and the graph's retry rules apply.

The loop still validates every action, runs the guard and the hooks, and writes the ledger. The measured token counters of each turn become `usage` events (an unknown counter stays unknown, never 0), every tool call claude reports becomes a `tool.observed` event and counts toward the `toolCalls` budget, and `provider.session`, `runner.turn` and `route.fallback` events are recorded.

## How it is guarded, and the honest limit

| Layer | What it does |
| --- | --- |
| Repository trust | `run start` and `run resume` need a trusted repository (exit 4 otherwise), like other executable repository config. |
| `--allowedTools` | A node-scoped request list (read-only nodes get read tools; `implement` adds edit tools; test nodes add test commands). |
| `PreToolUse` hook | The generated settings file (`<run dir>/claude/settings.json`, mode 0600) registers `asterweave hook pre-tool-use` for every tool. It runs the [guard](/cli/policy-and-guards) in supervised mode and answers deny or ask. |
| Loop checks | Action schema, guard, hooks, evidence rules, budgets, approvals, the run lock. |
| Process control | A deadline per turn, an output cap, a tree kill on abort, and no orphan processes. |

**The limit: claude executes its own tools.** The loop never dispatches them, so the guard cannot stop a tool call except through the `PreToolUse` hook, and **the hook is the only gate that runs before one of claude's tools**. `--allowedTools` and the other flags are requests to a program whose behaviour is unverified here, and the guard itself is a heuristic, not a sandbox. If the hook is not honoured (a schema mismatch, a shell quoting problem, a timeout that fails open), nothing else stands between claude and your files. There is no OS sandbox. Use a disposable clone or a worktree (`--worktree`) and keep secrets out of reach.

**Evidence from claude is a claim, not proof.** The graph requires the evidence kinds, and a failing result blocks a pass, but nothing here verifies that a test really ran or passed. Review the result yourself.

**Nothing claude writes can approve anything.** The action schema has no way to grant an approval. A `request-approval` action only creates a pending request; a person answers it at a terminal (`run approve`, see [Runs](/cli/runs)). The one-time nonce of a request is shown only on the supervisor's own stderr when that is a terminal, never written to the ledger, the run directory, the child's environment or JSON output. This is defence in depth, not a sandbox: a process that can reach your console could read it.

`tool` actions in a reply are not accepted (claude runs its own tools), and every block of the final group must be an `evidence`, `complete`, `request-approval` or `wait` action: one forged or unknown block rejects the whole reply as malformed output and nothing from it is used.

The nonce rules, exactly: a supervisor with a terminal on stderr prints a one-time nonce for each new request and stores only its hash; a **headless** supervisor prints none and stores none, so flags are exit 2 (`APPROVAL_TERMINAL_REQUIRED`) and only the terminal prompt can approve. A supervisor on a terminal that **resumes** a run issues a fresh nonce for the requests it has not announced, which **invalidates any earlier nonce** of those requests. A request created by an older build (no nonce field) never gets a nonce.

## Environment of the claude process

The child gets an allow-list, not your environment: `PATH`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `windir`, `TEMP`, `TMP`, `TMPDIR`, `LANG`, `LC_*`, `TERM`, `NO_COLOR`, proxy variables, `PATHEXT`, `ComSpec`, `HOMEDRIVE`, `HOMEPATH`, `ANTHROPIC_*` and `CLAUDE_*`. AWS or Google variables are passed only when `CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` selects that provider. `GITHUB_TOKEN`, `GH_TOKEN`, `NPM_TOKEN`, `SSH_AUTH_SOCK` and every `ASTERWEAVE_*` value are dropped, except the three correlation variables `ASTERWEAVE_RUN_ID`, `ASTERWEAVE_SESSION_ID` and `ASTERWEAVE_CONFIG_DIR`, which the hook needs. Provider login lives in claude's own store; Asterweave stores no provider credential. Because `ASTERWEAVE_RUN_ID` is set, `run approve` and `mcp test --approve` refuse to run inside that process.

## Failures and exit codes

A turn that fails is classified from its exit code and bounded, redacted stderr/result text (wording heuristics, unverified):

| Class | What happens |
| --- | --- |
| `rate-limit`, `overloaded`, `5xx`, `timeout` | Retryable. The route advances to the next `model.fallback` entry (`route.fallback` event, fresh provider session) and the turn is retried. No fallback left: the node is blocked. |
| `auth`, `not-installed`, `version-unsupported`, `invalid-request`, `offline`, `policy`, `unknown` | Never fall back. The node is blocked with signature `runner:<class>` and a remediation; exit 1. |
| `output-limit`, `crashed` | The child is stopped or died. The node is blocked with signature `runner:<class>`; exit 1. |
| `killed` | You interrupted the run (Ctrl+C, SIGTERM): the whole claude process tree is killed, the run is **paused**, exit 130. |

A blocked run is resumable: fix the cause (log in with claude itself, update claude, raise a budget) and run `asterweave run resume <runId>`. Other exit codes: 6 waiting for an approval, 7 policy denied, 4 untrusted repository, 5 invalid configuration, 2 usage. A missing or too-old claude is reported **before** a run is created (exit 1). The minimum version, 2.1.0, is a conservative guess; `asterweave doctor` shows a `claude.runner` check (a WARN when claude is missing or old, never a FAIL).

Budgets apply as in [Runs](/cli/runs): tool calls reported by claude and measured tokens count, and an exhausted budget blocks the node with `budget:<name>`.

## Sessions and worktrees

- `--session <id>` links the run to an existing active session: the session records the run, the node, a checkpoint when the command returns, and the provider session id. If the session has a worktree, claude works there.
- `--worktree <name>` creates an isolated git worktree and a session for it, then works inside it (see [Sessions](/cli/sessions)). It cannot be combined with `--session`.
- `run resume <runId>` continues the provider session recorded in the run ledger.

## Residual risks

- Tool calls beyond the stream parser's caps (1000 tool events per turn, 5000 events) are not counted against the tool-call budget; the dropped count is recorded on the `runner.turn` event only.
- `doctor` and the runner probe `claude --version` with different environments (full versus allow-listed), so they can disagree on an unusual machine.

- **Budgets are enforced between turns.** One claude turn can overshoot a token or tool-call budget before the loop sees the numbers. If the supervisor crashes in the middle of a turn, `run resume` runs that turn again, and its tools run again.
- **The hook is best effort until checked live.** If the hook times out, crashes or is not honoured, a tool may run anyway (what claude does is unverified). Inside a run the hook answers deny instead of ask for anything that needs approval, because a headless claude cannot answer a prompt.
- **Project settings are still loaded.** `.claude/settings.json` and `.claude/settings.local.json` of the repository (and your user settings) are still read by claude; their precedence over the generated settings file is unverified. That is why the repository must be trusted first, and why a worktree's own governing files are not re-checked after it is created.
- **POSIX:** a descendant that starts its own session or process group escapes the group kill on abort or deadline.
- **Windows:** the tree kill uses `taskkill /T`, which cannot find the descendants of a process that already exited; they are not reaped.
- **Evidence is a claim.** See above; nothing proves a test really passed.

## Unverified

- The `claude` flags used (`-p`, `--output-format stream-json`, `--verbose`, `--session-id`, `--resume`, `--fork-session`, `--model`, `--effort`, `--permission-mode`, `--allowedTools`, `--settings`, `--mcp-config`, `--strict-mcp-config`, `--append-system-prompt`).
- The stream-json event shapes (`system/init`, assistant `tool_use` blocks, `tool_result`, `result` with `usage` and `total_cost_usd`, rate-limit events).
- The settings and hook schema, whether claude honours the hook, what it does when the hook times out, and which shell runs the hook command on Windows.
- The wording of rate-limit, auth, overload and network failures, and the format of `claude --version`.
- Whether a provider session can be resumed or forked as assumed, and that a different model starts a fresh session.
- The minimum version 2.1.0.
- On Windows, a grandchild process that outlives a claude that exited by itself cannot be found and killed (a documented limit); an abort or a deadline kills the whole tree.
