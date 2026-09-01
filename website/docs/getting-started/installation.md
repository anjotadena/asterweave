---
sidebar_position: 2
title: Installation
description: Install and enable the Asterweave plugin.
---

# Installation

## From GitHub (recommended)

Run inside any Claude Code session:

```text
/plugin marketplace add anjotadena/asterweave-marketplace
/plugin install asterweave@at-digital-labs
/plugin enable asterweave@at-digital-labs
/reload-plugins
/asterweave:doctor
```

Claude Code prompts for the GitHub token on enable and stores it as sensitive plugin configuration.

## From a local clone

```bash
git clone https://github.com/anjotadena/asterweave-marketplace
```

Start Claude Code from the directory *containing* the clone, then:

```text
/plugin marketplace add ./asterweave-marketplace
/plugin install asterweave@at-digital-labs
/plugin enable asterweave@at-digital-labs
```

## For plugin development

```bash
claude --plugin-dir ./asterweave-marketplace/plugins/asterweave
```

## Verify a release before installing

```bash
npm run check                              # offline structural + behavioral validation
claude plugin validate ./plugins/asterweave
```

`npm run check` runs the manifest validator and the full unit test suite; it needs no network access. `claude plugin validate` requires Claude Code on the machine.

## Enterprise rollout

Host the repository under organization control, review releases, and pin approved versions or commit SHAs. Administrators can declare the marketplace and plugin in managed or project settings:

```json
{
  "extraKnownMarketplaces": {
    "at-digital-labs": {
      "source": {
        "source": "github",
        "repo": "anjotadena/asterweave-marketplace"
      }
    }
  },
  "enabledPlugins": {
    "asterweave@at-digital-labs": true
  }
}
```

Combine with managed `strictKnownMarketplaces`, permission deny rules, sandboxing, branch protection, required checks, CODEOWNERS, secret scanning, and human review — the plugin's hooks are not a replacement for platform policy. See [Security](/repositories/repository-integration#github-token-posture) for token guidance.

## Next

Continue to [Quick start](/getting-started/quick-start).
