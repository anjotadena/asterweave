---
sidebar_position: 6
title: Policy and guards
description: "The Asterweave CLI guard: reason codes and decisions, supervised versus autonomous mode, policy.json, the allow-list shell classifier and its limits, the user-owned allowCommands list, how it differs from the plugin guard, scoped approvals, and the experimental hook pre-tool-use command."
---

# Policy and guards

Every action a [run](/cli/runs) proposes passes through the **guard** before anything happens. The guard is pure decision logic and **fails closed**: if it cannot decide (an internal error, a missing home directory, a lost run lock), the answer is `unavailable`, which every consumer treats exactly like `deny`.

:::note Phase B is simulated
Runs in Phase B use a fake executor and a simulated tool dispatcher, so an allowed action does not actually execute. The guard, the policy and the audit trail behave as they will with a real executor.
:::

## Decisions

A decision is `{decision, reason, ruleId, detail}` with `decision` one of:

| Decision | Effect on a run |
| --- | --- |
| `allow` | The action is dispatched |
| `require-approval` | The run saves a scoped approval request and stops (`waiting-approval`, **exit 6**). Nothing runs until a person approves with `run approve` |
| `deny` | The node ends `policy-denied` and the run is blocked (**exit 7**). An approval never overrides a `deny` |
| `unavailable` | Same as `deny` (exit 7), for a guard that could not evaluate |

Every decision is written to the audit trail as a `tool.decision` event with its `reason` and `ruleId`; shown by `run show` as the **attention** line.

## Where the guard is evaluated

| Point | What is checked |
| --- | --- |
| Tool dispatch | Budgets, then the action itself: tool allow-list (autonomous), the shell classifier, paths, secrets |
| Before any mutation | Write, edit, a mutating shell or git command, merge, deploy: the process must still hold the run lock |
| Before graph advancement | A `pass` needs a budget left; the plan `approve` node needs a valid plan approval |
| Before a retry | Attempt budget, repeated failure signature, run budgets |
| On resume | The lock is held, the policy hash has not drifted, approvals are still valid |

## Reason codes

