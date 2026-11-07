---
sidebar_position: 4
title: Exit codes and doctor
description: "Every exit code of the Asterweave CLI, the JSON error envelope, which stream gets what, and the stable doctor check ids and statuses."
---

# Exit codes and doctor

The CLI returns a small, stable set of exit codes. The same table is printed by `asterweave help`.

## Exit codes

| Code | Meaning | Typical causes |
| --- | --- | --- |
| `0` | OK | The command succeeded. `doctor` with only `PASS` and `WARN`; `auth status` with a signed-out model provider; `/exit` or Ctrl+D on an empty composer line in a session; `trust revoke` for a repository that was not trusted |
| `1` | Error, or any doctor `FAIL` | `doctor` found a `FAIL` check. `repo connect` problems such as `REPO_NOT_GIT`, `REPO_NO_ORIGIN`, `REPO_ORIGIN_MISMATCH`, `REPO_BRANCH_NOT_FOUND`. `repo status` when the connected path has disappeared. `git` missing. `gh repo list` failing. A corrupt or unwritable file in the user directory (including `trust status` on a corrupt `trust.json`). `trust` problems: a path that does not exist (`REPO_PATH_INVALID`), a declined confirmation (`TRUST_DECLINED`), or governing files that changed between the preview and the grant (`TRUST_CHANGED_DURING_GRANT`). Esc or Ctrl+D in a picker or at the `trust grant` y/N prompt (`LOGIN_CANCELLED`, `LAUNCH_CANCELLED`, `REPO_CONNECT_CANCELLED`, `TRUST_DECLINED`). `TRUST_STORE_BUSY`: another Asterweave process held the `trust.json.lock` file for the whole 2 second wait. A provider login that could not start. Any unexpected failure, including an uncaught exception in the interactive session (the terminal is restored first; Node prints the error and exits `1`) |
| `2` | Usage error, or a TTY is required | Unknown command or subcommand, missing or extra arguments, an invalid host, `--json` with the bare launch or `auth login`, `repo connect` without `--repo` and `--branch` in a non-interactive context, `trust grant` without `--path` in a non-interactive context, and a bare `asterweave` with no terminal |
| `3` | Authentication required or invalid | `auth status` when GitHub is signed out, expired, or missing scopes. Interactive launch when `gh` is missing or unreadable. `auth login` when `gh` or `claude` is missing, or the sign-in still fails the re-check. `repo connect` when `gh repo list` reports that you are not authenticated |
| `4` | Repository trust required | `config show --strict` when the repository has executable config (quality-gate commands, Claude Code settings, MCP servers) and is not trusted (`TRUST_REQUIRED`; the remediation is `asterweave trust grant --path <path>`, with the path quoted for the platform shell when needed; on Windows a path that cmd.exe or PowerShell would still expand is printed on its own line instead of inside the command). Without `--strict`, untrusted configuration is only a skipped key in `config show`, a `repo.trust` warning in `doctor`, and a launch banner warning, and the exit code stays 0. Any later operation that must run trusted configuration uses the same code |
| `5` | Configuration invalid | A bad value in the user `config.json`, an environment variable, a flag, or the repository adapter, or a `config.json` that is not valid JSON. Returned by `config show`, by `auth status` / `auth login` (which resolve the GitHub host from configuration), and by interactive `launch` and `repo connect` when the configuration is invalid, or when `github.host` is not `github.com` (`GITHUB_HOST_UNSUPPORTED`; this build supports github.com only for those two commands). A repository adapter that cannot be read as a regular file is also a configuration error. `doctor` reports the same problem as a `config.valid` `FAIL`, so its own exit code is `1` |
| `130` | Interrupted | Ctrl+C or SIGINT during a picker, the session, or a provider login hand-off. A closed input stream (not Ctrl+D) in a picker or at the y/N prompt. A provider login whose process was killed or exited non-zero (`LOGIN_INTERRUPTED`). Nothing is saved |

Examples:

