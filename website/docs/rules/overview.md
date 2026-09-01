---
sidebar_position: 1
title: Rules overview
description: Global plugin policy vs. project-specific rules, and how they combine.
---

# Rules

Asterweave should not be the place for every project coding convention, and a repository's `.claude/rules/` should not be the place to re-litigate Asterweave's safety policy. Two layers exist, and they don't overlap.

## Global plugin policy (not editable per-repository)

Baked into the plugin's skills, agents, and hooks — the same everywhere Asterweave runs:

- Evidence discipline: "Do not claim tests passed unless they were executed" (see [the evidence contract](/architecture/overview#evidence)).
- Git and change safety: never work directly on a protected/default branch, never force-push, never bulk-discard user changes without consent.
- Approval gates: human approval after `challenge`/`plan`, and again before commit/push/PR unless `--auto-pr` was explicitly passed.
- Security review is mandatory and independent, every time.

A repository can **add** checks or **narrow** permissions on top of this. It cannot remove or weaken it — see [Agent routing](/architecture/agent-routing#what-routing-can-and-cannot-do).

## Project rules (`.claude/rules/*.md`)

Specific to one repository: path-scoped conventions that `/asterweave:scaffold` generates or refreshes from real evidence, never invented.

```text
.claude/
└── rules/
    ├── backend.md
    ├── frontend.md
    ├── database.md
    ├── testing.md
    └── security.md
```

Each rule file requires a `paths` frontmatter scope and stays cohesive — one topic per file, matching real paths rather than a catch-all glob.

**Global example:** "Do not claim tests passed unless they were actually executed." — this is Asterweave policy; it does not belong in a repository rule file (it's already enforced).

**Project example:**

```markdown title=".claude/rules/backend.md"
---
paths:
  - "src/Commands/**"
---

Commands use Vertical Slice Architecture. Each command owns its handler,
validator, and endpoint in one folder; do not introduce a shared service
layer across command boundaries.
```

## Precedence

From [the repository scaffolding contract](/repositories/scaffolding), conflicts resolve in this order:

1. organization-managed security, permissions, and compliance;
2. Asterweave's destructive-operation and evidence invariants;
3. existing repository instructions and verified CI policy;
4. observed architecture and conventions;
5. approved task requirements;
6. Asterweave's stack defaults;
7. model judgment.

A demonstrably insecure or incorrect existing repository pattern is never preserved as a rule merely because it's already there — Asterweave records the evidence, the risk, and a recommended decision instead of normalizing it.

## Related

[Asterweave vs. the repository](/concepts/plugin-vs-repository), [Adding a project rule](/usage/repository-maintenance#adding-a-project-rule).
