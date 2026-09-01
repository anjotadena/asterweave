---
sidebar_position: 4
title: Your first delivery
description: A walkthrough of a first end-to-end /asterweave:deliver run.
---

# Your first delivery

This walks through delivering a single GitHub issue end to end, without reading Asterweave's internals first.

## 1. Confirm the plugin is healthy

```text
/asterweave:doctor
```

`doctor` is read-only. It reports the Claude Code and Node.js versions, repository trust status, Git status, plugin manifest validity, hook wiring, GitHub MCP connectivity, stack detection, and the health of any existing `.claude/asterweave/state.json`. Fix anything it flags before continuing — see [Troubleshooting](/troubleshooting/common-issues).

## 2. Align the repository (once)

```text
/asterweave:scaffold --dry-run
```

then, after reviewing the digest:

```text
/asterweave:scaffold
```

If the repository already has an evidence-backed `.claude/`, this may propose few or no changes. Skip straight to step 3 if you already know the repository is aligned.

## 3. Pick a work item

```text
/asterweave:daily
```

Lists your assigned GitHub issues, requested reviews, and failing CI without changing anything. Or go straight to a known issue.

## 4. Deliver it

```text
/asterweave:deliver owner/repository#123
```

Asterweave works through the graph described in [Architecture overview](/architecture/overview):

1. **Intake** — normalizes the task, acceptance criteria, constraints, and source.
2. **Analyze** — read-only repository and stack discovery; writes a context manifest.
3. **Challenge** — a requirements grill that surfaces contradictions, missing acceptance criteria, and hidden assumptions. It returns `READY`, `READY_WITH_ASSUMPTIONS`, or `BLOCKED`.
4. **Plan** — an approval-ready implementation DAG with file/boundary changes, test strategy, and rollback.
5. **Human approval** — Asterweave pauses here. Read the plan before approving.
6. **Implement → test → verify → review** — a bounded implementation, focused tests, runtime verification against acceptance criteria, and independent staff/security review. A failure at any of these routes back to `implement`, not forward.
7. **Submit PR** — Asterweave shows the exact commit/push/PR plan and asks for confirmation (unless you passed `--auto-pr`), then creates or updates the pull request.
8. **Monitor pipeline** — polls the submitted commit's required checks.
9. **Resolve review comments** — triages new PR comments; anything actionable routes back through `implement`.
10. **Update work item** — writes the final state back to GitHub (or Azure DevOps) and links the pull request.

## 5. Review the result

Read the pull request Asterweave created. It contains an evidence-rich body: linked issue, outcome, changes, architecture decisions, the acceptance matrix, exact test results, and known risks. Merge according to your team's normal review process — Asterweave never merges its own PR.

## If it stops early

A `BLOCKED` or `needs-human` outcome at `challenge` or elsewhere means Asterweave found something only you can resolve — usually an ambiguous requirement or a genuinely risky decision. Answer its question and re-invoke `/asterweave:deliver` on the same issue; it resumes from durable state rather than starting over. See [Continuing interrupted work](/usage/continuing-work).

## Next

Read [Daily workflow](/usage/daily-workflow) for the everyday loop, or [How to use Asterweave](/usage/overview) for the mental model behind it.
