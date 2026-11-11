---
name: contribute
description: Help an existing repository, owned or open source, with a contribution. Assesses the repository, ranks opportunities, selects one bounded task, delivers a verified patch or a documented blocker, and prepares the contribution package.
argument-hint: "<repository|url|objective>"
model: opus
effort: high
asterweave-skill: 1
triggers: contribute to, help this project, find something I can contribute, open source contribution, deliver a contribution
inputs: objective (required), repository path or URL (optional), authorization scope (optional, default discovery)
prerequisites: git, repository readable
outputs: repository assessment, ranked opportunities, selected task with acceptance criteria, verified patch or blocker, contribution package
capabilities: read, search, git-local, run-tests
verification: test-verify then pr-review passed for the selected task
stop-when: scope is discovery and findings are reviewed, a blocker needs the user, attempt or cost limit reached
follow-ups: repo-audit, issue-triage, bug-fix, feature-implement, test-verify, pr-review, pr-prepare
---

# Contribute

Objective and scope: `$ARGUMENTS`. Read the [contribution reference](../../references/contribution.md) first.

1. **Discover**: identity, branch and commit, license, setup, CONTRIBUTING and AGENTS guidance, issue templates, security policy, tooling. Do not run setup hooks or install packages before the repository is trusted.
2. **Scope and baseline**: record the objective and authorization scope. Run the existing checks for a baseline and note unrelated working tree edits; never stash, reset or clean them.
3. **Existing work**: read open issues and PRs where access exists. Search for duplicates and active work. If access is missing, record it as unavailable.
4. **Audit**: invoke `repo-audit` for the relevant area. Keep observed defects, suspected problems and ideas apart.
5. **Triage**: invoke `issue-triage` on the candidates. Rank by impact, evidence, suitability, effort, dependencies and maintainer guidance. No invented scores or percentages.
6. **Select** one bounded task inside the request. Write acceptance criteria and reproduction steps before editing.
7. **Implement** with `bug-fix` or `feature-implement`, in a branch or worktree. Sequential execution is the default; parallel audit or review needs authorization, a concurrency cap and one write owner per file set.
8. **Verify** with `test-verify`, then `pr-review`. Return to step 7 only for actionable failures or findings, within attempt and cost limits.
9. **Package** with `pr-prepare`. Report blockers and the exact checks performed.

A `discovery` scope ends after step 5 with reviewed findings and proposed work. Remote actions need authorization naming the action and target.
