---
sidebar_position: 1
title: How to use Asterweave
description: The normal mental model and the simplest day-to-day flow.
---

# How to use Asterweave

## The mental model

**You** choose *what* to work on. **Asterweave** handles *how* the delivery workflow runs. The repository's **`.claude/`** tells Asterweave *how this codebase works*. **Specifications** (when a repository has them) define *what the change must accomplish*.

```text
Open repository
        ↓
/asterweave:scaffold        (once, when adopting or realigning)
        ↓
Review detected project context
        ↓
/asterweave:deliver <work-item>
        ↓
Review the final PR
```

That is the entire normal flow. Everything else in this documentation is detail for when you need it.

## When to scaffold

Run [`/asterweave:scaffold`](/commands/scaffold):

- when onboarding Asterweave into a repository for the first time;
- when the repository's architecture changes significantly;
- when `.claude/` has visibly gone stale (wrong commands, outdated conventions);
- when upgrading repository integration conventions after a major Asterweave version change.

It should **not** normally run before every ticket once the repository is already aligned — see [Repository maintenance](/usage/repository-maintenance) for the signals that mean it's time to run it again.

## When to use each command

| Situation | Command |
| --- | --- |
| First time using Asterweave in a repository | [`/asterweave:scaffold`](/commands/scaffold) |
| Repository structure changed meaningfully | [`/asterweave:scaffold --refresh`](/commands/scaffold) |
| Check repository alignment without changing anything | [`/asterweave:scaffold --check`](/commands/scaffold) |
| Understand a ticket before committing to a plan | [`/asterweave:analyze`](/commands/analyze) then [`/asterweave:challenge`](/commands/challenge) |
| Full end-to-end delivery | [`/asterweave:deliver <id>`](/commands/deliver) |
| Review code you (or someone else) wrote manually | [`/asterweave:review`](/commands/review) |
| Resume interrupted work | [`/asterweave:resume`](/commands/resume) |
| Triage what to work on today | [`/asterweave:daily`](/commands/daily) |
| Check plugin/repository health | [`/asterweave:doctor`](/commands/doctor) |
| Learn from a completed/blocked workflow | [`/asterweave:retro`](/commands/retro) |

See the full [command overview](/commands/overview) for all sixteen.

## What Asterweave automates vs. what stays yours

See [Manual vs. autonomous responsibility](/usage/starting-new-work#manual-vs-autonomous-responsibility) for the detailed split. In short: Asterweave reduces routine interaction — repository discovery, planning mechanics, implementation, testing, verification, review routing, PR mechanics, CI monitoring — but never removes your ownership of intent: ambiguous product decisions, high-risk or destructive actions, and major architecture changes always pause for you.

## Anti-patterns

Avoid:

- Running `/asterweave:scaffold` before every ticket unnecessarily.
- Duplicating Asterweave's generic agents or workflows inside a repository's `.claude/`.
- Putting business requirements in `CLAUDE.md` instead of `specs/`.
- Manually invoking every internal specialist agent during a normal delivery — the orchestrator decides which agents and checks are needed.
- Accepting a Critical/High review finding without actually addressing it, or bypassing failed verification to force a PR.
- Starting a second delivery when resumable workflow state already exists for the same goal.
- Editing Asterweave's own plugin rules to accommodate one repository's convention — that belongs in `.claude/rules/`.
- Treating pipeline success as proof that acceptance criteria are satisfied — [`verify`](/commands/verify)'s runtime evidence is the actual proof.

## Next

[Daily workflow](/usage/daily-workflow) for the everyday loop, or [Starting new work](/usage/starting-new-work) for how a single ticket goes from assignment to `READY`.
