---
sidebar_position: 11
title: Pull request and pipeline monitoring
description: "Asterweave CLI Phase E: poll a pull request and its workflow runs, decide when a task is closable, and produce an explicit diagnosis packet. Polling only, read-only, zero model calls. Everything is fixture-verified; live GitHub is unverified."
---

# Pull request and pipeline monitoring

`asterweave pipeline` watches a pull request and the checks that run after it merges, and answers one question: **is this task closable?** It is polling only (no webhooks, no server), read-only (GitHub `GET` requests only) and makes **no model calls**: nothing under `src/runtime/pipeline/` or in the command imports the Claude runner, and a test fails if that changes.

:::caution Unverified against live GitHub
Every path described here was verified against an in-process fake of the GitHub REST API (`packages/cli/tests/fixtures/fake-github.mjs`), never against github.com or a GitHub Enterprise server. The response shapes are written from memory of the REST API. See [Unverified assumptions](#unverified-assumptions).
:::

## Commands

```text
asterweave pipeline status   <pr> [--repo owner/name] [--refresh] [--json]
asterweave pipeline watch    <pr> [--repo owner/name] [--timeout 30m] [--interval 15s] [--run <runId>] [--json]
asterweave pipeline diagnose <pr> [--repo owner/name] [--check <key>] [--json]
```

The repository defaults to the GitHub `origin` remote of the current directory; `--repo` (validated as `owner/name`) overrides it. The local clone is used (for the repository adapter) only when its origin really is that repository. Unknown flags for a subcommand exit 2.

| Command | What it does | Exit codes |
| --- | --- | --- |
| `status` | Prints the recorded state and verdict. Offline unless `--refresh`, which does exactly one poll first. | `0`; `1` nothing recorded (`PIPELINE_NOT_FOUND`), or a `--refresh` whose poll failed or was rate-limited (JSON `ok: false`, `refresh` and `poll.status` say why; the state shown is the last one read); `3` sign-in; `5` bad configuration |
| `watch` | Polls until a terminal verdict, `--timeout` (default 30 minutes, at most 24 hours), the attempt cap (1000), or a rate limit that outlasts the timeout. | `0` closable; `1` every other verdict, a timeout or a rate limit (machine-readable `verdict`); `130` Ctrl-C (the state stays resumable) |
| `diagnose` | An explicit, read-only diagnosis packet for the failing checks. GitHub failures are mapped like `watch`: sign-in `3` (`PIPELINE_AUTH`), pull request not found `1` (`PIPELINE_PR_NOT_FOUND`), anything else `1` with a fixed `PIPELINE_GITHUB_ERROR` (a response body is never echoed), interrupted `130`. | `0`; `1`/`3`/`130` as above |

`watch` holds a per-pull-request lock: a second `watch` (or `status --refresh`) of the same pull request fails with `PIPELINE_LOCKED` while the first runs. Plain `status` never needs the lock.

## Two state machines

**Pull request state**: `open`, `closed-unmerged`, `merged`. `merged` is sticky: a later report of `open` never un-merges it. For a merged pull request the state records `mergedAt`, `mergeCommitSha` and the base branch.

**Check state**, per required key (a workflow file path or a check name): `waiting`, `running`, `passed`, `failed`, `cancelled`, `skipped`, `neutral`, `run-not-detected`, `missing-configuration`.

Only runs whose `head_sha` equals the **resulting target-branch commit** count toward the closable verdict. This build uses the pull request's `merge_commit_sha`. Runs on the pull request head sha are tracked separately as the `preMerge` stage and never count for post-merge verification.

**Only one workflow event counts for the merge commit: `push` by default.** A run of the same workflow on the same commit triggered by anything else (`issue_comment`, `schedule`, `workflow_dispatch`, `pull_request`, ...) is counted as foreign and ignored, so it can neither mask a failed push run nor be the only success. The policy `trigger` (`push`, `pull_request`, `workflow_run` or `merge_group`) changes that event; `pull_request` is an explicit opt-in. The filter applies even when the merge commit equals the pull request head sha. A check run that belongs to the check suite of a run with another event is refused the same way.

### Identities

- A **workflow run** is identified by (workflow, event). Within one identity a higher `run_attempt` (or a newer run) supersedes; a run of another event is a different identity, and different identities are combined **worst-of**.
- A **check run** is identified by (GitHub App, check suite, name). All GitHub Actions jobs share one app, so the **check suite** is what keeps two workflows apart: a later check run supersedes an earlier one only inside the same app **and** suite, so a passing `build` from another suite (for example a job added by the pull request in another workflow) can never clear a failing `build`; distinct suites are combined worst-of. With neither app nor suite information a check run stands alone and is never superseded.
- **Workflow reruns**: when a check suite belongs to a known workflow run (the run's `check_suite_id`), check runs are grouped by (workflow, event, run id) when the verdict is computed, and the highest `run_attempt` of that group supersedes the older attempts' check runs. Nothing supersedes across workflows or across run ids. **Whether a rerun reuses the check suite or creates a new one is unverified**: if a rerun check run appears in a suite the monitor cannot attribute to the run, the old failure stays and the key is not closable (fail closed) until a new commit or a clean run settles it.
- **Which suite belongs to which event is judged when the verdict is computed**, from the current suite map, never once when a check run is first seen. A check run of a suite owned by a run of another event than the trigger is ignored. A check run whose suite no listed run owns counts only when the run listing of that commit was **complete** (then it is a non-workflow producer, such as a third-party CI app); when the listing was cut off (page cap) it does not count (`suite-event-unknown`, key `waiting`), and an incomplete listing of the target commit is never closable (blocker `required-checks-unavailable`, `listing-incomplete`). A later poll that reveals the owning run invalidates the earlier check runs.
- **Branch-protection app pins**: when branch protection names the app for a required check (`checks[].app_id`), the pin is recorded with the policy and only check runs from that app count for the key.

### How a required key matches

- A key that contains `/` or ends in `.yml` / `.yaml` names a **workflow file** and matches only a run of exactly that path. A bare file name such as `ci.yml` means `.github/workflows/ci.yml` (no basename or sub-directory match).
- Any other key is a **check name** and matches check runs by that name only. A workflow is **never** matched by its name (any workflow file can call itself `CI`): when only a workflow with that name ran, the key is `waiting` and, after the detection window, `ambiguous-key` (verdict `ambiguous-key`, exit 1) with a remediation to list the workflow file or the exact check name. It is never satisfied.

### How observations are folded

- **Dedupe**: an identical report (run id, attempt, status, conclusion, `updated_at`) is counted and ignored.
- **Out of order**: an older `updated_at`, a lower attempt, or a non-terminal report after a terminal one for the same attempt is counted and ignored. Terminal conclusions are sticky.
- **Rerun**: a higher `run_attempt` (or a newer run of the same workflow) supersedes the old attempt, which is kept in a short history. The latest valid attempt per workflow wins.
- **Disappearing runs** are not forgotten.
- **Other commits**: a sha that is neither the pull request head nor the merge commit is counted as foreign and ignored.
- `skipped` and `neutral` are **not success** unless the check is listed under `allowSkipped`; they are shown as what they are. `cancelled`, `timed_out`, `action_required` and any unknown conclusion are never success.
- **Run not detected**: when no run for a required key exists on the merge commit after the detection window (default 10 minutes after the merge, configurable), the key is `run-not-detected`. Before that it is `waiting`. Absence is never success.

## The closable verdict

`closable: true` only when the pull request is **merged** AND every required key (and every `deployment` key, when configured) has a **passed** latest attempt on the target commit (or an allowed `skipped`/`neutral`). Otherwise `closable: false` with `blockers[]`, each `{ key, state, reason }`.

| `verdict` | Meaning | `watch` stops |
| --- | --- | --- |
| `closable` | merged and everything passed | yes, exit 0 |
| `waiting` | not merged yet, or checks still queued, running or not yet detected | no |
| `failed` | a required check failed (fail-fast, even while others still run) | yes, exit 1 |
| `ambiguous-key` | a bare key matched only a workflow name; list the workflow file or the exact check name | yes, exit 1 |
| `cancelled` | a required check was cancelled | yes, exit 1 |
| `not-passed` | a required check was skipped or neutral and is not allowed | yes, exit 1 |
| `run-not-detected` | no run on the merge commit after the detection window | yes, exit 1 |
| `missing-configuration` | no required checks configured; the blocker carries a remediation | yes, exit 1 |
| `closed-unmerged` | the pull request was closed without merging | yes, exit 1 |

A stopped `watch` that did not reach a terminal verdict (`status` of `timeout`, `attempts`, `rate-limited` or `unavailable`) reports verdict `waiting` and exits 1.

### Dropped observations fail closed

The reducer keeps at most 500 slots for the merge commit and 250 for the pull request head (the head can never starve the merge commit), and a poll event larger than about 800 KB is trimmed (head observations first, oldest first). An observation that is not recorded could be the failing one, so any drop or trim is stored **per commit** in the poll event (`listing`: `complete` false, `dropped` n) and survives replay and checkpoints. While the merge commit has such a gap the verdict cannot be `closable`: it is `waiting` with the blocker `required-checks-unavailable` (`observations-dropped`, or `listing-incomplete` for a cut-off page listing). A later poll that lists the commit completely and records every observation clears the gap; if it records the failure, the verdict becomes `failed`. A commit with **no listing record at all** is treated as incomplete too (`listing-unknown`). In addition, the **identities** (workflow or check, per commit) that were dropped are remembered: they keep blocking until a later poll *records them again*. A complete poll in which GitHub simply no longer returns a dropped failure (for example because the run was deleted) does not heal them, because absence is not evidence. The memory is bounded (100 identities per commit; beyond that it cannot heal), so such a pull request cannot become closable from this monitor's state; start a fresh state (move the `pr-<n>` directory aside) after reviewing it.

Check runs are requested with `filter=all`: GitHub's default (`latest`) returns only the newest check run per name, which could hide a same-name failure before the reducer sees it. The exact semantics of `filter` (and whether it groups by app) are unverified; the reducer's (app, suite, name) identities decide what supersedes what.

### Merge commit equal to the pull request head

When the merge commit is the pull request head sha (a fast-forward style merge), pre-merge observations sit on the same commit. For the merge commit only workflow runs of the trigger event (`push` by default) count, whenever they were observed; a check run counts only when its check suite belongs to a listed run of that event, and a check run of an unlisted suite is **unknown** there (`suite-event-unknown`), not satisfied.

### Known limits and trust model

- **A bare, unpinned check-name key is the weakest option.** It matches check runs of that name from any producer, so when the real check never ran, a same-name check from another producer (an app, or a workflow added by the pull request) can satisfy it. Prefer a **workflow path** key (`.github/workflows/ci.yml`), or pin the check to its app: branch protection's `app_id`, or `pins` in `pipeline.json` (`"pins": [{ "key": "build", "appId": 15368 }]`). Path keys and pins are what close this gap; the monitor cannot know which producer is the legitimate one.
- **Availability limit.** At most 150 check runs of the merge commit are read per poll (three pages of 50), reruns included with `filter=all`. A merge commit with more than that can never become closable (the listing is reported incomplete). The slot tables are also bounded (500 for the merge commit, 250 for the head).
- Deleting a workflow run needs write access to Actions. What a deleted run does to `filter=all` listings is **unverified**; a failure that disappears from GitHub is not treated as healed (see above), but a failure that was never observed cannot be.
- Everything above was verified against the fake only.

### Required-check sources fail closed

Only a plain `403`/`404` from branch protection means "no protection to read" and lets that source be empty. Any other problem reading it (5xx, network, an exhausted rate limit) or an unknown base branch (the pull request could not be read while preparing) means the set of required checks may be **incomplete**: the last recorded union is kept (a smaller set is never recorded over it), the verdict cannot be `closable`, and a blocker `{ key: "*", state: "waiting", reason: "required-checks-unavailable" }` is added; `watch` stops with `status: "unavailable"` once nothing else is outstanding. A later `watch` or `status --refresh` that can read the source records the complete set.

Once branch protection has contributed to the recorded set, **only a successful read of it** (or you editing `pipeline.json` / the adapter) can shrink the set: a later `403`, `404` or error keeps the recorded protection checks and pins, applies your edits, and marks the set unavailable (`branch-protection-unreadable`). The first read of a repository whose protection answers `403`/`404` simply has no protection source. An interrupt while preparing is exit 130 before anything is written.

## Where the required checks come from

The union, in this precedence order, deduplicated:

1. **User policy** `<userDir>/pipeline.json`:

   ```json
   { "repos": { "owner/name": { "required": ["ci.yml"], "allowSkipped": ["lint"], "deployment": ["deploy"], "detectionWindowMs": 600000, "trigger": "push" } } }
   ```

   This is the only source of `allowSkipped`, `deployment`, `detectionWindowMs` and `trigger`, so a repository cannot loosen the policy. An invalid file is `PIPELINE_CONFIG_INVALID` (exit 5).
2. **Repository adapter** `completion.requiredChecks` in `.claude/asterweave.json` (at most 50 strings of at most 200 characters; workflow files or exact check names). It is read only for a **trusted** repository (the same gate as `hooks`; an untrusted repository's value is skipped and reported as `repository-not-trusted`), from the bytes the trust hash covers.
3. **Branch protection** required status checks of the base branch, when the credential can read them, including the `app_id` pins. `403` and `404` mean unavailable and are not errors; other failures fail closed (see above).

An empty union is `missing-configuration`, never closable. `status --refresh` and `watch` record the effective policy and its sources in the state; plain `status` evaluates with the recorded policy.

## Polling

Time, randomness, sleeping and the abort signal are injected, so tests do not sleep.

- **Schedule**: bounded exponential backoff with jitter, minimum 5 s, maximum 120 s. A successful poll that changed nothing backs off; any change resets it. `--interval` (5 s to 120 s) sets the minimum.
- **Failures** (network, 5xx) back off the same way and are recorded as `poll.failed` events.
- **Server hints**: `Retry-After` and `x-ratelimit-reset` are honoured, up to one hour.
- **Rate limits are not failures.** The poll state becomes `rate-limited` with `resumeAt`. If the wait outlasts the remaining `--timeout`, `watch` returns at once with `status: "rate-limited"` and `resumeAt` instead of sleeping.
- **Bounds**: total wall time (`--timeout`), 1000 attempts, no tight loops.
- **Cancellation**: Ctrl-C (an abort signal) ends the watch cleanly with exit 130; nothing is recorded as a failure and the next `watch` resumes.
- **Reconcile on resume**: every poll reads the full state (pull request, workflow runs and check runs of the head and, once merged, the merge commit). Nothing assumes what happened while the process was gone; the first poll of each `watch` is recorded as `reconciled`.
- Authentication or a missing pull request cannot be fixed by polling: they stop the command (`PIPELINE_AUTH` exit 3, `PIPELINE_PR_NOT_FOUND` exit 1, `PIPELINE_FORBIDDEN` exit 1).

## Credential

The token comes from the GitHub CLI: `gh auth token -h <host>` through the injected spawn. The token is not in argv (only the host is), is cached in memory only, and is never printed, logged, stored or put in an error. A missing `gh` or no sign-in is exit 3 with a remediation. Host from `github.host`.

## `diagnose`

Explicit and read-only. It prints a bounded packet and sends it nowhere:

- failing and cancelled checks (name, state, conclusion, run id, attempt, link, whether required), optionally filtered with `--check <key>`;
- for workflow runs, the failing jobs and their failed step **names** (logs are never downloaded);
- for check runs, the sanitized `output.title` and `output.summary` (at most 2 KiB each);
- the names of the changed files (at most 100);
- the "Acceptance criteria" section of the pull request body, when present (at most 2 KiB).

It never reruns anything, never edits anything and never starts a model. The packet ends with the command you may choose to run yourself, for example `asterweave run start --workflow bugfix "<goal>"`. Handing it to a run is your decision.

## Linking to a run: `watch --run <runId>`

With `--run`, the monitor appends `pipeline.observed` (when the key states change), `pipeline.verdict` (at the end) and, once, `pipeline.target` records to the run's ledger, under the run lock, through the existing append API, so the audit trail shows the verdict. An event group that a previous process left unfinished is completed first, as `run approve` and `run abort` do. When the run's current node is `monitor-pipeline` and is running, a link call also records a `pipeline` **evidence** entry through the existing evidence transition, **only for a settled verdict**: result `pass` when the verdict is closable, `fail` for any other final verdict. While the verdict is still `waiting` no evidence is written, so a waiting link can never replace an earlier `fail` and unblock the node; one entry is written for each link call that sees a settled verdict. It never completes, retries or advances a node: graph semantics are untouched. A run that is locked by a live process or whose snapshot is behind its log is not modified; the command reports `run-locked` or `run-behind-its-log` and carries on.

The link is refused with a usage error (exit 2) before any request when the run does not exist, when the repository (`--repo`, or the origin of the current directory) is not the origin of the run's own workspace, or when the run is bound to another pull request: the run's `submit-pr` evidence names the pull request, else the first link records `pipeline.target` and later links must match it. The evidence binds a pull request when it carries exactly one `/pull/N` URL of the run's own repository (bare `#N` references are then not consulted, so `Fixes #3 ... https://github.com/o/r/pull/9` binds #9), or, without such a URL, exactly one bare `#N`. URLs of other repositories are ignored. Evidence that names several distinct pull requests (two own URLs, or `#3 and #4`) binds nothing: you pass the pull request explicitly and it is recorded as the target.

## What is stored

`<userDir>/pipelines/<hash of host and owner/name>/<owner>-<name>/pr-<n>/` holds `state.json`, `events.jsonl` and the lock. The log is event-first: an event is appended and fsynced before `state.json` is rewritten, and the state is a fold of the events, so a crash loses nothing. A torn final line is ignored on read and cut off under the lock (recorded as `store.repaired`). Reads are capped at 8 MiB (over the cap is `PIPELINE_LOG_TOO_LARGE`, nothing is truncated), one event is at most 1 MiB, and past 4 MiB the log rotates to `events.1.jsonl` and restarts with a checkpoint. `schemaVersion` is 1; a newer file is refused (exit 5) and left untouched. Every record passes the secret redactor. It records the repository, pull request number, base branch, resulting commit, per-key workflow identity, run id, attempt, conclusion, timestamps (observed, run started, completed), poll counters, rate-limit info and the optional run and session links.

## Untrusted input

Everything that comes from GitHub (workflow and check names, paths, conclusions, titles, branch names, summaries) is attacker controlled. It is rebuilt field by field (never spread), sanitized for terminal control sequences, redacted for secrets and length-capped before it reaches the state, a terminal or JSON output. State keys are prefixed so none can be `__proto__`. Error messages are fixed text and never echo a response body. Every request goes only to the allow-listed API host, with `redirect: "error"`, and every pagination link is re-validated before the credential is sent with it.

## JSON output

```text
{ ok, repo, host, prNumber, verdict, closable,
  pr: { state, headSha, baseBranch, mergedAt, mergeCommitSha }, target: { sha, branch },
  keys: [{ key, role, stage, state, reason, satisfied, runId, attempt, conclusion, url, updatedAt, workflow }],
  preMerge: [...], blockers: [{ key, state, reason, remediation? }], counters,
  poll: { status, count, lastPolledAt, lastSuccessAt, resumeAt, consecutiveErrors, rateLimit },
  policy: { required, allowSkipped, deployment, detectionWindowMs, trigger, sources }, links }
```

`watch` adds `status` (`terminal`, `timeout`, `attempts`, `rate-limited`, `aborted`), `attempts`, `resumeAt` and `runLink`; its `ok` is true only when closable. `diagnose` prints `{ ok, repo, prNumber, pr, filter, failing, changedFiles, acceptanceCriteria, sentAnywhere: false, handoff }`.

## Unverified assumptions

- **Check suites and Actions**: attributing a check run to the workflow event that produced it relies on the check run's `check_suite.id` equalling the workflow run's `check_suite_id`; unverified. The GitHub Actions app id (15368) is not assumed anywhere.
- **GitHub response shapes** (`GET /pulls/{n}`, `/actions/runs`, `/actions/runs/{id}/jobs`, `/commits/{sha}/check-runs`, `/pulls/{n}/files`, `/branches/{b}/protection/required_status_checks`) are written from memory of the REST API and checked only against the fake.
- **Branch protection permissions**: the endpoint needs more than read access on some repositories; this build treats `403` and `404` as "unavailable", which is also what a repository without protection answers.
- **`merge_commit_sha` semantics differ per merge strategy.** This build uses the value GitHub reports for a merged pull request as the commit to verify: for a merge commit it is that commit, for a squash merge the squashed commit. For a rebase merge GitHub documents a different value than the merge commit of the other strategies, and the commits created on the base branch differ from the pull request commits; whether the reported sha is the one workflows run on is not verified. If runs never appear on it, the key ends as `run-not-detected`, not as success. A merge queue or a branch rule that creates other commits is not modelled.
- **Rate-limit headers** (`x-ratelimit-remaining`, `x-ratelimit-reset`, `Retry-After`) and the way a primary limit answers (`403` with remaining 0) follow documentation from memory.
- **`gh auth token -h <host>`** is assumed to print the token for the host and nothing else.
- GitHub Enterprise Server hosts use the `<host>/api/v3` prefix by the same rule as the existing GitHub tools; unverified.
- No webhooks, no GitHub Checks write API, no logs download and no deployment API are used: deployment checks are ordinary required keys.
