---
sidebar_position: 12
title: HRIS-014 fixture demo
description: "A self-contained, zero-dependency demo of the Asterweave CLI on one fictional task (HRIS-014): sign-in to a closable pull request, plus the failure paths. Everything is a fixture: no live model, no live GitHub, no live MCP server."
---

# HRIS-014 fixture demo

`npm run demo:hris-014` drives the **real** Asterweave command handlers through one fictional task, **HRIS-014: accrue leave balance monthly** in a fixture repository (`unexaro/hris`), from sign-in to a pull request that becomes *closable*, and then walks the failure paths.

:::caution Everything is a fixture
This demo calls **no live model, no live GitHub and no live MCP server**. The runner talks to a scripted stand-in for `claude` (`packages/cli/tests/fixtures/fake-claude.mjs`), GitHub is an in-process fake `fetch` (`tests/fixtures/fake-github.mjs`) and the MCP server is `tests/fixtures/mcp-server.mjs`. Passing the demo says the commands, state machines and safety rules behave as designed against those fixtures. It says nothing about how a real model, GitHub or MCP server behaves. See [Fixture versus live coverage](#fixture-versus-live-coverage).
:::

## Run it

You need Node.js 22 or newer and a `git` on the `PATH`. Nothing else: no install step, no network, no account, no token.

1. Clone the repository and open a terminal in its root.
2. Run:

   ```bash
   npm run demo:hris-014
   ```

   or, without npm:

   ```bash
   node packages/cli/scripts/demo-hris-014.mjs
   ```

3. Read the output. Each step prints `PASS` or `FAIL`, the fixture it used and one line of evidence. The run ends with the coverage table and a summary such as `22 passed, 0 failed, 8.1 s`.
4. Check the exit code: `0` only when every step passed within 60 seconds, non-zero otherwise (`echo $?` on bash, `$LASTEXITCODE` in PowerShell).

The demo takes about 10 seconds. The same script is run by the test suite (`packages/cli/tests/demo-hris-014.test.mjs`, part of `npm run test:cli`).

### Isolation

- Every directory is a fresh temporary directory under the system temp location, removed at the end. `ASTERWEAVE_CONFIG_DIR` (and `HOME`/`USERPROFILE`) always point inside it: **your real Asterweave user directory, credentials, trust list and repositories are never read or written.** The test sets `ASTERWEAVE_CONFIG_DIR` to a sentinel directory and fails if the script touches it.
- The GitHub token is a made-up value built at run time and is injected in-process; a step checks it never appears in a request URL or in any output.
- The fixture repository is created with `git init`; its remote is a URL string only and is never contacted.

## What the demo does

| Step | What it shows | How it is exercised |
| --- | --- | --- |
| 01 | Auth validated | `auth status --json` against fake `gh` and `claude` child processes (account masked) |
| 02 | Repository connected | `repo connect --repo unexaro/hris --branch main` on the fixture repository |
| 03 | Fixture MCP server configured, validated, tested | `mcp list` and `mcp validate` only parse; `mcp test` starts `tests/fixtures/mcp-server.mjs`, lists its tools (never calls one) after an approval typed on a fake terminal |
| 04 | Model route shown | `model show` and `model explain plan` from a temporary `config.json` |
| 05 | Session started | `session start --worktree hris-014`: a session and a real isolated `git worktree` |
| 06 | Run to the plan approval | `run start` drives four fake-claude turns (intake, analyze, challenge, plan) and stops at the approval: exit `6` |
| 07 | Non-TTY mode | `run approve` without a terminal is exit `2` (also with forged flags and no nonce); `mcp test` without a terminal is exit `6` and spawns nothing |
| 08 | Approval by the person | The library call `run approve` makes after its y/N prompt, with the `tty` source (the stand-in for the human) |
| 09 | Interrupt and resume | A hung turn holds the run lock: a second `run resume` is `RUN_LOCKED`; abort pauses the run (exit `130`); after `run resume` the approval, the graph state, an uncommitted file in the worktree and the task id are unchanged and no node is repeated |
| 10 | Pull request created (simulated) | The fake GitHub holds an open PR #14; `pipeline status --refresh` says `waiting`, not closable |
| 11 | Merge simulated, workflow failure | The PR merges; `ci.yml` fails on the merge commit while `pipeline watch --run hris-014` polls: verdict `failed`, exit `1`, verdict appended to the run ledger |
| 12 | Explicit diagnosis | `pipeline diagnose`: failing job and step names, acceptance criteria and changed files; printed only, sent nowhere |
| 13 | Duplicate and delayed events | An identical report is counted as a duplicate; a stale `in_progress` report after the failure is counted as out of order; the verdict does not change |
| 14 | Rerun, closable only at the end | `ci.yml` attempt 2 supersedes attempt 1; with `ci.yml` and `lint.yml` passed but the `e2e` check still running the verdict is `waiting`; when `e2e` passes during `watch` it becomes `closable` (exit `0`). The step asserts the task was *not* closable at every earlier point |
| 15 | Zero model calls while monitoring | The fake-claude invocation counter file is unchanged across all `pipeline` commands, and a spawn spy saw only `git` |
| 16 | Offline runner | `claude` not installed: `RUNNER_NOT_INSTALLED`, exit `1`, nothing created |
| 17 | Invalid MCP configuration | `mcp validate` on a broken `.mcp.json`: exit `5`, every problem named |
| 18 | Provider throttling | A rate-limit failure falls back to the next model and records `route.fallback` |
| 19 | Budget exhaustion | A token budget is exhausted: run blocked, checkpoint left in the session |
| 20 | Safe cancellation | Abort pauses the run (exit `130`) and the child process tree, including a grandchild, is gone |
| 21 | Denied tool request | The real `hook pre-tool-use` denies a destructive git command, asks for a push to the default branch, and stays silent for an ordinary one |
| 22 | Hook timeout | A validate hook that sleeps past its timeout is killed and the action is denied (`HOOK_FAILED`) |

The required checks of the pipeline steps come from two sources, to show the union: `ci.yml` and `lint.yml` from a temporary `pipeline.json`, and `e2e` from the repository adapter (`completion.requiredChecks`), which is honoured because the fixture repository is trusted.

## Fixture versus live coverage

| Path | What the demo uses | Verified live? |
| --- | --- | --- |
| Model calls (the runner) | `tests/fixtures/fake-claude.mjs`, a scripted child process | **No** |
| Model provider sign-in | A fake `claude auth status` child process | **No** |
| GitHub sign-in | A fake `gh auth status` child process; the token is injected in-process | **No** |
| GitHub REST (pull request, runs, jobs, check runs) | `tests/fixtures/fake-github.mjs`, an in-process `fetch` | **No** |
| PR creation and merge | Simulated by editing the fake GitHub world; Asterweave does not create or merge pull requests here | **No** |
| MCP server | `tests/fixtures/mcp-server.mjs`, a real child process; tools are listed, never called | **No** |
| Hooks, guard, approvals, worktrees, ledger, locks | The real code, on temporary directories | Real code, fixture inputs |
| Rate-limit fallback / budgets / cancellation | The real code, driven by fake-claude failure text | Provider messages **not** verified live |

Nothing in this demo was checked against a live service. The message formats, stream shapes and REST shapes the fixtures imitate were written from memory of the real ones. The unverified assumptions are listed on the pages of the features: [The Claude runner](/cli/runner), [Tools, usage and routing](/cli/tools-usage-routing) and [Pull request and pipeline monitoring](/cli/pipeline#unverified-assumptions).

## Limits of the demo

- The fake claude never edits files. The "worktree change" in step 09 is a file the script writes into the worktree to prove that uncommitted work is untouched by an interrupt and a resume.
- Step 08 uses the library call instead of typing `y` at the `run approve` prompt, because the demo has no human. The terminal prompt path is covered by the test suite.
- Step 22 calls the hook runner directly with a hook process written for the demo (see [Hooks](/cli/hooks)); it does not show hooks firing inside a run.
- The timings are those of a local machine with local child processes. The 60 second limit is a smoke bound, not a performance claim.