| Reason | Decision | When |
| --- | --- | --- |
| `DESTRUCTIVE_COMMAND` | deny | A command that destroys data or state: hard resets, forced cleans, forced pushes, recursive forced deletes, dropping databases, pruning containers, deleting namespaces, destroying infrastructure (see [what the classifier recognizes](#what-the-classifier-recognizes)) |
| `DEFAULT_BRANCH_PUSH` | require-approval | A push that updates `main` or `master` (or cannot be shown not to), including `--all`, `--mirror`, wildcard refspecs and a bare `git push` while on a default branch |
| `OUT_OF_POLICY_OPERATION` | require-approval | `merge` and `deploy` tool actions, `gh pr merge`, publishing (`npm publish`, `gh release`), `terraform`/`kubectl`/`helm` changes. In autonomous mode also an operation or branch the policy does not pre-authorize |
| `NETWORK_EGRESS` | require-approval | `curl`, `wget`, `Invoke-WebRequest`, package installs and similar |
| `PATH_OUTSIDE_WORKSPACE` | deny | A path argument whose real path is outside the workspace root (symlinks and `..` are resolved). Also a PowerShell **provider or drive qualified** operand (`env:X`, `HKCU:\Software`, `Cert:\`, `Temp:\x`, `FileSystem::C:\...`, `FileSystem::\\host\share`, `Microsoft.PowerShell.Core\FileSystem::...`): it is not a file below the workspace, and PowerShell makes the network connection when it resolves a UNC provider path. On Windows the Read, Write and Edit tools refuse the same spellings |
| `SECRET_ACCESS` | deny | `.env*` files, `~/.ssh`, credential files, the Asterweave user directory. On Windows trailing dots and spaces and `:stream` suffixes are ignored (`.env.`, `.env::$DATA`). A wildcard that can match a secret name (`.en*`, `id_r*`, `*.pem`, `*.key`) is refused too; a bare `*` is not (see [limits](#limits)) |
| `PROTECTED_PATH` | deny | A **write** (redirection, `tee`, `cp`/`mv`/`rm`/`ln`/`chmod`/`dd of=`, `sed -i`, `find -delete`, or the Write/Edit/MultiEdit/NotebookEdit tools) to a file that controls repository behaviour or the agent itself: anything under `.git/` (hooks, config; Windows spellings such as `.git::$INDEX_ALLOCATION`, `GIT~1`, `.git.` and a trailing space count, and a **symbolic link, even a dangling one,** is followed to its target), `.claude/settings*.json`, `.claude/asterweave.json`, `.claude/hooks/`, the `.claude` directory itself (except creating it) and `.mcp.json`; and the **repository hook mechanisms**, because the allowed `git commit` and `git push` run whatever hooks the repository configures: `.husky/`, `.githooks/`, `.git-hooks/`, `.lefthook/`, `lefthook*.yml|yaml|json|toml`, `.pre-commit-config.yaml`, `.gitattributes`, and the directory named by `core.hooksPath` (read once per classification with a config-only `git config --get`, at the verified workspace root, inside the time budget). Also `git config` writes of keys that can run commands, redirect remotes or change what a push updates, and any `git config --global/--system/--file`. Reads are not affected |
| `APPROVAL_SELF_GRANT` | deny | `asterweave run approve` (with or without `--nonce`), `asterweave mcp test --approve`, or any write under the `runs` directory: a run cannot approve itself or edit its own ledger |
| `UNPARSEABLE_COMMAND` | require-approval (supervised), **deny (autonomous)** | Anything that is **not an [understood form](#the-allow-list)** (rule id `not-allow-listed`: wrappers such as `sudo`/`exec`/`env`/`timeout`, interpreters and build tools such as `node`/`python`/`npm`/`make`, `find`/`awk`/`sed`/`tar`, writes and redirections to files, unknown commands or flags, PowerShell script blocks and `&` call operators), and, as before, anything the classifier cannot parse: command substitution (`$(...)`, backticks), `$'...'` and `$"..."` strings, `$1`/`$@`-style expansions, brace expansion, `bash -c` style wrappers, inline interpreter code (`node -e`, `python -c`, `perl -e`, `ruby -e`, `deno eval`...), PowerShell `Start-Process`, `Invoke-Expression`, `&` with a non-literal, `[Type]::` calls, `-EncodedCommand`, unbalanced quotes, risky environment prefixes (`GIT_*`, `LD_*`, `PATH`, `PAGER`, `EDITOR`...), `git -c` with a key outside a short harmless allow-list, `--config-env`, `--exec-path`, push refspecs that git resolves in ways the guard does not model. A command over **64 KiB**, with too many words or paths, or that exhausts the time or file-system budget (rule id `command-too-complex`, `command-too-long`, `path-budget`) is **denied in every mode**: nobody can review it. Running out of budget while the guard resolves the workspace and user directories is the same refusal, never `GUARD_UNAVAILABLE` |
| `TOOL_NOT_ALLOWED` | deny | An unknown tool, a malformed action, an invalid path argument, or (autonomous) a tool the policy does not list |
| `BUDGET_EXHAUSTED` | deny (the run exits **1**, not 7: a budget is a limit, not a policy refusal) | A run budget is used up, or a node has no attempts left, or the same failure signature repeated (see [Budgets](/cli/runs#budgets)) |
| `STALE_APPROVAL` | require-approval | An approval no longer matches the plan or policy, the policy changed since the run started, or the plan has not been approved |
| `HOOK_BLOCKED` | deny, or **require-approval** | A `validate` [hook](/cli/hooks) vetoed the action: exit 2 or a `deny` verdict is a deny, a `require-approval` verdict asks (a hook can only make a decision stricter) |
| `HOOK_FAILED` | deny | A `validate` hook failed (crash, timeout, bad verdict) and its failure policy is `block`, or hooks could not be run at all |
| `GUARD_UNAVAILABLE` | unavailable (= deny) | The guard itself failed, or a mutation was attempted without the run lock |
| `UNDISPLAYABLE_TARGET` | deny (exit 7; also `run approve` exit 1) | An approval would have to cover a scope the person could not be shown faithfully: longer than 2000 characters, or 8000 once every non-ASCII character is escaped, control or direction-changing characters, or text that redaction would rewrite. **Nothing is requested**; see [what you approve is what you see](#what-you-approve-is-what-you-see) |

When a command raises several findings, denies win over asks; an ask names every approval it needs.

## Supervised and autonomous mode

**Supervised** (the default) allows only the [understood forms](#the-allow-list) and asks a person about everything else, as in the table above. There is no tool allow-list; but a write, a redirection to a file, an interpreter or a build tool is not an understood form, so it asks (the Write/Edit tools are checked as paths: a write inside the workspace to an unprotected file is allowed).

**Autonomous** is for unattended runs and is only ever enabled by your own `policy.json` (below). It is **narrower in what it allows, stricter in what it tolerates**:

- A tool must be listed in `autonomous.tools`, otherwise `TOOL_NOT_ALLOWED`. (`merge` and `deploy` are never in the list and always ask.)
- An operation tag must be listed in `autonomous.operations` to be pre-authorized: `commit`, `push-branch` (only for a branch matching `autonomous.branches`) and `open-pr`. Anything else asks. **`push-branch` requires a non-empty `autonomous.branches`**: the policy validator rejects a policy that lists `push-branch` without one, and the guard denies a `push-branch` when the list is absent (an unscoped push cannot be told from a push to a protected branch).
- Anything that is not an understood form (and not listed in `allowCommands`) is denied outright instead of asked about.

Autonomous mode applies to a run only when the **workflow**, the **repository** and the **current branch** are all inside the policy's scope; outside it the run is supervised.

**No policy can pre-authorize** a merge, a deploy, a publish, a destructive command, a network egress or a default-branch push: these always need a scoped approval (or are denied). The policy validator rejects `merge` and `deploy` in `tools` and `operations`.

## The policy file

The only source of policy is `<userDir>/policy.json` in your Asterweave user directory. **Repository files can never grant anything**: `.claude/asterweave.json`, `CLAUDE.md` and everything under the workspace are ignored for policy. A missing file means supervised defaults. An invalid file fails closed: `POLICY_INVALID`, exit 5.

```json
{
  "v": 1,
  "mode": "autonomous",
  "autonomous": {
    "workflows": ["delivery@1"],
    "repos": ["c:\\work\\widgets\\.git"],
    "branches": ["feat/*"],
    "tools": ["shell", "read", "write", "edit", "git"],
    "operations": ["commit", "push-branch", "open-pr"],
    "budgets": { "iterations": 20, "toolCalls": 200, "tokens": 0, "wallMs": 1800000 }
  }
}
```

| Field | Rules |
| --- | --- |
| `v` | Must be `1` |
| `mode` | `supervised` or `autonomous`; `autonomous` requires the `autonomous` block |
| `autonomous.workflows` | Required, non-empty. Graph ids as `id@version`, for example `delivery@1` |
| `autonomous.repos` | Required, non-empty. Repository keys: the real path of the clone's git directory (for example `/home/me/widgets/.git`; lower-cased on Windows). Every work tree of one clone shares its key |
| `autonomous.branches` | Globs for branches a run may push (`*` stays within a path segment, `**` crosses `/`). **Required and non-empty when `operations` lists `push-branch`.** When set, a run on any other branch is supervised |
| `autonomous.tools` | Required. Any of `shell`, `read`, `write`, `edit`, `git` |
| `autonomous.operations` | Required. Any of `commit`, `push-branch`, `open-pr` |
| `allowCommands` | Optional, **top level** (applies in supervised and autonomous mode). Up to 64 argv prefixes, each 1 to 8 words, e.g. `[["npm","test"],["node","--test"]]`. See [allowCommands](#allowcommands-the-user-owned-list) |
| `autonomous.budgets` | Optional integers 0 to 1000000000 for `iterations`, `toolCalls`, `tokens`, `wallMs`; `0` is unlimited |

Unknown properties are errors. The **policy hash** is the sha256 of the file's canonical JSON (keys sorted, no whitespace); `allowCommands` is part of it, so changing the list is a policy change (see below).

### Policy hash drift

A run is bound to the policy hash it started under (`policy.bound`). If `policy.json` changes, an existing run **asks before it goes on**: it saves an approval named `resume` (scope `old-hash->new-hash`) and stops (exit 6). When you approve it, the run binds to the new policy, approvals granted under the old policy are retired (`approval.invalidated`), and the plan has to be approved again. `run show` reports `policy.changed`.

## Terminal-only approvals (defence in depth, not a sandbox)

Approvals must come from a person at a terminal, not from an agent. Three layers, each weaker than a real sandbox:

1. **The classifier** denies the command text `asterweave run approve ...` and `asterweave mcp test ... --approve` (`APPROVAL_SELF_GRANT`, also with `--nonce`), and writes under the `runs` directory. It is a heuristic over command text.
2. **A one-time nonce.** Each approval request carries the SHA-256 of a random 128-bit nonce. The plaintext is shown only on the stderr of the process driving the run, and only when that is a terminal; it is never written to disk, the ledger, hook payloads, JSON output or any child's environment or stdio. Flags without a valid nonce never grant; the nonce is single use, expires after one hour, and 5 wrong tries lock the flag path of that request for 10 minutes. A headless driver shows no nonce, so its requests need the interactive prompt (stdin and stdout both a terminal).
3. **Environment markers.** `run approve` and `mcp test` refuse (exit 7, `APPROVAL_FORBIDDEN_CONTEXT`) when `ASTERWEAVE_RUN_ID`, `ASTERWEAVE_SESSION_ID`, `CLAUDECODE` or a `CLAUDE_CODE_*` variable is set. Running approve from Claude Code's own terminal is therefore refused by design.

What this does **not** do: a process running as your operating-system user can unset the markers, read your files, and, on Windows, may reach the console (`AttachConsole`, `CONOUT$`) and read the nonce or answer a prompt. That is why the nonce is not the only barrier and why the interactive prompt exists. Isolating tool processes needs operating-system sandboxing, which is not provided; do not treat these controls as such.

## Scoped approvals

An approval is for **exactly one thing**: a scope `{operation, target}` where `target` is the exact command text (or the canonical JSON of a merge or deploy input). Approving `git push origin main` does not approve `git push origin main --tags`, and approving one merge does not approve another. An approval is also tied to the policy hash and, for plans, to the artifact hash and revision. It can be granted only by a person ([`run approve`](/cli/runs#run-approve)), never by the model, a repository file, an MCP server or text in an image.

## What the classifier recognizes

The shell classifier tokenizes a command line with quote awareness, splits it on `&&`, `||`, `;`, newlines and pipes, and inspects each command. It recognizes at least:

- `git reset --hard`; `git clean` with force in any flag layout (`-f`, `-d -f`, `--force`); `git checkout .` and `git restore .`; `git push --force`, `--force-with-lease` and `-f`; also behind `git -c key=value` and `git -C path`.
- `rm -rf` or `-r -f` of anything that is not a strict subpath of the workspace, `Remove-Item -Recurse -Force` with the flags in either order on a root, home or outside path.
- `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE TABLE`, `docker system prune -a`, `kubectl delete ns`, `terraform destroy`.
- Pushes to `main`/`master` (configurable default branches), including refspecs such as `+HEAD:refs/heads/main`; `--delete` and bare `--tags` are not default-branch pushes.

### The allow-list

The classifier **allows only forms it fully understands**; everything else is `UNPARSEABLE_COMMAND` (a question when supervised, a denial when autonomous). It prefers this to growing a denylist or a table of wrappers: a new wrapper, tool or spelling is, by default, one the classifier does not understand. A command is allowed only when **every segment** (split on `&&`, `||`, `;`, newlines and pipes) is one of:

- **Read-only commands** with allow-listed flags and in-workspace, non-secret, non-protected path operands: `ls`/`dir` (cmd `dir` only with `/b`), `pwd`, `echo`, `cat`/`type`, `head`, `tail`, `wc`, `grep` (no recursion), a **lone** `cd <plain workspace directory>` (see "Directory changes" below), and the PowerShell cmdlets `Get-ChildItem`, `Get-Content`, `Select-String`, `Get-Location`, `Get-Item`, `Test-Path`, `Write-Output`, `Set-Location` (only as a lone, plain directory change) with allow-listed parameters (ASCII and Unicode dashes are normalized; an abbreviation must be unique). Pipelines are allowed only between such commands. Not allowed: **unbounded or hidden listings** (`Get-ChildItem -Recurse`/`-Depth`/`-Force`, `Get-Item -Force`, `ls -R`), `cd -` (shell state), any path operand with a **colon** other than a fully qualified drive root (`C:\` or `C:/`, then no other colon): provider paths (`env:`, `HKCU:`, `FileSystem::`), drive-relative paths (`Get-ChildItem C:`; refused only where PowerShell reads them, that is in the PowerShell dialect or for a PowerShell cmdlet: a POSIX or cmd reading of `C:x` is an ordinary relative path) and `file:stream` spellings, and **reading `.git/config`** (remote URLs there can embed credentials such as `https://user:token@host/...`), also through a wildcard that CAN match it (`cat .gi*/config`, `.git/c*`, `.[g]it/config`, `Get-Content .gi*\config`; in the POSIX dialect a leading `*` or `?` cannot match a leading dot, so `?git/config` is not `.git/config` there). **`findstr` is not allowed at all**: `/f:file`, `/g:file` and `/d:dirs` read names or search strings from files, and Git Bash rewrites `//f:x` to `/f:x`, so the operands the guard checked are not the files read.
- **Read-only git**: `status`, `log`, `diff`, `show`, `branch --list/-a/-v`, `rev-parse`, `ls-files`, `remote -v`, `blame`, `describe`, `tag --list`, `config [--local|--global] --get|--get-all <key>` for a key of a small explicit list only (`user.name`, `user.email`, a few harmless `core.*`, `color.*`, `init.defaultBranch` ... any other key, `--get-regexp`, `--list`, `--show-origin`, `--system`, `--file` ask: a deny-list of secret-looking keys is never complete, `sendemail.smtppass`, `http.proxy`, `http.extraheader` and `core.sshcommand` can all hold credentials), with allow-listed flags and **no global options** (`-C`, `-c`, `--git-dir`, `--exec-path`...), no `GIT_*` prefixes and no `--output`, `--no-index` or external-diff / textconv options. **Every operand is checked as a path too** (strictly, before and after `--`): `git diff /abs/a b`, `git show HEAD -- /data/x`, `git blame /abs/x` and `git ls-files /abs` read outside the repository, so an operand outside the workspace is denied or asked about, and an absolute-looking text outside the workspace that is not under an operating-system root (`/c/Users/x` is a Windows path to Git Bash, `/data/x` a real one on Linux) is asked about unless it is the value of a `--flag=value` (a regex such as `--grep=/re/`).
- **Nothing else is a segment**: a segment that is only shell syntax is not understood. That covers a redirection with no command (`> src/a.js` truncates or creates the file; `>> f`, `>| f`, `< f`, `ls; > f`, `echo hi && > f`, even `2>&1`), `VAR=x` or `$x = 1` with nothing after it, `:`, `true`, a bare `cd` and here-strings. The only allowed texts that run nothing are empty text, whitespace, separators with nothing around them (`;;`, a lone `|`, `(` or `)`) and a comment (POSIX and PowerShell; cmd has no `#` comment, so it is a command word there and asks). A fragment such as `ls &&` is a syntax error in every shell: the only command in it is the allow-listed `ls`.
- **The three policy operations**: `git commit -m <message>` (operation `commit`), `git push [-u] <remote> <branch>` (operation `push-branch`; a default branch is a `DEFAULT_BRANCH_PUSH`) and `gh pr create` with `--title/-t`, `--body/-b`, `--base/-B`, `--draft`, `--fill` and `--dry-run` only (operation `open-pr`; `--head/-H`, `--repo/-R`, `--web`, `--template`, `--body-file/-F`, labels, reviewers... ask). **`<remote>` must be a remote configured in the workspace repository** (read once per classification with a config-only git call at the verified workspace root, inside the time budget) and must not also be the name of a file or directory in the workspace or the working directory: git reads any other word as a local path and runs the `pre-receive` / `update` hooks of the repository found there, and plain file writes can build one. A push whose remote is unknown, unconfigured or unreadable asks (denied when autonomous).

Reads that display credentials stay a **residual risk**: `git remote -v` and `git remote get-url` print remote URLs exactly as configured (a URL with an embedded token is printed in full); `git config --get *.url` / `*.pushurl` and any read of `.git/config` ask instead, and `git log --format=...` can invoke a configured `gpg.program` for signature placeholders.

Not understood, so asked about (or denied when autonomous): wrappers and launchers (`sudo`, `exec`, `env`, `nice`, `timeout`, `stdbuf`, `xargs`, `nohup`, `time`, `start`, `call`, shells, `wsl`, `ssh`...), interpreters, runtimes and build tools (`node`, `python`, `perl`, `npm`, `npx`, `make`, `cargo`, `dotnet`, `java`...), `find`/`awk`/`sed`/`tar` and similar, `cp`/`mv`/`rm`/`mkdir`/`touch`, `git add`/`checkout`/`merge`..., unknown commands and flags, any redirection to or from a file, command substitution, backticks, process substitution, heredocs, `VAR=x` prefixes, subshells and `{ }` groups, PowerShell script blocks (`{` `}`), `&` and `.` call operators, `$`/`%` expansions, and anything with a glob it cannot check against the real directory listing.

The deny floors still run first and take precedence, on the de-escaped words, **and on every later word of a segment that is not understood**: `exec -a x git push origin +main` is a `DESTRUCTIVE_COMMAND`, `exec -a x cp a .git/hooks/pre-commit` is a `PROTECTED_PATH`, `sudo --user root git push origin main` is a `DEFAULT_BRANCH_PUSH` (nothing about a wrapper's own options is modelled).

#### What the floors recognize

- `git reset --hard`; `git clean` with force in any flag layout; `git checkout .` and `git restore .`; `git push --force`, `--force-with-lease`, `-f` and `+refspec`; also behind `git -c key=value` and `git -C path`.
- `rm -rf` or `-r -f` of anything that is not a strict subpath of the workspace, `Remove-Item -Recurse -Force` on a root, home or outside path, or with **no literal target** (`Get-ChildItem | Remove-Item -Recurse`).
- `DROP DATABASE`, `DROP SCHEMA`, `TRUNCATE TABLE`, `docker system prune -a`, `kubectl delete ns`, `terraform destroy`.
- Pushes to `main`/`master` (configurable default branches), including refspecs such as `+HEAD:refs/heads/main`; `--delete` and bare `--tags` are not default-branch pushes.

#### Dialects

cmd `dir` is allowed with `/b` only (in the run loop, where the dialect is unknown, `dir /b` is read in every dialect, and in the PowerShell reading `/b` is a path outside the workspace, so `dir /b` is a hard `PATH_OUTSIDE_WORKSPACE` deny there even when supervised); `dir /s`, `/a`, `/o`... ask, because they list more than the operand the guard checked (and `/s` is a path outside the workspace in the POSIX reading).

The shell **dialect** follows the tool, not the host: the Bash tool is read as POSIX shell **even on Windows** (Git Bash removes backslashes: `g\it re\set` is `git reset`); the PowerShell tool as PowerShell (backtick escapes only, **a backslash is literal even before a quote**, `''` quoting, en and em dashes are parameter dashes, no script blocks); `cmd` text with caret escapes, a literal backslash, **no single quotes and no `#` comments**. When the dialect is not known (the run loop, any other tool name) all three readings are checked, and a segment must be understood in **every** one. `$'...'` strings are decoded and the decoded text is checked; `$"..."`, `$1`, `$@`, `${...}`, `$(...)` and brace expansion are unparseable.

#### No side effects on untrusted text

The classifier makes **no file-system, network or git call for text it has not placed inside the workspace**: UNC paths (`\\host\share`, `//host/share`), `\\?\`, `\\.\`, device names, NTFS stream syntax, `~user` and `$`/`%` expansions are decided by text (outside the workspace: `PATH_OUTSIDE_WORKSPACE`), so the guard cannot be made to contact an SMB share. A workspace that itself lives on a UNC share may use paths under its own verified root. Inside the workspace a bounded `realpath` / `lstat` / `readlink` chain follows links, **including dangling ones** (a link to `.git/hooks/pre-commit` is that file), and every call is counted against the budget (6000 calls, 3 s by default). Exhausting the budget is a **deny** (`command-too-complex`), never "the path does not exist". Git is run by the classifier at only three points, always **at the verified workspace root**, inside the same time budget, with `safe.bareRepository=explicit`, no fsmonitor and no pager, and (except for one read, below) `GIT_CEILING_DIRECTORIES` set to the root's parent (so a root that is not itself a repository never resolves to a repository above it): the current branch (`symbolic-ref`, hooks disabled), the raw `core.hooksPath` (a config-only `git config --get`, plus `rev-parse --show-cdup` to confirm the root is the top of its working tree; this one read deliberately passes **no** ceiling, because a parent repository has to be found to show that the root is not the top, and it stays safe because `safe.bareRepository=explicit` stops git from taking a bare-shaped directory for a repository and the read only prints a path) and the names of the configured remotes (a config-only `git config --name-only --get-regexp`). The two configuration reads run no hook and read every scope, the user's global configuration included. No read is made for text that is merely a path in the workspace. An unreadable `core.hooksPath` is treated as unset (fail-open: it only means one more directory is not protected from writes, and git that cannot be run cannot commit either); an unreadable remote list is **fail-closed** (no push is understood, because an unknown remote word is a push to a local path). If the root is not the top of its working tree, a relative `core.hooksPath` cannot be placed, so **no** `git` or `gh` form is understood (see "Embedded repositories" below).

#### Protected paths and hook mechanisms

Writes (Write, Edit, redirections, `cp`...) are refused as `PROTECTED_PATH` for: `.git` (also through a wildcard that names it, `.gi*`, `.[g]it`), `.claude/settings*.json`, `.claude/asterweave.json`, `.mcp.json`, the hook-manager directories `.husky`, `.githooks`, `.git-hooks`, `.lefthook*`, the directory named by `core.hooksPath`, and these configuration names: `.gitattributes`, `lefthook*`, `.pre-commit-config.*`, `.lintstagedrc*`, `lint-staged.config.*`, `.huskyrc*`, `.overcommit.yml`, `.simple-git-hooks.*`, `simple-git-hooks.*`. It also refuses what could become a **git directory** inside the workspace (a push to a path runs that repository's hooks): a file named `HEAD`, a hook-named file (`pre-receive`, `update`...) in a directory called `hooks`, `config` / `packed-refs` / `hooks/*` next to an existing `HEAD` file, and the last of `HEAD`, `objects/`, `refs/` to appear next to the other two (checked with a budgeted `lstat`). `HEAD` is compared **case-insensitively on every platform** (macOS file systems are case-insensitive too), so a file literally named `head` or `Head` is refused as well; that is a deliberate false positive on case-sensitive file systems.

Residual risks, left open on purpose: `package.json` is **not** protected (`lint-staged` and `simple-git-hooks` configuration lives there, and so do npm scripts); git aliases and other configuration the agent cannot write but a repository can ship; `git remote -v` prints URL credentials; and **hooks still run on an allowed `git commit` / `git push`** in a repository that configures husky, lefthook or similar. A **real dispatcher MUST run git with `-c core.hooksPath=<an empty directory>` and a hardened environment** (no `GIT_*` variables, no tokens, `core.fsmonitor=false`, `protocol.ext.allow=never`); this is required before any unattended run executes commands (Phase D). The classifier's own git calls use the other flags (`core.fsmonitor=false`, `protocol.ext.allow=never`, `core.sshCommand=`, `safe.bareRepository=explicit`) and a minimal environment; its two configuration reads (`core.hooksPath`, remotes) are config-only, so they run no hook and are deliberately **not** given a `core.hooksPath` override (it would hide the value being read). **The dispatcher must also set `safe.bareRepository=explicit` and `GIT_CEILING_DIRECTORIES` (the parent of the workspace root)** and must not run git in a directory the guard has not tied to the workspace repository (see "Embedded repositories" below). None of this makes the allow-list complete or a sandbox: it is a short list of forms the classifier understands, checked as text plus a few bounded file-system looks.

#### Embedded repositories (N1)

`git` finds its repository by walking **up** from the directory it runs in, and a directory that merely **looks like** a git directory (`HEAD` + `objects/` + `refs/`, or `HEAD` + `commondir`) is taken for one when `safe.bareRepository` has its default, `all`. A hostile repository can **commit** such a directory (`evil/HEAD`, `evil/config`, `evil/objects/*`, `evil/refs/*`, `evil/hooks/*`; or `evil2/` with only `HEAD` and `commondir`). `git status` run inside it then uses `evil/config`: `core.fsmonitor`, `diff.external`, hooks and remote URLs are attacker-controlled commands. The remotes the guard read belong to the **root** repository, not to that directory, so a command such as `git push origin feat/x` run from `evil` is not what it looks like.

Therefore **every `git` and `gh` form is understood only when**:

1. the workspace root has a **`.git` entry** (a directory, or the file of a linked work tree), checked with the budgeted `lstat`. The guard verified the remotes, the hooks path and the branch of *that* repository; a root without one (the directory of a bare repository, a directory holding `HEAD` + `objects/` + `refs/` or `HEAD` + `commondir`, a plain directory whose repository is above it) is not a repository the guard knows. This applies to every form, reads included, not only `commit` and `push`;
2. the root is the **top of its working tree** (`core.hooksPath` is read from that top: when the answer is "not the top", no `git` or `gh` form at all is understood, reads included); and
3. git's discovery from the **payload working directory** ends at the root's own `.git`. The guard walks every directory from the hook payload `cwd` up to the workspace root (the root itself excluded) with the budgeted `lstat` (counted against the 6000 file-system calls and the time budget; running out is `command-too-complex`, never "nothing there"). The form is **not understood** (asked about when supervised, denied when autonomous, finding `git-embedded-repository`) when the working directory is outside the workspace root, or any directory on the way holds a `.git`, `HEAD` or `commondir` entry, or both `objects` and `refs`. A normal subdirectory (`packages/cli`) is unaffected; a nested repository with its own `.git` (a submodule) asks, because it is not the repository whose remotes were read. `git -C evil status` was always refused.

A git or gh form from the root, or from a normal subdirectory payload `cwd`, with `<root>/.git` present and the root being the top of its working tree, is allowed as before. (`asterweave hook pre-tool-use` takes the root from `CLAUDE_PROJECT_DIR` or the git top level of the `cwd` and does not itself require a `.git` there: a root without one makes every git and gh form ask, everything else is judged as usual.)

#### Directory changes

**The guard never follows a directory change.** The directory a later command really runs in cannot be predicted from the text: a *failing* `cd` leaves the shell where it was (`cd evil && cd ../nope; git status` runs `git` from `evil`), a *wildcard* operand expands to whatever matches in the real directory (`cd ev*`, `cd ev?l`, `cd [e]vil`, `Set-Location ev*`, `sl e?il` all reach `evil` in posix, PowerShell and cmd), Windows drops trailing dots and spaces (`cd evil.`), `CDPATH` can make a relative operand mean another directory, and bash falls back to the physical directory for `cd link/../x`. A model of the working directory would diverge from the shell, and a divergence is exactly how a command is judged in one directory and run in another (for example from an embedded repository whose `core.fsmonitor` runs). So the guard does not model it at all:

- A command line that contains `cd`, `chdir`, `Set-Location`, `sl`, `pushd`, `popd`, `Push-Location` or `Pop-Location` **together with any other command** (before, after, chained with `&&`, `||`, `;`, `|` or a newline, or inside a subshell or group, in any dialect reading of the line) is **not understood as a whole**: it asks when supervised and is denied when autonomous (finding `cwd-change-with-other-commands`). The other commands are judged against the payload working directory only for the path and secret floors, which still deny on their own. `cd src && cat a.js` and `ls && cd src` therefore ask; run the commands as separate tool calls (the payload `cwd` then carries the directory).
- A **lone** `cd` (nothing else on the line) is understood only for a plain in-workspace operand: no wildcard (`*`, `?`, `[`; PowerShell backtick escapes), no component ending in a dot or space, no `~` (home, `~user`, Windows 8.3 `PROGRA~1`), `$`, `%`, `-` or quote, no provider or drive-qualified form (`env:`, `FileSystem::`, `C:x`), no `name/..` (bash's physical fallback), and in the POSIX reading no `CDPATH`-sensitive spelling: a relative operand that does not start with `./` or `../` is understood only when it is a real directory here (budgeted `lstat`) and `CDPATH` is unset. The operand is checked against the payload working directory (nothing can have moved it), is never a directory outside the workspace, and is not an embedded repository (the same walk as above, on the target: `cd evil` asks because the next command would start there).

Hardening that goes with it: the classifier's own git calls use `safe.bareRepository=explicit` (git refuses an implicitly discovered bare-shaped directory), disable fsmonitor, hooks (except the config-only reads, which run none) and the pager, and pass `GIT_CEILING_DIRECTORIES` = the parent of the root so that a non-repository root never resolves to a parent repository. The one exception is the `rev-parse --show-cdup` read of the hooks-path check, which passes no ceiling (see above). **Requirement for the Phase D dispatcher**: run every action in a fresh shell, or pass the real working directory to the guard on each call (the simulated loop passes one fixed directory and never updates it, so a lone `cd` followed by a write that turns that directory into an embedded repository would otherwise be judged from the wrong place); run git with hooks disabled, `-c safe.bareRepository=explicit` and `GIT_CEILING_DIRECTORIES` = the parent of the workspace root, from a working directory proven to reach the root's `.git`, inside a sandbox; the classifier's text analysis is not a sandbox. Git older than 2.38.1 ignores `safe.bareRepository`; the directory walk does not depend on it. `asterweave doctor` does not check this setting. Residual: a working directory that becomes an embedded repository between the check and the run (time of check to time of use); a lone `cd` followed by a later call is judged again from the new payload `cwd` (the walk), not remembered; and `CLAUDE_PROJECT_DIR` is trusted as the boundary.

### allowCommands: the user-owned list

`<userDir>/policy.json` may list commands you accept without a question, as exact **argv prefixes**:

```json
{ "v": 1, "mode": "supervised", "allowCommands": [["npm", "test"], ["node", "--test"]] }
```

A segment matches when its words start with a listed prefix (`npm test -- --watch=false` matches `["npm","test"]`; `npm install` and `npm testx` do not). A command is allowed when every segment is an understood form or a listed prefix **and there is no other shell syntax** (no redirection, subshell, `VAR=x` prefix, wrapper or substitution). The first word must be a bare command name (no path). It applies in supervised **and** autonomous mode. It is **not** a way around the floors: secrets, protected and outside-workspace paths, destructive commands and default-branch pushes in a listed command are still refused. Only `policy.json` is read: `.claude/asterweave.json`, `CLAUDE.md` and any file in the repository can never add to it, and the list is part of the policy hash. Repository [hooks](/cli/hooks) run only if their command is understood or listed. Listing `npm test` means trusting what the repository's `test` script does.

**Option rule.** After the listed prefix, any further word that starts with `-` makes the command **not match**, unless that exact option is part of the listed prefix: `npm test --script-shell=calc.exe`, `npm test --prefix=C:\x` and `node --test --import data:text/javascript,1` are not understood (they ask, or are denied when autonomous), because an option changes what the listed program runs or loads. Positional words are fine (the secret, protected and outside-workspace floors still apply to them). A bare `--` ends the options: what follows is passed on to the program's own script (`npm test -- --watch=false`, `cargo test -- --nocapture`). The policy file format and the policy hash are unchanged; the rule only affects which commands match. Keep the list narrow and put every option you accept **in the prefix**:

```json
"allowCommands": [["npm", "test"], ["npm", "run", "lint"], ["node", "--test"], ["cargo", "test", "--quiet"], ["dotnet", "test", "App.sln"]]
```

A listed command can still run any code in the repository (a `test` script, a configuration file the tool loads) and can still run git hooks; the rule closes the command-line options, not what the program does by itself.

### Limits

:::caution The classifier is a heuristic, not a sandbox
It reads the **text** of a command and **cannot see** inside a script file, a Makefile target, `npm test` (once you list it), `node script.js` (once you list it), an alias or shell function defined elsewhere (a shell profile that redefines `ls` or `git` is not visible), or what a program does with its input. A command the guard does not understand is **asked about, not blocked**: approving it approves whatever it does. The allow-list is deliberately small, so most commands ask; `allowCommands` is how you opt in to the ones you trust. Remaining residual risks: the command name is resolved by your shell (`PATH`, or the current directory in `cmd`), so a planted `git` or `cat` program is not noticed; `git diff`/`log -p`/`show` honour external-diff and textconv drivers configured by the repository, and print tracked secrets; the self-grant refusal (`ASTERWEAVE_RUN_ID`) is **advisory** (a child process can unset the variable). The guard models no git configuration beyond the three values it reads (see "No side effects on untrusted text"): aliases, `include`s and every other key in `~/.gitconfig` or the repository are not visible. Those three reads (`git config --get` and `--get-regexp`) do see **every scope**, so a `core.hooksPath` or a remote defined in `~/.gitconfig` is seen like one in the repository. Further residual risks of the allowed forms: `git commit` and `git push` **run repository hooks**. The hook directories and configuration listed under `PROTECTED_PATH` cannot be written through the guard, but `lint-staged` / `simple-git-hooks` configuration in `package.json` (deliberately not protected wholesale), the scripts it calls, aliases and shell functions, and any file a hook runs remain execution paths; `--no-verify` is **not** enough to avoid hooks and the guard does not rely on it. A **real dispatcher** (a later phase; Phase B only simulates) must therefore run git with `-c core.hooksPath=<an empty directory>` and hardened configuration, instead of trusting this list. (The guard's own reads are not a model for it: its configuration reads are config-only and run no hook, so they do not set `core.hooksPath`.) Reading special files (FIFOs, devices, `/proc`) can block or print process state; the guard only checks names and locations. Real isolation (a container, a separate account) is a later phase.
:::

#### Size and time limits

The floor patterns are applied by a **linear scan** (the plugin's regular expressions are polynomial: a 5000-character line takes seconds). A command over **64 KiB** is refused before anything else runs, more than 4000 words, 2000 commands or 2000 paths are refused too, a path over 4096 characters is refused, and one classification has a monotonic-clock budget (the hook uses 2 s) and a limit of 6000 file-system calls; exceeding either is a deny (`command-too-complex`).

### What you approve is what you see

An approval is bound to the **raw** target. `run show` and the `run approve` prompt display it with every non-ASCII character as an explicit `\u{XXXX}` escape (a Hangul filler, a variation selector, a combining mark or a Cyrillic `а` can never look like nothing or like a Latin letter), a backslash as `\\`, a newline as `\n`, a tab as `\t`. The display is therefore injective. A scope longer than 2000 characters, whose escaped form is longer than 8000, or that holds control or direction-changing characters is never requested (`UNDISPLAYABLE_TARGET`).

## Differences from the plugin guard

The Claude Code plugin ships its own PreToolUse guard (`hook-guard.mjs`). The CLI guard is a re-implementation that is at least as strict on every case the plugin's tests cover, and stricter where the plugin misses:

| Case | Plugin guard | CLI guard |
| --- | --- | --- |
| Environment variable bypass | `ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD`, `ASTERWEAVE_ALLOW_DEFAULT_BRANCH_PUSH` switch checks off | **None.** There is no way to turn the guard off from the environment |
| Malformed hook input | Fails **open** (allows) | Fails **closed** (denies) |
| `git -c key=value push ...` | The `-c` value can hide the subcommand | `-c` takes a value; the push is classified, and a key outside the harmless allow-list is unparseable |
| Backslash or quote spellings (`g\it`, `$'/'`) on Windows | Not decoded | Decoded per shell dialect before the checks |
| Very long commands | Polynomial regular expressions (seconds to minutes) | Refused above 64 KiB; linear scan below |
| Writes to `.git`, `.claude/settings*.json`, hooks, `.mcp.json` | Not checked | `PROTECTED_PATH` |
| `git clean -d -f`, `git clean --force` | Only some flag layouts | All force layouts |
| `rm -rf ./src` and other relative or workspace paths | Only root, home, `.` and `..` | Any recursive forced delete except a strict subpath inside the workspace |
| `Remove-Item -Force -Recurse` | One flag order | Either order |
| Option values such as `git push -o x` | The value can be read as a refspec | Flag values are not read as refspecs; quoting is respected |
| Paths | Not checked | Real path checked against the workspace root; secrets and the user directory blocked |
| Unknown commands | Allowed unless a pattern matches | **Asked about** unless an understood form or listed in `allowCommands` |
| Autonomous policy, scoped approvals, budgets, lock | None | Part of the guard |

## `hook pre-tool-use` (hidden, experimental)

`asterweave hook pre-tool-use` lets Claude Code itself ask the CLI guard about a tool call. It is **hidden** from `help`, **experimental**, and it **does not replace the plugin's guard**: the plugin's PreToolUse hook remains the supported protection for Claude Code sessions. Use this command only to add the CLI's stricter rules next to it.

The command reads Claude Code's PreToolUse JSON from stdin, evaluates the command (or the file path for `Write`, `Edit`, `MultiEdit` and `NotebookEdit`) in **supervised** mode and writes the plugin's response shape. The workspace boundary is **not** the payload's `cwd` (a model that `cd`s to your home directory would otherwise make everything "inside"): it is `$CLAUDE_PROJECT_DIR` when set (absolute, must exist), otherwise the **git top level** of the payload `cwd`, accepted only if it passes `worktreeRootProblem` (the work tree git reports must contain the `cwd` and its `.git` must be the repository's own, or point back at it; a hostile `core.worktree` fails this) and is not a filesystem root, the home directory or one of its ancestors. `$CLAUDE_PROJECT_DIR` is refused when it is the home directory, an ancestor of it or a filesystem root. A UNC or device working directory is refused unless it lies under `$CLAUDE_PROJECT_DIR` (the hook does not touch it). The user's own `allowCommands` from `policy.json` are honoured; an unreadable or invalid policy grants nothing. If the root cannot be determined the answer is `deny`. The Bash tool is read as POSIX shell on every platform, the PowerShell tool as PowerShell. The response shape:

```json
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Asterweave blocked this command: ..."}}
```

- `deny` for a deny or unavailable decision, `ask` for a require-approval decision.
- For an `allow` it prints **nothing** (the normal permission flow continues, exactly like the plugin hook). It **never** emits an explicit `allow` document, because Claude Code treats that as a permission grant that skips your own prompt. The former `--emit-allow` flag has been removed (it is now an unknown flag, exit 2).
- It **always exits 0** once the subcommand is recognized, because Claude Code treats other non-zero exits as non-blocking errors. Unparseable JSON, a non-object payload, a missing or non-string command or path, a payload over 1 MiB, or any internal failure is answered with `deny`.
- An unknown hook name or flag exits 2, which also blocks (fail closed). It never uses the `{ok:false}` envelope. **Exit 2 for a usage error is the contract**: Claude Code treats exit 2 as "block", so a mistyped hook name can never become a pass, while every other failure is a `deny` document with exit 0.

To wire it in as an additional PreToolUse hook, add an entry to your Claude Code settings (for example `~/.claude/settings.json`), using the absolute path of your clone:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/asterweave/packages/cli/bin/asterweave.mjs hook pre-tool-use",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Set a `timeout`** (seconds) on the hook, as above. The command answers in well under a second for any realistic input and bounds its own work (64 KiB command cap, 2 s classification budget, 1 MiB payload cap), but a hung process is outside its control. What Claude Code does when a command hook times out (whether the tool call is allowed, blocked or asks) is **UNVERIFIED** here and may be fail-open; do not rely on the timeout path as a protection.

### What the hook covers, and what it does not

Covered: the **Bash** and **PowerShell** tools (the command text) and the **Write**, **Edit**, **MultiEdit** and **NotebookEdit** tools (the file path, classified as a **path** with no variable expansion: workspace boundary, secrets, `PROTECTED_PATH`, Windows stream / 8.3 / trailing-dot spellings, dangling links). Any other tool name that carries a `command` is read under both shell dialects.

**Not** covered: **Read**, **Grep**, **Glob**, **WebFetch**, **WebSearch**, MCP tools and sub-agent tools (add them to your own permission rules), what a script or interpreter does once it runs, files changed by a program rather than by a tool call, and anything in a session where the hook is not installed. The hook is an extra layer next to the plugin's guard and Claude Code's own permissions, not a sandbox.

## Related

- [Runs](/cli/runs)
- [Hooks](/cli/hooks)
- [Configuration and trust](/cli/config-and-trust)
- [Exit codes and doctor](/cli/exit-codes)
