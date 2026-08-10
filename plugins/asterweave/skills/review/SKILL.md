---
name: review
description: Run independent staff-engineering and security reviews over the complete diff and affected consumers, then separate blocking defects from optional improvements.
argument-hint: "[base-branch|scope]"
model: opus
effort: high
---

# Review independently

Review `$ARGUMENTS` after implementation and verification.

1. Read complete touched files, diff, tests, acceptance evidence, downstream consumers of changed interfaces, and [repository adapter](../../references/repository-adapter.md). Resolve the `review` route, invoke configured project skills, and delegate the staff pass to its project agent or `asterweave:staff-reviewer` when no route exists.
2. Check correctness, architecture boundaries, authorization, security, data integrity, concurrency, error behavior, backward compatibility, performance, accessibility, observability, migrations, and maintainability.
3. Validate test quality and identify behavior not covered by unit/integration/runtime evidence.
4. Delegate a separate pass to `asterweave:security-reviewer`; do not leak your expected findings.
5. Verify every reported issue is real and introduced or exposed by this change.
6. Report findings by `Critical`, `High`, `Medium`, or `Low`, with file/location, evidence, impact, recommended fix, and trade-off.
7. Mark Critical/High findings as graph blockers. Separate pre-existing issues and optional suggestions.
8. Return a verdict and `code-review` plus `security-review` evidence summaries.

If no blocking findings exist, say so explicitly without inventing issues.
