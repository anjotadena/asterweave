---
sidebar_position: 1
title: Common issues
description: Symptoms, causes, diagnosis, and resolution for frequent Asterweave problems.
---

# Common issues

Run [`/asterweave:doctor`](/commands/doctor) first for any of these — it checks most of the underlying causes in one pass.

## Asterweave doesn't detect the project correctly

**Symptoms:** `detect-stack.mjs` output (surfaced during `analyze`, `daily`, or `doctor`) doesn't match the repository's real stack or commands.

**Cause:** Stack detection is a *signal generator*, not an authority — it can be wrong on unusual layouts, and Asterweave is explicitly required to verify its signals against manifests, CI, and documentation rather than trust them blindly.

**Diagnose:** Run `/asterweave:doctor --verbose` and compare its reported commands against your actual build/test scripts.

**Resolution:** Run [`/asterweave:scaffold`](/commands/scaffold) so an evidence-backed `CLAUDE.md`/`.claude/rules/` captures the real commands and conventions going forward — subsequent nodes read those first instead of re-deriving them from detection each time.

## Scaffold keeps changing files on `--refresh`

**Symptoms:** Repeated `/asterweave:scaffold --refresh` proposes changes to the same files.

**Cause:** Usually a genuinely moving target — the repository's build/test commands, architecture, or CI keep changing — or a hand-edited managed file has drifted from what scaffolding last generated, and each refresh re-detects the same drift.

**Diagnose:** Read the proposal's conflicts/warnings section; it names exactly which file drifted and why.

**Resolution:** Make an explicit keep/update/remove decision for the drifted file rather than repeatedly approving a churny digest. If the repository's conventions are still actively changing, wait until they stabilize before refreshing again.

## A repository agent conflicts with a generic Asterweave agent

**Symptoms:** Both a `.claude/agents/*.md` file and an Asterweave plugin agent seem to cover the same ground.

