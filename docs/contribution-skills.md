# Contribution skills

Eight skills for contributing to an existing repository, owned or open source. They are plugin skills under `plugins/asterweave/skills/` (`/asterweave:<id>` in Claude Code) and are also discoverable and routable from the CLI.

| Skill | Use it to | Workflow |
| --- | --- | --- |
| `contribute` | Assess a repository, rank opportunities, deliver one bounded task | `contribute@1` (`audit@1` when discovery only) |
| `repo-audit` | Find defects and gaps with evidence | `audit@1` |
| `issue-triage` | Decide whether an issue or finding is fixable now | in session |
| `bug-fix` (aliases `fix-bug`, `bugfix`, `fix-issue`) | Reproduce, fix, regression-test, verify | `bugfix@1` |
| `feature-implement` | Build to acceptance criteria | `delivery@1` |
| `test-verify` | Run checks, attribute failures | in session |
| `pr-review` | Review a diff or PR | in session |
| `pr-prepare` | Local contribution package (no push) | in session |

Shared detail (authorization scopes, finding record, status mapping, civic-data checklist) is in `plugins/asterweave/references/contribution.md` and loads only when a skill is selected.

## Invocation

```
asterweave skill list
asterweave skill show bug-fix --body
asterweave skill route "Fix issue 42"
asterweave skill route "Audit this repository and find something I can contribute"
asterweave run start "Search resets when I open a project and go back" --workflow auto
asterweave run start "Audit this repository" --workflow audit
asterweave run start "Fix the export bug" --workflow contribute
asterweave run show            # adds a Contribution section for these runs
npm run demo:contribute        # fixture demo, no model, no network
```

`--workflow auto` is opt-in; the default workflow is still `delivery`. Routing is a deterministic rule set over the request text (and a `--failing-test` hint). An audit request is `discovery` scope and selects `audit@1`, which has no node that can change the repository. Implementation scope comes from an instruction to fix, implement or deliver.

## Design

- Skills use the existing `SKILL.md` format. Versioned metadata is the single-line `asterweave-skill: 1` plus `triggers`, `inputs`, `outputs`, `capabilities`, `verification`, `stop-when`, `follow-ups` (and optional `aliases`, `prerequisites`). Skills without it are legacy and still load. The existing validator checks the new fields (`npm run validate`).
- Precedence for a bare id: user (`~/.claude/skills`) > repository (`.claude/skills`, only when the repository is trusted) > bundled. `asterweave:<id>` always selects the bundled definition. `skill list` and `skill show` print the winning source and what it shadows. Note the repository trust hash does not cover `.claude/skills`.
- `contribute@1` and `audit@1` are graphs on the existing engine. `test-verify` and `pr-review` failures re-enter `implement` within the node attempt budgets; a `blocked` outcome leaves the run blocked.
- Per-run state (`contribution.json` in the run directory): recorded scope, task, structured findings, remote-write journal. Scope is recorded once from the command and never widened on resume. Remote writes need a `publish` scope with an exact operation and target grant; a recorded remote id makes a retry a no-op and an uncertain write must be reconciled first. Library only: no shipped graph performs a remote write, and there is no CLI flag that grants `publish`.

## BetterBukidnon discovery example (read-only, 2026-11-11)

Inputs read with bounded, ordinary reads. Nothing was posted or opened.

- `Better-Bukidnon/budget`: public; root has `CLAUDE.md`, `LICENSE`, `README.md`, `docs/`, `examples/`, `scripts/`, `src/`, Vite/TypeScript config. `.github/` contains only `workflows/`.
- Issues: 28 open (first page of 10 read). Zero open PRs. Issue 32 (accessibility audit, WCAG 2.2 AA), 33 (performance budget), 34 (plain-language and Binisaya labels), 31 (labelled `blocked`) are candidates for `repo-audit`/`issue-triage`; none was triaged or reproduced.
- Site `budget.betterbukidnon.org`: the fetch returned only the page title ("Province of Bukidnon · FY 2027 budget projects"). Pages, data sources, units and budget stages are **unavailable** (client-rendered or not extracted); no data claim is made.
- Unavailable/unverified: contribution policy (no `CONTRIBUTING`, issue templates or security policy file at the root or in `.github`; `CLAUDE.md` and `docs/` not read), the remaining 18 issues, any source document, any reproduced defect.

Proposed next step (needs the user's authorization): `asterweave run start "Audit the accessibility of this repository" --workflow audit` in a clone, then `issue-triage` on issue 32.

## Limits

Everything is fixture-verified. Not exercised live: the Claude runner executing these nodes with a real model, GitHub writes (none exist for these workflows), parallel audit agents (sequential only). The run monitor shows skill, task, stage, findings, verification, blockers, next action, elapsed wall time and tokens when reported; the ledger does not record the active agent, current tool or changed files, and `run show` says so.
