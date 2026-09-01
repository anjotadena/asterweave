---
sidebar_position: 2
title: Documentation testing
description: How this site is built, checked, and kept from drifting off the plugin's real command set.
---

# Documentation testing

## Building the site

```bash
cd website
npm install
npm run build
```

A broken build fails loudly (Docusaurus's `onBrokenLinks` is set to `throw`) — an internal link to a page that doesn't exist fails the build, not just a warning.

## Documentation completeness check

`website/scripts/check-docs.mjs` compares the plugin's actual skills and agents (`plugins/asterweave/skills/*/SKILL.md`, `plugins/asterweave/agents/*.md`) against the pages under `website/docs/commands/` and `website/docs/agents/`, and fails if:

- a skill exists with no corresponding `commands/<name>.md` page;
- an agent exists with no corresponding `agents/<name>.md` page;
- a documented command or agent page doesn't correspond to anything in the plugin source (stale documentation for something that was removed).

Run it locally with:

```bash
node website/scripts/check-docs.mjs
```

This is the mechanism that keeps the command and agent references from drifting into a second, independent source of truth — see [Automatic command documentation](/contributing/development#architecture-guidelines) for why that matters.

## CI

The `docs` GitHub Actions workflow (`.github/workflows/docs.yml`) runs on every push/PR touching `website/` or the plugin source: installs dependencies, runs `check-docs.mjs`, builds the site, and — only on `main` — deploys the build to GitHub Pages. Any failure in the completeness check or the build fails CI.

## What isn't automated yet

There is currently no automated broken-external-link checker or spell-checker in CI. Treat `onBrokenLinks: 'throw'` (internal links) and `check-docs.mjs` (command/agent coverage) as the current guarantees, and review external links and prose manually in review.

## Related

[Development](/contributing/development), [GitHub Pages deployment](https://github.com/anjotadena/asterweave/blob/main/.github/workflows/docs.yml).
