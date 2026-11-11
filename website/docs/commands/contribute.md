---
sidebar_position: 30
title: /asterweave:contribute
description: Help an existing repository, owned or open source, with a contribution.
---

# `/asterweave:contribute`

## Purpose

Help an existing repository, owned or open source, with a contribution. Assesses the repository, ranks opportunities, selects one bounded task, delivers a verified patch or a documented blocker, and prepares the contribution package.

## Syntax

```text
/asterweave:contribute <repository|url|objective>
```

## Inputs

objective (required), repository path or URL (optional), authorization scope (optional, default discovery).

## Prerequisites

git, repository readable.

## What happens

1. **Discover**: identity, branch and commit, license, setup, CONTRIBUTING and AGENTS guidance, issue templates, security policy, tooling. Do not run setup hooks or install packages before the repository is trusted.
2. **Scope and baseline**: record the objective and authorization scope. Run the existing checks for a baseline and note unrelated working tree edits; never stash, reset or clean them.
3. **Existing work**: read open issues and PRs where access exists. Search for duplicates and active work. If access is missing, record it as unavailable.
4. **Audit**: invoke `repo-audit` for the relevant area. Keep observed defects, suspected problems and ideas apart.
5. **Triage**: invoke `issue-triage` on the candidates. Rank by impact, evidence, suitability, effort, dependencies and maintainer guidance. No invented scores or percentages.
6. **Select** one bounded task inside the request. Write acceptance criteria and reproduction steps before editing.
7. **Implement** with `bug-fix` or `feature-implement`, in a branch or worktree. Sequential execution is the default; parallel audit or review needs authorization, a concurrency cap and one write owner per file set.
8. **Verify** with `test-verify`, then `pr-review`. Return to step 7 only for actionable failures or findings, within attempt and cost limits.
9. **Package** with `pr-prepare`. Report blockers and the exact checks performed.

## Outputs

repository assessment, ranked opportunities, selected task with acceptance criteria, verified patch or blocker, contribution package.

## Verification and stop conditions

- Verified when: test-verify then pr-review passed for the selected task.
- Stops when: scope is discovery and findings are reviewed, a blocker needs the user, attempt or cost limit reached.
- Follow-up skills: repo-audit, issue-triage, bug-fix, feature-implement, test-verify, pr-review, pr-prepare.

See [Contribution skills](https://github.com/anjotadena/asterweave/blob/main/docs/contribution-skills.md) for scopes, routing (`asterweave skill route`) and the CLI workflows.
