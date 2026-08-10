# Repository adapter

`.claude/asterweave.json` connects Asterweave's reusable graph to project-specific skills, agents, and quality gates. It follows [the repository adapter schema](../schemas/repository-adapter.schema.json).

```json
{
  "version": 1,
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