**Cause:** The repository agent should have been classified `MERGE` or `REMOVE` during scaffolding, per [existing agent classification](/repositories/scaffolding#existing-agent-classification), but wasn't (perhaps it was added after the last scaffold run).

**Diagnose:** Compare the repository agent's actual system prompt against the [agent reference](/agents/overview) — is it doing generic code/security review or generic implementation?

**Resolution:** Run `/asterweave:scaffold --refresh` and accept the classification it proposes, or manually fold genuine domain rules into a `.claude/rules/*.md` file and delete the duplicate agent. Never let both silently coexist. See [Asterweave vs. the repository](/concepts/plugin-vs-repository).

## The `PreToolUse` hook blocks a command unexpectedly

**Symptoms:** A shell command is denied with an "Asterweave blocked this command" message.

**Cause:** The command matched one of the [fixed destructive-operation patterns](/hooks/pre-tool-use#what-it-blocks) — most often an unintended match inside a larger command string, not necessarily a truly destructive intent.

**Diagnose:** Read the denial reason; it names the exact pattern that matched.

**Resolution:** Use the safer, explicit alternative the hook is nudging toward (for example, a scoped restore of a specific path rather than a bulk one). Do not set `ASTERWEAVE_DISABLE_DESTRUCTIVE_GUARD=1` to work around it in a normal delivery — that variable exists for the plugin's own test suite. See [PreToolUse: destructive-command guard](/hooks/pre-tool-use).

## Build/test commands aren't detected

**Symptoms:** `analyze`/`test`/`doctor` report no discovered build or test command.

**Cause:** The repository uses an uncommon wrapper (a custom script, an unusual `tasks` runner) that `detect-stack.mjs` doesn't recognize as a signal.

**Diagnose:** Check `/asterweave:doctor --verbose` output against your actual CI workflow file.

**Resolution:** Run `/asterweave:scaffold` — evidence-backed `qualityGates.required` entries in `.claude/asterweave.json` (see the [reference](/configuration/asterweave-json)) let you declare the exact command, with its CI source, once.

## A work item cannot be loaded

**Symptoms:** `intake`, `daily`, or a task command reports it cannot read the issue/work item.

**Cause:** An ambiguous repository/organization reference, an unconfigured or disconnected provider MCP, or insufficient token scope.

**Diagnose:** Run `/asterweave:doctor` and check the MCP connectivity section; confirm the reference you passed matches `owner/repo#123` (GitHub) or `organization/project` + ID (Azure DevOps).

**Resolution:** Fix the reference, or reconfigure the provider per [Prerequisites](/getting-started/prerequisites) and [Repository integration](/repositories/repository-integration).

## A pull request already exists

**Symptoms:** `submit-pr` finds an existing PR for the branch.

**Cause:** A prior `deliver` run (possibly interrupted) already created it.

**Diagnose:** Run `/asterweave:resume --inspect-only` to see whether workflow state already references a PR number.

**Resolution:** Let Asterweave update the existing PR rather than creating a second one — this is the expected, safe behavior, not an error to work around.

## A pipeline keeps failing

See the dedicated [Pipeline failures](/usage/pipeline-failures) guide for retry limits and the `NEEDS_HUMAN` outcome.

## A workflow cannot resume

**Symptoms:** `/asterweave:resume` reports a material conflict between state and the repository.

**Cause:** The branch was deleted, force-pushed by something else, or the repository diverged significantly since the last recorded event.

**Diagnose:** `resume` itself reports the specific divergence it found.

**Resolution:** Don't force a resume past a genuine conflict — let Asterweave route to re-analysis or replan, or start a fresh `deliver` if the prior branch is truly gone.

## Configuration is invalid

**Symptoms:** Write stages are blocked, citing an invalid `.claude/asterweave.json`.

**Cause:** A property outside the [schema](/configuration/asterweave-json) (all objects are `additionalProperties: false`), a bad `version`, or a routing key that isn't one of the [routable stages](/architecture/agent-routing#routable-stages).

**Diagnose:** `/asterweave:doctor` reports adapter validity explicitly.

**Resolution:** Fix the file against the [reference](/configuration/asterweave-json) — most often a typo'd stage name or an extra property.

## A spec looks stale

**Symptoms:** `challenge` flags a contradiction between the task and an existing `specs/` document.

**Cause:** This is by design — a contradiction is a **blocker**, not a silent override.

**Resolution:** Resolve the actual product question, then approve the spec update `challenge`/`plan` proposes. See [Specifications](/concepts/specifications).

## An agent seems to have been selected incorrectly

**Symptoms:** A stage ran with a generic Asterweave agent when you expected a project-specific one, or vice versa.

**Cause:** `.claude/asterweave.json` has no route for that stage, or the route's `agent`/`skills` names don't match what actually exists under `.claude/agents/`/`.claude/skills/`.

**Diagnose:** Compare `routing.<stage>` in the adapter against the [agent routing precedence](/architecture/agent-routing#precedence) and the actual files present.

**Resolution:** Fix the adapter, or run `/asterweave:scaffold --refresh` to regenerate it from current evidence.

## Migrating from a LoopForge installation

**Symptoms:** You previously used `loopforge@at-digital-labs` and want to switch to Asterweave.

**Cause:** Asterweave is a rename that changes the plugin identity and command namespace (`/loopforge:*` → `/asterweave:*`). The two plugins register equivalent hooks and GitHub MCP behavior and must not both be enabled at once.

**Resolution:**

1. Finish or pause any active LoopForge workflow, then disable and uninstall `loopforge@at-digital-labs`.
2. Install Asterweave per [Installation](/getting-started/installation).
3. Workflow state is not migrated automatically. To resume unfinished work: first verify `.claude/asterweave/` does not already exist, then rename `.claude/loopforge/` to `.claude/asterweave/`.
4. Keep a backup of the renamed directory until [`/asterweave:doctor`](/commands/doctor) and [`/asterweave:resume`](/commands/resume) both confirm the state is valid.

## Related

[`/asterweave:doctor`](/commands/doctor), [Debugging a delivery](/usage/troubleshooting-workflow).
