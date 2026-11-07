---
sidebar_position: 7
title: Hooks
description: "Asterweave CLI hooks: the events, the entry schema, user hooks versus trusted repository hooks, ordering, timeouts, failure policy, the stdin payload and the security model."
---

# Hooks

A **hook** is a program you register to be run around the steps of a [run](/cli/runs): to veto a tool call, to log what happened, or to notify something. Hooks never replace the [guard](/cli/policy-and-guards); they sit next to it and can only make it **stricter**.

:::note Phase B is simulated
Hooks run for real (they are real processes), but the runs they observe use a fake executor and a simulated tool dispatcher. No model is called and no tool is executed by a run.
:::

## Events

| Event | When | Blocking? | Payload fields (besides `v`, `event`, `runId`, `seq`) |
| --- | --- | --- | --- |
| `run.started` | The loop starts or resumes | no | `status`, `node` |
| `node.before-enter` | Before a node is entered | **yes** | `node`, `attempt` |
| `tool.before` | After the guard looked at a tool action, before it is dispatched | **yes** | `node`, `step`, `tool`, `input` |
| `tool.after` | After a tool action completed | no | `node`, `step`, `tool`, `ok` |
| `node.completed` | A node finished | no | `node`, `outcome`, `next` |
| `approval.requested` | An approval was requested | no | `approvalId`, `kind`, `scope` |
| `run.finished` | The loop stopped (completed, waiting, blocked, paused) | no | `status` |

## Entry schema

A hook entry is an object with exactly these properties (anything else is rejected):

| Property | Rules |
| --- | --- |
| `id` | Required. 1 to 64 characters: letters, digits, `.`, `_`, `-`; starts with a letter or digit |
| `event` | Required. One of the events above |
| `argv` | Required. The command and its arguments as an array of 1 to 64 strings (each at most 4096 characters, no NUL, the first one non-empty). **No shell**: nothing is interpreted, expanded or piped |
| `kind` | Required. `validate` (can veto; only on the blocking events `node.before-enter` and `tool.before`) or `log` (observe only, on any event) |
| `timeoutMs` | Optional integer from 1 to 30000. Default 10000. The process is killed when the time is up |
| `onFailure` | Optional `block` or `ignore`. Default `block` for `validate`, `ignore` for `log` |

`argv[0]` must not be blank (empty or whitespace only is rejected, like the plugin scaffold does) and must be a bare command name (resolved on `PATH`; a Windows `.cmd` shim is not accepted, only a real executable) or an absolute path. A relative path such as `./check.sh` is refused.

```json
{ "id": "no-prod", "event": "tool.before", "argv": ["node", "/home/me/hooks/no-prod.mjs"], "kind": "validate", "timeoutMs": 5000, "onFailure": "block" }
```

## Where hooks come from

| Source | Location | Loaded when |
| --- | --- | --- |
| User hooks | `<userDir>/hooks.json`: `{"v":1,"hooks":[ ...entries ]}` | Always |
| Repository hooks | The `hooks` array in `.claude/asterweave.json` | Only if the repository is **trusted** |