```bash
asterweave doctor --json            # exit 1 when any check is FAIL, otherwise 0
asterweave auth status              # exit 3 when GitHub is not usable
ASTERWEAVE_RUNNER=docker asterweave config show   # exit 5
asterweave bogus                    # exit 2
asterweave < /dev/null              # exit 2: interactive mode requires a TTY
```

The same reason code can map to different exit codes in different commands. For example a missing `gh` is `GH_NOT_INSTALLED` with exit 3 in `auth` and the launch gate, but exit 1 when `repo connect` tries to list repositories, because there it is a tooling error rather than a sign-in decision. Read the error `code` and `remediation` rather than inferring from the exit code alone. See the [reason code table](/cli/auth#reason-codes).

## Error codes

Errors carry a stable machine-readable `code`. The ones you are most likely to see:

| Code | Exit | Where |
| --- | --- | --- |
| `USAGE` | 2 | any command |
| `CONFIG_INVALID` | 5 | `config show`, `auth`, `launch`, `repo connect` |
| `GITHUB_HOST_UNSUPPORTED` | 5 | interactive `launch`, `repo connect` (`github.host` is not `github.com`) |
| `TRUST_DECLINED` | 1 | `trust grant` (the y/N confirmation was not answered `y`; nothing changed) |
| `TRUST_CHANGED_DURING_GRANT` | 1 | `trust grant` (a governing file changed after the preview; nothing was granted) |
| `TRUST_REQUIRED` | 4 | `config show --strict` (executable repository config that is not trusted) |
| `TRUST_STORE_BUSY` | 1 | `trust grant`, `trust revoke` (the trust store lock was held for the whole wait) |
| `REPO_INVALID`, `REPO_BRANCH_INVALID` | 2 | `repo connect` (value not in `owner/name` form, or not a usable branch name) |
| `REPO_PATH_INVALID`, `REPO_NOT_GIT`, `REPO_NO_ORIGIN`, `REPO_ORIGIN_MISMATCH`, `REPO_BRANCH_NOT_FOUND`, `REPO_BRANCHES_FAILED`, `REPO_NONE_FOUND`, `REPO_RECORD_INVALID` | 1 | `repo`, launch, `trust` (`REPO_PATH_INVALID`) |
| `GIT_NOT_INSTALLED`, `GIT_FAILED` | 1 | `repo` |
| `GH_NOT_INSTALLED`, `GH_SHELL_SHIM_ONLY`, `GH_REPO_LIST_FAILED`, `GH_OUTPUT_UNPARSEABLE` | 1 | `repo` (listing repositories) |
| `GH_*` and `CLAUDE_*` reason codes | 3 | `auth`, launch (see [Authentication](/cli/auth#reason-codes)) |
| `LOGIN_INTERRUPTED` | 130 | `auth login`, launch |
| `GH_LOGIN_FAILED`, `CLAUDE_LOGIN_FAILED`, `LOGIN_CANCELLED`, `LAUNCH_CANCELLED`, `REPO_CONNECT_CANCELLED` | 1 | `auth login`, launch, `repo connect` |
| `STORE_CORRUPT`, `STORE_UNREADABLE`, `STORE_WRITE_FAILED`, `CREDENTIAL_REFERENCE_INVALID`, `CREDENTIAL_REFERENCE_SECRET` | 1 | any command touching the user directory. For a corrupt `trust.json` the remediation is to run `trust revoke` or `trust grant`, which replace it |
| `UNEXPECTED` | 1 | an unanticipated failure (JSON envelope only) |

## JSON error envelope

When a command is run with `--json` and fails, stdout carries exactly one object and stderr stays empty:

```json
{"ok":false,"error":{"code":"CONFIG_INVALID","message":"Invalid value for 'runner' (flag): expected one of local","remediation":null}}
```

- `code` is the stable identifier from the table above.
- `message` is human-readable and has passed through the secret redactor.
- `remediation` is a suggested next step, or `null`.

An error found while parsing the command line itself (for example a malformed option such as `--=x`) happens before the command knows it was asked for JSON, so it is reported as text on stderr.

Strings in the JSON (values and object keys) never contain raw C1 control, bidirectional-control or U+2028/U+2029 characters: they are written as \u escapes (backslash, u, four hex digits), so the output parses to the same data but is safe to print.

Without `--json`, an error is written to stderr as `Asterweave <area> error: <message>`, where `area` is the command name (or `CLI`), followed on the next line by the remediation when there is one:

```text
Asterweave launch error: interactive mode requires a TTY; use --json or a TTY terminal
Run asterweave in a terminal, or use a subcommand such as `asterweave doctor --json`.
```

(The launch command itself does not accept `--json`. Use a subcommand with `--json`, such as `doctor --json`.) An unknown command prints `Asterweave CLI error: unknown command '...'` followed by the usage text on stderr and exits 2.

## stdout and stderr

- **stdout** carries results: human-readable output, or the single JSON object with `--json`. `help`, `--version`, and per-command `--help` also go to stdout.
- **stderr** carries errors only (and the usage text after an unknown command).
- A `doctor` `FAIL` is data, not an error message. The report goes to stdout and the exit code is 1. With `doctor --json`, stderr is empty.
- `repo status` is the one command that prints both: if the connected path has vanished it prints the status to stdout and the error to stderr, then exits 1.
- When stdout is not a TTY (a pipe or file), or `NO_COLOR` is set, output contains no ANSI escape sequences.
- Tokens, `Bearer` values, and credentials embedded in URLs are redacted from everything printed, and email addresses are masked.

## Doctor check ids

`asterweave doctor` is read-only, never prints a command's text or a secret, and always reports these ids in this order. Statuses are `PASS`, `WARN`, and `FAIL`. Only `FAIL` changes the exit code (to 1); `ok` in the JSON is `true` when no check is `FAIL`.

| Id | PASS | WARN | FAIL |
| --- | --- | --- | --- |
| `node.version` | Node.js 22 or newer | none | Older than 22, or the version could not be determined |
| `user-dir.writable` | The user directory can be created and written (a temporary probe file is written and removed) | Writable, but the probe file could not be removed | The directory cannot be written. Set `ASTERWEAVE_CONFIG_DIR` to a writable absolute path |
| `config.valid` | The layered configuration resolves | none | An invalid value or an unreadable or corrupt file; the reason names the key and origin |
| `github.install` | `gh` found | none | `gh` not found (`GH_NOT_INSTALLED`) |
| `github.auth` | Signed in to the host | Skipped because `gh` is missing, or the sign-in state could not be read | Not signed in, or expired or revoked (`GH_NOT_AUTHENTICATED`, `GH_AUTH_INVALID`) |
| `github.scopes` | `repo` and `read:org` covered | Scopes unknown (`GH_SCOPES_UNKNOWN`), or skipped | A required scope is missing (`GH_SCOPE_MISSING`) |
| `model.claude` | Claude Code signed in | Any other state: not installed, shim only, signed out, or unreadable. Never a `FAIL` | none |
| `account.asterweave` | Always: `unavailable: no hosted backend configured` | none | none |
| `repo.connection` | A usable clone is connected | Nothing connected, or the status could not be read | The connected path no longer exists or is no longer a git work tree |
| `repo.trust` | The repository is trusted, or there is no repository to evaluate | The repository is untrusted or its trust status could not be read. The reason lists the kinds of executable config found | none |

`repo.trust` evaluates the connected clone, or else the current directory when it contains any of the four trust-governing files.

Each check is `{"id","status","reason","remediation"}`; `remediation` is `null` for a `PASS` and appears under every other row in text output. The text report ends with a summary line such as `No blocking problems: 8 PASS, 2 WARN, 0 FAIL`, or `Blocking problems found: ...` when any check failed.

```text
PASS  node.version        Node.js 22.22.0 (requires 22+).
PASS  github.auth         Signed in to github.com as octocat.
WARN  repo.connection     No repository is connected.
                        -> asterweave repo connect

No blocking problems: 8 PASS, 2 WARN, 0 FAIL
```

(Abridged: a real report has one row for each of the ten ids.)

## Related

- [CLI overview](/cli/overview)
- [Authentication](/cli/auth)
- [Configuration and trust](/cli/config-and-trust)
