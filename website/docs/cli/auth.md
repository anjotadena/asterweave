---
sidebar_position: 2
title: Authentication
description: "How the Asterweave CLI signs in through gh and claude, what it stores, every reason code with its fix, and how to troubleshoot sign-in."
---

# Authentication

The CLI never holds your credentials. It asks the tools that do (`gh` for GitHub, `claude` for Claude Code), shows you the result with personal data masked, and keeps only a small **reference** that says which sign-in it relies on.

## Three separate planes

Sign-in state is tracked as three independent planes. One never stands in for another.

| Plane | Provided by | Required to start a session? | What a problem looks like |
| --- | --- | --- | --- |
| **GitHub** | the GitHub CLI, `gh` | **Yes.** Interactive launch runs the sign-in step first | Exit code 3 for `auth status`, a sign-in screen at launch |
| **Model provider** | Claude Code, `claude` | No | A warning line in the launch banner; `WARN` in `doctor` |
| **Asterweave account** | none (no hosted backend) | No | Always reported as `unavailable: no hosted backend configured`. Informational only |

Signing in to the model provider does not satisfy the GitHub requirement, and the "Browser sign-in" choice on the launch sign-in screen is the model provider.

## Delegation to `gh` and `claude`

| What Asterweave needs | Command it runs | Notes |
| --- | --- | --- |
| GitHub sign-in state | `gh auth status --json hosts` | `gh` exits 0 even when you are signed out, so the decision is made from the JSON, not the exit code. Never `--show-token` or `-t` |
| Claude Code sign-in state | `claude auth status` | Read as JSON. The logged-out output has not been verified against a real install, so parsing is tolerant: `loggedIn:false`, or a failing exit without `loggedIn:true`, both mean not signed in |
| GitHub sign-in | `gh auth login --web -h HOST -s repo,read:org` | Terminal handed to `gh` with inherited stdio |
| Claude Code sign-in | `claude auth login` | Terminal handed to `claude` with inherited stdio |

Rules that apply to every call:

