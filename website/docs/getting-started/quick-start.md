---
sidebar_position: 3
title: Quick start
description: Two commands to align a repository and deliver a first work item.
---

# Quick start

```bash
cd my-project
```

## 1. Align the repository

```text
/asterweave:scaffold --dry-run
```

Previews the evidence-backed `CLAUDE.md`, `.claude/rules/`, project skills/agents, and `.claude/asterweave.json` that Asterweave would create or update, without writing anything. Review the digest, then apply it:

```text
/asterweave:scaffold
```

Asterweave shows an audited create/replace plan and asks you to approve its content digest before writing. See [Repository scaffolding](/repositories/scaffolding) for exactly what it can and cannot touch.

:::tip Run this once per adoption, not per ticket
Run `/asterweave:scaffold` when you first adopt Asterweave in a repository, and `--refresh` later when architecture, tooling, or policy changes meaningfully. It is not part of the normal per-ticket loop. See [When to scaffold](/usage/overview#when-to-scaffold).
:::

## 2. Deliver a work item

```text
/asterweave:deliver owner/repository#123
```

Asterweave takes the issue through intake, analysis, a requirements challenge, an approval-gated implementation plan, implementation, tests, runtime verification, independent code and security review, and pull-request submission — pausing for your explicit approval after the plan and again before push/PR unless invoked with `--auto-pr`. See [The delivery workflow](/architecture/overview) for the full node sequence.

## What to expect

Asterweave reports its progress and decisions as normal conversation, not a fixed console format — but by the end of a successful `deliver` run you should be able to see:

- the plan it proposed and that you approved;
- the diff it produced and the tests it added or ran;
- runtime/acceptance evidence tied to your acceptance criteria;
- the independent code-review and security-review verdicts;
- the pull request URL, and the CI checks it monitored on your behalf.

If Asterweave cannot proceed safely, it stops in a typed state instead of guessing: `blocked`, `needs-human`, `policy-denied`, or `security-escalation`. See [Starting new work](/usage/starting-new-work) for what each of those means and how to respond.

## Next

- [Your first delivery](/getting-started/first-delivery) walks through the same flow with more detail on what happens at each step.
- [Daily workflow](/usage/daily-workflow) covers the everyday loop once the repository is aligned.
