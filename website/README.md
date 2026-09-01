# Asterweave documentation site

This is the [Docusaurus](https://docusaurus.io/) site published to GitHub Pages at
<https://anjotadena.github.io/asterweave/>. See [`docs/contributing/development.md`](docs/contributing/development.md)
and [`docs/contributing/testing.md`](docs/contributing/testing.md) for how it fits into the rest of the repository.

## Local development

```bash
npm install
npm start
```

Starts a local dev server with live reload.

## Build

```bash
npm run build
```

Generates static content into `build/`. `onBrokenLinks` is set to `throw`, so a broken internal link fails this command.

## Documentation completeness check

```bash
npm run check-docs
```

Fails if a plugin skill or agent (`plugins/asterweave/skills/`, `plugins/asterweave/agents/`) has no corresponding
page under `docs/commands/` or `docs/agents/`, or if a documented command/agent page no longer matches anything in
the plugin source. This is what keeps the command and agent references from drifting into a second source of truth.

## Deployment

Deployment is automated by [`.github/workflows/docs.yml`](../.github/workflows/docs.yml) on every push to `main`
that touches `website/` or `plugins/asterweave/`. It is not deployed manually.
