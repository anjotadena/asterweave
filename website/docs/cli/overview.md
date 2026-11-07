---
sidebar_position: 1
title: CLI overview
description: "The standalone asterweave command-line interface (preview): what Phase A does, how to run it from the repository, and the full command reference."
---

# Asterweave CLI (preview)

`asterweave` is a standalone terminal program that sits next to the [Claude Code plugin](/getting-started/installation). **Phase A** is the foundation: it signs you in, connects a local clone, shows your effective configuration, manages repository trust, and diagnoses your setup. It does **not** run agents yet.

:::note Preview status
The CLI lives in `packages/cli/` in the Asterweave repository. The package is marked `private` and is **not published to npm** yet, so there is no `npm install -g asterweave` today. Run it from a clone of the repository as described below. The plugin and its `/asterweave:` skills are unaffected by the CLI.
:::

## What Phase A does and does not do

| Phase A does | Phase A does not |
| --- | --- |
| Require a GitHub sign-in (through `gh`) before an interactive session starts | Run an agent loop. Typing free text in the composer shows "not available in this build" |
| Warn, without blocking, when Claude Code (`claude`) is not signed in | Call a hosted Asterweave service. There is no hosted backend and the Asterweave account is always "unavailable" |
| Connect an **existing** local clone and remember it | Clone, fetch, check out, or modify a repository |
| Show every configuration key with the layer it came from | Run quality-gate commands, hooks, or MCP servers from a repository |
| Record trust for a repository, bound to a content hash | Spawn `claude -p`, run `claude doctor`, or read a token |
| Diagnose Node, `gh`, `claude`, the user directory, configuration, and the repository (`doctor`) | Provide `/sessions`, `/usage`, `/settings`, or `/context` (these are stubs) |

## Requirements