Repository hooks are **executable repository config**. They count as findings in [`trust`](/cli/config-and-trust#what-counts-as-executable) (one per entry, shown as `hook` with the field name `hooks[0].argv`, never the command text), they make `config show --strict` exit 4 while the repository is untrusted, and `doctor` lists them. For an untrusted repository they are **never loaded**; the loader reports them as skipped (`UNTRUSTED`). Editing `.claude/asterweave.json` makes the repository untrusted again until you re-grant it. Repository hooks are read from the very bytes the trust hash covers, so what you reviewed is what runs.

An invalid user `hooks.json` or an invalid `hooks` key in a **trusted** repository is `HOOKS_INVALID` (exit 5) and the run does not start. An invalid `hooks` key in the repository adapter is also a configuration error for `config show`.

### Ordering and duplicates

Hooks run **one at a time, in load order**: user hooks first, then repository hooks, each in array order. An entry is identified by `id` plus `event`; when the same pair appears twice, the **first one wins**, so a repository can never replace a user hook. Duplicates inside one file are an error.

## What a hook sees

The process runs with the working directory of the repository, with **no shell** and a **minimal environment**: only what is needed to start a program (`PATH`, `PATHEXT`, `SystemRoot`, `ComSpec`, `TEMP`/`TMP`/`TMPDIR`, `HOME`/`USERPROFILE`, `LANG`, `LC_ALL`) plus `ASTERWEAVE_HOOK_EVENT`, `ASTERWEAVE_HOOK_ID` and `ASTERWEAVE_RUN_ID`. Tokens and other variables are not passed on.

It receives one JSON object on **stdin**:

```json
{"v":1,"event":"tool.before","runId":"demo-1","seq":17,"node":"implement","step":2,"tool":"shell","input":{"command":"git status"}}
```

The payload is redacted before it is written (token-shaped strings are collapsed, values under secret-like key names such as `token` or `password` become `[redacted]`) and is capped at 256 KiB; a larger one is replaced by `{"v":1,"event":...,"truncated":true}`. Output from the hook is capped at 64 KiB, redacted, and recorded in a `hook.result` event.

## Results and failure policy

For a `validate` hook on a blocking event:

| What the hook does | Result |
| --- | --- |
| Exit 0 with no output, or `{"decision":"allow"}` | Passes. `allow` never loosens anything |
| Exit 0 with `{"decision":"deny","reason":"..."}` | The action is denied: `HOOK_BLOCKED` |
| Exit 0 with `{"decision":"require-approval","reason":"..."}` (or `ask`) | The action needs a scoped approval, like any guard question |
| Exit 2 | An explicit veto: `HOOK_BLOCKED` (deny), whatever `onFailure` says |
| Any other exit code, a signal, a timeout, a missing program, an unreadable verdict | A **failure**: with `onFailure: "block"` the action is denied (`HOOK_FAILED`); with `ignore` it has no effect |

`log` hooks never change a decision, and their failures are only recorded.

`node.before-enter` hooks run for **every** node, including approval nodes. A `require-approval` verdict from a hook holds the run like any other guard question: the pending approval has scope operation `hook:<id>` (the hook's id), the run saves it and stops with exit 6, and it continues only after a person approves that scope with `run approve`. A `deny` verdict blocks.

A `validate` hook can only **tighten**: the final decision is the strictest of the guard's and every hook's (`allow` below `require-approval` below `deny`). A hook that answers `allow` after the guard said `require-approval` changes nothing, and once the decision is already a deny the remaining validate hooks are skipped. If the hooks cannot be run at all for a blocking event, the action is refused (`HOOK_FAILED`).

## Security notes

- A hook is code that runs as you. Read a repository's hooks before you trust it; trust is bound to the contents of the adapter file.
- **Repository hooks go through the guard.** Before a repository hook runs, its command line is evaluated as a shell action by the same guard as any tool call; a hook command the guard refuses does not run and counts as a failure. The command line is built with POSIX quoting and always read as a POSIX shell command, whatever the platform; a hook whose argv runs inline interpreter code (`node -e`...) or writes to protected paths is refused. User hooks are your own and are not re-checked. A repository hook only runs if its argv is an understood form or matches your `allowCommands` prefix, and the [option rule](/cli/policy-and-guards#allowcommands-the-user-owned-list) applies: a hook argv with an option (`["node","check.mjs","--strict"]`) matches `["node","check.mjs"]` only if the option is part of the listed prefix, so list the full argv prefix. These are Asterweave run hooks; they are not git hooks. The files that configure **git** hooks (`.husky/`, `.githooks/`, `lefthook*.yml`, `.pre-commit-config.yaml`, `.gitattributes`, the `core.hooksPath` directory) are protected paths the guard will not let a run write, but `package.json` hook configuration (`lint-staged`, `simple-git-hooks`) is not, and `--no-verify` is not a protection: a real dispatcher must run git with `core.hooksPath` pointed at an empty directory (see [Limits](/cli/policy-and-guards#limits)).
- The guard behind this is a heuristic, not a sandbox: see [Policy and guards](/cli/policy-and-guards#limits). The separate `asterweave hook pre-tool-use` command is a Claude Code PreToolUse hook, not one of these run hooks; it never emits an `allow` document (the `--emit-allow` flag was removed), and if you wire it into Claude Code you should set a `timeout` on it (what Claude Code does on a timeout is unverified).
- **Git hooks of the repository still run** when an allowed `git commit` or `git push` executes in a repository that configures husky, lefthook, pre-commit and the like (the guard protects the hook files and the `core.hooksPath` directory from writes, but `package.json` scripts and `lint-staged` / `simple-git-hooks` configuration there are not protected). A real dispatcher MUST run git with `-c core.hooksPath=<an empty directory>` and a hardened environment; see [Policy and guards](/cli/policy-and-guards#protected-paths-and-hook-mechanisms). A push is understood only to a remote configured in the workspace repository, because git reads any other word as a local path and runs the hooks of the repository there.
- **Hooks cannot approve.** They cannot raise a decision, answer an approval, or write the ledger; their output is only ever read as a verdict and recorded.
- The payload and the recorded results are redacted, but a hook that receives `input` sees the command text of the action. Do not send it anywhere you would not send the command.
- There is no environment switch to disable hooks or the guard.

## Related

- [Runs](/cli/runs)
- [Policy and guards](/cli/policy-and-guards)
- [Configuration and trust](/cli/config-and-trust)
- The `hooks` key of the repository adapter is described in the plugin's repository adapter reference.
