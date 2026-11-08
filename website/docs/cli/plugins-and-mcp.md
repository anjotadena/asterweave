---
sidebar_position: 15
title: Plugins and MCP management
description: "Asterweave CLI Phase F2: scoped, delegated management of Claude Code plugins (and MCP servers). Asterweave owns trust, approval and the effective view; claude performs the writes. Fixture-verified only."
---

# Plugins and MCP management

Asterweave does not install plugins or MCP servers itself. It owns **trust, approval and the effective view**; the writes are delegated to `claude plugin install|uninstall|enable|disable` (and `claude mcp add|remove`) through one supervised admin runner. Nothing here was exercised against a live `claude`: every test uses a scripted fake. Anything that depends on the real tool is listed under [Unverified](#unverified).

## Scopes

| Asterweave `--scope` | Claude scope | Where it lives | Trust |
| --- | --- | --- | --- |
| `global` | `user` | `~/.claude/settings.json` (`enabledPlugins`), `~/.claude/plugins/installed_plugins.json` | Not part of repository trust |
| `repo` | `project` | `<repo>/.claude/settings.json` (the shareable declaration; no new repo file) | Changing it makes the repository **untrusted** until re-granted |
| (never) | `local` | `<repo>/.claude/settings.local.json` | Shown by `plugin list`, labelled "local, not managed by asterweave", never written |

`--scope` is required on every change: Claude's own default is `local`, which Asterweave never uses.

## What is delegated and what Asterweave owns

Asterweave never writes MCP or plugin configuration itself. Every change goes through one **admin runner** that accepts only these argv shapes: `claude mcp add|remove` and `claude plugin install|uninstall|enable|disable`. Anything else is refused before a process exists: `mcp list|get|serve|add-json|add-from-claude-desktop|reset-project-choices` (some start servers or import foreign state), `plugin marketplace|update|prune`, Claude's `local` scope, a missing scope, unknown flags, a name that starts with `-`, an argument that looks like a secret. The runner uses `shell: false`, an allow-listed environment (no tokens), no stdin, a 60 s deadline and the abort signal with a whole-process-tree kill, and keeps at most 64 KiB of redacted output. **Global** changes run in a fresh private temporary directory, so a repository's `.claude/settings.json` or `.mcp.json` cannot influence them; **repo** changes run in the repository root. Ctrl+C (SIGINT/SIGTERM) kills the whole claude process tree, removes the temporary directory, names the files that may have changed (a repo-scope change leaves the repository untrusted until reviewed) and exits 130; a second signal ends the process at once. `CLAUDE_CONFIG_DIR` present in the environment (even empty) makes **every** change refuse with exit 2, in both scopes (claude would write user-level files, such as `installed_plugins.json`, that Asterweave does not verify); unset it for the command.

Asterweave owns the rules around the write: the exact command and the files that may change are shown first; a y/N at a terminal or `--yes` confirms (never with `--json`); agent environment markers refuse with exit 7; the result is verified as exactly the intended change; and repository trust is handled as below.

## MCP commands

| Command | What it does |
| --- | --- |
| `asterweave mcp add <name> --scope global\|repo [--transport stdio\|http\|sse] [--env KEY='${VAR}']... [--header 'Name: ${VAR}']... [--yes] [--trust] [--json] (-- <command> [args...] \| <url>)` | `claude mcp add <name> [<url>] -s user\|project -t <transport> [-e KEY=${VAR}]... [-H 'Name: ${VAR}']... [-- <command> [args...]]` |
| `asterweave mcp remove <name> --scope global\|repo [--yes] [--trust] [--json]` | `claude mcp remove <name> -s user\|project`, and deletes the server's stored approval record |
| `asterweave mcp enable\|disable` | Usage error (exit 2): Claude Code has **no CLI** to enable or disable an MCP server. Use `remove` and `add`. |

`list`, `inspect`, `validate` and `test` are unchanged (see [Tools, usage and routing](/cli/tools-usage-routing)).

### Why environment values must be references

The repository's `.mcp.json` is a shareable file. `--env` and `--header` values must therefore be a reference, never a literal: `${NAME}` (upper case, the form Claude Code expands from its own environment) or Asterweave's `${cred:NAME}` (resolved by `mcp test`; a warning says Claude Code does not expand it). A literal, a default (`${NAME:-x}`) or text mixed with a reference is refused with exit 2 and **never echoed**. Quote the reference with single quotes so your shell does not expand it: `--env API_KEY='${MY_API_KEY}'`. `mcp validate` accepts both reference forms; the descriptor hash that approvals bind covers the reference **names** (a `${cred:A}` hashes exactly as before, a `${A}` as `env:A`), so swapping the variable a key points at makes the approval stale.

Other checks before anything runs: server names `letters, digits, . _ -` (at most 64); `http`/`sse` urls must be `https` (`http` only for localhost) without credentials; the resulting definition goes through the same linter as `mcp validate` (an unpinned `npx`/`uvx` package or a shell wrapper is shown as a warning in the preview); adding a name that already exists in that scope, or removing one that does not, is refused.

### Verification and trust after a change

Before and after the call Asterweave snapshots the governing files and compares them as parsed JSON, key by key. For `--scope repo` all four trust-governing files are compared (`.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/asterweave.json`); for `--scope global` the `mcpServers` entries of `~/.claude.json` (Claude's own bookkeeping keys in that file are ignored, and the repository's trust hash must not move). Before claude runs, the trust hash is read, the snapshot taken and the hash read again; if they disagree (a file was written in that window) nothing is run. Any trust-governing file other than the expected target (`.mcp.json` for MCP, `.claude/settings.json` for plugins) that changes is `UNEXPECTED_CHANGE` too. The difference must be exactly the one intended entry: for `add` the new server's transport, command, arguments, url, environment and header **names and references** must match the request; for `remove` that one entry is gone. Anything else is `UNEXPECTED_CHANGE` (exit 1): trust is not re-granted, nothing is reverted, and you are told to review with `git diff`. A claude that exits non-zero is reported with its redacted stderr and the names of any files that changed anyway.

A `--scope repo` change alters the trust hash, so the repository is **untrusted afterwards** and the command exits **4** (the change itself succeeded). Review the diff, then run `asterweave trust grant`. `--trust` re-grants in the same command only when **all** of these hold: the repository was trusted immediately before; the diff was verified as exactly the intended entry; the files are unchanged since the verification; and a person confirmed (a second y/N, or `--yes`). If the repository was not trusted before, re-granting would also bless unrelated configuration nobody reviewed, so `--trust` is not applied. The grant is bound to the verified hash. `--trust` with `--scope global` is a usage error.

Per-server MCP approvals (`mcp test`) are separate: `remove` deletes the server's approval record (for a user server, under every repository), `add` creates none (and clears a leftover one); approval still happens at `mcp test`, at a terminal.

### Guard floors for MCP

`asterweave mcp add|remove` and the direct `claude mcp add|remove|rm|add-json|add-from-claude-desktop|reset-project-choices` are denied to an agent by the guard (reason `APPROVAL_SELF_GRANT`, rule `config-mutation`), whatever the quoting, wrapper (`sudo`, `env`, `bash -c`, `npx`) or option order. `mcp list|inspect|validate|test` without `--approve` stay allowed. The verb is the first word after `mcp`/`plugin` (option values are skipped), so `mcp test add` is not a false positive; a command the classifier cannot follow (a variable or substitution as the command word) that still names claude, an area and a mutating verb is denied as well, and `xargs` feeding `claude`/`asterweave mcp|plugin` is denied whatever the verb.

## Plugin commands

| Command | What it does |
| --- | --- |
| `asterweave plugin list [--scope global\|repo\|all] [--json]` | Installs and `enabledPlugins` per scope. Parse-only, never starts anything. |
| `asterweave plugin inspect <id> [--json]` | Manifest summary from the installed cache directory: name, version, description, component counts by directory name (`skills`, `agents`, `commands`, `hooks`, `.mcp.json`), hook commands (redacted, flagged **runs code**) and MCP servers with the `mcp validate` warnings. Never executes anything. Fields that the manifest declares as a path, a list of paths or inline objects (`hooks`, `mcpServers`, `skills`, `agents`, `commands`) are resolved inside the install directory (no absolute paths, no `..`, no links, 1 MiB cap). Anything that cannot be read is reported as `manifest declares hooks at <path>: not inspected (<why>), treat as code` and the summary says **could not be fully inspected**: it is never an all-clear. |
| `asterweave plugin install <name@marketplace> --scope global\|repo [--config k=v]... [--yes] [--trust] [--json]` | `claude plugin install <id> -s user\|project [--config k=v]...` |
| `asterweave plugin uninstall <id> --scope ... [--keep-data] [--yes] [--trust] [--json]` | `claude plugin uninstall <id> -s ... [--keep-data]` |
| `asterweave plugin enable\|disable <id> --scope ... [--yes] [--trust] [--json]` | `claude plugin enable\|disable <id> -s ...` |

`list` and `inspect` read at most 8 MiB per file, only regular files, build null-prototype copies of the JSON (no `__proto__` pollution), sanitize and redact every string, and never follow symbolic links inside a plugin directory. An install path that resolves outside `~/.claude/plugins` is not read. Scopes are listed side by side and **never merged**; a plugin declared enabled in one scope and disabled in another is labelled a conflict, because precedence is not verified.

### Rules for changes

- **The marketplace must already be known** (`~/.claude/plugins/known_marketplaces.json`). Asterweave never adds a marketplace, and a change that adds one is reported as an unexpected change.
- **Strict ids**: `name` or `name@marketplace`, letters, digits, `.` `_` `-`, at most 100 characters in total; `install` needs the qualified form.
- **Code-execution warning**: plugins can run hooks and start MCP servers with your permissions once enabled. Install and enable print a loud warning before the confirmation, and Asterweave has not reviewed the plugin. For `enable` (and a reinstall) the warning also states what a parse-only inspection of the cached plugin found, including when it was incomplete; a plugin cannot be inspected before its first install.
- **`--path`** selects the repository for `--scope repo` (and for `list` / `inspect`); it is refused with exit 2 for `--scope global`, where it would have no effect.
- **Confirmation**: the exact command and the files that may change are shown; a y/N at a terminal, or `--yes` without one. `--json` never prompts. Agent environment markers (`ASTERWEAVE_RUN_ID`, `ASTERWEAVE_SESSION_ID`, `CLAUDECODE`, `CLAUDE_CODE_*`) refuse the command with exit 7: an agent must not change executable configuration.
- **`--config` values**: no secret ever travels in argv. A key that looks like a secret (`token`, `key`, `secret`, `password`, ...) accepts only a whole `${NAME}` reference (a literal is refused with exit 2), and so does any value the redactor flags. The refused value is never echoed. Let Claude Code prompt for the secret instead. Other values must be plain text or a whole `${NAME}` reference (passed to claude verbatim, never expanded by Asterweave) (no control characters, at most 500 characters), keys are unique, at most 20 entries.
- **Verified result**: before and after the change Asterweave snapshots the plugin state. The result must be exactly the intended plugin change: no other key in the settings file, no other scope, no other plugin installed or removed, no marketplace change, and (repo scope) no change to `.mcp.json`, `settings.local.json`, the user settings or `.claude/asterweave.json`. The result lists `changedFiles` (for a global change: `~/.claude/settings.json` and `~/.claude/plugins/installed_plugins.json` when they changed). A global change is also passed the current repository, so the envelope can prove it did not move the repository's trust hash. Anything else is `UNEXPECTED_CHANGE` (exit 1); trust is not re-granted and you are told to review with `git diff`.

### Trust after a repository change

A `--scope repo` change edits `.claude/settings.json`, one of the trust-governing files, so the repository is untrusted afterwards (exit 4 from the change itself: it succeeded, but a trusted run is not possible yet). Review the diff, then run `asterweave trust grant`. `--trust` re-grants in the same command **only** when the repository was trusted immediately before, the diff was verified as exactly the intended entry, and the confirmation was given. `--trust` with `--scope global` is a usage error (a global change does not touch repository trust).

### Guard floors

An agent cannot use either door: `asterweave plugin install|uninstall|enable|disable` and the direct `claude plugin ...` mutations are denied by the guard with the reason `APPROVAL_SELF_GRANT`. `plugin list` and `plugin inspect` stay allowed.

## Exit codes

`0` ok · `1` error, `UNEXPECTED_CHANGE`, unknown marketplace file unreadable, plugin not found, admin runner unavailable · `2` usage (bad id, missing `--scope`, `--scope local`, unknown marketplace, bad `--config`, unknown flag for the subcommand) · `4` repository untrusted after a repo-scope change (the change was applied and verified) · `7` refused (agent markers) · `130` interrupted. See [Exit codes](/cli/exit-codes).

## Unverified

These are assumptions, labelled in the code and not checked against a real `claude`:

- The shape of `installed_plugins.json` (both `{ plugins: { id: [ { scope, installPath, version, projectPath } ] } }` and a flat map are parsed defensively) and of `known_marketplaces.json` (object keyed by name, or an array of `{ name }`).
- That `-s project` writes `enabledPlugins` into the repository's `.claude/settings.json`, that `-s user` writes `~/.claude/settings.json`, and that `disable` leaves `enabledPlugins[id] = false` (it is verified as `false`; a tool that deletes the key would be reported as an unexpected change).
- The semantics of `--config`, including whether `${NAME}` references are expanded.
- Plugin precedence between scopes.
- `CLAUDE_CONFIG_DIR` is not honoured: Asterweave reads `~/.claude` only, and every change refuses while the variable is present, even when empty.
- MCP: what `claude mcp add -s project` writes (assumed: an entry in the repository's `.mcp.json` with `type`, `command`, `args`, `env` or `type`, `url`, `headers`; any other key in the entry is reported as an unexpected change), that `-s user` writes the top-level `mcpServers` of `~/.claude.json`, the argument order (`<name> [<url>] -s .. -t .. -e .. -H .. -- command`; `-e` and `-H` are variadic in claude's help, so positionals come first), and whether `${VAR}` in `.mcp.json` is expanded by Claude Code. `${cred:NAME}` is not a Claude Code feature.
