---
sidebar_position: 1
title: asterweave.json reference
description: Every supported property of .claude/asterweave.json.
---

# `asterweave.json` reference

`.claude/asterweave.json` connects Asterweave's reusable graph to project-specific skills, agents, and quality gates. It is optional — a repository with no adapter simply uses Asterweave's defaults everywhere. Asterweave validates it against [`repository-adapter.schema.json`](https://github.com/anjotadena/asterweave/blob/main/plugins/asterweave/schemas/repository-adapter.schema.json) before any write stage runs; an invalid adapter blocks those stages until fixed.

:::note File name
The adapter file is `.claude/asterweave.json` — **JSON**, not YAML.
:::

## Properties

| Property | Type | Required | Default | Description |
| --- | --- | :---: | --- | --- |
| `version` | `1` (const) | ✅ | — | Schema version; must be exactly `1`. |
| `provider.workItems` | `"github"` \| `"azure-devops"` \| `"none"` | — | `"github"` | Which system `deliver`, `daily`, and the task skills use for issues/work items and PR handling. |
| `routing.<stage>` | object | — | — | Per-stage routing to a project skill/agent. Keys must be one of the [routable stages](/architecture/agent-routing#routable-stages). |
| `routing.<stage>.agent` | string (`^[a-z0-9]+(-[a-z0-9]+)*$`) | — | — | Name of a project agent under `.claude/agents/` to delegate this stage to. |
| `routing.<stage>.skills` | string[] (same pattern, unique) | — | `[]` | Project skills to invoke before delegating this stage. |
| `qualityGates.required` | array | — | `[]` | Additional required quality-gate commands, added to every stage/final gate set. |
| `qualityGates.required[].id` | string (`^[a-z0-9]+(-[a-z0-9]+)*$`) | ✅ (within entry) | — | A short identifier for the gate. |
| `qualityGates.required[].command` | string | ✅ (within entry) | — | The exact command to run. |
| `qualityGates.required[].source` | string | ✅ (within entry) | — | Where this command was discovered (for example a CI workflow file), for auditability. |
| `qualityGates.required[].timeoutSeconds` | integer (1–7200) | — | — | Optional timeout for the gate command. |

`additionalProperties` is `false` at every level — an unrecognized property makes the adapter invalid.

## Routable stages

`analyze`, `challenge`, `plan`, `implement`, `test`, `verify`, `review`, `submit-pr`, `monitor-pipeline`, `resolve-review-comments`, `update-work-item`.

`intake` and `approve` cannot be routed — they are always Asterweave-owned.

## Full example

```json title=".claude/asterweave.json"
{
  "version": 1,
  "provider": {
    "workItems": "github"
  },
  "routing": {
    "implement": {
      "agent": "payments-implementer",
      "skills": ["payments-domain", "tenant-security"]
    },
    "test": {
      "agent": "payments-test-engineer",
      "skills": ["integration-test-harness"]
    }
  },
  "qualityGates": {
    "required": [
      {
        "id": "build",
        "command": "dotnet build PaymentSpace.sln --no-restore",
        "source": "azure-pipelines.yml",
        "timeoutSeconds": 900
      }
    ]
  }
}
```

## What this cannot do

Routing may **add** quality-gate commands and **narrow** permissions. It cannot skip human approval, evidence, testing, runtime verification, independent review, security review, or Git-safety rules — see [What routing can and cannot do](/architecture/agent-routing#what-routing-can-and-cannot-do).

## Related

[Agent routing](/architecture/agent-routing), [Plugin settings](/configuration/plugin-settings), [Repository scaffolding](/repositories/scaffolding).
