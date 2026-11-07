---
sidebar_position: 3
title: Configuration and trust
description: "How the Asterweave CLI layers configuration, which keys exist, where its user files live, and how repository trust is granted, revoked, and invalidated."
---

# Configuration and trust

The CLI resolves one **effective configuration** from several layers and shows you where every value came from. A repository's own configuration can make programs run, so the parts of it that are executable are applied only after you explicitly trust the repository.

## Precedence

From lowest to highest:

1. **default**: built into the CLI.
2. **user**: `config.json` in the [user directory](#user-directory).
3. **repo**: the repository's `.claude/asterweave.json` (the same file the plugin uses, read-only here). Executable fields are applied only when the repository is [trusted](#trust-store).
4. **env**: `ASTERWEAVE_*` environment variables. An empty variable is ignored.
5. **flag**: command-line flags (`config show` accepts `--runner`, `--github-host`, `--ui-color`, and `--path` to layer in a specific repository under the usual trust rules, and `--strict`, see [`config show --strict`](#config-show---strict)).

A higher layer replaces a lower one key by key. An invalid value in **any** layer stops the command with exit code 5 and names the key and where it came from.

Which repository counts as the "repo" layer: the connected clone from `asterweave repo connect` when that path still exists, otherwise the current directory.

## Configuration keys

Only the keys below exist. Anything else in `config.json` is listed as ignored and never applied.

| Key | Values | Default | Env variable | Flag | Notes |
| --- | --- | --- | --- | --- | --- |
| `runner` | `local` | `local` | `ASTERWEAVE_RUNNER` | `--runner` | Phase A has only the local runner |
| `github.host` | a host name, optionally with a port | `github.com` | `ASTERWEAVE_GITHUB_HOST` | `--github-host` | Used by `auth status`, `auth login`, and `doctor`. Interactive launch and `repo connect` always use `github.com` in this build |
| `ui.color` | `auto`, `always`, `never` | `auto` | `ASTERWEAVE_UI_COLOR` | `--ui-color` | Applied to the text output of `launch` and `doctor`. `never` turns color off; `always` forces it on even when stdout is not a TTY; `auto` colors only on a TTY. `NO_COLOR` (when set and non-empty) always wins, even over `always` |
| `provider.workItems` | `github`, `azure-devops`, `none` | `none` | `ASTERWEAVE_PROVIDER_WORKITEMS` | none | May also come from the repository adapter. Shown only: nothing in the CLI uses it yet. The plugin's skills treat an absent value as `github`, but the CLI's own default for this key is `none` |
| `qualityGates.required` | array of `id`, `command`, `source` (and optional `timeoutSeconds`) | `[]` | none | none | **Executable.** Repository adapter only; not settable in `config.json`, env, or flags. Applied only for a trusted repository |
| `hooks` | array of hook entries (`id`, `event`, `argv`, `kind`, `timeoutMs`, `onFailure`) | none | none | none | **Executable.** Repository adapter only (user hooks live in `hooks.json`, see [Hooks](/cli/hooks)). Validated on every read; loaded and run only for a trusted repository. Not shown by `config show` |

Beyond these keys, the repository's `.claude/asterweave.json` is checked for `"version": 1` and for unknown top-level properties (either one is a configuration error, exit 5). The full schema is enforced by the plugin; the other adapter sections (`routing`, `completion`, `handoff`, `autoContinue`) are accepted and ignored by the CLI. The `hooks` section is validated (an invalid entry is a configuration error, exit 5) and used by [`run`](/cli/runs) only when the repository is trusted.

### A user `config.json`

Keys can be nested or written flat; both of these are the same setting.

```json
{
  "github": { "host": "github.example.com" },
  "ui.color": "never"
}
```

## `config show`

```bash
asterweave config show [--json] [--strict] [--path dir] [--runner local] [--github-host host] [--ui-color auto|always|never]
```

Rows are `key`, `value`, and `(origin)`, where origin is `default`, `user:<file>`, `repo:<file>`, `env:<NAME>`, or `flag`. Key names that look secret (containing `password`, `secret`, `token`, `api_key`, `credential`, or `auth`) show `[redacted]`, and token-shaped or email-shaped values are redacted.

A default run with nothing set:

```text
runner                 local       (default)
github.host            github.com  (default)
ui.color               auto        (default)
provider.workItems     none        (default)
qualityGates.required  []          (default)

Precedence (lowest to highest): default < user < repo < env < flag
Repository: C:\work\widgets (untrusted: NOT_GRANTED; no .claude/asterweave.json)
```

A run with a user config, an environment variable, and an untrusted repository adapter that contains a quality gate:

```text
runner                 local            (env:ASTERWEAVE_RUNNER)
github.host            ghe.example.com  (user:C:\Users\octocat\AppData\Roaming\asterweave\config.json)
ui.color               auto             (default)
provider.workItems     github           (repo:C:\work\widgets\.claude\asterweave.json)
qualityGates.required  []               (default)

Precedence (lowest to highest): default < user < repo < env < flag
Repository: C:\work\widgets (untrusted: NOT_GRANTED)
Note: repository config C:\work\widgets\.claude\asterweave.json was only partly applied: qualityGates.required skipped because the repository is not trusted.
      Review it, then run: asterweave trust grant --path C:\work\widgets
Ignored unknown keys: bogus
```

Note that `provider.workItems` (not executable) is applied from the untrusted repository, while `qualityGates.required` is skipped and reported. After `trust grant`, the same run shows the gate with its `repo:` origin.

`--json` output has the shape below. `repo` is `null` when no repository applies.

```json
{
  "ok": true,
  "precedence": ["default", "user", "repo", "env", "flag"],
  "entries": {
    "runner": { "value": "local", "origin": "default" },
    "github.host": { "value": "github.com", "origin": "default" }
  },
  "unknown": [],
  "repo": {
    "path": "C:\\work\\widgets",
    "file": "C:\\work\\widgets\\.claude\\asterweave.json",
    "hasAdapter": true,
    "trusted": false,
    "trustReason": "NOT_GRANTED",
    "hash": "0000000000000000000000000000000000000000000000000000000000000000",
    "skipped": ["qualityGates.required"]
  }
}
```

(`entries` is abridged to two keys; the real output lists all five.) An invalid value exits 5: for example `ASTERWEAVE_RUNNER=docker asterweave config show --json` prints `{"ok":false,"error":{"code":"CONFIG_INVALID",...}}`.

### `config show --strict`

By default `config show` exits 0 for an untrusted repository and reports the skipped executable keys. With `--strict` it instead exits **4** (`TRUST_REQUIRED`) when the repository has executable config (a quality-gate command, a repository hook, `.claude/settings*.json`, or `.mcp.json`) and is not trusted, writes nothing to stdout, and prints `asterweave trust grant --path <path>` as the remediation (the path is quoted when it contains anything but plain path characters: single quotes on macOS and Linux, double quotes on Windows so the command works in both cmd.exe and PowerShell; a Windows path that either shell would still expand, for example one containing `%`, `!`, `$` or a backtick, is never put in the command: the command shows `<path>` and the path follows on its own line with the note to quote it for your shell). With `--json` the usual error envelope is printed. A trusted repository, or one with no executable config, exits 0 as normal. The check is the same trust check later operations use, and it never prints command text.

## User directory

The CLI keeps four small files in one directory:

| Platform | Location |
| --- | --- |
| Windows | `%APPDATA%\asterweave` (falls back to `<home>\AppData\Roaming\asterweave`) |
| macOS | `~/Library/Application Support/asterweave` |
| Linux and others | `$XDG_CONFIG_HOME/asterweave` if that variable is an absolute path, otherwise `~/.config/asterweave` |
| Any | `ASTERWEAVE_CONFIG_DIR`, if set to an **absolute** path (a relative value is ignored) |

| File | Contents |
| --- | --- |
| `config.json` | your settings (optional; you create it) |
| `credentials.json` | [credential references](/cli/auth#what-is-stored-references-only), never tokens |
| `trust.json` | the [trust store](#trust-store) |
| `repo.json` | the connection made by `repo connect`: repository, branch, path, runner, and time |

Writes are atomic (temporary file then rename, retried on Windows file locks), directories are created mode `0700` and files `0600` on macOS and Linux. A file that exists but is not valid JSON is never overwritten or deleted by a read; for `config.json` it is a configuration error (exit 5) naming the file.

## What counts as executable

"Executable" means repository content that can cause a program to run:

| Source | Why it matters |
| --- | --- |
| `qualityGates.required[].command` in `.claude/asterweave.json` | Shell commands that a later phase will run as quality gates |
| `hooks[]` in `.claude/asterweave.json` | Programs that [`asterweave run`](/cli/runs) starts around the steps of a run (one finding per entry, reported as kind `hook` with the field `hooks[0].argv`; the command text is never printed) |
| `.claude/settings.json` and `.claude/settings.local.json` | When `claude` runs in the repository it loads hooks, environment variables, helpers, and permissions from them |
| `.mcp.json` | When `claude` runs in the repository it may start the MCP servers declared there |

**None of these is executed by the commands described on this page** (`config`, `trust`, `doctor`, `repo`, the launch). The one place Asterweave starts repository-defined programs is a [run](/cli/runs), and then only the repository **hooks**, and only for a trusted repository; quality-gate commands, settings and MCP servers are still not run by Asterweave. They are detected, counted by file name and kind (never printing a command's text), and gated. Trust changes whether `config show` applies `qualityGates.required` and whether a run loads the repository `hooks`. It also drives the `repo.trust` check in `doctor`, the trust line in `repo status`, and a warning in the launch banner when an untrusted repository has executable files. Exit code 4 is returned by `config show --strict` for an untrusted repository with executable config; nothing else in Phase A returns it.

## Trust store

`trust.json` maps a repository to the hash of its trust-governing content at the moment you granted trust:

```json
{
  "c:\\work\\widgets": {
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "trustedAt": "2026-01-01T00:00:00.000Z"
  }
}
```

The key is the repository's real path (symlinks and junctions resolved; lower-cased on Windows). The hash is SHA-256 over a versioned label, that real path, and, for each of these four files in order, its name and either its bytes (with length) or a marker that it is missing or unreadable:

1. `.claude/asterweave.json`
2. `.claude/settings.json`
3. `.claude/settings.local.json`
4. `.mcp.json`

Consequences:

- **Any change makes the repository untrusted again**, including whitespace, a new file appearing, or a file being deleted. `status` then reports the reason `CHANGED` (previously trusted) instead of `NOT_GRANTED` (never trusted).
- **Moving or renaming the clone** changes the real path and therefore the hash, so trust must be granted again at the new location.
- Content cannot migrate between files without changing the hash, because each file's name and length are part of the input.

### Grant and revoke

```bash
asterweave trust                         # same as: trust status
asterweave trust status --path C:\work\widgets
asterweave trust grant --path C:\work\widgets
asterweave trust revoke --path C:\work\widgets
```

- `--path` defaults to the connected repository, then the current directory. **`trust grant` needs an explicit `--path` when not run in a terminal or with `--json`**, so a script can never trust the current directory by accident.
- In a terminal, `trust grant` without `--path` prints the review and then asks `Trust <path> (<counts of executable config>)? [y/N]`. The default is No (Enter, Esc, `n`); only `y` grants. Esc and Ctrl+D count as No (exit 1, `TRUST_DECLINED`); Ctrl+C or a closed input stream exits 130.
- A grant is bound to what was reviewed: the hash shown in the preview is re-checked when the grant is recorded. If a governing file changed in between, nothing is granted, the exit code is 1 with code `TRUST_CHANGED_DURING_GRANT`, and the fix is to rerun `trust grant`.
- The preview lists the executable config found in the very bytes that were hashed for the grant (not a second read of the files).
- `trust grant` and `trust revoke` serialise their update of `trust.json` with a lock file next to it (`trust.json.lock`, created exclusively, removed afterwards, taken over when older than 30 seconds). If another process holds it for the whole 2 second wait, the command exits 1 with `TRUST_STORE_BUSY` and nothing is written.
- Configuration is parsed from the same bytes of `.claude/asterweave.json` that were hashed for trust, so the file cannot change between the trust check and its use.
- If `trust.json` cannot be read, `launch`, `repo status`, `doctor` and `config show` treat the repository as **untrusted** and print `trust store unreadable: run asterweave trust revoke/grant to recreate` (executable config is not applied; the file is never rewritten by a read). `trust grant` and `trust revoke` are the explicit acts that recover it: they replace a corrupt `trust.json` with a fresh valid store (so nothing else stays trusted), and `trust grant` keeps its hash binding and y/N confirmation. `trust status` is a trust decision and fails closed instead: on a corrupt store it exits 1 with code `STORE_CORRUPT` and a remediation pointing at `trust revoke` / `trust grant`. A trust store that exists but cannot be read at all (for example a permissions error) is not recreated by either command; they exit 1 with `STORE_UNREADABLE`.
- `grant` prints a preview first (the kinds and counts of executable config and which files the grant covers) and then records trust. With an explicit `--path` there is no separate confirmation prompt (that is the confirmation): read the files before you run it.
- `revoke` is idempotent. Revoking a repository that was not trusted says so and exits 0. On a corrupt `trust.json` it writes a fresh empty store and reports `"removed":false,"recreated":true`.
- `status` shows the path, the trust state and time, the hash, and the executable findings.

Text from `trust status`:

```text
Repository  C:\work\widgets
Trust       untrusted (trust has not been granted)
Hash        0000000000000000000000000000000000000000000000000000000000000000

Executable repository config found:
   1  quality-gate command(s)  in .claude/asterweave.json
   2  repository hook(s)       in .claude/asterweave.json

Review these files, then run: asterweave trust grant --path C:\work\widgets
```

JSON shapes (abridged):

```json
{"ok":true,"trusted":false,"reason":"NOT_GRANTED","path":"C:\\work\\widgets","hash":"...","trustedAt":null,"files":[{"file":".claude/asterweave.json","state":"present"}],"executable":[{"field":"qualityGates.required[0].command","file":".claude/asterweave.json","kind":"command"}]}
```

```json
{"ok":true,"trusted":true,"path":"C:\\work\\widgets","hash":"...","trustedAt":"2026-01-01T00:00:00.000Z","executable":[]}
```

```json
{"ok":true,"trusted":false,"path":"C:\\work\\widgets","hash":"...","removed":true,"recreated":false}
```

`recreated` is `true` only when `revoke` replaced a corrupt `trust.json` with a fresh empty store (then `removed` is `false`).

`reason` is `TRUSTED`, `NOT_GRANTED`, or `CHANGED`; `kind` is `command`, `settings`, or `mcp`; a file `state` is `present`, `missing`, or `unreadable`. The status shown by `launch`, `repo status`, `doctor` and `config show` can also carry the reason `STORE_UNREADABLE` (with a `warning`): `trust.json` could not be read, which includes the corrupt-store case, and the repository is treated as untrusted. (`trust status` itself does not report it; it fails with exit 1 instead.)

Exit codes for `trust`:

| Code | When |
| --- | --- |
| `0` | Success, including `revoke` of a repository that was not trusted |
| `1` | The path does not exist (`REPO_PATH_INVALID`); the confirmation was declined (`TRUST_DECLINED`); a governing file changed between the preview and the grant (`TRUST_CHANGED_DURING_GRANT`); `trust status` on a corrupt or unreadable `trust.json` (`STORE_CORRUPT` / `STORE_UNREADABLE`); `trust.json` could not be written; `trust.json.lock` stayed held (`TRUST_STORE_BUSY`) |
| `2` | Usage error (unknown subcommand or option, `grant` without `--path` outside a terminal or with `--json`) |
| `130` | Ctrl+C (or a closed input stream) at the confirmation prompt |

## Related

- [CLI overview](/cli/overview)
- [Authentication](/cli/auth)
- [Exit codes and doctor](/cli/exit-codes)
- [`asterweave.json` reference](/configuration/asterweave-json): the repository adapter file this CLI reads
