---
sidebar_position: 14
title: Context and usage views
description: "The asterweave context command and the interactive /context, /usage, /attachments and /image views: three separate numbers (context size, cumulative usage, budget remaining), measured versus unknown, and what nothing here estimates."
---

# Context and usage views

`asterweave context` and the interactive `/context`, `/usage`, `/attachments` and `/image` commands show where a run stands. They are **read-only and offline**: they read the run ledger and the session store, never call a model, and never spawn the runner.

## Three numbers, never merged

| Number | Meaning | Shape |
| --- | --- | --- |
| **Context size** | The latest **measured** size of the working context, in tokens. A gauge: it goes up and down, and only the newest measurement counts. | One value, or `unknown`. |
| **Cumulative usage** | The **sum** of the measured counters over every usage report of the run: input, output, cache read, cache creation, and the total that budgets use. | One value per counter, or `unknown` per counter. |
| **Budget remaining** | `limit - used` for tokens, tool calls, iterations and wall time, against the effective policy. | A number, `0 (EXHAUSTED)`, `no limit`, or `remaining unknown`. |

Context size is **not** cumulative usage. A conversation whose context is 12 000 tokens at the end may have consumed 90 000 input tokens over ten turns, because each turn re-reads the context. Showing one as the other would be wrong in both directions, so they are separate lines and separate JSON fields.

## Measured versus unknown

Every counter is either a non-negative integer that an executor **reported**, or `unknown` (`null` in JSON). Unknown is never shown as `0` and is never added to a known number: if only `inputTokens` was reported, `outputTokens` stays `unknown`. Nothing is estimated, guessed from text length, or filled in from a catalog. A run that reported nothing shows `unknown` everywhere; so does the interactive session when there is no run yet (it says `no run yet`).

## Where the values come from

- Usage counters and the context size: `usage` events that the executor wrote to the run ledger (the same events `asterweave usage` aggregates). The newest event with a measured context size wins.
- Budgets: the run snapshot (`budgets.used`) and the limits of the current policy. A token total from a run that predates the usage ledger is still a measured number; the larger known number is shown.
- Context window and percent used: only from the **static** model catalog, and only when it documents a window for the model. The shipped catalog documents none, so the window and the percent used are `unknown`. The percent is shown only when **both** the context size and the window are known.
- Route: the model and effort the run pinned when it started, and `DRIFT` when the configuration changed since.
- Attachments: the images of the run's session, counted apart as **staged** (not sent yet) and **sent** (already sent with the first turn of the run named in `sentRunId`). A staged image goes out once, with the first turn of a run started by `asterweave run start --session <id>` for that session; a plain `run start` never picks up staged images, and a sent image is not sent again. Image bytes are never shown or logged.

## `asterweave context [runId | --session id] [--json]`

Without arguments it uses the newest run of this repository and that run's session (when the run has none, the newest active session); `--session` uses that session's linked run (a session with no run shows unknowns plus its attachments). A run id and `--session` together are a usage error (exit 2). No run: exit 1 with a remediation. Unknown flags: exit 2.

JSON: `{"ok":true,"context":{...}}` with the stable fields `version`, `source` (`run`, `session` or `none`), `runId`, `sessionId`, `title`, `status`, `contextTokens` (`tokens`, `measured`, `node`, `model`, `at`), `window` (`tokens`, `model`, `source`), `percentUsed`, `cumulative` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheCreationTokens`, `tokens`, `events`, `skipped`), `counters` (`measured` or `unknown` per counter), `budget` (`tokens`, `toolCalls`, `iterations`, `wallMs`, each `{used, limit, remaining}`), `byNode`, `byModel`, `attachments` (`count`, `staged`, `sent`, `bytes`, `stagedBytes`, `sentOn`, `items` with ids, names, formats, sizes, dimensions, full SHA-256 hashes and `sentRunId` (`null` while staged), no bytes), `route` and `policy`. `attachments.count`, `staged` and `sent` are `null` when the attachment store could not be read.

When the run has memory traces ([conversation memory](./memory.md#tokens-and-observability)), the text view adds a `Memory` line and JSON adds `context.memory`: `runId`, `requests`, `memoryTokens` (an **estimate**, characters / 4, `estimated: true`), `selected`, `cacheHits`, `cacheMisses`, `retrievalMs`, `summaryTokens` and `extractionTokens` (0: both are deterministic). It is absent when there is no memory store or no trace, so the view is unchanged for runs without memory. The memory tokens are part of the provider's input tokens above, not an addition to them.

## Interactive commands

| Command | Shows |
| --- | --- |
| `/context` | The three numbers, the window, attachments and the route, in about ten lines. `@` still adds context to a message. |
| `/usage` | Cumulative counters, the context size, per-node and per-model totals and the token budget. |
| `/attachments` | Images of the active session, staged and sent: id, state, name, format, size, dimensions, hash prefix. |
| `/image <path>` | Stages a copy of an image on the active session (through the attachment store, which validates it and strips metadata). Nothing is sent now; staged images are sent by `asterweave run start --session <id>`. |

The active session is the session of the newest run of the repository, or, when there is no run (or the run has no session), the newest active session. `/context`, `/attachments`, `/image` and `asterweave context` (without arguments) all use that same session, and every result names it. With none, they say so. An archived session is not staged on. Output is sanitized (terminal escapes and control characters removed), bounded to 40 lines, and wrapped to the terminal width. `asterweave context` and `asterweave usage` print the full reports.

## Not verified

- **Context window sizes.** The static catalog documents none, so no window or percent is shown. Add one only from a documented source.
- **Whether the runner reports a context size at all.** The view reads `contextTokens` when an executor reports it; whether `claude -p` provides a figure that means "size of the working context" was not verified. Until it does, the context size is `unknown`.
- **Cache counters.** Whether and how they are reported depends on the runner and was not verified.
- The attachment store and the first-turn image input are specified separately; see the images page. The views work without the store and then show attachments as `unknown`.
