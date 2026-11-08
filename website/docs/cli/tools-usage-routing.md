---
sidebar_position: 8
title: Tools, usage and routing
description: "Asterweave CLI Phase C: the typed tool registry, the read-only GitHub adapter, the MCP stdio client and its approvals, token usage and budgets, and model routing. Fixture-verified only: no live model calls."
---

# Tools, usage and routing

Phase C adds the pieces a real agent needs around the run loop: a registry of typed tools, token usage with budgets, and model routing. Like Phase B it is verified with fixtures only. **No model is called and no real MCP server was exercised**; the MCP client was tested against a local fixture server. `asterweave run start` still uses the simulated dispatcher until Phase D.

## Commands

| Command | What it does |
| --- | --- |
| `asterweave usage [runId] [--json]` | Measured tokens by counter, node and model, latest context size, budgets remaining. Read-only. |
| `asterweave model [show \| explain <node>] [--json]` | The route pinned by the newest run against the current configuration, with drift. Read-only, no network. |
| `asterweave mcp list \| inspect \| validate [--json]` | MCP server definitions from `.mcp.json`, the user Claude file and plugin caches. **Never starts a server.** |
| `asterweave mcp test <name> [--source s] [--approve <hash>]` | The only command that starts a server: `initialize` and `tools/list`, never `tools/call`. Approving needs an interactive terminal prompt; `--approve <hash>` only pins what you reviewed. |

## Usage and budgets

Three numbers are always separate: **context size** (the latest measured size of the working context), **cumulative usage** (the sum per counter) and **budget remaining**. A value nobody measured is `unknown`, never 0, and unknown is never added to a known value. The loop records one `usage` event per executor report; a malformed report is rejected as a whole and logged by path only.

Budgets exist for the run and, in autonomous policy, per node:

```json
{ "v": 1, "autonomous": { "budgets": { "tokens": 200000, "perNode": { "tokens": 50000, "toolCalls": 40, "iterations": 10 } } } }
```

When a run or node budget is exhausted the loop persists a checkpoint (`budget.exhausted`, scope `run` or `node`) and blocks the run with the signature `budget:<name>` (or `budget:node.<name>`). Resume is refused while the node is still over its token or tool-call limit. A node whose executor reports nothing can never exhaust a token budget, because unknown is not 0. The token budget counts input plus output tokens; cache and context tokens are reported separately.

## Model routing

User configuration and environment only (a repository cannot choose where prompts go): `model.default` (`ASTERWEAVE_MODEL`), `model.effort`, `model.fallback` (up to four ids) and `model.stages.<node>`. The route is **pinned** into `run.json` when a run starts; changing configuration later does not alter a running run, and `asterweave model` shows the drift. Model ids come from a static catalog and are labelled **unverified**; an unknown id is allowed and flagged, never rejected. Fallback to the next model happens only on transient classes (rate limit, overloaded, timeout, 5xx), never on auth, policy-denied or invalid-request failures, and never changes approvals. The pure fallback function exists and is tested; a real executor wires it in Phase D.

## Tool registry and bounded output

Tools are registered with an id, a schema, the stages that may use them, limits and a read-only flag. A stage sees only its own small list (at most 16), and the same capability cannot be registered through two routes. Every result is capped by bytes, lines, items and line length, stripped of control sequences and redacted. When output is truncated the full redacted text is stored as an artifact (`<sha256>.txt`, private mode) and the result carries an excerpt, a truncation marker, the byte counts and the artifact path.

Results from API and MCP tools are wrapped as `{"trust":"untrusted","source":...,"content":...}`. They are data: they cannot register tools, trigger calls, change approvals or escape sanitization, and the tests include hostile responses (instruction text, ANSI escapes, huge or deeply nested JSON, `__proto__` keys).

### GitHub read-only adapter

`github.issue.get`, `github.pull.get` and `github.checks.list` use an injected fetch and a credential reference (never in arguments, logs or errors). Only `GET` over HTTPS to the allow-listed host and path prefix; redirects are errors; `Link: rel=next` is followed up to three pages and re-validated before the credential is sent; 429 and 5xx retry with `Retry-After`. Issue and pull request text is attacker-controlled and is returned as untrusted data.

