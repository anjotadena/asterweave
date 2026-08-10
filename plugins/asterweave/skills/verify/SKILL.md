---
name: verify
description: Independently verify implemented behavior against acceptance criteria in the running application or executable environment, producing an evidence matrix rather than relying only on tests.
argument-hint: "<acceptance-criteria|issue>"
context: fork
agent: asterweave:verification-engineer
background: false
model: sonnet
effort: high
---

# Verify observable behavior

Verify `$ARGUMENTS` independently from implementation.

1. Read the approved acceptance criteria and [evidence contract](../../references/evidence-contract.md).
2. Build and launch the application with repository-native commands and required local dependencies.
3. Exercise the affected behavior through its real boundary: browser, API, CLI, worker, mobile simulator/device, desktop process, database, or integration harness.
4. Cover happy path, failure path, permissions, persistence, compatibility, and user-visible states proportional to risk.
5. Capture reproducible evidence: commands, inputs, output/status, screenshots or artifact paths when relevant, timestamps, and environment limitations.
6. Do not modify production code or declare success from unit tests alone.
7. Return an acceptance-criteria matrix with `PASS`, `FAIL`, or `BLOCKED`, plus one `acceptance` evidence summary and stable failure signatures.
