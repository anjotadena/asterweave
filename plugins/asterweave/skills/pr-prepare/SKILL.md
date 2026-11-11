---
name: pr-prepare
description: Prepare a contribution for maintainer review. Produces a focused diff, commits where authorized, a PR title and body, issue linkage and a validation summary, without publishing.
argument-hint: "[base-branch] [issue]"
model: sonnet
effort: medium
asterweave-skill: 1
aliases: prepare-pr, contribution-package
triggers: prepare a PR, write the PR description, package the contribution, get this ready for review
inputs: base branch (optional), linked issue (optional)
prerequisites: test-verify and pr-review completed or their gaps stated
outputs: focused diff summary, commits where authorized, PR title and body, issue linkage, validation summary with exact checks, remaining blockers
capabilities: read, git-local
verification: the PR body lists only checks that were executed
stop-when: package written locally; publishing needs the submit-pr skill and authorization
follow-ups: submit-pr
---

# PR prepare

Base and issue: `$ARGUMENTS`. This skill writes a local package and never pushes or opens a PR.

1. Confirm the diff is focused: no unrelated edits, generated noise or secrets.
2. Follow the repository's PR template and commit conventions. Commit only if the user authorized commits.
3. Write the title and body: problem, change, issue linkage, validation summary with exact commands and results, remaining blockers and limitations.
4. To publish, hand off to [submit-pr](../submit-pr/SKILL.md). It needs authorization naming the action and target, and it records the PR number the moment it exists.
