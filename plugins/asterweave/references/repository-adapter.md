# Repository adapter

`.claude/asterweave.json` connects Asterweave's reusable graph to project-specific skills, agents, and quality gates. It follows [the repository adapter schema](../schemas/repository-adapter.schema.json).

`provider.workItems` selects which work-item/PR system `deliver`, `daily`, and the task skills use: `github` (default when unset), `azure-devops`, or `none` for local-only workflows without an external tracker. Setting it does not change delivery gates — it only selects the MCP connection and task skill used for intake, PR handling, and the `update-work-item` node.

Routable stages are `analyze`, `challenge`, `plan`, `implement`, `test`, `verify`, `review`, `submit-pr`, `monitor-pipeline`, `resolve-review-comments`, and `update-work-item`. `intake` and `approve` are never routable — they are always Asterweave-owned.

```json
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

## Runtime routing

Before each supported stage, run:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/scaffold-repo.mjs" route <stage> --root .
```

If a route exists:

1. invoke its project skills by exact unscoped name;
2. delegate the bounded stage to its project agent with a self-contained prompt;
3. retain Asterweave's node contract, evidence requirements, retry budgets, and security gates;
4. add every configured quality command to the stage/final gate set.

If no route exists, use the Asterweave specialist. Invalid adapter or managed-artifact drift blocks write stages until resolved. Project configuration may add checks and reduce permissions; it cannot skip approval, testing, runtime verification, independent review, security review, Git safety, or evidence.

Project agents outrank plugin agents when names collide, so adapters use explicit project names and never the `asterweave:` namespace. Project skills are also unscoped; plugin skills remain under `/asterweave:*`.