### MCP stdio client

Newline-delimited JSON-RPC 2.0 over a child process: `initialize`, `tools/list`, `tools/call`. The child is started without a shell, with a minimal environment (`PATH` plus the keys the definition declares), the repository root as working directory, a per-request timeout, a frame size limit and strict UTF-8. Requests from the server (sampling, roots, elicitation) get method-not-found. Cancellation and crashes kill the process tree and never leave an orphan. Environment values in an MCP definition must be credential references written `${cred:NAME}`; literal values are never passed and make `mcp validate` fail (exit 5) and `mcp test` refuse.

## Guard classes `api` and `mcp`

| Class | Decision |
| --- | --- |
| `api` | `GET`, `https`, allow-listed host and path prefix only; userinfo, fragments, dot segments and unknown input keys are denied. In autonomous mode `autonomous.tools` must include `api`. |
| `mcp` | The server must be trusted and have an approval **bound to its descriptor hash**, and the tool must be in the approved list. Untrusted: denied. No approval: approval required. Server definition or tool list changed: `STALE_APPROVAL`. Counts as a mutation, so it needs the run lock. In autonomous mode `autonomous.tools` must include `mcp`. |

The descriptor hash covers transport, command, arguments, working directory, the environment **keys with the credential reference each one reads** (never values), URL with credentials removed, and the advertised tools with the hash of each description and each input schema. Pointing a key at a different `${cred:NAME}`, or changing a tool description, makes the approval stale. `mcp test` approvals are stored in `<userDir>/mcp-approvals.json` per repository, source and server. **Approval is terminal-only.** `mcp test` asks `y/N` on an interactive terminal (stdin and stdout both a terminal, no `--json`), showing what would run. `--approve <hex>` (at least 12 characters of the definition hash) does not grant anything by itself: it is a pin that must match the definition you reviewed, and the prompt is still asked. Without a terminal, or with `--json`, the command exits 6 ("approve in a terminal") and starts nothing. After listing, the full hash including the tool list is recorded. If the tool list, a description or a schema changes later, `mcp test` exits 6 and prints the **new** full hash; the old token is refused, and at a terminal the prompt names the added and removed tools before the new list is recorded. `mcp test` refuses with exit 7 (`APPROVAL_FORBIDDEN_CONTEXT`) when `ASTERWEAVE_RUN_ID`, `ASTERWEAVE_SESSION_ID`, `CLAUDECODE` or a `CLAUDE_CODE_*` variable is set, so running it from inside Claude Code's own terminal is refused by design. The guard also denies the command text `asterweave mcp test --approve` like `run approve`. This is defence in depth, not a sandbox: the markers are advisory, and a process running as your user may reach your console (on Windows through `AttachConsole`/`CONOUT$`); see [Policy and guards](/cli/policy-and-guards#terminal-only-approvals-defence-in-depth-not-a-sandbox). User and plugin servers start in a private temporary directory, project servers in the repository root; servers get a flood limit (100 server requests) and a stdin backpressure limit.

## What is not verified

- No real MCP server and no live GitHub API call; `~/.claude.json` as the user-level MCP location is unverified, and so is precedence between project, user and plugin sources, so servers from different sources are listed separately and a duplicate name is a `validate` error.
- On Windows `npx` and `uvx` resolve to `.cmd` shims and the client never uses a shell: such definitions report `MCP_SHELL_SHIM` until you point at the real executable.
- If an MCP server itself crashes, its child processes can survive on Windows (`taskkill /T` needs the parent alive; a Job Object needs a dependency). Closing or aborting while the server is alive removes the whole tree.
- The POSIX process-group kill is implemented but was not run on this machine.
- The classifier and guards remain heuristics, not a sandbox. Approvals are terminal-only (a nonce for `run approve`, a y/N prompt for `mcp test`) plus advisory environment markers: that is defence in depth, and a real dispatcher still needs operating-system isolation.
