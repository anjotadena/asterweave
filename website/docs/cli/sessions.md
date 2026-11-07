---
sidebar_position: 9
title: Sessions and worktrees
description: "Asterweave CLI Phase D-a: durable sessions (start, list, search, resume, fork, archive, clean, transcript), schema migration and recovery, and isolated git worktrees. No runner yet: nothing here calls a model."
---

# Sessions and worktrees

A **session** is the durable record that ties together a repository, a branch or worktree, a run, checkpoints, approval references and measured usage, so work can be found and resumed later. Phase D-a adds the store and the commands. **There is no runner yet**: a session does not start a model, and `session resume` only checks that everything it needs is still there and prints the next command. The runner arrives in Phase D-b.

## Commands

| Command | What it does |
| --- | --- |
| `asterweave session start [--title t] [--worktree name] [--run [id]] [--json]` | Records a session for this repository. `--worktree` first creates an isolated git worktree. `--run` links the newest run (or a given run id). |
| `session list [--all] [--json]` | Active sessions of this repository (`--all` includes archived). |
| `session show <id>` / `session search <text>` | One session, or a literal case-insensitive search over title, branch, goal, run id and id. Ids may be given as a unique prefix of at least 6 characters. |
| `session resume <id> [--json]` | Checks the archive flag, workspace, repository identity, branch or worktree and the linked run, and reports `needsReconcile` when the linked run's ledger has events the snapshot does not, has a torn tail, or the run is still `active` (interrupted mid-step; the runner reconciles before continuing). `plan.cwd` is the directory to work in: the worktree path when the session has one, else the workspace. Starts nothing and writes nothing. |
| `session fork <id> [--title t]` | A new session whose parent is `<id>`, with checkpoints up to the last verified one. The provider session id, run, node and worktree are **not** copied, and when the parent has a worktree the branch is not inherited either (it is checked out in that worktree, so the fork could never sit on it); the parent's branch is kept in the fork's `created` event as `forkedFromBranch`. |
| `session archive <id>` | Marks a session archived. Archived sessions are not resumable; fork them instead. |
| `session clean [--older-than days] [--yes]` | Preview by default. Deletion needs `--yes` (exit 2 without it on a non-terminal) or a y/N on a terminal. It deletes only archived session directories listed in the preview, never workspaces, worktrees or runs, and skips a session whose worktree is dirty or unknown. |
| `session transcript <id>` | A bounded, sanitized summary of the linked run's ledger events. No raw tool output. |

## Storage and recovery

Sessions live in `<userDir>/sessions/<repo>/<s_id>/` as `session.json` plus an append-only `events.jsonl`. Events are written first and the snapshot second, so a crash between the two is repaired on the next load. A torn log tail is ignored and cut off before the next append. `list`, `show`, `search`, `resume` and `transcript` are strictly read-only: they never migrate, quarantine or repair, and show an old or damaged record as it would be repaired. The commands that write (`start`, `fork`, `archive`, `clean`) repair what they touch. A record written by an older version (v1) is migrated by the next write command after a one-time `session.json.bak-v1` copy; one written by a newer version is refused read-only ("written by a newer asterweave"). A corrupt snapshot is renamed to `session.json.corrupt-<time>` and rebuilt from the log; with no log it is reported and left alone. `session.json` and `events.jsonl` over 8 MiB are never read (a large snapshot is rebuilt from the log in memory; a large log is reported as a problem). Concurrent writers take a per-session lock with stale takeover; the lock is not heartbeated because every critical section is a few short synchronous writes, so it counts as stale only after 5 minutes or when its owner process is dead.

## Worktrees

`session start --worktree <name>` creates `<userDir>/worktrees/<repo>/<name>` on a new branch `asterweave/<name>` from the current commit, so the repository itself never shows changes and no `.gitignore` edit is needed. Names must match `^[a-z0-9][a-z0-9._-]{0,63}$`. Creation and inspection run git without hooks and refuse when a repository-local `filter.*` driver exists, because a plain `git status` would run it; the dirty state is then reported as `unknown`. Removal (module API, no command yet) never forces: it refuses a dirty or unknown, locked, main, missing, not Asterweave-created or unpushed worktree, and never deletes a branch.

## What is not verified

- No runner and no model call. `providerSessionId` stays empty until D-b.
- Claude Code's own `-w/--worktree` flag exists, but where it places worktrees was not verified, so the location above is Asterweave's own choice.
- Windows 8.3 short paths, two-clone identity checks and the POSIX file modes of the stores were only partly exercised.