- Programs are started from an argument array, never through a shell. On Windows, `claude.exe` is preferred over `claude.cmd`; if only a `.cmd` shim exists the result is `CLAUDE_SHELL_SHIM_ONLY`.
- The probes run with the Asterweave [user directory](/cli/config-and-trust#user-directory) as their working directory, so a repository's `.claude/settings.json` is never loaded by them.
- Asterweave never calls `claude doctor` or `claude -p`, and has no `--token` option.
- Required GitHub scopes are `repo` and `read:org`. `write:org` and `admin:org` also satisfy `read:org`.

## What is stored: references only

`credentials.json` in the [user directory](/cli/config-and-trust#user-directory) holds only the references written by a successful `auth login` (including the sign-in step at launch). It never contains a token. Every reference is checked against a closed schema before it is written, and any token-shaped or unmasked-email value makes the write fail.

```json
{
  "version": 1,
  "references": {
    "github": {
      "provider": "github",
      "source": "gh-cli",
      "host": "github.com",
      "account": "octocat",
      "verifiedAt": "2026-01-01T00:00:00.000Z"
    },
    "model": {
      "provider": "model",
      "source": "claude-cli",
      "account": "an***@e***.com",
      "authMethod": "claude.ai"
    }
  }
}
```

Files are written atomically (a temporary file, then a rename, retried on Windows file locks). On macOS and Linux they are mode `0600`. Unknown keys or hand-edited content that fails validation is ignored, not trusted.

## Masking

- Email addresses are masked: `person@example.com` becomes `pe***@e***.com`.
- Token-shaped strings (GitHub personal-access and OAuth tokens, Anthropic and other API keys, JWTs, `Bearer` values, private key blocks, and credentials embedded in URLs) are reduced to a well-known prefix plus an ellipsis, or replaced with `[redacted]`.
- All of `auth`, `doctor`, `config show`, and error messages go through this redaction.

## `auth status`

```bash
asterweave auth status [--json] [--host github.example.com]
```

Text output:

```text
GitHub: signed in as octocat (github.com) scopes ok
Model provider (Claude Code): signed in as an***@e***.com (claude.ai)
Asterweave account: unavailable (no hosted backend configured)
```

When GitHub is not usable, its line is the reason followed by an arrow line with the fix. A model-provider problem adds `(warning only: Asterweave can still start without a model sign-in)`.

The exit code is **0** unless GitHub is in a failing state, in which case it is **3**. A signed-out model provider, an unknown-scope warning, or the unavailable Asterweave account never changes it.

`--json` fields per plane:

| Plane | Fields |
| --- | --- |
| all | `plane`, `status` (`ok`, `warn`, `fail`, or `unavailable`), `code`, `reason`, `remediation` |
| `github` | plus `host`, `account`, `scopes` (array), `scopesKnown`, `tokenSource` (for example `keyring` or an environment variable name, never the token) |
| `model` | plus `account` (masked), `authMethod`, `apiProvider`, `orgName`, `subscriptionType` |

The top-level `ok` is `false` only when GitHub's `status` is `fail`.

## `auth login`

```bash
asterweave auth login            # picker (terminal required)
asterweave auth login github     # [--host github.example.com]
asterweave auth login model
```

- With no plane, a terminal is required: the picker offers `GitHub (recommended)` and `Browser sign-in` (the model provider). Without a terminal the command exits 2.
- `--json` is rejected (exit 2) because login is interactive. `--host` applies to GitHub only (exit 2 with `model`).
- The terminal is handed to `gh` or `claude`. When it returns, Asterweave **re-checks the sign-in**. Only if the re-check passes does it write the reference and print `✓ Signed in: ...` and `Asterweave stored a reference only; no token is kept.`
- If GitHub still fails the check (for example the scopes you approved are not enough), the command exits 3 with that reason code and nothing is written. The same applies to the model provider.
- **Interrupted login.** Ctrl+C or SIGINT during the hand-off, the provider process being killed by a signal, or the provider exiting with a non-zero status all end as `LOGIN_INTERRUPTED` with exit code 130, with no partial reference written. A denied browser authorization usually ends this way.
- If the provider process cannot be started, the error is `GH_LOGIN_FAILED` or `CLAUDE_LOGIN_FAILED` (exit 1). If the program is not installed, you get the install code (`GH_NOT_INSTALLED`, `CLAUDE_NOT_INSTALLED`, or `CLAUDE_SHELL_SHIM_ONLY`) with exit 3.
- Pressing Esc in the picker exits 1 with `LOGIN_CANCELLED` (nothing saved). Ctrl+C there exits 130.

## `auth logout`

```bash
asterweave auth logout github    # [--host github.example.com] [--json]
asterweave auth logout model
```

Logout is **reference-only**. It removes Asterweave's stored reference for that plane and prints the provider's own command for you to run. It never signs you out of GitHub or Claude Code itself and never starts `gh` or `claude`.

```text
Removed Asterweave's stored reference (no provider sign-out performed).
To sign out of GitHub run: gh auth logout -h github.com
```

If no reference was stored, the first line says so (`No Asterweave reference was stored ...`) and the exit code is still 0. For GitHub the host in the printed command is `--host`, otherwise the host in the stored reference, otherwise `github.com`. With `--json`: `{"ok":true,"plane":"github","droppedReference":true,"providerCommand":"gh auth logout -h github.com"}`.

## Which host is used

| Command | GitHub host |
| --- | --- |
| `auth status`, `auth login` | `--host`, else the `github.host` [config key](/cli/config-and-trust#configuration-keys) (default `github.com`) |
| `auth logout` | `--host`, else the stored reference's host, else `github.com` |
| `doctor` | the `github.host` config key |
| Interactive launch, `repo connect` | `github.com` only in this build. If the effective `github.host` (config file, `ASTERWEAVE_GITHUB_HOST`) is anything else, both commands fail immediately with exit 5, code `GITHUB_HOST_UNSUPPORTED` and the message `launch and repo connect support github.com only in this build; github.host is <host> (origin: <origin>)`, before any probe or picker. Unset `github.host`, or use `auth status` / `doctor`, which do honour it |

`--host` is validated before anything is probed or opened: an invalid value exits 2 without spawning `gh`.

## Reason codes

Every probe result carries a stable `code`. The `status` column is what `auth status` reports; [`doctor`](/cli/exit-codes#doctor-check-ids) maps these to `PASS`, `WARN`, or `FAIL`.

| Code | Plane | Status | Meaning | Remediation |
| --- | --- | --- | --- | --- |
| `OK` | github, model | `ok` | Signed in and, for GitHub, `repo` and `read:org` present | none |
| `GH_NOT_INSTALLED` | github | `fail` | `gh` not found on `PATH` | Install the [GitHub CLI](https://cli.github.com/) and re-run |
| `GH_NOT_AUTHENTICATED` | github | `fail` | No signed-in account for the host | `gh auth login --web -h HOST -s repo,read:org` |
| `GH_AUTH_INVALID` | github | `fail` | The host entry is not in the `success` state, which covers an expired or revoked token | `gh auth refresh -h HOST` |
| `GH_SCOPE_MISSING` | github | `fail` | The token lacks `repo` or `read:org` | `gh auth refresh -h HOST -s repo,read:org`. If the token comes from a `GH_` or `GITHUB_` environment variable, unset it or use one with those scopes |
| `GH_SCOPES_UNKNOWN` | github | `warn` | Signed in, but `gh` reports no scopes (an environment or fine-grained token). Access is not verified | If repository access fails, run `gh auth login --web -h HOST -s repo,read:org` |
| `GH_STATUS_UNPARSEABLE` | github | `fail` | `gh auth status --json hosts` output could not be read, or `gh` could not run | Upgrade `gh` (2.40 or newer), or check that `gh --version` runs |
| `CLAUDE_NOT_INSTALLED` | model | `fail` | `claude` not found on `PATH` | Install the native Claude Code build so `claude.exe` is on `PATH` |
| `CLAUDE_SHELL_SHIM_ONLY` | model | `fail` | Only a `.cmd` or `.bat` shim exists, and Asterweave never uses a shell | Install the native build |
| `CLAUDE_NOT_AUTHENTICATED` | model | `fail` | `loggedIn` is false, or `claude auth status` exited non-zero without reporting a sign-in | `claude auth login` (or `asterweave auth login model`) |
| `CLAUDE_STATUS_UNPARSEABLE` | model | `fail` | `claude auth status` output could not be read, or `claude` could not run | Upgrade Claude Code (`claude update`), or check that `claude --version` runs |
| `ACCOUNT_UNAVAILABLE` | asterweave | `unavailable` | There is no hosted backend in Phase A | none; informational |

`fail` for the model plane never blocks anything: it is a warning in the launch banner and `WARN` in `doctor`. Login-flow codes (error envelope only): `LOGIN_INTERRUPTED` (130), `GH_LOGIN_FAILED` and `CLAUDE_LOGIN_FAILED` (1), `LOGIN_CANCELLED` and `LAUNCH_CANCELLED` (1).

## Troubleshooting

**Denied or missing scopes.** `GH_SCOPE_MISSING` means `gh` is signed in but without `repo` or `read:org`. Run `gh auth refresh -h github.com -s repo,read:org`, approve every scope in the browser, then `asterweave auth status`. If you denied the authorization in the browser, `gh` normally exits non-zero and Asterweave reports `LOGIN_INTERRUPTED` (exit 130) with nothing saved; just run the login again. If the token comes from `GH_TOKEN` or `GITHUB_TOKEN`, `gh auth refresh` cannot change it: unset the variable or use a token with the right scopes.

**Expired or revoked sign-in.** `GH_AUTH_INVALID` reports the host's state and says the token may be expired or revoked. Run `gh auth refresh -h github.com`; if that fails, `gh auth login --web -h github.com -s repo,read:org`. At interactive launch the sign-in screen appears automatically for this code.

**Interrupted login.** Exit 130 with `sign-in was interrupted; nothing was saved` is safe: no reference was written, and your existing `gh` or `claude` state is whatever the provider left it. Run `asterweave auth status` to see where you stand, then retry.

**Headless or remote machine.** `asterweave` itself needs a terminal. For scripts, use `auth status --json` and `doctor --json`, which never prompt. To sign in on a machine with no browser, run `gh auth login` yourself in a session where you can complete the web flow (the web flow gives a one-time code and a URL you can open on another device), then confirm with `asterweave auth status`. If you supply a token through `GH_TOKEN`, scopes cannot be determined and the result is `GH_SCOPES_UNKNOWN` (a warning, exit 0).

**`claude` is installed but reported as not installed.** On Windows, a `claude.cmd` shim from `npm` is not run. Install the native build so `claude.exe` is on `PATH`; `asterweave doctor` prints which code applied.

:::note Not verified live
The expired-token, revoked-token, denied-scope, and logged-out `claude auth status` cases are driven by recorded fixtures and stub programs, not by real accounts. See [Fixture vs live coverage](/cli/overview#fixture-vs-live-coverage).
:::

## Related

- [CLI overview](/cli/overview)
- [Exit codes and doctor](/cli/exit-codes)
- [Configuration and trust](/cli/config-and-trust)
