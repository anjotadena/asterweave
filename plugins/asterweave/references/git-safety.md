# Git and change-safety policy

## Before work

- Inspect status, current branch, upstream, remotes, and relevant base history.
- Identify user-owned modified and untracked files. Preserve them.
- Never assume the working tree is clean or that every diff belongs to the task.
- Do not automatically pull, switch branches, stash, pop, rebase, reset, clean, restore, or discard.

## During work

- Keep the change scoped and avoid unrelated formatting/generated churn.
- Parallel writers require separate worktrees/branches and explicit ownership.
- Review complete touched files and `git diff --check` before staging.
- Stage only task-related paths. Verify the staged diff before commit.
- Never commit secrets, local workflow state, build output, or environment files.

## Submission

- Do not work directly on a protected/default branch.
- Use logical commits with clear messages and no unrelated changes.
- Push without force. Never rewrite shared history.
- Confirm base/head repository and branch before creating a PR.
- Do not merge, self-approve, dismiss reviews, bypass checks, or delete branches.

The pre-tool hook blocks a small set of destructive commands but is not a complete safety system. Continue to use Claude Code permissions, sandboxing, branch protection, required checks, CODEOWNERS, and human review.
