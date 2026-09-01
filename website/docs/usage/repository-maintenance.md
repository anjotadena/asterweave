---
sidebar_position: 7
title: Repository maintenance
description: Keeping .claude healthy, adding project rules and agents, and team/onboarding practice.
---

# Repository maintenance

## When to reconcile

Run [`/asterweave:scaffold --refresh`](/commands/scaffold) when:

- a major framework upgrade occurs;
- the architecture changes;
- testing tooling changes;
- the repository is reorganized;
- build/test commands change;
- duplicated agents or rules have accumulated;
- Asterweave's own major version changes.

To check for drift without changing anything first:

```text
/asterweave:scaffold --check
```

which reports something like:

> **Repository drift detected.**
> **Changed:** test framework, source layout
> **Stale:** `.claude/rules/testing.md`
> **Duplicate:** a local `code-reviewer` agent
> **Recommended:** run scaffold reconciliation.

## Adding a project rule

**Scenario:** Asterweave keeps proposing a repository abstraction over your persistence layer, but this project intentionally uses `ApplicationDbContext` directly.

**Correct fix:** add a project-specific rule, not a plugin-wide exception.

```markdown title=".claude/rules/backend.md"
---
paths:
  - "src/Persistence/**"
---

Persistence handlers use ApplicationDbContext directly.
Do not introduce repository abstractions unless required by an
approved architecture decision.
```

This belongs in repository rules because it's project-specific — never edit Asterweave's own global behavior for one project's convention.

## Adding a project-specific agent

**Scenario:** finance code needs specialized accounting/settlement validation a generic reviewer can't reasonably provide.

1. Create `.claude/agents/finance-domain-reviewer.md` with a narrow purpose, scope, trigger conditions, least-privilege tool permissions, expected inputs, and the kinds of findings it should surface.
2. Route to it in `.claude/asterweave.json`:

```json
{
  "version": 1,
  "routing": {
    "review": {
      "agent": "finance-domain-reviewer"
    }
  }
}
```

(Routing applies per stage, not per path glob — a domain-specific reviewer is typically invoked for the `review` stage on any change, and relies on its own scoped instructions to focus on the paths that matter to it.)

Do this only for expertise that generic Asterweave agents cannot reasonably provide — see [Repository-specific agents](/repositories/scaffolding#repository-specific-agents).

## Do not duplicate Asterweave

Don't create repository copies of: the generic delivery workflow, a generic code reviewer, a generic security reviewer, generic pipeline monitoring, the generic PR workflow, generic retry logic, or generic branch handling. Configure Asterweave (`.claude/asterweave.json`) or add a project rule instead. See [the worked scaffolding example](/repositories/scaffolding#worked-example).

## The decision tree for new project knowledge

See [Asterweave vs. the repository](/concepts/plugin-vs-repository#a-decision-tree-for-new-project-knowledge) for the full diagram: product behavior → `specs/`; engineering convention → `.claude/rules/`; bounded domain reviewer knowledge → `.claude/agents/`; reusable across many repositories → propose it to the plugin; deterministic safety enforcement → a hook (treated as its own high-risk design task); temporary to one delivery → workflow state, never committed.

## Team workflow: what to commit

**Usually commit:** `CLAUDE.md`, `.claude/rules/`, `.claude/agents/`, `.claude/asterweave.json`, `specs/`.

**Usually don't commit:** `.claude/asterweave/` (workflow execution state — gitignorable by default), local caches, temporary analysis output, and never secrets.

Committed repository context is what gives every developer, and every Asterweave session, consistent project knowledge — it's not personal configuration.

## Onboarding a new developer

1. Install Claude Code and the Asterweave plugin.
2. Clone the repository.
3. Read the project's `CLAUDE.md`.
4. Skim the relevant `.claude/rules/*.md` files.
5. Run [`/asterweave:scaffold --check`](/commands/scaffold) to confirm repository alignment.
6. Review `.claude/asterweave.json` if the repository has one.
7. Run [`/asterweave:analyze`](/commands/analyze) on something familiar, to see how Asterweave understands the codebase.
8. Deliver a low-risk ticket end to end with [`/asterweave:deliver`](/commands/deliver).
9. Review the generated PR carefully — this is the best way to calibrate trust in what Asterweave produces.

A developer should be able to become productive this way without reading Asterweave's internals first.

## Related

[Repository scaffolding](/repositories/scaffolding), [The `.claude` directory](/repositories/claude-directory), [Agent routing](/architecture/agent-routing).
