---
sidebar_position: 3
title: Starting new work
description: What to expect between assigning a ticket and Asterweave being READY to implement it.
---

# Starting new work

## The sequence

1. Open the repository.
2. Confirm your working tree is safe to work in (no uncommitted work you'd lose track of).
3. Identify the work item.
4. Run:

```text
/asterweave:deliver <id>
```

Asterweave determines, on its own, whether an existing specification is sufficient, whether story analysis is needed, whether blocking ambiguity exists, whether additional human input is required, and whether a repository-specific agent should handle a stage.

## Possible outcomes

| Outcome | Meaning | Your response |
| --- | --- | --- |
| Proceeds to plan approval | `challenge` returned `READY` or `READY_WITH_ASSUMPTIONS` | Review the plan, approve or ask for changes |
| `BLOCKED` | A genuine product/business decision is missing | Answer the specific question(s) asked |
| `needs-human` | Something else requires your judgment (an outcome the graph can reach at several nodes, not only `challenge`) | Read the reason, provide the decision |
| `policy-denied` | A proposed action would weaken a mandatory gate | Choose a safer approach — the gate will not be bypassed |
| `security-escalation` | A security finding needs a remediation decision | Review the finding and decide |

## Example: a `BLOCKED` outcome

```text
/asterweave:deliver 4821
```

might report something like:

> **Work item:** ADO-4821
> **Analysis:** BLOCKED
> **Reason:** Expected behavior for partial refunds exceeds documented business rules.
> **Questions:**
> 1. Should multiple partial refunds be allowed against the same payment?
> 2. What happens when total refunds equal the original payment amount?

Answer the questions in your reply. Re-invoking `/asterweave:deliver 4821` picks the workflow back up from its recorded state rather than starting over — see [Continuing interrupted work](/usage/continuing-work).

## Manual vs. autonomous responsibility

**Asterweave handles automatically:** repository discovery, reading the work item, relevant source/test discovery, implementation planning mechanics, branch preparation, implementation, verification, agent routing, security/code review, PR creation, pipeline monitoring, retryable fixes within budget, and reporting back.

**Stays yours, and Asterweave will pause for it:** ambiguous product intent, high-risk or destructive actions, major architectural change, breaking API behavior without your approval, business-rule decisions not present in any source of truth, and accepting risk exceptions.

Asterweave is built to reduce routine interaction, not to remove your ownership of intent.

## Related

[Daily workflow](/usage/daily-workflow), [Continuing interrupted work](/usage/continuing-work), [Architecture overview](/architecture/overview#typed-edges-and-recovery) for the full set of typed stop states.