- Node.js 22 or newer (`engines.node` is `>=22`). The CLI tests (`npm run test:cli`) need Node 22+ too and stop with a clear message on an older Node, although the repository root still allows Node 18 for the plugin scripts.
- [GitHub CLI (`gh`)](https://cli.github.com/), signed in with the `repo` and `read:org` scopes. Asterweave never reads the token; it asks `gh`.
- Optional: the native [Claude Code](https://docs.claude.com/en/docs/claude-code) build. On Windows the native `claude.exe` must be on `PATH`. A `.cmd`-only install is reported as `CLAUDE_SHELL_SHIM_ONLY` because Asterweave never uses a shell to launch programs.
- `git`, for `repo connect` and `repo status`.

## Run it from the repository

From the root of a clone of the Asterweave repository:

```bash
node packages/cli/bin/asterweave.mjs --version
node packages/cli/bin/asterweave.mjs help
node packages/cli/bin/asterweave.mjs doctor
```

Everything below is written as `asterweave ...`; substitute the `node packages/cli/bin/asterweave.mjs` form unless you have linked the package.

To get a bare `asterweave` command on your `PATH` you can use `npm link` from `packages/cli/`. This is the standard npm mechanism for a local package; it changes global npm state and was not exercised as part of this documentation, so check `asterweave --version` afterwards.

:::caution Do not use `npm exec asterweave`
The package is not published, and a bare name that is not a local dependency can make npm look up an unrelated package of the same name in the registry. Always run the script by path or through `npm link`.
:::

## First launch walkthrough

Run `asterweave` with no command in an interactive terminal. The flow is:

1. **Terminal check.** Both stdin and stdout must be a TTY, and `TERM` must not be `dumb`. Otherwise the CLI exits with code 2 and `interactive mode requires a TTY` (see [non-TTY behavior](#non-tty-behavior)).
2. **GitHub sign-in (required).** Asterweave asks `gh auth status --json hosts`. If you are not signed in, the token is invalid or expired, or the `repo` / `read:org` scopes are missing, you see a **Sign in to continue.** screen with two choices:
   - `GitHub (recommended)` hands the terminal to `gh auth login --web -h github.com -s repo,read:org`. Your browser opens, you approve, and you return to the terminal. Asterweave re-checks and stores a reference only.
   - `Browser sign-in` signs in to the *model provider* (`claude auth login`). It does **not** satisfy the GitHub requirement, so the screen returns until GitHub is signed in.
   - If `gh` is not installed, or its status cannot be read, there is nothing the screen can fix and the CLI exits with code 3 and an install hint.
3. **Model provider check.** `claude auth status` is read. A missing Claude Code sign-in becomes a warning line in the banner, never a blocker.
4. **Repository selection.** If a connection from an earlier run still points at a valid clone, it is reused. Otherwise the repository is taken from the `origin` remote of your current directory (shown as `Repository: owner/name (from origin)`), so organisation and collaborator repositories work; you then pick a branch (from `git branch -a`). Only when the clone has no usable GitHub `origin` do you pick from `gh repo list`, which lists just the repositories you own. The current directory must be an existing clone whose `origin` is the selected repository. See [`repo connect`](#command-reference).
5. **Banner.** For example:

   ```text
   ✓ Signed in: GitHub (octocat)
   ✓ Repo: widgets (main)
   ✓ Runner: Local
   Asterweave account: unavailable (local session)
   
   Claude Code · local
   ```

   A `✓ Model: Claude Code` line appears when the model provider is signed in, and `!` warning lines appear for a missing model sign-in, unverifiable GitHub scopes, or an untrusted repository that has executable configuration.
6. **Session.** A full-screen view with the header `Asterweave vX | repo (branch)   /help · Esc to close` and a persistent composer at the bottom.

### In the session

| Input | Result |
| --- | --- |
| `/help` or `/commands` | Lists the slash commands |
| `/exit`, or Ctrl+D on an empty composer line | Leaves Asterweave (exit code 0). Ctrl+D with text in the composer does nothing, like a shell |
| `/sessions`, `/usage`, `/settings`, `/context` | Print "Not available in this build (agent sessions arrive in a later phase)." |
| `@` | Opens a completion list; the only entry is the connected repository (for example `@widgets`) |
| `/` | Opens the slash-command completion list. Tab or Enter completes, Up and Down move, Esc closes the list |
| Any other text, then Enter | Echoed into the on-screen transcript, followed by the "not available" line. Nothing is sent anywhere and nothing is saved |
| Ctrl+C | Leaves with exit code 130 |

In a picker or at the `trust grant` y/N prompt, Ctrl+D behaves like Esc: it cancels (exit 1 with the matching `*_CANCELLED` / `TRUST_DECLINED` code) and nothing is saved. A closed input stream is still an interrupt (130).

## Command reference

| Command | Purpose | Flags |
| --- | --- | --- |
| `asterweave` | Start the interactive session (the walkthrough above) | none. `--json` is rejected |
| `asterweave help [command]` | Show usage, or detailed help for one command | none |
| `asterweave --version`, `-v` | Print the version | none |
| `asterweave doctor` | Read-only health report. See [check ids](/cli/exit-codes#doctor-check-ids) | `--json` |
| `asterweave auth status` | Masked sign-in state of the three planes. See [Authentication](/cli/auth) | `--json`, `--host h` |
| `asterweave auth login [github\|model]` | Hand the terminal to `gh auth login --web` or `claude auth login`. With no plane in a terminal, shows a picker | `--host h` (GitHub only) |
| `asterweave auth logout github\|model` | Remove Asterweave's stored reference and print the provider's own logout command | `--host h` (GitHub only), `--json` |
| `asterweave repo connect` | Connect an existing local clone | `--repo owner/name`, `--branch name`, `--path dir`, `--json` |
| `asterweave repo status` | Show the saved connection, work-tree state (always `unknown`: the work tree is never inspected), and trust | `--json` |
| `asterweave config show` | Show effective configuration with the origin of every key. See [Configuration and trust](/cli/config-and-trust) | `--json`, `--strict`, `--path dir`, `--runner local`, `--github-host host`, `--ui-color auto\|always\|never` |
| `asterweave trust [status\|grant\|revoke]` | Review, grant, or revoke trust for a repository. Defaults to `status` | `--path dir`, `--json` |

Every command accepts `-h` / `--help`, which prints that command's help and exits 0.

`repo connect` details:

- In a terminal, any of `--repo` and `--branch` you leave out are chosen with pickers. With `--json`, or without a terminal, both `--repo` and `--branch` are required, otherwise the exit code is 2.
- `--path` defaults to the current directory. It must be an existing git work tree; Asterweave never clones.
- The clone's `origin` must be the same `owner/name` you chose, and the branch must exist locally or on `origin` (Asterweave never fetches).
- It reads the clone with a minimal git environment (no inherited tokens or `GIT_*` variables) and read-only git commands that never hash work-tree content, so it does not write to the repository and cannot trigger repository-configured filter drivers. The work-tree state is therefore not inspected: `dirty` is always `null` (unknown).

### JSON output

With `--json`, a command writes exactly one JSON object and a newline to stdout. Failures use the [error envelope](/cli/exit-codes#json-error-envelope). Values below are illustrative.

`doctor --json`:

```json
{"ok":true,"checks":[{"id":"node.version","status":"PASS","reason":"Node.js 22.22.0 (requires 22+).","remediation":null}]}
```

`auth status --json` (abridged; see [Authentication](/cli/auth#auth-status) for every field):

```json
{"ok":true,"planes":{"asterweave":{"status":"unavailable","code":"ACCOUNT_UNAVAILABLE"},"github":{"status":"ok","code":"OK","host":"github.com","account":"octocat"},"model":{"status":"ok","code":"OK","account":"an***@e***.com"}}}
```

`auth logout github --json`:

```json
{"ok":true,"plane":"github","droppedReference":true,"providerCommand":"gh auth logout -h github.com"}
```

`repo connect --json`:

```json
{"ok":true,"repository":"octocat/widgets","branch":"main","path":"C:\\work\\widgets","runner":"local"}
```

`repo status --json` when nothing is connected, and when connected:

```json
{"ok":true,"connected":false}
```

```json
{"ok":true,"connected":true,"repository":"octocat/widgets","branch":"main","path":"C:\\work\\widgets","runner":"local","connectedAt":"2026-01-01T00:00:00.000Z","currentBranch":"main","dirty":null,"trust":{"trusted":false,"reason":"NOT_GRANTED"}}
```

If the connected path has disappeared or is no longer a git work tree, `ok` is `false`, a `problem` of `REPO_PATH_MISSING` or `REPO_NOT_GIT` is added, and the exit code is 1.

`config show --json` and `trust ... --json` are shown in [Configuration and trust](/cli/config-and-trust).

## Non-TTY behavior

- **Unknown options exit 2.** Every command lists the options it accepts; anything else (for example `doctor --jsno`) fails with `Unknown option '--jsno'` before the command does anything, and in `--json` mode the error is the usual JSON envelope. An option that exists but does not apply to the chosen subcommand gets a subcommand-specific usage error instead (for example `repo status --path x`: `--path is not accepted by repo status; it only applies to repo connect`), also exit 2. `-h/--help` and `-v/--version` are always accepted.
- A bare `asterweave` without a terminal exits 2 with `interactive mode requires a TTY`. Use a subcommand with `--json` instead (`doctor --json`, `auth status --json`, `repo status --json`).
- `auth login` with no plane, `repo connect` without `--repo` and `--branch`, and `trust grant` without `--path` need a terminal or explicit flags; otherwise they exit 2.
- A corrupt `repo.json` is reported as a warning and treated as not connected (`repo connect` or the launch picker replaces it); a corrupt `trust.json` is treated as untrusted with a warning. Neither stops `launch`, `repo status` or `doctor`, and reads never rewrite either file. `trust grant` and `trust revoke` recreate a corrupt `trust.json`; `trust status` exits 1 on one. The text `repo status` output prints `Work tree   unknown` (the JSON `dirty` is `null`).
- A relative `ASTERWEAVE_CONFIG_DIR` is ignored (the platform default directory is used instead). When the user directory cannot be written, `doctor`'s `user-dir.writable` remediation tells you to set `ASTERWEAVE_CONFIG_DIR` to a writable **absolute** directory.
- Text taken from a repository, config file, remote URL or provider (names, paths, error messages) is stripped of terminal control sequences before it is printed; `--json` output escapes C1, bidirectional and U+2028/U+2029 characters as \u escapes.
- Output written to a pipe or file contains **no ANSI escape bytes**. Color is used only when stdout is a TTY and `NO_COLOR` is unset, subject to the `ui.color` setting (`never` disables it, `always` forces it unless `NO_COLOR` is set).
- With `--json`, stdout carries only the JSON object. Human-readable errors go to stderr only (exit codes: [Exit codes](/cli/exit-codes)).

## Terminal restore

The interactive screens use the alternate screen, hide the cursor, and put stdin in raw mode. On every way out (normal exit, `/exit`, Ctrl+C, SIGINT, an uncaught error, a closed input stream, or process exit) Asterweave switches raw mode off, shows the cursor again (`ESC[?25h`), leaves the alternate screen (`ESC[?1049l`), and turns bracketed paste off. Restoring twice is harmless. Resizing the terminal redraws the current screen.

If a terminal is ever left in a bad state anyway (for example after killing the process with SIGKILL, which no program can intercept), run `reset` on macOS and Linux, or open a new tab on Windows.

### Windows terminals

The full-screen views need a real console. Use **Windows Terminal**, or the classic console host (`cmd.exe` and PowerShell windows). **mintty** (the default Git Bash window) without `winpty` makes Node report that stdin and stdout are not TTYs, so `asterweave` exits with code 2 even though the window looks interactive. Subcommands such as `doctor` and `auth status` work in any shell; only the interactive screens, pickers, and `auth login` with no plane need a real console.

## Runner and security boundaries

- **Local only.** The only runner is `local`: everything happens on your machine, in your repository, under your account. There is no hosted backend, and no data is sent to an Asterweave service.
- **Provider sign-in belongs to the providers.** `gh` and `claude` hold your tokens. Asterweave stores references only and never passes `--show-token`. See [Authentication](/cli/auth).
- **No repository-controlled commands run in Phase A.** Quality-gate commands, `.claude/settings*.json` hooks, and `.mcp.json` servers are only detected and counted. See [what counts as executable](/cli/config-and-trust#what-counts-as-executable).
- **No `claude -p`, no `claude doctor`.** Asterweave never starts a Claude Code agent run, and never calls `claude doctor` because that command can start the stdio servers declared in a repository's `.mcp.json`.
- **Probes run outside your repository.** `gh auth status` and `claude auth status` run with the Asterweave user directory as their working directory, so a repository's `.claude/settings.json` is never loaded by them.
- **No shell.** Programs are started from an argument array with `shell: false`. Host names are validated before they are placed in a command line.
- **Secrets are redacted.** Output, JSON, and error messages pass through a redactor that collapses token-shaped strings to a prefix and masks email addresses.

## Troubleshooting with `doctor`

Run `asterweave doctor` first. It prints one row per check, with a remediation under every row that is not `PASS`. The most common outcomes:

| Check id | You see | Do this |
| --- | --- | --- |
| `node.version` FAIL | Node is older than 22 | Install Node.js 22 or newer |
| `user-dir.writable` FAIL | Cannot write to the user directory | Make it writable, or set `ASTERWEAVE_CONFIG_DIR` to a writable absolute path |
| `config.valid` FAIL | A bad value or corrupt `config.json` | Fix the key and file named in the reason; see [Configuration and trust](/cli/config-and-trust) |
| `github.install` FAIL | `gh` not found | Install the [GitHub CLI](https://cli.github.com/) |
| `github.auth` FAIL | Not signed in, or expired / revoked | `asterweave auth login github`, or the `gh auth refresh` command shown |
| `github.scopes` FAIL | `repo` or `read:org` missing | `gh auth refresh -h github.com -s repo,read:org` |
| `model.claude` WARN | Claude Code missing or signed out | `asterweave auth login model`. Optional |
| `repo.connection` WARN | No repository connected | `asterweave repo connect --repo owner/name --branch main` |
| `repo.connection` FAIL | The connected path is gone | `asterweave repo connect --path` pointing at the clone |
| `repo.trust` WARN | The repository has executable config that is not trusted | Review it, then `asterweave trust grant --path ...` |

Full list of check ids and statuses: [Exit codes and doctor](/cli/exit-codes#doctor-check-ids).

## Fixture vs live coverage

The CLI has an automated test suite (`npm run test:cli` from the repository root, using `node:test`). Be clear about what it does and does not prove:

- **Exercised with stand-ins.** `gh` and `claude` are replaced by stub programs on a fake `PATH` (and by injected `spawn` functions), and terminals are replaced by fake TTY streams. Sign-in states such as denied scopes, an error state, empty scopes, `loggedIn:false`, and garbage output are canned fixtures. Real subprocess tests run `bin/asterweave.mjs` itself and check exit codes, that stdout carries only JSON, and that errors go to stderr only.
- **Not exercised in automated tests.** A real `gh` or `claude`, a real browser or device login, a genuinely expired or revoked token, the real shape of a *logged-out* `claude auth status`, and rendering in a real Windows console host, mintty, or other terminal emulator.
- **Manual smoke.** The author ran `doctor`, `auth status`, and `config show` against a real, signed-in `gh` and `claude` on Windows 11, and they succeeded. The interactive launch, a real login hand-off, and non-Windows platforms have not been run live.

Treat the logged-out and expired-token paths as best effort. If they misbehave, `asterweave doctor --json` output (which contains no secrets) is the most useful thing to attach to a bug report.

## Related

- [Authentication](/cli/auth): the three planes, reason codes, and sign-in troubleshooting
- [Configuration and trust](/cli/config-and-trust): precedence, keys, user directory, and the trust store
- [Exit codes and doctor](/cli/exit-codes): every exit code, the JSON error envelope, and check ids
