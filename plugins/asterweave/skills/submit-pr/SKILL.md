---
name: submit-pr
description: Prepare, push, and create or update a GitHub pull request only after Asterweave quality gates pass, with safe Git handling, evidence-rich PR content, and explicit confirmation.
argument-hint: "[base-branch] [--draft]"
disable-model-invocation: true
model: sonnet
effort: high
---

# Submit a verified pull request

Submit `$ARGUMENTS` under [Git safety](../../references/git-safety.md), [repository adapter](../../references/repository-adapter.md), and the configured provider's workflow — [GitHub](../../references/github-mcp.md) by default, or [Azure DevOps](../../references/azure-devops-mcp.md) when `.claude/asterweave.json` sets `provider.workItems: azure-devops`. Resolve the `submit-pr` route and use its project skills/agent when configured; otherwise use `asterweave:pr-engineer`.

1. Require a completed or submit-ready Asterweave state. Run `node "${CLAUDE_SKILL_DIR}/../../scripts/graph-state.mjs" status --compact` and refuse if test, verify, or review gates have not passed.
2. Inspect status, branch, upstream, remote, base branch, commits, complete diff, generated files, and possible secrets. Preserve unrelated changes and stage only task files.
3. Re-run required final build, lint/static analysis, unit, integration/contract, and acceptance verification commands when evidence is stale or the diff changed.
4. Draft a conventional commit message and PR body with:
   - linked issue and outcome;
   - change summary and architecture decisions;
   - acceptance-criteria evidence matrix;
   - exact tests and results;
   - security/data/migration/compatibility impacts;
   - rollout, rollback, observability, risks, and screenshots where relevant.
5. Show branch, files to commit, commit message, remote target, and PR draft before any commit, push, or GitHub mutation. Obtain explicit confirmation.
6. Commit only related files, push without force, then use the bundled GitHub MCP to create or update the PR. Default to draft when uncertainty, migration, or follow-up validation remains.
7. Read back the PR, verify base/head/title/body/linked issue, and inspect checks. Record `pull-request` evidence with URL and commit SHA.
8. Inside an active `deliver` workflow, hand off to the `monitor-pipeline`, `resolve-review-comments`, and `update-work-item` nodes rather than declaring delivery complete here.

Never merge, approve your own PR, bypass checks, dismiss reviews, or delete branches.
