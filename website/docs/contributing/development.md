---
sidebar_position: 1
title: Development
description: Working on the Asterweave plugin itself.
---

# Contributing to Asterweave

This page is about working on **the plugin itself** (`plugins/asterweave/`), not about using it in a downstream repository.

## Repository layout

```text
.claude-plugin/marketplace.json    marketplace catalog (no version — plugin.json is authoritative)
plugins/asterweave/                the plugin itself
  .claude-plugin/plugin.json       authoritative version and user config
  .mcp.json                        GitHub MCP server, token via ${user_config.github_token}
  skills/ agents/ hooks/           workflow surface
  scripts/ schemas/ tests/         deterministic core
website/                           this documentation site (Docusaurus)
package.json                       npm run check → validate + test
```

## Local setup

```bash
git clone https://github.com/anjotadena/asterweave
cd asterweave
npm install
```

Run the plugin against a local Claude Code session with:

```bash
claude --plugin-dir ./plugins/asterweave
```

## Testing

```bash
npm test        # node plugins/asterweave/scripts/run-tests.mjs
npm run validate # node plugins/asterweave/scripts/validate-plugin.mjs plugins/asterweave
npm run check    # both — offline, no network required
```

Unit tests live under `plugins/asterweave/tests/` and currently cover stack detection, workflow-state/graph routing and recovery, plugin/skill/agent manifest validity, repository scaffolding, and the two hooks. `npm run check` is the same offline validation the README's [installation](/getting-started/installation#verify-a-release-before-installing) instructions recommend before installing a release.

If Claude Code is available on the machine, also run:

```bash
claude plugin validate ./plugins/asterweave
```

## Working on documentation

This site lives in `website/` and is built with [Docusaurus](https://docusaurus.io/). See [Documentation testing](/contributing/testing) for how it's built and checked in CI.

```bash
cd website
npm install
npm start   # local dev server with live reload
npm run build
```

## Architecture guidelines

Follow the same principles the plugin itself is built on — see [Core concepts](/concepts/core-concepts) and [Architecture overview](/architecture/overview):

- deterministic state graphs over narrative confidence;
- bounded local agent loops with isolated specialist contexts;
- append-only evidence, never overwritten;
- progressive disclosure — minimal always-loaded context, lazy path rules, on-demand skills/references;
- evaluator/implementer separation — the agent that reviews a change is never the agent that wrote it;
- least-privilege tool allowlists per agent, with an explicit `disallowedTools` for anything that must never write or spawn further agents.

A new skill or agent should follow the same shape as the existing ones: short frontmatter (`name`, `description`, `model`, `effort`, `argument-hint` where relevant), a scoped system prompt, and — for agents — an explicit tool allowlist.

## Pull requests

Keep changes scoped and evidence-backed, the same standard Asterweave itself enforces on the repositories it works in. Run `npm run check` before submitting. There is currently no separate `CONTRIBUTING.md` or tagged release process in this repository beyond the version recorded in `plugins/asterweave/.claude-plugin/plugin.json` — check open [issues](https://github.com/anjotadena/asterweave/issues) and recent history for the current state of in-flight work before starting something large.

## Related

[Documentation testing](/contributing/testing), [Architecture overview](/architecture/overview).
