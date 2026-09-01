---
sidebar_position: 9
title: Daily cheat sheet
description: The scannable, copy-paste version of everything on this page.
---

# Daily cheat sheet

**First time in a repository**

```text
/asterweave:scaffold
```

**Normal ticket**

```text
/asterweave:deliver <id>
```

**Finish a half-built repository, module by module**

```text
/asterweave:complete-project
```

**Understand a ticket before committing to it**

```text
/asterweave:analyze <id>
/asterweave:challenge <id>
```

**Review changes you wrote manually (staff + security)**

```text
/asterweave:review
```

**Resume interrupted work**

```text
/asterweave:resume
```

**Check repository alignment without changing anything**

```text
/asterweave:scaffold --check
```

**Triage today**

```text
/asterweave:daily
```

**Health check**

```text
/asterweave:doctor
```

**Learn from a finished or blocked workflow**

```text
/asterweave:retro
```

:::note
There is no separate `bootstrap`, `analyze-user-story`, `security-review`, or `resolve-pr-comments` command — use `scaffold`, `analyze`/`challenge`, `review`, and `deliver`/`resume` respectively. See the [command overview](/commands/overview).
:::

## Related

[Common scenarios](/usage/common-scenarios), [Command overview](/commands/overview).
