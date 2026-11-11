---
name: pr-review
description: Review a diff or pull request and report prioritized, actionable findings with file references, evidence, impact and a suggested resolution.
argument-hint: "[pr-url|pr-number|base-branch]"
model: opus
effort: high
asterweave-skill: 1
aliases: review-pr
triggers: review this PR, review the diff, review my changes, look over the pull request
inputs: PR reference or branch (optional, default current diff)
prerequisites: diff readable
outputs: findings by severity with file:line, evidence, impact, suggested resolution; verdict
capabilities: read, search, tracker-read
verification: each finding was checked against the code and is introduced or exposed by the change
stop-when: verdict given
follow-ups: bug-fix, feature-implement, pr-prepare
---

# PR review

Target: `$ARGUMENTS`. Follow the [review skill](../review/SKILL.md) for the staff and security passes.

1. Read complete touched files, the diff and tests, not only added lines.
2. Report `Critical`, `High`, `Medium`, `Low` with `file:line`, evidence, impact and a suggested fix. Separate pre-existing issues.
3. Posting review comments on a remote PR is a remote action and needs authorization for that PR; otherwise return the review locally.
4. If nothing blocks, say so without inventing findings.
